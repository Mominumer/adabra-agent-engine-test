import { renewClaim } from './claims.js';
import { flush } from './sender.js';

// One pass of the background agent: keep every held lease alive, then deliver queued checkpoints.
//
// Renewal outcomes:
//   ok                         -> remember the new expiry
//   404/403/409 (refused)      -> the claim is gone (expired, released, cancelled, taken over): drop it and notify
//   401, 5xx, network error    -> keep the claim and try again next pass; give up only when the lease would have
//                                 expired locally, because after that the coordinator fences us anyway
export async function tick({ claims, outbox, cfg, now = Date.now(), log = () => {}, notify = () => {} }) {
  const auth = { url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token };
  const summary = { renewed: [], lost: [], retrying: [] };

  for (const [taskId, claim] of Object.entries(claims.all())) {
    let r;
    try {
      r = await renewClaim(auth, taskId, claim.run_id, claim.generation);
    } catch (err) {
      r = { ok: false, status: 0, data: { error: `network: ${err.cause?.code ?? err.message}` } };
    }
    if (r.ok) {
      claims.set(taskId, { ...claim, expires_at: r.data.expires_at });
      summary.renewed.push(taskId);
    } else if ([403, 404, 409].includes(r.status)) {
      claims.remove(taskId);
      summary.lost.push({ task_id: taskId, reason: r.data.error ?? `http ${r.status}` });
      notify(`Lost ${taskId}`, `${r.data.error ?? `http ${r.status}`}. Stop work on it: output will be rejected.`);
    } else if (now >= claim.expires_at) {
      claims.remove(taskId);
      summary.lost.push({ task_id: taskId, reason: 'could not reach the coordinator before the lease ran out' });
      notify(`Lost ${taskId}`, 'The lease ran out while the coordinator was unreachable. Re-claim before continuing.');
    } else {
      summary.retrying.push(taskId);
      log(`renew ${taskId}: ${r.data.error ?? `http ${r.status}`}, will retry`);
    }
  }

  const sent = await flush({ outbox, url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token, now, log });
  return { ...summary, sent };
}
