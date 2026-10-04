// Stage 1: GPX -> simplified route geometry + waypoints (data/routes-geom.json)
import fs from 'node:fs';
import { haversine, makeProj, simplifyIdx } from './lib/geo.mjs';

const ROUTES = [
  { id: 'sbh', file: 'sbh-monadnock.gpx', name: 'SBH Monadnock', color: '#e6194b' },
  { id: 'mbh', file: 'mbh-monadnock.gpx', name: 'MBH Monadnock', color: '#4363d8' },
];
const TOL = 2.5; // metres, Douglas-Peucker tolerance
const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

function classifyWpt(name, desc, sym) {
  const t = `${name} ${desc} ${sym}`.toLowerCase();
  const kinds = [];
  if (/\bgas\b|gas station|fuel/.test(t)) kinds.push('gas');
  if (/food|lunch|restaurant|tavern|taco|dunkin|provision|sandwich/.test(t)) kinds.push('food');
  if (/extreme|danger|death|slow|dangerous|pipe of doom|hardest|obstacle|drop/.test(t)) kinds.push('hazard');
  if (/gate/.test(t)) kinds.push('gate');
  if (/break|rest stop|smoke|swimming|recollect|parking/.test(t)) kinds.push('break');
  if (/start/.test(t)) kinds.push('start');
  if (/jeep trail|class vi|class 6|cellar hole/.test(t)) kinds.push('classvi-hint');
  return kinds;
}

const out = [];
for (const r of ROUTES) {
  const xml = fs.readFileSync(new URL(`../raw/${r.file}`, import.meta.url), 'utf8');
  const wpts = [];
  for (const m of xml.matchAll(/<wpt lat="([-\d.]+)" lon="([-\d.]+)">([\s\S]*?)<\/wpt>/g)) {
    const g = (tag) => { const x = m[3].match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return x ? decode(x[1]) : ''; };
    const name = g('name'), desc = g('desc'), sym = g('sym');
    wpts.push({ lat: +m[1], lon: +m[2], name, desc, sym, kinds: classifyWpt(name, desc, sym) });
  }
  const trk = xml.slice(xml.indexOf('<trk>'));
  const segs = [...trk.matchAll(/<trkseg>([\s\S]*?)<\/trkseg>/g)].map((s) => [...s[1].matchAll(/<trkpt lat="([-\d.]+)" lon="([-\d.]+)"(?:\/>|>([\s\S]*?)<\/trkpt>)/g)].map((p) => {
    const ele = p[3] && p[3].match(/<ele>([-\d.]+)<\/ele>/);
    return [+p[1], +p[2], ele ? +ele[1] : null];
  }));
  // Use the longest <trkseg> only (some exports carry a tiny stub track far from the real route).
  const lens = segs.map((sg) => sg.length);
  const main = segs[lens.indexOf(Math.max(...lens))];
  const dropped = segs.length - 1;
  const all = main;
  const gaps = [];
  const proj = makeProj(all[0][0]);
  const xy = all.map((p) => proj(p[0], p[1]));
  const idx = simplifyIdx(xy, TOL);
  const pts = idx.map((i) => all[i]);
  // cumulative distance (m)
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
  // attach waypoints to nearest track point (distance along track)
  for (const w of wpts) {
    let best = Infinity, bi = 0;
    for (let i = 0; i < pts.length; i++) {
      const d = haversine([w.lat, w.lon], pts[i]);
      if (d < best) { best = d; bi = i; }
    }
    w.distAlong = Math.round(cum[bi]); w.offTrack = Math.round(best);
  }
  wpts.sort((a, b) => a.distAlong - b.distAlong);
  const startEnd = Math.round(haversine(all[0], all.at(-1)));
  console.log(`${r.id}: raw ${all.length} -> ${pts.length} pts, ${(cum.at(-1) / 1609.344).toFixed(1)} mi, dropped stubs ${dropped}, start-end gap ${startEnd} m, wpts ${wpts.length}`);
  out.push({ id: r.id, name: r.name, color: r.color, sourceFile: r.file, rawPoints: all.length, droppedStubTracks: dropped, startEndGapM: startEnd, lengthM: Math.round(cum.at(-1)), pts: pts.map((p) => [+p[0].toFixed(6), +p[1].toFixed(6), p[2] == null ? null : Math.round(p[2])]), cum: cum.map((c) => Math.round(c * 10) / 10), waypoints: wpts });
}
fs.writeFileSync(new URL('../data/routes-geom.json', import.meta.url), JSON.stringify(out));
console.log('wrote data/routes-geom.json', (fs.statSync(new URL('../data/routes-geom.json', import.meta.url)).size / 1024).toFixed(0), 'KB');
