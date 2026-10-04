import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as S from '../docs/js/sim.js';

// synthetic straight route heading north along a meridian, all one terrain class
function straight(id, km, cls, limit = 0) {
  const lat0 = 43.0, lon = -72.0, dLat = (km * 1000) / 111195;
  const pts = [[lat0, lon], [lat0 + dLat, lon]];
  const lengthM = km * 1000;
  return { id, name: id, lengthM, pts, cum: [0, lengthM], terrain: [{ a: 0, b: lengthM, cls, conf: 3, limit: limit || null }], stops: [], waypoints: [] };
}
const grp = (id, routeId, n, t0, extra = {}) => ({ id, routeId, name: id, n, skill: 'intermediate', t0, ...extra });
const mphOf = (route, sim) => (route.lengthM / sim.endRel) / S.MPH;

test('terrain speed model: paved = limit + bonus', () => {
  const r = straight('p', 20, 0);
  const ctx = S.makeContext([r]);
  const { sims } = S.simulateScenario(ctx, { groups: [grp('a', 'p', 1, 0)], params: { useWaypointStops: false } });
  const mph = mphOf(r, sims[0]);
  assert.ok(mph > 40 && mph < 42.6, `paved avg ${mph.toFixed(1)} mph should be near 35+7.5`);
});

test('terrain speed model: maintained dirt default 25 + 7.5', () => {
  const r = straight('d', 20, 1);
  const { sims } = S.simulateScenario(S.makeContext([r]), { groups: [grp('a', 'd', 1, 0)] });
  const mph = mphOf(r, sims[0]);
  assert.ok(mph > 30 && mph < 32.6, `dirt avg ${mph.toFixed(1)}`);
});

test('terrain speed model: posted OSM limit is honoured', () => {
  const r = straight('d', 20, 1, 15);
  const { sims } = S.simulateScenario(S.makeContext([r]), { groups: [grp('a', 'd', 1, 0)] });
  const mph = mphOf(r, sims[0]);
  assert.ok(mph > 20 && mph < 22.6, `15 mph dirt avg ${mph.toFixed(1)} (expect ~22.5)`);
});

test('terrain speed model: Class VI intermediate ~16 mph, fast ~23.5 mph', () => {
  const r = straight('c', 30, 2);
  const ctx = S.makeContext([r]);
  const i = S.simulateScenario(ctx, { groups: [grp('a', 'c', 1, 0)] }).sims[0];
  const f = S.simulateScenario(ctx, { groups: [grp('a', 'c', 1, 0, { skill: 'fast' })] }).sims[0];
  assert.ok(Math.abs(mphOf(r, i) - 16) < 0.5, `int ${mphOf(r, i)}`);
  assert.ok(Math.abs(mphOf(r, f) - 23.5) < 0.7, `fast ${mphOf(r, f)}`);
});

test('column length grows with rider count and rough terrain', () => {
  const rp = straight('p', 20, 0), rc = straight('c', 20, 2);
  const ctx = S.makeContext([rp, rc]);
  const sp = S.simulateScenario(ctx, { groups: [grp('a', 'p', 18, 0)] }).sims[0];
  const sc = S.simulateScenario(ctx, { groups: [grp('a', 'c', 18, 0)] }).sims[0];
  const mid = (s) => Math.floor(s.endRel / 2);
  const lenP = (sp.head[mid(sp)] - sp.tail[mid(sp)]) * 10, lenC = (sc.head[mid(sc)] - sc.tail[mid(sc)]) * 10;
  assert.ok(lenP > 400 && lenP < 1000, `paved column ${lenP} m`);
  assert.ok(lenC > 0 && lenC / sc.path.n > 0, 'column positive');
  assert.ok((sc.Darr[sc.n >> 1]) > sp.Darr[sp.n >> 1], 'rougher terrain spreads the column in time');
});

test('stop sign adds delay and obeys braking limits', () => {
  const r = straight('p', 10, 0); r.stops = [{ d: 5000, kind: 'stop', fwd: true, rev: true }];
  const ctx = S.makeContext([r]);
  const a = S.simulateScenario(ctx, { groups: [grp('a', 'p', 1, 0)], params: { useStops: false } }).sims[0];
  const b = S.simulateScenario(ctx, { groups: [grp('a', 'p', 1, 0)] }).sims[0];
  assert.ok(b.endRel - a.endRel > 6 && b.endRel - a.endRel < 20, `stop cost ${b.endRel - a.endRel}s`);
  // speed at the stop edge is zero
  const e = Math.round(5000 / b.ds);
  assert.ok(b.dep[e] - b.arr[e] >= 1.9);
});

test('faster group overtakes slower group on Class VI (same direction)', () => {
  const r = straight('c', 40, 2);
  const ctx = S.makeContext([r]);
  const res = S.runScenario(ctx, { groups: [grp('slow', 'c', 5, 9 * 3600), grp('fast', 'c', 5, 9 * 3600 + 600, { skill: 'fast' })] });
  assert.equal(res.events.length, 1);
  const e = res.events[0];
  assert.equal(e.rel, 'overtake'); assert.equal(e.overtaker, 'fast'); assert.equal(e.terrain, 2); assert.equal(e.relRaw, 'same');
  assert.equal(e.level, 'high');
  const q = S.answerQuestion(res.events, { x: 'fast', y: 'slow', terrain: 2, from: 9 * 3600, to: 12 * 3600 });
  assert.ok(q.yes);
  const q2 = S.answerQuestion(res.events, { x: 'slow', y: 'fast', terrain: 2, from: 9 * 3600, to: 12 * 3600 });
  assert.ok(!q2.yes);
});

