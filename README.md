# Kozhikode in miniature — multiplayer

One small Node server does two jobs: it serves the game page and it relays players over a WebSocket (`/ws`).
Players see each other (name tags), share vehicles (only one driver at a time), and chat reaches only people within 30 m.

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
- Not included yet: voice chat, accounts, moderation tools. Names are plain text and messages are length-limited and rate-limited.
