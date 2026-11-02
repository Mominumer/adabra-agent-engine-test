import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { plain } from '../shared/sanitize.js';
import { isSafePath, LIMITS, SEVERITIES, validateReviewResult } from '../shared/review-result.js';

// Tells the coordinator how a review of a task's PR went. The reviewer talks to the coordinator as its own enrolled device
// with its own token; the coordinator alone holds the GitHub token that writes to the task's issue. Runs entirely after,
// and apart from, the commit statuses: nothing here can delay or change adabra/tests or adabra/review.

const BRANCH_RE = /^task\/(TASK-[1-9]\d{0,8})$/;
const BODY_LINE_RE = /^Task: (TASK-[1-9]\d{0,8})[ \t]*$/;
const DEVICE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Branch names and descriptions are untrusted, so only exact forms count: branch `task/TASK-7`, or a line reading exactly
// `Task: TASK-7` in the description. If they name different tasks nothing is linked: guessing could mark the wrong task.
// Returns { task_id, why }; `why` holds only ids the patterns above have accepted, so it is safe to log.
export function parseTaskId({ branch, body } = {}) {
  const ids = new Set();
  const fromBranch = typeof branch === 'string' ? branch.match(BRANCH_RE) : null;
  if (fromBranch) ids.add(fromBranch[1]);
  if (typeof body === 'string') {
    for (const line of body.split(/\r?\n/)) {
      const m = line.match(BODY_LINE_RE);
      if (m) ids.add(m[1]);
    }
  }
  if (ids.size > 1) return { task_id: null, why: `the PR names more than one task (${[...ids].join(', ')})` };
  return { task_id: [...ids][0] ?? null, why: null };
}

const clip = (s, max) => plain(s ?? '').slice(0, max).toWellFormed();

// The message for the coordinator. Everything from the review is brought within the schema, so the coordinator never has to
// refuse it: a severity not on the list becomes 'other', a path that could carry a sentence is dropped, and text is clipped.
// Keeping that text inert is up to whoever shows it. Worst findings first, as only some are sent.
export function buildResult({ taskId, job, tests, review, now }) {
  const all = (Array.isArray(review.findings) ? review.findings : []).filter((f) => f && typeof f === 'object');
  const blockersFirst = [...all].sort((a, b) => (b.severity === 'blocker') - (a.severity === 'blocker'));
  const result = {
    result_id: randomUUID(),
    task_id: taskId,
    pr: job.pr,
    sha: job.sha,
    tests: tests.state,
    review: review.state,
    tests_summary: clip(tests.summary, LIMITS.summary),
    review_summary: clip(review.summary, LIMITS.summary),
    findings: blockersFirst.slice(0, LIMITS.findings).map((f) => ({
      severity: f.severity == null ? 'note' : SEVERITIES.includes(f.severity) ? f.severity : 'other',
      file: isSafePath(f.file) ? f.file : null,
      line: isSafePath(f.file) && Number.isSafeInteger(f.line) && f.line >= 1 ? f.line : null,
      message: clip(f.message, LIMITS.message),
    })),
    findings_total: all.length,
    reviewer: /^[A-Za-z0-9._-]{1,40}$/.test(review.reviewer ?? '') ? review.reviewer : null,
    commit_seen_at: job.created_at,
    reviewed_at: now,
  };
  const errors = validateReviewResult(result);
  if (errors.length) throw new Error(errors.join('; '));
  return result;
}

