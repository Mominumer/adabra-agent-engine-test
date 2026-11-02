import { REVIEW_MARKER } from './github.js';
import { buildResult, parseTaskId } from './task-results.js';
import { fence, quiet } from '../shared/sanitize.js';
import { AUTH_HOLD_MS, upsertComment } from '../shared/github-auth.js';

export const CONTEXTS = { tests: 'adabra/tests', review: 'adabra/review' };
const STATES = new Set(['success', 'failure', 'error']);
const GAVE_UP = 'Review could not run; ask the operator (reviewer retry)';

// A step result is trusted only if it is well formed; anything else (missing, crashed, garbage) counts as an error.
// A check is never 'success' by default.
export function normalize(r, step) {
  if (!r || typeof r !== 'object' || !STATES.has(r.state)) {
    return { state: 'error', summary: `${step} step returned no valid result`, findings: [], log: '' };
  }
  return {
    state: r.state,
    summary: String(r.summary ?? '').slice(0, 500),
    findings: Array.isArray(r.findings) ? r.findings.slice(0, 50) : [],
    log: String(r.log ?? ''),
    reviewer: r.reviewer ? String(r.reviewer).slice(0, 40) : null,
  };
}

export function renderComment(job, tests, review) {
  const icon = { success: 'pass', failure: 'FAIL', error: 'ERROR' };
  const lines = [
    REVIEW_MARKER,
    `**Adabra review for \`${job.sha.slice(0, 12)}\`**`,
    '',
    '| Check | Result | Summary |',
    '|---|---|---|',
    `| ${CONTEXTS.tests} | ${icon[tests.state]} | ${quiet(tests.summary).replace(/\|/g, '\\|')} |`,
    `| ${CONTEXTS.review} | ${icon[review.state]} | ${quiet(review.summary).replace(/\|/g, '\\|')} |`,
  ];
  if (review.findings.length) {
    lines.push('', '**Findings**', '');
    for (const f of review.findings) {
      const where = f.file ? `\`${quiet(f.file)}${f.line ? `:${Number(f.line) || ''}` : ''}\` ` : '';
      lines.push(`- ${quiet(f.severity ?? 'note')}: ${where}${quiet(f.message ?? '')}`);
    }
  }
  if (tests.log) {
    const tail = tests.log.length > 3000 ? `…\n${tests.log.slice(-3000)}` : tests.log;
    lines.push('', '<details><summary>Test output (last 3000 characters)</summary>', '', '```', fence(quiet(tail)), '```', '</details>');
  }
  const by = review.reviewer ? `Review by ${quiet(review.reviewer)}. ` : '';
  lines.push('', `_${by}A new push is reviewed again automatically. Checked ${new Date().toISOString()}._`);
  return lines.join('\n');
}

export class Dispatcher {
  // linkTasks: queue a result for the coordinator when a job belongs to a task. Off when this reviewer has no device identity.
  constructor({ store, github, repo, authors, runTests, runReview, now = () => Date.now(), log = () => {}, linkTasks = false }) {
    Object.assign(this, { store, github, repo, runTests, runReview, now, log, linkTasks });
    this.authors = new Set(authors);
    this.skipped = new Set(); // log each skipped PR commit once, not every poll
  }

  eligible(pr) {
    if (pr.draft) return 'draft';
    if (pr.head_repo !== this.repo) return 'from a fork';
    if (!this.authors.has(pr.author)) return `author ${pr.author} is not on the allowlist`;
    return null;
  }

  // Queue every new head commit of eligible open PRs and mark it pending on GitHub.
  async poll() {
    let queued = 0;
    for (const pr of await this.github.openPulls()) {
      const why = this.eligible(pr);
      if (why) {
        const key = `${pr.number}:${pr.sha}`;
        if (!this.skipped.has(key)) this.log(`PR #${pr.number} skipped: ${why}`);
        this.skipped.add(key);
        continue;
      }
      const meta = { branch: pr.branch, base: pr.base, author: pr.author, title: pr.title, body: pr.body };
      if (this.store.enqueue(pr.number, pr.sha, meta, this.now())) {
        queued++;
        this.log(`PR #${pr.number} ${pr.sha.slice(0, 12)} queued`);
        for (const ctx of Object.values(CONTEXTS)) await this.github.setStatus(pr.sha, ctx, 'pending', 'Queued on the Adabra mini');
      }
    }
    return queued;
  }

