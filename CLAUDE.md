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

## Graphics
- Visual overhaul runs in phases on `shadul-dev` (1 lighting/atmosphere, 2 roads+promenade+ocean, 3 vegetation, 4 vehicles, 5 characters, 6 buildings/shops/props, 7 UI, 8 perf+QA). External CC0 assets may go in `public/assets/` (list source + license per file); code stays in index.html.
- `Game.QUALITY` presets Low/Medium/High/Ultra (render scale, shadow map size + area, LOD, traffic, peds). `autoQuality()` picks Low/Medium on phones, High on desktop; G cycles and saves to localStorage `kzk_q`.
- Fog is replaced globally (`THREE.ShaderChunk.fog_fragment`): exponential haze with desaturation; fogNear/fogFar mean start/scale, not hard limits. Default weather = Kerala 5 PM.
- Ground PBR (`groundPBR`, `beachGround`): photo textures from `public/assets/tex`, world-space anti-tiled. Three r128 caches shader programs by `onBeforeCompile.toString()` (no `customProgramCacheKey`), so every patched material variant overrides `toString` with a unique key — do the same for new patched materials or they silently reuse another program.
- Road dressing: raised concrete kerbs (`eKerb`, batch key `kerb`, visual only — physics/groundY unchanged), edge grime via colour-gradient strips (`eStripG`), asphalt wear in the road shader (tar patches, cracks, oil), worn paint on `MAT.mark`, manholes + drain gratings on art/main roads. Patched materials without a `map` can't use `mapTexelToLinear` — decode sRGB by hand.
- Vegetation: `Batch.add('palm'|'tree'|'shrub')` adds a detailed near-LOD variant (`palmA/B/C`, `treeHi`, `shrubHi`: ringed bark, V-folded fronds, leaf-card canopies, `windSway` vertex wind) plus the old simple model in the new `midx` group (visible only between LOD.near and LOD.mid). Big landmark batches (r>400, e.g. the beach) hand trees to the streaming chunk; farbank/far batches use `*M` simple types.
- Vehicles: car/auto bodies use `profGeoR` (rounded profile + 3-step bevel + `smoothNormals`), `wheelArches`, clear-coat `MAT.veh` (MeshPhysical), matte `MAT.tire` for drivable-vehicle wheels. KSRTC buses (`isKSRTC`) carry a side advert (`busAdQuads`, `MAT.ad`, image `public/assets/ads/tripla.png`) on parked (batch key `ad`), traffic and drivable buses.
- Characters: `loadChars()` loads `public/assets/chars/men_*.glb` (owner-supplied CC0 Quaternius Animated Men; 4 outfits, `look.o` 0–3, passed by the server). `makeAvatar` tints Shirt/Pants/Skin/Hair materials, normalises to 1.76 m; `avAnimate` maps Idle/Walk/Run(jog+sprint, time-scaled)/Jump/Sitting. Falls back to `buildHuman`. NPC `Peds`: instanced simple bodies everywhere, but the nearest `Peds.avN` (Low 5 / Med 10 / High 18 / Ultra 28, within 55 m) borrow a rigged man from a 28-avatar pool (`mkPool`/`takeAv`/`updateAvatars`), re-tinted to that pedestrian's colours.
- Model vehicles: `loadVehModels()` + `bakeVehModel()` bake owner-supplied Quaternius cars/ambulance/private buses (`public/assets/veh`) into vertex-coloured geometry used by `vehGeo` (traffic, drivable); parked ones are instanced per chunk (`registerVehInst`, `parkModel`) — merging them blew memory. `VMAP` maps game types to models; KSRTC (`bus`,`busK`) stays procedural. `calibrateVehModels` sets wheelbase/radius from the models. `?noveh` disables them.
- Buildings: `mkBuilding`/`mkHouse` add facade depth (concrete sunshades over each window bay aligned to the facade texture tile, sills, AC units, drain pipes); facade materials use `weathered()` (rising damp at the foot, rain streaks, faded patches in world space).
- Utility lines: every `pole` added through `Batch.add1` is recorded in `POLES`; art/main roads get a pole line on one side every 34 m. `buildCables` links each pole to its nearest aligned neighbour (12–45 m) with 3 sagging conductors — one `LineSegments` draw call.
- Vehicle lights: brake (`bl`), reverse (`rl`) and head-lamp lenses (`hd`) on drivable vehicles; `Env.lightsOn` (dusk/overcast/rain) turns lenses on and drives one `Env.head` SpotLight in front of the player's vehicle (always in the scene, intensity 0 when off, so no shader recompiles).
- Don't put `//` comments in the middle of minified one-line statements — it comments out the rest of the line. Check with an inline-script syntax pass before testing.
- The beach is the shared ground mesh (`MAT.ground`), not `MAT.sandDecal`; `beachGround` blends photo sand + a wet band (from `Env.seaU.uShoreX`) only inside the beach strip.

