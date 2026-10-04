// NEAR ride simulator core. Pure ES module: runs in the browser, in a Web Worker and in Node (tests).
// All times are seconds since local (Eastern) midnight. All distances are metres along the route unless noted.
// This is an ESTIMATE. See about.html for the model and its limits.

export const CELL = 10;               // target route cell length (m)
export const MPH = 0.44704;           // m/s per mph
export const CLS_NAMES = ['paved', 'maintained dirt', 'Class VI'];
export const CLS_SHORT = ['Paved', 'Maint. dirt', 'Class VI'];

export const DEFAULT_PARAMS = {
  // posted-limit defaults when OSM has no maxspeed (mph)
  limitPaved: 35, limitDirt: 25,
  // riders run this many mph over posted limits on maintained roads (5-10, Dan: typically 5-10 faster)
  bonusMph: 7.5, fastExtraMph: 2.5, bonusCapMph: 12,
  // Class VI average speeds (mph): intermediate 16, fast 22-25 -> 23.5
  cviInt: 16, cviFast: 23.5,
  // cornering limit (lateral m/s^2) on maintained roads; minimum corner speed (m/s)
  latAccInt: 3.0, latAccFast: 3.6, vCornerMin: 4.5,
  // longitudinal accel / braking (m/s^2)
  accel: 3.0, accelCvi: 2.0, brake: 3.5,
  // column spacing as a TIME gap between riders (s)
  gapSec: 2.0, gapRoughSec: 4.5, gapDepartSec: 2.0, gapSpreadM: 150, gapCloseM: 600, stopGapExtra: 0.5,
  // controls
  useStops: true, useInferredStops: true, useSignals: true, stopDwell: 2.0, signalDelay: 20, yieldCapMps: 6,
  // regroup stops at gas/food waypoints (minutes)
  useWaypointStops: true, gasMin: 15, foodMin: 45,
  // encounter detection
  threshold: 30, mergeGapSec: 90,
  // severity
  sevTerrain: [1, 2, 4], sevRelation: { overtake: 2, opposite: 2, crossing: 1, follow: 1 },
  // Monte Carlo variability
  mcSpeedSigma: 0.06, mcLocalSigma: 0.07, mcStartJitterSec: 120, mcDwellSigma: 0.25,
};

// ------------------------------------------------------------------ helpers
const R_EARTH = 6371008.8;
const KY = (Math.PI / 180) * R_EARTH;
const LAT0 = 42.9;
const KX = KY * Math.cos((LAT0 * Math.PI) / 180);
const projX = (lon) => lon * KX, projY = (lat) => lat * KY;
export const projectLatLon = (lat, lon) => [projX(lon), projY(lat)];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function randn(rng) { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export function fmtClock(sec, withSec = false) {
  let s = Math.round(sec); const day = Math.floor(s / 86400); s -= day * 86400;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')}${withSec ? ':' + String(ss).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}${day ? ' (+1d)' : ''}`;
}
export function fmtDur(sec) {
  sec = Math.round(sec); if (sec < 90) return `${sec} s`;
  const m = Math.round(sec / 60); if (m < 90) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ------------------------------------------------------------------ route geometry (cached, forward direction)
const geomCache = new WeakMap();
export function getGeom(route) {
  let g = geomCache.get(route); if (g) return g;
  const L = route.lengthM;
  const n = Math.max(2, Math.round(L / CELL)), ds = L / n;
  const lat = new Float64Array(n + 1), lon = new Float64Array(n + 1);
  const pts = route.pts, cum = route.cum;
  let k = 0;
  for (let i = 0; i <= n; i++) {
    const d = i * ds;
    while (k < cum.length - 2 && cum[k + 1] < d) k++;
    const span = cum[k + 1] - cum[k]; const t = span > 0 ? Math.min(1, Math.max(0, (d - cum[k]) / span)) : 0;
    lat[i] = pts[k][0] + t * (pts[k + 1][0] - pts[k][0]); lon[i] = pts[k][1] + t * (pts[k + 1][1] - pts[k][1]);
  }
  g = finishGeom(route.id, n, ds, lat, lon);
  geomCache.set(route, g);
  return g;
}
function finishGeom(id, n, ds, lat, lon) {
  const ex = new Float64Array(n + 1), ey = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) { ex[i] = projX(lon[i]); ey[i] = projY(lat[i]); }
  const cx = new Float64Array(n), cy = new Float64Array(n), tx = new Float32Array(n), ty = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cx[i] = (ex[i] + ex[i + 1]) / 2; cy[i] = (ey[i] + ey[i + 1]) / 2;
    const dx = ex[i + 1] - ex[i], dy = ey[i + 1] - ey[i], l = Math.hypot(dx, dy) || 1; tx[i] = dx / l; ty[i] = dy / l;
  }
  // radius of curvature at edges from points +/- W cells away
  const W = 4, Re = new Float32Array(n + 1).fill(1e9);
  for (let i = W; i <= n - W; i++) {
    const ax = ex[i - W], ay = ey[i - W], bx = ex[i], by = ey[i], qx = ex[i + W], qy = ey[i + W];
    const ab = Math.hypot(bx - ax, by - ay), bc = Math.hypot(qx - bx, qy - by), ca = Math.hypot(ax - qx, ay - qy);
    const area2 = Math.abs((bx - ax) * (qy - ay) - (by - ay) * (qx - ax));
    Re[i] = area2 < 1e-6 ? 1e9 : (ab * bc * ca) / (2 * area2);
  }
  const Rc = new Float32Array(n);
  for (let i = 0; i < n; i++) Rc[i] = Math.min(Re[i], Re[i + 1]);
  return { id, n, ds, lat, lon, ex, ey, cx, cy, tx, ty, Rc };
}
function reverseGeom(g, id) {
  const n = g.n, lat = new Float64Array(n + 1), lon = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) { lat[i] = g.lat[n - i]; lon[i] = g.lon[n - i]; }
  return finishGeom(id, n, g.ds, lat, lon);
}

