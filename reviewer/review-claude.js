import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { buildJobDir, JOB_ROOT, removeJobDir, sweepJobDirs } from './job-dir.js';
import { diffText, preCheck, UNSHOWN_OK } from './precheck.js';
import { OPT, readPaths } from './review-check.js';
import { mockReview } from './review-mock.js';
import { judgeRun, localDetail, MAX_OUTPUT_BYTES, ReviewPaused, reviewSummary, ReviewSuperseded, STATUS_TEXT } from './review-output.js';
import { nextUtcMidnight } from './store.js';
import { parseTaskId } from './task-results.js';

// The real review, same contract as the mock: given a job, return { state, summary, findings, reviewer }. It costs money, so the
// checks that spend nothing come first, and a pass comes only from a result judgeRun accepts.
// These two must match the wrapper's --model and --system-prompt-file; a test holds them together.
export const SKILL = 'review-v1';
export const MODEL = 'claude-sonnet-5-5';
export const PRECHECK_REVIEWER = 'adabra-precheck';
export const DEFAULT_DAILY_CAP = 30;
const MAX_PAID_ATTEMPTS = 3; // transient and unrecognised failures of one commit, before the result is final
const STRIKES_TO_PAUSE = 3; // unrecognised failures in a row, whichever commits they were on
const HARD_STOP_MS = 16 * 60_000; // past the wrapper's time limit and sudo's own, so this only fires if both have failed
const MAX_STDERR = 64 * 1024;

