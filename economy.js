'use strict';
/* Server-authoritative economy: wallet, XP, delivery missions, shops, personal vehicles.
   The client only sends intents (accept job, buy item, wear, spawn vehicle). Money, prices, rewards, mission
   progress and ownership are decided here from server-known positions (p.x/p.z from state updates). */

// Places (x, z in metres) — same spots as the client's TRAVEL points.
const PLACES = {
  mavoor: { x: -170, z: 6, en: 'Mavoor Road', ml: 'മാവൂർ റോഡ്' }, palayam: { x: -560, z: 208, en: 'Palayam', ml: 'പാളയം' },
  beach: { x: -1100, z: 20, en: 'Kozhikode Beach', ml: 'കോഴിക്കോട് ബീച്ച്' }, mananchira: { x: -446, z: 14, en: 'Mananchira', ml: 'മാനാഞ്ചിറ' },
  smstreet: { x: -622, z: -126, en: 'S.M. Street', ml: 'മിഠായി തെരുവ്' }, railway: { x: -772, z: 196, en: 'Railway Station', ml: 'റെയിൽവേ സ്റ്റേഷൻ' },
  hilite: { x: 826, z: 596, en: 'HiLITE Mall', ml: 'ഹൈലൈറ്റ് മാൾ' }, thondayad: { x: 782, z: 34, en: 'Thondayad', ml: 'തൊണ്ടയാട്' },
  medical: { x: 1144, z: -12, en: 'Medical College', ml: 'മെഡിക്കൽ കോളേജ്' }, beypore: { x: -1094, z: 1210, en: 'Beypore', ml: 'ബേപ്പൂർ' }, sarovaram: { x: 214, z: -150, en: 'Sarovaram', ml: 'സരോവരം' },
};
// Job givers and shops. Offsets keep the marker beside, not on, the fast-travel point.
const SPOTS = [
  { id: 'nazeer', kind: 'food', name: "Nazeer's Kitchen", ml: 'നസീറിന്റെ അടുക്കള', at: 'mavoor', dx: 8, dz: 6 },
  { id: 'spice', kind: 'food', name: 'Malabar Spice', ml: 'മലബാർ സ്പൈസ്', at: 'palayam', dx: 6, dz: -8 },
  { id: 'shawaya', kind: 'food', name: 'Beach Shawaya', ml: 'ബീച്ച് ഷവായ', at: 'beach', dx: 10, dz: 12 },
  { id: 'fish_beach', kind: 'fishing', name: 'Beach fishing spot', ml: 'മീൻപിടുത്തം', at: 'beach', dx: -72, dz: 60 },
  { id: 'fish_beypore', kind: 'fishing', name: 'Beypore fishing spot', ml: 'ബേപ്പൂർ മീൻപിടുത്തം', at: 'beypore', dx: -8, dz: 30 },
  { id: 'fishmarket', kind: 'market', name: 'Beach Fish Market', ml: 'മീൻ ചന്ത', at: 'beach', dx: 18, dz: -22 },
  { id: 'race_city', kind: 'race', name: 'Calicut City Sprint', ml: 'സിറ്റി സ്പ്രിന്റ്', at: 'mavoor', dx: -12, dz: -10 },
  { id: 'courier', kind: 'courier', name: 'Malabar Express Courier', ml: 'മലബാർ എക്സ്പ്രസ് കൊറിയർ', at: 'palayam', dx: -14, dz: 10 },
  { id: 'autostand', kind: 'auto', name: 'Railway Pre-paid Auto Stand', ml: 'പ്രീ-പെയ്ഡ് ഓട്ടോ', at: 'railway', dx: -12, dz: 12 },
  { id: 'scooters', kind: 'dealer', name: 'Calicut Two Wheelers', ml: 'കാലിക്കറ്റ് ടൂ വീലേഴ്സ്', at: 'railway', dx: 10, dz: -10 },
  { id: 'cars', kind: 'dealer', name: 'Malabar Used Cars', ml: 'മലബാർ യൂസ്ഡ് കാർസ്', at: 'hilite', dx: -22, dz: -26 },
  { id: 'cloth', kind: 'cloth', name: 'Kasavu Textiles', ml: 'കസവ് ടെക്സ്റ്റൈൽസ്', at: 'smstreet', dx: 8, dz: 8 },
].map((s) => ({ ...s, x: PLACES[s.at].x + s.dx, z: PLACES[s.at].z + s.dz }));
const SPOT = Object.fromEntries(SPOTS.map((s) => [s.id, s]));

