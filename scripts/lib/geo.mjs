// Shared geometry helpers (flat-earth local projection is accurate enough at NH scale).
export const R = 6371008.8;
export const toRad = (d) => (d * Math.PI) / 180;
export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
// Equirectangular projection around a reference latitude, returns metres.
export function makeProj(lat0) {
  const kx = (Math.PI / 180) * R * Math.cos(toRad(lat0));
  const ky = (Math.PI / 180) * R;
  return (lat, lon) => [lon * kx, lat * ky];
}
export function distPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { d: Math.hypot(px - cx, py - cy), t };
}
// Douglas-Peucker on projected points; returns kept indices.
export function simplifyIdx(pts, tol) {
  const n = pts.length;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let md = -1, mi = -1;
    for (let i = s + 1; i < e; i++) {
      const { d } = distPointSeg(pts[i][0], pts[i][1], pts[s][0], pts[s][1], pts[e][0], pts[e][1]);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([s, mi], [mi, e]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}
