import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// What this device believes it holds, kept in $TEAM_AGENT_HOME/claims.json.
// The coordinator is the authority; this file only remembers run id and generation between commands.
export class ClaimFile {
  constructor(home) {
    this.path = join(home, 'claims.json');
  }

  #read() {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {};
  }

  all() {
    return this.#read();
  }

  get(taskId) {
    return this.#read()[taskId] ?? null;
  }

  // Written to a temp file and renamed so the background agent and the CLI never see a half-written file.
  #write(all) {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  set(taskId, claim) {
    const all = this.#read();
    all[taskId] = claim;
    this.#write(all);
  }

  remove(taskId) {
    const all = this.#read();
    delete all[taskId];
    this.#write(all);
  }
}

export const newRunId = () => `RUN-${randomUUID().slice(0, 8)}`;

async function call({ url, deviceId, token, path, body, timeoutMs = 5000 }) {
  const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'content-type': 'application/json', 'x-device-id': deviceId, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

export const claimTask = (cfg, taskId, runId) =>
  call({ ...cfg, path: '/v1/claims', body: { task_id: taskId, run_id: runId } });
export const renewClaim = (cfg, taskId, runId, generation) =>
  call({ ...cfg, path: '/v1/claims/renew', body: { task_id: taskId, run_id: runId, generation } });
export const releaseClaim = (cfg, taskId, runId, generation) =>
  call({ ...cfg, path: '/v1/claims/release', body: { task_id: taskId, run_id: runId, generation } });

// Renews on an interval until the claim is lost or the signal aborts. Returns why it stopped.
// A network error keeps retrying until the lease would have expired locally; a refusal stops at once.
export async function heartbeat(cfg, taskId, claim, { intervalMs = 30_000, signal, log = () => {}, sleep = (ms, s) => new Promise((r) => { const t = setTimeout(r, ms); s?.addEventListener('abort', () => { clearTimeout(t); r(); }); }) } = {}) {
  let leaseUntil = claim.expires_at;
  while (!signal?.aborted) {
    await sleep(intervalMs, signal);
    if (signal?.aborted) break;
    try {
      const r = await renewClaim(cfg, taskId, claim.run_id, claim.generation);
      if (r.ok) {
        leaseUntil = r.data.expires_at;
        log(`renewed ${taskId}, lease valid for ${Math.round((leaseUntil - Date.now()) / 1000)}s`);
      } else {
        return { stopped: 'refused', reason: r.data.error ?? `http ${r.status}` };
      }
    } catch (err) {
      log(`renew failed (${err.cause?.code ?? err.message})`);
      if (Date.now() >= leaseUntil) return { stopped: 'lease-lapsed', reason: 'could not reach the coordinator before the lease ran out' };
    }
  }
  return { stopped: 'aborted' };
}

export async function listTasks({ url, deviceId, token, timeoutMs = 5000 }) {
  const res = await fetch(`${url.replace(/\/$/, '')}/v1/tasks/mine`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'x-device-id': deviceId, authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// Plain-language reason for a refused claim.
export function claimRefusal(r) {
  const d = r.data ?? {};
  switch (d.error) {
    case 'claimed': return `already being worked on by ${d.owner}`;
    case 'assigned': return `reserved for ${d.owner}`;
    case 'closed': return 'the task is closed';
    case 'unknown_task': return 'no such task';
    default: return d.error ?? `http ${r.status}`;
  }
}
