// Web Worker: heavy jobs (start-time optimiser, Monte Carlo forecast) off the UI thread.
import * as S from './sim.js';
let ctx = null;
self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') { ctx = S.makeContext(m.routes); self.postMessage({ type: 'ready' }); }
    else if (m.type === 'optimize') { self.postMessage({ type: 'result', id: m.id, result: S.optimize(ctx, m.scenario, m.locked) }); }
    else if (m.type === 'mc') {
      const r = S.monteCarlo(ctx, m.scenario, m.runs, m.seed || 12345, (p) => self.postMessage({ type: 'progress', id: m.id, p }));
      self.postMessage({ type: 'result', id: m.id, result: r });
    }
  } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) }); }
};
