// Economy end-to-end against a running server (npm start): new player -> deliveries -> buy scooter -> persistence -> exploits.
// node test/economy-e2e.js [ws://localhost:3000/ws]
const WebSocket = require('ws');
const URL = process.argv[2] || 'ws://localhost:3000/ws';
const P = { mavoor: [-170, 6], mananchira: [-446, 14], beach: [-1100, 20], railway: [-772, 196], nazeer: [-162, 12], scooters: [-762, 186], cloth: [-614, -118] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
function client(name, tok) { return new Promise((res) => { const ws = new WebSocket(URL); const c = { ws, msgs: [], tok: null, pos: [0, 0] };
  ws.on('message', (d) => { const m = JSON.parse(d); c.msgs.push(m); if (m.t === 'ph' && m.k === 'me' && m.tok) c.tok = m.tok; });
  c.send = (o) => ws.send(JSON.stringify(o)); c.last = (k) => [...c.msgs].reverse().find((m) => m.t === 'eco' && m.k === k);
  c.at = (x, z) => { c.pos = [x, z]; c.send({ t: 's', x, y: 0, z, h: 0, sp: 0, vi: -1 }); };
  c.drive = async (x, z, speed = 25) => { const [x0, z0] = c.pos, d = Math.hypot(x - x0, z - z0), n = Math.max(1, Math.ceil(d / (speed * 0.1))); for (let i = 1; i <= n; i++) { c.at(x0 + (x - x0) * i / n, z0 + (z - z0) * i / n); await sleep(100); } };
  ws.on('open', () => { c.send({ t: 'join', name, look: {}, tok }); setTimeout(() => res(c), 800); }); }); }
(async () => {
  const a = await client('EcoTester'); let me = a.last('me');
  check(me && me.cash === 1500, 'new player starts with ₹1,500 (got ' + (me && me.cash) + ')');
  check(me && me.spots.some((s) => s.kind === 'food') && me.spots.some((s) => s.kind === 'dealer'), 'map spots include food job + scooter dealer');
  a.send({ t: 'eco', k: 'done', total: 999999 }); a.send({ t: 'eco', k: 'credit', amount: 999999 }); await sleep(300);
  a.at(...P.nazeer); await sleep(200); a.send({ t: 'eco', k: 'accept', spot: 'nazeer' }); await sleep(300);
  let ms = a.last('mission'); check(ms && ms.mission && ms.mission.to === 'Mananchira', 'first job: Nazeer → Mananchira');
  a.at(-300, 400); await sleep(200);                 // teleport
  check(!!a.last('fail'), 'teleporting mid-job cancels it');
  a.at(...P.nazeer); await sleep(200); a.send({ t: 'eco', k: 'accept', spot: 'nazeer' }); await sleep(300);
  await a.drive(...P.mananchira); await sleep(500);
  let d = a.last('done'); check(d && d.total === 500 && d.cash === 2000, 'delivery pays ₹500, wallet ₹2,000 (got ' + (d && d.cash) + ')');
  a.send({ t: 'eco', k: 'buy', item: 'city125' }); await sleep(300);
  check(/Visit/.test((a.last('err') || {}).text || ''), 'cannot buy away from the dealer');
  await a.drive(...P.scooters, 40); a.send({ t: 'eco', k: 'buy', item: 'city125' }); await sleep(300);
  check(/Not enough/.test((a.last('err') || {}).text || ''), 'cannot buy scooter with ₹2,000');
  // earn: repeat generated deliveries
  for (let i = 0; i < 16 && (a.last("done") || {}).cash < 7000; i++) {
    await a.drive(...P.nazeer, 40); a.msgs = a.msgs.filter((m) => m.k !== 'mission'); a.send({ t: 'eco', k: 'accept', spot: 'nazeer' }); await sleep(300);
    const mm = (a.last('mission') || {}).mission; if (!mm) { console.log('no mission', a.last('err')); break; }
    const tgt = mm.target.x === -162 ? null : mm.target; const dest = mm.stage === 1 ? mm.target : null; await a.drive(dest.x, dest.z, 40); await sleep(400);
  }
  d = a.last('done'); console.log('     wallet after jobs ₹' + (d && d.cash));
  await a.drive(...P.scooters, 40);
  a.send({ t: 'eco', k: 'buy', item: 'city125' }); a.send({ t: 'eco', k: 'buy', item: 'city125' }); await sleep(800);
  const bought = a.msgs.filter((m) => m.k === 'bought'); check(bought.length === 1 && bought[0].cash === d.cash - 6000, 'double-buy: charged once (₹' + (bought[0] && bought[0].cash) + ')');
  a.send({ t: 'eco', k: 'spawn', item: 'city125', h: 0 }); await sleep(300);
  const pv = a.msgs.find((m) => m.t === 'pv' && !m.gone); check(pv && pv.vid >= 1000 && pv.type === 'scooter', 'owned scooter spawns as vehicle ' + (pv && pv.vid));
  const b = await client('Watcher'); await sleep(300);
  b.at(a.pos[0] + 3, a.pos[1]); a.send({ t: 's', x: a.pos[0], y: 0, z: a.pos[1], h: 0, vi: pv.vid, sn: 0 }); await sleep(400);
  const snap = [...b.msgs].reverse().find((m) => m.t === 'p'); const row = snap && snap.p.find((r) => r[7] === pv.vid);
  check(!!row, 'another player sees them on the bought scooter');
  b.send({ t: 's', x: a.pos[0] + 3, y: 0, z: a.pos[1], h: 0, vi: pv.vid, sn: 0 }); await sleep(300);
  check([...b.msgs].some((m) => m.t === 'deny' && m.vi === pv.vid), 'someone else cannot drive your scooter');
  await a.drive(...P.cloth, 40); a.send({ t: 'eco', k: 'buy', item: 'shirt_black' }); await sleep(500);
  const lk = [...b.msgs].reverse().find((m) => m.t === 'lk'); check(lk && lk.look.shirt === '#151515' && lk.look.o === 1, 'black shirt bought and other players see it');
  const cashNow = (a.last('me') || {}).cash, tok = a.tok; a.ws.close(); await sleep(500);
  const a2 = await client('EcoTester', tok); await sleep(500); me = a2.last('me');
  check(me && me.cash === cashNow && me.owned.includes('city125') && me.owned.includes('shirt_black') && me.outfit.shirt === '#151515', 'after reconnect: ₹' + (me && me.cash) + ', scooter + shirt still owned, outfit kept');
  a2.send({ t: 'eco', k: 'txs' }); await sleep(300); console.log('     transactions:', (a2.last('txs') || {}).list.map((t) => t.type + ' ' + t.amount).join(', '));
  process.exit(fails ? 1 : 0);
})();
