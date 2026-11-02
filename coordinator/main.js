#!/usr/bin/env node
// Coordinator entry point (runs on the Mac mini).
//
//   node coordinator/main.js serve
//   node coordinator/main.js device-add <device-id> [builder|reviewer]   (prints the token once; default builder)
//   node coordinator/main.js device-rotate <device-id>   (new token; the old one stops working)
//   node coordinator/main.js device-revoke <device-id>
//   node coordinator/main.js task-add <TASK-1> <issue-number> [device-id]   (optionally reserved for a device)
//   node coordinator/main.js task-assign <TASK-1> <device-id|none>
//   node coordinator/main.js tasks                        (all tasks, who they are reserved for, who holds them)
//   node coordinator/main.js task-sync                    (mirror issues labelled agent-task now; serve does it every 60 s)
//   node coordinator/main.js claims                       (who holds which task)
//   node coordinator/main.js claim-cancel <TASK-1>        (operator: fence the current owner)
//   node coordinator/main.js status
//   node coordinator/main.js github-check                 (do these GitHub settings work? reads only, opens no database)
//
// Environment:
//   COORDINATOR_DB          SQLite path (default ./coordinator.db)
//   COORDINATOR_HOST/PORT   listen address (default 127.0.0.1:8787; expose it with `tailscale serve`)
//   GITHUB_REPO             owner/name
//   GITHUB_TOKEN_FILE       file containing a fine-grained token (never pass the token on the command line)
//   GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_KEY_FILE
//                           use a GitHub App instead of the token file: all three, or none. See the README.
//   GITHUB_DRY_RUN=1        log what would be posted instead of calling GitHub
//   ADABRA_STOP_FILE        the operator's emergency stop (default ~/.adabra-control/stop.json); see service/ops.sh
import { readFileSync } from 'node:fs';
import { ROLES, Store } from './store.js';
import { VERDICT_TEXT } from '../shared/review-result.js';
import { COORDINATOR_PERMISSIONS, GitHubClient } from './github.js';
import { Worker } from './worker.js';
import { createServer } from './server.js';
import { syncTasks, TASK_LABEL } from './sync.js';
import { keepLeasesWhileStopped } from './stop-keeper.js';
import { readStop, stopLine } from '../shared/stop.js';
import { appAuthFromEnv, gitHubCheck } from '../shared/github-auth.js';

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const [cmd, ...args] = process.argv.slice(2);

// Refuses to go on if the app settings are incomplete or invalid. The token file is read only when none of them is set.
const appAuth = () => appAuthFromEnv({ prefix: 'GITHUB', repo: process.env.GITHUB_REPO, permissions: COORDINATOR_PERMISSIONS });

function githubClient(auth = appAuth()) {
  const repo = process.env.GITHUB_REPO;
  return auth ? new GitHubClient({ repo, auth }) : new GitHubClient({ repo, token: readFileSync(process.env.GITHUB_TOKEN_FILE, 'utf8').trim() });
}

// Before the database opens: this check needs no database, and must not leave one behind.
if (cmd === 'github-check') {
  const github = githubClient();
  const read = async () => `read check: ${(await github.listIssues(TASK_LABEL)).length} issue(s) labelled ${TASK_LABEL}`;
  process.exit((await gitHubCheck({ auth: github.auth, read })) ? 0 : 1);
}

const store = new Store(process.env.COORDINATOR_DB ?? './coordinator.db');

const showStop = () => {
  const s = readStop();
  if (s.stopped) console.log(stopLine(s));
};

function usage() {
  console.error('usage: main.js serve | device-add <id> [builder|reviewer] | device-revoke <id> | task-add <TASK-N> <issue> | status | github-check');
  process.exit(2);
}

