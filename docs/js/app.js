import * as S from './sim.js';
import { parseGpxToRoute } from './gpx.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const MI = 1609.344;
const T_MIN = 7 * 3600, T_MAX = 15 * 3600;
const TERR_COL = ['#6b7a90', '#c8892b', '#c2185b'];
const PALETTE = ['#e6194b', '#4363d8', '#3cb44b', '#f58231', '#911eb4', '#008080', '#9a6324', '#800000'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------------------------------------------------------------- settings definition
const SETTINGS = [
  { key: 'threshold', label: 'Encounter distance threshold', unit: 'm', min: 15, max: 100, step: 5 },
  { key: 'bonusMph', label: 'Speed over posted limit on maintained roads', unit: 'mph', min: 5, max: 10, step: 0.5, hint: 'Dan: riders typically run 5 to 10 mph over. Fast riders add 2.5 mph.' },
  { key: 'cviInt', label: 'Class VI average, intermediate', unit: 'mph', min: 8, max: 24, step: 0.5 },
  { key: 'cviFast', label: 'Class VI average, fast', unit: 'mph', min: 18, max: 30, step: 0.5, hint: 'Fast riders do 22 to 25 mph.' },
  { key: 'limitPaved', label: 'Default paved limit (no OSM maxspeed)', unit: 'mph', min: 20, max: 55, step: 5 },
  { key: 'limitDirt', label: 'Default maintained dirt limit', unit: 'mph', min: 10, max: 40, step: 5 },
  { key: 'gapSec', label: 'Rider spacing, paved and maintained dirt', unit: 's', min: 1, max: 5, step: 0.5 },
  { key: 'gapRoughSec', label: 'Rider spacing on Class VI', unit: 's', min: 2, max: 9, step: 0.5 },
  { key: 'accel', label: 'Acceleration', unit: 'm/s2', min: 1.5, max: 5, step: 0.25 },
  { key: 'brake', label: 'Braking', unit: 'm/s2', min: 2, max: 6, step: 0.25 },
  { key: 'stopDwell', label: 'Pause at each stop sign (leader)', unit: 's', min: 0, max: 10, step: 0.5 },
  { key: 'signalDelay', label: 'Expected wait at a traffic signal', unit: 's', min: 0, max: 90, step: 5 },
  { key: 'gasMin', label: 'Short gas stop', unit: 'min', min: 0, max: 60, step: 5 },
  { key: 'foodMin', label: 'Lunch / food stop', unit: 'min', min: 0, max: 120, step: 5 },
];
const TOGGLES = [
  { key: 'useStops', label: 'Stop at mapped stop signs' },
  { key: 'useInferredStops', label: 'Stop at inferred junctions (minor road onto a bigger road)' },
  { key: 'useSignals', label: 'Wait at traffic signals' },
  { key: 'useWaypointStops', label: 'Regroup at gas / food waypoints' },
];

// ---------------------------------------------------------------- state
const state = {
  routes: [], ctx: null, rows: {}, obs: { on: false, routeId: 'sbh', t0: 9 * 3600 + 45 * 60, reverse: false, skill: 'intermediate' },
  params: {}, overrides: {}, wptMinutes: {}, res: 60, custom: [],
  sims: [], events: [], P: S.DEFAULT_PARAMS, t: 9 * 3600, playing: false, forecast: null, tMin: T_MIN, tMax: 18 * 3600,
};
const timeStr = (s, withSec) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}${withSec || ss ? ':' + String(ss).padStart(2, '0') : ''}`; };
const parseTime = (v) => { if (!v) return null; const p = v.split(':').map(Number); return p[0] * 3600 + (p[1] || 0) * 60 + (p[2] || 0); };

function defaultRows() {
  const rows = {};
  for (const r of state.routes) rows[r.id] = { n: 0, t0: 9 * 3600, skill: 'intermediate', reverse: false };
  if (rows.sbh) { rows.sbh.n = 18; rows.sbh.t0 = 9 * 3600; }
  if (rows.mbh) { rows.mbh.n = 7; rows.mbh.t0 = 9.5 * 3600; }
  return rows;
}
function saveState() {
  try {
    localStorage.setItem('near.state.v1', JSON.stringify({ rows: state.rows, obs: state.obs, params: state.params, overrides: state.overrides, wptMinutes: state.wptMinutes, res: state.res }));
    const diff = {}; for (const k of Object.keys(state.params)) if (state.params[k] !== S.DEFAULT_PARAMS[k]) diff[k] = state.params[k];
    const rows = {}; for (const [id, r] of Object.entries(state.rows)) rows[id] = [r.n, r.t0, r.skill === 'fast' ? 1 : 0, r.reverse ? 1 : 0];
    const hash = btoa(unescape(encodeURIComponent(JSON.stringify({ r: rows, o: state.obs.on ? state.obs : 0, p: diff }))));
    history.replaceState(null, '', '#s=' + hash);
  } catch (e) { /* storage may be unavailable */ }
}
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem('near.state.v1') || 'null');
    if (saved) { Object.assign(state, { obs: { ...state.obs, ...saved.obs }, params: saved.params || {}, overrides: saved.overrides || {}, wptMinutes: saved.wptMinutes || {}, res: saved.res || 60 }); for (const [id, r] of Object.entries(saved.rows || {})) if (state.rows[id]) Object.assign(state.rows[id], r); }
  } catch (e) {}
  try {
    const m = location.hash.match(/^#s=(.+)$/);
    if (m) {
      const h = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
      for (const [id, a] of Object.entries(h.r || {})) if (state.rows[id]) state.rows[id] = { n: a[0], t0: a[1], skill: a[2] ? 'fast' : 'intermediate', reverse: !!a[3] };
      if (h.o) state.obs = { ...state.obs, ...h.o, on: true };
      if (h.p) state.params = { ...state.params, ...h.p };
    }
  } catch (e) {}
}

// ---------------------------------------------------------------- scenario
function routeById(id) { return state.routes.find((r) => r.id === id); }
function buildScenario() {
  const groups = [];
  for (const r of state.routes) {
    const row = state.rows[r.id]; if (!row || !(row.n > 0)) continue;
    groups.push({ id: r.id, routeId: r.id, name: r.name, n: row.n, skill: row.skill, t0: row.t0, reverse: row.reverse, color: r.color });
  }
  if (state.obs.on && routeById(state.obs.routeId)) groups.push({ id: 'obs', routeId: state.obs.routeId, name: 'Dan (observer)', n: 1, skill: state.obs.skill, t0: state.obs.t0, reverse: state.obs.reverse, color: '#f5c400', observer: true });
  return { groups, params: { ...state.params }, overrides: state.overrides, wptMinutes: state.wptMinutes };
}

// ---------------------------------------------------------------- rows UI
function renderRows() {
  const tb = $('#rows tbody'); tb.innerHTML = '';
  const step = state.res;
  for (const r of state.routes) {
    const row = state.rows[r.id];
    const tr = document.createElement('tr'); tr.dataset.route = r.id; if (!(row.n > 0)) tr.className = 'row-off';
    tr.innerHTML = `<th scope="row" style="text-transform:none;font-size:1rem;color:inherit"><span class="swatch" style="background:${r.color}"></span>${esc(r.name)}<div class="small muted">${r.stats.lengthMi} mi${r.custom ? ' (imported)' : ''}</div></th>
      <td><input type="number" min="0" max="60" step="1" value="${row.n}" aria-label="Riders on ${esc(r.name)}" data-f="n"></td>
      <td><input type="time" min="07:00" max="15:00" step="${step}" value="${timeStr(row.t0, step < 60)}" aria-label="Departure time for ${esc(r.name)}, Eastern" data-f="t0"></td>
      <td><select data-f="skill" aria-label="Skill level for ${esc(r.name)}"><option value="intermediate"${row.skill === 'intermediate' ? ' selected' : ''}>Intermediate</option><option value="fast"${row.skill === 'fast' ? ' selected' : ''}>Fast</option></select></td>
      <td><select data-f="reverse" aria-label="Direction for ${esc(r.name)}"><option value="0">Forward</option><option value="1"${row.reverse ? ' selected' : ''}>Reversed</option></select></td>`;
    tb.appendChild(tr);
  }
  const o = state.obs;
  const tr = document.createElement('tr'); tr.dataset.route = '__obs'; if (!o.on) tr.className = 'row-off';
  tr.innerHTML = `<th scope="row" style="text-transform:none;font-size:1rem;color:inherit"><label><input type="checkbox" data-f="on"${o.on ? ' checked' : ''}> <span class="swatch" style="background:#f5c400"></span>Observer rider (Dan, solo)</label><div class="small muted">Optional single rider on any route</div></th>
    <td><select data-f="routeId" aria-label="Observer route">${state.routes.map((r) => `<option value="${r.id}"${o.routeId === r.id ? ' selected' : ''}>${esc(r.name)}</option>`).join('')}</select></td>
    <td><input type="time" min="07:00" max="15:00" step="${step}" value="${timeStr(o.t0, step < 60)}" aria-label="Observer departure time, Eastern" data-f="t0"></td>
    <td><select data-f="skill" aria-label="Observer skill"><option value="intermediate"${o.skill === 'intermediate' ? ' selected' : ''}>Intermediate</option><option value="fast"${o.skill === 'fast' ? ' selected' : ''}>Fast</option></select></td>
    <td><select data-f="reverse" aria-label="Observer direction"><option value="0">Forward</option><option value="1"${o.reverse ? ' selected' : ''}>Reversed</option></select></td>`;
  tb.appendChild(tr);
  $('#res').value = String(state.res);
}
function onRowChange(e) {
  const el = e.target, tr = el.closest('tr'); if (!tr || !el.dataset.f) return;
  const id = tr.dataset.route, f = el.dataset.f;
  if (id === '__obs') {
    if (f === 'on') state.obs.on = el.checked;
    else if (f === 't0') state.obs.t0 = clamp(parseTime(el.value) ?? state.obs.t0, T_MIN, T_MAX);
    else if (f === 'reverse') state.obs.reverse = el.value === '1';
    else state.obs[f] = el.value;
    tr.classList.toggle('row-off', !state.obs.on);
  } else {
    const row = state.rows[id];
    if (f === 'n') row.n = clamp(Math.round(+el.value || 0), 0, 60);
    else if (f === 't0') row.t0 = clamp(parseTime(el.value) ?? row.t0, T_MIN, T_MAX);
    else if (f === 'reverse') row.reverse = el.value === '1';
    else row[f] = el.value;
    tr.classList.toggle('row-off', !(row.n > 0));
  }
  if (f === 't0' && el.value) { const v = clamp(parseTime(el.value), T_MIN, T_MAX); el.value = timeStr(v, state.res < 60); }
  scheduleRun();
}

// ---------------------------------------------------------------- run
let runTimer = null;
function scheduleRun() { clearTimeout(runTimer); runTimer = setTimeout(runNow, 120); saveState(); }
function runNow() {
  const sc = buildScenario();
  const t0 = performance.now();
  const res = S.runScenario(state.ctx, sc);
  state.sims = res.sims; state.events = res.events; state.P = res.P; state.forecast = null;
  const ms = Math.round(performance.now() - t0);
  if (state.sims.length) {
    state.tMin = Math.max(T_MIN - 600, Math.floor(Math.min(...state.sims.map((s) => s.t0)) / 60) * 60 - 300);
    state.tMax = Math.min(86399, Math.ceil(Math.max(...state.sims.map((s) => s.t0 + s.endRel)) / 60) * 60 + 60);
  }
  $('#status').textContent = `Simulated ${state.sims.length} group${state.sims.length === 1 ? '' : 's'} in ${ms} ms.`;
  const sl = $('#slider'); sl.min = state.tMin; sl.max = state.tMax;
  state.t = clamp(state.t, state.tMin, state.tMax);
  renderAfterRun();
}
function renderAfterRun() {
  drawRoutes(); drawEvents(); rebuildDots(); renderLegend(); renderEventsTable(); renderTicks(); renderQuestion(); renderOptLocks(); renderBriefingText(); renderForecast(); updateFrame(true); renderTerrainSummary();
}

// ---------------------------------------------------------------- map
let map, rendererCanvas;
const L_ = window.L;
const layers = {};
function initMap() {
  rendererCanvas = L_.canvas({ padding: 0.4 });
  map = L_.map('map', { preferCanvas: true, zoomControl: true, attributionControl: true }).setView([42.85, -72.05], 10);
  L_.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(map);
  for (const k of ['terrain', 'lines', 'conf', 'wp', 'sel', 'ev', 'dots', 'pulse']) layers[k] = L_.layerGroup().addTo(map);
  map.on('click', onMapClick);
}
function shownRoutes() {
  const ids = new Set(state.sims.map((s) => s.grp.routeId));
  return $('#show-all').checked ? state.routes : state.routes.filter((r) => ids.has(r.id));
}
function drawRoutes() {
  ['terrain', 'lines', 'conf', 'wp'].forEach((k) => layers[k].clearLayers());
  const routes = shownRoutes(); const bounds = [];
  routes.forEach((r, ri) => {
    const g = S.getGeom(r), t = S.applyOverrides(r, state.overrides[r.id]);
    const used = state.sims.some((s) => s.grp.routeId === r.id);
    // terrain underlay
    let i0 = 0;
    for (let i = 1; i <= g.n; i++) {
      if (i === g.n || t.cls[i] !== t.cls[i0]) {
        const pts = []; for (let k = i0; k <= i; k += 2) pts.push([g.lat[k], g.lon[k]]); if ((i - i0) % 2) pts.push([g.lat[i], g.lon[i]]);
        L_.polyline(pts, { color: TERR_COL[t.cls[i0]], weight: used ? 9 : 5, opacity: used ? 0.55 : 0.3, dashArray: t.cls[i0] === 2 ? '3 7' : null, lineCap: 'butt', renderer: rendererCanvas, interactive: false }).addTo(layers.terrain);
        i0 = i;
      }
    }
    L_.polyline(r.pts.map((p) => [p[0], p[1]]), { color: r.color, weight: used ? 4 - ri * 1.2 : 2, opacity: used ? 0.95 : 0.5, renderer: rendererCanvas, interactive: false }).addTo(layers.lines);
    r.pts.forEach((p) => bounds.push([p[0], p[1]]));
    if ($('#show-low').checked) {
      let j0 = -1;
      for (let i = 0; i <= g.n; i++) {
        const low = i < g.n && t.conf[i] === 1 && !t.edited[i];
        if (low && j0 < 0) j0 = i;
        if (!low && j0 >= 0) { const pts = []; for (let k = j0; k <= i; k += 2) pts.push([g.lat[k], g.lon[k]]); L_.polyline(pts, { color: '#ffd400', weight: 3, dashArray: '2 6', renderer: rendererCanvas, interactive: false }).addTo(layers.conf); j0 = -1; }
      }
    }
    // waypoints
    r.waypoints.forEach((w) => {
      const k = w.kinds.includes('gas') ? 'gas' : w.kinds.includes('food') ? 'food' : w.kinds.includes('hazard') ? 'hazard' : w.kinds.includes('gate') ? 'gate' : 'other';
      const col = { gas: '#e65100', food: '#2e7d32', hazard: '#d50000', gate: '#6a1b9a', other: '#455a64' }[k];
      L_.circleMarker([w.lat, w.lon], { radius: 5, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: 1, renderer: rendererCanvas }).bindTooltip(`${esc(w.name)}${w.desc ? ' - ' + esc(w.desc) : ''} (${r.name}, mile ${(w.distAlong / MI).toFixed(1)})`).addTo(layers.wp);
    });
  });
  if (bounds.length && !state.fitted) { map.fitBounds(bounds, { padding: [20, 20] }); state.fitted = true; }
  drawSelection();
}
function renderLegend() {
  const gl = state.sims.map((s) => `<div><span class="swatch" style="background:${s.grp.color || '#888'}"></span>${esc(s.grp.name)} (${s.N})</div>`).join('');
  $('#legend').innerHTML = `<div><i style="border-color:${TERR_COL[0]}"></i>paved</div><div><i style="border-color:${TERR_COL[1]}"></i>maintained dirt</div><div><i class="cvi" style="border-color:${TERR_COL[2]}"></i>Class VI</div>${gl}<div>Ring = encounter (color = terrain)</div><div>Dots: <span style="color:#e65100">gas</span> <span style="color:#2e7d32">food</span> <span style="color:#d50000">hazard</span> <span style="color:#6a1b9a">gate</span></div>`;
}
let dotSets = [];
function rebuildDots() {
  layers.dots.clearLayers(); dotSets = [];
  for (const sim of state.sims) {
    const col = sim.grp.color || '#333';
    const col_line = L_.polyline([], { color: col, weight: 9, opacity: 0.45, lineCap: 'round', renderer: rendererCanvas, interactive: false }).addTo(layers.dots);
    const riders = [];
    for (let k = 0; k < sim.N; k++) riders.push(L_.circleMarker([0, 0], { radius: k === 0 ? 7 : 4.5, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: 1, opacity: 1, renderer: rendererCanvas, interactive: false }));
    const label = L_.circleMarker([0, 0], { radius: 1, opacity: 0, fillOpacity: 0, interactive: false }).bindTooltip(`${sim.grp.name} (${sim.N})`, { permanent: true, direction: 'top', offset: [0, -8], className: 'near-tip' });
    riders.forEach((m) => m.addTo(layers.dots)); label.addTo(layers.dots);
    dotSets.push({ sim, line: col_line, riders, label, shown: false });
  }
}
function updateDots() {
  for (const d of dotSets) {
    const sim = d.sim, rel = state.t - sim.t0;
    const active = rel >= 0 && rel <= sim.endRel + 1;
    if (!active) { if (d.shown) { d.riders.forEach((m) => layers.dots.removeLayer(m)); layers.dots.removeLayer(d.label); d.line.setLatLngs([]); d.shown = false; } continue; }
    if (!d.shown) { d.riders.forEach((m) => m.addTo(layers.dots)); d.label.addTo(layers.dots); d.shown = true; }
    const pos = S.riderPositions(sim, state.t);
    pos.forEach((e, k) => d.riders[k].setLatLng(S.edgeLatLon(sim.path, e)));
    const tail = pos[pos.length - 1], head = pos[0];
    const stride = Math.max(3, Math.ceil((head - tail) / 120)); const pts = [S.edgeLatLon(sim.path, tail)];
    for (let i = Math.ceil(tail); i < head; i += stride) pts.push([sim.path.g.lat[i], sim.path.g.lon[i]]);
    pts.push(S.edgeLatLon(sim.path, head)); d.line.setLatLngs(pts);
    d.label.setLatLng(S.edgeLatLon(sim.path, head));
  }
}

// ---------------------------------------------------------------- events
let evMarkers = [], pulseMarkers = new Map(), activeIds = new Set();
function roadAt(route, d) { const s = route.terrain.find((t) => d >= t.a && d < t.b) || route.terrain.at(-1); return s ? s.name : ''; }
function nearWpt(route, d) { let best = null, bd = 3000; for (const w of route.waypoints) { const x = Math.abs(w.distAlong - d); if (x < bd) { bd = x; best = w; } } return best; }
function whereText(ev) {
  const r = routeById(ev.routeA); if (!r) return '';
  const road = roadAt(r, ev.distAFwd), w = nearWpt(r, ev.distAFwd);
  return `mile ${(ev.distAFwd / MI).toFixed(1)} of ${r.name}${road ? ', ' + road : ''}${w ? ` (near "${w.name}")` : ''}`;
}
function relText(ev) {
  if (ev.rel === 'overtake') { const o = ev.overtaker === ev.a ? ev.aName : ev.bName, v = ev.overtaker === ev.a ? ev.bName : ev.aName; return `${o} overtaking ${v} (same direction)`; }
  if (ev.rel === 'follow') { const f = ev.behind === ev.a ? ev.aName : ev.bName, l = ev.behind === ev.a ? ev.bName : ev.aName; return `${f} catching up to ${l} (same direction)`; }
  if (ev.rel === 'opposite') return 'Meeting head-on (opposite directions)';
  return 'Crossing / merging';
}
function drawEvents() {
  layers.ev.clearLayers(); layers.pulse.clearLayers(); pulseMarkers.clear(); activeIds.clear(); evMarkers = [];
  state.events.forEach((ev, i) => {
    const m = L_.circleMarker([ev.lat, ev.lon], { radius: 11, color: TERR_COL[ev.terrain], weight: 4, fillColor: '#fff', fillOpacity: 0.35, renderer: rendererCanvas })
      .bindTooltip(`${S.fmtClock(ev.tStart)}: ${relText(ev)}, ${S.CLS_NAMES[ev.terrain]}`).addTo(layers.ev);
    m.on('click', () => jumpToEvent(i));
    evMarkers.push(m);
  });
}
function evSeverityBadge(ev) { return `<span class="chip ${ev.level}">${ev.level}</span>`; }
function renderEventsTable() {
  const tb = $('#ev-table tbody'); tb.innerHTML = '';
  const hi = state.events.filter((e) => e.level === 'high').length, c6 = state.events.filter((e) => e.terrain === 2).length;
  $('#ev-summary').textContent = state.events.length ? `${state.events.length} predicted encounter${state.events.length === 1 ? '' : 's'}: ${hi} high severity, ${c6} on Class VI. Threshold ${state.P.threshold} m.` : (state.sims.length < 2 ? 'Select at least two groups (or one group plus the observer) to see encounters.' : `No encounters predicted within ${state.P.threshold} m for this scenario.`);
  state.events.forEach((ev, i) => {
    const tr = document.createElement('tr'); tr.className = 'clickable'; tr.tabIndex = 0; tr.dataset.i = i;
    tr.innerHTML = `<td>${S.fmtClock(ev.tStart)}<div class="small muted">to ${S.fmtClock(ev.tEnd)}</div></td><td>${esc(ev.aName)} + ${esc(ev.bName)}</td><td>${esc(relText(ev))}</td><td><span class="chip t-${ev.terrain}">${S.CLS_NAMES[ev.terrain]}</span></td><td class="small">${esc(whereText(ev))}</td><td>${S.fmtDur(ev.duration)}</td><td>${ev.ridersA}/${ev.nA} + ${ev.ridersB}/${ev.nB}</td><td>${evSeverityBadge(ev)}</td>`;
    tb.appendChild(tr);
  });
}
function renderTicks() {
  const el = $('#ticks'); el.innerHTML = '';
  const span = state.tMax - state.tMin || 1;
  state.events.forEach((ev, i) => {
    const s = document.createElement('span'); s.className = 't-' + ev.terrain; s.tabIndex = 0; s.setAttribute('role', 'button');
    s.style.left = ((ev.tStart - state.tMin) / span * 100) + '%'; s.style.width = Math.max(0.4, (ev.tEnd - ev.tStart) / span * 100) + '%';
    s.title = `${S.fmtClock(ev.tStart)}: ${relText(ev)}, ${S.CLS_NAMES[ev.terrain]}`; s.setAttribute('aria-label', s.title); s.dataset.i = i;
    el.appendChild(s);
  });
}
function jumpToEvent(i) {
  const ev = state.events[i]; if (!ev) return;
  setTime(ev.tStart + Math.min(20, ev.duration / 2), false);
  map.setView([ev.lat, ev.lon], Math.max(map.getZoom(), 14));
  $('#map').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  evMarkers[i]?.openTooltip();
}
let audioCtx;
function beep() {
  if (!$('#beep').checked) return;
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.18); } catch (e) {}
}

// ---------------------------------------------------------------- frame
function setTime(t, keepPlaying = true) {
  state.t = clamp(Math.round(t), state.tMin, state.tMax);
  if (!keepPlaying) setPlaying(false);
  updateFrame();
}
function updateFrame(force) {
  const t = state.t;
  $('#slider').value = t; $('#clock').textContent = S.fmtClock(t, true);
  updateDots();
  const act = [];
  state.events.forEach((ev, i) => { if (t >= ev.tStart && t <= ev.tEnd + 5) act.push(i); });
  const aset = new Set(act);
  let fresh = false;
  for (const i of act) if (!activeIds.has(i)) {
    fresh = true;
    const ev = state.events[i];
    const p = L_.marker([ev.lat, ev.lon], { icon: L_.divIcon({ className: '', html: '<div class="pulse"></div>', iconSize: [0, 0] }), interactive: false, keyboard: false }).addTo(layers.pulse);
    pulseMarkers.set(i, p);
  }
  for (const i of [...activeIds]) if (!aset.has(i)) { layers.pulse.removeLayer(pulseMarkers.get(i)); pulseMarkers.delete(i); }
  activeIds = aset;
  if (fresh && state.playing) beep();
  const b = $('#banner');
  if (act.length) {
    const top = act.map((i) => state.events[i]).sort((x, y) => y.score - x.score)[0];
    b.className = 'banner on sev-' + top.level;
    b.textContent = `ENCOUNTER: ${relText(top)}, ${S.CLS_NAMES[top.terrain]}, ${S.fmtClock(top.tStart)}` + (act.length > 1 ? ` (+${act.length - 1} more now)` : '');
  } else b.className = 'banner';
  $$('#ev-table tbody tr').forEach((tr) => tr.classList.toggle('active-ev', aset.has(+tr.dataset.i)));
  const next = state.events.find((e) => e.tStart > t);
  $('#next-ev').textContent = state.events.length ? (act.length ? `Encounter in progress (${act.length}).` : next ? `Next encounter in ${S.fmtDur(next.tStart - t)}: ${relText(next)}, ${S.CLS_NAMES[next.terrain]}, ${S.fmtClock(next.tStart)}.` : 'No further encounters.') : '';
}
let lastTs = 0;
function frame(ts) {
  if (!state.playing) return;
  const dt = Math.min(0.1, (ts - lastTs) / 1000); lastTs = ts;
  state.t += dt * +$('#speed').value;
  if (state.t >= state.tMax) { state.t = state.tMax; setPlaying(false); }
  updateFrame();
  requestAnimationFrame(frame);
}
function setPlaying(p) {
  state.playing = p; $('#play-btn').textContent = p ? 'Pause' : 'Play';
  if (p) { if (state.t >= state.tMax) state.t = state.tMin; lastTs = performance.now(); requestAnimationFrame(frame); }
}

// ---------------------------------------------------------------- question card
function renderQuestion() {
  const gs = state.sims.map((s) => s.grp);
  const fill = (sel, def) => { const cur = sel.value; sel.innerHTML = gs.map((g) => `<option value="${g.id}">${esc(g.name)}</option>`).join(''); sel.value = gs.some((g) => g.id === cur) ? cur : def; };
  const qx = $('#q-x'), qy = $('#q-y');
  fill(qx, gs.find((g) => g.id === 'sbh')?.id ?? gs[0]?.id); fill(qy, gs.find((g) => g.id === 'mbh')?.id ?? gs[1]?.id ?? gs[0]?.id);
  computeQuestion();
}
function computeQuestion() {
  const x = $('#q-x').value, y = $('#q-y').value, terr = +$('#q-t').value, from = parseTime($('#q-from').value), to = parseTime($('#q-to').value);
  const ans = $('#q-answer'), det = $('#q-detail');
  if (state.sims.length < 2 || !x || !y || x === y) { ans.textContent = 'Pick two different groups that both have riders.'; det.textContent = ''; return; }
  const nameOf = (id) => state.sims.find((s) => s.grp.id === id)?.grp.name || id;
  const q = S.answerQuestion(state.events, { x, y, terrain: terr, from, to });
  const win = `${S.fmtClock(from)} and ${S.fmtClock(to)}`;
  if (q.yes) {
    const e = q.hits[0];
    ans.innerHTML = `<span class="yes">Model says YES:</span> ${esc(nameOf(x))} overtakes ${esc(nameOf(y))} on ${S.CLS_NAMES[terr]} between ${win}${q.hits.length > 1 ? ` (${q.hits.length} times)` : ''}. First at ${S.fmtClock(e.tStart)} for ${S.fmtDur(e.duration)}, ${esc(whereText(e))}.`;
  } else {
    ans.innerHTML = `<span class="no">Model says NO:</span> no ${esc(nameOf(x))} overtake of ${esc(nameOf(y))} on ${S.CLS_NAMES[terr]} between ${win}.`;
  }
  const lines = [];
  for (const e of q.related) lines.push(`${S.fmtClock(e.tStart)} to ${S.fmtClock(e.tEnd)}: ${relText(e)}, ${S.CLS_NAMES[e.terrain]}, ${whereText(e)}`);
  const none = `No encounter of any kind between these two groups touches that window.`;
  det.innerHTML = `<strong>What the model shows in that window for these two groups:</strong> ${lines.length ? '<ul>' + lines.map((l) => `<li>${esc(l)}</li>`).join('') + '</ul>' : none} <br>Assumptions: single deterministic run, ${state.P.threshold} m threshold, speeds ${state.P.cviInt}/${state.P.cviFast} mph on Class VI (intermediate/fast), limit +${state.P.bonusMph} mph on maintained roads, OSM terrain with your edits. Real groups vary, so see the Leader briefing tab for probabilities.`;
}

// ---------------------------------------------------------------- worker jobs
let worker = null, workerOk = false, jobSeq = 0; const jobs = new Map();
function startWorker() {
  try {
    worker = new Worker('js/worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') { workerOk = true; return; }
      const j = jobs.get(m.id); if (!j) return;
      if (m.type === 'progress') j.onProgress?.(m.p);
      else if (m.type === 'result') { jobs.delete(m.id); j.resolve(m.result); }
      else if (m.type === 'error') { jobs.delete(m.id); j.reject(new Error(m.message)); }
    };
    worker.onerror = () => { workerOk = false; worker = null; };
    worker.postMessage({ type: 'init', routes: state.routes });
  } catch (e) { worker = null; }
}
function job(type, payload, onProgress) {
  const id = ++jobSeq;
  return new Promise((resolve, reject) => {
    if (worker) { jobs.set(id, { resolve, reject, onProgress }); worker.postMessage({ type, id, ...payload }); return; }
    setTimeout(() => {
      try {
        if (type === 'optimize') resolve(S.optimize(state.ctx, payload.scenario, payload.locked));
        else resolve(S.monteCarlo(state.ctx, payload.scenario, payload.runs, payload.seed || 12345, onProgress));
      } catch (err) { reject(err); }
    }, 30);
  });
}
function reinitWorker() { state.ctx = S.makeContext(state.routes); if (worker) worker.postMessage({ type: 'init', routes: state.routes }); }

// ---------------------------------------------------------------- optimizer
function renderOptLocks() {
  const gs = state.sims.map((s) => s.grp);
  const earliest = gs.slice().sort((a, b) => a.t0 - b.t0)[0]?.id;
  const prev = new Set($$('#opt-lock input:checked').map((i) => i.value));
  const hadAny = $$('#opt-lock input').length > 0;
  $('#opt-lock').innerHTML = '<span class="small">Lock departure time of:</span> ' + gs.map((g) => `<label class="small"><input type="checkbox" value="${g.id}"${(hadAny ? prev.has(g.id) : g.id === earliest) ? ' checked' : ''}> ${esc(g.name)} (${S.fmtClock(g.t0)})</label>`).join(' ');
}
async function runOptimizer() {
  const sc = buildScenario(); const groups = sc.groups;
  if (groups.length < 2) { $('#opt-out').innerHTML = '<p>Select at least two groups.</p>'; return; }
  const locked = $$('#opt-lock input:checked').map((i) => i.value);
  if (locked.length === groups.length) { $('#opt-out').innerHTML = '<p>Unlock at least one group so the optimizer can move it.</p>'; return; }
  $('#opt-btn').disabled = true; $('#opt-status').textContent = 'Searching...';
  const t0 = performance.now();
  try {
    const r = await job('optimize', { scenario: sc, locked });
    $('#opt-status').textContent = `Done in ${Math.round(performance.now() - t0)} ms.`;
    renderOptResult(r, sc, locked);
  } catch (e) { $('#opt-status').textContent = 'Optimizer failed: ' + e.message; }
  $('#opt-btn').disabled = false;
}
function renderOptResult(r, sc, locked) {
  const out = $('#opt-out');
  const sevLine = (x) => `${x.count} encounter${x.count === 1 ? '' : 's'}, severity score ${x.score.toFixed(1)}${x.classViOvertakes ? `, ${x.classViOvertakes} Class VI overtake${x.classViOvertakes > 1 ? 's' : ''}` : ''}${x.headOn ? `, ${x.headOn} head-on` : ''}`;
  let html = `<p><strong>Current schedule:</strong> ${esc(sevLine(r.before))}.</p>`;
  if (r.minStagger && r.minStagger.deltaSec != null) {
    const d = r.minStagger.deltaSec, [a, b] = r.minStagger.names;
    html += `<p><strong>Smallest clear stagger (${esc(a)} vs ${esc(b)}):</strong> ${d === 0 ? 'any' : esc(b) + ' departs ' + S.fmtDur(Math.abs(d)) + (d > 0 ? ' after ' : ' before ') + esc(a)}. Bars below show the severity (model units) for each start-time difference from -4 h to +4 h; green means clear for that stagger and all within 15 minutes of it.</p>`;
    const cur = r.minStagger.curve.filter(([s]) => s >= -4 * 3600 && s <= 4 * 3600), mx = Math.max(1, ...cur.map((c) => c[1]));
    html += `<div class="bar" role="img" aria-label="Severity versus start-time difference">${cur.map(([s, c]) => `<div class="${c === 0 ? 'ok' : ''}" style="height:${Math.max(2, c / mx * 100)}%" title="${s / 60} min: ${c.toFixed(1)}"></div>`).join('')}</div><div class="small muted" style="display:flex;justify-content:space-between"><span>-4 h</span><span>0</span><span>+4 h</span></div>`;
  }
  html += '<div class="cards">';
  r.after.forEach((a, i) => {
    html += `<div class="card"><h3>Option ${i + 1}</h3><ul style="margin:.2rem 0 .5rem 1rem;padding:0">${a.groups.map((g) => `<li>${esc(g.name)}: <strong>${S.fmtClock(g.t0)}</strong>${locked.includes(g.id) ? ' (locked)' : ''}</li>`).join('')}</ul><div class="small">${esc(sevLine(a))}<br>Was: ${r.before.count} encounters.<br>Departure spread: ${S.fmtDur(a.spreadSec)}.</div><button class="btn small" type="button" data-apply="${i}" style="margin-top:6px">Apply this schedule</button></div>`;
  });
  html += '</div>';
  if (!r.after.length) html += '<p>No schedule found.</p>';
  if (r.bestCost > 0) html += '<p class="small muted">No fully clear schedule exists within 7:00 AM to 3:00 PM for these groups; the options above minimize weighted severity.</p>';
  html += '<p class="small muted">A "clear" result means clear in the model. Real groups vary; run the Leader briefing forecast on the applied schedule to see how robust it is.</p>';
  out.innerHTML = html;
  out.querySelectorAll('[data-apply]').forEach((b) => b.addEventListener('click', () => {
    const a = r.after[+b.dataset.apply];
    for (const g of a.groups) { if (g.id === 'obs') state.obs.t0 = g.t0; else if (state.rows[g.id]) state.rows[g.id].t0 = g.t0; }
    renderRows(); scheduleRun();
  }));
}

// ---------------------------------------------------------------- briefing / Monte Carlo
function renderBriefingText() { $('#brief-text').textContent = S.briefingMarkdown(buildScenario(), state.events, state.forecast, state.ctx); }
function mileOn(c, groupId) {
  const isA = c.a === groupId; const rid = isA ? c.routeA : c.routeB; const d = isA ? c.distAFwd : c.distBFwd; const r = routeById(rid);
  if (!r) return '';
  const road = roadAt(r, d), w = nearWpt(r, d);
  return `mile ${(d / MI).toFixed(1)} of ${r.name}${road ? ', ' + road : ''}${w ? ` (near "${w.name}")` : ''}`;
}
function renderForecast() {
  const el = $('#forecast');
  if (!state.forecast) { el.innerHTML = '<p class="small muted">Run the forecast to see probabilities, time windows and places for each group.</p>'; return; }
  const f = state.forecast; let html = '';
  for (const s of state.sims) {
    const g = s.grp; const mine = f.clusters.filter((c) => c.a === g.id || c.b === g.id);
    html += `<h3><span class="swatch" style="background:${g.color}"></span>${esc(g.name)} leader: ${mine.length ? 'expect ' + mine.length + ' encounter zone' + (mine.length > 1 ? 's' : '') : 'no encounters expected'}</h3>`;
    if (mine.length) {
      html += '<div class="tablewrap"><table><thead><tr><th>Chance</th><th>Likely time (ET)</th><th>With</th><th>What</th><th>Terrain</th><th>Where</th></tr></thead><tbody>';
      for (const c of mine) {
        const other = c.a === g.id ? c.bName : c.aName;
        const what = c.rel === 'overtake' ? (c.overtaker === g.id ? 'you overtake them' : 'they overtake you') : c.rel === 'follow' ? (c.behind === g.id ? 'you close on them' : 'they close on you') : c.rel === 'opposite' ? 'head-on meeting' : 'crossing / merge';
        html += `<tr><td><strong>${Math.round(c.prob * 100)}%</strong></td><td>${S.fmtClock(c.tP50)}<div class="small muted">${S.fmtClock(c.tP10)} to ${S.fmtClock(c.tP90)}</div></td><td>${esc(other)}</td><td>${what}</td><td><span class="chip t-${c.terrain}">${S.CLS_NAMES[c.terrain]}</span></td><td class="small">${esc(mileOn(c, g.id))}</td></tr>`;
      }
      html += '</tbody></table></div>';
    }
  }
  el.innerHTML = html + `<p class="small muted">${f.runs} runs. Chance = share of runs with an encounter in that zone. Zones are grouped within a few km of each other, so a moving overtake counts once.</p>`;
}
async function runForecast() {
  const sc = buildScenario(); if (sc.groups.length < 2) { $('#mc-status').textContent = 'Select at least two groups.'; return; }
  const runs = +$('#mc-runs').value; $('#mc-btn').disabled = true; $('#mc-prog').hidden = false; const bar = $('#mc-prog > div'); bar.style.width = '0'; $('#mc-status').textContent = 'Running...';
  try {
    const r = await job('mc', { scenario: sc, runs, seed: 12345 }, (p) => { bar.style.width = Math.round(p * 100) + '%'; });
    state.forecast = r; $('#mc-status').textContent = `${runs} runs complete.`; renderForecast(); renderBriefingText();
  } catch (e) { $('#mc-status').textContent = 'Forecast failed: ' + e.message; }
  $('#mc-prog').hidden = true; $('#mc-btn').disabled = false;
}

// ---------------------------------------------------------------- terrain editor
const te = { a: null, b: null, step: 0 };
function teRoute() { return routeById($('#te-route').value); }
function drawSelection() {
  layers.sel.clearLayers();
  const r = teRoute(); if (!r || te.a == null || te.b == null || $('#tab-terrain').hidden) return;
  const g = S.getGeom(r), a = Math.max(0, Math.floor(Math.min(te.a, te.b) * MI / g.ds)), b = Math.min(g.n, Math.ceil(Math.max(te.a, te.b) * MI / g.ds));
  const pts = []; for (let i = a; i <= b; i += 2) pts.push([g.lat[i], g.lon[i]]); pts.push([g.lat[b], g.lon[b]]);
  L_.polyline(pts, { color: '#00e5ff', weight: 12, opacity: 0.55, lineCap: 'butt', interactive: false }).addTo(layers.sel);
}
function onMapClick(e) {
  if (!$('#te-pick').checked) return;
  const r = teRoute(); if (!r) return;
  const g = S.getGeom(r), [px, py] = S.projectLatLon(e.latlng.lat, e.latlng.lng);
  let bi = -1, bd = 1e12; for (let i = 0; i < g.n; i++) { const d = (g.cx[i] - px) ** 2 + (g.cy[i] - py) ** 2; if (d < bd) { bd = d; bi = i; } }
  if (Math.sqrt(bd) > 400) { $('#te-info').textContent = 'That click is more than 400 m from the selected route.'; return; }
  const mile = +(bi * g.ds / MI).toFixed(2);
  if (te.step === 0) { te.a = mile; te.b = mile; te.step = 1; } else { te.b = mile; te.step = 0; }
  $('#te-a').value = Math.min(te.a, te.b); $('#te-b').value = Math.max(te.a, te.b);
  $('#te-info').textContent = te.step ? `Start set at mile ${mile}. Click the end point.` : `Selected miles ${Math.min(te.a, te.b)} to ${Math.max(te.a, te.b)}.`;
  drawSelection();
}
function subtractRange(list, a, b) {
  const out = [];
  for (const o of list) {
    const lo = Math.min(o.a, o.b), hi = Math.max(o.a, o.b);
    if (hi <= a || lo >= b) { out.push(o); continue; }
    if (lo < a) out.push({ ...o, a: lo, b: a });
    if (hi > b) out.push({ ...o, a: b, b: hi });
  }
  return out;
}
function applyTerrainEdit(cls) {
  const r = teRoute(); if (!r) return;
  let a = parseFloat($('#te-a').value), b = parseFloat($('#te-b').value);
  if (!isFinite(a) || !isFinite(b) || a === b) { $('#te-info').textContent = 'Pick a start and end mile first.'; return; }
  a = Math.max(0, Math.min(a, b) * MI); b = Math.min(r.lengthM, Math.max(parseFloat($('#te-a').value), parseFloat($('#te-b').value)) * MI);
  let list = subtractRange(state.overrides[r.id] || [], a, b);
  if (cls !== 'clear') list.push({ a: Math.round(a), b: Math.round(b), cls: +cls });
  list.sort((x, y) => x.a - y.a);
  const merged = []; for (const o of list) { const p = merged.at(-1); if (p && p.cls === o.cls && Math.abs(p.b - o.a) < 1) p.b = o.b; else merged.push({ ...o }); }
  state.overrides[r.id] = merged; if (!merged.length) delete state.overrides[r.id];
  $('#te-info').textContent = cls === 'clear' ? 'Edits cleared in range.' : `Set miles ${(a / MI).toFixed(2)} to ${(b / MI).toFixed(2)} to ${S.CLS_NAMES[cls]}.`;
  renderTerrainList(); scheduleRun();
}
function renderTerrainList() {
  const el = $('#te-list'); const items = [];
  for (const [rid, list] of Object.entries(state.overrides)) list.forEach((o, i) => items.push(`<div>${esc(routeById(rid)?.name || rid)}: miles ${(o.a / MI).toFixed(2)} to ${(o.b / MI).toFixed(2)} = <span class="chip t-${o.cls}">${S.CLS_NAMES[o.cls]}</span> <button class="btn small" type="button" data-del="${rid}:${i}">Remove</button></div>`));
  el.innerHTML = items.length ? items.join('') : '<span class="muted">No edits. The OSM-derived classification is in use.</span>';
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { const [rid, i] = b.dataset.del.split(':'); state.overrides[rid].splice(+i, 1); if (!state.overrides[rid].length) delete state.overrides[rid]; renderTerrainList(); scheduleRun(); }));
}
function renderTerrainSummary() {
  const tb = $('#te-sum tbody'); tb.innerHTML = '';
  for (const r of state.routes) {
    const t = S.applyOverrides(r, state.overrides[r.id]); const n = t.cls.length; const c = [0, 0, 0]; let ed = 0; for (let i = 0; i < n; i++) { c[t.cls[i]]++; ed += t.edited[i]; }
    const g = S.getGeom(r), mi = (k) => (k * g.ds / MI).toFixed(1);
    const cf = r.stats.confPct;
    tb.insertAdjacentHTML('beforeend', `<tr><th scope="row" style="text-transform:none;font-size:.95rem;color:inherit">${esc(r.name)}</th>${c.map((k) => `<td>${mi(k)} mi (${(100 * k / n).toFixed(1)}%)</td>`).join('')}<td>${cf.high}% / ${cf.medium}% / ${cf.low}%</td><td>${mi(ed)} mi</td></tr>`);
  }
}

// ---------------------------------------------------------------- stops tab
function renderStops() {
  const r = routeById($('#st-route').value); if (!r) return;
  const P = { ...S.DEFAULT_PARAMS, ...state.params };
  const defs = S.defaultWaypointStops(r); const tb = $('#st-table tbody'); tb.innerHTML = '';
  const ov = state.wptMinutes[r.id] || {};
  defs.forEach((w) => {
    const val = ov[w.idx] != null ? ov[w.idx] : S.resolveWaypointMinutes(w, P);
    tb.insertAdjacentHTML('beforeend', `<tr><td>${esc(w.name)}<div class="small muted">${w.kinds.join(', ')}</div></td><td>${(w.d / MI).toFixed(1)}</td><td><input type="number" min="0" max="180" step="5" value="${val}" data-w="${w.idx}" aria-label="Stop minutes at ${esc(w.name)}"></td></tr>`);
  });
  if (!defs.length) tb.innerHTML = '<tr><td colspan="3" class="muted">No gas or food waypoints on this route.</td></tr>';
  const used = new Set(); defs.forEach((w) => used.add(w.idx));
  $('#st-info').innerHTML = '<ul>' + r.waypoints.map((w) => `<li>Mile ${(w.distAlong / MI).toFixed(1)}: <strong>${esc(w.name)}</strong>${w.desc ? ' - ' + esc(w.desc) : ''} <span class="muted">[${esc(w.sym || 'waypoint')}${w.kinds.length ? '; ' + w.kinds.join(', ') : ''}${w.offTrack > 300 ? '; ' + (w.offTrack / 1000).toFixed(1) + ' km off the track, not used as a stop' : ''}]</span></li>`).join('') + '</ul>';
  const st = r.stats.stops || {};
  $('#st-controls').textContent = r.custom ? 'Imported route: no stop-sign data.' : `Controls on ${r.name} from OpenStreetMap: ${st.stop || 0} mapped stop signs, ${st.inferredStop || 0} inferred stops (minor road onto a bigger road), ${st.signal || 0} signal(s). Posted speed limits were tagged on ${r.stats.limitsTaggedPct}% of the route length; the rest use the defaults.`;
}

// ---------------------------------------------------------------- settings tab
function renderSettings() {
  const el = $('#settings'); el.innerHTML = '';
  for (const s of SETTINGS) {
    const v = state.params[s.key] ?? S.DEFAULT_PARAMS[s.key];
    el.insertAdjacentHTML('beforeend', `<div class="setting"><label for="set-${s.key}">${s.label} (${s.unit})</label><input type="number" id="set-${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${v}" data-k="${s.key}">${s.hint ? `<span class="small muted">${s.hint}</span>` : ''}</div>`);
  }
  for (const t of TOGGLES) {
    const v = state.params[t.key] ?? S.DEFAULT_PARAMS[t.key];
    el.insertAdjacentHTML('beforeend', `<div class="setting"><label><input type="checkbox" data-k="${t.key}"${v ? ' checked' : ''}> ${t.label}</label></div>`);
  }
}

// ---------------------------------------------------------------- custom GPX
function renderCustomList() {
  const el = $('#gpx-list');
  el.innerHTML = state.custom.length ? '<h3>Imported routes</h3>' + state.custom.map((r) => `<div>${esc(r.name)} (${r.stats.lengthMi} mi) <button class="btn small" type="button" data-rm="${r.id}">Remove</button></div>`).join('') : '';
  el.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => removeCustom(b.dataset.rm)));
}
function saveCustom() { try { const s = JSON.stringify(state.custom); if (s.length < 1.5e6) localStorage.setItem('near.custom.v1', s); else localStorage.removeItem('near.custom.v1'); } catch (e) {} }
function refreshRouteSelects() {
  for (const sel of ['#te-route', '#st-route']) { const cur = $(sel).value; $(sel).innerHTML = state.routes.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join(''); if (state.routes.some((r) => r.id === cur)) $(sel).value = cur; }
}
function removeCustom(id) {
  state.custom = state.custom.filter((r) => r.id !== id); state.routes = state.routes.filter((r) => r.id !== id); delete state.rows[id]; delete state.overrides[id];
  if (state.obs.routeId === id) state.obs.routeId = state.routes[0].id;
  saveCustom(); reinitWorker(); refreshRouteSelects(); renderRows(); renderCustomList(); renderStops(); scheduleRun();
}

// ---------------------------------------------------------------- init
async function init() {
  const data = await (await fetch('data/routes.json')).json();
  state.routes = data.routes; state.meta = data.meta;
  try { const c = JSON.parse(localStorage.getItem('near.custom.v1') || '[]'); for (const r of c) { state.custom.push(r); state.routes.push(r); } } catch (e) {}
  state.rows = defaultRows(); loadState();
  state.ctx = S.makeContext(state.routes);
  state.fitted = false;
  initMap(); startWorker();
  renderRows(); renderSettings(); refreshRouteSelects(); renderTerrainList(); renderStops(); renderCustomList();
  // events
  $('#rows').addEventListener('change', onRowChange); $('#rows').addEventListener('input', (e) => { if (e.target.type === 'number') onRowChange(e); });
  $('#res').addEventListener('change', (e) => { state.res = +e.target.value; renderRows(); saveState(); });
  $('#reset-btn').addEventListener('click', () => { state.rows = defaultRows(); state.obs = { on: false, routeId: 'sbh', t0: 9 * 3600 + 45 * 60, reverse: false, skill: 'intermediate' }; renderRows(); scheduleRun(); });
  for (const id of ['#q-x', '#q-y', '#q-t', '#q-from', '#q-to']) $(id).addEventListener('change', computeQuestion);
  $('#play-btn').addEventListener('click', () => setPlaying(!state.playing));
  $('#back-btn').addEventListener('click', () => setTime(state.t - 300)); $('#fwd-btn').addEventListener('click', () => setTime(state.t + 300));
  $('#slider').addEventListener('input', (e) => setTime(+e.target.value));
  $('#ticks').addEventListener('click', (e) => { const s = e.target.closest('span'); if (s) jumpToEvent(+s.dataset.i); });
  $('#ticks').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset.i) { e.preventDefault(); jumpToEvent(+e.target.dataset.i); } });
  $('#ev-table tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr'); if (tr) jumpToEvent(+tr.dataset.i); });
  $('#ev-table tbody').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const tr = e.target.closest('tr'); if (tr) jumpToEvent(+tr.dataset.i); } });
  $('#show-all').addEventListener('change', () => { drawRoutes(); }); $('#show-low').addEventListener('change', () => drawRoutes());
  document.addEventListener('keydown', (e) => { if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(document.activeElement.tagName) && document.activeElement.role !== 'button') { e.preventDefault(); setPlaying(!state.playing); } });
  $('#theme-btn').addEventListener('click', () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('near.theme', t); } catch (e) {} });
  // tabs
  const tabs = $$('#tabs [role=tab]');
  tabs.forEach((b) => b.addEventListener('click', () => {
    tabs.forEach((x) => { x.setAttribute('aria-selected', x === b); $('#' + x.getAttribute('aria-controls')).hidden = x !== b; });
    drawSelection(); if (b.id === 'tb-terrain') { $('#te-pick').checked = true; } else { $('#te-pick').checked = false; }
    map.invalidateSize();
  }));
  $('#tabs').addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { const i = tabs.indexOf(document.activeElement); const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]; n.focus(); n.click(); } });
  $$('.tabpanel').forEach((p, i) => { p.hidden = i !== 0; });
  $('#opt-btn').addEventListener('click', runOptimizer); $('#mc-btn').addEventListener('click', runForecast);
  $('#copy-brief').addEventListener('click', async () => { const txt = $('#brief-text').textContent; try { await navigator.clipboard.writeText(txt); $('#mc-status').textContent = 'Briefing copied.'; } catch (e) { const r = document.createRange(); r.selectNodeContents($('#brief-text')); getSelection().removeAllRanges(); getSelection().addRange(r); $('#mc-status').textContent = 'Press Ctrl/Cmd+C to copy the selected text.'; } });
  $('#print-brief').addEventListener('click', () => { $$('#tabs [role=tab]')[2].click(); document.body.classList.add('print-brief'); window.print(); setTimeout(() => document.body.classList.remove('print-brief'), 500); });
  $('#te-route').addEventListener('change', () => { te.a = te.b = null; te.step = 0; $('#te-a').value = $('#te-b').value = ''; drawSelection(); });
  $('#te-a').addEventListener('input', () => { te.a = parseFloat($('#te-a').value); te.b = parseFloat($('#te-b').value); drawSelection(); }); $('#te-b').addEventListener('input', () => { te.a = parseFloat($('#te-a').value); te.b = parseFloat($('#te-b').value); drawSelection(); });
  $$('[data-te]').forEach((b) => b.addEventListener('click', () => applyTerrainEdit(b.dataset.te)));
  $('#te-clearall').addEventListener('click', () => { state.overrides = {}; renderTerrainList(); scheduleRun(); });
  $('#te-export').addEventListener('click', () => { const blob = new Blob([JSON.stringify({ app: 'near-ride-deconfliction', version: 1, overrides: state.overrides, wptMinutes: state.wptMinutes }, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'near-terrain-edits.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
  $('#te-import').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); if (j.overrides) state.overrides = j.overrides; if (j.wptMinutes) state.wptMinutes = j.wptMinutes; renderTerrainList(); renderStops(); scheduleRun(); $('#te-info').textContent = 'Edits imported.'; } catch (err) { $('#te-info').textContent = 'Could not read that file: ' + err.message; } e.target.value = ''; });
  $('#st-route').addEventListener('change', renderStops);
  $('#st-table').addEventListener('change', (e) => { const el = e.target; if (el.dataset.w == null) return; const rid = $('#st-route').value; (state.wptMinutes[rid] ||= {})[el.dataset.w] = clamp(+el.value || 0, 0, 180); scheduleRun(); });
  $('#settings').addEventListener('change', (e) => { const el = e.target; const k = el.dataset.k; if (!k) return; state.params[k] = el.type === 'checkbox' ? el.checked : clamp(+el.value, +el.min, +el.max); if (el.type !== 'checkbox') el.value = state.params[k]; renderStops(); scheduleRun(); });
  $('#settings-reset').addEventListener('click', () => { state.params = {}; renderSettings(); renderStops(); scheduleRun(); });
  $('#gpx-add').addEventListener('click', async () => {
    const f = $('#gpx-file').files[0]; const msg = $('#gpx-msg');
    if (!f) { msg.textContent = 'Choose a .gpx file first.'; return; }
    try {
      const id = 'c' + (Date.now() % 1e6);
      const r = parseGpxToRoute(await f.text(), { id, name: $('#gpx-name').value.trim() || f.name.replace(/\.gpx$/i, ''), color: PALETTE[(state.routes.length + 2) % PALETTE.length], defaultCls: +$('#gpx-cls').value });
      state.custom.push(r); state.routes.push(r); state.rows[id] = { n: 0, t0: 9 * 3600, skill: 'intermediate', reverse: false };
      saveCustom(); reinitWorker(); refreshRouteSelects(); renderRows(); renderCustomList(); renderStops();
      msg.textContent = `Added "${r.name}" (${r.stats.lengthMi} mi, ${r.pts.length} points, ${r.waypoints.length} waypoints). Set riders above, then refine terrain in the Terrain editor.`;
      scheduleRun();
    } catch (err) { msg.textContent = 'Could not import: ' + err.message; }
  });
  renderOptLocks();
  runNow();
  window.__near = { state, S, ready: true };
}
init().catch((err) => { console.error(err); const m = document.createElement('p'); m.className = 'disclaimer'; m.textContent = 'The simulator failed to start: ' + err.message; document.querySelector('main').prepend(m); });
