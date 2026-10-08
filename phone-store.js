'use strict';
/* Phone persistence: accounts (device token -> permanent 6-digit number), call history, contacts, blocks.
   PgStore  : Postgres via DATABASE_URL (permanent; the UNIQUE index on phone_number is what guarantees uniqueness).
   MemStore : no DATABASE_URL -> everything is lost on restart. Dev only. */
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newPhone = () => String(crypto.randomInt(100000, 1000000));          // 100000-999999, never a leading zero
const newToken = () => crypto.randomBytes(32).toString('hex');
const isPg23505 = (e) => e && e.code === '23505';                           // unique_violation
const CALL_OPEN = ['ringing', 'answered'];

/* ------------------------------------------------------------------ Postgres */
class PgStore {
  constructor(pool) { this.pool = pool; this.kind = 'postgres'; }
  q(text, params) { return this.pool.query(text, params); }

  async init() {
    await this.q(`CREATE TABLE IF NOT EXISTS phone_users (
      id BIGSERIAL PRIMARY KEY,
      token_hash TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      phone_number TEXT NOT NULL,
      online BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT phone_number_format CHECK (length(phone_number) = 6 AND phone_number >= '100000' AND phone_number <= '999999')
    )`);
    await this.q('CREATE UNIQUE INDEX IF NOT EXISTS phone_users_phone_uq ON phone_users (phone_number)');
    await this.q('CREATE UNIQUE INDEX IF NOT EXISTS phone_users_token_uq ON phone_users (token_hash)');
    await this.q(`CREATE TABLE IF NOT EXISTS call_records (
      id BIGSERIAL PRIMARY KEY,
      caller_user_id BIGINT NOT NULL,
      receiver_user_id BIGINT NOT NULL,
      caller_phone TEXT NOT NULL,
      receiver_phone TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      answered_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      duration_seconds INTEGER NOT NULL DEFAULT 0
    )`);
    await this.q('CREATE INDEX IF NOT EXISTS call_records_caller_ix ON call_records (caller_user_id, started_at DESC)');
    await this.q('CREATE INDEX IF NOT EXISTS call_records_receiver_ix ON call_records (receiver_user_id, started_at DESC)');
    await this.q(`CREATE TABLE IF NOT EXISTS phone_contacts (
      id BIGSERIAL PRIMARY KEY,
      owner_user_id BIGINT NOT NULL,
      contact_user_id BIGINT NOT NULL,
      saved_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await this.q('CREATE UNIQUE INDEX IF NOT EXISTS phone_contacts_uq ON phone_contacts (owner_user_id, contact_user_id)');
    await this.q(`CREATE TABLE IF NOT EXISTS phone_blocks (
      id BIGSERIAL PRIMARY KEY,
      owner_user_id BIGINT NOT NULL,
      blocked_user_id BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await this.q('CREATE UNIQUE INDEX IF NOT EXISTS phone_blocks_uq ON phone_blocks (owner_user_id, blocked_user_id)');
    await this.reconcile();
  }

  /* After a restart nobody can still be online or mid-call. */
  async reconcile() {
    await this.q('UPDATE phone_users SET online = FALSE WHERE online = TRUE');
    await this.q("UPDATE call_records SET status = 'failed', ended_at = now() WHERE status = 'ringing'");
    await this.q("UPDATE call_records SET status = 'ended', ended_at = now() WHERE status = 'answered'");
  }

  row(r) { return r && { id: String(r.id), phone: r.phone_number, name: r.display_name }; }

  async accountByToken(token) {
    const r = await this.q('SELECT id, phone_number, display_name FROM phone_users WHERE token_hash = $1', [sha(token)]);
    return this.row(r.rows[0]);
  }

  /* The UNIQUE index decides: on a collision (two accounts racing for one number) we just draw again. */
  async createAccount(name) {
    for (let i = 0; i < 40; i++) {
      const token = newToken(), phone = newPhone();
      try {
        const r = await this.q('INSERT INTO phone_users (token_hash, display_name, phone_number, online) VALUES ($1,$2,$3,TRUE) RETURNING id, phone_number, display_name', [sha(token), name || '', phone]);
        return { user: this.row(r.rows[0]), token };
      } catch (e) { if (!isPg23505(e)) throw e; }
    }
    throw new Error('could not allocate a phone number');
  }

  async touch(id, name, online) { await this.q('UPDATE phone_users SET display_name = $2, online = $3, last_seen = now() WHERE id = $1', [id, name || '', !!online]); }
  async setOffline(id) { await this.q('UPDATE phone_users SET online = FALSE, last_seen = now() WHERE id = $1', [id]); }
  async userByPhone(phone) { const r = await this.q('SELECT id, phone_number, display_name FROM phone_users WHERE phone_number = $1', [phone]); return this.row(r.rows[0]); }

  async createCall(c) {
    const r = await this.q('INSERT INTO call_records (caller_user_id, receiver_user_id, caller_phone, receiver_phone, status) VALUES ($1,$2,$3,$4,$5) RETURNING id', [c.callerId, c.receiverId, c.callerPhone, c.receiverPhone, c.status || 'ringing']);
    return String(r.rows[0].id);
  }
  /* Conditional transition: only moves a record that is still in one of `from` (so it can never be both rejected and answered). */
  async updateCall(id, from, patch) {
    const sets = ['status = $2'], vals = [id, patch.status, from];
    if (patch.answered) sets.push('answered_at = now()');
    if (patch.ended) sets.push('ended_at = now()');
    if (patch.duration != null) { vals.push(Math.max(0, patch.duration | 0)); sets.push('duration_seconds = $' + vals.length); }
    const r = await this.q('UPDATE call_records SET ' + sets.join(', ') + ' WHERE id = $1 AND status = ANY($3::text[])', vals);
    return r.rowCount > 0;
  }

  async recents(userId, limit = 30) {
    const r = await this.q(`SELECT c.id, c.caller_user_id, c.receiver_user_id, c.caller_phone, c.receiver_phone, c.status, c.started_at, c.duration_seconds
      FROM call_records c WHERE c.caller_user_id = $1 OR c.receiver_user_id = $1 ORDER BY c.started_at DESC, c.id DESC LIMIT $2`, [userId, limit]);
    return r.rows.map((x) => {
      const out = String(x.caller_user_id) === String(userId);
      // The receiver only learns about calls it was actually rung for.
      return { id: String(x.id), out, num: out ? x.receiver_phone : x.caller_phone, status: x.status, at: new Date(x.started_at).getTime(), dur: x.duration_seconds };
    }).filter((x) => x.out || ['answered', 'ended', 'missed', 'rejected', 'cancelled'].includes(x.status));
  }

  async contacts(ownerId) {
    const r = await this.q('SELECT c.id, c.saved_name, u.phone_number FROM phone_contacts c JOIN phone_users u ON u.id = c.contact_user_id WHERE c.owner_user_id = $1 ORDER BY c.saved_name', [ownerId]);
    return r.rows.map((x) => ({ id: String(x.id), name: x.saved_name, num: x.phone_number }));
  }
  async countContacts(ownerId) { const r = await this.q('SELECT count(*)::int AS n FROM phone_contacts WHERE owner_user_id = $1', [ownerId]); return r.rows[0].n; }
  async saveContact(ownerId, contactId, name) {
    await this.q(`INSERT INTO phone_contacts (owner_user_id, contact_user_id, saved_name) VALUES ($1,$2,$3)
      ON CONFLICT (owner_user_id, contact_user_id) DO UPDATE SET saved_name = EXCLUDED.saved_name`, [ownerId, contactId, name]);
  }
  async deleteContact(ownerId, id) { await this.q('DELETE FROM phone_contacts WHERE owner_user_id = $1 AND id = $2', [ownerId, id]); }

  async isBlocked(ownerId, otherId) { const r = await this.q('SELECT 1 FROM phone_blocks WHERE owner_user_id = $1 AND blocked_user_id = $2', [ownerId, otherId]); return r.rows.length > 0; }
  async block(ownerId, otherId) { await this.q('INSERT INTO phone_blocks (owner_user_id, blocked_user_id) VALUES ($1,$2) ON CONFLICT (owner_user_id, blocked_user_id) DO NOTHING', [ownerId, otherId]); }
  async unblock(ownerId, otherId) { await this.q('DELETE FROM phone_blocks WHERE owner_user_id = $1 AND blocked_user_id = $2', [ownerId, otherId]); }
  async blocks(ownerId) {
    const r = await this.q('SELECT u.phone_number FROM phone_blocks b JOIN phone_users u ON u.id = b.blocked_user_id WHERE b.owner_user_id = $1', [ownerId]);
    return r.rows.map((x) => x.phone_number);
  }
}

/* ------------------------------------------------------------------ in memory (dev) */
class MemStore {
  constructor() { this.kind = 'memory'; this.users = new Map(); this.byTok = new Map(); this.byPhone = new Map(); this.calls = new Map(); this.contactsM = []; this.blocksM = []; this.seq = 1; }
  async init() {}
  async accountByToken(token) { return this.byTok.get(sha(token)) || null; }
  async createAccount(name) {
    for (let i = 0; i < 40; i++) {
      const phone = newPhone(); if (this.byPhone.has(phone)) continue;
      const token = newToken(), u = { id: String(this.seq++), phone, name: name || '' };
      this.users.set(u.id, u); this.byPhone.set(phone, u); this.byTok.set(sha(token), u);
      return { user: { ...u }, token };
    }
    throw new Error('could not allocate a phone number');
  }
  async touch(id, name) { const u = this.users.get(id); if (u) u.name = name || ''; }
  async setOffline() {}
  async userByPhone(phone) { const u = this.byPhone.get(phone); return u ? { ...u } : null; }
  async createCall(c) { const id = String(this.seq++); this.calls.set(id, { id, ...c, status: c.status || 'ringing', at: Date.now(), dur: 0 }); return id; }
  async updateCall(id, from, patch) { const c = this.calls.get(id); if (!c || !from.includes(c.status)) return false; c.status = patch.status; if (patch.duration != null) c.dur = patch.duration | 0; return true; }
  async recents(userId, limit = 30) {
    return [...this.calls.values()].filter((c) => c.callerId === userId || c.receiverId === userId).sort((a, b) => b.at - a.at).slice(0, limit).map((c) => {
      const out = c.callerId === userId; return { id: c.id, out, num: out ? c.receiverPhone : c.callerPhone, status: c.status, at: c.at, dur: c.dur };
    }).filter((x) => x.out || ['answered', 'ended', 'missed', 'rejected', 'cancelled'].includes(x.status));
  }
  async contacts(ownerId) { return this.contactsM.filter((c) => c.owner === ownerId).map((c) => ({ id: c.id, name: c.name, num: this.users.get(c.contact).phone })).sort((a, b) => a.name.localeCompare(b.name)); }
  async countContacts(ownerId) { return this.contactsM.filter((c) => c.owner === ownerId).length; }
  async saveContact(owner, contact, name) { const c = this.contactsM.find((x) => x.owner === owner && x.contact === contact); if (c) c.name = name; else this.contactsM.push({ id: String(this.seq++), owner, contact, name }); }
  async deleteContact(owner, id) { this.contactsM = this.contactsM.filter((c) => !(c.owner === owner && c.id === id)); }
  async isBlocked(owner, other) { return this.blocksM.some((b) => b.owner === owner && b.other === other); }
  async block(owner, other) { if (!(await this.isBlocked(owner, other))) this.blocksM.push({ owner, other }); }
  async unblock(owner, other) { this.blocksM = this.blocksM.filter((b) => !(b.owner === owner && b.other === other)); }
  async blocks(owner) { return this.blocksM.filter((b) => b.owner === owner).map((b) => this.users.get(b.other).phone); }
}

function createStore(opts = {}) {
  const url = opts.databaseUrl !== undefined ? opts.databaseUrl : process.env.DATABASE_URL;
  if (opts.pool) return new PgStore(opts.pool);
  if (!url) return new MemStore();
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  const ssl = process.env.PGSSL === '0' || local ? false : { rejectUnauthorized: false };
  return new PgStore(new Pool({ connectionString: url, ssl, max: 5 }));
}

module.exports = { createStore, PgStore, MemStore, CALL_OPEN };
