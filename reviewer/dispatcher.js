import { REVIEW_MARKER } from './github.js';

export const CONTEXTS = { tests: 'adabra/tests', review: 'adabra/review' };
const STATES = new Set(['success', 'failure', 'error']);

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
  };
}

// Text that came from the PR or the sandbox is untrusted: no @mentions (they notify people), no breaking out of code blocks.
const quiet = (s) => String(s).replace(/@/g, '@​');
const fence = (s) => String(s).replace(/```/g, "'''");

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
  lines.push('', `_A new push is reviewed again automatically. Checked ${new Date().toISOString()}._`);
  return lines.join('\n');
}

export class Dispatcher {
  constructor({ store, github, repo, authors, runTests, runReview, now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { store, github, repo, runTests, runReview, now, log });
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
      const meta = { branch: pr.branch, author: pr.author, title: pr.title, body: pr.body };
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
      return this.#retry(job, `runner: ${err.message}`, 'Review infrastructure problem; retrying');
    }
    try {
      await this.github.setStatus(job.sha, CONTEXTS.tests, tests.state, tests.summary || tests.state);
      await this.github.setStatus(job.sha, CONTEXTS.review, review.state, review.summary || review.state);
      await this.#upsertComment(job, renderComment(job, tests, review));
    } catch (err) {
      return this.#retry(job, `github: ${err.message}`, null);
    }
    this.store.markDone(job.pr, job.sha, { tests: tests.state, review: review.state });
    this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} done: tests ${tests.state}, review ${review.state}`);
    return { pr: job.pr, sha: job.sha, tests: tests.state, review: review.state };
  }

  async #retry(job, error, statusText) {
    const dead = this.store.markRetry(job.pr, job.sha, error, this.now());
    this.log(`PR #${job.pr} ${job.sha.slice(0, 12)} ${dead ? 'FAILED for good' : 'will retry'}: ${error}`);
    if (statusText) {
      const text = dead ? 'Review could not run; ask the operator (reviewer retry)' : statusText;
      for (const ctx of Object.values(CONTEXTS)) {
        await this.github.setStatus(job.sha, ctx, 'error', text).catch(() => {});
      }
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