// Whether this reviewer has a device identity. { off: reason } means reviews run exactly as they would without this feature.
export function deliveryConfig(env = process.env, home = homedir()) {
  const deviceId = (env.REVIEW_DEVICE_ID ?? '').trim();
  if (!deviceId) return { off: 'REVIEW_DEVICE_ID is not set' };
  if (!DEVICE_RE.test(deviceId)) return { off: 'REVIEW_DEVICE_ID is not a valid device id' };
  const url = (env.REVIEW_COORDINATOR_URL ?? '').trim();
  if (!url) return { off: 'REVIEW_COORDINATOR_URL is not set' };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { off: 'REVIEW_COORDINATOR_URL is not a valid URL' };
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname))) {
    return { off: 'REVIEW_COORDINATOR_URL must be https, or http to this machine' }; // the device token would travel in clear
  }
  const tokenFile = env.REVIEW_DEVICE_TOKEN_FILE?.trim() || join(home, '.adabra', 'reviewer-device-token');
  if (!existsSync(tokenFile)) return { off: `device token file ${tokenFile} does not exist` };
  return { deviceId, url, origin: parsed.origin, tokenFile };
}

// Sends due results to the coordinator.
// 2xx                 -> acknowledged (stored durably, or already known, or older than what the task shows)
// 400/409/413/422     -> rejected, will not be retried (retrying cannot help; e.g. no such task)
// 401/403             -> kept pending: a token or enrolment problem a human must fix, and fixing it must lose nothing
// network, 404, 5xx.. -> kept pending with backoff, for as long as it takes
// A pass stops at the first of the last two: every other result would meet the same problem.
export async function deliverResults({ store, url, deviceId, token, now = Date.now(), timeoutMs = 5000, log = () => {} }) {
  const results = { acked: 0, rejected: 0, retry: 0 };
  for (const row of store.dueTaskResults(now)) {
    const label = `task result ${row.task_id} PR #${row.pr} ${row.sha.slice(0, 12)}`;
    let res;
    try {
      res = await fetch(`${url.replace(/\/$/, '')}/v1/review-results`, {
        method: 'POST',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', 'x-device-id': deviceId, authorization: `Bearer ${token}` },
        body: row.payload,
      });
    } catch (err) {
      const why = err.cause?.code ?? err.name;
      store.retryTaskResult(row.result_id, `network: ${why}`, now);
      results.retry++;
      log(`${label}: coordinator unreachable (${why}), will retry`);
      break;
    }
    const text = await res.text().catch(() => '');
    if (res.ok) {
      store.ackTaskResult(row.result_id);
      results.acked++;
      log(`${label}: delivered`);
    } else if ([400, 409, 413, 422].includes(res.status)) {
      store.rejectTaskResult(row.result_id, `${res.status} ${text.slice(0, 200)}`);
      results.rejected++;
      log(`${label}: REJECTED by the coordinator, not retried: ${res.status} ${text.slice(0, 200)}`);
    } else {
      store.retryTaskResult(row.result_id, `http ${res.status}`, now);
      results.retry++;
      const hint = [401, 403].includes(res.status) ? ': check the reviewer device id, token and role' : '';
      log(`${label}: http ${res.status}${hint}, will retry`);
      break;
    }
  }
  return results;
}

// Turns delivery on or off and says which. Delivery has its own timer, so a slow or absent coordinator never holds up the
// review loop, and a 15-minute test run never holds up delivery.
export function startTaskResults({ store, env = process.env, home = homedir(), log = () => {} }) {
  const cfg = deliveryConfig(env, home);
  if (cfg.off) {
    log(`task results: off (${cfg.off}); reviews run as usual, tasks are not told the outcome`);
    return { linkTasks: false, stop: () => {} };
  }
  log(`task results: on, device ${cfg.deviceId}, coordinator ${cfg.origin}`);
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try {
      if (!store.dueTaskResults(Date.now()).length) return;
      const token = readFileSync(cfg.tokenFile, 'utf8').trim(); // read each time, so a rotated token needs no restart
      await deliverResults({ store, url: cfg.url, deviceId: cfg.deviceId, token, log });
    } catch (err) {
      log(`task results: delivery pass failed, will retry: ${err.code ?? err.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void pass(), Number(env.REVIEW_DELIVERY_MS) || 5000);
  timer.unref?.();
  return { linkTasks: true, pass, stop: () => clearInterval(timer) };
}
