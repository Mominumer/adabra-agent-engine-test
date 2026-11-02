import { REVIEW_MARKER } from './github.js';
import { buildResult, parseTaskId } from './task-results.js';
import { ReviewPaused, ReviewSuperseded, STATUS_TEXT } from './review-output.js';
import { fence, plain, quiet } from '../shared/sanitize.js';

export const CONTEXTS = { tests: 'adabra/tests', review: 'adabra/review' };
export const SHADOW_CONTEXT = 'adabra/review-shadow'; // not required by branch protection, and not in CONTEXTS: only compared, never waited for
const OPERATOR_RECHECK_MS = 24 * 3_600_000; // a pause waiting for the operator has no end time, so its jobs look again at this pace
const STATES = new Set(['success', 'failure', 'error']);
const GAVE_UP = 'Review could not run; ask the operator (reviewer retry)';

// A step result is trusted only if it is well formed; anything else (missing, crashed, garbage) counts as an error.
// A check is never 'success' by default.
export function normalize(r, step) {
  if (!r || typeof r !== 'object' || !STATES.has(r.state)) {
    return { state: 'error', summary: `${step} step returned no valid result`, findings: [], log: '', reviewer: null, attention: [], advisory: false };
  }
  return {
    state: r.state,
    summary: String(r.summary ?? '').slice(0, 500),
    findings: Array.isArray(r.findings) ? r.findings.slice(0, 50) : [],
    log: String(r.log ?? ''),
    reviewer: r.reviewer ? String(r.reviewer).slice(0, 40) : null,
    attention: Array.isArray(r.attention) ? r.attention.slice(0, 60) : [],
    advisory: r.advisory === true,
  };
}

