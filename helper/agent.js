#!/usr/bin/env node
// Background agent for a builder laptop (or the Mac mini acting as a builder).
// Keeps held leases alive and delivers queued checkpoints, so nobody has to run `heartbeat` or `flush` by hand.
//
//   node helper/agent.js
//
// Environment: TEAM_AGENT_HOME (default ~/.team-agent), TEAM_AGENT_TICK_MS (default 30000).
// Writes $TEAM_AGENT_HOME/agent-status.json after every pass; run `node helper/cli.js status` to read it.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Outbox } from './outbox.js';
import { ClaimFile } from './claims.js';
import { tick } from './tick.js';
import { readSecretFile, replaceFile, showNotification, stopSignals, watchParent } from './platform.js';

const home = process.env.TEAM_AGENT_HOME ?? join(homedir(), '.team-agent');
const tickMs = Number(process.env.TEAM_AGENT_TICK_MS ?? 30_000);
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const statusPath = join(home, 'agent-status.json');

function notify(title, message) {
  log(`NOTICE ${title}: ${message}`);
  showNotification(title, message, { log });
}

function loadConfig() {
  const config = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  return { ...config, token: readSecretFile(join(home, 'token')) };
}

const claims = new ClaimFile(home);
const outbox = new Outbox(join(home, 'outbox.db'));
const ac = new AbortController();
for (const sig of stopSignals()) process.on(sig, () => ac.abort());
// Under helper/supervisor.js (Windows): if the supervisor dies, stop too, so the next start cannot run a second agent.
if (process.env.TEAM_AGENT_SUPERVISED) watchParent(() => ac.abort());

log(`agent started, home ${home}, every ${tickMs / 1000}s`);
while (!ac.signal.aborted) {
  try {
    const cfg = loadConfig(); // re-read each pass so enroll and token rotation take effect without a restart
    const r = await tick({ claims, outbox, cfg, log, notify });
    const status = { at: new Date().toISOString(), held: Object.keys(claims.all()), outbox: outbox.counts(), last: r };
    writeFileSync(`${statusPath}.tmp`, JSON.stringify(status, null, 2));
    replaceFile(`${statusPath}.tmp`, statusPath);
    if (r.lost.length || r.sent.acked || r.sent.rejected) log(JSON.stringify({ lost: r.lost, sent: r.sent }));
  } catch (err) {
    log(`pass failed: ${err.message}`); // e.g. not enrolled yet; keep running and try again
  }
  await new Promise((res) => {
    const t = setTimeout(res, tickMs);
    ac.signal.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });
}
outbox.close();
log('agent stopped');
