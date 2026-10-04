// Stage 2: download OpenStreetMap ways + stop/yield/signal nodes near the routes via Overpass.
// No API key needed. Results cached per tile in data/osm-cache/ (so stage 3 is reproducible offline).
// Data (c) OpenStreetMap contributors, ODbL 1.0.
import fs from 'node:fs';

const routes = JSON.parse(fs.readFileSync(new URL('../data/routes-geom.json', import.meta.url), 'utf8'));
const MIRRORS = (process.env.OVERPASS || 'https://overpass.openstreetmap.fr/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter,https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter').split(',');
const DLAT = 0.04, DLON = 0.055, PAD = 0.0006;
const dir = new URL('../data/osm-cache/', import.meta.url);
fs.mkdirSync(dir, { recursive: true });

const tiles = new Map();
for (const r of routes) for (const p of r.pts) {
  const i = Math.floor(p[0] / DLAT), j = Math.floor(p[1] / DLON);
  tiles.set(`${i}_${j}`, [i, j]);
  // also mark neighbours if the point is within PAD of a tile edge
  const fi = p[0] / DLAT - i, fj = p[1] / DLON - j;
  const ni = fi < PAD / DLAT ? i - 1 : fi > 1 - PAD / DLAT ? i + 1 : i;
  const nj = fj < PAD / DLON ? j - 1 : fj > 1 - PAD / DLON ? j + 1 : j;
  if (ni !== i) tiles.set(`${ni}_${j}`, [ni, j]);
  if (nj !== j) tiles.set(`${i}_${nj}`, [i, nj]);
  if (ni !== i && nj !== j) tiles.set(`${ni}_${nj}`, [ni, nj]);
}
console.log('tiles needed:', tiles.size);

const query = (s, w, n, e) => `[out:json][timeout:120];
(
  way["highway"]["highway"!~"^(footway|steps|cycleway|pedestrian|corridor|elevator|proposed|construction|bus_stop|platform)$"](${s},${w},${n},${e});
);
out body geom;
(
  node["highway"~"^(stop|give_way|traffic_signals)$"](${s},${w},${n},${e});
  node["railway"="level_crossing"](${s},${w},${n},${e});
);
out;`;

async function fetchTile(key, [i, j]) {
  const file = new URL(`tile_${key}.json`, dir);
  if (fs.existsSync(file)) return 'cached';
  const s = i * DLAT - PAD, n = (i + 1) * DLAT + PAD, w = j * DLON - PAD, e = (j + 1) * DLON + PAD;
  const q = query(s.toFixed(5), w.toFixed(5), n.toFixed(5), e.toFixed(5));
  for (let attempt = 0; attempt < 8; attempt++) {
    const m = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(m, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'near-ride-deconfliction/1.0 (route preprocessing; BrittonSolutions@icloud.com)' }, signal: AbortSignal.timeout(150000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const js = await res.json();
      js.elements = js.elements.map((x) => {
        if (x.tags) { const t = {}; for (const [k, v] of Object.entries(x.tags)) if (!/^(tiger:|source|created_by|nhd:|gnis:|massgis:|ref:|wikidata|wikipedia|note:|fixme)/i.test(k)) t[k] = v; x.tags = t; }
        delete x.bounds; delete x.timestamp; delete x.version; delete x.changeset; delete x.user; delete x.uid;
        return x;
      });
      fs.writeFileSync(file, JSON.stringify({ tile: key, bbox: [s, w, n, e], timestamp: js.osm3s?.timestamp_osm_base, elements: js.elements }));
      return `ok ${js.elements.length} via ${new URL(m).host}`;
    } catch (err) {
      console.log(`  retry ${key} (${err.message}) via ${new URL(m).host}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error('failed tile ' + key);
}

const queue = [...tiles.entries()];
let done = 0;
const worker = async () => {
  while (queue.length) {
    const [k, v] = queue.shift();
    const r = await fetchTile(k, v);
    done++;
    console.log(`[${done}/${tiles.size}] ${k} ${r}`);
  }
};
await Promise.all([worker(), worker(), worker()]);
