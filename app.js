/* Spectrum — audio engine, gestures and UI wiring. */
(function () {
  'use strict';
  const SA = window.SA, V = SA.views;
  const $ = (id) => document.getElementById(id);
  const MODES = ['spectrum', 'bars', 'waterfall', 'scope', '3d'];
  const ZERO_MS = 3000;

  /* ---------- prefs ---------- */
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('spectrum.v2') || '{}') || {}; } catch (e) {}
  const save = () => {
    try {
      localStorage.setItem('spectrum.v2', JSON.stringify({
        mode: S.mode, log: S.view.log, fft: S.fftSize, smooth: S.smooth, hold: S.peakHold, lut: S.lutName, dark: S.dark,
      }));
    } catch (e) {}
  };

  /* ---------- state ---------- */
  const GRID = 2048, ROWS = 300;
  const S = {
    mode: MODES.includes(prefs.mode) ? prefs.mode : '3d',
    dark: prefs.dark === true, theme: null,
    view: { fMin: 20, fMax: 20000, log: prefs.log !== false, dbMin: -100, dbMax: 0 },
    fftSize: [1024, 2048, 4096, 8192, 16384, 32768].includes(prefs.fft) ? prefs.fft : 4096,
    smooth: typeof prefs.smooth === 'number' ? SA.clamp(prefs.smooth, 0, 0.95) : 0.7,
    peakHold: !!prefs.hold,
    lutName: SA.MAPS[prefs.lut] ? prefs.lut : 'ember',
    lut8: null, lut32: null,
    sampleRate: 48000, nyq: 24000, binHz: 48000 / 4096,
    spec: null, peak: null, pw: null, time: null,
    bands: [], bandDb: null, bandPeak: null,
    hist: { grid: GRID, rows: ROWS, data: new Float32Array(GRID * ROWS).fill(SA.DB_FLOOR), head: 0, count: 0, dt: 33, last: 0, g0: 10, g1: 24000, edges: new Float32Array(GRID + 1) },
    scope: { span: 2048, amp: 0.5 },
    cam: { yaw: -0.55, pitch: 0.5, dist: 3.3 },
    cursor: null,
    source: null, running: false,
    noise: null, zero: null,
  };
  let raw, sm;

  function setLut(name) {
    S.lutName = name;
    S.lut8 = SA.buildLut(name, S.dark, S.theme.bg);
    S.lut32 = new Uint32Array(S.lut8.buffer);
  }
  function applyTheme() {
    const root = document.documentElement;
    root.dataset.theme = S.dark ? 'dark' : 'light';
    const cs = getComputedStyle(root), v = (n) => cs.getPropertyValue(n).trim();
    const bg = v('--bg'), ink = v('--ink'), accent = v('--accent'), i = SA.hex(ink);
    S.theme = {
      id: S.dark ? 'dark' : 'light', bg, ink, accent, muted: v('--muted'),
      grid: `rgba(${i[0]},${i[1]},${i[2]},0.09)`, line2: `rgba(${i[0]},${i[1]},${i[2]},0.28)`,
      bgF: SA.hex(bg).map((c) => c / 255), inkF: i.map((c) => c / 255), accentRGB: SA.hex(accent),
    };
    setLut(S.lutName);
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = bg;
  }
  function alloc() {
    const n = S.fftSize / 2;
    raw = new Float32Array(n); sm = new Float32Array(n);
    S.pw = new Float32Array(n).fill(1e-14);
    S.spec = new Float32Array(n).fill(SA.DB_FLOOR);
    S.peak = new Float32Array(n).fill(SA.DB_FLOOR);
    S.time = new Float32Array(S.fftSize);
    S.scope.span = Math.min(S.scope.span, S.fftSize);
  }
  function rateChanged(sr) {
    const first = S.view.fMax >= Math.min(20000, S.nyq) - 1;
    S.sampleRate = sr; S.nyq = sr / 2; S.binHz = sr / S.fftSize;
    const H = S.hist;
    if (H.g1 !== S.nyq) { H.g1 = S.nyq; H.count = 0; H.head = 0; }
    SA.histEdges(H, S.binHz);
    S.bands = SA.makeBands(S.nyq);
    S.bandDb = new Float32Array(S.bands.length).fill(SA.DB_FLOOR);
    S.bandPeak = new Float32Array(S.bands.length).fill(SA.DB_FLOOR);
    if (first || S.view.fMax > S.nyq) S.view.fMax = Math.min(20000, S.nyq);
    if (S.view.fMin >= S.view.fMax) S.view.fMin = S.view.log ? 20 : 0;
  }
  applyTheme(); alloc(); rateChanged(48000);

  /* ---------- audio ---------- */
  let ctx = null, analyser = null, mute = null, src = null;

  function ensureCtx() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('This browser has no Web Audio support.');
      ctx = new AC();
      analyser = ctx.createAnalyser();
      analyser.smoothingTimeConstant = 0;
      analyser.fftSize = S.fftSize;
      mute = ctx.createGain(); mute.gain.value = 0;
      analyser.connect(mute); mute.connect(ctx.destination); // keeps the graph pulled, silently
    }
    return ctx.state !== 'running' && ctx.resume ? ctx.resume().catch(() => {}) : Promise.resolve();
  }
  function stopSource() {
    if (src) { try { src.stop(); } catch (e) {} }
    src = null;
  }
  async function micSource() {
    if (!window.isSecureContext) throw new Error('Microphone needs a secure (https) page.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot open a microphone.');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false,
      });
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) throw new Error('Microphone is blocked. Allow it in the browser’s site settings, or try the demo.');
      if (e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) throw new Error('No microphone found on this device.');
      throw new Error('Could not open the microphone.');
    }
    const node = ctx.createMediaStreamSource(stream);
    node.connect(analyser);
    return { stop() { node.disconnect(); stream.getTracks().forEach((t) => t.stop()); } };
  }
  async function fileSource(file) {
    const buf = await file.arrayBuffer();
    let audio;
    try {
      audio = await new Promise((res, rej) => { const p = ctx.decodeAudioData(buf, res, rej); if (p && p.catch) p.catch(rej); });
    } catch (e) { throw new Error('Could not read that file as audio.'); }
    const node = ctx.createBufferSource();
    node.buffer = audio; node.loop = true;
    node.connect(analyser); node.connect(ctx.destination);
    node.start();
    return { stop() { try { node.stop(); } catch (e) {} node.disconnect(); } };
  }
  function demoSource() {
    const out = ctx.createGain(); out.connect(analyser);
    const nodes = [];
    const osc = (type, f, gain) => {
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = type; o.frequency.value = f; gn.gain.value = gain;
      o.connect(gn); gn.connect(out); o.start(); nodes.push(o);
      return o;
    };
    const sweep = osc('sine', 120, 0.22);
    osc('sawtooth', 220, 0.05);
    osc('sine', 1000, 0.1);
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(), lp = ctx.createBiquadFilter(), ng = ctx.createGain();
    noise.buffer = nb; noise.loop = true; lp.type = 'lowpass'; lp.frequency.value = 2500; ng.gain.value = 0.03;
    noise.connect(lp); lp.connect(ng); ng.connect(out); noise.start(); nodes.push(noise);
    let next = ctx.currentTime;
    return {
      tick() {
        while (next < ctx.currentTime + 1) {
          sweep.frequency.setValueAtTime(120, next);
          sweep.frequency.exponentialRampToValueAtTime(9000, next + 4);
          sweep.frequency.exponentialRampToValueAtTime(120, next + 8);
          next += 8;
        }
      },
      stop() { nodes.forEach((n) => { try { n.stop(); } catch (e) {} }); out.disconnect(); },
    };
  }

  let starting = false;
  async function start(kind, file) {
    if (starting) return;
    starting = true;
    try {
      const ready = ensureCtx(); // must run inside the tap, before any await (Safari)
      await ready;
      const next = kind === 'mic' ? await micSource() : kind === 'file' ? await fileSource(file) : demoSource();
      stopSource();
      src = next;
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      clearZero(true);
      sm.fill(0); S.peak.fill(SA.DB_FLOOR);
      S.source = kind; S.running = true;
      $('intro').hidden = true;
      closeSheet();
      if (S.mode === '3d') hint3d();
    } catch (e) {
      toast(e.message || 'Something went wrong.', 4500);
      if (!S.source) $('intro').hidden = false;
    } finally {
      starting = false;
      ui();
    }
  }
  function togglePlay() {
    if (!S.source) { $('intro').hidden = false; return; }
    if (S.running) { S.running = false; if (S.zero) clearZero(true); ctx.suspend && ctx.suspend(); }
    else { S.running = true; ctx.resume(); }
    ui();
  }
  function setFft(n) {
    if (n === S.fftSize) return;
    const oldNoise = S.noise;
    S.fftSize = n;
    if (analyser) analyser.fftSize = n;
    alloc();
    rateChanged(S.sampleRate);
    if (S.zero) { S.zero = null; $('zeroOverlay').hidden = true; }
    S.noise = oldNoise ? SA.resampleNoise(oldNoise, n / 2) : null;
    save(); ui();
  }

  /* ---------- zero (background removal) ---------- */
  function toggleZero() {
    if (S.zero) return;
    if (S.noise) { clearZero(); toast('Background restored'); return; }
    if (!S.running) { toast('Resume first, then zero the background.'); return; }
    S.zero = { t0: performance.now(), acc: new Float64Array(S.fftSize / 2), n: 0 };
    $('zeroOverlay').hidden = false;
    ui();
  }
  function clearZero(silent) {
    S.zero = null; S.noise = null;
    $('zeroOverlay').hidden = true;
    if (!silent) ui();
  }
  function finishZero() {
    const z = S.zero, n = z.acc.length, noise = new Float32Array(n);
    for (let i = 0; i < n; i++) noise[i] = z.acc[i] / Math.max(1, z.n);
    S.noise = noise; S.zero = null;
    S.peak.fill(SA.DB_FLOOR); S.bandPeak.fill(SA.DB_FLOOR);
    $('zeroOverlay').hidden = true;
    toast('Background removed from the graphs.', 2600);
    ui();
  }

  /* ---------- per-frame analysis ---------- */
  let lastRead = 0, lastT = 0;
  function process(now) {
    if (ctx.sampleRate !== S.sampleRate) rateChanged(ctx.sampleRate);
    if (src && src.tick) src.tick();
    const n = raw.length, z = S.zero, noise = S.noise, spec = S.spec, peak = S.peak, pw = S.pw;
    analyser.getFloatFrequencyData(raw);
    const dt = Math.min(0.1, (now - lastT) / 1000 || 0.016); lastT = now;
    const k = noise ? Math.max(S.smooth, 0.7) : S.smooth, k1 = 1 - k, decay = 9 * dt, OS = SA.OVERSUB;
    for (let i = 0; i < n; i++) {
      const d = raw[i];
      const p = d > -200 ? Math.pow(10, d * 0.1) : 0;
      if (z) z.acc[i] += p;
      let s = (sm[i] = k * sm[i] + k1 * p);
      if (noise) s -= OS * noise[i];
      if (!(s > 1e-14)) s = 1e-14;
      pw[i] = s;
      const db = 10 * Math.log10(s);
      spec[i] = db;
      const pk = peak[i] - decay;
      peak[i] = db > pk ? db : pk;
    }
    if (z) {
      z.n++;
      const el = now - z.t0;
      $('zeroBar').style.transform = 'scaleX(' + Math.min(1, el / ZERO_MS) + ')';
      $('zeroCount').textContent = Math.max(1, Math.ceil((ZERO_MS - el) / 1000));
      if (el >= ZERO_MS) finishZero();
    }
    if (analyser.getFloatTimeDomainData) analyser.getFloatTimeDomainData(S.time);
    else {
      const b = process.bytes && process.bytes.length === S.time.length ? process.bytes : (process.bytes = new Uint8Array(S.time.length));
      analyser.getByteTimeDomainData(b);
      for (let i = 0; i < b.length; i++) S.time[i] = (b[i] - 128) / 128;
    }
    SA.bandLevels(pw, S.bands, S.binHz, S.bandDb);
    for (let b = 0; b < S.bandDb.length; b++) { const pk = S.bandPeak[b] - 18 * dt; S.bandPeak[b] = S.bandDb[b] > pk ? S.bandDb[b] : pk; }
    const H = S.hist;
    if (now - H.last >= H.dt) {
      H.last = now;
      SA.resample(spec, H.edges, H.data.subarray(H.head * H.grid, (H.head + 1) * H.grid));
      H.head = (H.head + 1) % H.rows;
      if (H.count < H.rows) H.count++;
    }
    if (now - lastRead > 120) { lastRead = now; readout(); }
  }
  function readout() {
    const p = SA.findPeak(S.spec, S.binHz, 20, S.nyq);
    if (p.db < -90 || !(p.f > 0)) { $('readF').textContent = '—'; $('readN').textContent = '—'; $('readD').textContent = '—'; return; }
    const nt = SA.note(p.f);
    $('readF').textContent = p.f >= 1000 ? (p.f / 1000).toFixed(3) + ' kHz' : p.f.toFixed(1) + ' Hz';
    $('readN').textContent = nt.name + ' ' + (nt.cents >= 0 ? '+' : '−') + Math.abs(nt.cents) + '¢';
    $('readD').textContent = p.db.toFixed(1) + ' dB';
  }

  /* ---------- drawing ---------- */
  const plot = $('plot'), c2d = $('c2d'), cgl = $('cgl'), g2 = c2d.getContext('2d');
  let W = 0, Hh = 0, dpr = 1, R = V.rect(300, 200), snapWanted = false;

  function draw() {
    const w = plot.clientWidth, h = plot.clientHeight;
    if (!w || !h) return;
    const d = Math.min(window.devicePixelRatio || 1, 2);
    if (w !== W || h !== Hh || d !== dpr) {
      W = w; Hh = h; dpr = d;
      for (const c of [c2d, cgl]) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
    }
    g2.setTransform(dpr, 0, 0, dpr, 0, 0);
    g2.clearRect(0, 0, W, Hh);
    R = V.rect(W, Hh);
    if (S.mode === '3d') V.three(g2, S, dpr, cgl, W, Hh);
    else { V[S.mode](g2, S, R, dpr); V.cursor(g2, S, R); }
  }
  function frame(now) {
    requestAnimationFrame(frame);
    if (S.running && analyser) process(now);
    draw();
    if (snapWanted) { snapWanted = false; snapshot(); }
  }
  function snapshot() {
    const c = document.createElement('canvas'); c.width = c2d.width; c.height = c2d.height;
    const x = c.getContext('2d');
    x.fillStyle = S.theme.bg; x.fillRect(0, 0, c.width, c.height);
    if (S.mode === '3d') x.drawImage(cgl, 0, 0);
    x.drawImage(c2d, 0, 0);
    c.toBlob((blob) => {
      if (!blob) return toast('Could not save image');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'spectrum-' + S.mode + '-' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, 'image/png');
  }

  /* ---------- zoom / pan ---------- */
  function zoomX(k, t) {
    if (S.mode === 'scope') S.scope.span = SA.clamp(S.scope.span / k, 64, S.fftSize);
    else SA.zoomFreq(S.view, k, SA.clamp(t, 0, 1), S.nyq);
  }
  function zoomY(k, t) {
    if (S.mode === 'scope') S.scope.amp = SA.clamp(S.scope.amp / k, 0.001, 1);
    else SA.zoomDb(S.view, k, SA.clamp(t, 0, 1));
  }
  function pan(dx, dy) {
    if (S.mode === 'scope') return;
    if (dx) SA.panFreq(S.view, dx / R.w, S.nyq);
    if (dy && S.mode !== 'waterfall') SA.panDb(S.view, dy / R.h);
  }
  function resetView() {
    const v = S.view;
    v.fMin = v.log ? 20 : 0; v.fMax = Math.min(20000, S.nyq); v.dbMin = -100; v.dbMax = 0;
    S.scope.span = Math.min(2048, S.fftSize); S.scope.amp = 0.5;
    S.cam.yaw = -0.55; S.cam.pitch = 0.5; S.cam.dist = 3.3;
    S.cursor = null;
  }
  function setLog(on) {
    const v = S.view;
    v.log = on;
    if (on) { v.fMin = Math.max(v.fMin, 10); if (v.fMax < v.fMin * 1.1) v.fMax = Math.min(S.nyq, v.fMin * 2); }
    SA.zoomFreq(v, 1, 0.5, S.nyq);
    save(); ui();
  }

  const pts = new Map();
  let tap = null, lastTap = { t: 0, x: 0, y: 0 };
  const local = (e) => { const b = c2d.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
  const tx = (x) => (x - R.x) / R.w, ty = (y) => 1 - (y - R.y) / R.h;

  c2d.addEventListener('pointerdown', (e) => {
    try { c2d.setPointerCapture(e.pointerId); } catch (err) {}
    const p = local(e);
    pts.set(e.pointerId, p);
    tap = pts.size === 1 ? { x: p.x, y: p.y, t: performance.now(), moved: false } : null;
  });
  c2d.addEventListener('pointermove', (e) => {
    const p = local(e), prev = pts.get(e.pointerId);
    if (!prev) { if (e.pointerType === 'mouse') S.cursor = p; return; }
    if (pts.size === 1) {
      const dx = p.x - prev.x, dy = p.y - prev.y;
      if (tap && Math.abs(p.x - tap.x) + Math.abs(p.y - tap.y) > 8) tap.moved = true;
      if (S.mode === '3d') { S.cam.yaw -= dx * 0.008; S.cam.pitch = SA.clamp(S.cam.pitch + dy * 0.006, 0.06, 1.45); }
      else { pan(dx, dy); if (e.pointerType === 'mouse') S.cursor = p; }
      pts.set(e.pointerId, p);
    } else if (pts.size === 2) {
      let other = null;
      pts.forEach((v, id) => { if (id !== e.pointerId) other = v; });
      const sx0 = Math.abs(prev.x - other.x), sy0 = Math.abs(prev.y - other.y);
      const sx1 = Math.abs(p.x - other.x), sy1 = Math.abs(p.y - other.y);
      const mx = (p.x + other.x) / 2, my = (p.y + other.y) / 2;
      if (S.mode === '3d') {
        const d0 = Math.hypot(sx0, sy0), d1 = Math.hypot(sx1, sy1);
        if (d0 > 10 && d1 > 10) S.cam.dist = SA.clamp((S.cam.dist * d0) / d1, 1.6, 8);
      } else {
        // sideways pinch = frequency only, vertical pinch = level only, diagonal = both
        const doX = sx1 > sy1 * 0.5 && sx0 > 24 && sx1 > 24, doY = sy1 > sx1 * 0.5 && sy0 > 24 && sy1 > 24;
        if (doX) zoomX(sx1 / sx0, tx(mx));
        if (doY) zoomY(sy1 / sy0, ty(my));
        pan((p.x - prev.x) / 2, (p.y - prev.y) / 2);
      }
      pts.set(e.pointerId, p);
    }
  });
  const up = (e) => {
    const had = pts.delete(e.pointerId);
    if (!had || e.type === 'pointercancel') { tap = null; return; }
    if (tap && !tap.moved && performance.now() - tap.t < 350 && pts.size === 0) {
      const now = performance.now();
      if (now - lastTap.t < 350 && Math.hypot(tap.x - lastTap.x, tap.y - lastTap.y) < 40) { resetView(); lastTap.t = 0; }
      else {
        lastTap = { t: now, x: tap.x, y: tap.y };
        if (e.pointerType !== 'mouse') S.cursor = S.cursor && Math.abs(S.cursor.x - tap.x) < 24 ? null : { x: tap.x, y: tap.y };
      }
    }
    tap = null;
  };
  c2d.addEventListener('pointerup', up);
  c2d.addEventListener('pointercancel', up);
  c2d.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pts.size) S.cursor = null; });
  c2d.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    const unit = e.deltaMode === 1 ? 16 : 1;
    if (!e.shiftKey && !e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) && S.mode !== '3d') { pan(-e.deltaX * unit, 0); return; }
    const dlt = (e.deltaY || e.deltaX) * unit;
    const k = Math.exp(-dlt * (e.ctrlKey ? 0.012 : 0.0022));
    if (S.mode === '3d') S.cam.dist = SA.clamp(S.cam.dist / k, 1.6, 8);
    else if (e.shiftKey || p.x < R.x) zoomY(k, ty(p.y));
    else zoomX(k, tx(p.x));
  }, { passive: false });
  // Safari trackpad pinch (desktop). Touch pinches are handled by pointer events above.
  let gScale = 1;
  c2d.addEventListener('gesturestart', (e) => { e.preventDefault(); gScale = 1; });
  c2d.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    if (pts.size) return;
    const k = e.scale / gScale; gScale = e.scale;
    if (S.mode === '3d') S.cam.dist = SA.clamp(S.cam.dist / k, 1.6, 8);
    else zoomX(k, S.cursor ? tx(S.cursor.x) : 0.5);
  });
  c2d.addEventListener('gestureend', (e) => e.preventDefault());

  $('zoomer').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const z = b.dataset.z, K = 1.5;
    if (z === 'r') resetView();
    else if (z === 'x+') zoomX(K, 0.5); else if (z === 'x-') zoomX(1 / K, 0.5);
    else if (z === 'y+') zoomY(K, 0.5); else if (z === 'y-') zoomY(1 / K, 0.5);
  });

  /* ---------- UI ---------- */
  let toastT = 0;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms || 2200);
  }
  function seg(name, value) {
    document.querySelectorAll('[data-seg="' + name + '"] button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.val === String(value))));
  }
  function ui() {
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === S.mode)));
    cgl.style.display = S.mode === '3d' ? 'block' : 'none';
    $('bar').hidden = !S.source;
    $('btnPlay').textContent = S.running ? 'Pause' : 'Resume';
    const zb = $('btnZero');
    zb.classList.toggle('on', !!S.noise); zb.disabled = !!S.zero;
    zb.setAttribute('aria-pressed', String(!!S.noise));
    zb.textContent = S.zero ? 'Listening…' : S.noise ? 'Undo zero' : 'Zero background';
    const tb = $('btnTheme');
    tb.setAttribute('aria-pressed', String(S.dark));
    tb.setAttribute('aria-label', S.dark ? 'Switch to light mode' : 'Switch to dark mode');
    seg('source', S.source || ''); seg('scale', S.view.log ? 'log' : 'lin'); seg('lut', S.lutName);
    $('fft').value = String(S.fftSize); $('smooth').value = String(S.smooth); $('hold').checked = S.peakHold;
    $('fftHint').textContent = '≈ ' + (S.binHz >= 10 ? S.binHz.toFixed(0) : S.binHz.toFixed(1)) + ' Hz per step';
  }
  function hint3d() {
    if (hint3d.done) return;
    hint3d.done = true;
    toast('Drag to rotate. Pinch or scroll to move closer.', 3200);
  }
  function setMode(m) {
    S.mode = m; S.cursor = null;
    if (m === '3d' && S.source) hint3d();
    save(); ui();
  }
  function openSheet() { $('sheet').hidden = false; $('backdrop').hidden = false; requestAnimationFrame(() => document.body.classList.add('sheet-open')); }
  function closeSheet() {
    document.body.classList.remove('sheet-open');
    setTimeout(() => { if (!document.body.classList.contains('sheet-open')) { $('sheet').hidden = true; $('backdrop').hidden = true; } }, 220);
  }

  $('tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.view); });
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnZero').addEventListener('click', toggleZero);
  $('btnSettings').addEventListener('click', openSheet);
  $('btnTheme').addEventListener('click', () => { S.dark = !S.dark; applyTheme(); save(); ui(); });
  $('sheetClose').addEventListener('click', closeSheet);
  $('backdrop').addEventListener('click', closeSheet);

  const pickFile = () => { try { ensureCtx(); } catch (e) {} $('fileInput').click(); };
  const choose = (kind) => (kind === 'file' ? pickFile() : start(kind));
  $('intro').addEventListener('click', (e) => { const b = e.target.closest('button[data-src]'); if (b) choose(b.dataset.src); });
  $('fileInput').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) start('file', f); });
  document.querySelector('[data-seg="source"]').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) choose(b.dataset.val); });
  document.querySelector('[data-seg="scale"]').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setLog(b.dataset.val === 'log'); });
  document.querySelector('[data-seg="lut"]').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { setLut(b.dataset.val); save(); ui(); } });
  $('fft').addEventListener('change', (e) => setFft(+e.target.value));
  $('smooth').addEventListener('input', (e) => { S.smooth = +e.target.value; save(); });
  $('hold').addEventListener('change', (e) => { S.peakHold = e.target.checked; S.peak.fill(SA.DB_FLOOR); save(); });
  $('btnSnap').addEventListener('click', () => { snapWanted = true; closeSheet(); });

  const root = document.documentElement;
  const fsReq = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!fsReq) $('btnFull').hidden = true;
  $('btnFull').addEventListener('click', () => {
    const cur = document.fullscreenElement || document.webkitFullscreenElement;
    if (cur) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else { const r = fsReq.call(root); if (r && r.catch) r.catch(() => {}); }
    closeSheet();
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key >= '1' && e.key <= '5') setMode(MODES[+e.key - 1]);
    else if (e.key === 'z' || e.key === 'Z') toggleZero();
    else if (e.key === 'Escape') closeSheet();
    else if (e.key === '0') resetView();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.running && ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
  });

  ui();
  requestAnimationFrame(frame);
  window.__spectrum = { S, start };
})();