// ------------------------------------------------------------------ waypoint stop defaults
export function defaultWaypointStops(route) {
  // Returns [{idx, d, name, kinds, minutes}] ; minutes = default regroup stop length. Editable in the UI.
  const L = route.lengthM, list = [];
  route.waypoints.forEach((w, idx) => {
    if (w.offTrack > 2000 || w.distAlong < 500 || w.distAlong > L - 500) return;
    if (!(w.kinds.includes('gas') || w.kinds.includes('food'))) return;
    list.push({ idx, d: w.distAlong, name: w.name, kinds: [...w.kinds], minutes: 0, off: w.offTrack });
  });
  // merge entries closer than 600 m (e.g. a 'Food' pin next to a 'Gas' pin)
  const merged = [];
  for (const w of list) {
    const p = merged.at(-1);
    if (p && w.d - p.d < 600 && (p.off > 300) === (w.off > 300)) { p.kinds = [...new Set([...p.kinds, ...w.kinds])]; p.name += ' + ' + w.name; p.merged = true; } else merged.push({ ...w });
  }
  // rule: first stop that has food = lunch (foodMin); every other gas/food stop = short gas stop (gasMin)
  let lunchUsed = false;
  for (const w of merged) {
    if (w.off > 300) w.minutes = 0; // pin is off the track (side trip): optional, default skipped
    else if (!lunchUsed && w.kinds.includes('food')) { w.minutes = -1; lunchUsed = true; } else w.minutes = -2;
  }
  return merged; // -1 => P.foodMin ; -2 => P.gasMin (resolved in resolveWaypointMinutes)
}
export function resolveWaypointMinutes(def, P) { return def.minutes === -1 ? P.foodMin : def.minutes === -2 ? P.gasMin : def.minutes; }

// ------------------------------------------------------------------ path = oriented geometry + terrain + controls
export function applyOverrides(route, overrides) {
  // overrides: [{a,b,cls}] in forward metres; later entries win. Returns per-cell cls/limit/conf arrays (forward)
  const g = getGeom(route), n = g.n, ds = g.ds;
  const cls = new Uint8Array(n), limit = new Float32Array(n), conf = new Uint8Array(n), edited = new Uint8Array(n);
  let si = 0;
  for (let i = 0; i < n; i++) {
    const mid = (i + 0.5) * ds;
    while (si < route.terrain.length - 1 && route.terrain[si].b <= mid) si++;
    const s = route.terrain[si]; cls[i] = s.cls; limit[i] = s.limit || 0; conf[i] = s.conf;
  }
  for (const o of overrides || []) {
    const a = Math.max(0, Math.floor(Math.min(o.a, o.b) / ds)), b = Math.min(n - 1, Math.ceil(Math.max(o.a, o.b) / ds) - 1);
    for (let i = a; i <= b; i++) { cls[i] = o.cls; limit[i] = o.limit || 0; conf[i] = 3; edited[i] = 1; }
  }
  return { cls, limit, conf, edited };
}

export function buildPath(route, { reverse = false, overrides = [], wptMinutes = null } = {}, P = DEFAULT_PARAMS) {
  const g0 = getGeom(route);
  let g = g0;
  if (reverse) { if (!g0._rev) g0._rev = reverseGeom(g0, route.id + '~'); g = g0._rev; }
  const n = g.n, ds = g.ds;
  const t = applyOverrides(route, overrides);
  let cls = t.cls, limit = t.limit, conf = t.conf, edited = t.edited;
  if (reverse) { cls = Uint8Array.from(cls).reverse(); limit = Float32Array.from(limit).reverse(); conf = Uint8Array.from(conf).reverse(); edited = Uint8Array.from(edited).reverse(); }
  const L = route.lengthM;
  const events = []; // control events at edges
  for (const s of route.stops || []) {
    const ok = reverse ? s.rev : s.fwd; if (!ok) continue;
    const e = Math.round((reverse ? L - s.d : s.d) / ds);
    if (e <= 0 || e >= n) continue;
    if (s.kind === 'stop' && s.inferred && !P.useInferredStops) continue;
    if (s.kind === 'stop' && !P.useStops) continue;
    if (s.kind === 'signal' && !P.useSignals) continue;
    if (cls[Math.min(n - 1, e)] === 2 && s.kind !== 'stop') continue;
    events.push({ e, kind: s.kind, inferred: !!s.inferred });
  }
  const wpts = [];
  if (P.useWaypointStops) {
    const defs = defaultWaypointStops(route);
    defs.forEach((w, k) => {
      const min = wptMinutes && wptMinutes[w.idx] != null ? wptMinutes[w.idx] : resolveWaypointMinutes(w, P);
      if (min <= 0) return;
      const e = Math.round((reverse ? L - w.d : w.d) / ds);
      wpts.push({ e, kind: 'wpt', minutes: min, name: w.name, idx: w.idx });
    });
  }
  events.sort((a, b) => a.e - b.e);
  return { key: route.id + (reverse ? '~' : ''), routeId: route.id, route, reverse, g, n, ds, cls, limit, conf, edited, events, wpts, L };
}

