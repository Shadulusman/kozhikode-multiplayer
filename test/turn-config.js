// Checks that the TURN settings reach a joining client. Start the server with TURN_URL/TURN_USER/TURN_PASS set, then: node test/turn-config.js [ws://localhost:3000/ws]
const WebSocket = require('ws');
const url = process.argv[2] || 'ws://localhost:' + (process.env.PORT || 3000) + '/ws';
const ws = new WebSocket(url);
const fail = (msg) => { console.error('FAIL: ' + msg); process.exit(1); };
setTimeout(() => fail('no welcome message within 5 s'), 5000);
ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'turncheck', look: {} })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw); if (m.t !== 'w') return;
  const turn = (m.ice || []).filter((s) => [].concat(s.urls).some((u) => /^turns?:/.test(u)));
  if (!turn.length) fail('welcome message has no turn: server in ice — is TURN_URL set? got ' + JSON.stringify(m.ice));
  for (const t of turn) if (!t.username || !t.credential) fail('TURN entry without username/credential: ' + JSON.stringify(t));
  console.log('OK: clients receive ' + turn.length + ' TURN entr' + (turn.length > 1 ? 'ies' : 'y') + ': ' + turn.map((t) => [].concat(t.urls).join(' ')).join(' | '));
  process.exit(0);
});
