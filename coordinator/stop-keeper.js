import { readStop, watchStop } from '../shared/stop.js';

// While a stop is in force renewals are refused, and that must not cost anyone their claim or let another device take the task
// on resume. So the coordinator itself keeps alive every lease that was live when the stop began. If the file cannot say when
// that was, it keeps the ones live now.
export function keepLeasesWhileStopped({ store, leaseMs, read = readStop, intervalMs = 5000, now = () => Date.now(), log = () => {} }) {
  return watchStop({
    read,
    intervalMs,
    log,
    whileStopped: (s) => {
      const t = now();
      store.holdLeases(s.since ? Date.parse(s.since) : t, t, leaseMs);
    },
  });
}
