// Client-side GPX import: parse, simplify and shape a route object compatible with the simulator.
const R = 6371008.8;
function hav(a, b) {
  const t = Math.PI / 180, dLat = (b[0] - a[0]) * t, dLon = (b[1] - a[1]) * t;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * t) * Math.cos(b[0] * t) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function dpIdx(xy, tol) {
  const n = xy.length, keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const st = [[0, n - 1]];
  while (st.length) {
    const [s, e] = st.pop(); let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const dx = xy[e][0] - xy[s][0], dy = xy[e][1] - xy[s][1], l2 = dx * dx + dy * dy;
      let t = l2 ? ((xy[i][0] - xy[s][0]) * dx + (xy[i][1] - xy[s][1]) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(xy[i][0] - (xy[s][0] + t * dx), xy[i][1] - (xy[s][1] + t * dy));
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; st.push([s, mi], [mi, e]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(i); return out;
}
function kindsOf(name, desc, sym) {
  const t = `${name} ${desc} ${sym}`.toLowerCase(), k = [];
  if (/\bgas\b|gas station|fuel/.test(t)) k.push('gas');
  if (/food|lunch|restaurant|tavern|dunkin|provision|sandwich/.test(t)) k.push('food');
  if (/extreme|danger|death|slow|hardest|obstacle/.test(t)) k.push('hazard');
  if (/gate/.test(t)) k.push('gate');
  if (/start/.test(t)) k.push('start');
  return k;
}
export function parseGpxToRoute(xmlText, { id, name, color, defaultCls = 1 }) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('That file is not valid GPX/XML.');
  const segs = [...doc.getElementsByTagName('trkseg')].map((s) => [...s.getElementsByTagName('trkpt')].map((p) => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))]).filter((p) => isFinite(p[0]) && isFinite(p[1])));
  let pts = segs.sort((a, b) => b.length - a.length)[0];
  if (!pts || pts.length < 2) { // fall back to a GPX route (rte)
    pts = [...doc.getElementsByTagName('rtept')].map((p) => [parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))]);
  }
  if (!pts || pts.length < 2) throw new Error('No track points found (need a <trk> or <rte>).');
  const kx = Math.cos(pts[0][0] * Math.PI / 180) * 111195, ky = 111195;
  const xy = pts.map((p) => [p[1] * kx, p[0] * ky]);
  const keep = dpIdx(xy, 2.5), sp = keep.map((i) => pts[i]);
  const cum = [0]; for (let i = 1; i < sp.length; i++) cum.push(cum[i - 1] + hav(sp[i - 1], sp[i]));
  const L = Math.round(cum.at(-1));
  const wpts = [...doc.getElementsByTagName('wpt')].map((w) => {
    const g = (t) => (w.getElementsByTagName(t)[0]?.textContent || '').trim();
    const lat = parseFloat(w.getAttribute('lat')), lon = parseFloat(w.getAttribute('lon'));
    let best = 1e12, bi = 0; sp.forEach((p, i) => { const d = hav([lat, lon], p); if (d < best) { best = d; bi = i; } });
    return { lat, lon, name: g('name'), desc: g('desc'), sym: g('sym'), kinds: kindsOf(g('name'), g('desc'), g('sym')), distAlong: Math.round(cum[bi]), offTrack: Math.round(best) };
  }).sort((a, b) => a.distAlong - b.distAlong);
  const nm = name || doc.querySelector('metadata > name')?.textContent || doc.querySelector('trk > name')?.textContent || 'Custom route';
  const pct = [0, 0, 0]; pct[defaultCls] = 100;
  return { id, name: nm, color, custom: true, lengthM: L, startEndGapM: Math.round(hav(sp[0], sp.at(-1))), rawPoints: pts.length, pts: sp.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]), cum: cum.map((c) => Math.round(c * 10) / 10),
    terrain: [{ a: 0, b: L, cls: defaultCls, conf: 1, hw: '', surf: '', name: '', limit: null, why: 'imported GPX: single default terrain, edit in Terrain editor' }], stops: [], waypoints: wpts,
    stats: { lengthMi: +(L / 1609.344).toFixed(1), pct, miles: pct.map((p) => +(p / 100 * L / 1609.344).toFixed(1)), confPct: { high: 0, medium: 0, low: 100 }, clsConfPct: [], matchedPct: 0, stops: {} } };
}
