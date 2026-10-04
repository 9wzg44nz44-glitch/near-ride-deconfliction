// Lists every stretch where two routes run within a threshold of each other, with miles on each route,
// direction relationship and terrain. Usage: node scripts/overlap-report.mjs [routeA] [routeB] [thresholdM]
import fs from 'node:fs';
import * as S from '../docs/js/sim.js';
const [A = 'mbh', B = 'sbh', thr = '30'] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(new URL('../docs/data/routes.json', import.meta.url), 'utf8'));
const ctx = S.makeContext(d.routes);
const ra = ctx.byId.get(A), rb = ctx.byId.get(B);
const pa = S.buildPath(ra, {}), pb = S.buildPath(rb, {});
const adj = S.buildAdjacency(pa, pb, +thr);
const MI = 1609.344;
// per A-cell: list of B-cells in contact (take the nearest-by-index run start/end)
const rows = [];
for (let i = 0; i < pa.n; i++) {
  for (let r = adj.ptr[i]; r < adj.ptr[i + 1]; r++) rows.push({ i, lo: adj.lo[r], hi: adj.hi[r] });
}
// cluster consecutive A cells whose B ranges overlap/continue
const stretches = [];
for (const r of rows) {
  const dot0 = (j) => pa.g.tx[r.i] * pb.g.tx[j] + pa.g.ty[r.i] * pb.g.ty[j];
  const j = Math.round((r.lo + r.hi) / 2);
  const last = stretches.find((s) => r.i - s.iEnd <= 3 && Math.abs(j - s.jEnd) <= 10);
  if (last) { last.iEnd = r.i; last.jEnd = j; last.jMin = Math.min(last.jMin, r.lo); last.jMax = Math.max(last.jMax, r.hi); last.dots.push(dot0(j)); last.cls.push(pa.cls[r.i]); }
  else stretches.push({ iStart: r.i, iEnd: r.i, jStart: j, jEnd: j, jMin: r.lo, jMax: r.hi, dots: [dot0(j)], cls: [pa.cls[r.i]] });
}
const out = stretches.map((s) => {
  const dot = s.dots.reduce((a, b) => a + b, 0) / s.dots.length;
  const cls = [0, 0, 0]; s.cls.forEach((c) => cls[c]++);
  const [lat, lon] = S.edgeLatLon(pa, (s.iStart + s.iEnd) / 2);
  return { aFrom: s.iStart * pa.ds / MI, aTo: (s.iEnd + 1) * pa.ds / MI, bFrom: s.jStart * pb.ds / MI, bTo: (s.jEnd + 1) * pb.ds / MI, lenM: (s.iEnd - s.iStart + 1) * pa.ds, rel: dot > 0.5 ? 'same' : dot < -0.5 ? 'opposite' : 'crossing', terrain: S.CLS_NAMES[cls.indexOf(Math.max(...cls))], lat, lon };
}).filter((s) => s.lenM >= 0);
console.log(`${A} (miles) vs ${B} (miles), threshold ${thr} m`);
for (const s of out) console.log(`${A} ${s.aFrom.toFixed(2)}-${s.aTo.toFixed(2)} | ${B} ${s.bFrom.toFixed(2)}-${s.bTo.toFixed(2)} | ${s.lenM.toFixed(0)} m | ${s.rel} | ${s.terrain} | ${s.lat.toFixed(5)},${s.lon.toFixed(5)}`);
