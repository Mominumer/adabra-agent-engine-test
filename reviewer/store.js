import { DatabaseSync } from 'node:sqlite';

export const MAX_ATTEMPTS = 5;

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

  // After a crash or restart, anything left 'running' never finished: run it again.
  requeueInterrupted() {
    return this.db.prepare("UPDATE jobs SET state = 'queued' WHERE state = 'running'").run().changes;
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
