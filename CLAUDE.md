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
