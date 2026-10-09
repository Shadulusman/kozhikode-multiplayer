// Daily goals, fishing, fish market, race (entry fee, checkpoints, prize) against a running server.
const WebSocket = require('ws'); const URL = process.argv[2] || 'ws://localhost:3000/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
(async () => { const ws = new WebSocket(URL), msgs = []; ws.on('message', (d) => msgs.push(JSON.parse(d))); await new Promise((r) => ws.on('open', r));
  const send = (o) => ws.send(JSON.stringify(o)), last = (k) => [...msgs].reverse().find((m) => m.t === 'eco' && m.k === k); let pos = [0, 0], vi = -1;
  const at = (x, z) => { pos = [x, z]; send({ t: 's', x, y: 0, z, h: 0, vi, sn: 0 }); };
  const drive = async (x, z, step = 3) => { const [x0, z0] = pos, n = Math.max(1, Math.ceil(Math.hypot(x - x0, z - z0) / step)); for (let i = 1; i <= n; i++) { at(x0 + (x - x0) * i / n, z0 + (z - z0) * i / n); await sleep(100); } };
  send({ t: 'join', name: 'Angler', look: {} }); for (let i = 0; i < 40 && !last('me'); i++) await sleep(100);
  const me = last('me'), spot = (k) => me.spots.find((s) => s.kind === k); await sleep(300);
  const dl = last('daily'); check(dl && dl.goals.length >= 4, 'daily goals sent: ' + (dl && dl.goals.map((g) => g.label).join(' | ')));
  const f = spot('fishing'); pos = [f.x, f.z]; at(f.x, f.z); await sleep(200);
  send({ t: 'eco', k: 'cast' }); await sleep(200); send({ t: 'eco', k: 'reel' }); await sleep(300); check((last('fish') || {}).state === 'early', 'reeling before the bite fails');
  let caught = 0; for (let i = 0; i < 3; i++) { send({ t: 'eco', k: 'cast' }); await sleep(200); const c = last('fish'); await sleep(c.biteIn + 200); send({ t: 'eco', k: 'reel' }); await sleep(300); if ((last('fish') || {}).state === 'caught') caught++; }
  check(caught === 3, 'reeling at the bite catches fish (' + caught + '/3): ' + last('fish').fish);
  const mk = spot('market'); await drive(mk.x, mk.z, 4); send({ t: 'eco', k: 'sell' }); await sleep(400); const sold = last('sold'); check(sold && sold.n === 3 && sold.total >= 180, 'sold 3 fish for ₹' + (sold && sold.total));
  const r = spot('race'); await drive(r.x, r.z, 4); send({ t: 'eco', k: 'accept', spot: r.id }); await sleep(300); check(/vehicle/.test((last('err') || {}).text || ''), 'race needs a vehicle');
  vi = 3; at(...pos); await sleep(200); const before = (last('sold') || {}).cash; send({ t: 'eco', k: 'accept', spot: r.id }); await sleep(400);
  const cs = last('cash'); check(cs && cs.cash === before - 200, 'entry fee ₹200 taken (₹' + before + ' → ₹' + (cs && cs.cash) + ')');
  await sleep(3200); for (let i = 0; i < 3; i++) { const m = last('mission').mission; await drive(m.target.x, m.target.z, 3); await sleep(300); }
  const res = last('race'); check(res && res.secs > 0, 'race finished in ' + (res && res.secs) + ' s (target ' + (res && res.par) + ' s), prize ₹' + (res && res.prize));
  process.exit(fails ? 1 : 0); })();
