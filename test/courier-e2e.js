// Courier run against a running server: accept at Malabar Express, deliver 3 stops in order, get paid once.
const WebSocket = require('ws'); const URL = process.argv[2] || 'ws://localhost:3000/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
(async () => { const ws = new WebSocket(URL), msgs = []; ws.on('message', (d) => msgs.push(JSON.parse(d))); await new Promise((r) => ws.on('open', r));
  const send = (o) => ws.send(JSON.stringify(o)), last = (k) => [...msgs].reverse().find((m) => m.t === 'eco' && m.k === k); let pos = [0, 0];
  const at = (x, z) => { pos = [x, z]; send({ t: 's', x, y: 0, z, h: 0, vi: -1 }); };
  const drive = async (x, z) => { const [x0, z0] = pos, n = Math.max(1, Math.ceil(Math.hypot(x - x0, z - z0) / 4)); for (let i = 1; i <= n; i++) { at(x0 + (x - x0) * i / n, z0 + (z - z0) * i / n); await sleep(100); } };
  send({ t: 'join', name: 'Courier', look: {} }); for (let i = 0; i < 40 && !last('me'); i++) await sleep(100);
  const s = last('me').spots.find((x) => x.kind === 'courier'); pos = [s.x, s.z]; at(s.x, s.z); await sleep(200); send({ t: 'eco', k: 'accept', spot: s.id }); await sleep(300);
  let m = last('mission').mission; check(m && m.kind === 'courier' && m.stage === 1 && m.stop === '1/3', 'courier run: 3 stops, first ' + m.to);
  const seen = [];
  for (let i = 0; i < 3; i++) { m = last('mission').mission; seen.push(m.to); await drive(m.target.x, m.target.z); await sleep(400); }
  const d = last('done'); check(d && d.title === 'COURIER RUN' && d.total > 0, 'paid once after 3 stops: ' + seen.join(' → ') + ' = ₹' + (d && d.total));
  check(msgs.filter((x) => x.k === 'done').length === 1, 'only one payout');
  process.exit(fails ? 1 : 0); })();
