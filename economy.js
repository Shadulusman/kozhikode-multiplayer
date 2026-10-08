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
  medical: { x: 1144, z: -12, en: 'Medical College', ml: 'മെഡിക്കൽ കോളേജ്' }, sarovaram: { x: 214, z: -150, en: 'Sarovaram', ml: 'സരോവരം' },
};
// Job givers and shops. Offsets keep the marker beside, not on, the fast-travel point.
const SPOTS = [
  { id: 'nazeer', kind: 'food', name: "Nazeer's Kitchen", ml: 'നസീറിന്റെ അടുക്കള', at: 'mavoor', dx: 8, dz: 6 },
  { id: 'spice', kind: 'food', name: 'Malabar Spice', ml: 'മലബാർ സ്പൈസ്', at: 'palayam', dx: 6, dz: -8 },
  { id: 'shawaya', kind: 'food', name: 'Beach Shawaya', ml: 'ബീച്ച് ഷവായ', at: 'beach', dx: 10, dz: 12 },
  { id: 'autostand', kind: 'auto', name: 'Railway Pre-paid Auto Stand', ml: 'പ്രീ-പെയ്ഡ് ഓട്ടോ', at: 'railway', dx: -12, dz: 12 },
  { id: 'scooters', kind: 'dealer', name: 'Calicut Two Wheelers', ml: 'കാലിക്കറ്റ് ടൂ വീലേഴ്സ്', at: 'railway', dx: 10, dz: -10 },
  { id: 'cloth', kind: 'cloth', name: 'Kasavu Textiles', ml: 'കസവ് ടെക്സ്റ്റൈൽസ്', at: 'smstreet', dx: 8, dz: 8 },
].map((s) => ({ ...s, x: PLACES[s.at].x + s.dx, z: PLACES[s.at].z + s.dz }));
const SPOT = Object.fromEntries(SPOTS.map((s) => [s.id, s]));

const CATALOG = {
  // vehicles (type = client VEH type). Prices tuned so the first scooter takes ~10 deliveries.
  city125: { kind: 'vehicle', name: 'City 125 scooter', type: 'scooter', price: 6000, color: '#c62828', shop: 'scooters' },
  breeze: { kind: 'vehicle', name: 'Breeze scooter', type: 'scooter', price: 9500, color: '#1565c0', shop: 'scooters' },
  thunder150: { kind: 'vehicle', name: 'Thunder 150 bike', type: 'bike', price: 18000, color: '#212121', shop: 'scooters' },
  // clothes: outfit style (o) + colours
  tee_white: { kind: 'cloth', name: 'White T-shirt', price: 350, look: { o: 0, shirt: '#f5f5f5' }, shop: 'cloth' },
  shirt_black: { kind: 'cloth', name: 'Black shirt', price: 850, look: { o: 1, shirt: '#151515' }, shop: 'cloth' },
  shirt_kasavu: { kind: 'cloth', name: 'Kasavu cream shirt', price: 1200, look: { o: 1, shirt: '#efe3c2', pants: '#f4efe0' }, shop: 'cloth' },
  shirt_green: { kind: 'cloth', name: 'Malabar green shirt', price: 900, look: { o: 1, shirt: '#1b5e20' }, shop: 'cloth' },
  sports: { kind: 'cloth', name: 'Sports tee + shorts', price: 700, look: { o: 2, shirt: '#ef6c00', pants: '#212121' }, shop: 'cloth' },
  formal: { kind: 'cloth', name: 'Formal suit', price: 4500, look: { o: 3, shirt: '#263238', pants: '#263238' }, shop: 'cloth' },
};
const FOODS = ['Kozhikode biriyani', 'Chicken biriyani', 'Porotta + beef', 'Pathiri + chicken curry', 'Shawaya', 'Tea + snacks', 'Kozhikode halwa', 'Fresh juice'];

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const xpLevel = (xp) => Math.floor(Math.sqrt(xp / 100)) + 1;
const R_SPOT = 9, R_DROP = 10, MAX_JUMP = 80, MAX_SPEED = 45;

