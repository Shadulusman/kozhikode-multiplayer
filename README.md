# Kozhikode in miniature — multiplayer

One small Node server does two jobs: it serves the game page and it relays players over a WebSocket (`/ws`).
Players see each other (name tags), share vehicles (only one driver at a time), text chat reaches only people within 30 m, and voice chat connects people within about 25 m.

## Run on your computer
    npm install
    npm start
Open http://localhost:3000 in two browser tabs and press start in both.

## Put it online (Render, free tier works)
1. Upload this folder to a GitHub repo.
2. render.com → New → Web Service → pick the repo.
3. Build command: `npm install`   Start command: `npm start`
4. Open the URL Render gives you. Share it — anyone who opens it joins the same world.
(Free instances sleep after ~15 min idle; the first visit then takes ~30 s to wake. Railway and Fly.io work the same way.)

## Settings (environment variables)
- `PORT` — set automatically by hosts
- `MAX_PLAYERS` — default 60
- `CHAT_RADIUS` — metres, default 30

## Notes
- Traffic and pedestrians (NPCs) are local to each player; only real people are synced.
- The page must be opened from this server's address (same origin). To point a page hosted elsewhere at a server, open it with `?server=wss://your-server.example.com/ws`.
- Voice: tap the Mic button (or press B). It is peer-to-peer (WebRTC); the server only relays the handshake. Volume fades with distance and pans left/right. Needs HTTPS (Render provides it). Use headphones to avoid echo. If players on strict mobile networks can't hear each other, add a TURN server via the env vars `TURN_URL`, `TURN_USER`, `TURN_PASS`.
- Not included yet: full accounts/passwords, moderation tools. Names are plain text and messages are length-limited and rate-limited.

## In-game phone
Press **P** (or tap the phone button) to open your phone. Every player gets a permanent 6-digit number; dial a friend's number to ring them anywhere in the world. Calls are WebRTC voice (peer-to-peer; the server only relays the handshake). Needs a microphone and HTTPS (or localhost). Keys: **P** open/close, **Esc** back, digits + **Enter** dial, **Y**/**N** answer/decline an incoming call (**N** also ends a call while the phone is down).

- **Numbers are tied to a device token** the server issues on first join (kept in the browser's localStorage, stored hashed server-side). Clearing browser data = a new number. There are no passwords yet.
- **Permanent numbers need Postgres.** Set `DATABASE_URL` (any Postgres: Render Postgres, Neon, Supabase). Without it the server falls back to memory and numbers/history reset on every restart (fine for local dev). Tables are created automatically; a UNIQUE index guarantees no two players share a number.
- Optional env vars: `WEBRTC_STUN_URL`, `WEBRTC_TURN_URL`, `WEBRTC_TURN_USERNAME`, `WEBRTC_TURN_CREDENTIAL` (the older `TURN_URL`/`TURN_USER`/`TURN_PASS` also work). A TURN server is needed for players on strict mobile/corporate networks. `PHONE_RING_MS` (default 28000), `PHONE_RATE_MAX` (6 call attempts/min).
- Call state lives in server memory, so run a single instance (as `render.yaml` does). Scaling out needs shared state (e.g. Redis) first.
- `?phonedebug=1` shows a developer panel (call id, peer-connection state).
- Tests: `npm test` (server logic, runs the Postgres SQL against pg-mem). `test/e2e-phone.js` drives two real browsers (see its header).
