'use strict';
/* In-game phone: authoritative call sessions + WebRTC signalling relay.
   Voice itself never touches this server - only offer/answer/ICE do (see public/phone.js).
   Wire format: client<->server messages are { t:'ph', k:<kind>, ... }.

   Client -> server : call{num} answer reject end sig{d} up recents contacts cadd{name,num} cdel{id} block{num} unblock{num} blocks
   Server -> client : me out in fail answered ended sig live missed recents contacts blocks err

   Call lifecycle (server state):   ringing -> answered -> ended        (record status: ringing|answered|rejected|missed|cancelled|failed|offline|ended)
   Identity comes from the authenticated socket (p.ph.user), never from message fields. */
const crypto = require('crypto');

const RING_MS = +process.env.PHONE_RING_MS || 28000;      // unanswered after this -> missed (server timer is authoritative)
const SETUP_MS = +process.env.PHONE_SETUP_MS || 25000;    // answered but WebRTC never came up -> failed
const RATE_WINDOW = 60000;
const rateMax = () => +process.env.PHONE_RATE_MAX || 6, ratePerTarget = () => +process.env.PHONE_RATE_TARGET || 3;
const MAX_CONTACTS = 100;
const NUM = /^[1-9]\d{5}$/;

const cleanSaved = (n) => String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);

