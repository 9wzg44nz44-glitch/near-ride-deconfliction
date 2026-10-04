// Stage 3: map-match each route to cached OSM ways, classify terrain (paved / maintained dirt / Class VI),
// extract posted speed limits and stop/yield/signal controls, and write docs/data/routes.json.
// Usage: node scripts/classify.mjs
import fs from 'node:fs';
import { makeProj } from './lib/geo.mjs';

const root = new URL('../', import.meta.url);
const routes = JSON.parse(fs.readFileSync(new URL('data/routes-geom.json', root), 'utf8'));
const cacheDir = new URL('data/osm-cache/', root);
const proj = makeProj(42.9);
const STEP = 10;          // m between map-matching samples
const MATCH_TOL = 30;     // m, max distance track sample -> way
const MIN_RUN = 80;       // m, shortest terrain run kept after smoothing

// ---------- load OSM ----------
const ways = new Map(), nodes = new Map();
let osmTimestamp = '';
for (const f of fs.readdirSync(cacheDir)) {
  if (!f.endsWith('.json')) continue;
  const t = JSON.parse(fs.readFileSync(new URL(f, cacheDir), 'utf8'));
  if (t.timestamp && t.timestamp > osmTimestamp) osmTimestamp = t.timestamp;
  for (const e of t.elements) {
    if (e.type === 'way') ways.set(e.id, e);
    else if (e.type === 'node') nodes.set(e.id, e);
  }
}
console.log(`OSM: ${ways.size} ways, ${nodes.size} control nodes, snapshot ${osmTimestamp}`);

// ---------- way classification ----------
const PAVED_SURF = new Set(['asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'chipseal', 'bitumen', 'sett', 'cobblestone', 'metal', 'tar']);
const UNPAVED_SURF = new Set(['unpaved', 'dirt', 'gravel', 'fine_gravel', 'compacted', 'ground', 'earth', 'grass', 'mud', 'sand', 'pebblestone', 'rock', 'dirt/sand', 'woodchips', 'clay', 'gravel;dirt', 'dirt;gravel', 'grass_paver']);
const ROUGH_SURF = new Set(['ground', 'earth', 'grass', 'mud', 'sand', 'rock', 'clay', 'woodchips']);
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const MINOR = new Set(['residential', 'living_street', 'unclassified', 'service', 'road']);
const ROUGH_SMOOTH = new Set(['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable']);
const CLASS6_RE = /class\s*(vi|6)\b|unmaintained|jeep\s*trail|legal\s*trail|town\s*trail|\bcart\s*path|\bwoods\s*road|\bsled\s*road|\bold\s+(county|stage)\b.*\b(trail|path)\b/i;

export function parseMaxspeedMph(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kph)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'km/h').toLowerCase();
  return unit === 'mph' ? Math.round(n) : Math.round(n * 0.621371 / 5) * 5;
}