// ------------------------------------------------------------------ group simulation
export function makeNoise(rng, n, P) {
  const mult = new Float32Array(n);
  const gf = Math.min(1.25, Math.max(0.75, 1 + P.mcSpeedSigma * randn(rng)));
  let x = 0; const rho = 0.98, sig = P.mcLocalSigma * Math.sqrt(1 - rho * rho);
  for (let i = 0; i < n; i++) { x = rho * x + sig * randn(rng); mult[i] = gf * Math.min(1.3, Math.max(0.7, 1 + x)); }
  return { mult, rng, dwellSigma: P.mcDwellSigma };
}

export function simulateGroup(path, grp, P = DEFAULT_PARAMS, noise = null) {
  const { n, ds } = path, N = Math.max(1, grp.n | 0), N1 = N - 1;
  const fast = grp.skill === 'fast';
  const bonus = Math.min(P.bonusCapMph, P.bonusMph + (fast ? P.fastExtraMph : 0));
  const latAcc = fast ? P.latAccFast : P.latAccInt;
  const vCvi = (fast ? P.cviFast : P.cviInt) * MPH;
  const mult = noise ? noise.mult : null;
  // 1) target speed per cell
  const vcell = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = path.cls[i]; let v;
    if (c === 2) v = vCvi;
    else {
      const lim = path.limit[i] || (c === 0 ? P.limitPaved : P.limitDirt);
      v = (lim + bonus) * MPH;
      const Rr = path.g.Rc[i]; if (Rr < 1e8) v = Math.min(v, Math.max(P.vCornerMin, Math.sqrt(latAcc * Rr)));
    }
    if (mult) v *= mult[i];
    vcell[i] = Math.max(v, 1.5);
  }
  const v = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) v[i] = Math.min(i > 0 ? vcell[i - 1] : 1e9, i < n ? vcell[i] : 1e9);
  // 2) controls at edges
  const dwell = new Float64Array(n + 1), regroup = new Uint8Array(n + 1), gapExtra = new Float32Array(n + 1);
  const jit = (x) => (noise ? x * Math.exp(noise.dwellSigma * randn(noise.rng)) : x);
  for (const ev of path.events) {
    const e = ev.e;
    if (ev.kind === 'stop') { v[e] = 0; dwell[e] = Math.max(dwell[e], jit(P.stopDwell)); gapExtra[e] += P.stopGapExtra; }
    else if (ev.kind === 'signal') { v[e] = 0; const d = noise ? (noise.rng() < 0.5 ? 0 : 10 + noise.rng() * 50) : P.signalDelay; dwell[e] = Math.max(dwell[e], d); gapExtra[e] += 0.3; }
    else { v[e] = Math.min(v[e], P.yieldCapMps); }
  }
  for (const w of path.wpts) { v[w.e] = 0; regroup[w.e] = 1; dwell[w.e] = jit(w.minutes * 60); }
  v[0] = 0; v[n] = 0;
  // 3) forward / backward passes for accel & braking limits
  for (let i = 0; i < n; i++) { const a = path.cls[i] === 2 ? P.accelCvi : P.accel; v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] * v[i] + 2 * a * ds)); }
  for (let i = n - 1; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * P.brake * ds));
  // 4) leader timing + column spread
  const arr = new Float64Array(n + 1), dep = new Float64Array(n + 1), Darr = new Float64Array(n + 1), Ddep = new Float64Array(n + 1);
  let g = P.gapSec;
  arr[0] = 0; Darr[0] = N1 * g;
  for (let i = 0; i <= n; i++) {
    let dd = Darr[i];
    if (regroup[i]) { dep[i] = arr[i] + Darr[i] + dwell[i]; dd = N1 * P.gapDepartSec; g = P.gapDepartSec; }
    else if (dwell[i] > 0) { dep[i] = arr[i] + dwell[i]; g = Math.max(g, 0) + gapExtra[i]; dd = N1 * g; }
    else { dep[i] = arr[i]; }
    Ddep[i] = dd;
    if (i === n) break;
    const sum = v[i] + v[i + 1];
    const dt = sum < 0.6 ? 4 : (2 * ds) / sum;
    arr[i + 1] = dep[i] + dt;
    // time-gap relaxation toward terrain target: spreads quickly on rough ground, closes up slowly
    const tgt = path.cls[i] === 2 ? P.gapRoughSec : P.gapSec;
    g = Ddep[i] / (N1 || 1);
    if (N1 > 0) {
      if (tgt > g) g += (tgt - g) * Math.min(1, ds / P.gapSpreadM); else g -= (g - tgt) * Math.min(1, ds / P.gapCloseM);
    }
    let dnext = N1 * g;
    dnext = Math.max(dnext, Ddep[i] - 0.25 * dt); // the tail cannot close up faster than 25% quicker than the leader
    Darr[i + 1] = dnext; g = N1 ? dnext / N1 : g;
  }
  const endRel = arr[n] + Darr[n];
  const sim = { grp, N, path, n, ds, arr, dep, Darr, Ddep, endRel, t0: grp.t0 || 0, len: Math.ceil(endRel) + 2 };
  sampleSim(sim);
  return sim;
}