// Starts the wrapper as the review user and collects its output, bounded. Always resolves. The sudo process runs as root, so it may
// not be possible to signal it: at the deadline the pipes are dropped and the answer given anyway, whatever became of the process.
export function sudoRunner({ opt = OPT, sudo = '/usr/bin/sudo', deadlineMs = HARD_STOP_MS, maxBytes = MAX_OUTPUT_BYTES } = {}) {
  return (id) => new Promise((resolve) => {
    let reviewUser;
    try {
      reviewUser = readPaths(opt).REVIEW_USER;
    } catch (err) {
      resolve({ code: 78, stdout: '', stderr: err.message }); // not installed: the same answer as a model step that is off
      return;
    }
    const child = spawn(sudo, ['-n', '-u', reviewUser, join(opt, 'bin', 'run-review'), id], {
      cwd: opt, // the dispatcher's folders are closed to the review user
      env: { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = [];
    let size = 0;
    let stderr = '';
    let overflow = false;
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: overflow ? '' : Buffer.concat(out).toString('utf8'), stderr, overflow, ...r });
    };
    const abandon = (r) => {
      if (settled) return;
      finish(r); // first: a refused signal arrives as an 'error' event, and must not become the answer
      child.kill('SIGTERM');
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    timer = setTimeout(() => abandon({ code: null, timedOut: true }), deadlineMs);
    child.stdout.on('data', (b) => {
      size += b.length;
      if (size <= maxBytes) {
        out.push(b);
        return;
      }
      overflow = true;
      out.length = 0;
      abandon({ code: null });
    });
    child.stderr.on('data', (b) => {
      stderr = (stderr + b.toString('utf8')).slice(-MAX_STDERR);
    });
    child.on('error', () => finish({ code: 127 }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

export function claudeReview({
  store, github, sandbox, runner = sudoRunner(), root = JOB_ROOT, now = Date.now, log = () => {},
  dailyCap = DEFAULT_DAILY_CAP, skill = SKILL, model = MODEL, unshownOk = UNSHOWN_OK,
}) {
  const reviewer = `${model}.${skill}`; // a dot, not a slash: the task link only passes on a name without one

  const writeJob = async (job, files, meta) => {
    let cleaned;
    try {
      const tarball = await github.downloadTarball(job.sha);
      cleaned = await sandbox.cleanTree({ name: `adabra-review-clean-${job.pr}-${job.sha.slice(0, 12)}-${now()}`, tarball });
    } catch (err) {
      if (err.code === 'TOO_LARGE') return { final: { state: 'failure', summary: STATUS_TEXT.tooLarge } };
      if (err.code === 'UNREADABLE') return { final: { state: 'error', summary: STATUS_TEXT.unreadable } };
      throw err; // the machinery, not the PR: retried
    }
    return buildJobDir({
      root, pr: job.pr, sha: job.sha, tar: cleaned.tar, report: cleaned.report, diff: diffText(files),
      title: meta.title ?? '', body: meta.body ?? '', task: parseTaskId(meta).task_id, now: now(), paid: true,
    });
  };

  // What the failure means for this job and for the reviews after it.
  const afterFailure = (job, judged) => {
    const final = (summary) => ({ state: 'error', summary, findings: [], reviewer });
    switch (judged.class) {
      case 'limit':
        store.clearStrikes();
        throw new ReviewPaused('limit', store.pauseForLimit(now(), judged.resetAt ?? null));
      case 'auth':
        store.clearStrikes();
        store.pauseForAuth();
        throw new ReviewPaused('auth');
      case 'run-limit':
        store.reviewWorked();
        return final(STATUS_TEXT.runLimit);
      case 'invalid':
        store.reviewWorked();
        return final(STATUS_TEXT.invalid);
      case 'transient':
        store.clearStrikes();
        break;
      default:
        // A change in a message's wording lands here. It must not be able to burn a day's runs one job at a time.
        if (store.addStrike() >= STRIKES_TO_PAUSE) throw new ReviewPaused('limit', store.pauseForLimit(now(), null));
    }
    if (job.attempts + 1 >= MAX_PAID_ATTEMPTS) return final(STATUS_TEXT.transient);
    throw new Error(`review step failed (${judged.class}); it will be retried`);
  };

  const review = async (job) => {
    const label = `PR #${job.pr} ${job.sha.slice(0, 12)}`;
    const meta = job.meta ?? {};
    const key = { pr: job.pr, sha: job.sha, skill, model };
    const { files, truncated } = await github.compareFiles(meta.base ?? 'main', job.sha); // network error -> retried
    const pre = preCheck({ files, truncated, title: meta.title, body: meta.body, unshownOk });
    const shaped = (r) => ({ findings: [], ...r, attention: pre.attention, advisory: true });

    if (pre.tooLarge) return shaped({ state: 'failure', summary: STATUS_TEXT.tooLarge, reviewer: PRECHECK_REVIEWER });
    if (pre.blockers.length) {
      return shaped({ state: 'failure', summary: `${pre.blockers.length} blocking finding(s) from the pre-checks`, findings: pre.blockers, reviewer: PRECHECK_REVIEWER });
    }

    // Already paid for: a retry after GitHub failed, or a restart, gets the same answer at no cost, paused or not.
    const cached = store.cachedReview(key);
    if (cached) {
      log(`${label} review: using the stored result`);
      return shaped({ state: cached.state, summary: reviewSummary(cached), findings: cached.findings, reviewer });
    }
    const paused = store.reviewPause(now());
    if (paused) throw new ReviewPaused(paused.kind, paused.until);
    if (store.paidRunsOn(now()) >= dailyCap) throw new ReviewPaused('daily', nextUtcMidnight(now()));

    const written = await writeJob(job, files, meta);
    if (written.final) return shaped({ ...written.final, reviewer: PRECHECK_REVIEWER });
    try {
      // The last moment before spending. Fetching and cleaning take time, and a push may have landed meanwhile.
      const head = await github.pullHead(job.pr);
      if (!head.open || head.sha !== job.sha) throw new ReviewSuperseded();
      // Counted before it starts, so a crash during the run still counts it.
      const runId = store.beginReviewRun({ ...key, now: now(), cap: dailyCap });
      if (runId === null) throw new ReviewPaused('daily', nextUtcMidnight(now()));

      const run = await runner(written.id);
      const paths = new Set(['diff.patch', 'pr.json', ...written.files.map((f) => f.path)]);
      for (const f of files) {
        paths.add(f.filename);
        if (f.previous_filename) paths.add(f.previous_filename);
      }
      const judged = judgeRun(run, { sha: job.sha, files: paths, jobDir: written.dir, now: now() });
      const { cost, turns, durationMs, modelUsage } = judged.usage;
      store.finishReviewRun(runId, {
        outcome: judged.ok ? 'valid' : judged.class,
        paid: judged.ok || judged.paid,
        result: judged.ok ? { state: judged.state, findings: judged.findings } : null,
        cost, turns, durationMs, modelUsage, now: now(),
      });
      const measured = `estimated cost ${cost ?? 'unknown'}, ${turns ?? '?'} turn(s), ${durationMs ?? '?'} ms`;
      log(`${label} review run: ${judged.ok ? judged.state : judged.class} (${measured})`);
      if (!judged.ok) {
        log(`${label} review problem: ${judged.why}. ${localDetail(judged.raw)}`);
        return shaped(afterFailure(job, judged));
      }
      store.reviewWorked();
      return shaped({ state: judged.state, summary: reviewSummary(judged), findings: judged.findings, reviewer });
    } finally {
      try {
        removeJobDir(root, written.id);
      } catch (err) {
        log(`${label} could not remove the job directory: ${err.code ?? err.message}`);
      }
    }
  };

  review.paid = true; // the dispatcher does not buy a review of a commit whose tests did not pass
  // Once when the service starts: jobs left by a crash go, and a pause waiting for the operator lifts, because a restart is how they say so.
  review.start = () => {
    const swept = sweepJobDirs(root);
    if (swept) log(`removed ${swept} job director(ies) left by a previous run`);
    if (store.clearAuthPause()) log('review pause lifted by the restart');
  };
  return review;
}

const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

// Which review the dispatcher runs. Unset means the mock: no job directory, no sudo, nothing paid.
// opt, sudo, root, deadlineMs and now are for tests; on the mini they stay at their defaults.
export function reviewEngine({ env = process.env, github, store, sandbox, log, now, opt, sudo, root, deadlineMs }) {
  const engine = (env.REVIEW_ENGINE ?? '').trim() || 'mock';
  if (engine === 'mock') return { runReview: mockReview(github) };
  if (engine !== 'shadow' && engine !== 'claude') throw new Error(`REVIEW_ENGINE must be mock, shadow or claude, not ${engine}`);
  const cap = (env.REVIEW_DAILY_CAP ?? '').trim();
  if (cap && !/^\d+$/.test(cap)) throw new Error('REVIEW_DAILY_CAP must be a whole number of runs');
  const unshown = (env.REVIEW_UNSHOWN_OK ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const paid = claudeReview({
    store, github, sandbox, log, ...defined({ root, now }),
    runner: sudoRunner(defined({ opt, sudo, deadlineMs })),
    dailyCap: cap ? Number(cap) : DEFAULT_DAILY_CAP,
    unshownOk: unshown.length ? unshown : UNSHOWN_OK,
  });
  return engine === 'claude' ? { runReview: paid } : { runReview: mockReview(github), shadowReview: paid };
}
