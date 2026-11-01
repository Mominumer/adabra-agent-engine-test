#!/usr/bin/env node
// Coordinator entry point (runs on the Mac mini).
//
//   node coordinator/main.js serve
//   node coordinator/main.js device-add <device-id>      (prints the token once)
//   node coordinator/main.js device-rotate <device-id>   (new token; the old one stops working)
//   node coordinator/main.js device-revoke <device-id>
//   node coordinator/main.js task-add <TASK-1> <issue-number>
//   node coordinator/main.js status
//
// Environment:
//   COORDINATOR_DB          SQLite path (default ./coordinator.db)
//   COORDINATOR_HOST/PORT   listen address (default 127.0.0.1:8787; expose it with `tailscale serve`)
//   GITHUB_REPO             owner/name
//   GITHUB_TOKEN_FILE       file containing a fine-grained token (never pass the token on the command line)
//   GITHUB_DRY_RUN=1        log what would be posted instead of calling GitHub
import { readFileSync } from 'node:fs';
import { Store } from './store.js';
import { GitHubClient } from './github.js';
import { Worker } from './worker.js';
import { createServer } from './server.js';

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const [cmd, ...args] = process.argv.slice(2);
const store = new Store(process.env.COORDINATOR_DB ?? './coordinator.db');

function usage() {
  console.error('usage: main.js serve | device-add <id> | device-revoke <id> | task-add <TASK-N> <issue> | status');
  process.exit(2);
}

if (cmd === 'device-add' && args[0]) {
  console.log(`device ${args[0]} token (shown once, store it on that device only):\n${store.addDevice(args[0])}`);
} else if (cmd === 'device-rotate' && args[0]) {
  console.log(`device ${args[0]} new token (shown once; the old token no longer works):\n${store.rotateDevice(args[0])}`);
} else if (cmd === 'device-revoke' && args[0]) {
  store.revokeDevice(args[0]);
  console.log(`revoked ${args[0]}`);
} else if (cmd === 'task-add' && args[0] && Number.isInteger(Number(args[1]))) {
  store.addTask(args[0], Number(args[1]));
  console.log(`${args[0]} -> issue #${args[1]}`);
} else if (cmd === 'status') {
  console.log(store.counts());
} else if (cmd === 'serve') {
  let github;
  if (process.env.GITHUB_DRY_RUN === '1') {
    let id = 1000;
    github = {
      findProgressComment: async () => null,
      createComment: async (issue, body) => (log(`[dry-run] comment on #${issue}:\n${body}`), ++id),
      updateComment: async (cid, body) => log(`[dry-run] update comment ${cid}:\n${body}`),
    };
  } else {
    const token = readFileSync(process.env.GITHUB_TOKEN_FILE, 'utf8').trim();
    github = new GitHubClient({ repo: process.env.GITHUB_REPO, token });
  }
  const worker = new Worker({ store, github, log });
  worker.start();
  const host = process.env.COORDINATOR_HOST ?? '127.0.0.1';
  const port = Number(process.env.COORDINATOR_PORT ?? 8787);
  createServer({ store, log }).listen(port, host, () => log(`coordinator listening on ${host}:${port}`));
} else {
  usage();
}
