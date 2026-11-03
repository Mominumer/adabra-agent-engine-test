#!/usr/bin/env node
// Review dispatcher (runs on the Mac mini, separate from the coordinator).
//
//   node reviewer/main.js serve          poll open PRs and review each new head commit, one at a time
//   node reviewer/main.js poll-once      queue new commits once and exit (no reviews run)
//   node reviewer/main.js status         queue counts and recent jobs
//   node reviewer/main.js retry <pr>     run the latest commit of a PR again
//   node reviewer/main.js sandbox-check  prove the Docker sandbox is locked down (no PR needed)
//   node reviewer/main.js review-check   prove the review user's containment (no PR, no token, no model call; needs service/review-user.sh)
//   node reviewer/main.js review-check --live [--yes]   the same proof with 2 paid runs on a hostile fixture: see review-live.js
//   node reviewer/main.js seeded-run [--yes] [--set v1|hard] [--run-name <name>]   up to 25 paid runs (28 with --set hard) on a set with known answers, and its numbers: see seeded-run.js
//   node reviewer/main.js github-check   do these GitHub settings work? reads only, opens no database
//   node reviewer/main.js override <pr> --reason "..."   operator only, at a terminal: see override.js and service/ops.sh
//
// Environment:
//   GITHUB_REPO          owner/name
//   REVIEW_TOKEN_FILE    the reviewer's own fine-grained token (default ~/.adabra/review-token)
//   REVIEW_APP_ID, REVIEW_APP_INSTALLATION_ID, REVIEW_APP_KEY_FILE
//                        use a GitHub App instead of the token file: all three, or none. See the README.
//   REVIEW_AUTHORS       comma-separated GitHub logins whose PRs may run on the mini (required for serve)
//   REVIEW_DB            SQLite path (default ./reviewer.db)
//   REVIEW_POLL_MS       default 60000
//   REVIEW_DRY_RUN=1     log statuses and comments instead of posting them
//   REVIEW_IMAGE         sandbox image, pulled beforehand (default node:26-slim; pin by digest)
//   REVIEW_TEST_CMD      command run on the PR inside the sandbox (default: npm test)
//   REVIEW_TIMEOUT_MS    per-job limit (default 900000 = 15 min)
//   REVIEW_ENGINE        mock (default), shadow (the mock decides, the real review only reports to adabra/review-shadow) or claude.
//                        The real review also needs: sudo service/review-user.sh install --enable-model
//   REVIEW_DAILY_CAP     real review runs allowed per UTC day (default 30)
//   REVIEW_UNSHOWN_OK    comma-separated extensions a changed file may have when GitHub will not show it (default: images and fonts)
//   REVIEW_LOG_FILE      where override leaves its record (default ~/Library/Logs/adabra-reviewer.log, the service's log)
//   ADABRA_STOP_FILE     the operator's emergency stop (default /opt/adabra-control/stop.json if that folder exists, otherwise ~/.adabra-control/stop.json); see service/ops.sh
//   REVIEW_RUNS_DIR      where the live check and the seeded run keep their local results (default ~/.adabra-review-runs)
//
// Telling the coordinator how a task's review went (off unless the device identity is set; reviews run the same either way):
//   REVIEW_DEVICE_ID          this reviewer's enrolled device, role reviewer (coordinator: device-add <id> reviewer)
//   REVIEW_DEVICE_TOKEN_FILE  that device's token (default ~/.adabra/reviewer-device-token), not any GitHub token
//   REVIEW_COORDINATOR_URL    https, or http to this machine (e.g. http://127.0.0.1:8787)
//   REVIEW_DELIVERY_MS        how often to send what is due (default 5000)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore } from './store.js';
import { REVIEW_PERMISSIONS, ReviewGitHub } from './github.js';
import { Dispatcher } from './dispatcher.js';
import { reviewEngine } from './review-claude.js';
import { Sandbox, selfCheck } from './sandbox.js';
import { startTaskResults } from './task-results.js';
import { reviewCheck } from './review-check.js';
import { overrideCommand } from './override.js';
import { liveCommand } from './review-live.js';
import { reviewRunLines } from './run-summary.js';
import { seededCommand } from './seeded-run.js';
import { isStopped, readStop, stopLine, watchStop } from '../shared/stop.js';
import { appAuthFromEnv, gitHubCheck } from '../shared/github-auth.js';

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const [cmd, ...args] = process.argv.slice(2);
const sandbox = new Sandbox({
  image: process.env.REVIEW_IMAGE,
  cmd: process.env.REVIEW_TEST_CMD,
  timeoutMs: process.env.REVIEW_TIMEOUT_MS ? Number(process.env.REVIEW_TIMEOUT_MS) : undefined,
});

