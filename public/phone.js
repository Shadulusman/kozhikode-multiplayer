/* In-game phone: UI, call state machine, WebRTC voice. Server side: phone-server.js.
   Hooks into index.html through: Net.ws / Net.on / Net.ice / Net.track / Net.id, and the lines marked "phone" in Net
   (join token, 'ph' message, voiceUpdate partner skip, close).
   Voice goes peer-to-peer over WebRTC; the game WebSocket only carries signalling. */
(function () {
  'use strict';
  if (window.Phone) return;

  /* ---------------------------------------------------------------- helpers */
  const ls = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} return null; };
  const DEBUG = /[?&]phonedebug=1/.test(location.search) || ls('kzk_phdbg') === '1';
  const NUMRE = /^[1-9]\d{5}$/;
  const fmt = (n) => (n && n.length === 6 ? n.slice(0, 3) + ' ' + n.slice(3) : (n || ''));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clock = (sec) => { sec = Math.max(0, sec | 0); return String((sec / 60) | 0).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0'); };
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const net = () => (typeof Net !== 'undefined' ? Net : null);
  const playing = () => typeof Game !== 'undefined' && Game.playing && net() && net().on;
  const log = (...a) => { if (DEBUG) console.log('[phone]', ...a); };

  const IC = {
    phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
    users: 'M9 11a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 11zM2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16 4.8a3.2 3.2 0 0 1 0 6.1M18 14.8c2.2.5 3.6 2.3 3.6 5.2',
    msg: 'M4 5h16v11H9.5L5 20v-4H4z',
    sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
    back: 'M15 5l-7 7 7 7',
    del: 'M21 5H9l-6 7 6 7h12zM14 9.5l5 5M19 9.5l-5 5',
    mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
    micoff: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16',
    vol: 'M4 9.5h3.5L13 5v14l-5.5-4.5H4zM16.5 8.5a5 5 0 0 1 0 7',
    plus: 'M12 5v14M5 12h14',
    x: 'M6 6l12 12M18 6L6 18',
    clockic: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM12 8v4.5l3 1.5',
  };
  const svg = (n, cls) => '<svg class="ph-svg ' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true"><path d="' + IC[n] + '"/></svg>';
  const SUB = { 2: 'ABC', 3: 'DEF', 4: 'GHI', 5: 'JKL', 6: 'MNO', 7: 'PQRS', 8: 'TUV', 9: 'WXYZ', 0: '+' };

  const RESULT = {   // text shown on the call screen when a call ends / cannot start
    declined: ['CALL DECLINED'], noanswer: ['NO ANSWER'], ended: ['CALL ENDED'], lost: ['CONNECTION LOST'], missed: ['MISSED CALL'], cancelled: ['CALL CANCELLED'],
    busy: ['LINE BUSY'], notfound: ['NUMBER NOT FOUND'], offline: ['USER UNAVAILABLE'], self: ['YOU CANNOT CALL YOURSELF'], incall: ['LINE BUSY'], rate: ['TOO MANY CALLS - TRY LATER'],
    nomic: ['MICROPHONE UNAVAILABLE'], failed: ['CALL FAILED'], connfail: ['CALL CONNECTION FAILED'], unavailable: ['USER UNAVAILABLE'],
  };

  /* ---------------------------------------------------------------- sounds (original, synthesised) */
  const Tones = {
    own: null, timers: {}, nodes: new Set(), on: ls('kzk_phsnd') !== '0',
    ctx() { const n = net(); let c = n && n.actx; if (!c) { if (!this.own) { try { this.own = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } c = this.own; } if (c && c.state === 'suspended') c.resume().catch(() => {}); return c; },
    note(f, t0, dur, vol, type) {
      const c = this.ctx(); if (!c || !this.on || c.state !== 'running') return;     // audio still locked: skip, the next ring cycle plays once it unlocks
      const o = c.createOscillator(), g = c.createGain(); o.type = type || 'triangle'; o.frequency.value = f;
      const t = c.currentTime + t0; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.012); g.gain.setValueAtTime(vol, t + Math.max(0.02, dur - 0.05)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.02); this.nodes.add(o); o.onended = () => { this.nodes.delete(o); try { g.disconnect(); } catch (e) {} };
    },
    loop(name, period, fn) { this.stop(name); fn(); this.timers[name] = setInterval(fn, period); },
    stop(name) { if (name) { clearInterval(this.timers[name]); delete this.timers[name]; return; } for (const k of Object.keys(this.timers)) { clearInterval(this.timers[k]); } this.timers = {}; for (const o of this.nodes) { try { o.stop(); } catch (e) {} } this.nodes.clear(); },
    ring() { this.loop('ring', 2600, () => { const s = [659.25, 783.99, 987.77, 783.99, 659.25, 783.99, 987.77, 1318.5]; for (let r = 0; r < 2; r++) s.forEach((f, i) => this.note(f, r * 1.0 + i * 0.115, 0.1, 0.1)); }); },
    ringback() { this.loop('rb', 3400, () => { this.note(425, 0, 1.0, 0.09, 'sine'); this.note(450, 0, 1.0, 0.07, 'sine'); }); },
    connected() { this.note(660, 0, 0.09, 0.1, 'sine'); this.note(990, 0.1, 0.14, 0.1, 'sine'); },
    ended() { this.note(520, 0, 0.12, 0.1, 'sine'); this.note(390, 0.13, 0.2, 0.1, 'sine'); },
    ding() { this.note(880, 0, 0.12, 0.09, 'sine'); this.note(1175, 0.12, 0.2, 0.08, 'sine'); },
  };

  /* ---------------------------------------------------------------- state machine */
  const NEXT = {
    IDLE: ['DIALING', 'RINGING'],
    DIALING: ['CALLING', 'RINGING', 'FAILED', 'ENDED', 'IDLE'],
    CALLING: ['CONNECTING', 'ENDING', 'ENDED', 'FAILED'],
    RINGING: ['CONNECTING', 'ENDING', 'ENDED', 'FAILED'],
    CONNECTING: ['ACTIVE', 'ENDING', 'ENDED', 'FAILED'],
    ACTIVE: ['ENDING', 'ENDED', 'FAILED'],
    ENDING: ['ENDED', 'FAILED', 'IDLE'],
    ENDED: ['IDLE', 'DIALING', 'RINGING'],
    FAILED: ['IDLE', 'DIALING', 'RINGING'],
  };

  const P = {
    state: 'IDLE', cx: null, num: null, myName: '', contacts: [], recents: [], blocks: [], missed: 0, mode: 'closed', page: 'home', tab: 'keypad', dial: '',
    pc: null, lt: null, ownStream: null, pend: [], remoteSet: false, audio: null, volIdx: 0, muted: false, t0: 0, ticker: null, resultT: null, endingT: null, discT: null, autoCloseT: null, wantAnswer: false, el: {},
    get partnerId() { return this.cx && (this.state === 'CONNECTING' || this.state === 'ACTIVE') ? String(this.cx.peer) : null; },
    isPartner(id) { return this.partnerId !== null && this.partnerId === String(id); },

    go(next, info) {
      if (next === this.state) return true;
      if (!NEXT[this.state].includes(next)) { log('blocked transition', this.state, '->', next); return false; }
      const prev = this.state; this.state = next; log(prev, '->', next, info || '');
      clearTimeout(this.resultT); clearTimeout(this.endingT);
      switch (next) {
        case 'DIALING': Tones.stop(); break;
        case 'CALLING': Tones.stop(); Tones.ringback(); break;
        case 'RINGING': Tones.stop(); Tones.ring(); this.showForCall(); if (navigator.vibrate) { try { navigator.vibrate([400, 200, 400, 1200, 400, 200, 400]); } catch (e) {} } break;
        case 'CONNECTING': Tones.stop(); if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} } break;
        case 'ACTIVE': Tones.stop(); Tones.connected(); this.t0 = performance.now(); break;
        case 'ENDING': Tones.stop(); this.endingT = setTimeout(() => { if (this.state === 'ENDING') this.go('ENDED', { text: RESULT.ended[0] }); }, 2500); break;
        case 'ENDED': case 'FAILED': {
          Tones.stop(); Tones.ended(); this.teardown(); if (navigator.vibrate) { try { navigator.vibrate(0); } catch (e) {} }
          this.result = (info && info.text) || (next === 'FAILED' ? RESULT.failed[0] : RESULT.ended[0]); this.resultErr = next === 'FAILED';
          this.resultT = setTimeout(() => this.go('IDLE'), 1900); break;
        }
        case 'IDLE': this.teardown(); this.cx = null; this.result = ''; this.wantAnswer = false; this.autoClose(); net() && net().ws && this.send({ k: 'recents' }); break;
      }
      this.render(); return true;
    },

    send(o) { const n = net(); if (n && n.ws && n.ws.readyState === 1) { n.ws.send(JSON.stringify(Object.assign({ t: 'ph' }, o))); return true; } return false; },
    nameOf(num) { const c = this.contacts.find((x) => x.num === num); return c ? c.name : ''; },

    /* ------------------------------------------------------------ user actions */
    async dialNow(num) {
      num = String(num || this.dial).replace(/\D/g, '');
      if (this.state !== 'IDLE' || !this.num) return;
      if (!NUMRE.test(num)) return this.hint('Enter a 6-digit number', true);
      this.cx = { id: null, num, name: this.nameOf(num), peer: null, role: 'caller' };
      this.go('DIALING'); this.showForCall();
      if (num === this.num) return this.go('FAILED', { text: RESULT.self[0] });        // never reaches the server
      try { await this.getMic(); } catch (e) { log('mic', e); if (this.state === 'DIALING') this.go('FAILED', { text: RESULT.nomic[0] }); return; }
      if (this.state !== 'DIALING') { this.releaseMic(); return; }
      if (!this.send({ k: 'call', num })) this.go('FAILED', { text: RESULT.failed[0] });
    },
    async answerNow() {
      if (this.state !== 'RINGING' || this.wantAnswer) return; this.wantAnswer = true;
      try { await this.getMic(); } catch (e) { this.wantAnswer = false; this.flashStatus(RESULT.nomic[0]); return; }
      if (this.state !== 'RINGING') { this.releaseMic(); return; }
      this.send({ k: 'answer' });
    },
    declineNow() {
      if (this.state === 'RINGING') { this.send({ k: 'reject' }); this.go('ENDING'); }
    },
    endNow() {
      const s = this.state;
      if (s === 'DIALING') { this.send({ k: 'end' }); this.go('ENDED', { text: RESULT.cancelled[0] }); }
      else if (s === 'CALLING' || s === 'CONNECTING' || s === 'ACTIVE') { this.send({ k: 'end' }); this.go('ENDING'); }
      else if (s === 'RINGING') this.declineNow();
    },
    toggleMute() { if (!this.lt) return; this.muted = !this.muted; this.lt.enabled = !this.muted; this.render(); },
    cycleVol() { this.volIdx = (this.volIdx + 1) % 3; if (this.audio) this.audio.volume = [1, 0.6, 0.3][this.volIdx]; this.render(); },

    /* ------------------------------------------------------------ microphone */
    async getMic() {
      if (this.lt && this.lt.readyState === 'live') return;
      const n = net(), nt = n && n.track;
      if (nt && nt.readyState === 'live') { this.lt = nt.clone(); this.lt.enabled = true; this.ownStream = null; }   // own copy: muting the call never touches proximity chat
      else {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('no getUserMedia');
        this.ownStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        this.lt = this.ownStream.getAudioTracks()[0];
      }
      this.muted = false; this.lt.enabled = true;
    },
    releaseMic() { try { if (this.lt) this.lt.stop(); } catch (e) {} this.lt = null; if (this.ownStream) { try { this.ownStream.getTracks().forEach((t) => t.stop()); } catch (e) {} this.ownStream = null; } this.muted = false; },

    /* ------------------------------------------------------------ WebRTC */
    makePc() {
      const n = net(); const pc = new RTCPeerConnection({ iceServers: (n && n.ice) || [{ urls: 'stun:stun.l.google.com:19302' }] });
      this.pc = pc; this.pend = []; this.remoteSet = false;
      pc.addTrack(this.lt, new MediaStream([this.lt]));
      pc.onicecandidate = (e) => { if (e.candidate && this.pc === pc) this.send({ k: 'sig', id: this.cx && this.cx.id, d: { type: 'ice', c: e.candidate.toJSON() } }); };
      pc.ontrack = (e) => { if (this.pc === pc) this.attachRemote(e.streams[0] || new MediaStream([e.track])); };
      pc.onconnectionstatechange = () => this.pcState(pc);
      pc.oniceconnectionstatechange = () => this.pcState(pc);
      return pc;
    },
    attachRemote(stream) {
      if (!this.audio) { const a = new Audio(); a.autoplay = true; a.setAttribute('playsinline', ''); this.audio = a; }
      this.audio.srcObject = stream; this.audio.volume = [1, 0.6, 0.3][this.volIdx];
      const p = this.audio.play(); if (p && p.catch) p.catch(() => { const retry = () => { removeEventListener('pointerdown', retry, true); removeEventListener('keydown', retry, true); this.audio && this.audio.play().catch(() => {}); }; addEventListener('pointerdown', retry, true); addEventListener('keydown', retry, true); });
    },
    pcState(pc) {
      if (this.pc !== pc) return;
      const cs = pc.connectionState, ice = pc.iceConnectionState; log('pc', cs, ice);
      const up = cs === 'connected' || ice === 'connected' || ice === 'completed';
      if (up) { clearTimeout(this.discT); if (this.state === 'CONNECTING') { this.go('ACTIVE'); this.send({ k: 'up', id: this.cx && this.cx.id }); } this.render(); return; }
      if (cs === 'failed' || ice === 'failed') { clearTimeout(this.discT); const was = this.state; if (was === 'CONNECTING' || was === 'ACTIVE') { this.send({ k: 'end' }); this.go('FAILED', { text: (was === 'ACTIVE' ? RESULT.lost : RESULT.connfail)[0] }); } return; }
      if (ice === 'disconnected' && this.state === 'ACTIVE') { clearTimeout(this.discT); this.discT = setTimeout(() => { if (this.pc === pc && this.state === 'ACTIVE' && pc.iceConnectionState !== 'connected') { this.send({ k: 'end' }); this.go('FAILED', { text: RESULT.lost[0] }); } }, 7000); this.render(); }
    },
    async startRtc() {
      try {
        const pc = this.makePc();
        if (this.cx.role === 'caller') {
          const o = await pc.createOffer({ offerToReceiveAudio: true }); if (this.pc !== pc) return;
          await pc.setLocalDescription(o); this.send({ k: 'sig', id: this.cx.id, d: { type: 'offer', sdp: o.sdp } });
        }
      } catch (e) { log('rtc start', e); this.send({ k: 'end' }); this.go('FAILED', { text: RESULT.connfail[0] }); }
    },
    async onSig(d) {
      const pc = this.pc; if (!d || !pc) return;
      try {
        if (d.type === 'offer' && this.cx.role === 'callee') {
          await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp }); this.remoteSet = true; await this.flush(pc);
          const a = await pc.createAnswer(); if (this.pc !== pc) return; await pc.setLocalDescription(a); this.send({ k: 'sig', id: this.cx.id, d: { type: 'answer', sdp: a.sdp } });
        } else if (d.type === 'answer' && this.cx.role === 'caller' && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp }); this.remoteSet = true; await this.flush(pc);
        } else if (d.type === 'ice' && d.c) {
          if (this.remoteSet) await pc.addIceCandidate(d.c).catch(() => {}); else this.pend.push(d.c);        // candidates can beat the SDP: hold them
        }
      } catch (e) { log('sig', e); if (this.state === 'CONNECTING' || this.state === 'ACTIVE') { this.send({ k: 'end' }); this.go('FAILED', { text: RESULT.connfail[0] }); } }
    },
    async flush(pc) { const q = this.pend.splice(0); for (const c of q) { if (this.pc !== pc) return; await pc.addIceCandidate(c).catch(() => {}); } },

    /* everything a call allocates is released here (called on every exit path) */
    teardown() {
      clearTimeout(this.discT);
      const pc = this.pc; this.pc = null;
      if (pc) { pc.onicecandidate = pc.ontrack = pc.onconnectionstatechange = pc.oniceconnectionstatechange = null; try { pc.getSenders().forEach((s) => { try { pc.removeTrack(s); } catch (e) {} }); } catch (e) {} try { pc.close(); } catch (e) {} }
      this.pend = []; this.remoteSet = false;
      if (this.audio) { try { this.audio.pause(); } catch (e) {} this.audio.srcObject = null; }
      this.releaseMic(); Tones.stop();
    },

    /* ------------------------------------------------------------ server messages */
    onMsg(m) {
      log('<-', m.k, m);
      switch (m.k) {
        case 'me': this.num = m.num; this.myName = m.name; if (m.tok) ls('kzk_ptok', m.tok); this.send({ k: 'contacts' }); this.send({ k: 'recents' }); this.send({ k: 'blocks' }); this.render(); break;
        case 'out': {
          if (this.state === 'DIALING') { this.cx.id = m.id; this.cx.peer = m.peer; this.cx.name = this.nameOf(m.num) || m.name || ''; this.cx.num = m.num; this.go('CALLING'); }
          else { this.send({ k: 'end' }); }      // we already gave up on this call
          break;
        }
        case 'in': {
          const s = this.state;
          if (s === 'IDLE' || s === 'ENDED' || s === 'FAILED' || s === 'DIALING') {
            if (s === 'DIALING') this.releaseMic();                    // glare: their call wins, our attempt is refused by the server
            this.wantAnswer = false;
            this.cx = { id: m.id, num: m.num, name: this.nameOf(m.num) || m.name || '', peer: m.peer, role: 'callee' };
            this.go('RINGING');
          }
          break;
        }
        case 'fail': if (this.state === 'DIALING') { this.releaseMic(); this.go('FAILED', { text: (RESULT[m.reason] || RESULT.failed)[0] }); } break;
        case 'answered': {
          if (!this.cx || this.cx.id !== m.id) break;
          this.cx.role = m.role; this.cx.peer = m.peer;
          if (this.go('CONNECTING')) this.startRtc();
          break;
        }
        case 'sig': if (this.cx && this.cx.id === m.id && (this.state === 'CONNECTING' || this.state === 'ACTIVE')) this.onSig(m.d); break;
        case 'live': this.render(); break;
        case 'ended': {
          if (!this.cx || this.cx.id !== m.id) break;
          const mine = m.by === 'me'; let text = RESULT.ended[0], fail = false;
          if (m.reason === 'rejected') text = mine ? RESULT.ended[0] : RESULT.declined[0];
          else if (m.reason === 'noanswer') text = this.cx.role === 'caller' ? RESULT.noanswer[0] : RESULT.missed[0];
          else if (m.reason === 'cancelled') { text = this.cx.role === 'caller' ? RESULT.cancelled[0] : RESULT.missed[0]; if (this.cx.role === 'callee' && !mine) this.notify(this.cx.num, this.cx.name); }
          else if (m.reason === 'lost') { text = RESULT.lost[0]; fail = true; }
          else if (m.reason === 'setup') { text = RESULT.connfail[0]; fail = true; }
          if (this.state === 'ENDED' || this.state === 'FAILED') break;
          this.go(fail ? 'FAILED' : 'ENDED', { text }); break;
        }
        case 'missed': this.notify(m.num, this.nameOf(m.num) || m.name); break;
        case 'recents': this.recents = m.list || []; this.renderLists(); break;
        case 'contacts': this.contacts = m.list || []; this.renderLists(); if (this.saving) { this.saving = false; this.toggleForm(false); } break;
        case 'blocks': this.blocks = m.list || []; this.renderLists(); break;
        case 'err': {
          if (m.code === 'replaced') { this.num = null; this.disabled = true; this.teardown(); this.cx = null; this.state = 'IDLE'; this.render(); const n = net(); n && typeof UI !== 'undefined' && UI.toast('Phone is active in another window'); }
          else { this.saving = false; this.hint(({ notfound: 'NUMBER NOT FOUND', self: 'THAT IS YOUR OWN NUMBER', full: 'CONTACT LIST IS FULL', bad: 'CHECK NAME AND NUMBER' }[m.code]) || 'PHONE UNAVAILABLE', true); }
          break;
        }
      }
    },
    onNetClose() {
      const s = this.state; this.disabled = false;
      if (s !== 'IDLE' && s !== 'ENDED' && s !== 'FAILED') this.go('FAILED', { text: RESULT.lost[0] });      // no server = no call
      this.num = null; this.render();
    },

    /* ------------------------------------------------------------ notifications */
    notify(num, name) {
      this.missed++; Tones.ding(); const n = this.el.notif; n.innerHTML = '<small>MISSED CALL</small>' + (name ? esc(name) + '<br>' : '') + '<span>' + esc(fmt(num)) + '</span>'; n.classList.add('on');
      clearTimeout(this.notifT); this.notifT = setTimeout(() => n.classList.remove('on'), 4200); this.render();
    },

    /* ------------------------------------------------------------ visibility */
    showForCall() { if (this.mode === 'closed') { this.openUI(false); } this.setPage('phone', 'keypad', true); },
    autoClose() { clearTimeout(this.autoCloseT); if (this.mode === 'auto' && this.state === 'IDLE') this.autoCloseT = setTimeout(() => { if (this.mode === 'auto' && this.state === 'IDLE') this.closeUI(); }, 250); },
    openUI(user) {
      clearTimeout(this.autoCloseT); const r = this.el.root; r.classList.add('open'); r.setAttribute('aria-hidden', 'false');
      if (user) { this.mode = 'user'; window.__typing = true; this.ownTyping = true; if (typeof Input !== 'undefined') Input.k = {}; try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {} }
      else if (this.mode !== 'user') this.mode = 'auto';
      if (user && this.page === 'phone' && this.tab === 'recents') this.clearMissed();
      this.render();
    },
    closeUI() {
      if (this.state === 'RINGING') return;                 // an incoming call has to be answered or declined first
      this.el.root.classList.remove('open'); this.el.root.setAttribute('aria-hidden', 'true'); this.mode = 'closed';
      if (this.ownTyping) { window.__typing = false; this.ownTyping = false; }
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const c = document.getElementById('c'); if (c) c.focus(); this.render();
    },
    claim() { if (this.mode !== 'auto') return; clearTimeout(this.autoCloseT); this.mode = 'user'; window.__typing = true; this.ownTyping = true; if (typeof Input !== 'undefined') Input.k = {}; this.render(); },   // player started using an auto-opened phone
    toggle() { if (!playing() || this.disabled || !this.num) return; if (this.mode === 'closed') this.openUI(true); else if (this.mode === 'auto' && this.state !== 'IDLE') this.claim(); else this.closeUI(); },
    clearMissed() { this.missed = 0; },

    /* ------------------------------------------------------------ UI */
    setPage(page, tab, instant) {
      this.page = page; if (tab) this.tab = tab;
      if (page === 'phone' && this.tab === 'recents') { this.clearMissed(); this.send({ k: 'recents' }); }
      if (page === 'phone' && this.tab === 'contacts') this.send({ k: 'contacts' });
      if (page === 'settings') this.send({ k: 'blocks' });
      this.render();
    },
    hint(text, bad) { const h = this.el.hint; if (!h) return; h.textContent = text; h.classList.toggle('bad', !!bad); clearTimeout(this.hintT); this.hintT = setTimeout(() => { h.textContent = ''; h.classList.remove('bad'); }, 2600); },
    flashStatus(text) { const s = this.el.st; s.textContent = text; s.className = 'st err'; clearTimeout(this.flashT); this.flashT = setTimeout(() => this.render(), 2200); },
    toggleForm(on, num) { this.formOpen = on === undefined ? !this.formOpen : !!on; this.el.form.classList.toggle('on', this.formOpen); if (this.formOpen) { this.el.fname.value = ''; this.el.fnum.value = num || ''; setTimeout(() => (num ? this.el.fname : this.el.fname).focus(), 30); } },
    digit(d) { if (this.state !== 'IDLE') return; if (this.dial.length >= 6) return; if (!this.dial && d === '0') { this.hint('Numbers start with 1-9', true); return; } this.dial += d; this.render(); },
    backspace() { if (this.state !== 'IDLE') return; this.dial = this.dial.slice(0, -1); this.render(); },

    render() {
      const e = this.el; if (!e.root) return; const s = this.state, cx = this.cx;
      e.root.classList.toggle('online', !!(net() && net().on)); e.root.classList.toggle('ringing', s === 'RINGING');
      $$('.ph-page', e.root).forEach((p) => p.classList.toggle('on', p.dataset.page === this.page));
      $$('.ph-tab', e.root).forEach((t) => t.classList.toggle('on', t.dataset.tab === this.tab));
      $$('.ph-sub', e.root).forEach((t) => t.classList.toggle('on', t.dataset.sub === this.tab));
      const mine = this.num ? fmt(this.num) : '--- ---';
      $$('[data-mynum]', e.root).forEach((x) => (x.textContent = mine));
      // keypad
      const d = this.dial; e.disp.innerHTML = d ? esc(d.length > 3 ? d.slice(0, 3) + ' ' + d.slice(3) : d) + '<span class="cur"></span>' : '<span class="ph-ph">Enter number</span>';
      e.del.classList.toggle('on', !!d); e.dialBtn.disabled = !(NUMRE.test(d) && this.num && s === 'IDLE');
      // badges
      const has = this.missed > 0; const pa = $('[data-app="phone"]', e.root); if (pa) { pa.classList.toggle('has', has); $('em', pa).textContent = this.missed; }
      e.fab.classList.toggle('has', has && this.mode === 'closed'); $('b', e.fab).textContent = this.missed;
      // call overlay
      const show = s !== 'IDLE', c = e.call;
      c.classList.toggle('on', show); c.classList.toggle('pulse', s === 'CALLING' || s === 'RINGING' || s === 'DIALING'); c.classList.toggle('ringing', s === 'RINGING');
      if (show && cx) {
        const nm = cx.name || fmt(cx.num); e.nm.textContent = nm; e.no.textContent = cx.name ? fmt(cx.num) : ''; e.av.textContent = (cx.name || '#').trim().charAt(0).toUpperCase();
      }
      const lbl = { DIALING: 'Calling', CALLING: 'Calling', RINGING: 'Incoming call', CONNECTING: 'Connecting', ACTIVE: 'Connected', ENDING: 'Ending', ENDED: '', FAILED: '' }[s] || '';
      e.lbl.textContent = lbl; e.lbl.classList.toggle('live', s === 'ACTIVE');
      let st = '', cls = 'st';
      if (s === 'DIALING' || s === 'CALLING') st = '<span class="dots">Calling</span>';
      else if (s === 'RINGING') st = 'Y answer  |  N decline';
      else if (s === 'CONNECTING') st = '<span class="dots">Connecting</span>';
      else if (s === 'ACTIVE') { const dis = this.pc && this.pc.iceConnectionState === 'disconnected'; st = dis ? '<span class="dots">Reconnecting</span>' : clock((performance.now() - this.t0) / 1000); }
      else if (s === 'ENDING') st = '<span class="dots">Ending</span>';
      else if (s === 'ENDED' || s === 'FAILED') { st = esc(this.result); cls = 'st big' + (this.resultErr ? ' err' : ''); }
      e.st.className = cls; e.st.innerHTML = st;
      e.bMute.hidden = s !== 'ACTIVE'; e.bVol.hidden = s !== 'ACTIVE'; e.bEnd.hidden = !(s === 'DIALING' || s === 'CALLING' || s === 'CONNECTING' || s === 'ACTIVE'); e.bDec.hidden = s !== 'RINGING'; e.bAns.hidden = s !== 'RINGING';
      e.bMute.firstElementChild.classList.toggle('on', this.muted); e.bMute.firstElementChild.innerHTML = svg(this.muted ? 'micoff' : 'mic'); $('span', e.bMute).textContent = this.muted ? 'Muted' : 'Mute';
      $('span', e.bVol).textContent = ['Volume 100%', 'Volume 60%', 'Volume 30%'][this.volIdx];
      // pill (call running while the phone is down)
      const live = s === 'CALLING' || s === 'CONNECTING' || s === 'ACTIVE' || s === 'DIALING', pill = e.pill, showPill = live && this.mode === 'closed';
      pill.classList.toggle('on', showPill);
      if (showPill) { $('.pnm', pill).textContent = cx ? (cx.name || fmt(cx.num)) : ''; $('.tm', pill).textContent = s === 'ACTIVE' ? clock((performance.now() - this.t0) / 1000) : 'calling...'; $('[data-act="pmute"]', pill).classList.toggle('on', this.muted); }
      e.fab.classList.toggle('hide', this.mode !== 'closed');
      this.renderLists();
    },

    renderLists() {
      const e = this.el; if (!e.root) return;
      // recents
      const rows = this.recents.map((r) => {
        const miss = !r.out && (r.status === 'missed' || r.status === 'cancelled'), nm = this.nameOf(r.num), label = nm || fmt(r.num);
        let sub; if (r.out) sub = r.status === 'ended' || r.status === 'answered' ? 'Outgoing' + (r.dur ? ' &middot; ' + clock(r.dur) : '') : r.status === 'rejected' ? 'Declined' : r.status === 'missed' ? 'No answer' : r.status === 'cancelled' ? 'Cancelled' : 'Unavailable';
        else sub = miss ? '<span class="miss">Missed</span>' : r.status === 'rejected' ? 'Declined' : '<span class="in">Incoming</span>' + (r.dur ? ' &middot; ' + clock(r.dur) : '');
        const ago = this.ago(r.at);
        return '<div class="ph-row' + (miss ? ' miss' : '') + '" data-act="redial" data-num="' + r.num + '"><div class="ph-av">' + esc((nm || '#').charAt(0).toUpperCase()) + '</div><div class="t"><b>' + esc(label) + '</b><span>' + sub + (nm ? ' &middot; ' + fmt(r.num) : '') + ' &middot; ' + ago + '</span></div>' +
          (nm ? '' : '<button class="ph-mini" data-act="savenum" data-num="' + r.num + '" aria-label="Save contact">' + svg('plus') + '</button>') + '<button class="ph-mini go" data-act="redial" data-num="' + r.num + '" aria-label="Call">' + svg('phone') + '</button></div>';
      });
      e.recents.innerHTML = rows.length ? rows.join('') : '<div class="ph-empty">No recent calls</div>';
      // contacts
      e.contacts.innerHTML = this.contacts.length ? this.contacts.map((c) => '<div class="ph-row" data-act="redial" data-num="' + c.num + '"><div class="ph-av">' + esc(c.name.charAt(0).toUpperCase()) + '</div><div class="t"><b>' + esc(c.name) + '</b><span>' + fmt(c.num) + '</span></div><button class="ph-mini x" data-act="cdel" data-id="' + esc(c.id) + '" aria-label="Delete contact">' + svg('x') + '</button><button class="ph-mini go" data-act="redial" data-num="' + c.num + '" aria-label="Call">' + svg('phone') + '</button></div>').join('') : '<div class="ph-empty">No contacts yet.<br>Save a friend\'s number to call them by name.</div>';
      // blocked
      e.blocked.innerHTML = this.blocks.length ? this.blocks.map((n) => '<div class="ph-setrow"><span class="grow">' + fmt(n) + '</span><button class="ph-btn sm ghost" data-act="unblock" data-num="' + n + '">Unblock</button></div>').join('') : '<div class="ph-hint" style="text-align:left;padding:0">Nobody blocked.</div>';
      if (e.snd) e.snd.textContent = Tones.on ? 'On' : 'Off';
    },
    ago(t) { const s = (Date.now() - t) / 1000; if (s < 60) return 'now'; if (s < 3600) return ((s / 60) | 0) + 'm ago'; if (s < 86400) return ((s / 3600) | 0) + 'h ago'; return ((s / 86400) | 0) + 'd ago'; },

    build() {
      const root = document.createElement('div'); root.id = 'ph-root'; root.setAttribute('aria-hidden', 'true'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Phone');
      const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((k) => '<button class="ph-key' + (/\d/.test(k) ? '' : ' dis') + '" data-key="' + k + '" type="button">' + k + '<small>' + (SUB[k] || '') + '</small></button>').join('');
      root.innerHTML =
        '<div id="ph-body"><div id="ph-screen"><div class="ph-notch"></div>' +
        '<div class="ph-status"><span id="ph-time"></span><span class="r"><span class="ph-sig"><i></i><i></i><i></i><i></i></span><span class="ph-bat"><i></i></span></span></div>' +
        // home
        '<section class="ph-page on" data-page="home"><div class="ph-home-top"><div class="ph-clock" id="ph-clock"></div><div class="ph-date" id="ph-date"></div></div>' +
        '<div class="ph-mynum"><small>MY NUMBER</small><b data-mynum>--- ---</b></div>' +
        '<div class="ph-apps">' +
        '<button class="ph-app" data-act="app" data-app="phone" type="button"><span class="ic" style="background:linear-gradient(145deg,#3ddc97,#1b9a68)">' + svg('phone') + '</span>Phone<em>0</em></button>' +
        '<button class="ph-app" data-act="app" data-app="contacts" type="button"><span class="ic" style="background:linear-gradient(145deg,#f2b84b,#c4801c)">' + svg('users') + '</span>Contacts</button>' +
        '<button class="ph-app" data-act="app" data-app="messages" type="button"><span class="ic" style="background:linear-gradient(145deg,#4aa8ff,#2a6fd6)">' + svg('msg') + '</span>Messages</button>' +
        '<button class="ph-app" data-act="app" data-app="settings" type="button"><span class="ic" style="background:linear-gradient(145deg,#8a97a8,#4c5867)">' + svg('sliders') + '</span>Settings</button>' +
        '</div></section>' +
        // phone app
        '<section class="ph-page" data-page="phone"><div class="ph-head"><button class="ph-back" data-act="home" type="button" aria-label="Back">' + svg('back') + '</button><h2>Phone</h2></div>' +
        '<div class="ph-tabs"><button class="ph-tab on" data-act="tab" data-tab="keypad" type="button">Keypad</button><button class="ph-tab" data-act="tab" data-tab="recents" type="button">Recents</button><button class="ph-tab" data-act="tab" data-tab="contacts" type="button">Contacts</button></div>' +
        '<div class="ph-sub on" data-sub="keypad"><div class="ph-me"><span>MY NUMBER</span><b data-mynum>--- ---</b></div><div class="ph-disp" id="ph-disp"></div><div class="ph-keys">' + keys + '</div>' +
        '<div class="ph-callrow"><button class="ph-callbtn" id="ph-dial" data-act="dial" type="button" aria-label="Call" disabled>' + svg('phone') + '</button><button class="ph-del" id="ph-del" data-act="del" type="button" aria-label="Delete">' + svg('del') + '</button></div><div class="ph-hint" id="ph-hint"></div></div>' +
        '<div class="ph-sub" data-sub="recents"><div class="ph-list" id="ph-recents"></div></div>' +
        '<div class="ph-sub" data-sub="contacts"><div class="ph-bar"><button class="ph-btn sm" data-act="cform" type="button">+ Add contact</button></div>' +
        '<div class="ph-form" id="ph-form"><input class="ph-in" id="ph-fname" maxlength="16" placeholder="Name" autocomplete="off"><input class="ph-in" id="ph-fnum" maxlength="7" inputmode="numeric" placeholder="6-digit number" autocomplete="off"><div style="display:flex;gap:8px"><button class="ph-btn" data-act="csave" type="button" style="flex:1">Save</button><button class="ph-btn ghost" data-act="cform" type="button">Cancel</button></div></div>' +
        '<div class="ph-list" id="ph-contacts"></div></div></section>' +
        // messages
        '<section class="ph-page" data-page="messages"><div class="ph-head"><button class="ph-back" data-act="home" type="button" aria-label="Back">' + svg('back') + '</button><h2>Messages</h2></div><div class="ph-empty">Texting is coming soon.<br>For now, call a friend.</div></section>' +
        // settings
        '<section class="ph-page" data-page="settings"><div class="ph-head"><button class="ph-back" data-act="home" type="button" aria-label="Back">' + svg('back') + '</button><h2>Settings</h2></div><div class="ph-set">' +
        '<h3>MY PHONE</h3><div class="ph-big" data-mynum>--- ---</div><div class="ph-setrow"><button class="ph-btn sm ghost" data-act="copy" type="button">Copy number</button><span id="ph-copied" class="ph-hint" style="padding:0"></span></div>' +
        '<h3>SOUND</h3><div class="ph-setrow"><span class="grow">Ringtones &amp; call sounds</span><button class="ph-btn sm ghost" data-act="snd" type="button" id="ph-snd">On</button></div>' +
        '<h3>BLOCKED NUMBERS</h3><div id="ph-blocked"></div><div class="ph-setrow"><input class="ph-in grow" id="ph-bnum" maxlength="7" inputmode="numeric" placeholder="6-digit number" autocomplete="off"><button class="ph-btn sm" data-act="block" type="button">Block</button></div>' +
        '<div class="ph-hint" id="ph-bhint"></div>' +
        (DEBUG ? '<h3>DEBUG</h3><div class="ph-dbg" id="ph-dbgp"></div>' : '') + '</div></section>' +
        // call overlay
        '<div id="ph-call"><div class="lbl" id="pc-lbl"></div><div class="ph-pulse"><i></i><i></i><i></i><div class="av" id="pc-av">#</div></div><div class="pnm" id="pc-nm"></div><div class="no" id="pc-no"></div><div class="st" id="pc-st"></div>' +
        '<div class="ph-ctl"><div class="c" id="pc-mute"><button class="ph-round" data-act="mute" type="button" aria-label="Mute">' + svg('mic') + '</button><span>Mute</span></div>' +
        '<div class="c" id="pc-vol"><button class="ph-round" data-act="vol" type="button" aria-label="Volume">' + svg('vol') + '</button><span>Volume 100%</span></div>' +
        '<div class="c" id="pc-dec"><button class="ph-round red" data-act="decline" type="button" aria-label="Decline">' + svg('phone') + '</button><span>Decline</span></div>' +
        '<div class="c" id="pc-end"><button class="ph-round red" data-act="end" type="button" aria-label="End call">' + svg('phone') + '</button><span>End</span></div>' +
        '<div class="c" id="pc-ans"><button class="ph-round grn" data-act="answer" type="button" aria-label="Answer">' + svg('phone') + '</button><span>Answer</span></div></div></div>' +
        '<button class="ph-home-ind" data-act="home" type="button" aria-label="Home"></button></div></div>';
      document.body.appendChild(root);

      const fab = document.createElement('button'); fab.id = 'ph-fab'; fab.type = 'button'; fab.setAttribute('aria-label', 'Phone (P)'); fab.innerHTML = svg('phone') + '<b>0</b>'; document.body.appendChild(fab);
      const pill = document.createElement('div'); pill.id = 'ph-pill';
      pill.innerHTML = '<span class="dot"></span><span class="pnm"></span><span class="tm"></span><button data-act="pmute" type="button" aria-label="Mute">' + svg('mic') + '</button><button class="red" data-act="pend" type="button" aria-label="End call">' + svg('phone') + '</button>'; document.body.appendChild(pill);
      const notif = document.createElement('div'); notif.id = 'ph-notif'; document.body.appendChild(notif);
      let dbg = null; if (DEBUG) { dbg = document.createElement('div'); dbg.id = 'ph-dbg'; document.body.appendChild(dbg); }

      const g = (id) => document.getElementById(id);
      Object.assign(this.el, { root, fab, pill, notif, dbg, disp: g('ph-disp'), del: g('ph-del'), dialBtn: g('ph-dial'), hint: g('ph-hint'), recents: g('ph-recents'), contacts: g('ph-contacts'), blocked: g('ph-blocked'), form: g('ph-form'), fname: g('ph-fname'), fnum: g('ph-fnum'),
        call: g('ph-call'), lbl: g('pc-lbl'), av: g('pc-av'), nm: g('pc-nm'), no: g('pc-no'), st: g('pc-st'), bMute: g('pc-mute'), bVol: g('pc-vol'), bDec: g('pc-dec'), bEnd: g('pc-end'), bAns: g('pc-ans'), snd: g('ph-snd'), dbgp: g('ph-dbgp') });

      const act = (el, ev) => {
        const a = el.dataset.act; ev.preventDefault(); ev.stopPropagation();
        switch (a) {
          case 'home': this.page = 'home'; this.render(); break;
          case 'app': { const n = el.dataset.app; if (n === 'phone') this.setPage('phone', 'keypad'); else if (n === 'contacts') this.setPage('phone', 'contacts'); else this.setPage(n); break; }
          case 'tab': this.setPage('phone', el.dataset.tab); break;
          case 'dial': this.dialNow(); break;
          case 'del': this.backspace(); break;
          case 'redial': if (this.state === 'IDLE') this.dialNow(el.dataset.num); break;
          case 'savenum': this.setPage('phone', 'contacts'); this.toggleForm(true, el.dataset.num); break;
          case 'cform': this.toggleForm(); break;
          case 'csave': { const name = this.el.fname.value.trim(), num = this.el.fnum.value.replace(/\D/g, ''); if (!name || !NUMRE.test(num)) { this.hint('Enter a name and a 6-digit number', true); break; } this.saving = true; this.send({ k: 'cadd', name, num }); break; }
          case 'cdel': this.send({ k: 'cdel', id: el.dataset.id }); break;
          case 'copy': { const t = this.num || ''; const done = (ok) => { const c = g('ph-copied'); c.textContent = ok ? 'Copied' : 'Press Ctrl+C'; setTimeout(() => (c.textContent = ''), 1800); }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => done(true), () => done(false)); else done(false); break; }
          case 'snd': Tones.on = !Tones.on; ls('kzk_phsnd', Tones.on ? '1' : '0'); if (!Tones.on) Tones.stop(); else if (this.state === 'RINGING') Tones.ring(); this.renderLists(); break;
          case 'block': { const n = g('ph-bnum').value.replace(/\D/g, ''); if (!NUMRE.test(n)) { g('ph-bhint').textContent = 'Enter a 6-digit number'; break; } g('ph-bhint').textContent = ''; this.send({ k: 'block', num: n }); g('ph-bnum').value = ''; break; }
          case 'unblock': this.send({ k: 'unblock', num: el.dataset.num }); break;
          case 'mute': case 'pmute': this.toggleMute(); break;
          case 'vol': this.cycleVol(); break;
          case 'end': case 'pend': this.endNow(); break;
          case 'decline': this.declineNow(); break;
          case 'answer': this.answerNow(); break;
        }
      };
      const onTap = (ev) => {
        const key = ev.target.closest && ev.target.closest('[data-key]'); if (key && root.contains(key)) { ev.preventDefault(); const k = key.dataset.key; if (/\d/.test(k)) { key.classList.add('hit'); setTimeout(() => key.classList.remove('hit'), 90); this.digit(k); } return; }
        const el = ev.target.closest && ev.target.closest('[data-act]'); if (!el || !(root.contains(el) || pill.contains(el))) return;
        // a nested mini button inside a row wins over the row
        act(el, ev);
      };
      root.addEventListener('click', onTap); pill.addEventListener('click', onTap);
      root.addEventListener('pointerdown', () => { if (this.mode === 'auto' && this.state !== 'RINGING') this.claim(); });
      root.addEventListener('contextmenu', (e) => e.preventDefault());
      fab.addEventListener('click', (e) => { e.preventDefault(); if (this.mode === 'closed') { if (this.state === 'IDLE' || true) this.openUI(true); } });
      // typing in the phone's own inputs: Enter saves/blocks, Escape leaves the field
      root.addEventListener('keydown', (e) => { if (!e.target.matches || !e.target.matches('input')) return; e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); if (e.target === this.el.fname || e.target === this.el.fnum) act($('[data-act="csave"]', root), e); else if (e.target.id === 'ph-bnum') act($('[data-act="block"]', root), e); } else if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); } });
      root.addEventListener('keyup', (e) => { if (e.target.matches && e.target.matches('input')) e.stopPropagation(); });
    },

    /* ------------------------------------------------------------ keyboard */
    key(e) {
      if (e.repeat && e.code !== 'Backspace') return;
      const inField = e.target && e.target.matches && e.target.matches('input,textarea');
      if (!playing() || this.disabled) return;
      if (inField) return;                                            // chat box or a phone field handles its own keys
      if (window.__typing && !this.ownTyping) return;                // some other text entry (travel menu etc.)
      if (e.code === 'KeyP' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); this.toggle(); return; }
      const s = this.state;
      if (s === 'RINGING' && (this.mode !== 'closed')) { if (e.code === 'KeyY' || (e.code === 'Enter' && this.mode === 'user')) { e.preventDefault(); this.answerNow(); return; } if (e.code === 'KeyN') { e.preventDefault(); this.declineNow(); return; } }
      if ((s === 'CALLING' || s === 'CONNECTING' || s === 'ACTIVE') && this.mode === 'closed' && e.code === 'KeyN') { e.preventDefault(); this.endNow(); return; }
      if (this.mode !== 'user') return;
      if (e.code === 'Escape') { e.preventDefault(); if (s !== 'IDLE') { if (s === 'RINGING') return; this.closeUI(); } else if (this.formOpen) this.toggleForm(false); else if (this.page !== 'home') { this.page = 'home'; this.render(); } else this.closeUI(); return; }
      if (s !== 'IDLE' || this.page !== 'phone' || this.tab !== 'keypad') { if (e.code === 'Enter' || e.code === 'Backspace') e.preventDefault(); return; }
      const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
      if (m) { e.preventDefault(); const k = $('[data-key="' + m[1] + '"]', this.el.root); if (k) { k.classList.add('hit'); setTimeout(() => k.classList.remove('hit'), 90); } this.digit(m[1]); }
      else if (e.code === 'Backspace') { e.preventDefault(); this.backspace(); }
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); this.dialNow(); }
    },

    /* ------------------------------------------------------------ periodic */
    tick() {
      const n = net(), e = this.el, on = !!(n && n.on && typeof Game !== 'undefined' && Game.playing);
      e.fab.classList.toggle('show', on && !!this.num && !this.disabled);      // no number from the server (phone system off) = no phone
      if (!on && this.mode !== 'closed' && this.state === 'IDLE') this.closeUI();
      const d = new Date(); const hh = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); $('#ph-time', e.root).textContent = hh; $('#ph-clock', e.root).textContent = hh.replace(/\s?[AP]M/i, '');
      $('#ph-date', e.root).textContent = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
      e.root.classList.toggle('online', !!(n && n.on));
      if (this.state === 'ACTIVE') this.render();
      if (this.state === 'RINGING' && !Tones.timers.ring && Tones.on) Tones.ring();      // context was locked when the call arrived: start as soon as it unlocks
      if (e.dbg) { const pc = this.pc; e.dbg.textContent = ['phone ' + (this.num || '-') + ' (' + (this.myName || '') + ')', 'state ' + this.state + '  mode ' + this.mode, 'call ' + (this.cx ? this.cx.id + ' ' + this.cx.role + ' peer=' + this.cx.peer : '-'), 'pc ' + (pc ? pc.connectionState + ' / ice ' + pc.iceConnectionState + ' / sig ' + pc.signalingState : '-'), 'mic ' + (this.lt ? this.lt.readyState + (this.lt.enabled ? '' : ' (muted)') : '-')].join('\n'); if (e.dbgp) e.dbgp.textContent = e.dbg.textContent; }
    },

    init() {
      if (!document.body) return addEventListener('DOMContentLoaded', () => this.init());
      this.build(); this.render();
      addEventListener('keydown', (e) => this.key(e), true);
      const unlock = () => { Tones.ctx(); }; addEventListener('pointerdown', unlock, true); addEventListener('keydown', unlock, true);
      setInterval(() => this.tick(), 500); this.tick();
      addEventListener('pagehide', () => { if (this.state !== 'IDLE') { this.send({ k: 'end' }); this.teardown(); } });
    },
  };

  window.Phone = P; P.Tones = Tones;
  Object.defineProperty(P, 'token', { get: () => ls('kzk_ptok') });
  P.init();
})();
