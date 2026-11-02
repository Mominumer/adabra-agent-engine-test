import { getStop, isStopResponse, renewClaim } from './claims.js';
import { flush } from './sender.js';
import { operatorText } from '../shared/sanitize.js';

// One pass of the background agent: keep every held lease alive, then deliver queued checkpoints.
//
// Renewal outcomes:
//   ok                         -> remember the new expiry
//   404/403/409 (refused)      -> the claim is gone (expired, released, cancelled, taken over): drop it and notify
//   401, 5xx, network error    -> keep the claim and try again next pass; give up only when the lease would have
//                                 expired locally, because after that the coordinator fences us anyway
//   503 `stopped`              -> the operator's emergency stop. The claim stays ours and the coordinator keeps its lease alive,
//                                 so it is never given up. While a stop is known, an unreachable coordinator does not end it either:
//                                 if the lease really did go, the coordinator says so when it answers, and the owner is told then.
// `memory` lasts between passes: it is how the owner gets told once when a stop begins and once when it ends.
export async function tick({ claims, outbox, cfg, now = Date.now(), log = () => {}, notify = () => {}, memory = {} }) {
  const auth = { url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token };
  const summary = { renewed: [], lost: [], retrying: [], paused: [] };

  let stop = memory.stop ?? null;
  try {
    const r = await getStop(auth);
    if (r.ok) stop = r.data.stopped ? r.data : null;
    else if (r.status === 404) stop = null; // a coordinator older than this helper has no stop
  } catch {
    // Unreachable: what was last known stands.
  }

  for (const [taskId, claim] of Object.entries(claims.all())) {
    let r;
    try {
      r = await renewClaim(auth, taskId, claim.run_id, claim.generation);
    } catch (err) {
      r = { ok: false, status: 0, data: { error: `network: ${err.cause?.code ?? err.message}` } };
    }
    if (r.ok) {
      stop = null;
      claims.set(taskId, { ...claim, expires_at: r.data.expires_at });
      summary.renewed.push(taskId);
    } else if (isStopResponse(r)) {
      stop = r.data;
      if (r.data.expires_at) claims.set(taskId, { ...claim, expires_at: r.data.expires_at });
      summary.paused.push(taskId);
    } else if ([403, 404, 409].includes(r.status)) {
      claims.remove(taskId);
      summary.lost.push({ task_id: taskId, reason: r.data.error ?? `http ${r.status}` });
      notify(`Lost ${taskId}`, `${r.data.error ?? `http ${r.status}`}. Stop work on it: output will be rejected.`);
    } else if (!stop && now >= claim.expires_at) {
      claims.remove(taskId);
      summary.lost.push({ task_id: taskId, reason: 'could not reach the coordinator before the lease ran out' });
      notify(`Lost ${taskId}`, 'The lease ran out while the coordinator was unreachable. Re-claim before continuing.');
    } else {
      summary.retrying.push(taskId);
      log(`renew ${taskId}: ${r.data.error ?? `http ${r.status}`}, will retry`);
    }
  }

  // Skipped while stopped, so that checkpoints build up no backoff and go in the first pass after resume.
  const sent = stop
    ? { acked: 0, rejected: 0, retry: 0, stopped: stop }
    : await flush({ outbox, url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token, now, log });
  if (sent.stopped) stop = sent.stopped;

  if (stop && !memory.stop) {
    const held = Object.keys(claims.all());
    notify(
      'Stopped by the operator',
      `${operatorText(stop.reason)}. Stop work. ${held.length ? `Your claims are kept (${held.join(', ')}). ` : ''}Checkpoints wait until the operator resumes.`,
    );
  }
  if (!stop && memory.stop) notify('Resumed', 'The operator resumed. Claims are renewing and queued checkpoints are being delivered.');
  memory.stop = stop;
  return { ...summary, sent, stop };
}