const CATALOG = {
  // vehicles (type = client VEH type). Prices tuned so the first scooter takes ~10 deliveries.
  city125: { kind: 'vehicle', name: 'City 125 scooter', type: 'scooter', price: 6000, color: '#c62828', shop: 'scooters', stats: [2, 2, 4, 3] },
  breeze: { kind: 'vehicle', name: 'Breeze scooter', type: 'scooter', price: 9500, color: '#1565c0', shop: 'scooters', stats: [3, 3, 4, 3] },
  thunder150: { kind: 'vehicle', name: 'Thunder 150 bike', type: 'bike', price: 18000, color: '#212121', shop: 'scooters', stats: [4, 4, 3, 4] },
  // used cars (prices: a first car is several hours of jobs; ~₹10k/hour from deliveries/fares)
  maruti_old: { kind: 'vehicle', name: 'Old Hatch 800', type: 'hatch', price: 35000, color: '#b71c1c', shop: 'cars', stats: [2, 2, 3, 3] },
  urban_x1: { kind: 'vehicle', name: 'Urban X1 sedan', type: 'sedan', price: 75000, color: '#0d47a1', shop: 'cars', stats: [3, 3, 4, 3] },
  sporty_gt: { kind: 'vehicle', name: 'Sporty GT', type: 'sedan', price: 120000, color: '#f5f5f5', shop: 'cars', stats: [4, 4, 4, 4] },
  ranger_suv: { kind: 'vehicle', name: 'Ranger SUV', type: 'suv', price: 140000, color: '#212121', shop: 'cars', stats: [3, 3, 3, 4] },
  // clothes: outfit style (o) + colours
  tee_white: { kind: 'cloth', name: 'White T-shirt', price: 350, look: { o: 0, shirt: '#f5f5f5' }, shop: 'cloth' },
  shirt_black: { kind: 'cloth', name: 'Black shirt', price: 850, look: { o: 1, shirt: '#151515' }, shop: 'cloth' },
  shirt_kasavu: { kind: 'cloth', name: 'Kasavu cream shirt', price: 1200, look: { o: 1, shirt: '#efe3c2', pants: '#f4efe0' }, shop: 'cloth' },
  shirt_green: { kind: 'cloth', name: 'Malabar green shirt', price: 900, look: { o: 1, shirt: '#1b5e20' }, shop: 'cloth' },
  sports: { kind: 'cloth', name: 'Sports tee + shorts', price: 700, look: { o: 2, shirt: '#ef6c00', pants: '#212121' }, shop: 'cloth' },
  formal: { kind: 'cloth', name: 'Formal suit', price: 4500, look: { o: 3, shirt: '#263238', pants: '#263238' }, shop: 'cloth' },
};
const DAILY = [ { id: 'food', label: 'Deliver 5 food orders', n: 5, bonus: 1500 }, { id: 'auto', label: 'Complete 3 auto fares', n: 3, bonus: 800 },
  { id: 'courier', label: 'Finish 2 courier runs', n: 2, bonus: 1000 }, { id: 'fish', label: 'Catch 5 fish', n: 5, bonus: 500 }, { id: 'race', label: 'Finish a race', n: 1, bonus: 400 } ];
