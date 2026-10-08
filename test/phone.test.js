'use strict';
/* node --test test/   - phone store + call state machine (fake sockets, pg-mem for the Postgres SQL). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStore, MemStore } = require('../phone-store');
const { createPhone } = require('../phone-server');

async function pgStore() {
  const { newDb, DataType } = require('pg-mem');
  const db = newDb();
  db.public.registerFunction({ name: 'length', args: [DataType.text], returns: DataType.integer, implementation: (s) => s.length });   // real Postgres has it built in
  const { Pool } = db.adapters.createPg();
  const s = createStore({ pool: new Pool() });
  await s.init();
  return s;
}

function world(store, opts = {}) {
  const inbox = new Map();
  const phone = createPhone({ store, send: (ws, o) => ws.out.push(o), log: () => {} });
  let n = 0;
  const mk = async (name, tok) => {
    const p = { id: String(++n), name, ws: { readyState: 1, out: [] } };
    await phone.attach(p, tok);
    return p;
  };
  const last = (p, k) => [...p.ws.out].reverse().find((m) => m.k === k);
  const all = (p, k) => p.ws.out.filter((m) => m.k === k);
  const tick = () => new Promise((r) => setImmediate(r));
  const say = async (p, o) => { await phone.handle(p, Object.assign({ t: 'ph' }, o)); await tick(); };
  return { phone, mk, last, all, say, tick };
}

for (const [label, make] of [['memory', async () => new MemStore()], ['postgres(pg-mem)', pgStore]]) {
  test(`[${label}] numbers: 6 digits, stable per token, unique`, async () => {
    const store = await make(); const w = world(store);
    const a = await w.mk('A'); const me = w.last(a, 'me');
    assert.match(me.num, /^[1-9]\d{5}$/); assert.ok(me.tok);
    a.closed = true; w.phone.detach(a);
    const a2 = await w.mk('A', me.tok);                      // "refresh": same token -> same number, no new token
    assert.equal(w.last(a2, 'me').num, me.num); assert.equal(w.last(a2, 'me').tok, undefined);
    const seen = new Set([me.num]);
    for (let i = 0; i < 150; i++) { const r = await store.createAccount('x' + i); assert.ok(!seen.has(r.user.phone)); seen.add(r.user.phone); }
  });

  test(`[${label}] concurrent signups never share a number (collision retry)`, async () => {
    const store = await make(); const crypto = require('crypto'); const orig = crypto.randomInt; let calls = 0;
    crypto.randomInt = (a, b) => (calls++ < 6 ? 123456 : orig(a, b));            // force the first draws to collide
    try { const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => store.createAccount('c' + i))); assert.equal(new Set(rs.map((r) => r.user.phone)).size, 6); }
    finally { crypto.randomInt = orig; }
  });

  test(`[${label}] call: ring -> answer -> signalling -> end, history for both`, async () => {
    const store = await make(); const w = world(store);
    const A = await w.mk('Ann'), B = await w.mk('Bob'); const bn = w.last(B, 'me').num, an = w.last(A, 'me').num;
    await w.say(A, { k: 'call', num: bn });
    const out = w.last(A, 'out'), inc = w.last(B, 'in'); assert.equal(out.id, inc.id); assert.equal(inc.num, an); assert.equal(inc.name, 'Ann');
    await w.say(B, { k: 'answer' });
    assert.equal(w.last(A, 'answered').role, 'caller'); assert.equal(w.last(B, 'answered').role, 'callee');
    await w.say(A, { k: 'sig', id: out.id, d: { type: 'offer', sdp: 'v=0' } });
    assert.deepEqual(w.last(B, 'sig').d, { type: 'offer', sdp: 'v=0' });
    await w.say(B, { k: 'sig', id: out.id, d: { type: 'ice', c: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } } });
    assert.equal(w.last(A, 'sig').d.type, 'ice');
    await w.say(A, { k: 'up' }); await w.say(B, { k: 'up' }); assert.ok(w.last(A, 'live'));
    await w.say(B, { k: 'end' });
    assert.equal(w.last(A, 'ended').reason, 'hangup'); assert.equal(w.last(B, 'ended').by, 'me'); assert.equal(w.last(A, 'ended').by, 'peer');
    await w.say(A, { k: 'recents' }); await w.say(B, { k: 'recents' });
    assert.equal(w.last(A, 'recents').list[0].status, 'ended'); assert.equal(w.last(A, 'recents').list[0].out, true);
    assert.equal(w.last(B, 'recents').list[0].out, false); assert.equal(w.last(B, 'recents').list[0].num, an);
    await w.say(A, { k: 'call', num: bn }); assert.ok(w.last(A, 'out').id !== out.id);   // lines are free again
  });

  test(`[${label}] reject / cancel / no-answer / offline / invalid / self / busy`, async () => {
    process.env.PHONE_RATE_MAX = '50'; process.env.PHONE_RATE_TARGET = '50'; const store = await make(); const w = world(store);
    const A = await w.mk('A'), B = await w.mk('B'), C = await w.mk('C'); const bn = w.last(B, 'me').num, an = w.last(A, 'me').num;
    await w.say(A, { k: 'call', num: bn }); await w.say(B, { k: 'reject' });
    assert.equal(w.last(A, 'ended').reason, 'rejected'); assert.equal(w.last(B, 'ended').status, 'rejected');
    await w.say(A, { k: 'call', num: bn }); await w.say(A, { k: 'end' });
    assert.equal(w.last(B, 'ended').status, 'cancelled');
    await w.say(A, { k: 'call', num: an }); assert.equal(w.last(A, 'fail').reason, 'self');
    await w.say(A, { k: 'call', num: '12345' }); assert.equal(w.last(A, 'fail').reason, 'notfound');
    await w.say(A, { k: 'call', num: '999999' }); assert.equal(w.last(A, 'fail').reason, 'notfound');
    await w.say(A, { k: 'call', num: bn }); await w.say(C, { k: 'call', num: bn }); assert.equal(w.last(C, 'fail').reason, 'busy');   // B is ringing
    await w.say(B, { k: 'answer' }); await w.say(C, { k: 'call', num: an }); assert.equal(w.last(C, 'fail').reason, 'busy');
    await w.say(A, { k: 'call', num: w.last(C, 'me').num }); assert.equal(w.last(A, 'fail').reason, 'incall');
    await w.say(A, { k: 'end' });
    B.closed = true; w.phone.detach(B); await w.say(A, { k: 'call', num: bn }); assert.equal(w.last(A, 'fail').reason, 'offline');   // exists but not online
  });

  test(`[${label}] unanswered call is missed by the server timer`, async () => {
    process.env.PHONE_RING_MS = '60'; delete require.cache[require.resolve('../phone-server')];
    const { createPhone: cp } = require('../phone-server'); const store = await make();
    const phone = cp({ store, send: (ws, o) => ws.out.push(o), log: () => {} });
    const mk = async (n) => { const p = { id: n, name: n, ws: { readyState: 1, out: [] } }; await phone.attach(p, null); return p; };
    const A = await mk('A'), B = await mk('B'); const bn = B.ws.out.find((m) => m.k === 'me').num;
    await phone.handle(A, { t: 'ph', k: 'call', num: bn }); await new Promise((r) => setTimeout(r, 150));
    assert.equal(A.ws.out.find((m) => m.k === 'ended').reason, 'noanswer'); assert.ok(B.ws.out.find((m) => m.k === 'missed'));
    await phone.handle(B, { t: 'ph', k: 'call', num: A.ws.out.find((m) => m.k === 'me').num }); assert.ok(B.ws.out.find((m) => m.k === 'out'));   // line was freed
    delete process.env.PHONE_RING_MS; delete require.cache[require.resolve('../phone-server')];
  });

  test(`[${label}] glare: simultaneous A<->B yields exactly one call`, async () => {
    const store = await make(); const w = world(store);
    const A = await w.mk('A'), B = await w.mk('B');
    await Promise.all([w.say(A, { k: 'call', num: w.last(B, 'me').num }), w.say(B, { k: 'call', num: w.last(A, 'me').num })]);
    const outs = [w.last(A, 'out'), w.last(B, 'out')].filter(Boolean); assert.equal(outs.length, 1);
    assert.equal([w.last(A, 'fail'), w.last(B, 'fail')].filter((f) => f && ['busy', 'incall'].includes(f.reason)).length, 1); assert.equal(w.phone._calls.size, 1);
  });

  test(`[${label}] disconnect mid-call ends the other side and frees the line`, async () => {
    const store = await make(); const w = world(store); const A = await w.mk('A'), B = await w.mk('B');
    await w.say(A, { k: 'call', num: w.last(B, 'me').num }); await w.say(B, { k: 'answer' });
    A.closed = true; A.ws.readyState = 3; w.phone.detach(A);
    assert.equal(w.last(B, 'ended').reason, 'lost'); assert.equal(w.phone._calls.size, 0);
    const C = await w.mk('C'); await w.say(B, { k: 'call', num: w.last(C, 'me').num }); assert.ok(w.last(B, 'out'));
  });

  test(`[${label}] signalling is only relayed inside a live call`, async () => {
    const store = await make(); const w = world(store); const A = await w.mk('A'), B = await w.mk('B'), C = await w.mk('C');
    await w.say(C, { k: 'sig', d: { type: 'offer', sdp: 'x' } }); assert.equal(w.all(A, 'sig').length + w.all(B, 'sig').length, 0);
    await w.say(A, { k: 'call', num: w.last(B, 'me').num }); await w.say(A, { k: 'sig', d: { type: 'offer', sdp: 'x' } }); assert.equal(w.all(B, 'sig').length, 0);   // still ringing
    await w.say(B, { k: 'answer' }); await w.say(C, { k: 'sig', id: w.last(A, 'out').id, d: { type: 'offer', sdp: 'evil' } }); assert.equal(w.all(A, 'sig').length + w.all(B, 'sig').length, 0);
    await w.say(A, { k: 'sig', d: { type: 'offer', sdp: 'x'.repeat(20000) } }); assert.equal(w.all(B, 'sig').length, 0);
    await w.say(A, { k: 'sig', d: { type: 'wat' } }); assert.equal(w.all(B, 'sig').length, 0);
  });

  test(`[${label}] rate limit, contacts, blocking`, async () => {
    delete process.env.PHONE_RATE_MAX; delete process.env.PHONE_RATE_TARGET; const store = await make(); const w = world(store); const A = await w.mk('A'), B = await w.mk('B'); const bn = w.last(B, 'me').num, an = w.last(A, 'me').num;
    for (let i = 0; i < 3; i++) { await w.say(A, { k: 'call', num: bn }); await w.say(A, { k: 'end' }); }
    await w.say(A, { k: 'call', num: bn }); assert.equal(w.last(A, 'fail').reason, 'rate');
    await w.say(A, { k: 'cadd', name: 'Bobby', num: bn }); assert.deepEqual(w.last(A, 'contacts').list.map((c) => [c.name, c.num]), [['Bobby', bn]]);
    await w.say(A, { k: 'cadd', name: 'Bobby2', num: bn }); assert.equal(w.last(A, 'contacts').list.length, 1);       // upsert, not duplicate
    await w.say(A, { k: 'cadd', name: 'Ghost', num: '999998' }); assert.equal(w.last(A, 'err').code, 'notfound');
    await w.say(A, { k: 'cadd', name: 'Me', num: an }); assert.equal(w.last(A, 'err').code, 'self');
    await w.say(B, { k: 'contacts' }); assert.equal(w.last(B, 'contacts').list.length, 0);                              // no leaking of other users' contacts
    await w.say(B, { k: 'block', num: an }); assert.deepEqual(w.last(B, 'blocks').list, [an]);
    const C = await w.mk('C'); await w.say(C, { k: 'call', num: bn });                                                // unblocked caller still rings
    await w.say(B, { k: 'reject' });
    await w.say(A, { k: 'cdel', id: w.last(A, 'contacts').list[0].id }); assert.equal(w.last(A, 'contacts').list.length, 0);
  });

  test(`[${label}] blocked caller sees the same thing as an offline player`, async () => {
    const store = await make(); const w = world(store); const A = await w.mk('A'), B = await w.mk('B');
    await w.say(B, { k: 'block', num: w.last(A, 'me').num });
    await w.say(A, { k: 'call', num: w.last(B, 'me').num }); assert.equal(w.last(A, 'fail').reason, 'offline'); assert.equal(w.all(B, 'in').length, 0);
  });

  test(`[${label}] second login on the same account replaces the first and ends its call`, async () => {
    const store = await make(); const w = world(store); const A = await w.mk('A'), B = await w.mk('B');
    const tok = w.last(A, 'me').tok; await w.say(A, { k: 'call', num: w.last(B, 'me').num }); await w.say(B, { k: 'answer' });
    const A2 = await w.mk('A', tok); assert.equal(w.last(A, 'err').code, 'replaced'); assert.equal(w.last(B, 'ended').reason, 'lost');
    assert.equal(w.last(A2, 'me').num, w.last(A, 'me').num);
  });
}

test('postgres: unique constraints reject duplicates, call updates are conditional', async () => {
  const store = await pgStore(); const a = await store.createAccount('a');
  await assert.rejects(() => store.q('INSERT INTO phone_users (token_hash, display_name, phone_number) VALUES ($1,$2,$3)', ['other', 'x', a.user.phone]));
  await assert.rejects(() => store.q('INSERT INTO phone_users (token_hash, display_name, phone_number) VALUES ($1,$2,$3)', ['t2', 'x', '012345']));
  const b = await store.createAccount('b');
  const id = await store.createCall({ callerId: a.user.id, receiverId: b.user.id, callerPhone: a.user.phone, receiverPhone: b.user.phone });
  assert.equal(await store.updateCall(id, ['ringing'], { status: 'rejected', ended: true }), true);
  assert.equal(await store.updateCall(id, ['ringing'], { status: 'answered', answered: true }), false);   // cannot become answered after rejected
  await store.createCall({ callerId: a.user.id, receiverId: b.user.id, callerPhone: a.user.phone, receiverPhone: b.user.phone, status: 'ringing' });
  await store.reconcile(); const r = await store.recents(a.user.id); assert.deepEqual(r.map((x) => x.status).sort(), ['failed', 'rejected']);
});
