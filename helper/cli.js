#!/usr/bin/env node
// Local helper (runs on each builder laptop).
//
//   node helper/cli.js enroll <coordinator-url> <device-id>   (then put the token in $TEAM_AGENT_HOME/token)
//   node helper/cli.js tasks                         (what you can work on: reserved for you first, then open ones)
//   node helper/cli.js claim TASK-1                  (exclusive lease; needs the coordinator)
//   node helper/cli.js claim-next                    (claims the first available task from that list)
//   node helper/cli.js heartbeat TASK-1              (keeps the lease alive; stops if the claim is lost)
//   node helper/cli.js checkpoint --task TASK-1 --status Building --summary "..." \
//        [--verification "..."] [--next "..."]       (uses the run and generation from the claim)
//   node helper/cli.js release TASK-1
//   node helper/cli.js flush
//   node helper/cli.js status
//
// State lives in $TEAM_AGENT_HOME (default ~/.team-agent): config.json, token (mode 600), outbox.db
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Outbox } from './outbox.js';
import { flush } from './sender.js';
import { validateEvent } from '../shared/event.js';
import { ClaimFile, claimRefusal, claimTask, heartbeat, listTasks, newRunId, releaseClaim } from './claims.js';

const home = process.env.TEAM_AGENT_HOME ?? join(homedir(), '.team-agent');
const configPath = join(home, 'config.json');
const tokenPath = join(home, 'token');