export function riderEdge(sim, f, tRel) {
  const { arr, dep, Darr, Ddep, n } = sim;
  if (tRel < arr[0] + f * Darr[0]) return 0;
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] + f * Darr[m] <= tRel) lo = m; else hi = m - 1; }
  const i = lo; if (i >= n) return n;
  const depK = dep[i] + f * Ddep[i];
  if (tRel <= depK) return i;
  const nxt = arr[i + 1] + f * Darr[i + 1];
  const frac = nxt > depK ? (tRel - depK) / (nxt - depK) : 1;
  return i + Math.min(1, Math.max(0, frac));
}
function sampleSim(sim) {
  const len = sim.len; sim.head = new Float32Array(len).fill(NaN); sim.tail = new Float32Array(len).fill(NaN);
  const fin = sim.endRel;
  for (let r = 0; r < len; r++) {
    if (r > fin + 1) break;
    sim.head[r] = riderEdge(sim, 0, r); sim.tail[r] = riderEdge(sim, 1, r);
  }
}
export function simAtTime(sim, t) { const r = Math.round(t - sim.t0); return r < 0 || r >= sim.len ? null : { head: sim.head[r], tail: sim.tail[r] }; }
export function riderPositions(sim, t) {
  const rel = t - sim.t0, N = sim.N, out = [];
  if (rel < 0 || rel > sim.endRel + 1) return out;
  for (let k = 0; k < N; k++) out.push(riderEdge(sim, N > 1 ? k / (N - 1) : 0, rel));
  return out;
}
export function edgeLatLon(path, e) {
  const g = path.g, i = Math.max(0, Math.min(g.n - 1, Math.floor(e))), t = Math.min(1, e - i);
  return [g.lat[i] + t * (g.lat[i + 1] - g.lat[i]), g.lon[i] + t * (g.lon[i + 1] - g.lon[i])];
}
export function shiftSim(sim, t0) { return { ...sim, t0 }; }

// ------------------------------------------------------------------ adjacency between two paths (spatial)
const adjCache = new Map();
export function buildAdjacency(pa, pb, thr) {
  const key = `${pa.key}|${pb.key}|${thr}`;
  const hit = adjCache.get(key); if (hit) return hit;
  const A = pa.g, B = pb.g, nA = A.n;
  const cs = Math.max(thr, 10), grid = new Map();
  for (let j = 0; j < B.n; j++) { const k = Math.floor(B.cx[j] / cs) * 100003 + Math.floor(B.cy[j] / cs); let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(j); }
  const ptr = new Uint32Array(nA + 1), pref = new Uint32Array(nA + 1), lo = [], hi = [];
  const thr2 = thr * thr;
  for (let i = 0; i < nA; i++) {
    ptr[i] = lo.length;
    const gx = Math.floor(A.cx[i] / cs), gy = Math.floor(A.cy[i] / cs); const js = [];
    for (let x = gx - 1; x <= gx + 1; x++) for (let y = gy - 1; y <= gy + 1; y++) {
      const a = grid.get(x * 100003 + y); if (!a) continue;
      for (const j of a) { const dx = A.cx[i] - B.cx[j], dy = A.cy[i] - B.cy[j]; if (dx * dx + dy * dy <= thr2) js.push(j); }
    }
    if (js.length) {
      js.sort((p, q) => p - q);
      let s = js[0], e = js[0];
      for (let k = 1; k < js.length; k++) { if (js[k] <= e + 1) e = js[k]; else { lo.push(s); hi.push(e); s = e = js[k]; } }
      lo.push(s); hi.push(e);
    }
    pref[i + 1] = pref[i] + (lo.length > ptr[i] ? 1 : 0);
  }
  ptr[nA] = lo.length;
  const adj = { ptr, pref, lo: Int32Array.from(lo), hi: Int32Array.from(hi) };
  if (adjCache.size > 60) adjCache.clear();
  adjCache.set(key, adj);
  return adj;
}

// ------------------------------------------------------------------ encounter detection for a pair of sims
const REL_NAMES = { overtake: 'overtaking', follow: 'same direction (following / catching up)', opposite: 'opposite directions (meeting head-on)', crossing: 'crossing / merging' };
export { REL_NAMES };

export function detectPair(A, B, P = DEFAULT_PARAMS, adj = null) {
  const pa = A.path, pb = B.path;
  adj = adj || buildAdjacency(pa, pb, P.threshold);
  const tStart = Math.max(A.t0, B.t0), tEnd = Math.min(A.t0 + A.len - 1, B.t0 + B.len - 1);
  const nA = pa.n - 1, nB = pb.n - 1;
  const samples = [];
  for (let t = Math.ceil(tStart); t <= tEnd; t++) {
    const rA = t - A.t0, rB = t - B.t0;
    const hA = A.head[rA], tA = A.tail[rA], hB = B.head[rB], tB = B.tail[rB];
    if (hA !== hA || hB !== hB) continue;
    const a0 = Math.min(nA, Math.floor(tA)), a1 = Math.min(nA, Math.floor(hA));
    const b0 = Math.min(nB, Math.floor(tB)), b1 = Math.min(nB, Math.floor(hB));
    if (adj.pref[a1 + 1] - adj.pref[a0] === 0) continue;
    let fi = -1, fj = -1, li = -1, lj = -1;
    for (let i = a0; i <= a1; i++) {
      for (let r = adj.ptr[i]; r < adj.ptr[i + 1]; r++) {
        const lo = Math.max(adj.lo[r], b0), hi = Math.min(adj.hi[r], b1);
        if (lo <= hi) { if (fi < 0) { fi = i; fj = lo; } li = i; lj = hi; }
      }
    }
    if (fi >= 0) samples.push({ t, fi, fj, li, lj });
  }
  // group samples into events
  const evs = []; let cur = null;
  for (const s of samples) {
    if (cur && s.t - cur.last.t <= P.mergeGapSec && Math.abs(s.fi - cur.last.fi) < 400) { cur.samples.push(s); cur.last = s; }
    else { cur = { samples: [s], last: s }; evs.push(cur); }
  }
  return evs.map((e) => summarizeEvent(A, B, e.samples, P, adj));
}

