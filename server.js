'use strict';
/* Kozhikode in miniature — multiplayer server.
   Serves the game page and relays players over a WebSocket at /ws.
   Run:  npm install && npm start      (PORT env var supported) */
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 3000;
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 60;
const CHAT_RADIUS = +process.env.CHAT_RADIUS || 30;   // metres: who can read a message
const AOI = 350;                                       // metres: who you can see
const TICK_MS = 100;                                   // snapshot rate (10 Hz)
const PUB = path.join(__dirname, 'public');
// Voice chat is peer-to-peer (WebRTC); this server only relays the handshake.
// Add a TURN server (TURN_URL / TURN_USER / TURN_PASS) if players on strict mobile networks can't hear each other.
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URL) ICE.push({ urls: process.env.TURN_URL.split(','), username: process.env.TURN_USER, credential: process.env.TURN_PASS });

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') { res.writeHead(200); return res.end('ok'); }
  const rel = url === '/' ? '/index.html' : url;
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const TYPES = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.md': 'text/plain; charset=utf-8' };
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });
const players = new Map();      // id -> player
const vehicles = new Map();     // vehicle index -> {x,y,z,h,occ:[playerId|null per seat]}; seat 0 = driver (owns the pose)
let nextId = 1;

const HEX = /^#[0-9a-fA-F]{6}$/;
const num = (v, lim = 1e5) => (typeof v === 'number' && isFinite(v) && Math.abs(v) < lim) ? v : null;
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const broadcast = (o, except) => { const s = JSON.stringify(o); for (const p of players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s); };
const cleanName = (n, id) => (String(n || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16)) || ('Guest' + id);
const cleanLook = (l) => { l = l || {}; return { shirt: HEX.test(l.shirt) ? l.shirt : '#1f6f8a', skin: HEX.test(l.skin) ? l.skin : '#8d5a3b', pants: HEX.test(l.pants) ? l.pants : '#2b3548' }; };

function releaseVehicle(p) {
  if (p.vi < 0) return;
  const v = vehicles.get(p.vi);
  if (v && v.occ[p.sn] === p.id) { v.occ[p.sn] = null; broadcast({ t: 'v', vi: p.vi, x: v.x, y: v.y, z: v.z, h: v.h, occ: v.occ }); }
  p.vi = -1; p.sn = 0;
}

wss.on('connection', (ws) => {
  let p = null, tokens = 40, lastRefill = Date.now(), lastChat = 0;
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const now = Date.now(); tokens = Math.min(40, tokens + (now - lastRefill) / 1000 * 30); lastRefill = now;
    if (--tokens < 0) return;                                   // flood protection
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'join') {
      if (p) return;
      if (players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); return ws.close(); }
      const id = String(nextId++);
      p = { id, ws, name: cleanName(m.name, id), look: cleanLook(m.look), x: 0, y: 0, z: 0, h: 0, sp: 0, og: 1, vi: -1, sn: 0, vf: 0, st: 0 };
      players.set(id, p);
      send(ws, {
        t: 'w', id, total: players.size, ice: ICE,
        players: [...players.values()].filter(q => q !== p).map(q => [q.id, q.name, q.look]),
        vehicles: [...vehicles.entries()].map(([vi, v]) => [vi, v.x, v.y, v.z, v.h, v.occ]),
      });
      broadcast({ t: 'j', id, name: p.name, look: p.look, total: players.size }, p);
      return;
    }
    if (!p) return;

    if (m.t === 's') {
      const x = num(m.x), y = num(m.y, 1e4), z = num(m.z), h = num(m.h, 100), sp = num(m.sp, 200), vf = num(m.vf, 200), st = num(m.st, 10);
      if (x === null || y === null || z === null || h === null) return;
      p.x = x; p.y = y; p.z = z; p.h = h; p.sp = sp || 0; p.og = m.og ? 1 : 0; p.vf = vf || 0; p.st = st || 0;
      const vi = Number.isInteger(m.vi) && m.vi >= 0 && m.vi < 500 ? m.vi : -1;
      const sn = Number.isInteger(m.sn) && m.sn >= 0 && m.sn < 8 ? m.sn : 0;
      if (vi !== p.vi || (vi >= 0 && sn !== p.sn)) {
        releaseVehicle(p);
        if (vi >= 0) {
          const v = vehicles.get(vi) || { x, y, z, h, occ: [] };
          if (v.occ[sn] && v.occ[sn] !== p.id) { send(ws, { t: 'deny', vi, sn }); }
          else { v.occ[sn] = p.id; vehicles.set(vi, v); p.vi = vi; p.sn = sn; }
        }
      }
      if (p.vi >= 0 && p.sn === 0) { const v = vehicles.get(p.vi); v.x = x; v.y = y; v.z = z; v.h = h; }
      return;
    }

    if (m.t === 'sig') {                       // voice handshake, only between nearby players
      const q = players.get(String(m.to));
      if (q && q !== p && m.d && typeof m.d === 'object' && Math.hypot(q.x - p.x, q.z - p.z) <= 60) send(q.ws, { t: 'sig', from: p.id, d: m.d });
      return;
    }

    if (m.t === 'c') {
      if (now - lastChat < 600) return; lastChat = now;
      const text = String(m.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140);
      if (!text) return;
      const out = JSON.stringify({ t: 'c', id: p.id, name: p.name, text });
      for (const q of players.values()) {
        if (q === p || (q.ws.readyState === 1 && Math.hypot(q.x - p.x, q.z - p.z) <= CHAT_RADIUS)) { if (q.ws.readyState === 1) q.ws.send(out); }
      }
    }
  });

  ws.on('close', () => {
    if (!p) return;
    releaseVehicle(p); players.delete(p.id);
    broadcast({ t: 'l', id: p.id, total: players.size });
  });
  ws.on('error', () => {});
});

// 10 Hz world snapshots: each player gets everyone within AOI metres
setInterval(() => {
  const all = [...players.values()];
  for (const p of all) {
    const arr = [];
    for (const q of all) {
      if (q === p) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      if (dx * dx + dz * dz < AOI * AOI || (p.vi >= 0 && q.vi === p.vi)) arr.push([q.id, q.x, q.y, q.z, q.h, q.sp, q.og, q.vi, q.vf, q.st, q.sn]);
    }
    send(p.ws, { t: 'p', p: arr });
  }
}, TICK_MS);

// drop dead connections
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 20000);

server.listen(PORT, () => console.log('Kozhikode multiplayer listening on :' + PORT));