function createPhone({ store, send, log = console.log }) {
  const byUser = new Map();    // userId -> player (one active phone session per account)
  const byPhone = new Map();   // phone number -> player (online only)
  const calls = new Map();     // callId -> call

  const ph = (p, o) => { if (p && p.ws && p.ws.readyState === 1) send(p.ws, Object.assign({ t: 'ph' }, o)); };
  const fail = (p, reason) => ph(p, { k: 'fail', reason });
  const ready = (p) => !!(p && p.ph && p.ph.ready && p.ph.user);

  /* ---- persistence is chained per call so writes land in order and never fight each other ---- */
  const persist = (c, fn) => { c.q = c.q.then(fn).catch((e) => log('[phone] db', e && e.message)); return c.q; };
  const record = (callerP, receiverU, status) => {
    // a call that never rang (offline / busy / blocked): one finished row for the caller
    store.createCall({ callerId: callerP.ph.user.id, receiverId: receiverU.id, callerPhone: callerP.ph.user.phone, receiverPhone: receiverU.phone, status }).catch((e) => log('[phone] db', e && e.message));
  };

  async function attach(p, tok) {
    p.ph = { ready: false, user: null, call: null, attempts: [], bucket: 60, last: Date.now() };
    try {
      let acc = tok ? await store.accountByToken(tok) : null, token = null;
      if (acc) await store.touch(acc.id, p.name, true);
      else { const r = await store.createAccount(p.name); acc = r.user; token = r.token; }
      if (p.closed) { store.setOffline(acc.id).catch(() => {}); return; }
      const old = byUser.get(acc.id);
      if (old && old !== p) {                          // same account opened elsewhere: newest wins
        if (old.ph.call) end(old.ph.call, old.ph.call.st === 'ringing' ? (old.ph.call.caller === old ? 'cancelled' : 'failed') : 'ended', 'lost', old);
        old.ph.ready = false; ph(old, { k: 'err', code: 'replaced' });
        if (byPhone.get(old.ph.user.phone) === old) byPhone.delete(old.ph.user.phone);
      }
      p.ph.user = acc; p.ph.ready = true; byUser.set(acc.id, p); byPhone.set(acc.phone, p);
      ph(p, { k: 'me', num: acc.phone, name: p.name, tok: token || undefined });
    } catch (e) { log('[phone] attach failed', e && e.message); ph(p, { k: 'err', code: 'unavailable' }); }
  }

  function detach(p) {
    if (!p.ph) return;
    p.closed = true;
    const c = p.ph.call;
    if (c) end(c, c.st === 'ringing' ? (c.caller === p ? 'cancelled' : 'failed') : 'ended', 'lost', p);
    const u = p.ph.user;
    if (u) {
      if (byUser.get(u.id) === p) { byUser.delete(u.id); store.setOffline(u.id).catch(() => {}); }
      if (byPhone.get(u.phone) === p) byPhone.delete(u.phone);
    }
    p.ph.ready = false;
  }

  /* ------------------------------------------------------------ call state machine */
  function other(c, p) { return c.caller === p ? c.receiver : c.caller; }

  function end(c, status, reason, by) {
    if (c.st === 'ended') return;
    const was = c.st;
    c.st = 'ended'; clearTimeout(c.ring); clearTimeout(c.watch); calls.delete(c.id);
    for (const q of [c.caller, c.receiver]) if (q.ph && q.ph.call === c) q.ph.call = null;
    const upAt = c.upAt || c.up1, dur = was === 'answered' && upAt ? Math.max(0, Math.round((Date.now() - upAt) / 1000)) : 0;
    persist(c, async () => { const id = await c.dbId; if (id) await store.updateCall(id, ['ringing', 'answered'], { status, ended: true, duration: dur }); });
    for (const q of [c.caller, c.receiver]) {
      ph(q, { k: 'ended', id: c.id, reason, status, dur, by: by === q ? 'me' : 'peer' });
      if (status === 'missed' && q === c.receiver) ph(q, { k: 'missed', num: c.caller.ph.user.phone, name: c.caller.name });
    }
  }

  function rate(p, targetPhone) {
    const now = Date.now(); p.ph.attempts = p.ph.attempts.filter((a) => now - a.at < RATE_WINDOW);
    if (p.ph.attempts.length >= rateMax() || p.ph.attempts.filter((a) => a.to === targetPhone).length >= ratePerTarget()) return false;
    p.ph.attempts.push({ at: now, to: targetPhone }); return true;
  }

  async function call(p, raw) {
    if (!ready(p)) return fail(p, 'unavailable');
    const num = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (!NUM.test(num)) return fail(p, 'notfound');
    if (num === p.ph.user.phone) return fail(p, 'self');
    if (p.ph.call) return fail(p, 'incall');
    if (!rate(p, num)) return fail(p, 'rate');

    const target = byPhone.get(num);
    if (!target || !ready(target) || target.ws.readyState !== 1) {
      const u = await store.userByPhone(num);
      if (!u) return fail(p, 'notfound');
      record(p, u, 'offline'); return fail(p, 'offline');
    }
    if (await store.isBlocked(target.ph.user.id, p.ph.user.id)) {      // looks exactly like an offline player
      record(p, target.ph.user, 'offline'); return fail(p, 'offline');
    }
    // Everything from here to reserving both lines is synchronous, so two simultaneous callers (or A<->B glare) cannot both win.
    if (!ready(p) || !ready(target) || p.ws.readyState !== 1 || target.ws.readyState !== 1) return fail(p, 'offline');
    if (p.ph.call) return fail(p, 'incall');
    if (target.ph.call) { record(p, target.ph.user, 'failed'); return fail(p, 'busy'); }

    const c = { id: crypto.randomBytes(9).toString('hex'), caller: p, receiver: target, st: 'ringing', createdAt: Date.now(), q: Promise.resolve(), up: new Set() };
    p.ph.call = c; target.ph.call = c; calls.set(c.id, c);
    c.dbId = store.createCall({ callerId: p.ph.user.id, receiverId: target.ph.user.id, callerPhone: p.ph.user.phone, receiverPhone: target.ph.user.phone, status: 'ringing' }).catch((e) => { log('[phone] db', e && e.message); return null; });
    c.ring = setTimeout(() => end(c, 'missed', 'noanswer'), RING_MS);
    ph(p, { k: 'out', id: c.id, num: target.ph.user.phone, name: target.name, peer: target.id });
    ph(target, { k: 'in', id: c.id, num: p.ph.user.phone, name: p.name, peer: p.id, ring: RING_MS });
  }

  function answer(p) {
    const c = p.ph && p.ph.call;
    if (!c || c.st !== 'ringing' || c.receiver !== p) return;
    clearTimeout(c.ring); c.st = 'answered'; c.answeredAt = Date.now();
    persist(c, async () => { const id = await c.dbId; if (id) await store.updateCall(id, ['ringing'], { status: 'answered', answered: true }); });
    c.watch = setTimeout(() => { if (c.st === 'answered' && !c.upAt) end(c, 'failed', 'setup'); }, SETUP_MS);
    ph(c.caller, { k: 'answered', id: c.id, role: 'caller', peer: c.receiver.id });
    ph(c.receiver, { k: 'answered', id: c.id, role: 'callee', peer: c.caller.id });
  }

  function reject(p) { const c = p.ph && p.ph.call; if (c && c.st === 'ringing' && c.receiver === p) end(c, 'rejected', 'rejected', p); }

  function hangup(p) {
    const c = p.ph && p.ph.call; if (!c) return;
    if (c.st === 'ringing') return c.caller === p ? end(c, 'cancelled', 'cancelled', p) : end(c, 'rejected', 'rejected', p);
    end(c, 'ended', 'hangup', p);
  }

  function sig(p, m) {
    const c = p.ph && p.ph.call, d = m.d;
    if (!c || c.st !== 'answered' || (m.id && m.id !== c.id) || !d || typeof d !== 'object') return;   // only participants of a live call
    if (d.type === 'offer' || d.type === 'answer') { if (typeof d.sdp !== 'string' || d.sdp.length > 14000) return; ph(other(c, p), { k: 'sig', id: c.id, d: { type: d.type, sdp: d.sdp } }); }
    else if (d.type === 'ice') {
      const k = d.c; if (!k || typeof k !== 'object' || typeof k.candidate !== 'string' || k.candidate.length > 1000) return;
      ph(other(c, p), { k: 'sig', id: c.id, d: { type: 'ice', c: { candidate: k.candidate, sdpMid: typeof k.sdpMid === 'string' ? k.sdpMid : null, sdpMLineIndex: Number.isInteger(k.sdpMLineIndex) ? k.sdpMLineIndex : null } } });
    }
  }

  function up(p, m) {      // a client reports its WebRTC link is connected
    const c = p.ph && p.ph.call; if (!c || c.st !== 'answered' || (m.id && m.id !== c.id)) return;
    c.up.add(p); if (!c.up1) c.up1 = Date.now();
    if (c.up.size === 2 && !c.upAt) { c.upAt = Date.now(); clearTimeout(c.watch); ph(c.caller, { k: 'live', id: c.id }); ph(c.receiver, { k: 'live', id: c.id }); }
  }

  /* ------------------------------------------------------------ lists */
  const sendRecents = async (p) => ph(p, { k: 'recents', list: await store.recents(p.ph.user.id) });
  const sendContacts = async (p) => ph(p, { k: 'contacts', list: await store.contacts(p.ph.user.id) });
  const sendBlocks = async (p) => ph(p, { k: 'blocks', list: await store.blocks(p.ph.user.id) });

  async function handle(p, m) {
    if (!p.ph) return;
    const now = Date.now(); p.ph.bucket = Math.min(60, p.ph.bucket + (now - p.ph.last) / 1000 * 40); p.ph.last = now;
    if (--p.ph.bucket < 0) return;
    if (!ready(p)) return;
    try {
      switch (m.k) {
        case 'call': return await call(p, m.num);
        case 'answer': return answer(p);
        case 'reject': return reject(p);
        case 'end': return hangup(p);
        case 'sig': return sig(p, m);
        case 'up': return up(p, m);
        case 'recents': return await sendRecents(p);
        case 'contacts': return await sendContacts(p);
        case 'blocks': return await sendBlocks(p);
        case 'cadd': {
          const num = String(m.num || '').replace(/\D/g, ''), name = cleanSaved(m.name);
          if (!NUM.test(num) || !name) return ph(p, { k: 'err', code: 'bad' });
          if (num === p.ph.user.phone) return ph(p, { k: 'err', code: 'self' });
          const u = await store.userByPhone(num); if (!u) return ph(p, { k: 'err', code: 'notfound' });
          const have = await store.contacts(p.ph.user.id);
          if (have.length >= MAX_CONTACTS && !have.some((x) => x.num === num)) return ph(p, { k: 'err', code: 'full' });
          await store.saveContact(p.ph.user.id, u.id, name); return await sendContacts(p);
        }
        case 'cdel': await store.deleteContact(p.ph.user.id, String(m.id || '')); return await sendContacts(p);
        case 'block': case 'unblock': {
          const num = String(m.num || '').replace(/\D/g, ''); if (!NUM.test(num) || num === p.ph.user.phone) return;
          const u = await store.userByPhone(num); if (!u) return;
          if (m.k === 'block') await store.block(p.ph.user.id, u.id); else await store.unblock(p.ph.user.id, u.id);
          return await sendBlocks(p);
        }
      }
    } catch (e) { log('[phone] handler', m.k, e && e.message); ph(p, { k: 'err', code: 'unavailable' }); }
  }

  function shutdown() { for (const c of [...calls.values()]) end(c, c.st === 'ringing' ? 'failed' : 'ended', 'server'); }
  return { attach, detach, handle, shutdown, _calls: calls, _byPhone: byPhone };
}

module.exports = { createPhone, RING_MS };