// returns { cls: 0 paved | 1 maintained dirt | 2 Class VI, conf: 3 high | 2 medium | 1 low, why }
export function classifyWay(tags) {
  const hw = tags.highway || '', surf = (tags.surface || '').toLowerCase(), tt = tags.tracktype || '', sm = tags.smoothness || '';
  const text = [tags.name, tags.designation, tags.description, tags.note, tags['surface:note'], tags.alt_name, tags.official_name].filter(Boolean).join(' ');
  const hasMax = !!parseMaxspeedMph(tags.maxspeed);
  if (CLASS6_RE.test(text) || tags.maintenance === 'no' || tags['4wd_only'] === 'yes' || /class_?vi|unmaintained/i.test(tags.designation || '')) return { cls: 2, conf: 3, why: 'tagged Class VI / unmaintained / trail' };
  const grade = tt ? parseInt(tt.replace('grade', ''), 10) : NaN;
  if (hw === 'path' || hw === 'bridleway') return { cls: 2, conf: PAVED_SURF.has(surf) ? 1 : 3, why: `highway=${hw}` };
  if (hw === 'track') {
    if (PAVED_SURF.has(surf)) return { cls: 0, conf: 2, why: 'track tagged paved' };
    if (grade >= 3 || ROUGH_SMOOTH.has(sm) || ROUGH_SURF.has(surf)) return { cls: 2, conf: 3, why: `track ${tt || surf || sm}` };
    if (grade === 1 || grade === 2) return { cls: 1, conf: 2, why: `track grade${grade}` };
    return { cls: 2, conf: 2, why: 'highway=track (no grade)' };
  }
  if (MAJOR.has(hw)) {
    if (UNPAVED_SURF.has(surf)) return { cls: 1, conf: 2, why: `${hw} tagged unpaved` };
    return { cls: 0, conf: PAVED_SURF.has(surf) ? 3 : 2, why: PAVED_SURF.has(surf) ? `${hw} surface=${surf}` : `${hw}, surface untagged` };
  }
  if (MINOR.has(hw)) {
    if (PAVED_SURF.has(surf)) return { cls: 0, conf: 3, why: `${hw} surface=${surf}` };
    if (UNPAVED_SURF.has(surf)) {
      if (ROUGH_SMOOTH.has(sm) || grade >= 3 || ROUGH_SURF.has(surf)) return { cls: 2, conf: 2, why: `${hw} unpaved, rough tags (${surf}/${sm || tt})` };
      if (hasMax || grade <= 2) return { cls: 1, conf: 3, why: `${hw} unpaved with ${hasMax ? 'maxspeed' : 'tracktype ' + tt}` };
      if (hw === 'service') return { cls: 1, conf: 1, why: 'unpaved service road' };
      return tags.name ? { cls: 1, conf: 2, why: `named ${hw}, surface=${surf}` } : { cls: 2, conf: 1, why: `unnamed ${hw}, surface=${surf}` };
    }
    if (hw === 'residential' || hw === 'living_street') return { cls: 0, conf: 2, why: `${hw}, surface untagged` };
    if (hasMax) return { cls: 0, conf: 1, why: `${hw}, surface untagged, maxspeed tagged` };
    return { cls: 0, conf: 1, why: `${hw}, surface untagged (assumed paved)` };
  }
  return { cls: 1, conf: 1, why: `unrecognised highway=${hw}` };
}