const FISH = [ { id: 'fish_mathi', name: 'Mathi (sardine)', p: 0.68, price: 60 }, { id: 'fish_ayala', name: 'Ayala (mackerel)', p: 0.26, price: 150 }, { id: 'fish_neymeen', name: 'Neymeen (seer fish)', p: 0.06, price: 500 } ];
const RACES = { race_city: { name: 'Calicut City Sprint', fee: 200, cps: ['mananchira', 'smstreet', 'railway'], prize: 900, minor: 300 } };
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);   // Kerala calendar day
const FOODS = ['Kozhikode biriyani', 'Chicken biriyani', 'Porotta + beef', 'Pathiri + chicken curry', 'Shawaya', 'Tea + snacks', 'Kozhikode halwa', 'Fresh juice'];

/** fictional Kerala-style registration (KL 11 = Kozhikode district code style), stable per owner+vehicle */
function plate(uid, item) { let h = 2166136261; for (const ch of String(uid) + ':' + item) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const L = 'ABCDEFGHJKLMNPRSTUVWXYZ'; return 'KL 11 ' + L[h % 23] + L[(h >>> 5) % 23] + ' ' + String(1000 + (h >>> 10) % 9000); }
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const xpLevel = (xp) => Math.floor(Math.sqrt(xp / 100)) + 1;
const GARAGE_SLOTS = 3, R_SPOT = 9, R_DROP = 10, MAX_JUMP = 80, MAX_SPEED = 45;