function headTime(sim, cell) { return sim.t0 + sim.arr[Math.min(sim.n, Math.max(0, cell))]; }

function summarizeEvent(A, B, S, P, adj) {
  const pa = A.path, pb = B.path;
  // relation & terrain by majority over samples
  const relCount = { same: 0, opposite: 0, crossing: 0 }, clsCount = [0, 0, 0];
  for (const s of S) {
    const dot = pa.g.tx[s.fi] * pb.g.tx[s.fj] + pa.g.ty[s.fi] * pb.g.ty[s.fj];
    relCount[dot > 0.5 ? 'same' : dot < -0.5 ? 'opposite' : 'crossing']++;
    clsCount[Math.max(pa.cls[s.fi], pb.cls[s.fj])]++;
  }
  const relK = Object.entries(relCount).sort((a, b) => b[1] - a[1])[0][0];
  const cls = clsCount.indexOf(Math.max(...clsCount));
  const first = S[0], last = S.at(-1), mid = S[S.length >> 1];
  let rel = relK === 'same' ? 'follow' : relK === 'opposite' ? 'opposite' : 'crossing';
  let aheadStart = null, aheadEnd = null, overtaker = null, behind = null;
  if (relK === 'same') {
    const d0 = headTime(A, first.fi) - headTime(B, first.fj), d1 = headTime(A, last.fi) - headTime(B, last.fj);
    aheadStart = d0 < 0 ? 'A' : 'B'; aheadEnd = d1 < 0 ? 'A' : 'B';
    if (aheadStart !== aheadEnd) { rel = 'overtake'; overtaker = aheadEnd; }
    else behind = aheadStart === 'A' ? 'B' : 'A';
  }
  // riders involved at the mid sample
  const tRel = (sim) => mid.t - sim.t0;
  const posA = riderPositions({ ...A, t0: A.t0 }, mid.t), posB = riderPositions({ ...B, t0: B.t0 }, mid.t);
  const b0 = Math.floor(B.tail[mid.t - B.t0]), b1 = Math.floor(B.head[mid.t - B.t0]);
  const a0 = Math.floor(A.tail[mid.t - A.t0]), a1 = Math.floor(A.head[mid.t - A.t0]);
  const aSet = [], bPieces = [];
  for (let i = Math.max(0, a0); i <= Math.min(pa.n - 1, a1); i++) for (let r = adj.ptr[i]; r < adj.ptr[i + 1]; r++) {
    const lo = Math.max(adj.lo[r], b0), hi = Math.min(adj.hi[r], b1);
    if (lo <= hi) { aSet.push(i); bPieces.push([lo, hi]); }
  }
  const inA = posA.filter((e) => aSet.some((i) => Math.abs(i - e) <= 3)).length;
  const inB = posB.filter((e) => bPieces.some(([lo, hi]) => e >= lo - 3 && e <= hi + 3)).length;
  const duration = last.t - first.t + 1;
  const base = P.sevTerrain[cls] * P.sevRelation[rel] * (1 + 0.1 * (A.N + B.N));
  const level = base < 6 ? 'low' : base < 14 ? 'medium' : 'high';
  const [lat, lon] = edgeLatLon(pa, mid.fi + 0.5);
  return {
    a: A.grp.id, b: B.grp.id, aName: A.grp.name, bName: B.grp.name,
    tStart: first.t, tEnd: last.t, tMid: mid.t, duration, rel, relRaw: relK, terrain: cls, terrainShare: clsCount.map((c) => c / S.length),
    overtaker: overtaker === 'A' ? A.grp.id : overtaker === 'B' ? B.grp.id : null,
    behind: behind === 'A' ? A.grp.id : behind === 'B' ? B.grp.id : null,
    atStop: pa.wpts.some((w) => Math.abs(w.e - mid.fi) <= 40) || pb.wpts.some((w) => Math.abs(w.e - mid.fj) <= 40),
    ridersA: inA, ridersB: inB, nA: A.N, nB: B.N, score: base, level, lat, lon,
    cellA: mid.fi, cellB: mid.fj, distA: mid.fi * pa.ds, distB: mid.fj * pb.ds,
    distAFwd: pa.reverse ? pa.L - mid.fi * pa.ds : mid.fi * pa.ds, distBFwd: pb.reverse ? pb.L - mid.fj * pb.ds : mid.fj * pb.ds,
    routeA: pa.routeId, routeB: pb.routeId, dirA: pa.reverse ? 'reverse' : 'forward', dirB: pb.reverse ? 'reverse' : 'forward',
  };
}