// A line of text from the review, for inside a code block: one line, nothing invisible, nothing that notifies or closes the block.
const inert = (s) => fence(quiet(plain(s).replace(/\p{Cf}/gu, '')));

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
    // A code block, because this text can come from a model that read the PR: no image, link or HTML in it can take effect.
    lines.push('', '**Findings**', '', '```');
    for (const f of review.findings) {
      const where = f.file ? `\`${f.file}${f.line ? `:${Number(f.line) || ''}` : ''}\` ` : '';
      lines.push(inert(`${f.severity ?? 'note'}: ${where}${f.message ?? ''}`));
    }
    lines.push('```');
  }
  if (review.attention.length) {
    lines.push('', '**Read these yourself**', '', '```', ...review.attention.map(inert), '```');
  }
  if (review.advisory) {
    lines.push('', '_Advisory only: a pass means the reviewer raised no blocker, not that the change is safe. Read it before merging._');
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
  // shadowReview: a second review to compare, run after the job is done. Its verdict goes to its own status and its findings to the log.
  constructor({ store, github, repo, authors, runTests, runReview, shadowReview = null, now = () => Date.now(), log = () => {}, linkTasks = false }) {
    Object.assign(this, { store, github, repo, runTests, runReview, shadowReview, now, log, linkTasks });
    this.authors = new Set(authors);
    this.skipped = new Set(); // log each skipped PR commit once, not every poll
  }

  eligible(pr) {
    if (pr.draft) return 'draft';
    if (pr.head_repo !== this.repo) return 'from a fork';
    if (!this.authors.has(pr.author)) return `author ${pr.author} is not on the allowlist`;
    return null;
  }

  // Once, when the service starts: whatever housekeeping the review engine has. The mock has none.
  start() {
    this.runReview.start?.();
    this.shadowReview?.start?.();
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
    } catch (err) {
      // The machinery failed (e.g. Docker down), not the PR: say so on GitHub and try again later.
      return this.#retry(job, `runner: ${err.message}`, 'Review infrastructure problem; retrying');
    }
    try {
      review = await this.#review(job, tests);
    } catch (err) {
      if (err instanceof ReviewPaused) return this.#paused(job, tests, err);
      if (err instanceof ReviewSuperseded) return this.#superseded(job, tests, err);
      // The tests did finish, so their real result still goes up while the review waits for another try.
      return this.#retry(job, `runner: ${err.message}`, 'Review infrastructure problem; retrying', tests);
    }
    try {
      await this.github.setStatus(job.sha, CONTEXTS.tests, tests.state, tests.summary || tests.state);
      await this.github.setStatus(job.sha, CONTEXTS.review, review.state, review.summary || review.state);
      await this.#upsertComment(job, renderComment(job, tests, review));
    } catch (err) {
      return this.#retry(job, `github: ${err.message}`, null);
    }
    // Only now, with the statuses posted: the job and its result for the task are saved together, or not at all.
    this.store.markDone(job.pr, job.sha, { tests: tests.state, review: review.state }, this.#taskResult(job, tests, review));
    this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} done: tests ${tests.state}, review ${review.state}`);
    await this.#shadow(job, tests);
    return { pr: job.pr, sha: job.sha, tests: tests.state, review: review.state };
  }

  // No verdict is not a pass, and a review of a commit whose tests did not pass is money for nothing.
  async #review(job, tests) {
    if (this.runReview.paid && tests.state !== 'success') return normalize({ state: 'error', summary: STATUS_TEXT.skipped }, 'review');
    return normalize(await this.runReview(job), 'review');
  }

  // The reviewer is paused, not the PR. The tests' real result still goes up, the review says why it has none, and the job waits
  // without using an attempt. No result for the task: this is not an outcome. It is deferred first, so a GitHub failure cannot lose that.
  async #paused(job, tests, paused) {
    const until = paused.until ?? this.now() + OPERATOR_RECHECK_MS;
    this.store.defer(job.pr, job.sha, until, paused.message);
    this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} waiting: ${paused.message}, next try ${new Date(until).toISOString()}`);
    const review = normalize({ state: 'error', summary: paused.statusText }, 'review');
    try {
      await this.github.setStatus(job.sha, CONTEXTS.tests, tests.state, tests.summary || tests.state);
      await this.github.setStatus(job.sha, CONTEXTS.review, review.state, review.summary);
      await this.#upsertComment(job, renderComment(job, tests, review));
    } catch (err) {
      this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} could not post the pause: ${err.message}`);
    }
    return { pr: job.pr, sha: job.sha, tests: tests.state, paused: paused.kind, until };
  }

  // A newer commit will get its own job and its own comment, so this one only closes its own statuses.
  async #superseded(job, tests, err) {
    this.store.markSuperseded(job.pr, job.sha);
    this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} superseded: ${err.message}`);
    await this.github.setStatus(job.sha, CONTEXTS.tests, tests.state, tests.summary || tests.state).catch(() => {});
    await this.github.setStatus(job.sha, CONTEXTS.review, 'error', err.statusText).catch(() => {});
    return { pr: job.pr, sha: job.sha, tests: tests.state, superseded: true };
  }

  // Comparison only: nothing here can touch the job, its required checks or its comment. The model's text stays in the local log.
  async #shadow(job, tests) {
    if (!this.shadowReview) return;
    const label = `PR #${job.pr} ${job.sha.slice(0, 12)}`;
    let state = 'error';
    let text = STATUS_TEXT.skipped;
    if (tests.state === 'success') {
      try {
        const r = normalize(await this.shadowReview(job), 'shadow');
        state = r.state;
        text = r.summary;
        for (const f of r.findings) {
          this.log(`${label} shadow finding: ${plain(`${f.severity} ${f.file ?? '-'}:${f.line ?? '-'} ${f.message}`)}`);
        }
      } catch (err) {
        text = err.statusText ?? 'Review could not complete';
        this.log(`${label} shadow review did not finish: ${err.message}`);
      }
    }
    await this.github.setStatus(job.sha, SHADOW_CONTEXT, state, text)
      .catch((err) => this.log(`${label} could not post the shadow status: ${err.message}`));
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

  // `tests`: the tests' result, when they finished and it was the review that failed.
  async #retry(job, error, statusText, tests = null) {
    // Giving up is an outcome the task should hear about too, or it goes on showing the verdict on an older commit.
    // The reason stays here: it is machinery detail, and the task's comment is public.
    const gaveUp = { state: 'error', summary: GAVE_UP, findings: [], reviewer: null };
    const dead = this.store.markRetry(job.pr, job.sha, error, this.now(), () => this.#taskResult(job, tests ?? gaveUp, gaveUp));
    this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} ${dead ? 'FAILED for good' : 'will retry'}: ${error}`);
    if (statusText) {
      const text = dead ? GAVE_UP : statusText;
      const testState = tests ? tests.state : 'error';
      const testText = tests ? tests.summary || tests.state : text;
      await this.github.setStatus(job.sha, CONTEXTS.tests, testState, testText).catch(() => {});
      await this.github.setStatus(job.sha, CONTEXTS.review, 'error', text).catch(() => {});
    }
    return { pr: job.pr, sha: job.sha, retry: !dead, failed: dead };
  }

  async #upsertComment(job, body) {
    let id = this.store.commentId(job.pr);
    if (id) {
      try {
        return await this.github.updateComment(id, body);
      } catch (err) {
        if (err.status !== 404) throw err; // deleted by someone: find or recreate below
      }
    }
    // Found by its marker, so a crash between creating it and remembering its id cannot create a second one.
    const found = await this.github.findReviewComment(job.pr);
    if (found) await this.github.updateComment(found, body);
    this.store.setCommentId(job.pr, found ?? (await this.github.createComment(job.pr, body)));
  }
}

// Phase 1 placeholder: until the Docker sandbox exists, every check reports an error (never a pass).
export const notConfigured = (step) => async () => ({
  state: 'error',
  summary: `${step} runner not set up yet on the mini`,
});
