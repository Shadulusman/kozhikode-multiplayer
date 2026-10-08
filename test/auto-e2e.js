// Auto-rickshaw fare against a running server: accept at the stand, refuse pickup on foot, complete in an auto.
const WebSocket = require('ws'); const URL = process.argv[2] || 'ws://localhost:3000/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let fails = 0; const check = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) fails++; };
(async () => { const ws = new WebSocket(URL), msgs = []; ws.on('message', (d) => msgs.push(JSON.parse(d))); await new Promise((r) => ws.on('open', r));
  const send = (o) => ws.send(JSON.stringify(o)), last = (k) => [...msgs].reverse().find((m) => m.t === 'eco' && m.k === k); let pos = [0, 0], veh = { vi: -1, vt: '' };
  const at = (x, z) => { pos = [x, z]; send({ t: 's', x, y: 0, z, h: 0, vi: veh.vi, sn: 0, vt: veh.vt }); };
  const drive = async (x, z) => { const [x0, z0] = pos, n = Math.max(1, Math.ceil(Math.hypot(x - x0, z - z0) / 4)); for (let i = 1; i <= n; i++) { at(x0 + (x - x0) * i / n, z0 + (z - z0) * i / n); await sleep(100); } };
  send({ t: 'join', name: 'AutoTester', look: {} }); await sleep(900);
  const stand = last('me').spots.find((s) => s.kind === 'auto'); check(!!stand, 'auto stand on the map: ' + (stand && stand.name));
  pos = [stand.x, stand.z]; at(stand.x, stand.z); await sleep(200); send({ t: 'eco', k: 'accept', spot: stand.id }); await sleep(300);
  const mm = last('mission').mission; check(mm && mm.kind === 'auto' && mm.stage === 0, 'fare accepted: pick up at ' + mm.from + ', drop at ' + mm.to);
  await drive(mm.target.x, mm.target.z); await sleep(300); check(last('mission').mission.stage === 0 && /auto-rickshaw/.test((last('err') || {}).text || ''), 'arriving on foot does not pick up the passenger');
  veh = { vi: 7, vt: 'auto' }; at(...pos); await sleep(300); const m2 = last('mission').mission; check(m2.stage === 1, 'in an auto: passenger on board');
  await drive(m2.target.x, m2.target.z); await sleep(500); const d = last('done'); check(d && d.kind === 'auto' && d.total >= 100 && d.total <= 450 + 120, 'fare paid ₹' + (d && d.total) + ' (' + (d && d.item) + ')');
  process.exit(fails ? 1 : 0); })();