export function describeEvent(ev) {
  const T = CLS_NAMES[ev.terrain];
  let what;
  if (ev.rel === 'overtake') { const o = ev.overtaker === ev.a ? ev.aName : ev.bName, v = ev.overtaker === ev.a ? ev.bName : ev.aName; what = `${o} overtaking ${v}, same direction`; }
  else if (ev.rel === 'follow') { const f = ev.behind === ev.a ? ev.aName : ev.bName, l = ev.behind === ev.a ? ev.bName : ev.aName; what = `${f} catching up to / following ${l}, same direction`; }
  else if (ev.rel === 'opposite') what = `${ev.aName} and ${ev.bName} meeting head-on, opposite directions`;
  else what = `${ev.aName} and ${ev.bName} crossing / merging`;
  return `${what}${ev.atStop ? ' (at a gas/food regroup stop)' : ''}, ${T}, ${fmtClock(ev.tStart)}`;
}

// ------------------------------------------------------------------ scenario runner
export function makeContext(routes) { return { routes, byId: new Map(routes.map((r) => [r.id, r])) }; }

export function simulateScenario(ctx, scenario, noiseSeed = null) {
  const P = { ...DEFAULT_PARAMS, ...(scenario.params || {}) };
  const sims = [];
  const rng = noiseSeed == null ? null : mulberry32(noiseSeed);
  for (const grp of scenario.groups) {
    if (!grp.n || grp.n < 1) continue;
    const route = ctx.byId.get(grp.routeId); if (!route) continue;
    const path = buildPath(route, { reverse: !!grp.reverse, overrides: scenario.overrides?.[grp.routeId] || [], wptMinutes: scenario.wptMinutes?.[grp.routeId] || null }, P);
    let g = grp;
    if (rng && P.mcStartJitterSec) g = { ...grp, t0: grp.t0 + Math.round(P.mcStartJitterSec * randn(rng) * 0.5) };
    const noise = rng ? makeNoise(rng, path.n, P) : null;
    sims.push(simulateGroup(path, g, P, noise));
  }
  return { sims, P };
}

export function findEvents(sims, P) {
  const out = [];
  for (let i = 0; i < sims.length; i++) for (let j = i + 1; j < sims.length; j++) out.push(...detectPair(sims[i], sims[j], P));
  out.sort((x, y) => x.tStart - y.tStart);
  return out;
}

export function runScenario(ctx, scenario, noiseSeed = null) {
  const { sims, P } = simulateScenario(ctx, scenario, noiseSeed);
  return { sims, P, events: findEvents(sims, P) };
}

// "Is group X overtaking group Y on <terrain> between h1 and h2?"
export function answerQuestion(events, q) {
  const { x, y, terrain, from, to } = q;
  const rel = events.filter((e) => ((e.a === x && e.b === y) || (e.a === y && e.b === x)) && e.tEnd >= from && e.tStart <= to);
  const hits = rel.filter((e) => e.rel === 'overtake' && e.overtaker === x && e.terrain === terrain);
  const otherOvertakes = rel.filter((e) => e.rel === 'overtake' && e.overtaker === x && e.terrain !== terrain);
  const reverseOvertakes = rel.filter((e) => e.rel === 'overtake' && e.overtaker === y);
  return { hits, otherOvertakes, reverseOvertakes, related: rel, yes: hits.length > 0 };
}

// ------------------------------------------------------------------ Monte Carlo forecast
export function monteCarlo(ctx, scenario, runs = 60, seed = 12345, onProgress = null) {
  const nominal = runScenario(ctx, scenario).events;
  const all = [];
  for (let r = 0; r < runs; r++) {
    const ev = runScenario(ctx, scenario, seed + r * 7919).events;
    ev.forEach((e) => all.push({ ...e, run: r }));
    if (onProgress && r % 5 === 0) onProgress((r + 1) / runs);
  }
  // cluster by pair + location bin (3 km, or 8 km for overtakes whose place moves with speed, along group A's route) ; nominal events seed the clusters
  const clusters = [];
  const key = (e) => [e.a, e.b].sort().join('|');
  const near = (c, e) => c.key === key(e) && c.routeA === e.routeA && Math.abs(c.cellA - e.cellA) < (e.rel === 'overtake' || e.rel === 'follow' ? 800 : 300) && c.dirA === e.dirA;
  for (const e of nominal) clusters.push({ key: key(e), routeA: e.routeA, dirA: e.dirA, cellA: e.cellA, nominal: e, members: [] });
  for (const e of all) {
    let c = clusters.find((q) => near(q, e));
    if (!c) { c = { key: key(e), routeA: e.routeA, dirA: e.dirA, cellA: e.cellA, nominal: null, members: [] }; clusters.push(c); }
    c.members.push(e);
    if (!c.nominal) c.cellA = c.members.reduce((a, m) => a + m.cellA, 0) / c.members.length;
  }
  const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const res = clusters.map((c) => {
    const runsHit = new Set(c.members.map((m) => m.run)).size;
    const rep = c.nominal || c.members[0];
    const ts = c.members.map((m) => m.tStart);
    const terr = [0, 0, 0]; const rels = {};
    c.members.forEach((m) => { terr[m.terrain]++; rels[m.rel] = (rels[m.rel] || 0) + 1; });
    const relMode = Object.entries(rels).sort((a, b) => b[1] - a[1])[0]?.[0] || rep.rel;
    return {
      a: rep.a, b: rep.b, aName: rep.aName, bName: rep.bName, nominal: !!c.nominal, prob: runsHit / runs,
      tP10: ts.length ? pct(ts, 0.1) : rep.tStart, tP50: ts.length ? pct(ts, 0.5) : rep.tStart, tP90: ts.length ? pct(ts, 0.9) : rep.tStart,
      terrain: terr.indexOf(Math.max(...terr)) , rel: c.members.length ? relMode : rep.rel, lat: rep.lat, lon: rep.lon,
      score: rep.score, level: rep.level, overtaker: rep.overtaker, behind: rep.behind, distAFwd: rep.distAFwd, distBFwd: rep.distBFwd, routeA: rep.routeA, routeB: rep.routeB, aName_: rep.aName, nA: rep.nA, nB: rep.nB,
      medianDur: c.members.length ? pct(c.members.map((m) => m.duration), 0.5) : rep.duration,
    };
  }).filter((c) => c.prob >= 0.1 || c.nominal).sort((x, y) => x.tP50 - y.tP50);
  return { runs, clusters: res, nominalCount: nominal.length };
}