// Before the database opens: this check needs neither the queue nor a token.
if (cmd === 'review-check') {
  if (args[0] === '--live') process.exit(await liveCommand({ args: args.slice(1), sandbox }));
  if (args.length) {
    console.error('review-check takes no other options: without --live this check never calls a model');
    process.exit(2);
  }
  let r;
  try {
    await sandbox.ensureDocker();
    r = await reviewCheck({ sandbox });
  } catch (err) {
    console.error(`review-check could not finish: ${err.message}`);
    process.exit(1);
  }
  for (const x of r.results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.check.padEnd(28)} want ${x.want}  got ${x.got}`);
  console.log(r.ok ? 'review user is contained' : 'REVIEW USER NOT CONTAINED - do not build the real review on this');
  process.exit(r.ok ? 0 : 1);
}

// Also before the database opens: it finds the service's own, and never leaves a new empty one where it was started.
if (cmd === 'seeded-run') process.exit(await seededCommand({ args, sandbox }));

// Refuses to go on if the app settings are incomplete or invalid. The token file is read only when none of them is set.
function realGitHub() {
  const repo = process.env.GITHUB_REPO;
  if (!repo) throw new Error('GITHUB_REPO is not set');
  const auth = appAuthFromEnv({ prefix: 'REVIEW', repo, permissions: REVIEW_PERMISSIONS });
  if (auth) return new ReviewGitHub({ repo, auth });
  return new ReviewGitHub({
    repo,
    token: readFileSync(process.env.REVIEW_TOKEN_FILE ?? join(homedir(), '.adabra', 'review-token'), 'utf8').trim(),
  });
}

// Also before the database opens: this check needs no database, and must not leave one behind.
if (cmd === 'github-check') {
  const gh = realGitHub();
  const read = async () => `read check: ${(await gh.openPulls()).length} open pull request(s)`;
  process.exit((await gitHubCheck({ auth: gh.auth, read })) ? 0 : 1);
}

const store = new ReviewStore(process.env.REVIEW_DB ?? './reviewer.db');

function github() {
  const real = realGitHub();
  log(`GitHub auth: ${real.auth.describe()}`);
  if (process.env.REVIEW_DRY_RUN !== '1') return real;
  let id = 5000;
  return {
    openPulls: () => real.openPulls(), // reading is harmless
    getPull: (n) => real.getPull(n),
    downloadTarball: (sha) => real.downloadTarball(sha),
    compareFiles: (base, sha) => real.compareFiles(base, sha),
    setStatus: async (sha, ctx, state, d) => log(`[dry-run] status ${sha.slice(0, 12)} ${ctx}=${state}: ${d}`),
    findReviewComment: async () => null,
    createComment: async (pr, body) => (log(`[dry-run] comment on PR #${pr}:\n${body}`), ++id),
    updateComment: async (cid, body) => log(`[dry-run] update comment ${cid}:\n${body}`),
  };
}

function dispatcher({ linkTasks = false } = {}) {
  const authors = (process.env.REVIEW_AUTHORS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!authors.length) throw new Error('REVIEW_AUTHORS is empty: list the GitHub logins allowed to run code on the mini');
  const gh = github();
  return new Dispatcher({
    store, github: gh, repo: process.env.GITHUB_REPO, authors, log, linkTasks, isStopped,
    runTests: sandbox.testRunner(gh),
    ...reviewEngine({ github: gh, store, sandbox, log }),
  });
}

if (cmd === 'serve') {
  const d = dispatcher({ linkTasks: startTaskResults({ store, log, isStopped }).linkTasks });
  const pollMs = Number(process.env.REVIEW_POLL_MS ?? 60_000);
  const stale = await sandbox.cleanup();
  if (stale) log(`removed ${stale} sandbox container(s) left by a previous run`);
  const n = store.requeueInterrupted();
  if (n) log(`re-queued ${n} job(s) interrupted by a restart`);
  d.start();
  log(`reviewer started for ${process.env.GITHUB_REPO}, polling every ${pollMs / 1000}s`);
  // On a stop, end a running job's containers within seconds. Again on each pass, in case the job has just started another one.
  await watchStop({
    log,
    intervalMs: 2000,
    whileStopped: async () => {
      if (!d.interrupt()) return;
      const ended = await sandbox.cleanup();
      if (ended) log(`stop: ended ${ended} sandbox container(s)`);
    },
  }).pass();
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
} else if (cmd === 'override') {
  process.exit(await overrideCommand({ args, store, github, dryRun: process.env.REVIEW_DRY_RUN === '1' }));
} else if (cmd === 'status') {
  const stop = readStop();
  if (stop.stopped) console.log(`${stopLine(stop)}\nNo job starts until the operator resumes; queued jobs stay queued.`);
  console.log(store.counts());
  const pause = store.reviewPause(Date.now());
  if (pause) console.log(`real reviews paused (${pause.kind}) ${pause.until ? `until ${new Date(pause.until).toISOString()}` : 'until retry or a restart'}`);
  const paidToday = store.paidRunsOn(Date.now());
  if (paidToday) console.log(`real review runs today (UTC): ${paidToday}`);
  for (const line of reviewRunLines(store.reviewRunTotals())) console.log(line);
  for (const j of store.recent(10)) {
    const res = j.result ? `tests ${j.result.tests}, review ${j.result.review}` : (j.last_error ?? '');
    console.log(`PR #${j.pr} ${j.sha.slice(0, 12)} ${j.state} (attempts ${j.attempts}) ${res}`);
  }
  const results = store.taskResultCounts();
  if (Object.keys(results).length) console.log('task results:', results);
  for (const r of store.undeliveredTaskResults()) {
    console.log(`${r.task_id} PR #${r.pr} ${r.sha.slice(0, 12)} ${r.status} (attempts ${r.attempts}) ${r.last_error ?? ''}`);
  }
} else if (cmd === 'sandbox-check') {
  const r = await selfCheck(sandbox);
  for (const x of r.results) console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.check.padEnd(15)} want ${x.want.padEnd(10)} got ${x.got}`);
  console.log(r.ok ? 'sandbox is locked down' : `SANDBOX NOT SAFE - do not run PRs. Raw output:\n${r.log}`);
  process.exit(r.ok ? 0 : 1);
} else if (cmd === 'retry' && Number.isInteger(Number(args[0]))) {
  console.log(store.retry(Number(args[0])) ? `PR #${args[0]} queued again` : `no jobs for PR #${args[0]}`);
} else {
  console.error('usage: main.js serve | poll-once | status | retry <pr> | sandbox-check | review-check [--live [--yes]] | seeded-run [--yes] [--set v1|hard] [--run-name <name>] | github-check | override <pr> --reason "..."');
  process.exit(2);
}