function createEconomy({ store, send, broadcast, log = console.log }) {
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
  const missionView = (m) => m && { kind: m.kind || 'food', title: m.story || (m.kind === 'auto' ? 'AUTO FARE' : 'FOOD DELIVERY'), item: m.item, stage: m.stage, from: m.pickup.name, to: m.dest.en, toMl: m.dest.ml,
    target: m.stage === 0 ? { x: m.pickup.x, z: m.pickup.z } : { x: m.dest.x, z: m.dest.z }, base: m.base, bonus: m.bonus, limit: m.limit, left: Math.max(0, Math.round(m.limit - (Date.now() - m.t0) / 1000)) };

  async function sendMe(p, extra) {
    const e = p.eco; const owned = await store.owned(e.uid);
    send(p.ws, { t: 'eco', k: 'me', cash: e.prof.cash, xp: e.prof.xp, level: xpLevel(e.prof.xp), jobs: e.prof.jobs, rep: e.prof.rep,
      owned: owned.map((o) => o.item), outfit: e.prof.outfit, spots: SPOTS.map(({ id, kind, name, ml, x, z }) => ({ id, kind, name, ml, x, z })),
      catalog: CATALOG, mission: missionView(e.mission), fresh: !!extra && extra.fresh });
  }

  async function attach(p, uid) {
    try {
      const prof = await store.profile(uid, p.look);
      p.eco = { uid, prof, mission: null, lastPos: null, busy: false };
      if (prof.outfit && Object.keys(prof.outfit).length) { p.look = { ...p.look, ...prof.outfit }; broadcast({ t: 'lk', id: p.id, look: p.look }); }
      await sendMe(p, { fresh: prof.fresh });
    } catch (e) { log('[eco] attach failed', e && e.message); }
  }

  function despawnPV(p) { for (const [vid, v] of pvSlots) if (v.owner === p) { pvSlots.delete(vid); broadcast({ t: 'pv', vid, gone: 1 }); } }
  function detach(p) { despawnPV(p); }
  const pvList = () => [...pvSlots.values()].map((v) => ({ vid: v.vid, type: v.type, color: v.color, x: v.x, z: v.z, h: v.h, owner: v.owner.id }));
  const pvOwner = (vid) => { const v = pvSlots.get(vid); return v ? v.owner : null; };

  /** called on every position update: teleport check + objective progress */
  async function onMove(p) {
    const e = p.eco; if (!e) return; const pos = { x: p.x, z: p.z }, now = Date.now();
    if (e.lastPos && e.mission) { const dt = Math.max(0.05, (now - e.lastPos.t) / 1000), jump = dist(pos, e.lastPos);
      if (jump > MAX_JUMP && jump / dt > MAX_SPEED && !p.onBus) { const m = e.mission; e.mission = null; send(p.ws, { t: 'eco', k: 'fail', title: m.story || 'FOOD DELIVERY', why: 'Fast travel cancels a job in progress.' }); } }
    e.lastPos = { ...pos, t: now };
    const m = e.mission; if (!m || e.busy) return;
    if (m.needAuto && !(p.vi >= 0 && p.sn === 0 && p.vt === 'auto')) { if (m.stage === 0 && dist(pos, m.pickup) < R_SPOT && !m.warned) { m.warned = true; send(p.ws, { t: 'eco', k: 'err', text: 'Drive an auto-rickshaw to pick up the passenger' }); } return; }
    if (m.stage === 0 && dist(pos, m.pickup) < R_SPOT) { m.stage = 1; m.tPick = now; send(p.ws, { t: 'eco', k: 'mission', mission: missionView(m), note: m.kind === 'auto' ? 'Passenger on board — drive to ' + m.dest.en : 'Order collected — deliver to ' + m.dest.en }); return; }
    if (m.stage === 1 && dist(pos, m.dest) < R_DROP) {
      const secs = (now - m.t0) / 1000, minSecs = dist(m.pickup, m.dest) / MAX_SPEED;       // can't be faster than a fast car
      if (secs < minSecs) { e.mission = null; send(p.ws, { t: 'eco', k: 'fail', title: 'DELIVERY', why: 'Delivery rejected.' }); log('[eco] rejected too-fast delivery', p.name, secs.toFixed(1)); return; }
      const fast = secs <= m.limit, amount = m.base + (fast ? m.bonus : 0), xp = Math.round(amount / 5);
      e.busy = true; e.mission = null;
      try { const cash = await store.credit(e.uid, amount, xp, m.kind === 'auto' ? 'FARE' : 'MISSION_REWARD', (m.kind || 'food') + ':' + m.giver + '>' + m.dest.en);
        e.prof.cash = cash; e.prof.xp += xp; e.prof.jobs++; e.prof.rep++;
        send(p.ws, { t: 'eco', k: 'done', kind: m.kind || 'food', title: m.story || (m.kind === 'auto' ? 'FARE COMPLETE' : 'DELIVERY COMPLETE'), item: m.kind === 'auto' ? m.pickup.name + ' → ' + m.dest.en : m.item, base: m.base, bonus: fast ? m.bonus : 0, total: amount, xp, cash, level: xpLevel(e.prof.xp), jobs: e.prof.jobs });
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
      const o = offer(p, m.spot); if (!o) return;
      e.mission = { ...o, stage: 0, t0: Date.now() };
      if (!o.needAuto && dist(p, o.pickup) < R_SPOT) { e.mission.stage = 1; e.mission.tPick = Date.now(); }
      return send(p.ws, { t: 'eco', k: 'mission', mission: missionView(e.mission), note: o.kind === 'auto' ? 'Get in an auto and pick up your passenger at ' + o.pickup.name : e.mission.stage === 1 ? o.item + ' collected — deliver to ' + o.dest.en : 'Pick up: ' + o.item });
    }
    if (m.k === 'abandon') { e.mission = null; return send(p.ws, { t: 'eco', k: 'mission', mission: null, note: 'Job cancelled' }); }
    if (m.k === 'buy') {
      const it = CATALOG[m.item]; if (!it) return;
      if (!near(it.shop)) return send(p.ws, { t: 'eco', k: 'err', text: 'Visit ' + SPOT[it.shop].name + ' to buy this' });
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
      const h = Number.isFinite(m.h) ? m.h : 0, v = { vid, owner: p, type: it.type, color: it.color, x: p.x + Math.cos(h) * 2.2, z: p.z - Math.sin(h) * 2.2, h };
      pvSlots.set(vid, v); broadcast({ t: 'pv', vid, type: v.type, color: v.color, x: v.x, z: v.z, h: v.h, owner: p.id }); return;
    }
    if (m.k === 'txs') return send(p.ws, { t: 'eco', k: 'txs', list: await store.txs(e.uid, 12) });
  }

  async function wear(p, item) {
    const e = p.eco, it = CATALOG[item]; if (!it || it.kind !== 'cloth') return;
    const owned = await store.owned(e.uid); if (!owned.some((o) => o.item === item)) return send(p.ws, { t: 'eco', k: 'err', text: 'You do not own that' });
    const outfit = { ...e.prof.outfit, ...it.look }; e.prof.outfit = outfit; await store.setOutfit(e.uid, outfit);
    p.look = { ...p.look, ...outfit }; broadcast({ t: 'lk', id: p.id, look: p.look });
  }

  return { attach, detach, handle, onMove, pvList, pvOwner, SPOTS };
}

module.exports = { createEconomy, CATALOG, SPOTS, PLACES, xpLevel };