if (cmd === 'device-add' && args[0] && (!args[1] || ROLES.includes(args[1]))) {
  const role = args[1] ?? 'builder';
  console.log(`device ${args[0]}, role ${role}, token (shown once, store it on that device only):\n${store.addDevice(args[0], role)}`);
} else if (cmd === 'device-rotate' && args[0]) {
  console.log(`device ${args[0]} new token (shown once; the old token no longer works):\n${store.rotateDevice(args[0])}`);
} else if (cmd === 'device-revoke' && args[0]) {
  store.revokeDevice(args[0]);
  console.log(`revoked ${args[0]}`);
} else if (cmd === 'task-add' && args[0] && Number.isInteger(Number(args[1]))) {
  store.addTask(args[0], Number(args[1]));
  console.log(`${args[0]} -> issue #${args[1]}`);
  if (args[2]) {
    const r = store.assignTask(args[0], args[2]);
    console.log(r.ok ? `reserved for ${args[2]}` : `not reserved: ${r.reason}`);
  }
} else if (cmd === 'task-assign' && args[0] && args[1]) {
  const r = store.assignTask(args[0], args[1] === 'none' ? null : args[1]);
  console.log(r.ok ? `${args[0]} is now ${args[1] === 'none' ? 'open to anyone' : `reserved for ${args[1]}`}` : `failed: ${r.reason}`);
} else if (cmd === 'tasks') {
  showStop();
  for (const t of store.db.prepare('SELECT * FROM tasks ORDER BY issue_number').all()) {
    const c = store.currentClaim(t.task_id);
    const live = c && c.state === 'held' && c.expires_at > Date.now();
    const review = store.reviewBrief(t.task_id);
    console.log(
      `${t.task_id} (#${t.issue_number}) ${t.closed ? 'CLOSED' : 'open'} ${t.source}: ` +
        `${t.assignee ? `reserved for ${t.assignee}` : 'anyone'}, ${live ? `held by ${c.device_id}` : 'not held'}` +
        `${t.returned_to ? `, returned to ${t.returned_to}` : ''}` +
        `${review ? `, ${VERDICT_TEXT[review.verdict]} on ${review.sha.slice(0, 12)}` : ''}${t.title ? ` - ${t.title}` : ''}`,
    );
  }
} else if (cmd === 'task-sync') {
  console.log(await syncTasks({ store, github: githubClient(), log }));
} else if (cmd === 'claim-cancel' && args[0]) {
  const r = store.cancelClaim(args[0]);
  console.log(r.ok ? `cancelled ${args[0]}; generation is now ${r.generation}, the old owner's output is fenced` : `failed: ${r.reason}`);
} else if (cmd === 'claims') {
  showStop();
  for (const t of store.db.prepare('SELECT task_id, generation FROM tasks ORDER BY task_id').all()) {
    const c = store.currentClaim(t.task_id);
    console.log(
      c
        ? `${t.task_id} gen ${t.generation}: ${c.state} by ${c.device_id} run ${c.run_id}, lease ${c.expires_at > Date.now() ? 'valid' : 'expired'}`
        : `${t.task_id} gen ${t.generation}: unclaimed`,
    );
  }
} else if (cmd === 'status') {
  showStop();
  console.log(store.counts());
} else if (cmd === 'serve') {
  const auth = appAuth(); // a dry run is no reason to accept broken settings
  let github;
  if (process.env.GITHUB_DRY_RUN === '1') {
    let id = 1000;
    github = {
      findProgressComment: async () => null,
      createComment: async (issue, body) => (log(`[dry-run] comment on #${issue}:\n${body}`), ++id),
      updateComment: async (cid, body) => log(`[dry-run] update comment ${cid}:\n${body}`),
    };
  } else {
    github = githubClient(auth);
    log(`GitHub auth: ${github.auth.describe()}`);
  }
  const worker = new Worker({ store, github, log, stopState: readStop });
  worker.start();
  const host = process.env.COORDINATOR_HOST ?? '127.0.0.1';
  const port = Number(process.env.COORDINATOR_PORT ?? 8787);
  const leaseMs = Number(process.env.COORDINATOR_LEASE_MS ?? 180_000);
  // Before the first request, so a stop in force through a restart keeps the leases that ran out while this was down.
  await keepLeasesWhileStopped({ store, leaseMs, log }).pass();
  if (process.env.GITHUB_DRY_RUN !== '1') {
    const syncEvery = Number(process.env.COORDINATOR_SYNC_MS ?? 60_000);
    const run = () => syncTasks({ store, github, log }).catch((err) => log(`task sync failed: ${err.message}`));
    run();
    setInterval(run, syncEvery).unref();
  }
  createServer({ store, log, leaseMs, stopState: readStop }).listen(port, host, () => log(`coordinator listening on ${host}:${port}`));
} else {
  usage();
}
