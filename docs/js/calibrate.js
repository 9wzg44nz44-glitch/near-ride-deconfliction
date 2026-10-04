// Reality check: compare an observed sighting (route + mile marker + approximate time + group) with the simulation.
// Pure functions so they can be unit tested in Node.
import { getGeom, MPH, CLS_NAMES } from './sim.js';
const MI = 1609.344;

function nearestCell(g, lat, lon, proj) {
  const [px, py] = proj(lat, lon);
  let bi = 0, bd = 1e30;
  for (let i = 0; i < g.n; i++) { const d = (g.cx[i] - px) ** 2 + (g.cy[i] - py) ** 2; if (d < bd) { bd = d; bi = i; } }
  return { cell: bi, distM: Math.sqrt(bd) };
}
const fwdMile = (path, cell) => (path.reverse ? path.L - cell * path.ds : cell * path.ds) / MI;

// obs: { routeId, mile, groupId, t (seconds or null), tolMin, heading: 'any'|'same'|'opposite' }
export function calibrateObservation(sims, routesById, obs, proj) {
  const route = routesById.get(obs.routeId);
  const out = { obs, ok: false, notes: [], flags: [] };
  if (!route) { out.error = 'Unknown route.'; return out; }
  const g = getGeom(route);
  const e = Math.max(0, Math.min(g.n - 1, Math.round(obs.mile * MI / g.ds)));
  out.lat = g.lat[e]; out.lon = g.lon[e];
  const seg = route.terrain.find((s) => e * g.ds >= s.a && e * g.ds < s.b) || route.terrain.at(-1);
  out.terrain = seg.cls; out.road = seg.name || '';
  const sim = sims.find((s) => s.grp.id === obs.groupId);
  if (!sim) { out.error = 'The observed group has no riders in the current scenario.'; return out; }
  out.groupName = sim.grp.name;
  const path = sim.path, gp = path.g;
  const near = nearestCell(gp, out.lat, out.lon, proj);
  out.offRouteM = Math.round(near.distM);
  if (near.distM > 150) { out.error = `${sim.grp.name}'s route does not pass within 150 m of that spot (nearest ${Math.round(near.distM)} m), so it cannot be there in the model.`; return out; }
  const bi = near.cell;
  out.groupMile = fwdMile(path, bi);
  // direction of the group's travel relative to the route the mile marker is on
  const dot = gp.tx[bi] * g.tx[e] + gp.ty[bi] * g.ty[e];
  out.direction = dot > 0.5 ? 'same' : dot < -0.5 ? 'opposite' : 'crossing';
  out.tHead = sim.t0 + sim.arr[bi];
  out.tTail = sim.t0 + sim.dep[bi] + sim.Ddep[bi];
  out.tMid = (out.tHead + out.tTail) / 2;
  out.windowMin = (out.tTail - out.tHead) / 60;
  // what the model spends before this point
  let stopped = 0; for (let i = 0; i < bi; i++) stopped += sim.dep[i] - sim.arr[i];
  const cls = [0, 0, 0]; for (let i = 0; i < bi; i++) cls[path.cls[i]]++;
  out.stoppedMin = stopped / 60; out.milesBefore = bi * path.ds / MI; out.classMiles = cls.map((c) => c * path.ds / MI);
  out.elapsedModelMin = (out.tMid - sim.t0) / 60;
  out.avgMphModel = (bi * path.ds / MI) / Math.max(0.01, (out.tHead - sim.t0 - stopped) / 3600);
  out.others = sims.filter((s) => s !== sim).map((s) => {
    const rel = obs.t == null ? out.tMid : obs.t;
    const r = Math.round(rel - s.t0);
    if (r < 0 || r > s.endRel) return { name: s.grp.name, state: r < 0 ? 'not started' : 'finished' };
    const hd = s.head[Math.min(r, s.len - 1)];
    return { name: s.grp.name, mile: fwdMile(s.path, Math.min(s.path.n, hd)), lat: null };
  });
  if (obs.t != null) {
    const tol = (obs.tolMin ?? 10) * 60;
    const r = Math.round(obs.t - sim.t0);
    out.modelHeadMileAtObs = r < 0 ? 0 : r > sim.endRel ? path.L / MI : fwdMile(path, sim.head[Math.min(r, sim.len - 1)]);
    out.modelTailMileAtObs = r < 0 ? 0 : r > sim.endRel ? path.L / MI : fwdMile(path, sim.tail[Math.min(r, sim.len - 1)]);
    let delta = 0;
    if (obs.t < out.tHead - tol) delta = obs.t - out.tHead + tol; else if (obs.t > out.tTail + tol) delta = obs.t - out.tTail - tol;
    out.deltaSec = delta; out.deltaRawSec = obs.t < out.tHead ? obs.t - out.tHead : obs.t > out.tTail ? obs.t - out.tTail : 0;
    out.consistent = delta === 0;
    // implied shift of the whole group, and implied pace (elapsed time model / elapsed time observed)
    out.impliedShiftMin = out.deltaRawSec / 60;
    const obsElapsed = obs.t - sim.t0, modelElapsed = out.tMid - sim.t0;
    out.impliedPace = obsElapsed > 60 ? modelElapsed / obsElapsed : null;
    out.impliedDelayMin = Math.max(0, out.deltaRawSec / 60);
  }
  // assumption flags
  if (obs.heading && obs.heading !== 'any' && out.direction !== obs.heading) out.flags.push(`Direction disagrees: you saw them heading ${obs.heading} to the route's mileage, but in the model ${sim.grp.name} passes this spot ${out.direction === 'crossing' ? 'crossing' : 'heading ' + out.direction}. Check the group's Direction setting.`);
  if (obs.t != null && !out.consistent) {
    const late = out.deltaSec > 0, m = Math.abs(out.deltaRawSec / 60);
    out.flags.push(`Timing disagrees by about ${m.toFixed(0)} min: the model has ${sim.grp.name} at this spot from ${fmt(out.tHead)} to ${fmt(out.tTail)}, you saw them at ${fmt(obs.t)}.`);
    if (late) out.flags.push(`The group was later than modeled. Candidates: a later real departure, slower riding (the Class VI average, ${out.classMiles[2].toFixed(1)} mi of Class VI before this point), or more stopping than the ${out.stoppedMin.toFixed(0)} min of stops the model has before it.`);
    else out.flags.push(`The group was earlier than modeled. Candidates: an earlier real departure, faster riding (the model averages ${out.avgMphModel.toFixed(0)} mph while moving to here), or fewer stops than the ${out.stoppedMin.toFixed(0)} min the model has before it.`);
  } else if (obs.t != null) out.flags.push('Timing is consistent with the model within your tolerance.');
  if (out.windowMin > 8) out.flags.push(`The modeled column takes ${out.windowMin.toFixed(0)} min to pass this spot (including any stop there), so a sighting anywhere in that window fits.`);
  out.ok = true;
  return out;
}
const fmt = (t) => { const h = Math.floor(t / 3600) % 24, m = Math.floor((t % 3600) / 60); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