const git = (...a) => {
  try {
    return execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

function loadConfig() {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const token = readFileSync(tokenPath, 'utf8').trim();
  return { ...config, token };
}

const claimFile = new ClaimFile(home);
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'enroll') {
  const [url, deviceId] = rest;
  if (!url || !deviceId) {
    console.error('usage: enroll <coordinator-url> <device-id>');
    process.exit(2);
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(configPath, JSON.stringify({ coordinator_url: url, device_id: deviceId }, null, 2));
  console.log(`saved ${configPath}. Now save the device token (from the coordinator's device-add) to ${tokenPath}:`);
  console.log(`  umask 077 && pbpaste > "${tokenPath}"   # macOS: copy the token first`);
} else if (cmd === 'tasks') {
  const cfg = loadConfig();
  const r = await listTasks({ url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token });
  if (!r.ok) {
    console.error(`could not list tasks: ${r.data.error ?? r.status}`);
    process.exit(1);
  }
  if (!r.data.tasks.length) console.log('no open tasks for you');
  for (const t of r.data.tasks) {
    const who = t.state === 'yours' ? 'you hold it' : t.state === 'busy' ? `held by ${t.held_by}` : 'available';
    console.log(`${t.task_id} (#${t.issue}) ${t.reserved_for_you ? '[reserved for you] ' : ''}${who}${t.title ? ` - ${t.title}` : ''}`);
  }
} else if (cmd === 'claim' || cmd === 'claim-next') {
  const cfg = loadConfig();
  const auth = { url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token };
  let taskId = rest[0];
  if (cmd === 'claim-next') {
    const list = await listTasks(auth);
    if (!list.ok) {
      console.error(`could not list tasks: ${list.data.error ?? list.status}`);
      process.exit(1);
    }
    taskId = list.data.tasks.find((t) => t.state === 'available')?.task_id;
    if (!taskId) {
      console.log('nothing available right now');
      process.exit(0);
    }
  } else if (!taskId) {
    console.error('usage: claim <TASK-1>');
    process.exit(2);
  }
  const existing = claimFile.get(taskId);
  const runId = existing?.run_id ?? newRunId();
  const r = await claimTask(auth, taskId, runId);
  if (r.ok) {
    claimFile.set(taskId, { run_id: runId, generation: r.data.generation, expires_at: r.data.expires_at });
    console.log(`claimed ${taskId}: run ${runId}, generation ${r.data.generation}, lease ${Math.round(r.data.lease_ms / 1000)}s`);
    console.log('the background agent keeps it alive (or run: node helper/cli.js heartbeat ' + taskId + ')');
  } else {
    console.error(`not claimed: ${claimRefusal(r)}`);
    process.exit(1);
  }
} else if (cmd === 'heartbeat') {
  const taskId = rest[0];
  const claim = taskId && claimFile.get(taskId);
  if (!claim) {
    console.error('no local claim for that task; run: claim <TASK-1>');
    process.exit(2);
  }
  const cfg = loadConfig();
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());
  console.log(`heartbeat for ${taskId} (generation ${claim.generation}); Ctrl+C to stop`);
  const intervalMs = Number(process.env.TEAM_AGENT_HEARTBEAT_MS ?? 30_000);
  const out = await heartbeat({ url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token }, taskId, claim, {
    intervalMs, signal: ac.signal, log: console.log,
  });
  if (out.stopped === 'aborted') console.log('stopped; the lease will expire on its own');
  else {
    console.error(`CLAIM LOST (${out.reason}). Stop work on ${taskId}: further output will be rejected.`);
    claimFile.remove(taskId);
    process.exit(3);
  }
} else if (cmd === 'release') {
  const taskId = rest[0];
  const claim = taskId && claimFile.get(taskId);
  if (!claim) {
    console.error('no local claim for that task');
    process.exit(2);
  }
  const cfg = loadConfig();
  // Deliver any queued checkpoints first: once released we still hold the generation, but be tidy.
  const outbox = new Outbox(join(home, 'outbox.db'));
  await flush({ outbox, url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token, log: console.error });
  const left = outbox.counts().pending ?? 0;
  outbox.close();
  if (left) {
    console.error(`${left} checkpoint(s) are still queued; not releasing. Flush them first.`);
    process.exit(1);
  }
  const r = await releaseClaim({ url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token }, taskId, claim.run_id, claim.generation);
  if (r.ok) {
    claimFile.remove(taskId);
    console.log(`released ${taskId}`);
  } else {
    console.error(`not released: ${r.data.error ?? r.status}`);
    process.exit(1);
  }
} else if (cmd === 'checkpoint') {
  const { values: v } = parseArgs({
    args: rest,
    options: {
      task: { type: 'string' },
      status: { type: 'string', default: 'Building' },
      summary: { type: 'string' },
      verification: { type: 'string', default: '' },
      next: { type: 'string', default: '' },
    },
  });
  const claim = v.task && claimFile.get(v.task);
  if (!claim) {
    console.error(`no local claim for ${v.task}; claim it first: node helper/cli.js claim ${v.task ?? '<TASK-1>'}`);
    process.exit(2);
  }
  const cfg = loadConfig();
  const head = git('rev-parse', 'HEAD');
  const unpushed = git('rev-list', '--count', '@{u}..HEAD');
  const event = {
    event_id: randomUUID(),
    task_id: v.task,
    run_id: claim.run_id,
    device_id: cfg.device_id,
    claim_generation: claim.generation,
    type: 'checkpoint',
    source_commit: head,
    unpushed_commits: unpushed === null ? null : Number(unpushed),
    summary: v.summary,
    verification: v.verification,
    status: v.status,
    next_action: v.next,
    ts: new Date().toISOString(),
  };
  const errors = validateEvent(event);
  if (errors.length) {
    console.error(`not recorded: ${errors.join('; ')}`);
    process.exit(2);
  }
  const outbox = new Outbox(join(home, 'outbox.db'));
  outbox.add(event); // durable first
  console.log(`recorded ${event.event_id}`);
  const r = await flush({ outbox, url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token, log: console.error });
  console.log(
    r.acked
      ? 'acknowledged by the coordinator'
      : r.rejected
        ? 'REJECTED by the coordinator (not retried): you may no longer hold this task; see the reason above'
        : 'queued; will retry on the next flush',
  );
  outbox.close();
} else if (cmd === 'flush') {
  const cfg = loadConfig();
  const outbox = new Outbox(join(home, 'outbox.db'));
  console.log(await flush({ outbox, url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token, log: console.error }));
  outbox.close();
} else if (cmd === 'status') {
  const outbox = new Outbox(join(home, 'outbox.db'));
  console.log('outbox:', outbox.counts());
  outbox.close();
  console.log('claims held:', Object.keys(claimFile.all()).join(', ') || 'none');
  try {
    const a = JSON.parse(readFileSync(join(home, 'agent-status.json'), 'utf8'));
    const age = Math.round((Date.now() - Date.parse(a.at)) / 1000);
    console.log(`background agent: last pass ${age}s ago${age > 120 ? ' (NOT RUNNING? it should report every 30s)' : ''}`);
  } catch {
    console.log('background agent: no status file (not running)');
  }
} else {
  console.error('usage: cli.js enroll | checkpoint | flush | status');
  process.exit(2);
}
