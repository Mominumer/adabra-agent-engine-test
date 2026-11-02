#!/usr/bin/env node
// Review dispatcher (runs on the Mac mini, separate from the coordinator).
//
//   node reviewer/main.js serve          poll open PRs and review each new head commit, one at a time
//   node reviewer/main.js poll-once      queue new commits once and exit (no reviews run)
//   node reviewer/main.js status         queue counts and recent jobs
//   node reviewer/main.js retry <pr>     run the latest commit of a PR again
//
// Environment:
//   GITHUB_REPO          owner/name
//   REVIEW_TOKEN_FILE    the reviewer's own fine-grained token (default ~/.adabra/review-token)
//   REVIEW_AUTHORS       comma-separated GitHub logins whose PRs may run on the mini (required for serve)
//   REVIEW_DB            SQLite path (default ./reviewer.db)
//   REVIEW_POLL_MS       default 60000
//   REVIEW_DRY_RUN=1     log statuses and comments instead of posting them
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore } from './store.js';
import { ReviewGitHub } from './github.js';
import { Dispatcher, notConfigured } from './dispatcher.js';

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const [cmd, ...args] = process.argv.slice(2);
const store = new ReviewStore(process.env.REVIEW_DB ?? './reviewer.db');

function github() {
  const repo = process.env.GITHUB_REPO;
  if (!repo) throw new Error('GITHUB_REPO is not set');
  const real = new ReviewGitHub({
    repo,
    token: readFileSync(process.env.REVIEW_TOKEN_FILE ?? join(homedir(), '.adabra', 'review-token'), 'utf8').trim(),
  });
  if (process.env.REVIEW_DRY_RUN !== '1') return real;
  let id = 5000;
  return {
    openPulls: () => real.openPulls(), // reading is harmless
    setStatus: async (sha, ctx, state, d) => log(`[dry-run] status ${sha.slice(0, 12)} ${ctx}=${state}: ${d}`),
    findReviewComment: async () => null,
    createComment: async (pr, body) => (log(`[dry-run] comment on PR #${pr}:\n${body}`), ++id),
    updateComment: async (cid, body) => log(`[dry-run] update comment ${cid}:\n${body}`),
  };
}

function dispatcher() {
  const authors = (process.env.REVIEW_AUTHORS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!authors.length) throw new Error('REVIEW_AUTHORS is empty: list the GitHub logins allowed to run code on the mini');
  return new Dispatcher({
    store, github: github(), repo: process.env.GITHUB_REPO, authors, log,
    runTests: notConfigured('test'), // phase 2: Docker sandbox
    runReview: notConfigured('review'), // phase 3: mock review skill
  });
}

if (cmd === 'serve') {
  const d = dispatcher();
  const pollMs = Number(process.env.REVIEW_POLL_MS ?? 60_000);
  const n = store.requeueInterrupted();
  if (n) log(`re-queued ${n} job(s) interrupted by a restart`);
  log(`reviewer started for ${process.env.GITHUB_REPO}, polling every ${pollMs / 1000}s`);
  let lastPoll = 0;
  for (;;) {
    if (Date.now() - lastPoll >= pollMs) {
      lastPoll = Date.now();
      await d.poll().catch((err) => log(`poll failed: ${err.message}`));
    }
    const r = await d.runOnce().catch((err) => (log(`run failed: ${err.message}`), null));
    if (!r) await new Promise((res) => setTimeout(res, 5000));
  }
} else if (cmd === 'poll-once') {
  console.log(`queued ${await dispatcher().poll()} new commit(s)`);
} else if (cmd === 'status') {
  console.log(store.counts());
  for (const j of store.recent(10)) {
    const res = j.result ? `tests ${j.result.tests}, review ${j.result.review}` : (j.last_error ?? '');
    console.log(`PR #${j.pr} ${j.sha.slice(0, 12)} ${j.state} (attempts ${j.attempts}) ${res}`);
  }
} else if (cmd === 'retry' && Number.isInteger(Number(args[0]))) {
  console.log(store.retry(Number(args[0])) ? `PR #${args[0]} queued again` : `no jobs for PR #${args[0]}`);
} else {
  console.error('usage: main.js serve | poll-once | status | retry <pr>');
  process.exit(2);
}