  // Run the oldest due job. Returns the job's outcome, or null when there is nothing to do.
  async runOnce() {
    const job = this.store.next(this.now());
    if (!job) return null;
    this.store.markRunning(job.pr, job.sha);
    this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} running`);
    let tests, review;
    try {
      tests = normalize(await this.runTests(job), 'test');
      review = normalize(await this.runReview(job), 'review');
    } catch (err) {
      // The machinery failed (e.g. Docker down), not the PR: say so on GitHub and try again later.
      return this.#retry(job, `runner: ${err.message}`, 'Review infrastructure problem; retrying', err);
    }
    try {
      await this.github.setStatus(job.sha, CONTEXTS.tests, tests.state, tests.summary || tests.state);
      await this.github.setStatus(job.sha, CONTEXTS.review, review.state, review.summary || review.state);
      await this.#upsertComment(job, renderComment(job, tests, review));
    } catch (err) {
      return this.#retry(job, `github: ${err.message}`, null, err);
    }
    // Only now, with the statuses posted: the job and its result for the task are saved together, or not at all.
    this.store.markDone(job.pr, job.sha, { tests: tests.state, review: review.state }, this.#taskResult(job, tests, review));
    this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} done: tests ${tests.state}, review ${review.state}`);
    return { pr: job.pr, sha: job.sha, tests: tests.state, review: review.state };
  }

  // What to tell the coordinator about this job, or null. Never throws: nothing about the task link may disturb a review.
  #taskResult(job, tests, review) {
    if (!this.linkTasks) return null;
    try {
      const { task_id: taskId, why } = parseTaskId(job.meta);
      if (why) this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} not linked to a task: ${why}`);
      return taskId ? buildResult({ taskId, job, tests, review, now: this.now() }) : null;
    } catch (err) {
      this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} task result not prepared: ${err.message}`);
      return null;
    }
  }

  async #retry(job, error, statusText, cause) {
    // Our own credentials are out, which says nothing about this job: it waits, however long that takes, and no attempt is used.
    // No status either, as GitHub would refuse it.
    if (cause?.authOutage) {
      this.store.holdJob(job.pr, job.sha, error, this.now() + AUTH_HOLD_MS);
      this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} held, not counted as an attempt: ${error}`);
      return { pr: job.pr, sha: job.sha, retry: true, failed: false };
    }
    // Giving up is an outcome the task should hear about too, or it goes on showing the verdict on an older commit.
    // The reason stays here: it is machinery detail, and the task's comment is public.
    const gaveUp = { state: 'error', summary: GAVE_UP, findings: [], reviewer: null };
    const dead = this.store.markRetry(job.pr, job.sha, error, this.now(), () => this.#taskResult(job, gaveUp, gaveUp));
    this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} ${dead ? 'FAILED for good' : 'will retry'}: ${error}`);
    if (statusText) {
      const text = dead ? GAVE_UP : statusText;
      for (const ctx of Object.values(CONTEXTS)) {
        await this.github.setStatus(job.sha, ctx, 'error', text).catch(() => {});
      }
    }
    return { pr: job.pr, sha: job.sha, retry: !dead, failed: dead };
  }

  async #upsertComment(job, body) {
    const remembered = this.store.commentId(job.pr);
    const id = await upsertComment({
      remembered,
      label: `PR #${job.pr}`,
      log: this.log,
      // Found by its marker, so a crash between creating it and remembering its id cannot create a second one.
      find: () => this.github.findReviewComment(job.pr),
      update: (commentId) => this.github.updateComment(commentId, body),
      create: () => this.github.createComment(job.pr, body),
    });
    if (id !== remembered) this.store.setCommentId(job.pr, id);
  }
}

// Phase 1 placeholder: until the Docker sandbox exists, every check reports an error (never a pass).
export const notConfigured = (step) => async () => ({
  state: 'error',
  summary: `${step} runner not set up yet on the mini`,
});
