'use strict';
/* node --test test/  - economy store: the Postgres SQL (via pg-mem) and the memory store behave the same. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PgStore, MemStore, START_CASH } = require('../economy-store');
async function pg() { const { newDb } = require('pg-mem'); const { Pool } = newDb().adapters.createPg(); const s = new PgStore(new Pool()); await s.init(); return s; }
for (const [name, make] of [['postgres', pg], ['memory', async () => new MemStore()]]) {
  test(name + ': new profile, reward, purchase, double purchase, insufficient funds, log', async () => {
    const s = await make();
    const p = await s.profile(7, { shirt: '#fff' }); assert.equal(p.cash, START_CASH); assert.equal(p.fresh, true);
    assert.equal((await s.profile(7)).fresh, false);
    assert.equal(await s.credit(7, 5000, 1000, 'MISSION_REWARD', 'food'), START_CASH + 5000);
    const r1 = await s.buy(7, 'vehicle', 'city125', 6000, { color: '#c00' }); assert.equal(r1.ok, true); assert.equal(r1.cash, START_CASH + 5000 - 6000);
    const r2 = await s.buy(7, 'vehicle', 'city125', 6000); assert.equal(r2.ok, false); assert.equal(r2.why, 'owned');
    const r3 = await s.buy(7, 'cloth', 'formal', 4500); assert.equal(r3.ok, false); assert.equal(r3.why, 'funds');
    assert.equal((await s.profile(7)).cash, 500, 'failed purchases take no money');
    assert.deepEqual((await s.owned(7)).map((o) => o.item), ['city125']);
    const tx = await s.txs(7); assert.deepEqual(tx.map((t) => t.type), ['VEHICLE_PURCHASE', 'MISSION_REWARD', 'START']); assert.equal(tx[0].after, 500);
  });
}