## Mobile UI
- Touch layout: right column Travel / Phone (`#ph-fab`, repositioned by index.html CSS) / Gfx (cycles quality); Run + Nearest vehicle hidden in vehicles, Horn only in vehicles, Jump button reads Brake while driving. Phone has a ✕ (`#ph-close`) since touch has no P/Esc. Phones default to Ultra (`autoQuality`).
- Seated rigged men: `seatHip(v)` gives seat height; avatar y = seatHip − AV_HIP (0.40), z +0.22.
- Model car windows are a second geometry group drawn with `MAT.carGlass` (`vehMats`); instanced parts copy `groups`.

## Performance
- `close` LOD group (`LOD.close`: Low 90 / Med 130 / High 180 / Ultra 260 m from chunk edge): parked vehicles (batch key `veh`, `vm_*` instances), detailed trees, props. Simple trees (`midx`) fill in beyond it. Parked vehicles always go to streaming chunks (`chunkAt`), never big landmark batches.
- Parked and traffic cars use low-poly model variants (`public/assets/veh/low`, ~60% fewer triangles); only drivable cars use the full models; drivable cars >420 m away are hidden.
- Profile (headless, Low): beach ~0.8M tris / 285 calls, Mavoor Road ~1.3M / 740, HiLITE ~1.55M / 410. JS per frame < 2.5 ms; cost is GPU geometry. Biggest remaining: merged building detail (`plain`).

## Street props
- `loadProps`/`registerProps` bake owner-supplied cones, road signs, bicycles (`public/assets/props`) into instanced `INST.p_*` types. Signs at signal approaches (60%), roadwork cone rings around ~18% of manholes, bicycles at ~8% of shopfronts, KSRTC shelters at every bus route end (`Buses.shelter`).

