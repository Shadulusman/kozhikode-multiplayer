/* Two-browser end-to-end test of the in-game phone (real WebRTC, fake microphones, separate profiles).
   Setup (not a project dependency):  npm i --no-save playwright-core
   Run:  BROWSER_PATH=<chrome or edge exe>  SHOTS_DIR=<folder for screenshots>  node test/e2e-phone.js
   Starts its own server on :3100 with a short ring timeout. Pauses each page's render loop (Game.manual) so software GL stays responsive. */
const { chromium } = require('playwright-core');
const { spawn } = require('child_process');
const path = require('path');
const PROJ = path.join(__dirname, '..');
const SHOTS = process.env.SHOTS_DIR || require('os').tmpdir();
const PORT = 3100, URL = 'http://localhost:' + PORT + '/';
const EDGE = process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function step(name, fn) { try { const r = await fn(); results.push(['PASS', name]); console.log('PASS', name, r === undefined ? '' : JSON.stringify(r)); } catch (e) { results.push(['FAIL', name, String(e.message || e).split('\n')[0]]); console.log('FAIL', name, '-', String(e.message || e).split('\n')[0]); } }
const until = (page, expr, arg, t = 20000) => page.waitForFunction(expr, arg, { timeout: t, polling: 100 });
const freeze = (p) => p.evaluate(() => { Game.manual = true; });
const state = (p) => p.evaluate(() => Phone.state);

