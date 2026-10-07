# Kozhikode in miniature — project notes

3D browser game of Kozhikode (Kerala) + a small multiplayer server.

## Layout
- `public/index.html` — the whole game client (single file, ~300 KB, Three.js r128 from cdnjs). Coordinates: +x east, +z south, metres.
- `server.js` — Node + `ws`. Serves `public/` and a WebSocket at `/ws` (positions, nearby chat, vehicle ownership, WebRTC voice handshake).
- `render.yaml` — Render web service (free plan). Auto-deploys on push to `main` if Auto-Deploy is on.

## Client map (search these names in index.html)
- `buildHuman(O)` — articulated person (player + remote players). `Player` — controller/animation. `Peds` — instanced NPC pedestrians.
- `vehGeo`, `carBody`, `busBody`, `rider`, `wheelGeo` — procedural vehicles; `PVehicle` — drivable vehicles (`PVEH` list, index = vehicle id in multiplayer).
- `Traffic` (NPC traffic), `Game` (loop/start), `UI`, `Input`, touch controls IIFE (before `const UI`).
- `Net` — multiplayer client: snapshots, name tags, chat, vehicle claim/release, voice (WebRTC, `voiceUpdate`).

## Multiplayer rules
- Client sends state ~12 Hz; server sends 10 Hz snapshots within 350 m.
- Chat radius 30 m, voice connects within 25 m and hangs up past 35 m.
- Shared seats: seat 0 = driver, others are passengers (bike/scooter 2, hatch/sedan/suv 4, auto-rickshaw 3, rest 1; see `seatCap`/`seatFor`/`freeSeat`). Client sends `sn` (seat) in state; server keeps `occ` = array of player ids per seat per vehicle, only seat 0 writes the vehicle pose, and replies `deny` if a seat is taken. If the driver leaves, a passenger is promoted to seat 0.
- Travel (T menu) while driving moves the vehicle with everyone in it (`Game.teleport(...,carry)`); the server always sends you the players sharing your vehicle, even beyond 350 m, and clients snap (not glide) when a vehicle jumps >25 m. A denied seat makes the client try the next seat.
- Vehicle glass is split into a transparent mesh (`splitGlass`) so seated people show through windows.
- NPC traffic/peds are local per player (not synced). Vehicle poses are kept by the server.
- Page must be opened from the server origin (or with `?server=wss://host/ws`). Mic needs HTTPS.

## Testing
- `npm install && npm start`, open http://localhost:3000 in two tabs.
- Headless checks used so far: Playwright + Chromium with `--use-gl=swiftshader` (slow: ~1 min per page load, run pages in the background); fake mic flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.

## Ideas not done yet
Accounts/moderation (mute/report), TURN server for voice on strict networks, remote-player vehicle collisions, saving last position.