## Route buses
- `Buses` (index.html): 4 KSRTC routes between TRAVEL places (`ROUTES`), path found on the road graph (Dijkstra), 2 buses each, keep-left lane. Position is a pure function of the shared clock (`Net.tOff` from the server's `now` in the welcome message), so every client sees the same bus with no extra network traffic. 9 m/s, 25 s stop at each end.
- Hollow `busR` body (open window band, seats), transparent glass, destination boards (canvas, Malayalam + English, switch at each end), brown-uniform driver, random passengers from a 16-avatar pool (only buses within 70 m).
- Hailing: a moving bus holds locally (per-bus `delay` subtracted from the shared clock, max 20 s) while a player on foot is within 10 m, or when a rider presses E (`reqStop`). This desyncs that bus slightly from other players; riders are still shown seated in it.
- Board with E at a stopped bus (`Buses.board`), get off with E at a stop (`alight`). Riding players send `rb` = busId*100+seat; the server relays it in snapshots (index 11) and others see them seated.

## Collisions with other players
- Your vehicle (`vsDyn`) already collides with every PVEH, including ones others drive (their poses are in PVEH), and on foot you are pushed out of them (`Player.pushFrom`). Added: your vehicle is blocked by other players on foot (0.38 m circles), and NPC traffic treats other players and their vehicles as obstacles (pushed into `Game.obst`). Each client resolves its own player/vehicle; others' positions are authoritative from their owners.

## Saved state (per device, localStorage)
- `kzk_name`, `kzk_look` (Net/MYLOOK), `kzk_pos` {x,z,h} saved every 5 s and on pagehide/hidden (`Game.savePos`), restored at start by `Game.loadPos` (validated inside the world and out of buildings). `?fresh` ignores it. Also `kzk_q` (graphics), `kzk_muted`.

## Voice / TURN
- `ICE` in server.js = STUN + optional TURN from `TURN_URL` (comma list) / `TURN_USER` / `TURN_PASS` (WEBRTC_* aliases); sent in the welcome message, used by proximity voice (`Net.makePeer`) and the phone. Setup steps in README (*Voice on strict networks*). `node test/turn-config.js` checks a running server hands TURN to clients.

## Economy (vertical slice) — server-authoritative
- `economy.js` (missions, shops, personal vehicles, validation) + `economy-store.js` (Postgres via the phone pool, or memory). Profile keyed by the phone account id (device token), so it survives refresh/relogin. Tables: `eco_profiles`, `eco_owned`, `eco_tx` (transaction log). Purchases are one SQL transaction (balance check + deduct + ownership row).
- Client (`Eco` in index.html) only sends intents `{t:'eco',k:'accept'|'abandon'|'buy'|'wear'|'spawn'|'txs'}`; server replies `me|mission|done|fail|bought|err|txs`, plus `pv` (bought vehicle spawned/removed, vid 1000+) and `lk` (outfit change broadcast).
- Missions progress from server-known positions (`onMove` on each state update): pickup within 9 m, drop within 10 m, minimum time (distance / 45 m/s), position jumps >80 m cancel the job (client blocks T travel during a job). First two jobs are fixed (Nazeer: Mananchira ₹500, Beach ₹700), then generated (₹ ≈ 180 + 0.22/m, 20% fast bonus).
- Spots (job givers, dealer, clothing) and catalog live in economy.js (`SPOTS`, `CATALOG`); new players start with ₹1,500 at Nazeer's Kitchen (Mavoor Road). First scooter ₹6,000 ≈ 10 deliveries.
- Bought vehicles: `PVX` map + `vehById(vi)`; every PVehicle has `vid` (shared = index, bought = 1000+); only the owner may take seat 0 (server denies others).
- Full map: `BigMap` (M, or tap the minimap): drag/wheel/pinch, tap a place/marker or anywhere for a waypoint (`Eco.setWaypoint`); the GPS route (`Eco.route`, road-graph Dijkstra from `Buses.path`) serves both missions and waypoints.
- Auto-rickshaw fares: spot kind `auto` (Railway pre-paid stand, 3 drivable autos appended to SPAWN_VEH there). Server requires `p.vt==='auto'` (client sends vehicle type in state) and seat 0 for pickup and drop; fare ₹100–450 + 25% fast bonus, tx type `FARE`. Passenger NPC waits at pickup then rides seat 1 (`Eco.passenger`).
- Courier runs: `courier` spot (Malabar Express Courier, Palayam): 3 drops chosen nearest-first (`m.drops`, `m.di`), intermediate stops advance on arrival, one payout at the end (₹300 + 0.2/m, +25% in time), tx `COURIER`. Test: `node test/courier-e2e.js`.
- Used cars: Malabar Used Cars near HiLITE (`cars` spot): ₹35k–₹1.4L, showroom vehicles with price tags outside every dealer, star stats in shop. Garage limit 3 vehicles (`GARAGE_SLOTS`). Bought vehicles carry a fictional `KL 11 XX 1234` plate (stable hash of owner+item) shown front/back.
- Tests: `npm test` (store, incl. pg-mem Postgres), `node test/economy-e2e.js`, `node test/auto-e2e.js` against a running server (full loop + exploits).

## Moderation
- Client: People panel (button or K) lists players within 60 m with Mute / Report. Mute is by name, stored in localStorage `kzk_muted`; hides their chat and sets their voice gain to 0.
- Server: chat profanity masked (`BAD` list, English + common Malayalam slurs), rate limit 600 ms gap and max 5 messages / 10 s (`warn` message), reports `{t:'rep',id,reason}` limited to 1 / 30 s, logged to stdout (`REPORT {...}`, visible in Render logs) and `reports.log` (gitignored, lost on Render redeploy) with reporter, target and both players' last 8 chat lines.

## Multiplayer rules
- Client sends state ~12 Hz; server sends 10 Hz snapshots within 350 m.
- Chat radius 30 m, voice connects within 25 m and hangs up past 35 m.
- Shared seats: seat 0 = driver, others are passengers (bike/scooter 2, hatch/sedan/suv 4, auto-rickshaw 3, rest 1; see `seatCap`/`seatFor`/`freeSeat`). Client sends `sn` (seat) in state; server keeps `occ` = array of player ids per seat per vehicle, only seat 0 writes the vehicle pose, and replies `deny` if a seat is taken. If the driver leaves, a passenger is promoted to seat 0.
- Travel (T menu) while driving moves the vehicle with everyone in it (`Game.teleport(...,carry)`); the server always sends you the players sharing your vehicle, even beyond 350 m, and clients snap (not glide) when a vehicle jumps >25 m. A denied seat makes the client try the next seat.
- Vehicle glass is split into a transparent mesh (`splitGlass`) so seated people show through windows.
- NPC traffic/peds are local per player (not synced). Vehicle poses are kept by the server.
- Page must be opened from the server origin (or with `?server=wss://host/ws`). Mic needs HTTPS.

## In-game phone (branch `partner-dev`)
- Server: `phone-server.js` (call sessions: ringing -> answered -> ended, rate limit, glare/busy, signalling relay; identity = `p.ph.user`, never message fields) and `phone-store.js` (Postgres via `DATABASE_URL`, or in-memory fallback). `server.js` only routes `t:'ph'` messages, attaches on `join` (token `tok`) and detaches on close.
- Client: `public/phone.js` + `public/phone.css` (own files so index.html merges stay trivial). index.html hooks: `tok` in the join message, `case 'ph'`, `Phone.onNetClose()` in `ws.onclose`, and `Phone.isPartner(id)` in `voiceUpdate` (stops proximity voice with the person you are on a call with).
- Client call state machine (`P.go`): IDLE, DIALING, CALLING, RINGING, CONNECTING, ACTIVE, ENDING, ENDED, FAILED. Everything a call allocates is released in `teardown()`.
- Phone uses its own mic track (clone of `Net.track` if proximity mic is on) so muting a call never mutes proximity chat. CSS class names must not collide with game CSS (`.nm` is the game's name tag: the phone uses `.pnm`).
- Key P opens the phone; while open `window.__typing` is set so game keys don't leak. Incoming calls open the phone in "auto" mode without suspending game input (Y/N answer/decline).
- Not done: phone-in-hand character animation, replicating "on a phone" state to nearby players, telephone-style audio EQ, Redis for multi-instance.

## Testing
- `npm install && npm start`, open http://localhost:3000 in two tabs.
- Headless checks used so far: Playwright + Chromium with `--use-gl=swiftshader` (slow: ~1 min per page load, run pages in the background); fake mic flags `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`.

## Ideas not done yet

