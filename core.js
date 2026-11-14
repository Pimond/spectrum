/* Spectrum — pure math helpers (no DOM). Loaded in browser and in node tests. */
(function (g) {
  'use strict';
  const SA = (g.SA = g.SA || {});

  SA.DB_FLOOR = -140;
  const clamp = (SA.clamp = (v, a, b) => (v < a ? a : v > b ? b : v));

  /* ---------- frequency / level axes ---------- */
  const fwd = (SA.fwd = (f, log) => (log ? Math.log(f) : f));
  const inv = (SA.inv = (u, log) => (log ? Math.exp(u) : u));

  SA.fToT = (f, v) => {
    const a = fwd(v.fMin, v.log), b = fwd(v.fMax, v.log);
    return (fwd(Math.max(f, 1e-6), v.log) - a) / (b - a);
  };
  SA.tToF = (t, v) => {
    const a = fwd(v.fMin, v.log), b = fwd(v.fMax, v.log);
    return inv(a + t * (b - a), v.log);
  };

  function setFreq(v, a, span, nyq) {
    const uLo = fwd(v.log ? 10 : 0, v.log), uHi = fwd(nyq, v.log);
    const minSpan = v.log ? Math.log(1.06) : Math.min(50, nyq);
    span = clamp(span, minSpan, uHi - uLo);
    if (a < uLo) a = uLo;
    if (a + span > uHi) a = uHi - span;
    v.fMin = inv(a, v.log);
    v.fMax = inv(a + span, v.log);
  }
  /* zoom by factor k (>1 = in) around anchor t0 (0..1 across the plot) */
  SA.zoomFreq = (v, k, t0, nyq) => {
    const a = fwd(v.fMin, v.log), b = fwd(v.fMax, v.log);
    const uLo = fwd(v.log ? 10 : 0, v.log), uHi = fwd(nyq, v.log);
    const minSpan = v.log ? Math.log(1.06) : Math.min(50, nyq);
    const span = clamp((b - a) / k, minSpan, uHi - uLo);
    const u0 = a + t0 * (b - a);
    setFreq(v, u0 - t0 * span, span, nyq);
  };
  /* pan by dt (fraction of plot width; positive = content moves right) */
  SA.panFreq = (v, dt, nyq) => {
    const a = fwd(v.fMin, v.log), b = fwd(v.fMax, v.log);
    setFreq(v, a - dt * (b - a), b - a, nyq);
  };
  SA.DB_LO = -150;
  SA.DB_HI = 20;
  function setDb(v, lo, span) {
    span = clamp(span, 6, SA.DB_HI - SA.DB_LO);
    if (lo < SA.DB_LO) lo = SA.DB_LO;
    if (lo + span > SA.DB_HI) lo = SA.DB_HI - span;
    v.dbMin = lo;
    v.dbMax = lo + span;
  }
  /* t0 measured from bottom (0) to top (1) */
  SA.zoomDb = (v, k, t0) => {
    const old = v.dbMax - v.dbMin;
    const span = clamp(old / k, 6, SA.DB_HI - SA.DB_LO);
    const d0 = v.dbMin + t0 * old;
    setDb(v, d0 - t0 * span, span);
  };
  /* dt = fraction of plot height; positive = content moves down */
  SA.panDb = (v, dt) => {
    const span = v.dbMax - v.dbMin;
    setDb(v, v.dbMin + dt * span, span);
  };

  /* ---------- ticks & formatting ---------- */
  SA.niceStep = (span, target) => {
    const raw = span / Math.max(1, target);
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  };
  SA.freqTicks = (v) => {
    const out = [];
    const ratio = v.fMax / Math.max(v.fMin, 1e-6);
    if (!v.log || ratio < 4) {
      const st = SA.niceStep(v.fMax - v.fMin, 7);
      for (let f = Math.ceil(v.fMin / st) * st; f <= v.fMax + st * 1e-6; f += st) out.push(f);
      return out;
    }
    const mult = ratio < 30 ? [1, 2, 3, 5, 7] : [1, 2, 5];
    for (let e = Math.floor(Math.log10(v.fMin)); e <= Math.ceil(Math.log10(v.fMax)); e++) {
      const p = Math.pow(10, e);
      for (const m of mult) {
        const f = m * p;
        if (f >= v.fMin * 0.999 && f <= v.fMax * 1.001) out.push(f);
      }
    }
    return out;
  };
  SA.fmtFreq = (f) => (f >= 1000 ? +(f / 1000).toFixed(2) + 'k' : '' + +f.toFixed(f < 100 ? 1 : 0));
  SA.fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 2 : 3) + ' kHz' : f.toFixed(1) + ' Hz');

  const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  SA.note = (f) => {
    if (!(f > 0)) return null;
    const n = 12 * Math.log2(f / 440) + 69;
    const r = Math.round(n);
    return { name: NAMES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1), cents: Math.round((n - r) * 100) };
  };

  /* ---------- resampling ---------- */
  /* edges: bin positions (float), length out.length+1. Wide cells take the max, narrow cells interpolate. */
  SA.resample = (src, edges, out) => {
    const n = src.length, last = n - 1;
    for (let c = 0; c < out.length; c++) {
      const a = edges[c], b = edges[c + 1];
      if (b - a <= 1) {
        let m = (a + b) * 0.5;
        if (m < 0) m = 0; else if (m > last) m = last;
        let i = Math.floor(m);
        if (i > last - 1) i = last - 1;
        const fr = m - i;
        out[c] = src[i] + (src[i + 1] - src[i]) * fr;
      } else {
        let i0 = Math.round(a), i1 = Math.round(b);
        if (i0 < 0) i0 = 0; else if (i0 > last) i0 = last;
        if (i1 < i0) i1 = i0; else if (i1 > last) i1 = last;
        let m = src[i0];
        for (let i = i0 + 1; i <= i1; i++) if (src[i] > m) m = src[i];
        out[c] = m;
      }
    }
  };
  SA.viewEdges = (v, cols, binHz, edges) => {
    const a = fwd(v.fMin, v.log), b = fwd(v.fMax, v.log), d = (b - a) / cols;
    for (let c = 0; c <= cols; c++) edges[c] = inv(a + c * d, v.log) / binHz;
  };
  SA.valueAt = (src, pos) => {
    const last = src.length - 1;
    pos = clamp(pos, 0, last);
    const i = Math.min(last - 1, Math.floor(pos));
    return src[i] + (src[i + 1] - src[i]) * (pos - i);
  };

  /* history grid: G log-spaced points from g0 to g1 Hz */
  SA.histEdges = (H, binHz) => {
    const G = H.grid, r = Math.log(H.g1 / H.g0) / (G - 1);
    for (let j = 0; j <= G; j++) H.edges[j] = (H.g0 * Math.exp((j - 0.5) * r)) / binHz;
  };
  /* for each of cols+1 column edges, index into history grid (or -1 outside) */
  SA.gridIndex = (v, cols, H, out) => {
    const a = fwd(v.fMin, v.log), b = fwd(v.fMax, v.log), d = (b - a) / cols;
    const G = H.grid, k = (G - 1) / Math.log(H.g1 / H.g0);
    for (let c = 0; c <= cols; c++) {
      const f = inv(a + c * d, v.log);
      if (f < H.g0 * 0.9 || f > H.g1 * 1.001) { out[c] = -1; continue; }
      let i = Math.round(Math.log(f / H.g0) * k);
      out[c] = i < 0 ? 0 : i > G - 1 ? G - 1 : i;
    }
  };

  /* ---------- analysis ---------- */
  SA.findPeak = (spec, binHz, fLo, fHi) => {
    const n = spec.length;
    const i0 = Math.max(1, Math.ceil(fLo / binHz)), i1 = Math.min(n - 2, Math.floor(fHi / binHz));
    let bi = -1, bv = -Infinity;
    for (let i = i0; i <= i1; i++) if (spec[i] > bv) { bv = spec[i]; bi = i; }
    if (bi < 0) return { f: 0, db: SA.DB_FLOOR };
    const a = spec[bi - 1], b = spec[bi], c = spec[bi + 1];
    const den = a - 2 * b + c;
    const d = den !== 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
    return { f: (bi + d) * binHz, db: b - 0.25 * (a - c) * d };
  };

  SA.makeBands = (nyq) => {
    const out = [], h = Math.pow(2, 1 / 6);
    for (let k = -17; k <= 13; k++) {
      const fc = 1000 * Math.pow(2, k / 3);
      const lo = fc / h;
      if (lo >= nyq) break;
      out.push({ fc, lo, hi: Math.min(fc * h, nyq) });
    }
    return out;
  };
  /* pw: linear power per bin -> out: dB per band */
  SA.bandLevels = (pw, bands, binHz, out) => {
    const last = pw.length - 1;
    for (let b = 0; b < bands.length; b++) {
      const B = bands[b];
      const i0 = Math.ceil(B.lo / binHz), i1 = Math.min(last, Math.floor(B.hi / binHz));
      let s = 0;
      if (i1 < i0) s = SA.valueAt(pw, B.fc / binHz);
      else for (let i = i0; i <= i1; i++) s += pw[i];
      out[b] = s > 1e-14 ? 10 * Math.log10(s) : SA.DB_FLOOR;
    }
  };

  /* spectral subtraction of a learned noise profile (linear power) */
  SA.OVERSUB = 2.5;
  SA.subtract = (p, noise) => {
    const s = p - SA.OVERSUB * noise;
    return s > 1e-14 ? s : 1e-14;
  };
  SA.resampleNoise = (old, newN) => {
    const oldN = old.length, out = new Float32Array(newN), r = oldN / newN;
    for (let i = 0; i < newN; i++) {
      const p = i * r, j = Math.min(oldN - 2, Math.floor(p)), fr = Math.min(1, p - j);
      out[i] = (old[j] + (old[j + 1] - old[j]) * fr) * r;
    }
    return out;
  };

  /* ---------- colormaps ---------- */
  /* Each map runs from the page ground (first stop, filled in at build time) to its loudest colour. */
  SA.MAPS = {
    aurora: {
      light: [[0, null], [0.2, '#ffe9b0'], [0.4, '#ff9a4a'], [0.6, '#d6336c'], [0.8, '#6a1b9a'], [1, '#150f4d']],
      dark: [[0, null], [0.18, '#1a1260'], [0.4, '#6a1b9a'], [0.6, '#d6336c'], [0.8, '#ff8a3d'], [1, '#fff3b0']],
    },
    viridis: {
      light: [[0, null], [0.2, '#e8e04a'], [0.42, '#5ec962'], [0.62, '#21918c'], [0.82, '#3b528b'], [1, '#440154']],
      dark: [[0, null], [0.15, '#440154'], [0.38, '#3b528b'], [0.6, '#21918c'], [0.8, '#5ec962'], [1, '#fde725']],
    },
    ice: {
      light: [[0, null], [0.25, '#bfeaf2'], [0.5, '#38a8dc'], [0.75, '#0f4fa8'], [1, '#06153d']],
      dark: [[0, null], [0.25, '#0b2a6b'], [0.5, '#1479c9'], [0.75, '#4fd6e8'], [1, '#f2fdff']],
    },
    mono: { light: [[0, null], [1, '#16181a']], dark: [[0, null], [1, '#ecebe7']] },
  };
  const hex = (SA.hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
  SA.buildLut = (name, dark, bg) => {
    const stops = (SA.MAPS[name] || SA.MAPS.aurora)[dark ? 'dark' : 'light'].map((st) => [st[0], st[1] || bg]);
    const lut = new Uint8Array(256 * 4);
    let s = 0;
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
      const [t0, c0] = stops[s], [t1, c1] = stops[s + 1];
      const a = hex(c0), b = hex(c1), k = clamp((t - t0) / (t1 - t0), 0, 1);
      lut[i * 4] = a[0] + (b[0] - a[0]) * k;
      lut[i * 4 + 1] = a[1] + (b[1] - a[1]) * k;
      lut[i * 4 + 2] = a[2] + (b[2] - a[2]) * k;
      lut[i * 4 + 3] = 255;
    }
    return lut;
  };

  /* ---------- tiny mat4 (column-major) ---------- */
  SA.perspective = (fovy, aspect, n, f) => {
    const t = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = t / aspect; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = (2 * f * n) / (n - f);
    return m;
  };
  SA.lookAt = (e, c, up) => {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2];
    let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  };
  SA.mul = (a, b) => {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  };
  SA.project = (m, x, y, z) => {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, w];
  };
})(typeof window !== 'undefined' ? window : globalThis);
