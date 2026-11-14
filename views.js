/* Spectrum — renderers. Each takes shared state S and draws into the 2D overlay (and WebGL for 3D). */
(function (g) {
  'use strict';
  const SA = g.SA, V = (SA.views = {});
  const M = { l: 42, r: 10, t: 10, b: 24 };
  const MONO = '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  const C = { font: '11px ' + MONO };
  V.rect = (w, h) => ({ x: M.l, y: M.t, w: Math.max(10, w - M.l - M.r), h: Math.max(10, h - M.t - M.b) });

  const yOf = (db, S, R) => R.y + R.h * (1 - (db - S.view.dbMin) / (S.view.dbMax - S.view.dbMin));

  function freqAxis(ctx, S, R, lines) {
    ctx.font = C.font; ctx.textBaseline = 'top'; ctx.textAlign = 'center'; ctx.lineWidth = 1;
    let lastR = -1e9;
    for (const f of SA.freqTicks(S.view)) {
      const t = SA.fToT(f, S.view);
      if (t < -0.001 || t > 1.001) continue;
      const x = Math.round(R.x + t * R.w) + 0.5;
      if (lines) { ctx.strokeStyle = S.theme.grid; ctx.beginPath(); ctx.moveTo(x, R.y); ctx.lineTo(x, R.y + R.h); ctx.stroke(); }
      const s = SA.fmtFreq(f), w = ctx.measureText(s).width;
      const lx = SA.clamp(x, R.x + w / 2, R.x + R.w - w / 2);
      if (lx - w / 2 > lastR + 6) { ctx.fillStyle = S.theme.muted; ctx.fillText(s, lx, R.y + R.h + 7); lastR = lx + w / 2; }
    }
    ctx.textAlign = 'right'; ctx.fillStyle = S.theme.muted; ctx.globalAlpha = 0.6;
    ctx.fillText('Hz', R.x - 6, R.y + R.h + 7); ctx.globalAlpha = 1;
  }
  function dbAxis(ctx, S, R) {
    const v = S.view, st = SA.niceStep(v.dbMax - v.dbMin, Math.max(2, R.h / 46));
    ctx.font = C.font; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.lineWidth = 1;
    for (let d = Math.ceil(v.dbMin / st) * st; d <= v.dbMax + 1e-6; d += st) {
      const y = Math.round(yOf(d, S, R)) + 0.5;
      ctx.strokeStyle = S.theme.grid; ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.x + R.w, y); ctx.stroke();
      if (y > R.y + 4 && y < R.y + R.h - 2) { ctx.fillStyle = S.theme.muted; ctx.fillText('' + Math.round(d * 10) / 10, R.x - 6, y); }
    }
    ctx.textBaseline = 'top'; ctx.fillStyle = S.theme.muted; ctx.globalAlpha = 0.6;
    ctx.fillText('dB', R.x - 6, R.y - 4); ctx.globalAlpha = 1;
  }

  let gradKey = '', gradFill = null, gradLine = null;
  function grads(ctx, S, R) {
    const key = S.lutName + '|' + S.theme.id + '|' + R.y + '|' + R.h;
    if (key === gradKey) return;
    gradKey = key;
    gradFill = ctx.createLinearGradient(0, R.y, 0, R.y + R.h);
    gradLine = ctx.createLinearGradient(0, R.y, 0, R.y + R.h);
    for (let i = 0; i <= 8; i++) {
      const t = i / 8, k = Math.round(255 * (1 - t * 0.62)) * 4, L = S.lut8;
      gradLine.addColorStop(t, `rgb(${L[k]},${L[k + 1]},${L[k + 2]})`);
      gradFill.addColorStop(t, `rgba(${L[k]},${L[k + 1]},${L[k + 2]},${(0.5 * (1 - t) + 0.04).toFixed(3)})`);
    }
  }

  let edges = null, colv = null;
  function cols(n) { if (!colv || colv.length !== n) { colv = new Float32Array(n); edges = new Float32Array(n + 1); } }

  function trace(ctx, S, R, n, close) {
    const v = S.view, ky = R.h / (v.dbMax - v.dbMin), sx = R.w / n, bottom = R.y + R.h + 2;
    ctx.beginPath();
    if (close) ctx.moveTo(R.x, bottom);
    for (let c = 0; c < n; c++) {
      let y = R.y + (v.dbMax - colv[c]) * ky;
      if (y > bottom) y = bottom;
      const x = R.x + (c + 0.5) * sx;
      if (c === 0 && !close) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (close) { ctx.lineTo(R.x + R.w, bottom); ctx.closePath(); }
  }

  /* ---------- Spectrum ---------- */
  V.spectrum = (ctx, S, R, dpr) => {
    freqAxis(ctx, S, R, true); dbAxis(ctx, S, R); grads(ctx, S, R);
    const n = Math.max(16, Math.round(R.w * dpr));
    cols(n);
    SA.viewEdges(S.view, n, S.binHz, edges);
    ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
    SA.resample(S.spec, edges, colv);
    trace(ctx, S, R, n, true); ctx.fillStyle = gradFill; ctx.fill();
    trace(ctx, S, R, n, false); ctx.strokeStyle = gradLine; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
    if (S.peakHold) {
      SA.resample(S.peak, edges, colv);
      trace(ctx, S, R, n, false); ctx.strokeStyle = S.theme.muted; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.restore();
  };

  /* ---------- Bars (1/3 octave) ---------- */
  V.bars = (ctx, S, R) => {
    freqAxis(ctx, S, R, false); dbAxis(ctx, S, R); grads(ctx, S, R);
    const bottom = R.y + R.h;
    ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
    for (let i = 0; i < S.bands.length; i++) {
      const B = S.bands[i], t0 = SA.fToT(B.lo, S.view), t1 = SA.fToT(B.hi, S.view);
      if (t1 <= 0 || t0 >= 1) continue;
      const x0 = R.x + t0 * R.w, x1 = R.x + t1 * R.w, gap = Math.min(3, (x1 - x0) * 0.18);
      const y = yOf(S.bandDb[i], S, R);
      if (y < bottom) { ctx.fillStyle = gradLine; ctx.globalAlpha = 1; ctx.fillRect(x0 + gap / 2, y, x1 - x0 - gap, bottom - y); }
      const yp = yOf(S.bandPeak[i], S, R);
      if (yp < bottom) { ctx.globalAlpha = 1; ctx.fillStyle = S.theme.ink; ctx.fillRect(x0 + gap / 2, yp - 1, x1 - x0 - gap, 2); }
    }
    ctx.restore();
  };

  /* ---------- Waterfall (spectrogram) ---------- */
  let wf = null, wfCtx = null, wfImg = null, wf32 = null, wfIdx = null;
  V.waterfall = (ctx, S, R, dpr) => {
    const H = S.hist, n = Math.min(1024, Math.max(16, Math.round(R.w * dpr))), rows = H.rows;
    if (!wf || wf.width !== n || wf.height !== rows) {
      wf = document.createElement('canvas'); wf.width = n; wf.height = rows;
      wfCtx = wf.getContext('2d'); wfImg = wfCtx.createImageData(n, rows);
      wf32 = new Uint32Array(wfImg.data.buffer); wfIdx = new Int32Array(n + 1);
    }
    SA.gridIndex(S.view, n, H, wfIdx);
    const lut = S.lut32, v = S.view, sc = 255 / (v.dbMax - v.dbMin), G = H.grid, data = H.data, BG = lut[0];
    const wide = wfIdx[n] - Math.max(0, wfIdx[0]) > n * 1.5;
    for (let r = 0; r < rows; r++) {
      const o = r * n;
      if (r >= H.count) { wf32.fill(BG, o, o + n); continue; }
      const base = ((((H.head - 1 - r) % rows) + rows) % rows) * G;
      for (let c = 0; c < n; c++) {
        const i = wfIdx[c];
        if (i < 0) { wf32[o + c] = BG; continue; }
        let d = data[base + i];
        if (wide && i + 1 < G) { const d2 = data[base + i + 1]; if (d2 > d) d = d2; }
        let li = (d - v.dbMin) * sc;
        li = li < 0 ? 0 : li > 255 ? 255 : li | 0;
        wf32[o + c] = lut[li];
      }
    }
    wfCtx.putImageData(wfImg, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(wf, R.x, R.y, R.w, R.h);
    freqAxis(ctx, S, R, false);
    // time labels
    const total = (rows * H.dt) / 1000, st = SA.niceStep(total, Math.max(2, R.h / 60));
    ctx.font = C.font; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = S.theme.muted;
    for (let s = 0; s <= total + 1e-6; s += st) {
      const y = R.y + (s / total) * R.h;
      if (y > R.y + R.h - 4) break;
      ctx.fillText(s === 0 ? 'now' : '-' + +s.toFixed(1) + 's', R.x - 6, Math.max(R.y + 6, y));
    }
    // colour scale
    const bw = 6, bx = R.x + R.w - bw - 6, bh = Math.min(120, R.h - 16), by = R.y + R.h - bh - 8;
    const gr = ctx.createLinearGradient(0, by, 0, by + bh), L = S.lut8;
    for (let i = 0; i <= 8; i++) { const k = Math.round(255 * (1 - i / 8)) * 4; gr.addColorStop(i / 8, `rgb(${L[k]},${L[k + 1]},${L[k + 2]})`); }
    ctx.fillStyle = S.theme.bg; ctx.globalAlpha = 0.85; ctx.fillRect(bx - 34, by - 5, bw + 39, bh + 10); ctx.globalAlpha = 1;
    ctx.strokeStyle = S.theme.line2; ctx.lineWidth = 1; ctx.strokeRect(bx - 0.5, by - 0.5, bw + 1, bh + 1);
    ctx.fillStyle = gr; ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = S.theme.ink; ctx.textAlign = 'right';
    ctx.textBaseline = 'top'; ctx.fillText(Math.round(v.dbMax) + '', bx - 5, by);
    ctx.textBaseline = 'bottom'; ctx.fillText(Math.round(v.dbMin) + '', bx - 5, by + bh);
  };

  /* ---------- Scope ---------- */
  V.scope = (ctx, S, R, dpr) => {
    const t = S.time, N = t.length, span = Math.min(N, Math.max(32, Math.round(S.scope.span))), amp = S.scope.amp;
    const mid = R.y + R.h / 2, ky = R.h / 2 / amp;
    ctx.font = C.font; ctx.lineWidth = 1;
    // amplitude grid
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let i = -2; i <= 2; i++) {
      const a = (i / 2) * amp, y = Math.round(mid - a * ky) + 0.5;
      ctx.strokeStyle = i === 0 ? S.theme.line2 : S.theme.grid;
      ctx.beginPath(); ctx.moveTo(R.x, y); ctx.lineTo(R.x + R.w, y); ctx.stroke();
      if (i > -2 && i < 2) { ctx.fillStyle = S.theme.muted; ctx.fillText(a === 0 ? '0' : '' + +a.toPrecision(2), R.x - 6, y); }
    }
    // time grid
    const totalMs = (span / S.sampleRate) * 1000, st = SA.niceStep(totalMs, Math.max(2, R.w / 80));
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (let ms = 0; ms <= totalMs + 1e-9; ms += st) {
      const x = Math.round(R.x + (ms / totalMs) * R.w) + 0.5;
      ctx.strokeStyle = S.theme.grid; ctx.beginPath(); ctx.moveTo(x, R.y); ctx.lineTo(x, R.y + R.h); ctx.stroke();
      if (ms > 0 && x < R.x + R.w - 14) { ctx.fillStyle = S.theme.muted; ctx.fillText(+ms.toPrecision(3) + '', x, R.y + R.h + 7); }
    }
    ctx.textAlign = 'right'; ctx.fillStyle = S.theme.muted; ctx.globalAlpha = 0.6;
    ctx.fillText('ms', R.x - 6, R.y + R.h + 7); ctx.globalAlpha = 1;
    // rising-edge trigger for a steady picture
    let start = 0;
    const lim = N - span;
    for (let i = 1; i < lim; i++) if (t[i - 1] < 0 && t[i] >= 0) { start = i; break; }
    ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
    ctx.beginPath();
    const px = Math.round(R.w * dpr);
    if (span <= px * 2) {
      for (let i = 0; i < span; i++) {
        const x = R.x + (i / (span - 1)) * R.w, y = mid - t[start + i] * ky;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
    } else {
      for (let c = 0; c < px; c++) {
        const i0 = start + Math.floor((c / px) * span), i1 = start + Math.floor(((c + 1) / px) * span);
        let lo = t[i0], hi = lo;
        for (let i = i0 + 1; i < i1; i++) { const s = t[i]; if (s < lo) lo = s; else if (s > hi) hi = s; }
        const x = R.x + (c + 0.5) / dpr;
        ctx.moveTo(x, mid - hi * ky); ctx.lineTo(x, mid - lo * ky + 0.5);
      }
    }
    const L = S.lut8, k = 190 * 4;
    ctx.strokeStyle = `rgb(${L[k]},${L[k + 1]},${L[k + 2]})`; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.restore();
  };

  /* ---------- 3D surface (WebGL) ---------- */
  const NX = 160, NZ = 96, ZH = 0.8, HS = 0.75, STRIDE = 2, LINE_EVERY = 3;
  let gl = null, glFail = false, prog, bufH, ibTri, ibLine, tex, loc = {}, hts, idx3, lutSeen = null, nTri = 0, nLine = 0;

  function initGL(canvas) {
    try {
      const o = { alpha: false, antialias: true };
      gl = canvas.getContext('webgl', o) || canvas.getContext('experimental-webgl', o);
    } catch (e) { gl = null; }
    if (!gl) { glFail = true; return; }
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER,
      'attribute vec2 aXZ; attribute float aH; uniform mat4 uM; uniform float uHS; varying float vH; varying float vZ;' +
      'void main(){ vH=aH; vZ=aXZ.y; gl_Position=uM*vec4(aXZ.x, aH*uHS, aXZ.y, 1.0); }'));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER,
      'precision mediump float; uniform sampler2D uLut; uniform float uLine; uniform float uZH; uniform vec3 uBg; uniform vec3 uLineC;' +
      'varying float vH; varying float vZ;' +
      'void main(){ vec3 c=texture2D(uLut, vec2(vH*0.98+0.01, 0.5)).rgb; float fade=mix(0.5,1.0,(vZ/uZH+1.0)*0.5);' +
      ' if(uLine>0.5){ c=mix(c, uLineC, 0.5); } gl_FragColor=vec4(mix(uBg, c, fade),1.0); }'));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { glFail = true; gl = null; return; }
    for (const n of ['uM', 'uHS', 'uLut', 'uLine', 'uZH', 'uBg', 'uLineC']) loc[n] = gl.getUniformLocation(prog, n);
    loc.aXZ = gl.getAttribLocation(prog, 'aXZ'); loc.aH = gl.getAttribLocation(prog, 'aH');

    const xz = new Float32Array(NX * NZ * 2);
    for (let z = 0; z < NZ; z++) for (let x = 0; x < NX; x++) {
      xz[(z * NX + x) * 2] = -1 + (2 * x) / (NX - 1);
      xz[(z * NX + x) * 2 + 1] = ZH - (2 * ZH * z) / (NZ - 1); // row 0 = newest, at the front
    }
    const bXZ = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bXZ); gl.bufferData(gl.ARRAY_BUFFER, xz, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.aXZ); gl.vertexAttribPointer(loc.aXZ, 2, gl.FLOAT, false, 0, 0);
    hts = new Float32Array(NX * NZ); idx3 = new Int32Array(NX + 1);
    bufH = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufH); gl.bufferData(gl.ARRAY_BUFFER, hts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(loc.aH); gl.vertexAttribPointer(loc.aH, 1, gl.FLOAT, false, 0, 0);

    const tri = new Uint16Array((NX - 1) * (NZ - 1) * 6);
    let k = 0;
    for (let z = 0; z < NZ - 1; z++) for (let x = 0; x < NX - 1; x++) {
      const a = z * NX + x, b = a + 1, c = a + NX, d = c + 1;
      tri[k++] = a; tri[k++] = c; tri[k++] = b; tri[k++] = b; tri[k++] = c; tri[k++] = d;
    }
    nTri = k;
    ibTri = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibTri); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, tri, gl.STATIC_DRAW);
    const ln = new Uint16Array(Math.ceil(NZ / LINE_EVERY) * (NX - 1) * 2);
    k = 0;
    for (let z = 0; z < NZ; z += LINE_EVERY) for (let x = 0; x < NX - 1; x++) { ln[k++] = z * NX + x; ln[k++] = z * NX + x + 1; }
    nLine = k;
    ibLine = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibLine); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, ln, gl.STATIC_DRAW);

    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  V.three = (ctx, S, dpr, glc, W, Hpx) => {
    if (!gl && !glFail) initGL(glc);
    if (!gl) {
      ctx.fillStyle = S.theme.muted; ctx.font = '14px "IBM Plex Sans", system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('The 3D view needs WebGL, which is turned off in this browser.', W / 2, Hpx / 2);
      return;
    }
    const H = S.hist, v = S.view, G = H.grid, data = H.data, rows = H.rows, inv = 1 / (v.dbMax - v.dbMin);
    SA.gridIndex(v, NX, H, idx3);
    for (let z = 0; z < NZ; z++) {
      const r = z * STRIDE, o = z * NX;
      if (r >= H.count) { hts.fill(0, o, o + NX); continue; }
      const base = ((((H.head - 1 - r) % rows) + rows) % rows) * G;
      for (let x = 0; x < NX; x++) {
        const i0 = idx3[x];
        if (i0 < 0) { hts[o + x] = 0; continue; }
        let i1 = idx3[x + 1]; if (i1 < 0) i1 = i0;
        let m = data[base + i0];
        for (let i = i0 + 1; i < i1; i++) if (data[base + i] > m) m = data[base + i];
        const h = (m - v.dbMin) * inv;
        hts[o + x] = h < 0 ? 0 : h > 1 ? 1 : h;
      }
    }
    if (lutSeen !== S.lut8) {
      lutSeen = S.lut8;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, S.lut8);
    }
    const aspect = W / Hpx, cam = S.cam, dist = cam.dist * Math.max(1, 1.25 / aspect);
    const cp = Math.cos(cam.pitch), tgt = [0, 0.08, 0];
    const eye = [tgt[0] + dist * Math.sin(cam.yaw) * cp, tgt[1] + dist * Math.sin(cam.pitch), tgt[2] + dist * Math.cos(cam.yaw) * cp];
    const mvp = SA.mul(SA.perspective(0.7, aspect, 0.1, 50), SA.lookAt(eye, tgt, [0, 1, 0]));

    gl.viewport(0, 0, glc.width, glc.height);
    const bg = S.theme.bgF, ik = S.theme.inkF;
    gl.clearColor(bg[0], bg[1], bg[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufH); gl.bufferSubData(gl.ARRAY_BUFFER, 0, hts);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc.uLut, 0); gl.uniformMatrix4fv(loc.uM, false, mvp); gl.uniform1f(loc.uHS, HS); gl.uniform1f(loc.uZH, ZH);
    gl.uniform3f(loc.uBg, bg[0], bg[1], bg[2]); gl.uniform3f(loc.uLineC, ik[0], ik[1], ik[2]);
    gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 1);
    gl.uniform1f(loc.uLine, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibTri); gl.drawElements(gl.TRIANGLES, nTri, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.uniform1f(loc.uLine, 1);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibLine); gl.drawElements(gl.LINES, nLine, gl.UNSIGNED_SHORT, 0);

    // labels, projected onto the 2D overlay
    const P = (x, y, z) => { const p = SA.project(mvp, x, y, z); return [(p[0] * 0.5 + 0.5) * W, (1 - (p[1] * 0.5 + 0.5)) * Hpx, p[2]]; };
    const front = Math.cos(cam.yaw) >= 0 ? ZH : -ZH, zOut = front * 1.08;
    ctx.font = C.font; ctx.fillStyle = S.theme.muted; ctx.strokeStyle = S.theme.line2; ctx.lineWidth = 1;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const a = P(-1, 0, front), b = P(1, 0, front);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    let lastX = null;
    for (const f of SA.freqTicks(v)) {
      const t = SA.fToT(f, v);
      if (t < -0.001 || t > 1.001) continue;
      const p0 = P(-1 + 2 * t, 0, front), p1 = P(-1 + 2 * t, 0, zOut);
      if (p0[2] <= 0) continue;
      ctx.beginPath(); ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.stroke();
      const s = SA.fmtFreq(f), w = ctx.measureText(s).width;
      if (lastX === null || Math.abs(p1[0] - lastX) > w + 8) { ctx.fillText(s, p1[0], p1[1] + 3); lastX = p1[0]; }
    }
    const side = Math.sin(cam.yaw) >= 0 ? -1 : 1, sx = side * (front > 0 ? 1 : -1);
    const lo = P(sx, 0, front), hi = P(sx, HS, front);
    ctx.beginPath(); ctx.moveTo(lo[0], lo[1]); ctx.lineTo(hi[0], hi[1]); ctx.stroke();
    const leftSide = lo[0] < W / 2 ? lo[0] > 56 : lo[0] > W - 56; // keep labels on screen
    ctx.textBaseline = 'middle'; ctx.textAlign = leftSide ? 'right' : 'left';
    const off = leftSide ? -6 : 6;
    ctx.fillText(Math.round(v.dbMax) + ' dB', hi[0] + off, hi[1]);
    ctx.fillText(Math.round(v.dbMin) + '', lo[0] + off, lo[1] - 6);
  };

  /* ---------- crosshair ---------- */
  V.cursor = (ctx, S, R) => {
    const c = S.cursor;
    if (!c || S.mode === 'scope' || S.mode === '3d') return;
    const x = SA.clamp(c.x, R.x, R.x + R.w), f = SA.tToF((x - R.x) / R.w, S.view);
    const db = SA.valueAt(S.spec, f / S.binHz);
    ctx.strokeStyle = S.theme.muted; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, R.y); ctx.lineTo(Math.round(x) + 0.5, R.y + R.h); ctx.stroke();
    if (S.mode === 'spectrum') {
      const y = SA.clamp(yOf(db, S, R), R.y, R.y + R.h);
      ctx.fillStyle = S.theme.accent; ctx.beginPath(); ctx.arc(x, y, 4, 0, 6.2832); ctx.fill();
    }
    const nt = SA.note(f);
    const s = SA.fmtHz(f) + (nt ? '  ' + nt.name : '') + '  ' + (db <= SA.DB_FLOOR + 1 ? '—' : db.toFixed(1) + ' dB');
    ctx.font = '12px ' + MONO;
    const w = ctx.measureText(s).width + 16, px = SA.clamp(x - w / 2, R.x + 2, R.x + R.w - w - 2), py = R.y + 6;
    ctx.fillStyle = S.theme.ink;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(px, py, w, 24, 4); ctx.fill(); } else ctx.fillRect(px, py, w, 24);
    ctx.fillStyle = S.theme.bg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(s, px + 8, py + 12.5);
  };
})(window);