function createEconomy({ store, send, broadcast, players = () => [], log = console.log }) {
  const activePlayers = () => [...players()].filter((p) => p.eco);
  const pvSlots = new Map();   // vid -> {vid, owner p, type, color}
  const nextSlot = () => { for (let i = 0; i < 100; i++) if (!pvSlots.has(1000 + i)) return 1000 + i; return -1; };

  function offer(p, spotId) {
    const s = SPOT[spotId]; if (!s) return null;
    if (s.kind === 'auto') {   // passenger waiting somewhere in the city -> drop at another place
      const places = Object.values(PLACES), from = places.filter((d) => dist(d, s) > 120 && dist(d, s) < 900)[Math.floor(Math.random() * 6)] || PLACES.mananchira;
      const to = places.filter((d) => d !== from && dist(d, from) > 250 && dist(d, from) < 1500); const dest = to[Math.floor(Math.random() * to.length)], d = dist(from, dest);
      const base = Math.min(450, Math.max(100, Math.round((80 + d * 0.25) / 10) * 10)), bonus = Math.round(base * 0.25 / 10) * 10;
      return { kind: 'auto', giver: s.id, item: 'Passenger', pickup: { ...from, name: from.en, x: from.x + 6, z: from.z + 4 }, dest, base, bonus, limit: Math.round((dist(s, from) + d) / 7 + 90), needAuto: true };
    }
    if (s.kind === 'race') { const R = RACES[s.id], cps = R.cps.map((k) => ({ ...PLACES[k] })); let len = 0, prev = s; for (const c of cps) { len += dist(prev, c); prev = c; }
      return { kind: 'race', giver: s.id, item: R.name, pickup: s, dest: cps[0], drops: cps, di: 0, base: R.prize, bonus: 0, par: Math.round(len / 16), limit: Math.round(len / 16), story: R.name.toUpperCase(), needVehicle: true, fee: R.fee }; }
    if (s.kind === 'courier') {   // 3 drops in nearest-first order; pays per stop + bonus for finishing in time
      const cargo = ['documents', 'electronics', 'medicine', 'shop stock', 'parcel', 'textiles'], left = Object.values(PLACES).filter((d) => dist(d, s) > 150 && dist(d, s) < 1300), drops = [];
      let cur = s; for (let i = 0; i < 3 && left.length; i++) { left.sort((a, b) => dist(a, cur) - dist(b, cur)); const k = Math.min(left.length - 1, Math.floor(Math.random() * 2)); const d = left.splice(k, 1)[0]; drops.push({ ...d, what: cargo[Math.floor(Math.random() * cargo.length)] }); cur = d; }
      let len = 0, prev = s; for (const d of drops) { len += dist(prev, d); prev = d; }
      const base = Math.round((300 + len * 0.2) / 10) * 10;
      return { kind: 'courier', giver: s.id, item: drops.length + ' parcels', pickup: s, dest: drops[0], drops, di: 0, base, bonus: Math.round(base * 0.25 / 10) * 10, limit: Math.round(len / 6 + 120), story: 'COURIER RUN' };
    }
    if (s.kind !== 'food') return null;
    const n = p.eco.prof.jobs;
    // onboarding: first two jobs are fixed (Nazeer), then generated
    if (n === 0 && spotId === 'nazeer') return { giver: s.id, item: 'Malabar biriyani', pickup: s, dest: PLACES.mananchira, base: 500, bonus: 0, limit: 420, story: 'FIRST DELIVERY' };
    if (n === 1 && spotId === 'nazeer') return { giver: s.id, item: 'Parcel for a beach stall', pickup: s, dest: PLACES.beach, base: 700, bonus: 0, limit: 480, story: 'BEACH ORDER' };
    const pool = Object.values(PLACES).filter((d) => dist(d, s) > 250 && dist(d, s) < 1400);
    const dest = pool[Math.floor(Math.random() * pool.length)], d = dist(s, dest);
    const base = Math.round((180 + d * 0.22) / 10) * 10, bonus = Math.round(base * 0.2 / 10) * 10, limit = Math.round(d / 6 + 60);
    return { giver: s.id, item: FOODS[Math.floor(Math.random() * FOODS.length)], pickup: s, dest, base, bonus, limit };
  }
  const missionView = (m) => m && { kind: m.kind || 'food', stop: m.drops ? (m.di + 1) + '/' + m.drops.length : '', title: m.story || (m.kind === 'auto' ? 'AUTO FARE' : 'FOOD DELIVERY'), item: m.item, stage: m.stage, from: m.pickup.name, to: m.dest.en, toMl: m.dest.ml,
    target: m.stage === 0 ? { x: m.pickup.x, z: m.pickup.z } : { x: m.dest.x, z: m.dest.z }, base: m.base, bonus: m.bonus, limit: m.limit, left: Math.max(0, Math.round(m.limit - (Date.now() - m.t0) / 1000)) };

  async function sendMe(p, extra) {
    const e = p.eco; const owned = await store.owned(e.uid);
    send(p.ws, { t: 'eco', k: 'me', cash: e.prof.cash, xp: e.prof.xp, level: xpLevel(e.prof.xp), jobs: e.prof.jobs, rep: e.prof.rep,
      owned: owned.map((o) => o.item), outfit: e.prof.outfit, spots: SPOTS.map(({ id, kind, name, ml, x, z }) => ({ id, kind, name, ml, x, z })),
      catalog: CATALOG, mission: missionView(e.mission), fresh: !!extra && extra.fresh, inv: await store.inv(e.uid), fishPrices: Object.fromEntries(FISH.map((f) => [f.id, f.price])), fishNames: Object.fromEntries(FISH.map((f) => [f.id, f.name])) });
  }

  async function attach(p, uid) {
    try {
      const prof = await store.profile(uid, p.look);
      p.eco = { uid, prof, mission: null, lastPos: null, busy: false };
      if (prof.outfit && Object.keys(prof.outfit).length) { p.look = { ...p.look, ...prof.outfit }; broadcast({ t: 'lk', id: p.id, look: p.look }); }
      await sendMe(p, { fresh: prof.fresh }); await sendDaily(p);
    } catch (e) { log('[eco] attach failed', e && e.message); }
  }

  function despawnPV(p) { for (const [vid, v] of pvSlots) if (v.owner === p) { pvSlots.delete(vid); broadcast({ t: 'pv', vid, gone: 1 }); } }
  function detach(p) { despawnPV(p); }
  const pvList = () => [...pvSlots.values()].map((v) => ({ vid: v.vid, type: v.type, color: v.color, plate: v.plate, x: v.x, z: v.z, h: v.h, owner: v.owner.id }));
  const pvOwner = (vid) => { const v = pvSlots.get(vid); return v ? v.owner : null; };

  /** called on every position update: teleport check + objective progress */
  async function onMove(p) {
    const e = p.eco; if (!e) return; const pos = { x: p.x, z: p.z }, now = Date.now();
    if (e.lastPos && e.mission) { const dt = Math.max(0.05, (now - e.lastPos.t) / 1000), jump = dist(pos, e.lastPos);
      if (jump > MAX_JUMP && jump / dt > MAX_SPEED && !p.onBus) { const m = e.mission; e.mission = null; send(p.ws, { t: 'eco', k: 'fail', title: m.story || 'FOOD DELIVERY', why: 'Fast travel cancels a job in progress.' }); } }
    e.lastPos = { ...pos, t: now };
    const m = e.mission; if (!m || e.busy) return;
    if (m.needVehicle && !(p.vi >= 0 && p.sn === 0)) { if (!m.warned) { m.warned = true; send(p.ws, { t: 'eco', k: 'err', text: 'Races are driven — get in a vehicle' }); } return; }
    if (m.kind === 'race' && now < m.go) return;   // countdown
    if (m.needAuto && !(p.vi >= 0 && p.sn === 0 && p.vt === 'auto')) { if (m.stage === 0 && dist(pos, m.pickup) < R_SPOT && !m.warned) { m.warned = true; send(p.ws, { t: 'eco', k: 'err', text: 'Drive an auto-rickshaw to pick up the passenger' }); } return; }
    if (m.stage === 0 && dist(pos, m.pickup) < R_SPOT) { m.stage = 1; m.tPick = now; send(p.ws, { t: 'eco', k: 'mission', mission: missionView(m), note: m.kind === 'auto' ? 'Passenger on board — drive to ' + m.dest.en : 'Order collected — deliver to ' + m.dest.en }); return; }
    if (m.stage === 1 && m.drops && m.di < m.drops.length - 1 && dist(pos, m.dest) < R_DROP) {   // intermediate courier stop
      m.di++; m.dest = m.drops[m.di]; send(p.ws, { t: 'eco', k: 'mission', mission: missionView(m), note: (m.kind === 'race' ? 'Checkpoint ' : 'Parcel delivered (') + m.di + '/' + m.drops.length + (m.kind === 'race' ? '' : ')') + ' — next: ' + m.dest.en }); return; }
    if (m.stage === 1 && dist(pos, m.dest) < R_DROP) {
      const secs = (now - m.t0) / 1000, minSecs = (m.drops ? m.drops.reduce((a, d, i) => a + dist(i ? m.drops[i - 1] : m.pickup, d), 0) : dist(m.pickup, m.dest)) / MAX_SPEED;       // can't be faster than a fast car
      if (secs < minSecs) { e.mission = null; send(p.ws, { t: 'eco', k: 'fail', title: 'DELIVERY', why: 'Delivery rejected.' }); log('[eco] rejected too-fast delivery', p.name, secs.toFixed(1)); return; }
      if (m.kind === 'race') return finishRace(p, m, now);
      const fast = secs <= m.limit, amount = m.base + (fast ? m.bonus : 0), xp = Math.round(amount / 5);
      e.busy = true; e.mission = null;
      try { const cash = await store.credit(e.uid, amount, xp, m.kind === 'auto' ? 'FARE' : m.kind === 'courier' ? 'COURIER' : 'MISSION_REWARD', (m.kind || 'food') + ':' + m.giver + '>' + m.dest.en);
        e.prof.cash = cash; e.prof.xp += xp; e.prof.jobs++; e.prof.rep++;
        bumpDaily(p, m.kind || 'food');
        send(p.ws, { t: 'eco', k: 'done', kind: m.kind || 'food', title: m.story || (m.kind === 'auto' ? 'FARE COMPLETE' : 'DELIVERY COMPLETE'), item: m.kind === 'auto' ? m.pickup.name + ' → ' + m.dest.en : m.drops ? m.drops.length + ' parcels delivered' : m.item, base: m.base, bonus: fast ? m.bonus : 0, total: amount, xp, cash, level: xpLevel(e.prof.xp), jobs: e.prof.jobs });
      } catch (err) { log('[eco] credit failed', err && err.message); send(p.ws, { t: 'eco', k: 'err', text: 'Could not save your reward — try again' }); }
      finally { e.busy = false; }
    }
  }

  async function handle(p, m) {
    const e = p.eco; if (!e) return send(p.ws, { t: 'eco', k: 'err', text: 'Wallet not ready yet' });
    const near = (id) => SPOT[id] && dist(p, SPOT[id]) < R_SPOT + 3;
    if (m.k === 'accept') {
      if (e.mission) return send(p.ws, { t: 'eco', k: 'err', text: 'Finish your current job first' });
      if (!near(m.spot)) return send(p.ws, { t: 'eco', k: 'err', text: 'Walk to the job marker first' });
      if (SPOT[m.spot] && SPOT[m.spot].kind === 'race' && !(p.vi >= 0 && p.sn === 0)) return send(p.ws, { t: 'eco', k: 'err', text: 'Get in a vehicle at the start line first' });
      const o = offer(p, m.spot); if (!o) return;
      if (o.fee) { const after = await store.debit(e.uid, o.fee, 'RACE_ENTRY', o.item); if (after === null) return send(p.ws, { t: 'eco', k: 'err', text: 'Entry fee is ₹' + o.fee }); e.prof.cash = after; send(p.ws, { t: 'eco', k: 'cash', cash: after }); }
      e.mission = { ...o, stage: 0, t0: Date.now() };
      if (o.kind === 'race') { e.mission.stage = 1; e.mission.go = Date.now() + 3000; e.mission.t0 = e.mission.go; e.offer = null; return send(p.ws, { t: 'eco', k: 'mission', mission: missionView(e.mission), note: 'Race starts in 3…', countdown: 3 }); }
      if (!o.needAuto && dist(p, o.pickup) < R_SPOT + 3) { e.mission.stage = 1; e.mission.tPick = Date.now(); }
      return send(p.ws, { t: 'eco', k: 'mission', mission: missionView(e.mission), note: o.kind === 'courier' ? 'Parcels loaded — first stop: ' + o.dest.en : o.kind === 'auto' ? 'Get in an auto and pick up your passenger at ' + o.pickup.name : e.mission.stage === 1 ? o.item + ' collected — deliver to ' + o.dest.en : 'Pick up: ' + o.item });
    }
    if (m.k === 'abandon') { e.mission = null; return send(p.ws, { t: 'eco', k: 'mission', mission: null, note: 'Job cancelled' }); }
    if (m.k === 'buy') {
      const it = CATALOG[m.item]; if (!it) return;
      if (!near(it.shop)) return send(p.ws, { t: 'eco', k: 'err', text: 'Visit ' + SPOT[it.shop].name + ' to buy this' });
      if (it.kind === 'vehicle') { const vs = (await store.owned(e.uid)).filter((o) => o.kind === 'vehicle').length; if (vs >= GARAGE_SLOTS) return send(p.ws, { t: 'eco', k: 'err', text: 'Your garage is full (' + GARAGE_SLOTS + ' vehicles)' }); }
      if (e.busy) return; e.busy = true;
      try { const r = await store.buy(e.uid, it.kind, m.item, it.price, it.kind === 'vehicle' ? { color: it.color } : {});
        if (!r.ok) return send(p.ws, { t: 'eco', k: 'err', text: r.why === 'owned' ? 'You already own this' : 'Not enough money — you need ₹' + it.price.toLocaleString('en-IN') });
        e.prof.cash = r.cash; e.prof.spent += it.price;
        send(p.ws, { t: 'eco', k: 'bought', item: m.item, name: it.name, price: it.price, cash: r.cash });
        if (it.kind === 'cloth') await wear(p, m.item);
        await sendMe(p);
      } catch (err) { log('[eco] buy failed', err && err.message); send(p.ws, { t: 'eco', k: 'err', text: 'Purchase failed — no money was taken' }); }
      finally { e.busy = false; }
      return;
    }
    if (m.k === 'wear') return wear(p, m.item);
    if (m.k === 'spawn') {
      const it = CATALOG[m.item]; if (!it || it.kind !== 'vehicle') return;
      const owned = await store.owned(e.uid); if (!owned.some((o) => o.item === m.item)) return send(p.ws, { t: 'eco', k: 'err', text: 'You do not own that vehicle' });
      if (p.vi >= 0) return send(p.ws, { t: 'eco', k: 'err', text: 'Get out of your vehicle first' });
      despawnPV(p); const vid = nextSlot(); if (vid < 0) return;
      const h = Number.isFinite(m.h) ? m.h : 0, v = { vid, owner: p, type: it.type, color: it.color, plate: plate(e.uid, m.item), x: p.x + Math.cos(h) * 2.2, z: p.z - Math.sin(h) * 2.2, h };
      pvSlots.set(vid, v); broadcast({ t: 'pv', vid, type: v.type, color: v.color, plate: v.plate, x: v.x, z: v.z, h: v.h, owner: p.id }); return;
    }
    if (m.k === 'txs') return send(p.ws, { t: 'eco', k: 'txs', list: await store.txs(e.uid, 12) });
    if (m.k === 'daily') return sendDaily(p);
    if (m.k === 'cast') {           // fishing: the server picks when the fish bites
      const sp = SPOTS.find((x) => x.kind === 'fishing' && dist(p, x) < 14); if (!sp) return send(p.ws, { t: 'eco', k: 'err', text: 'Go to a fishing spot' });
      if (p.vi >= 0) return send(p.ws, { t: 'eco', k: 'err', text: 'Get out of the vehicle to fish' });
      const wait = 3000 + Math.random() * 6000; e.fish = { bite: Date.now() + wait }; return send(p.ws, { t: 'eco', k: 'fish', state: 'cast', biteIn: Math.round(wait) }); }
    if (m.k === 'reel') { const f = e.fish; e.fish = null; if (!f) return; const dt = Date.now() - f.bite;
      if (dt < -400) return send(p.ws, { t: 'eco', k: 'fish', state: 'early' });
      if (dt > 2200) return send(p.ws, { t: 'eco', k: 'fish', state: 'escaped' });
      let r = Math.random(), fish = FISH[0]; for (const x of FISH) { if (r < x.p) { fish = x; break; } r -= x.p; }
      await store.addInv(e.uid, fish.id, 1); bumpDaily(p, 'fish'); return send(p.ws, { t: 'eco', k: 'fish', state: 'caught', fish: fish.name, price: fish.price, inv: await store.inv(e.uid) }); }
    if (m.k === 'sell') { if (!near('fishmarket')) return send(p.ws, { t: 'eco', k: 'err', text: 'Sell fish at the Beach Fish Market' });
      const inv = await store.inv(e.uid); let total = 0, n = 0; for (const f of FISH) { const q = inv[f.id] || 0; total += q * f.price; n += q; }
      if (!n) return send(p.ws, { t: 'eco', k: 'err', text: 'You have no fish to sell' });
      await store.clearInv(e.uid, FISH.map((f) => f.id)); const cash = await store.pay(e.uid, total, Math.round(total / 10), 'FISH_SALE', n + ' fish'); e.prof.cash = cash;
      return send(p.ws, { t: 'eco', k: 'sold', n, total, cash, inv: {} }); }
    if (m.k === 'offerAccept') { const o = e.offer; e.offer = null; if (!o || Date.now() > o.until || e.mission) return send(p.ws, { t: 'eco', k: 'err', text: 'That job is no longer available' });
      e.mission = { ...o.job, stage: 0, t0: Date.now() }; return send(p.ws, { t: 'eco', k: 'mission', mission: missionView(e.mission), note: 'Accepted — collect the order at ' + o.job.pickup.name }); }
    if (m.k === 'offerDecline') { e.offer = null; return; }
  }

  async function wear(p, item) {
    const e = p.eco, it = CATALOG[item]; if (!it || it.kind !== 'cloth') return;
    const owned = await store.owned(e.uid); if (!owned.some((o) => o.item === item)) return send(p.ws, { t: 'eco', k: 'err', text: 'You do not own that' });
    const outfit = { ...e.prof.outfit, ...it.look }; e.prof.outfit = outfit; await store.setOutfit(e.uid, outfit);
    p.look = { ...p.look, ...outfit }; broadcast({ t: 'lk', id: p.id, look: p.look });
  }

  async function sendDaily(p) { const e = p.eco, d = await store.daily(e.uid, today()); send(p.ws, { t: 'eco', k: 'daily', day: today(), goals: DAILY.map((g) => ({ ...g, have: Math.min(g.n, d[g.id] || 0), done: !!d[g.id + '_paid'] })) }); }
  async function bumpDaily(p, id) { const e = p.eco, g = DAILY.find((x) => x.id === id); if (!g) return; const day = today(), d = await store.daily(e.uid, day); d[id] = (d[id] || 0) + 1;
    let paid = 0; if (d[id] >= g.n && !d[id + '_paid']) { d[id + '_paid'] = 1; paid = g.bonus; } await store.setDaily(e.uid, day, d);
    if (paid) { const cash = await store.pay(e.uid, paid, Math.round(paid / 5), 'DAILY_BONUS', g.label); e.prof.cash = cash; send(p.ws, { t: 'eco', k: 'dailyDone', label: g.label, bonus: paid, cash }); }
    await sendDaily(p); }
  async function finishRace(p, m, now) { const e = p.eco, ms = now - m.go, secs = ms / 1000, R = RACES[m.giver]; e.mission = null;
    const prize = secs <= m.par ? R.prize : secs <= m.par * 1.5 ? R.minor : 0, prev = await store.best(e.uid, m.giver); await store.setBest(e.uid, m.giver, ms);
    let cash = e.prof.cash; if (prize) { cash = await store.pay(e.uid, prize, Math.round(prize / 4), 'RACE_PRIZE', R.name); e.prof.cash = cash; }
    bumpDaily(p, 'race'); send(p.ws, { t: 'eco', k: 'race', name: R.name, secs: +secs.toFixed(1), par: m.par, prize, cash, best: prev === null || ms < prev, bestSecs: +((prev === null ? ms : Math.min(prev, ms)) / 1000).toFixed(1) }); }
  /* Nazeer texts free players with a delivery offer every few minutes (after the onboarding jobs) */
  setInterval(() => { for (const p of activePlayers()) { const e = p.eco; if (!e || e.mission || e.offer || e.prof.jobs < (process.env.ECO_OFFER_MINJOBS !== undefined ? +process.env.ECO_OFFER_MINJOBS : 2) || Math.random() > (process.env.ECO_OFFER_MS ? 1 : 0.35)) continue;
      const o = offer(p, 'nazeer'); if (!o) continue; e.offer = { job: o, until: Date.now() + 60000 };
      send(p.ws, { t: 'eco', k: 'offer', from: 'Nazeer', text: o.item + ' · ' + SPOT.nazeer.name + ' → ' + o.dest.en, reward: o.base, secs: 60 }); } }, +process.env.ECO_OFFER_MS || 90000).unref();
  return { attach, detach, handle, onMove, pvList, pvOwner, SPOTS };
}

module.exports = { createEconomy, CATALOG, SPOTS, PLACES, xpLevel, DAILY, FISH, RACES };