// ------------------------------------------------------------------ start-time optimiser
export function optimize(ctx, scenario, lockedIds = [], opts = {}) {
  const P = { ...DEFAULT_PARAMS, ...(scenario.params || {}) };
  const groups = scenario.groups.filter((g) => g.n >= 1);
  const lockedSet = new Set(lockedIds);
  const T_MIN = opts.tMin ?? 7 * 3600, T_MAX = opts.tMax ?? 15 * 3600, STEP = opts.step ?? 300;
  const nSlots = Math.floor((T_MAX - T_MIN) / STEP) + 1;
  // simulate each group once (start 0); pair costs depend only on the start-time difference
  const sims = groups.map((g) => simulateScenario(ctx, { ...scenario, groups: [{ ...g, t0: 0 }] }).sims[0]);
  const G = groups.length;
  const kMin = -(nSlots - 1), kMax = nSlots - 1;
  const table = new Map();
  const costDelta = (i, j) => { // cost of group j starting k*STEP after group i
    const key = i + '|' + j; let t = table.get(key); if (t) return t;
    t = new Float64Array(kMax - kMin + 1);
    const adj = buildAdjacency(sims[i].path, sims[j].path, P.threshold);
    for (let k = kMin; k <= kMax; k++) {
      const evs = detectPair(shiftSim(sims[i], 0), shiftSim(sims[j], k * STEP), P, adj);
      let c = 0; for (const e of evs) c += e.score * (1 + Math.min(e.duration, 600) / 600 * 0.25);
      t[k - kMin] = c;
    }
    // robustness: a stagger only counts as good if every start difference within +/-15 min is also good
    const W = opts.robustSlots ?? 3, sm = new Float64Array(t.length);
    for (let k = 0; k < t.length; k++) { let m = 0; for (let q = Math.max(0, k - W); q <= Math.min(t.length - 1, k + W); q++) m = Math.max(m, t[q]); sm[k] = m; }
    t = sm; table.set(key, t); return t;
  };
  const free = [], fixedSlots = new Array(G).fill(null);
  groups.forEach((g, i) => { if (lockedSet.has(g.id)) fixedSlots[i] = Math.round((g.t0 - T_MIN) / STEP); else free.push(i); });
  const pairCost = (slots) => {
    let c = 0;
    for (let i = 0; i < G; i++) for (let j = i + 1; j < G; j++) c += costDelta(i, j)[slots[j] - slots[i] - kMin];
    return c;
  };
  const orig = groups.map((g) => Math.round((g.t0 - T_MIN) / STEP));
  const spreadOf = (slots) => (Math.max(...slots) - Math.min(...slots)) * STEP;
  const shiftOf = (slots) => slots.reduce((a, s, i) => a + Math.abs(s - orig[i]) * STEP, 0);
  // precompute all tables up front
  for (let i = 0; i < G; i++) for (let j = i + 1; j < G; j++) costDelta(i, j);
  const cands = [];
  const slots = fixedSlots.map((s, i) => (s == null ? 0 : s));
  const push = () => cands.push({ slots: slots.slice(), cost: pairCost(slots) });
  if (free.length === 0) push();
  else if (free.length <= 3) {
    const rec = (d) => {
      if (d === free.length) { push(); if (cands.length > 8000) trim(); return; }
      for (let s = 0; s < nSlots; s++) { slots[free[d]] = s; rec(d + 1); }
    };
    const trim = () => { cands.sort((a, b) => a.cost - b.cost || spreadOf(a.slots) - spreadOf(b.slots)); cands.length = 3000; };
    rec(0); trim();
  } else {
    const rng = mulberry32(99);
    for (let r = 0; r < 40; r++) {
      free.forEach((i) => (slots[i] = Math.floor(rng() * nSlots)));
      for (let it = 0; it < 6; it++) {
        let improved = false;
        for (const i of free) {
          let best = slots[i], bc = pairCost(slots);
          for (let s = 0; s < nSlots; s++) { slots[i] = s; const c = pairCost(slots); if (c < bc - 1e-9) { bc = c; best = s; improved = true; } }
          slots[i] = best;
        }
        if (!improved) break;
      }
      push();
    }
  }
  const origCost = pairCost(orig);
  cands.sort((a, b) => a.cost - b.cost || spreadOf(a.slots) - spreadOf(b.slots) || shiftOf(a.slots) - shiftOf(b.slots));
  const best = cands[0].cost;
  const picks = [];
  const different = (a, b) => a.slots.some((s, i) => Math.abs(s - b.slots[i]) * STEP >= 900);
  // prefer low cost, then compact, then small change; keep schedules at least 15 min apart in some group
  const pool = cands.filter((c) => c.cost <= best + 1e-9).sort((a, b) => spreadOf(a.slots) - spreadOf(b.slots) || shiftOf(a.slots) - shiftOf(b.slots));
  const ordered = [...pool, ...cands.filter((c) => c.cost > best + 1e-9)];
  const sig = (c) => c.slots.map((s, i) => i).sort((a, b) => c.slots[a] - c.slots[b] || a - b).join(',');
  // first: best compact schedule; second: best schedule with a different departure ORDER (e.g. other group goes first); then fill with schedules >= 30 min apart
  for (const c of ordered) { if (!picks.length) { picks.push(c); break; } }
  for (const c of ordered) { if (picks.length < 2 && c.cost <= best + 1e-9 && sig(c) !== sig(picks[0]) && different(picks[0], c)) picks.push(c); }
  for (const c of ordered) { if (picks.length >= 3) break; if (picks.every((p) => p.slots.some((s, i) => Math.abs(s - c.slots[i]) * STEP >= 1800))) picks.push(c); }
  const describe = (slotsArr) => {
    const gs = groups.map((g, i) => ({ ...g, t0: T_MIN + slotsArr[i] * STEP }));
    const r = runScenario(ctx, { ...scenario, groups: gs });
    return { groups: gs.map((g) => ({ id: g.id, name: g.name, t0: g.t0, n: g.n })), events: r.events, count: r.events.length, score: r.events.reduce((a, e) => a + e.score, 0), classViOvertakes: r.events.filter((e) => e.rel === 'overtake' && e.terrain === 2).length, headOn: r.events.filter((e) => e.rel === 'opposite').length };
  };
  const before = describe(orig);
  const after = picks.map((p) => ({ ...describe(p.slots), modelCost: p.cost, spreadSec: spreadOf(p.slots), shiftSec: shiftOf(p.slots) }));
  // for the first free group vs the first other group: smallest stagger that reaches the best cost
  let minStagger = null;
  if (G >= 2) {
    const t = costDelta(0, 1); let bestAbs = null; const bestPair = Math.min(...t);
    for (let k = kMin; k <= kMax; k++) if (t[k - kMin] <= bestPair + 1e-9 && (bestAbs == null || Math.abs(k) < Math.abs(bestAbs))) bestAbs = k;
    const curve = []; for (let k = kMin; k <= kMax; k++) curve.push([k * STEP, t[k - kMin]]);
    minStagger = { pair: [groups[0].id, groups[1].id], names: [groups[0].name, groups[1].name], deltaSec: bestAbs == null ? null : bestAbs * STEP, curve };
  }
  return { before, beforeCost: origCost, after, bestCost: best, minStagger, step: STEP, window: [T_MIN, T_MAX], robustMarginSec: (opts.robustSlots ?? 3) * STEP };
}