test('same speed, staggered start: no encounter', () => {
  const r = straight('p', 30, 0);
  const res = S.runScenario(S.makeContext([r]), { groups: [grp('a', 'p', 8, 8 * 3600), grp('b', 'p', 8, 8 * 3600 + 1800)] });
  assert.equal(res.events.length, 0);
});

test('opposite directions on one road produce a head-on meeting near the middle', () => {
  const r = straight('p', 30, 0);
  const res = S.runScenario(S.makeContext([r]), { groups: [grp('a', 'p', 3, 9 * 3600), grp('b', 'p', 3, 9 * 3600, { reverse: true })] });
  assert.equal(res.events.length, 1);
  const e = res.events[0];
  assert.equal(e.rel, 'opposite'); assert.equal(e.terrain, 0);
  assert.ok(Math.abs(e.distAFwd - 15000) < 3500, `meeting at ${e.distAFwd}`);
  assert.equal(e.level, 'low');
});

test('crossing routes are detected as crossing / merge', () => {
  const a = straight('a', 10, 0);
  // east-west road crossing the middle of route a
  const lat = 43.0 + 5000 / 111195, kx = 111195 * Math.cos(43.0 * Math.PI / 180);
  const dLon = 5000 / kx;
  const b = { id: 'b', name: 'b', lengthM: 10000, pts: [[lat, -72.0 - dLon], [lat, -72.0 + dLon]], cum: [0, 10000], terrain: [{ a: 0, b: 10000, cls: 0, conf: 3, limit: null }], stops: [], waypoints: [] };
  const res = S.runScenario(S.makeContext([a, b]), { groups: [grp('ga', 'a', 1, 9 * 3600), grp('gb', 'b', 1, 9 * 3600)] });
  // identical speed profiles and 5 km to the crossing: both arrive together
  assert.ok(res.events.length >= 1);
  assert.equal(res.events[0].relRaw, 'crossing');
});

test('terrain override changes the simulated timing', () => {
  const r = straight('p', 20, 0);
  const ctx = S.makeContext([r]);
  const base = S.simulateScenario(ctx, { groups: [grp('a', 'p', 1, 0)] }).sims[0];
  const ovr = S.simulateScenario(ctx, { groups: [grp('a', 'p', 1, 0)], overrides: { p: [{ a: 5000, b: 15000, cls: 2 }] } }).sims[0];
  assert.ok(ovr.endRel > base.endRel + 100);
});

test('optimizer finds a conflict-free stagger for an overtaking pair', () => {
  const r = straight('c', 40, 2);
  const ctx = S.makeContext([r]);
  const sc = { groups: [grp('slow', 'c', 5, 9 * 3600), grp('fast', 'c', 5, 9 * 3600 + 600, { skill: 'fast' })] };
  const res = S.optimize(ctx, sc, ['slow']);
  assert.ok(res.before.count >= 1);
  assert.equal(res.after[0].count, 0);
  assert.ok(res.after[0].groups.find((g) => g.id === 'fast').t0 !== sc.groups[1].t0);
});

test('Monte Carlo gives probabilities between 0 and 1', () => {
  const r = straight('c', 40, 2);
  const ctx = S.makeContext([r]);
  const mc = S.monteCarlo(ctx, { groups: [grp('slow', 'c', 5, 9 * 3600), grp('fast', 'c', 5, 9 * 3600 + 600, { skill: 'fast' })] }, 20, 7);
  assert.ok(mc.clusters.length >= 1);
  for (const c of mc.clusters) assert.ok(c.prob >= 0 && c.prob <= 1);
  assert.ok(mc.clusters[0].prob > 0.8);
});

test('real data: default SBH 18 @ 9:00 vs MBH 7 @ 9:30 runs and is deterministic', () => {
  const d = JSON.parse(fs.readFileSync(new URL('../docs/data/routes.json', import.meta.url), 'utf8'));
  assert.deepEqual(d.routes.map((r) => r.id), ['sbh', 'mbh']);
  const ctx = S.makeContext(d.routes);
  const sc = { groups: [grp('sbh', 'sbh', 18, 9 * 3600), grp('mbh', 'mbh', 7, 9.5 * 3600)] };
  const a = S.runScenario(ctx, sc), b = S.runScenario(ctx, sc);
  assert.equal(JSON.stringify(a.events.map((e) => [e.tStart, e.tEnd, e.rel])), JSON.stringify(b.events.map((e) => [e.tStart, e.tEnd, e.rel])));
  for (const s of a.sims) assert.ok(s.endRel > 3 * 3600 && s.endRel < 10 * 3600, 'ride duration plausible: ' + s.endRel);
  // terrain shares add to 100 %
  for (const r of d.routes) assert.ok(Math.abs(r.stats.pct.reduce((x, y) => x + y, 0) - 100) < 0.3);
});
