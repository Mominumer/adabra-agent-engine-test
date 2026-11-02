import { DatabaseSync } from 'node:sqlite';

export const MAX_ATTEMPTS = 5;
const PAUSE_FIRST_MS = 60 * 60_000;
const PAUSE_MAX_MS = 6 * 60 * 60_000;
export const CHECK_PR_BASE = 900_000_000; // PR numbers from here up are made up by the check tools: no real PR gets near this

const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

export function nextUtcMidnight(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

// The dispatcher's own queue. One row per (PR, commit). Statuses on GitHub are per commit, so a new push is a new row
// and is reviewed again; older queued commits of the same PR are superseded rather than run.
export class ReviewStore {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS jobs (
        pr INTEGER NOT NULL,
        sha TEXT NOT NULL,
        meta TEXT NOT NULL,                -- JSON: branch, author, title, body
        state TEXT NOT NULL DEFAULT 'queued', -- queued | running | done | superseded | failed
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        result TEXT,                       -- JSON once done
        last_error TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (pr, sha)
      );
      CREATE TABLE IF NOT EXISTS prs (
        pr INTEGER PRIMARY KEY,
        comment_id INTEGER
      );
      -- Results waiting to reach the coordinator. A new table, so a live database needs nothing else to upgrade, and
      -- reviews finished before this existed are never sent.
      CREATE TABLE IF NOT EXISTS task_results (
        result_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        pr INTEGER NOT NULL,
        sha TEXT NOT NULL,
        payload TEXT NOT NULL,             -- the exact JSON sent; re-sent unchanged until acknowledged
        status TEXT NOT NULL DEFAULT 'pending', -- pending | acked | rejected
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_results_due ON task_results (status, next_attempt_at);
      -- One row per run of the real review, added before it starts: the daily count, the stored results and the tuning data.
      -- New tables only, like task_results, so a live database needs nothing else to upgrade.
      CREATE TABLE IF NOT EXISTS review_runs (
        id INTEGER PRIMARY KEY,
        pr INTEGER NOT NULL,
        sha TEXT NOT NULL,
        skill TEXT NOT NULL,
        model TEXT NOT NULL,
        utc_day TEXT NOT NULL,             -- what the daily cap counts by
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        paid INTEGER NOT NULL DEFAULT 1,   -- 0 only when the wrapper proved the model never started
        outcome TEXT,                      -- valid, or the class of failure. NULL: still running, or it crashed
        result TEXT,                       -- JSON { state, findings } when valid
        cost_usd REAL,                     -- the CLI's estimate, for comparison only
        num_turns INTEGER,
        duration_ms INTEGER,
        model_usage TEXT
      );
      CREATE INDEX IF NOT EXISTS review_runs_day ON review_runs (utc_day, paid);
      CREATE INDEX IF NOT EXISTS review_runs_result ON review_runs (pr, sha, skill, model, outcome);
      -- At most one row. Kept across restarts, so a restart cannot start spending against a limit that still holds.
      CREATE TABLE IF NOT EXISTS review_pause (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        kind TEXT,                         -- limit | auth, NULL when not paused
        until_at INTEGER,                  -- when a limit pause ends; an auth pause waits for the operator
        backoff_ms INTEGER NOT NULL DEFAULT 0,
        strikes INTEGER NOT NULL DEFAULT 0 -- unrecognised failures in a row
      );
    `);
  }

  #tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  #addTaskResult(r) {
    this.db
      .prepare('INSERT INTO task_results (result_id, task_id, pr, sha, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.result_id, r.task_id, r.pr, r.sha, JSON.stringify(r), r.reviewed_at);
  }

  // Returns true only the first time this (pr, sha) is seen.
  enqueue(pr, sha, meta, now) {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO jobs (pr, sha, meta, created_at) VALUES (?, ?, ?, ?)')
      .run(pr, sha, JSON.stringify(meta), now);
    if (r.changes === 0) return false;
    this.db
      .prepare("UPDATE jobs SET state = 'superseded' WHERE pr = ? AND sha != ? AND state = 'queued'")
      .run(pr, sha);
    return true;
  }

  next(now) {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE state = 'queued' AND next_attempt_at <= ? ORDER BY created_at LIMIT 1")
      .get(now);
    return row ? { ...row, meta: JSON.parse(row.meta) } : null;
  }

  markRunning(pr, sha) {
    this.db.prepare("UPDATE jobs SET state = 'running', attempts = attempts + 1 WHERE pr = ? AND sha = ?").run(pr, sha);
  }

  // One transaction with the job, so a crash cannot leave a finished review whose result for the task is lost.
  markDone(pr, sha, result, taskResult = null) {
    this.#tx(() => {
      this.db
        .prepare("UPDATE jobs SET state = 'done', result = ?, last_error = NULL WHERE pr = ? AND sha = ?")
        .run(JSON.stringify(result), pr, sha);
      if (taskResult) this.#addTaskResult(taskResult);
    });
  }

  // Back to the queue with backoff, or 'failed' after MAX_ATTEMPTS. Returns true when it gave up.
  // taskResultIfDead is asked for a result to save with the job only when it gave up.
  markRetry(pr, sha, error, now, taskResultIfDead = () => null) {
    return this.#tx(() => {
      const { attempts } = this.db.prepare('SELECT attempts FROM jobs WHERE pr = ? AND sha = ?').get(pr, sha);
      const dead = attempts >= MAX_ATTEMPTS;
      this.db
        .prepare('UPDATE jobs SET state = ?, next_attempt_at = ?, last_error = ? WHERE pr = ? AND sha = ?')
        .run(dead ? 'failed' : 'queued', now + Math.min(600_000, 5000 * 2 ** attempts), String(error).slice(0, 500), pr, sha);
      const taskResult = dead ? taskResultIfDead() : null;
      if (taskResult) this.#addTaskResult(taskResult);
      return dead;
    });
  }

  // Back to the queue, taking back the attempt markRunning counted, so it can never use up its attempts this way.
  // For when the fault is not the job's: see the dispatcher.
  holdJob(pr, sha, error, nextAttemptAt) {
    this.db
      .prepare("UPDATE jobs SET state = 'queued', attempts = MAX(attempts - 1, 0), next_attempt_at = ?, last_error = ? WHERE pr = ? AND sha = ?")
      .run(nextAttemptAt, String(error).slice(0, 500), pr, sha);
  }

  // --- results for the coordinator ----------------------------------------
  // Oldest first. The coordinator decides what is stale, so order here is only a courtesy.
  dueTaskResults(now) {
    return this.db
      .prepare("SELECT * FROM task_results WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at, rowid")
      .all(now);
  }

  ackTaskResult(resultId) {
    this.db.prepare("UPDATE task_results SET status = 'acked', last_error = NULL WHERE result_id = ?").run(resultId);
  }

  rejectTaskResult(resultId, error) {
    this.db.prepare("UPDATE task_results SET status = 'rejected', last_error = ? WHERE result_id = ?").run(String(error).slice(0, 500), resultId);
  }

  // Stays pending however long the coordinator is away; only the wait between attempts is capped.
  retryTaskResult(resultId, error, now) {
    const { attempts } = this.db.prepare('SELECT attempts FROM task_results WHERE result_id = ?').get(resultId);
    this.db
      .prepare('UPDATE task_results SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE result_id = ?')
      .run(attempts + 1, now + Math.min(300_000, 1000 * 2 ** (attempts + 1)), String(error).slice(0, 500), resultId);
  }

  getTaskResult(resultId) {
    const row = this.db.prepare('SELECT * FROM task_results WHERE result_id = ?').get(resultId);
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }

  taskResultCounts() {
    return Object.fromEntries(
      this.db.prepare('SELECT status, COUNT(*) AS n FROM task_results GROUP BY status').all().map((r) => [r.status, r.n]),
    );
  }

  // Newest first, leaving out the ones delivered: what an operator may need to act on.
  undeliveredTaskResults(limit = 10) {
    return this.db
      .prepare("SELECT task_id, pr, sha, status, attempts, last_error FROM task_results WHERE status != 'acked' ORDER BY created_at DESC LIMIT ?")
      .all(limit);
  }

  markSuperseded(pr, sha) {
    this.db.prepare("UPDATE jobs SET state = 'superseded' WHERE pr = ? AND sha = ?").run(pr, sha);
  }

  // Takes a job out of the queue because the operator has overridden it while it waited, so no later result can replace the override.
  // Only if it is still waiting: false once it is due or running. `retry` can bring it back.
  closeWaitingJob(pr, sha, now, why) {
    const r = this.db
      .prepare("UPDATE jobs SET state = 'superseded', last_error = ? WHERE pr = ? AND sha = ? AND state = 'queued' AND next_attempt_at > ?")
      .run(String(why).slice(0, 500), pr, sha, now);
    return r.changes === 1;
  }

  // Undoes closeWaitingJob, when the override could not be posted after all. next_attempt_at was left as it was.
  reopenWaitingJob(pr, sha, lastError) {
    this.db.prepare("UPDATE jobs SET state = 'queued', last_error = ? WHERE pr = ? AND sha = ?").run(lastError, pr, sha);
  }

  // --- runs of the real review ---------------------------------------------
  paidRunsOn(now) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM review_runs WHERE utc_day = ? AND paid = 1').get(utcDay(now)).n;
  }

  // Returns the run's id, or null when the day's cap is already reached. Check and count happen together.
  beginReviewRun({ pr, sha, skill, model, now, cap }) {
    return this.#tx(() => {
      if (this.paidRunsOn(now) >= cap) return null;
      const r = this.db
        .prepare('INSERT INTO review_runs (pr, sha, skill, model, utc_day, started_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(pr, sha, skill, model, utcDay(now), now);
      return Number(r.lastInsertRowid);
    });
  }

  finishReviewRun(id, { outcome, paid = true, result = null, cost = null, turns = null, durationMs = null, modelUsage = null, now }) {
    this.db
      .prepare('UPDATE review_runs SET outcome = ?, paid = ?, result = ?, cost_usd = ?, num_turns = ?, duration_ms = ?, model_usage = ?, finished_at = ? WHERE id = ?')
      .run(outcome, paid ? 1 : 0, result ? JSON.stringify(result) : null, cost, turns, durationMs, modelUsage, now, id);
  }

  // The stored valid result, or null. By PR as well as commit: the diff the review read depends on the PR's base. A row that does
  // not read as a result is a miss, so it can only ever cost a run, never become a verdict.
  cachedReview({ pr, sha, skill, model }) {
    const row = this.db
      .prepare("SELECT result FROM review_runs WHERE pr = ? AND sha = ? AND skill = ? AND model = ? AND outcome = 'valid' ORDER BY id DESC LIMIT 1")
      .get(pr, sha, skill, model);
    if (!row) return null;
    try {
      const r = JSON.parse(row.result);
      return (r?.state === 'success' || r?.state === 'failure') && Array.isArray(r.findings) ? r : null;
    } catch {
      return null;
    }
  }

  reviewRuns(pr, sha) {
    return this.db.prepare('SELECT * FROM review_runs WHERE pr = ? AND sha = ? ORDER BY id').all(pr, sha);
  }

  // Real reviews so far, as counts and the CLI's estimates: never what a review said. The live check's rows have made-up PR numbers and
  // are left out, though they do count towards the day's cap.
  reviewRunTotals() {
    const totals = this.db
      .prepare(`SELECT COUNT(*) AS runs, COUNT(DISTINCT sha) AS commits, SUM(cost_usd) AS cost, SUM(num_turns) AS turns, SUM(duration_ms) AS ms
        FROM review_runs WHERE pr < ?`)
      .get(CHECK_PR_BASE);
    const groups = this.db
      .prepare(`SELECT COALESCE(outcome, 'unfinished') AS outcome, CASE WHEN json_valid(result) THEN json_extract(result, '$.state') END AS state, COUNT(*) AS n
        FROM review_runs WHERE pr < ? GROUP BY 1, 2`)
      .all(CHECK_PR_BASE);
    return { ...totals, groups };
  }

  // --- the pause on real reviews -------------------------------------------
  #pauseRow() {
    return this.db.prepare('SELECT kind, until_at, backoff_ms, strikes FROM review_pause WHERE id = 1').get()
      ?? { kind: null, until_at: null, backoff_ms: 0, strikes: 0 };
  }

  #savePause({ kind, until_at: until, backoff_ms: backoff, strikes }) {
    this.db
      .prepare(`INSERT INTO review_pause (id, kind, until_at, backoff_ms, strikes) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, until_at = excluded.until_at, backoff_ms = excluded.backoff_ms, strikes = excluded.strikes`)
      .run(kind, until, backoff, strikes);
  }

  // { kind, until }, or null when reviews may run. An expired limit pause lets one job through: its result decides what happens next.
  reviewPause(now) {
    const r = this.#pauseRow();
    if (r.kind === 'auth') return { kind: 'auth', until: null };
    return r.kind && r.until_at > now ? { kind: r.kind, until: r.until_at } : null;
  }

  // Until the stated reset if there is one, otherwise a back-off that doubles to a ceiling. Returns when it ends.
  pauseForLimit(now, statedReset = null) {
    const r = this.#pauseRow();
    const backoff = statedReset ? r.backoff_ms : Math.min(PAUSE_MAX_MS, r.backoff_ms ? r.backoff_ms * 2 : PAUSE_FIRST_MS);
    const until = statedReset ?? now + backoff;
    this.#savePause({ ...r, kind: 'limit', until_at: until, backoff_ms: backoff });
    return until;
  }

  pauseForAuth() {
    this.#savePause({ ...this.#pauseRow(), kind: 'auth', until_at: null });
  }

  // Returns how many in a row, this one included.
  addStrike() {
    const r = this.#pauseRow();
    this.#savePause({ ...r, strikes: r.strikes + 1 });
    return r.strikes + 1;
  }

  clearStrikes() {
    this.#savePause({ ...this.#pauseRow(), strikes: 0 });
  }

  // A run reached the model and came back, so the account is fine, whatever the result was.
  reviewWorked() {
    this.#savePause({ kind: null, until_at: null, backoff_ms: 0, strikes: 0 });
  }

  // The operator says go: jobs that were waiting for the pause to end come due now. Touches nothing when there is no pause.
  clearPause() {
    if (!this.#pauseRow().kind) return false;
    this.reviewWorked();
    this.db.prepare("UPDATE jobs SET next_attempt_at = 0 WHERE state = 'queued'").run();
    return true;
  }

  clearAuthPause() {
    return this.#pauseRow().kind === 'auth' ? this.clearPause() : false;
  }

  // After a crash or restart, anything left 'running' never finished: run it again.
  requeueInterrupted() {
    return this.db.prepare("UPDATE jobs SET state = 'queued' WHERE state = 'running'").run().changes;
  }

  // Back to the queue because of the operator's stop, not because anything failed: this run does not count against the job.
  parkJob(pr, sha) {
    this.db.prepare("UPDATE jobs SET state = 'queued', attempts = MAX(attempts - 1, 0) WHERE pr = ? AND sha = ?").run(pr, sha);
  }

  getJob(pr, sha) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE pr = ? AND sha = ?').get(pr, sha);
    return row ? { ...row, meta: JSON.parse(row.meta), result: row.result && JSON.parse(row.result) } : null;
  }

  // Operator: run the latest commit of a PR again (e.g. after fixing Docker).
  retry(pr) {
    const row = this.db.prepare('SELECT sha FROM jobs WHERE pr = ? ORDER BY created_at DESC LIMIT 1').get(pr);
    if (!row) return false;
    this.db
      .prepare("UPDATE jobs SET state = 'queued', attempts = 0, next_attempt_at = 0 WHERE pr = ? AND sha = ?")
      .run(pr, row.sha);
    this.clearPause();
    return true;
  }

  commentId(pr) {
    return this.db.prepare('SELECT comment_id FROM prs WHERE pr = ?').get(pr)?.comment_id ?? null;
  }

  setCommentId(pr, id) {
    this.db
      .prepare('INSERT INTO prs (pr, comment_id) VALUES (?, ?) ON CONFLICT(pr) DO UPDATE SET comment_id = excluded.comment_id')
      .run(pr, id);
  }

  counts() {
    return Object.fromEntries(
      this.db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all().map((r) => [r.state, r.n]),
    );
  }

  recent(limit = 20) {
    return this.db
      .prepare('SELECT pr, sha, state, attempts, last_error, result FROM jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map((r) => ({ ...r, result: r.result && JSON.parse(r.result) }));
  }

  close() {
    this.db.close();
  }
}
