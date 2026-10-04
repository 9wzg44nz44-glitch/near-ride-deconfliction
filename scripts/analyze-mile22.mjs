// Investigation helper: where/when are SBH and MBH at MBH mile 22, and which observer rides reproduce meetings with SBH?
// Usage: node scripts/analyze-mile22.mjs
import fs from 'node:fs';
import * as S from '../docs/js/sim.js';
const d = JSON.parse(fs.readFileSync(new URL('../docs/data/routes.json', import.meta.url), 'utf8'));
const ctx = S.makeContext(d.routes);
const MI = 1609.344, MILE = 22;
const mbh = ctx.byId.get('mbh'), sbh = ctx.byId.get('sbh');
const sc = { groups: [{ id: 'sbh', routeId: 'sbh', name: 'SBH', n: 18, skill: 'intermediate', t0: 9 * 3600 }, { id: 'mbh', routeId: 'mbh', name: 'MBH', n: 7, skill: 'intermediate', t0: 9.5 * 3600 }] };
const { sims } = S.simulateScenario(ctx, sc);
const [sS, sM] = sims;
const eM = Math.round(MILE * MI / sM.ds);
const [lat, lon] = S.edgeLatLon(sM.path, eM);
const [px, py] = S.projectLatLon(lat, lon);
// nearest SBH cell
const g = sS.path.g; let bi = 0, bd = 1e12; for (let i = 0; i < g.n; i++) { const dd = (g.cx[i] - px) ** 2 + (g.cy[i] - py) ** 2; if (dd < bd) { bd = dd; bi = i; } }
const dot = sM.path.g.tx[eM] * g.tx[bi] + sM.path.g.ty[eM] * g.ty[bi];
console.log(`MBH mile ${MILE}: ${lat.toFixed(5)}, ${lon.toFixed(5)}; terrain ${S.CLS_NAMES[sM.path.cls[eM]]}; road ${mbh.terrain.find((t) => MILE * MI >= t.a && MILE * MI < t.b)?.name}`);
console.log(`nearest SBH point: mile ${(bi * sS.ds / MI).toFixed(2)}, ${Math.sqrt(bd).toFixed(0)} m away, direction ${dot > 0.5 ? 'same' : dot < -0.5 ? 'opposite' : 'crossing'}`);
const T = (sim, e) => ({ head: sim.t0 + sim.arr[e], tail: sim.t0 + sim.arr[e] + sim.Darr[e] });
const tm = T(sM, eM), ts = T(sS, bi);
console.log(`MBH (7, 9:30): head ${S.fmtClock(tm.head, true)}, tail ${S.fmtClock(tm.tail, true)}`);
console.log(`SBH (18, 9:00): head ${S.fmtClock(ts.head, true)}, tail ${S.fmtClock(ts.tail, true)}  (SBH is ${((tm.head - ts.tail) / 60).toFixed(1)} min clear ahead of the MBH leader)`);
// times at selected MBH miles
for (const m of [5, 9, 15, 22, 30, 40]) {
  const e = Math.round(m * MI / sM.ds); const [la, lo] = S.edgeLatLon(sM.path, e); const [x, y] = S.projectLatLon(la, lo);
  let b = 0, bdd = 1e12; for (let i = 0; i < g.n; i++) { const dd = (g.cx[i] - x) ** 2 + (g.cy[i] - y) ** 2; if (dd < bdd) { bdd = dd; b = i; } }
  console.log(`MBH mile ${m}: MBH ${S.fmtClock(T(sM, e).head)}; nearest SBH mile ${(b * sS.ds / MI).toFixed(1)} (${Math.sqrt(bdd).toFixed(0)} m): SBH head ${S.fmtClock(T(sS, b).head)} tail ${S.fmtClock(T(sS, b).tail)}`);
}
// SBH mile reached at 10:30 and 10:35
for (const t of [10 * 3600, 10.5 * 3600, 10.58 * 3600]) { const p = S.simAtTime(sS, t); const q = S.simAtTime(sM, t); console.log(S.fmtClock(t), 'SBH head mile', (p.head * sS.ds / MI).toFixed(1), 'tail', (p.tail * sS.ds / MI).toFixed(1), '| MBH head mile', (q.head * sM.ds / MI).toFixed(1), 'tail', (q.tail * sM.ds / MI).toFixed(1)); }
// observer sweep: all start times, forward/reverse on MBH, solo; list SBH meetings before 10:35
console.log('\nObserver (solo, intermediate) on MBH vs SBH 18 @ 9:00 (no MBH group):');
for (const reverse of [false, true]) for (const skill of ['intermediate', 'fast']) {
  const rows = [];
  for (let t0 = 7 * 3600; t0 <= 10.5 * 3600; t0 += 300) {
    const r = S.runScenario(ctx, { groups: [sc.groups[0], { id: 'obs', routeId: 'mbh', name: 'Dan', n: 1, skill, t0, reverse }] });
    const ev = r.events.filter((e) => e.tStart < 10.583 * 3600);
    if (ev.length) rows.push({ t0, ev });
  }
  console.log(`\n-- MBH ${reverse ? 'REVERSED' : 'forward'}, ${skill}: ${rows.length} start times give meetings before 10:35`);
  const best = rows.sort((a, b) => b.ev.length - a.ev.length).slice(0, 4);
  for (const b of best) console.log(`  start ${S.fmtClock(b.t0)}: ${b.ev.length} meetings -> ` + b.ev.map((e) => `${S.fmtClock(e.tStart)} ${e.rel}/${e.relRaw} ${S.CLS_NAMES[e.terrain]} MBHmi ${((e.routeA === 'mbh' ? e.distAFwd : e.distBFwd) / MI).toFixed(1)} SBHmi ${((e.routeA === 'sbh' ? e.distAFwd : e.distBFwd) / MI).toFixed(1)}`).join('; '));
}