// ---------- spatial index of way segments ----------
const wayList = [...ways.values()];
const segs = []; // {w, ax,ay,bx,by}
const GRID = 50;
const grid = new Map();
const wayInfo = wayList.map((w) => ({ id: w.id, tags: w.tags || {}, cl: classifyWay(w.tags || {}), nodes: w.nodes || [] }));
wayList.forEach((w, wi) => {
  const g = w.geometry || [];
  for (let k = 0; k + 1 < g.length; k++) {
    const [ax, ay] = proj(g[k].lat, g[k].lon), [bx, by] = proj(g[k + 1].lat, g[k + 1].lon);
    const si = segs.length;
    segs.push({ wi, k, ax, ay, bx, by });
    const x0 = Math.floor(Math.min(ax, bx) / GRID), x1 = Math.floor(Math.max(ax, bx) / GRID);
    const y0 = Math.floor(Math.min(ay, by) / GRID), y1 = Math.floor(Math.max(ay, by) / GRID);
    for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) {
      const key = gx * 100003 + gy;
      let arr = grid.get(key); if (!arr) grid.set(key, (arr = []));
      arr.push(si);
    }
  }
});
function nearbySegs(x, y, r) {
  const out = new Set();
  const x0 = Math.floor((x - r) / GRID), x1 = Math.floor((x + r) / GRID), y0 = Math.floor((y - r) / GRID), y1 = Math.floor((y + r) / GRID);
  for (let gx = x0; gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) { const a = grid.get(gx * 100003 + gy); if (a) for (const s of a) out.add(s); }
  return out;
}
function segDist(x, y, s) {
  const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((x - s.ax) * dx + (y - s.ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(x - (s.ax + t * dx), y - (s.ay + t * dy)), t, ang: Math.atan2(dy, dx) };
}

// ---------- route helpers ----------
function posAt(r, d) {
  const cum = r.cum; let lo = 0, hi = cum.length - 1;
  d = Math.max(0, Math.min(cum[hi], d));
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
  const t = cum[hi] === cum[lo] ? 0 : (d - cum[lo]) / (cum[hi] - cum[lo]);
  return [r.pts[lo][0] + t * (r.pts[hi][0] - r.pts[lo][0]), r.pts[lo][1] + t * (r.pts[hi][1] - r.pts[lo][1])];
}

const out = [];
const CLS = ['paved', 'maintained dirt', 'Class VI'];
for (const r of routes) {
  const n = Math.ceil(r.lengthM / STEP);
  const samples = [];
  for (let i = 0; i <= n; i++) {
    const d = Math.min(r.lengthM, i * STEP);
    const [la, lo] = posAt(r, d);
    const [x, y] = proj(la, lo);
    const [la0, lo0] = posAt(r, d - 15), [la1, lo1] = posAt(r, d + 15);
    const [x0, y0] = proj(la0, lo0), [x1, y1] = proj(la1, lo1);
    samples.push({ d, x, y, hdg: Math.atan2(y1 - y0, x1 - x0) });
  }
  // map-match with a small continuity bonus for the previous way
  let prevWay = -1;
  const match = samples.map((s) => {
    let best = null, bestScore = Infinity, prevScore = Infinity, prevHit = null;
    for (const si of nearbySegs(s.x, s.y, MATCH_TOL)) {
      const sg = segs[si]; const { d, ang } = segDist(s.x, s.y, sg);
      if (d > MATCH_TOL) continue;
      const hw = wayInfo[sg.wi].tags.highway;
      let dang = Math.abs(((ang - s.hdg + Math.PI * 3) % (Math.PI * 2)) - Math.PI); // 0..pi
      dang = Math.min(dang, Math.PI - dang); // direction-agnostic
      const score = d + 25 * (dang / (Math.PI / 2)) + (hw === 'service' ? 3 : 0);
      if (score < bestScore) { bestScore = score; best = { wi: sg.wi, k: sg.k, d, score }; }
      if (sg.wi === prevWay && score < prevScore) { prevScore = score; prevHit = { wi: sg.wi, k: sg.k, d, score }; }
    }
    if (prevHit && prevScore <= bestScore + 8) best = prevHit;
    if (best) prevWay = best.wi;
    return best;
  });
  const matchedShare = match.filter(Boolean).length / match.length;

  // raw label per sample
  const lab = match.map((m) => (m ? { ...wayInfo[m.wi].cl, wi: m.wi } : null));

  // waypoint hints: 'Jeep Trail' / 'Class VI' / gate / cellar hole waypoints push unpaved-ish ways toward Class VI
  const hints = r.waypoints.filter((w) => w.kinds.includes('classvi-hint') || w.kinds.includes('gate'));
  lab.forEach((l, i) => {
    if (!l || l.cls === 0) return;
    for (const h of hints) if (Math.abs(samples[i].d - h.distAlong) < 250 && h.offTrack < 150 && l.cls === 1) { l.cls = 2; l.conf = Math.min(l.conf, 2); l.why += ' + waypoint hint (' + h.name + ')'; }
  });

  // fill gaps (no matched way): inherit nearest labelled neighbour, low confidence
  let unmatchedM = 0;
  for (let i = 0; i < lab.length; i++) if (!lab[i]) {
    let j = i; while (j < lab.length && !lab[j]) j++;
    const left = i > 0 ? lab[i - 1] : null, right = j < lab.length ? lab[j] : null;
    for (let k = i; k < j; k++) {
      const src = left && right ? (k - i < j - k ? left : right) : left || right;
      lab[k] = { cls: src ? src.cls : 0, conf: 1, why: 'no OSM way within ' + MATCH_TOL + ' m; inherited from neighbour', wi: -1, gap: true };
      unmatchedM += STEP;
    }
    i = j - 1;
  }

  // runs by class, then merge runs shorter than MIN_RUN into neighbour
  let runs = [];
  lab.forEach((l, i) => {
    const last = runs.at(-1);
    if (last && last.cls === l.cls) { last.b = i; last.items.push(l); }
    else runs.push({ cls: l.cls, a: i, b: i, items: [l] });
  });
  const lenOf = (rn) => (rn.b - rn.a + 1) * STEP;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      if (lenOf(runs[i]) >= MIN_RUN || runs.length === 1) continue;
      const L = runs[i - 1], R = runs[i + 1];
      let tgt = L && R ? (lenOf(L) >= lenOf(R) ? L : R) : L || R;
      // a short run bracketed by the same class is always absorbed; otherwise absorb into the longer neighbour
      for (const it of runs[i].items) { it.cls = tgt.cls; it.conf = 1; it.why = 'short stretch smoothed into neighbour'; }
      if (tgt === L) { L.b = runs[i].b; L.items.push(...runs[i].items); } else { R.a = runs[i].a; R.items.unshift(...runs[i].items); }
      runs.splice(i, 1);
      changed = true; break;
    }
    // merge adjacent equal classes created by absorption
    for (let i = 1; i < runs.length; i++) if (runs[i].cls === runs[i - 1].cls) { runs[i - 1].b = runs[i].b; runs[i - 1].items.push(...runs[i].items); runs.splice(i, 1); i--; changed = true; }
  }

  // build terrain segments with details; split runs further where the matched way changes (keeps names/limits)
  const terrain = [];
  for (const rn of runs) {
    let cur = null;
    for (let i = rn.a; i <= rn.b; i++) {
      const l = lab[i];
      const wi = l.wi;
      if (cur && cur.wi === wi) { cur.b = i; cur.confs.push(l.conf); continue; }
      cur = { wi, cls: rn.cls, a: i, b: i, confs: [l.conf], why: l.why };
      terrain.push(cur);
    }
  }
  // merge consecutive pieces with identical class + limit + name to keep the JSON small
  const merged = [];
  for (const t of terrain) {
    const info = t.wi >= 0 ? wayInfo[t.wi] : null;
    const tg = info ? info.tags : {};
    const limit = tg.maxspeed ? parseMaxspeedMph(tg.maxspeed) : null;
    const seg = { a: Math.round(samples[t.a].d), b: Math.round(Math.min(r.lengthM, samples[t.b].d + STEP)), cls: t.cls, conf: Math.min(...t.confs), hw: tg.highway || '', surf: tg.surface || '', name: tg.name || '', limit, why: t.why, wayId: info ? info.id : null };
    const last = merged.at(-1);
    if (last && last.cls === seg.cls && last.limit === seg.limit && last.name === seg.name && last.hw === seg.hw && last.surf === seg.surf) { last.b = seg.b; last.conf = Math.min(last.conf, seg.conf); }
    else merged.push(seg);
  }
  merged[0].a = 0; merged.at(-1).b = Math.round(r.lengthM);
  for (let i = 1; i < merged.length; i++) merged[i].a = merged[i - 1].b;

  // ---------- stop / yield / signal controls ----------
  const nodeWays = new Map(); // node id -> number of highway ways using it
  for (const w of wayInfo) for (const id of w.nodes) nodeWays.set(id, (nodeWays.get(id) || 0) + 1);
  const wayById = new Map(wayInfo.map((w, i) => [w.id, i]));
  const sampleNear = (la, lo, maxd) => {
    const [x, y] = proj(la, lo); let bi = -1, bd = maxd;
    for (let i = 0; i < samples.length; i++) { const d = Math.hypot(samples[i].x - x, samples[i].y - y); if (d < bd) { bd = d; bi = i; } }
    return bi < 0 ? null : { i: bi, d: bd };
  };
  const stops = [];
  const [bx0, by0] = [Math.min(...r.pts.map((p) => p[0])) - 0.001, Math.min(...r.pts.map((p) => p[1])) - 0.001];
  const [bx1, by1] = [Math.max(...r.pts.map((p) => p[0])) + 0.001, Math.max(...r.pts.map((p) => p[1])) + 0.001];
  // coarse prefilter by bbox
  const candidates = [...nodes.values()].filter((nd) => nd.lat >= bx0 && nd.lat <= bx1 && nd.lon >= by0 && nd.lon <= by1);
  // spatial hash of samples for speed
  const sgrid = new Map();
  samples.forEach((s, i) => { const key = Math.floor(s.x / 40) * 100003 + Math.floor(s.y / 40); (sgrid.get(key) || sgrid.set(key, []).get(key)).push(i); });
  const nearSample = (x, y, maxd) => {
    let bi = -1, bd = maxd;
    for (let gx = Math.floor((x - maxd) / 40); gx <= Math.floor((x + maxd) / 40); gx++) for (let gy = Math.floor((y - maxd) / 40); gy <= Math.floor((y + maxd) / 40); gy++) {
      for (const i of sgrid.get(gx * 100003 + gy) || []) { const d = Math.hypot(samples[i].x - x, samples[i].y - y); if (d < bd) { bd = d; bi = i; } }
    }
    return bi < 0 ? null : { i: bi, d: bd };
  };
  for (const nd of candidates) {
    const [x, y] = proj(nd.lat, nd.lon);
    const ns = nearSample(x, y, 15);
    if (!ns) continue;
    const hw = nd.tags?.highway, rail = nd.tags?.railway;
    const kind = hw === 'stop' ? 'stop' : hw === 'give_way' ? 'yield' : hw === 'traffic_signals' ? 'signal' : rail === 'level_crossing' ? 'xing' : null;
    if (!kind) continue;
    const dS = samples[ns.i].d;
    let fwd = true, rev = true, onWay = true;
    if (kind === 'stop' || kind === 'yield') {
      // the sign only binds traffic on the approach way, travelling towards the junction
      let found = false;
      for (let j = Math.max(0, ns.i - 12); j <= Math.min(samples.length - 1, ns.i + 12) && !found; j++) {
        const m = match[j]; if (!m) continue;
        const w = ways.get(wayInfo[m.wi].id); const p = w.nodes.indexOf(nd.id);
        if (p >= 0) {
          found = true;
          const isJ = (idx) => idx >= 0 && idx < w.nodes.length && (nodeWays.get(w.nodes[idx]) || 0) >= 2 || idx === 0 || idx === w.nodes.length - 1;
          const prevJ = p > 0 && isJ(p - 1), nextJ = p < w.nodes.length - 1 && isJ(p + 1);
          const dirTag = nd.tags?.direction;
          let towardNext = null;
          if (dirTag === 'forward') towardNext = true; else if (dirTag === 'backward') towardNext = false;
          else if (nextJ && !prevJ) towardNext = true; else if (prevJ && !nextJ) towardNext = false;
          if (towardNext !== null) {
            // is the route moving along the way's forward direction here?
            const g = w.geometry; const a = proj(g[Math.max(0, p - 1)].lat, g[Math.max(0, p - 1)].lon), b = proj(g[Math.min(g.length - 1, p + 1)].lat, g[Math.min(g.length - 1, p + 1)].lon);
            const wdx = b[0] - a[0], wdy = b[1] - a[1];
            const rdx = Math.cos(samples[ns.i].hdg), rdy = Math.sin(samples[ns.i].hdg);
            const routeAlongForward = wdx * rdx + wdy * rdy >= 0;
            const stopsFwdTravel = routeAlongForward === towardNext;
            fwd = stopsFwdTravel; rev = !stopsFwdTravel;
          }
        }
      }
      onWay = found;
    } else if (kind === 'signal') {
      onWay = true;
    }
    if (!onWay) continue;
    stops.push({ d: Math.round(dS), kind, fwd, rev, off: Math.round(ns.d), osmId: nd.id });
  }
  // Inferred stops: OSM often lacks stop-sign nodes in rural NH. Where the route leaves a lower-rank road for a
  // strictly higher-rank maintained road (e.g. dirt road -> paved tertiary) at a persistent way change, assume a stop
  // for travel in that direction. Flagged inferred=true so the UI can switch these off.
  const RANK = { motorway: 6, trunk: 6, primary: 5, secondary: 4, tertiary: 3, unclassified: 2, residential: 2, living_street: 2, road: 2, service: 1 };
  const rank = (wi) => RANK[wayInfo[wi].tags.highway] ?? 0;
  for (let i = 4; i < samples.length - 4; i++) {
    const A = match[i - 1], B = match[i];
    if (!A || !B || A.wi === B.wi) continue;
    if (![i - 4, i - 3, i - 2].every((k) => match[k] && match[k].wi === A.wi) || ![i + 1, i + 2, i + 3].every((k) => match[k] && match[k].wi === B.wi)) continue;
    const rA = rank(A.wi), rB = rank(B.wi);
    if (rA === rB) continue;
    const hi = rA > rB ? lab[i - 1] : lab[i];
    if (!hi || hi.cls === 2 || Math.max(rA, rB) < 2) continue;
    if (wayInfo[A.wi].tags.name && wayInfo[A.wi].tags.name === wayInfo[B.wi].tags.name) continue; // same road continuing
    const d = Math.round(samples[i].d);
    if (stops.some((q) => Math.abs(q.d - d) < 40)) continue;
    stops.push({ d, kind: 'stop', fwd: rB > rA, rev: rA > rB, off: 0, inferred: true });
  }
  stops.sort((a, b) => a.d - b.d);
  // de-duplicate nodes within 25 m of each other (same junction, same kind)
  const dedup = [];
  for (const s of stops) {
    const p = dedup.find((q) => q.kind === s.kind && Math.abs(q.d - s.d) < 25);
    if (p) { p.fwd = p.fwd || s.fwd; p.rev = p.rev || s.rev; } else dedup.push({ ...s });
  }

  // ---------- stats ----------
  const bySeg = [0, 0, 0], byConf = { 3: 0, 2: 0, 1: 0 }, byClsConf = [{ 3: 0, 2: 0, 1: 0 }, { 3: 0, 2: 0, 1: 0 }, { 3: 0, 2: 0, 1: 0 }];
  for (const s of merged) { bySeg[s.cls] += s.b - s.a; byConf[s.conf] += s.b - s.a; byClsConf[s.cls][s.conf] += s.b - s.a; }
  const tot = bySeg[0] + bySeg[1] + bySeg[2];
  const stats = { lengthMi: +(r.lengthM / 1609.344).toFixed(1), pct: bySeg.map((v) => +(100 * v / tot).toFixed(1)), miles: bySeg.map((v) => +(v / 1609.344).toFixed(1)), confPct: { high: +(100 * byConf[3] / tot).toFixed(1), medium: +(100 * byConf[2] / tot).toFixed(1), low: +(100 * byConf[1] / tot).toFixed(1) }, clsConfPct: byClsConf.map((o) => ({ high: +(100 * o[3] / tot).toFixed(1), medium: +(100 * o[2] / tot).toFixed(1), low: +(100 * o[1] / tot).toFixed(1) })), matchedPct: +(100 * matchedShare).toFixed(1), unmatchedM, limitsTaggedPct: +(100 * merged.filter((s) => s.limit).reduce((a, s) => a + s.b - s.a, 0) / tot).toFixed(1), stops: { stop: dedup.filter((s) => s.kind === 'stop' && !s.inferred).length, inferredStop: dedup.filter((s) => s.inferred).length, yield: dedup.filter((s) => s.kind === 'yield').length, signal: dedup.filter((s) => s.kind === 'signal').length, xing: dedup.filter((s) => s.kind === 'xing').length } };
  console.log(`${r.id}: ${stats.lengthMi} mi | paved ${stats.pct[0]}% dirt ${stats.pct[1]}% classVI ${stats.pct[2]}% | conf H/M/L ${stats.confPct.high}/${stats.confPct.medium}/${stats.confPct.low} | matched ${stats.matchedPct}% | stops ${JSON.stringify(stats.stops)} | segs ${merged.length}`);
  out.push({ id: r.id, name: r.name, color: r.color, sourceFile: r.sourceFile, lengthM: r.lengthM, startEndGapM: r.startEndGapM, rawPoints: r.rawPoints, pts: r.pts.map((p) => [p[0], p[1]]), cum: r.cum, terrain: merged, stops: dedup, waypoints: r.waypoints, stats });
}
fs.mkdirSync(new URL('docs/data/', root), { recursive: true });
fs.writeFileSync(new URL('docs/data/routes.json', root), JSON.stringify({ meta: { built: new Date().toISOString().slice(0, 10), osmSnapshot: osmTimestamp, attribution: 'Map data (c) OpenStreetMap contributors, ODbL 1.0', matchTolM: MATCH_TOL, minRunM: MIN_RUN, classes: CLS }, routes: out }));
console.log('wrote docs/data/routes.json', (fs.statSync(new URL('docs/data/routes.json', root)).size / 1024).toFixed(0), 'KB');