// ------------------------------------------------------------------ leader briefing text
export function briefingMarkdown(scenario, events, forecast, ctx) {
  const P = { ...DEFAULT_PARAMS, ...(scenario.params || {}) };
  const lines = [];
  lines.push('# NEAR leader briefing (estimate)');
  lines.push('');
  lines.push('Generated by the NEAR Route & Start Time Deconfliction Estimator. Estimates only; not safety critical.');
  lines.push('');
  lines.push('## Groups');
  for (const g of scenario.groups.filter((g) => g.n >= 1)) lines.push(`- ${g.name}: ${g.n} rider${g.n > 1 ? 's' : ''}, ${g.skill || 'intermediate'}, departs ${fmtClock(g.t0)}${g.reverse ? ' (route reversed)' : ''}`);
  lines.push('');
  lines.push(`Encounter distance threshold: ${P.threshold} m. Times are local Eastern clock times.`);
  lines.push('');
  lines.push('## Predicted encounters (single deterministic run)');
  if (!events.length) lines.push('None predicted.');
  for (const e of events) lines.push(`- ${fmtClock(e.tStart)} to ${fmtClock(e.tEnd)} (${fmtDur(e.duration)}): ${describeEvent(e)}. Severity ${e.level}. ${e.ridersA}/${e.nA} and ${e.ridersB}/${e.nB} riders involved. Near ${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}.`);
  if (forecast) {
    lines.push('');
    lines.push(`## Monte Carlo forecast (${forecast.runs} runs, speed and stop-time variation)`);
    for (const c of forecast.clusters) lines.push(`- ${Math.round(c.prob * 100)}% chance: ${c.aName} / ${c.bName}, ${c.rel}, ${CLS_NAMES[c.terrain]}, around ${fmtClock(c.tP50)} (10th to 90th percentile ${fmtClock(c.tP10)} to ${fmtClock(c.tP90)}), near ${c.lat.toFixed(4)}, ${c.lon.toFixed(4)}.`);
  }
  lines.push('');
  lines.push('Obey posted limits and stop signs. Class VI roads are used at your own risk; verify legality and seasonal closures.');
  return lines.join('\n');
}
