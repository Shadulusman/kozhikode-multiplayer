'use strict';
/* Economy persistence: wallet/XP profile, owned items, transaction log.
   PgStore  : Postgres (shares the phone system's pool / DATABASE_URL). Purchases run in one SQL transaction.
   MemStore : no DATABASE_URL -> lost on restart (dev only).
   Profiles are keyed by the phone account id (device token -> account), so they survive refresh/relogin. */

const START_CASH = 1500;

class PgStore {
  constructor(pool) { this.pool = pool; this.kind = 'postgres'; }
  q(text, params) { return this.pool.query(text, params); }
  async init() {
    await this.q(`CREATE TABLE IF NOT EXISTS eco_profiles (
      user_id BIGINT PRIMARY KEY,
      cash BIGINT NOT NULL DEFAULT 0, bank BIGINT NOT NULL DEFAULT 0,
      xp BIGINT NOT NULL DEFAULT 0, rep INTEGER NOT NULL DEFAULT 0,
      total_earned BIGINT NOT NULL DEFAULT 0, total_spent BIGINT NOT NULL DEFAULT 0,
      jobs_done INTEGER NOT NULL DEFAULT 0, outfit TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT eco_cash_nonneg CHECK (cash >= 0))`);
    await this.q(`CREATE TABLE IF NOT EXISTS eco_owned (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await this.q('CREATE UNIQUE INDEX IF NOT EXISTS eco_owned_uq ON eco_owned (user_id, kind, item)');
    await this.q(`CREATE TABLE IF NOT EXISTS eco_tx (
      id BIGSERIAL PRIMARY KEY, user_id BIGINT NOT NULL, type TEXT NOT NULL, amount BIGINT NOT NULL,
      balance_after BIGINT NOT NULL, source TEXT NOT NULL DEFAULT '', at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await this.q('CREATE INDEX IF NOT EXISTS eco_tx_user_ix ON eco_tx (user_id, at DESC)');
    await this.q('CREATE TABLE IF NOT EXISTS eco_daily (user_id BIGINT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL DEFAULT \'{}\', PRIMARY KEY (user_id, day))');
    await this.q('CREATE TABLE IF NOT EXISTS eco_inv (user_id BIGINT NOT NULL, item TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, item))');
    await this.q('CREATE TABLE IF NOT EXISTS eco_best (user_id BIGINT NOT NULL, race TEXT NOT NULL, ms INTEGER NOT NULL, PRIMARY KEY (user_id, race))');
  }
  row(r) { return r && { cash: Number(r.cash), bank: Number(r.bank), xp: Number(r.xp), rep: r.rep, earned: Number(r.total_earned), spent: Number(r.total_spent), jobs: r.jobs_done, outfit: JSON.parse(r.outfit || '{}') }; }
  async profile(uid, outfit) {
    let r = await this.q('SELECT * FROM eco_profiles WHERE user_id = $1', [uid]);
    if (r.rows[0]) return { ...this.row(r.rows[0]), fresh: false };
    await this.q('INSERT INTO eco_profiles (user_id, cash, outfit) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO NOTHING', [uid, START_CASH, JSON.stringify(outfit || {})]);
    await this.q('INSERT INTO eco_tx (user_id, type, amount, balance_after, source) VALUES ($1,$2,$3,$4,$5)', [uid, 'START', START_CASH, START_CASH, 'welcome']);
    r = await this.q('SELECT * FROM eco_profiles WHERE user_id = $1', [uid]);
    return { ...this.row(r.rows[0]), fresh: true };
  }
  async owned(uid) { const r = await this.q('SELECT kind, item, data FROM eco_owned WHERE user_id = $1 ORDER BY id', [uid]); return r.rows.map((x) => ({ kind: x.kind, item: x.item, data: JSON.parse(x.data || '{}') })); }
  /** reward: one statement updates cash/xp/counters, then the log row */
  async credit(uid, amount, xp, type, source) {
    const r = await this.q('UPDATE eco_profiles SET cash = cash + $2::bigint, xp = xp + $3::bigint, total_earned = total_earned + $2::bigint, jobs_done = jobs_done + 1, rep = rep + 1 WHERE user_id = $1 RETURNING cash', [uid, amount, xp]);
    const after = Number(r.rows[0].cash);
    await this.q('INSERT INTO eco_tx (user_id, type, amount, balance_after, source) VALUES ($1,$2,$3,$4,$5)', [uid, type, amount, after, source]);
    return after;
  }
  /** atomic purchase: money only leaves if the ownership row is created, in one transaction */
  async buy(uid, kind, item, price, data) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const own = await c.query('SELECT 1 FROM eco_owned WHERE user_id = $1 AND kind = $2 AND item = $3', [uid, kind, item]);
      if (own.rows.length) { await c.query('ROLLBACK'); return { ok: false, why: 'owned' }; }
      const r = await c.query('UPDATE eco_profiles SET cash = cash - $2::bigint, total_spent = total_spent + $2::bigint WHERE user_id = $1 AND cash >= $2::bigint RETURNING cash', [uid, price]);
      if (!r.rows.length) { await c.query('ROLLBACK'); return { ok: false, why: 'funds' }; }
      await c.query('INSERT INTO eco_owned (user_id, kind, item, data) VALUES ($1,$2,$3,$4)', [uid, kind, item, JSON.stringify(data || {})]);
      const after = Number(r.rows[0].cash);
      await c.query('INSERT INTO eco_tx (user_id, type, amount, balance_after, source) VALUES ($1,$2,$3,$4,$5)', [uid, kind === 'vehicle' ? 'VEHICLE_PURCHASE' : 'CLOTHING_PURCHASE', -price, after, item]);
      await c.query('COMMIT');
      return { ok: true, cash: after };
    } catch (e) { try { await c.query('ROLLBACK'); } catch (e2) {} if (e && e.code === '23505') return { ok: false, why: 'owned' }; throw e; }
    finally { c.release(); }
  }
  async setOutfit(uid, outfit) { await this.q('UPDATE eco_profiles SET outfit = $2 WHERE user_id = $1', [uid, JSON.stringify(outfit)]); }
  /** pay a bonus/sale without counting it as a job */
  async pay(uid, amount, xp, type, source) { const r = await this.q('UPDATE eco_profiles SET cash = cash + $2::bigint, xp = xp + $3::bigint, total_earned = total_earned + $2::bigint WHERE user_id = $1 RETURNING cash', [uid, amount, xp]); const after = Number(r.rows[0].cash);
    await this.q('INSERT INTO eco_tx (user_id, type, amount, balance_after, source) VALUES ($1,$2,$3,$4,$5)', [uid, type, amount, after, source]); return after; }
  /** entry fees etc.: only if the player can afford it */
  async debit(uid, amount, type, source) { const r = await this.q('UPDATE eco_profiles SET cash = cash - $2::bigint, total_spent = total_spent + $2::bigint WHERE user_id = $1 AND cash >= $2::bigint RETURNING cash', [uid, amount]); if (!r.rows.length) return null;
    const after = Number(r.rows[0].cash); await this.q('INSERT INTO eco_tx (user_id, type, amount, balance_after, source) VALUES ($1,$2,$3,$4,$5)', [uid, type, -amount, after, source]); return after; }
  async daily(uid, day) { const r = await this.q('SELECT data FROM eco_daily WHERE user_id = $1 AND day = $2', [uid, day]); return r.rows[0] ? JSON.parse(r.rows[0].data) : {}; }
  async setDaily(uid, day, data) { await this.q('INSERT INTO eco_daily (user_id, day, data) VALUES ($1,$2,$3) ON CONFLICT (user_id, day) DO UPDATE SET data = EXCLUDED.data', [uid, day, JSON.stringify(data)]); }
  async inv(uid) { const r = await this.q('SELECT item, qty FROM eco_inv WHERE user_id = $1 AND qty > 0', [uid]); return Object.fromEntries(r.rows.map((x) => [x.item, x.qty])); }
  async addInv(uid, item, n) { await this.q('INSERT INTO eco_inv (user_id, item, qty) VALUES ($1,$2,$3) ON CONFLICT (user_id, item) DO UPDATE SET qty = eco_inv.qty + EXCLUDED.qty', [uid, item, n]); }
  async clearInv(uid, items) { for (const it of items) await this.q('UPDATE eco_inv SET qty = 0 WHERE user_id = $1 AND item = $2', [uid, it]); }
  async best(uid, race) { const r = await this.q('SELECT ms FROM eco_best WHERE user_id = $1 AND race = $2', [uid, race]); return r.rows[0] ? r.rows[0].ms : null; }
  async setBest(uid, race, ms) { await this.q('INSERT INTO eco_best (user_id, race, ms) VALUES ($1,$2,$3) ON CONFLICT (user_id, race) DO UPDATE SET ms = LEAST(eco_best.ms, EXCLUDED.ms)', [uid, race, ms]); }
  async txs(uid, n = 10) { const r = await this.q('SELECT type, amount, balance_after, source, at FROM eco_tx WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [uid, n]); return r.rows.map((x) => ({ type: x.type, amount: Number(x.amount), after: Number(x.balance_after), source: x.source })); }
}

class MemStore {
  constructor() { this.kind = 'memory'; this.p = new Map(); this.o = []; this.t = []; this.lock = Promise.resolve(); }
  async init() {}
  async profile(uid, outfit) {
    let x = this.p.get(uid); if (x) return { ...x, outfit: { ...x.outfit }, fresh: false };
    x = { cash: START_CASH, bank: 0, xp: 0, rep: 0, earned: 0, spent: 0, jobs: 0, outfit: outfit || {} }; this.p.set(uid, x);
    this.t.push({ uid, type: 'START', amount: START_CASH, after: START_CASH, source: 'welcome' }); return { ...x, fresh: true };
  }
  async owned(uid) { return this.o.filter((x) => x.uid === uid).map(({ kind, item, data }) => ({ kind, item, data })); }
  async credit(uid, amount, xp, type, source) { const x = this.p.get(uid); x.cash += amount; x.xp += xp; x.earned += amount; x.jobs++; x.rep++; this.t.push({ uid, type, amount, after: x.cash, source }); return x.cash; }
  async buy(uid, kind, item, price, data) {
    const run = async () => { const x = this.p.get(uid);
      if (this.o.some((y) => y.uid === uid && y.kind === kind && y.item === item)) return { ok: false, why: 'owned' };
      if (!x || x.cash < price) return { ok: false, why: 'funds' };
      x.cash -= price; x.spent += price; this.o.push({ uid, kind, item, data: data || {} }); this.t.push({ uid, type: kind === 'vehicle' ? 'VEHICLE_PURCHASE' : 'CLOTHING_PURCHASE', amount: -price, after: x.cash, source: item });
      return { ok: true, cash: x.cash }; };
    const r = this.lock.then(run); this.lock = r.catch(() => {}); return r;   // serialised like a DB transaction
  }
  async setOutfit(uid, outfit) { const x = this.p.get(uid); if (x) x.outfit = outfit; }
  async pay(uid, amount, xp, type, source) { const x = this.p.get(uid); x.cash += amount; x.xp += xp; x.earned += amount; this.t.push({ uid, type, amount, after: x.cash, source }); return x.cash; }
  async debit(uid, amount, type, source) { const x = this.p.get(uid); if (!x || x.cash < amount) return null; x.cash -= amount; x.spent += amount; this.t.push({ uid, type, amount: -amount, after: x.cash, source }); return x.cash; }
  async daily(uid, day) { return { ...((this.d || (this.d = new Map())).get(uid + '|' + day) || {}) }; }
  async setDaily(uid, day, data) { (this.d || (this.d = new Map())).set(uid + '|' + day, { ...data }); }
  async inv(uid) { const m = (this.iv || (this.iv = new Map())).get(uid) || {}; return Object.fromEntries(Object.entries(m).filter(([, q]) => q > 0)); }
  async addInv(uid, item, n) { const iv = this.iv || (this.iv = new Map()); const m = iv.get(uid) || {}; m[item] = (m[item] || 0) + n; iv.set(uid, m); }
  async clearInv(uid, items) { const m = (this.iv || (this.iv = new Map())).get(uid) || {}; for (const it of items) m[it] = 0; }
  async best(uid, race) { return ((this.b || (this.b = new Map())).get(uid + '|' + race)) || null; }
  async setBest(uid, race, ms) { const b = this.b || (this.b = new Map()), k = uid + '|' + race, o = b.get(k); b.set(k, o ? Math.min(o, ms) : ms); }
  async txs(uid, n = 10) { return this.t.filter((x) => x.uid === uid).slice(-n).reverse().map(({ type, amount, after, source }) => ({ type, amount, after, source })); }
}

function createEcoStore(phoneStore) { return phoneStore && phoneStore.pool ? new PgStore(phoneStore.pool) : new MemStore(); }
module.exports = { createEcoStore, PgStore, MemStore, START_CASH };