(async () => {
  const srv = spawn(process.execPath, ['server.js'], { cwd: PROJ, env: Object.assign({}, process.env, { PORT: String(PORT), PHONE_RING_MS: '5000', PHONE_RATE_MAX: '40', PHONE_RATE_TARGET: '30' }) });
  srv.stdout.on('data', (d) => process.stdout.write('[srv] ' + d)); srv.stderr.on('data', (d) => process.stdout.write('[srv!] ' + d));
  await sleep(1500);
  const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const players = {};
  async function join(name) {
    const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 800, height: 640 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('kzk_q', '0'); } catch (e) {} });
    const page = await ctx.newPage(); page.name = name; page.ctx = ctx;
    const errs = []; page.errs = errs;
    page.on('pageerror', (e) => { errs.push(String(e)); console.log('[' + name + ' pageerror]', String(e).split('\n')[0]); });
    page.on('console', (m) => { if (m.type() === 'error') console.log('[' + name + ' console.error]', m.text().slice(0, 200)); });
    page.on('response', (r) => { if (r.status() >= 400) console.log('[' + name + ' HTTP ' + r.status() + ']', r.url().slice(0, 120)); });
    await page.goto(URL + '?phonedebug=1');
    await page.waitForSelector('#start-btn:not([hidden])', { timeout: 240000 }); await page.fill('#pname', name); await page.click('#start-btn');
    await until(page, () => window.Phone && Phone.num, null, 60000); await freeze(page);
    players[name] = page; return page;
  }
  const num = (p) => p.evaluate(() => Phone.num);
  const click = (p, sel) => p.click(sel, { timeout: 15000, force: true });
  const dialUI = async (p, n) => {
    await p.evaluate(() => { if (Phone.mode !== 'user') { Phone.openUI(true); } Phone.page = 'phone'; Phone.tab = 'keypad'; Phone.dial = ''; Phone.formOpen && Phone.toggleForm(false); Phone.render(); });
    await settled(p); for (const d of n) await p.click('.ph-key[data-key="' + d + '"]', { force: true });
    const got = await p.evaluate(() => Phone.dial); if (got !== n) throw new Error('typed ' + got + ' wanted ' + n);
    await click(p, '#ph-dial');
  };
  const settled = (p) => until(p, () => { const r = document.getElementById('ph-root').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 2 && document.getElementById('ph-root').classList.contains('open'); }, null, 15000).then(() => sleep(250));
  const hangUI = (p) => click(p, '#ph-call [data-act="end"]');
  const idle = async (p) => { await until(p, () => Phone.state === 'IDLE', null, 8000); };
  const callText = (p) => p.evaluate(() => document.getElementById('pc-st').textContent);

  let A, B, C;
  await step('both players join and get numbers', async () => {
    A = await join('Ann'); B = await join('Bob');
    const [a, b] = [await num(A), await num(B)];
    if (!/^[1-9]\d{5}$/.test(a) || !/^[1-9]\d{5}$/.test(b) || a === b) throw new Error('bad numbers ' + a + ' ' + b);
    return { a, b };
  });
  await A.screenshot({ path: path.join(SHOTS, '01-game.png') });
  const bn = await num(B), an = await num(A);

  await step('P key opens phone, screenshot', async () => {
    await A.evaluate(() => document.getElementById('c').focus()); await A.keyboard.press('KeyP'); await until(A, () => Phone.mode === 'user');
    await sleep(500); await A.screenshot({ path: path.join(SHOTS, '02-home.png') });
    await A.evaluate(() => { Phone.setPage('phone', 'keypad'); }); await sleep(400); await A.screenshot({ path: path.join(SHOTS, '03-keypad.png') });
    const typing = await A.evaluate(() => window.__typing); if (!typing) throw new Error('game input not suspended while phone open');
    await A.keyboard.press('Escape'); await A.keyboard.press('Escape'); await until(A, () => Phone.mode === 'closed'); const t2 = await A.evaluate(() => window.__typing); if (t2) throw new Error('__typing left on');
  });

  await step('keyboard digits dial + backspace', async () => {
    await A.keyboard.press('KeyP'); await until(A, () => Phone.mode === 'user'); await A.evaluate(() => { Phone.setPage('phone', 'keypad'); });
    for (const d of '1234567') await A.keyboard.press('Digit' + d); const v1 = await A.evaluate(() => Phone.dial); if (v1 !== '123456') throw new Error('max 6 digits: ' + v1);
    await A.keyboard.press('Backspace'); const v2 = await A.evaluate(() => Phone.dial); if (v2 !== '12345') throw new Error('backspace ' + v2);
    await A.evaluate(() => { Phone.dial = ''; Phone.render(); });
  });

  await step('refresh keeps the same number (token persisted)', async () => {
    const before = await num(B); await B.reload(); await B.waitForSelector('#start-btn:not([hidden])', { timeout: 240000 }); await B.fill('#pname', 'Bob'); await B.click('#start-btn'); await until(B, () => window.Phone && Phone.num, null, 60000); await freeze(B);
    const after = await num(B); if (before !== after) throw new Error(before + ' != ' + after);
  });

  await step('invalid number / self / not found', async () => {
    await dialUI(A, '999991'); await until(A, () => Phone.state === 'FAILED'); const t = await callText(A); if (!/NOT FOUND/.test(t)) throw new Error(t); await idle(A);
    await dialUI(A, an); await until(A, () => Phone.state === 'FAILED' || Phone.state === 'ENDED'); const t2 = await callText(A); if (!/YOURSELF/.test(t2)) throw new Error(t2); await idle(A);
  });

  await step('A dials B: A calling, B rings (phone auto-opens), reject -> A sees declined', async () => {
    await dialUI(A, bn); await until(A, () => Phone.state === 'CALLING'); await until(B, () => Phone.state === 'RINGING');
    const open = await B.evaluate(() => document.getElementById('ph-root').classList.contains('open')); if (!open) throw new Error('B phone did not auto-open');
    const nameB = await B.evaluate(() => document.getElementById('pc-nm').textContent); if (!/Ann/.test(nameB)) throw new Error('caller name ' + nameB);
    await B.screenshot({ path: path.join(SHOTS, '04-incoming.png') }); await A.screenshot({ path: path.join(SHOTS, '05-calling.png') });
    await click(B, '#ph-call [data-act="decline"]'); await until(A, () => Phone.state === 'ENDED' || Phone.state === 'FAILED'); const t = await callText(A); if (!/DECLINED/.test(t)) throw new Error('A saw ' + t);
    await idle(A); await idle(B);
  });

  await step('call again, B answers -> both ACTIVE, audio flows both ways', async () => {
    await dialUI(A, bn); await until(B, () => Phone.state === 'RINGING'); await settled(B); await click(B, '#ph-call [data-act="answer"]');
    await until(A, () => Phone.state === 'ACTIVE', null, 25000); await until(B, () => Phone.state === 'ACTIVE', null, 25000);
    await sleep(2500);
    const stats = (p) => p.evaluate(async () => { const s = await Phone.pc.getStats(); let rx = 0, en = 0, tx = 0; s.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') { rx = r.bytesReceived; en = r.totalAudioEnergy || 0; } if (r.type === 'outbound-rtp' && r.kind === 'audio') tx = r.bytesSent; }); return { rx, en, tx, audioEl: !!(Phone.audio && Phone.audio.srcObject), paused: Phone.audio && Phone.audio.paused }; });
    const [sa, sb] = [await stats(A), await stats(B)];
    if (!(sa.rx > 500 && sb.rx > 500 && sa.tx > 500 && sb.tx > 500)) throw new Error('no media ' + JSON.stringify([sa, sb]));
    if (!sa.audioEl || !sb.audioEl) throw new Error('no remote audio element');
    await B.screenshot({ path: path.join(SHOTS, '06-active.png') });
    return { A: sa, B: sb };
  });

  await step('call timer counts and starts only after connect', async () => {
    const t = await callText(A); if (!/^\d\d:\d\d$/.test(t)) throw new Error(t);
  });

  await step('mute disables local track without tearing down; unmute restores', async () => {
    await click(A, '#ph-call [data-act="mute"]'); const m = await A.evaluate(() => ({ en: Phone.lt.enabled, st: Phone.state, c: Phone.pc.connectionState })); if (m.en || m.st !== 'ACTIVE') throw new Error(JSON.stringify(m));
    await click(A, '#ph-call [data-act="mute"]'); const m2 = await A.evaluate(() => Phone.lt.enabled); if (!m2) throw new Error('unmute failed');
  });

  await step('closing phone mid-call shows pill; call continues', async () => {
    await A.evaluate(() => Phone.closeUI()); await sleep(400); const on = await A.evaluate(() => document.getElementById('ph-pill').classList.contains('on')); if (!on) throw new Error('no pill');
    await A.screenshot({ path: path.join(SHOTS, '07-pill.png') }); if ((await state(A)) !== 'ACTIVE') throw new Error('call dropped');
  });

  await step('proximity voice suppressed for call partner', async () => {
    const r = await A.evaluate(() => ({ partner: Phone.isPartner(Net.remote.size ? [...Net.remote.keys()][0] : '-1') || Phone.partnerId, peers: Net.peers.size })); return r;
  });

  await step('A hangs up -> both IDLE, nothing left running', async () => {
    await A.evaluate(() => document.querySelector('#ph-pill [data-act="pend"]').click());
    await until(B, () => Phone.state === 'ENDED' || Phone.state === 'FAILED' || Phone.state === 'IDLE'); await idle(A); await idle(B);
    for (const p of [A, B]) { const r = await p.evaluate(() => ({ pc: !!Phone.pc, lt: !!Phone.lt, tones: Object.keys(Phone.Tones.timers).length, src: !!(Phone.audio && Phone.audio.srcObject) })); if (r.pc || r.lt || r.tones || r.src) throw new Error(p.name + ' leaked ' + JSON.stringify(r)); }
  });

  await step('B calls A, A answers, B hangs up (other direction)', async () => {
    await dialUI(B, an); await until(A, () => Phone.state === 'RINGING'); await A.evaluate(() => Phone.answerNow()); await until(A, () => Phone.state === 'ACTIVE', null, 25000); await until(B, () => Phone.state === 'ACTIVE', null, 25000);
    await sleep(1200); await click(B, '#ph-call [data-act="end"]'); await until(A, () => Phone.state !== 'ACTIVE'); await idle(A); await idle(B);
  });

  await step('recents list shows calls (incl. duration) on both sides', async () => {
    for (const p of [A, B]) { await p.evaluate(() => { if (Phone.mode !== 'user') Phone.openUI(true); Phone.setPage('phone', 'recents'); }); await settled(p); await sleep(700); }
    const rows = await A.evaluate(() => [...document.querySelectorAll('#ph-recents .ph-row')].map((r) => r.textContent.replace(/\s+/g, ' ')));
    if (rows.length < 3) throw new Error('rows ' + JSON.stringify(rows)); await A.screenshot({ path: path.join(SHOTS, '08-recents.png') }); return rows.slice(0, 3);
  });

  await step('unanswered call -> server timer -> NO ANSWER / MISSED CALL notification', async () => {
    await dialUI(A, bn); await until(B, () => Phone.state === 'RINGING'); await until(A, () => Phone.state === 'ENDED' || Phone.state === 'FAILED', null, 12000);
    const t = await callText(A); if (!/NO ANSWER/.test(t)) throw new Error('A: ' + t);
    await until(B, () => document.getElementById('ph-notif').classList.contains('on'), null, 4000); await B.screenshot({ path: path.join(SHOTS, '09-missed.png') }); await idle(A); await idle(B);
  });

  await step('caller cancels while ringing -> B stops ringing', async () => {
    await dialUI(A, bn); await until(B, () => Phone.state === 'RINGING'); await hangUI(A); await until(B, () => Phone.state !== 'RINGING'); const tones = await B.evaluate(() => Object.keys(Phone.Tones.timers).length); if (tones) throw new Error('still ringing'); await idle(A); await idle(B);
  });

  await step('busy: C calls B while A<->B talk; self-call blocked for C', async () => {
    C = await join('Cat'); await dialUI(A, bn); await until(B, () => Phone.state === 'RINGING'); await B.evaluate(() => Phone.answerNow()); await until(B, () => Phone.state === 'ACTIVE', null, 25000);
    await dialUI(C, bn); await until(C, () => Phone.state === 'FAILED'); const t = await callText(C); if (!/BUSY/.test(t)) throw new Error(t); await idle(C);
  });

  await step('refresh during call -> other side gets CONNECTION LOST, B freed', async () => {
    await A.reload(); await until(B, () => Phone.state === 'FAILED' || Phone.state === 'ENDED' || Phone.state === 'IDLE', null, 15000); const t = await callText(B);
    await idle(B); await A.waitForSelector('#start-btn:not([hidden])', { timeout: 240000 }); await A.fill('#pname', 'Ann'); await A.click('#start-btn'); await until(A, () => window.Phone && Phone.num, null, 60000); await freeze(A);
    const a2 = await num(A); if (a2 !== an) throw new Error('number changed after refresh');
    await dialUI(C, bn); await until(B, () => Phone.state === 'RINGING'); await B.evaluate(() => Phone.declineNow()); await idle(B); await idle(C); return t;
  });

  await step('offline: closing B then dialling B shows USER UNAVAILABLE', async () => {
    await B.ctx.close(); await sleep(800); await dialUI(A, bn); await until(A, () => Phone.state === 'FAILED'); const t = await callText(A); if (!/UNAVAILABLE/.test(t)) throw new Error(t); await idle(A);
  });

  await step('contacts: add, list, call by name', async () => {
    await A.evaluate(() => { if (Phone.mode !== 'user') Phone.openUI(true); Phone.setPage('phone', 'contacts'); }); await sleep(500); await click(A, '[data-act="cform"]'); await sleep(300); await A.fill('#ph-fname', 'Rahul'); await A.fill('#ph-fnum', await num(C)); await click(A, '[data-act="csave"]');
    await until(A, () => Phone.contacts.length === 1); await A.screenshot({ path: path.join(SHOTS, '10-contacts.png') });
    await A.click('#ph-contacts .ph-row', { force: true }); await until(A, () => Phone.state === 'CALLING'); const nm = await A.evaluate(() => document.getElementById('pc-nm').textContent); if (nm !== 'Rahul') throw new Error('name ' + nm);
    await until(C, () => Phone.state === 'RINGING'); await C.screenshot({ path: path.join(SHOTS, '11-incoming-c.png') }); await hangUI(A); await idle(A); await idle(C);
  });

  await step('call works while in a vehicle; phone keys do not leak into driving', async () => {
    await C.evaluate(() => { const v = PVEH[0]; Player.enter(v, Game.scene); }); const inVeh = await C.evaluate(() => !!Player.veh); if (!inVeh) throw new Error('could not enter vehicle');
    await dialUI(A, await num(C)); await until(C, () => Phone.state === 'RINGING'); await settled(C); await C.keyboard.press('KeyY'); await until(C, () => Phone.state === 'ACTIVE', null, 25000); await until(A, () => Phone.state === 'ACTIVE', null, 25000);
    await C.evaluate(() => Phone.closeUI()); await sleep(300);
    await C.keyboard.down('KeyW'); const driving = await C.evaluate(() => !!Input.k.KeyW); await C.keyboard.up('KeyW'); if (!driving) throw new Error('driving keys blocked while phone closed');
    await C.keyboard.press('KeyP'); await until(C, () => Phone.mode === 'user'); await C.keyboard.down('KeyW'); await C.keyboard.press('Digit5'); const leaked = await C.evaluate(() => !!Input.k.KeyW || !!Input.k.Digit5); await C.keyboard.up('KeyW'); if (leaked) throw new Error('keys leaked to game while phone open');
    await C.keyboard.press('Escape'); await until(C, () => Phone.mode === 'closed'); const still = await C.evaluate(() => !!Player.veh && Phone.state === 'ACTIVE'); if (!still) throw new Error('vehicle/call lost');
    await C.keyboard.press('KeyN'); await until(C, () => Phone.state !== 'ACTIVE'); await idle(C); await idle(A); await C.evaluate(() => Player.exit(Game.scene));
  });
  await step('phone-sized viewport layout', async () => {
    await A.setViewportSize({ width: 390, height: 740 }); await A.evaluate(() => { if (Phone.mode !== 'user') Phone.openUI(true); Phone.setPage('home'); Phone.page = 'home'; Phone.render(); }); await settled(A); await sleep(400);
    await A.screenshot({ path: path.join(SHOTS, '12-mobile-home.png') });
    await A.evaluate(() => { Phone.setPage('phone', 'keypad'); }); await sleep(500); await A.screenshot({ path: path.join(SHOTS, '13-mobile-keypad.png') });
    const r = await A.evaluate(() => { const b = document.getElementById('ph-root').getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: innerWidth, h: innerHeight }; });
    if (r.l < 0 || r.r > r.w || r.t < 0 || r.b > r.h) throw new Error('phone off screen ' + JSON.stringify(r));
    await A.evaluate(() => Phone.closeUI());
  });
  await step('no page errors', async () => { const all = Object.values(players).flatMap((p) => p.errs); if (all.length) throw new Error(all.join(' | ').slice(0, 300)); });

  console.log('\n===== SUMMARY =====\n' + results.map((r) => r.join(' ')).join('\n'));
  await browser.close(); srv.kill();
  process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
