#!/usr/bin/env node
// Local helper (runs on each builder laptop).
//
//   node helper/cli.js enroll <coordinator-url> <device-id>   (then put the token in $TEAM_AGENT_HOME/token)
//   node helper/cli.js checkpoint --task TASK-1 --run RUN-1 --status Building \
//        --summary "..." [--verification "..."] [--next "..."] [--generation 1]
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
} else if (cmd === 'checkpoint') {
  const { values: v } = parseArgs({
    args: rest,
    options: {
      task: { type: 'string' },
      run: { type: 'string', default: 'RUN-1' },
      status: { type: 'string', default: 'Building' },
      summary: { type: 'string' },
      verification: { type: 'string', default: '' },
      next: { type: 'string', default: '' },
      generation: { type: 'string', default: '0' },
    },
  });
  const cfg = loadConfig();
  const head = git('rev-parse', 'HEAD');
  const unpushed = git('rev-list', '--count', '@{u}..HEAD');
  const event = {
    event_id: randomUUID(),
    task_id: v.task,
    run_id: v.run,
    device_id: cfg.device_id,
    claim_generation: Number(v.generation),
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
  console.log(r.acked ? 'acknowledged by the coordinator' : 'queued; will retry on the next flush');
  outbox.close();
} else if (cmd === 'flush') {
  const cfg = loadConfig();
  const outbox = new Outbox(join(home, 'outbox.db'));
  console.log(await flush({ outbox, url: cfg.coordinator_url, deviceId: cfg.device_id, token: cfg.token, log: console.error }));
  outbox.close();
} else if (cmd === 'status') {
  const outbox = new Outbox(join(home, 'outbox.db'));
  console.log(outbox.counts());
  outbox.close();
} else {
  console.error('usage: cli.js enroll | checkpoint | flush | status');
  process.exit(2);
}
