import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { verdictOf } from '../shared/review-result.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const MAX_ATTEMPTS = 8;
export const ROLES = ['builder', 'reviewer']; // a device has exactly one, for life: a builder cannot become a reviewer

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        issue_number INTEGER NOT NULL,
        comment_id INTEGER,
        applied_ts TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        ts TEXT NOT NULL,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS events_due ON events (status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS claims (
        task_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL            -- held | released | cancelled
      );
      -- Every result accepted from a reviewer, so a re-delivery is recognised whatever has happened since.
      CREATE TABLE IF NOT EXISTS review_results (
        result_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        applied INTEGER NOT NULL,      -- 0 = older than what the task already showed; never shown
        received_at TEXT NOT NULL
      );
      -- The result each task shows, and whether that still has to reach the task's GitHub comment.
      CREATE TABLE IF NOT EXISTS task_reviews (
        task_id TEXT PRIMARY KEY,
        result_id TEXT NOT NULL,
        commit_seen_at INTEGER NOT NULL,
        reviewed_at INTEGER NOT NULL,
        comment_pending INTEGER NOT NULL DEFAULT 1,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS task_reviews_due ON task_reviews (comment_pending, next_attempt_at);
    `);
    // Databases created before a column existed: add it. Existing rows keep working: every device there is a builder.
    // One transaction, so two processes opening an old database together cannot both try.
    this.#tx(() => {
      for (const [table, columns] of [
        ['tasks', [
          ['generation', 'INTEGER NOT NULL DEFAULT 0'],
          ['title', 'TEXT'],
          ['assignee', 'TEXT'], // device_id this task is reserved for; NULL = anyone
          ['closed', 'INTEGER NOT NULL DEFAULT 0'],
          ['source', "TEXT NOT NULL DEFAULT 'manual'"], // 'github' = kept in step with the issue by task-sync
          ['returned_to', 'TEXT'], // device a failed review sent this back to; see recordReviewResult
        ]],
        ['devices', [
          ['role', "TEXT NOT NULL DEFAULT 'builder'"],
        ]],
      ]) {
        const cols = this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
        for (const [name, ddl] of columns) {
          if (!cols.includes(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
        }
      }
    });
  }

  // --- claims ------------------------------------------------------------
  // A claim is an exclusive lease on a task. `generation` only ever increases per task and
  // fences old owners: output from a generation that is no longer current is rejected.
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

  #claimRow(taskId) {
    return this.db.prepare('SELECT * FROM claims WHERE task_id = ?').get(taskId);
  }

  claimTask(taskId, deviceId, runId, now, ttlMs) {
    return this.#tx(() => {
      const task = this.getTask(taskId);
      if (!task) return { ok: false, reason: 'unknown_task' };
      if (task.closed) return { ok: false, reason: 'closed' };
      if (task.assignee && task.assignee !== deviceId) return { ok: false, reason: 'assigned', owner: task.assignee };
      const cur = this.#claimRow(taskId);
      if (cur && cur.state === 'held' && cur.expires_at > now) {
        if (cur.device_id === deviceId && cur.run_id === runId) {
          // Same owner asking again (e.g. a lost reply): idempotent, extend the lease.
          this.db.prepare('UPDATE claims SET expires_at = ? WHERE task_id = ?').run(now + ttlMs, taskId);
          return { ok: true, generation: cur.generation, expires_at: now + ttlMs };
        }
        return { ok: false, reason: 'claimed', owner: cur.device_id, expires_at: cur.expires_at };
      }
      if (this.#returnBlocks(task, deviceId)) return { ok: false, reason: 'returned', owner: task.returned_to };
      const generation = task.generation + 1;
      // A new claim is someone picking the task up, which is what the return was asking for: it has done its job.
      this.db.prepare('UPDATE tasks SET generation = ?, returned_to = NULL WHERE task_id = ?').run(generation, taskId);
      this.db
        .prepare(
          "INSERT INTO claims (task_id, device_id, run_id, generation, expires_at, state) VALUES (?, ?, ?, ?, ?, 'held') " +
            'ON CONFLICT(task_id) DO UPDATE SET device_id = excluded.device_id, run_id = excluded.run_id, ' +
            "generation = excluded.generation, expires_at = excluded.expires_at, state = 'held'",
        )
        .run(taskId, deviceId, runId, generation, now + ttlMs);
      return { ok: true, generation, expires_at: now + ttlMs };
    });
  }

  // The caller must still be the current owner: same device, run and generation, still held, not expired.
  // An expired lease cannot be renewed: the owner must claim again (which bumps the generation).
  renewClaim(taskId, deviceId, runId, generation, now, ttlMs) {
    return this.#tx(() => {
      const cur = this.#claimRow(taskId);
      const task = this.getTask(taskId);
      if (!cur || !task) return { ok: false, reason: 'not_current' };
      if (cur.generation !== generation || task.generation !== generation) return { ok: false, reason: 'superseded' };
      if (cur.device_id !== deviceId || cur.run_id !== runId) return { ok: false, reason: 'not_owner' };
      if (cur.state !== 'held') return { ok: false, reason: cur.state };
      if (cur.expires_at <= now) return { ok: false, reason: 'expired' };
      this.db.prepare('UPDATE claims SET expires_at = ? WHERE task_id = ?').run(now + ttlMs, taskId);
      return { ok: true, generation, expires_at: now + ttlMs };
    });
  }

  releaseClaim(taskId, deviceId, runId, generation) {
    return this.#tx(() => {
      const cur = this.#claimRow(taskId);
      if (!cur || cur.generation !== generation || cur.device_id !== deviceId || cur.run_id !== runId) {
        return { ok: false, reason: 'not_current' };
      }
      if (cur.state === 'held') this.db.prepare("UPDATE claims SET state = 'released' WHERE task_id = ?").run(taskId);
      return { ok: true };
    });
  }

  // Operator action: bumps the generation so the current owner's later output is fenced.
  cancelClaim(taskId) {
    return this.#tx(() => {
      const task = this.getTask(taskId);
      if (!task) return { ok: false, reason: 'unknown_task' };
      this.db.prepare('UPDATE tasks SET generation = generation + 1, returned_to = NULL WHERE task_id = ?').run(taskId);
      this.db.prepare("UPDATE claims SET state = 'cancelled' WHERE task_id = ?").run(taskId);
      return { ok: true, generation: task.generation + 1 };
    });
  }

  // The operator's stop: keeps alive every lease that was live when the stop began, so refusing renewals costs nobody a claim.
  // Owner and generation stay as they are. A lease that had already lapsed by then stays lapsed. See stop-keeper.js.
  holdLeases(since, now, ttlMs) {
    return this.db
      .prepare("UPDATE claims SET expires_at = ? WHERE state = 'held' AND expires_at > ? AND expires_at < ?")
      .run(now + ttlMs, since, now + ttlMs).changes;
  }

  // An event is acceptable only from the current generation's owner. Fencing is by generation, not by
  // wall-clock expiry: an owner whose lease lapsed but who was never replaced may still report genuine work.
  eventMatchesClaim(event) {
    const task = this.getTask(event.task_id);
    const cur = this.#claimRow(event.task_id);
    return Boolean(
      task && cur &&
        task.generation === event.claim_generation &&
        cur.generation === event.claim_generation &&
        cur.device_id === event.device_id &&
        cur.run_id === event.run_id &&
        cur.state !== 'cancelled',
    );
  }

  eventStatus(event) {
    const row = this.db.prepare('SELECT payload_hash FROM events WHERE event_id = ?').get(event.event_id);
    if (!row) return 'new';
    return row.payload_hash === sha256(JSON.stringify(event)) ? 'duplicate' : 'conflict';
  }

  currentClaim(taskId) {
    return this.#claimRow(taskId);
  }

  close() {
    this.db.close();
  }

  // --- review results ----------------------------------------------------
  // How a failed review "returns the task to its owner": a reservation, not a claim. The result never grants, renews,
  // cancels or moves a lease and never changes the generation, so a reviewer cannot affect who may write checkpoints.
  // While a task is returned nobody else can claim it, and the owner sees it first and claims it the normal way, which
  // gets a new generation and ends the reservation. It also ends with a passing review, and when an operator steps in.
  //
  // The owner is the device the operator reserved the task for, else whoever holds the live lease, else whoever claimed
  // it last (they may have released, or their lease lapsed). A revoked device, or one whose claim an operator cancelled,
  // owns nothing; with no owner the result is still shown, but anyone may claim the task.
  #reviewOwner(task, now) {
    const c = this.#claimRow(task.task_id);
    const holder = c && c.state === 'held' && c.expires_at > now ? c.device_id : null;
    const last = c && c.state !== 'cancelled' ? c.device_id : null;
    return [task.assignee, holder, last].find((d) => d && this.isActiveBuilder(d)) ?? null;
  }

  // Does a return keep this device from claiming the task? The device the operator reserved it for always may claim it,
  // and a revoked device cannot hold a task hostage.
  #returnBlocks(task, deviceId) {
    return Boolean(task.returned_to) && task.returned_to !== deviceId && task.assignee !== deviceId && this.isActiveBuilder(task.returned_to);
  }

  #shownResult(taskId) {
    const row = this.db
      .prepare('SELECT r.payload FROM task_reviews t JOIN review_results r ON r.result_id = t.result_id WHERE t.task_id = ?')
      .get(taskId);
    return row ? JSON.parse(row.payload) : null;
  }

  // Committed (synchronous=FULL) before this returns, so the caller may acknowledge. Returns { outcome }:
  //   unknown_task  no such task
  //   conflict      this result id was already used with a different payload
  //   duplicate     seen before: nothing happens, so a late re-delivery cannot return a task its owner has picked up again
  //   stale         older than what the task shows (an older commit, or an older review of the same commit): kept, not shown
  //   accepted      now what the task shows
  recordReviewResult(result, deviceId, now) {
    const payload = JSON.stringify(result);
    const payloadHash = sha256(payload);
    return this.#tx(() => {
      const task = this.getTask(result.task_id);
      if (!task) return { outcome: 'unknown_task' };
      const seen = this.db.prepare('SELECT payload_hash FROM review_results WHERE result_id = ?').get(result.result_id);
      if (seen) return { outcome: seen.payload_hash === payloadHash ? 'duplicate' : 'conflict' };

      const cur = this.db.prepare('SELECT commit_seen_at, reviewed_at FROM task_reviews WHERE task_id = ?').get(result.task_id);
      const newer =
        !cur ||
        result.commit_seen_at > cur.commit_seen_at ||
        (result.commit_seen_at === cur.commit_seen_at && result.reviewed_at > cur.reviewed_at);
      this.db
        .prepare(
          'INSERT INTO review_results (result_id, task_id, device_id, payload, payload_hash, applied, received_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(result.result_id, result.task_id, deviceId, payload, payloadHash, newer ? 1 : 0, new Date().toISOString());
      if (!newer) return { outcome: 'stale' };

      this.db
        .prepare(
          'INSERT INTO task_reviews (task_id, result_id, commit_seen_at, reviewed_at) VALUES (?, ?, ?, ?) ' +
            'ON CONFLICT(task_id) DO UPDATE SET result_id = excluded.result_id, commit_seen_at = excluded.commit_seen_at, ' +
            'reviewed_at = excluded.reviewed_at, comment_pending = 1, attempts = 0, next_attempt_at = 0, last_error = NULL',
        )
        .run(result.task_id, result.result_id, result.commit_seen_at, result.reviewed_at);

      // 'error' says nothing about the work, so it leaves any return as it stands.
      const verdict = verdictOf(result);
      let returnedTo = task.returned_to;
      if (verdict === 'passed') returnedTo = null;
      if (verdict === 'changes_requested') returnedTo = task.closed ? null : this.#reviewOwner(task, now);
      this.db.prepare('UPDATE tasks SET returned_to = ? WHERE task_id = ?').run(returnedTo, result.task_id);
      return { outcome: 'accepted', verdict, returned_to: returnedTo };
    });
  }

  // What the task's GitHub comment shows. Its free text is still raw: renderComment makes it inert.
  reviewForComment(taskId) {
    const result = this.#shownResult(taskId);
    return result ? { ...result, verdict: verdictOf(result), returned_to: this.getTask(taskId).returned_to } : null;
  }

  // What a task list shows, and so what a builder agent reads and may act on. Validated fields only: none of a review's
  // free text (summaries, finding messages) ever goes this way, so it cannot be taken for instructions.
  reviewBrief(taskId) {
    const r = this.#shownResult(taskId);
    if (!r) return null;
    return {
      verdict: verdictOf(r),
      sha: r.sha,
      pr: r.pr,
      tests: r.tests,
      review: r.review,
      findings_total: r.findings_total,
      findings: r.findings.map(({ severity, file, line }) => ({ severity, file, line })),
    };
  }

  dueReviewComments(nowMs, limit = 50) {
    return this.db
      .prepare('SELECT task_id, result_id FROM task_reviews WHERE comment_pending = 1 AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?')
      .all(nowMs, limit);
  }

  // Only if this is still the result on show: one that arrived while GitHub was being written to still needs its turn.
  reviewCommentDone(taskId, resultId) {
    this.db
      .prepare('UPDATE task_reviews SET comment_pending = 0, attempts = 0, last_error = NULL WHERE task_id = ? AND result_id = ?')
      .run(taskId, resultId);
  }

  // Keeps trying for as long as it takes: an outage must not leave a task showing the wrong verdict.
  reviewCommentFailed(taskId, resultId, error, nowMs) {
    const row = this.db.prepare('SELECT attempts FROM task_reviews WHERE task_id = ? AND result_id = ?').get(taskId, resultId);
    if (!row) return;
    this.db
      .prepare('UPDATE task_reviews SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE task_id = ?')
      .run(row.attempts + 1, nowMs + Math.min(300_000, 2000 * 2 ** (row.attempts + 1)), String(error).slice(0, 500), taskId);
  }

  // The checkpoint the task's comment shows, so writing a review result does not wipe it.
  lastAppliedEvent(taskId) {
    const task = this.getTask(taskId);
    if (!task?.applied_ts) return null;
    const row = this.db
      .prepare("SELECT payload FROM events WHERE task_id = ? AND ts = ? AND status = 'done' LIMIT 1")
      .get(taskId, task.applied_ts);
    return row ? JSON.parse(row.payload) : null;
  }

  // --- devices -----------------------------------------------------------
  addDevice(deviceId, role = 'builder') {
    if (!ROLES.includes(role)) throw new Error(`unknown role ${role}`);
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare('INSERT INTO devices (device_id, token_hash, role) VALUES (?, ?, ?)')
      .run(deviceId, sha256(token), role);
    return token; // shown once, never stored in clear
  }

  deviceRole(deviceId) {
    return this.db.prepare('SELECT role FROM devices WHERE device_id = ?').get(deviceId)?.role ?? null;
  }

  // Issue a new token for an existing device (lost or mis-copied token); the old one stops working.
  rotateDevice(deviceId) {
    const token = randomBytes(32).toString('hex');
    const r = this.db
      .prepare('UPDATE devices SET token_hash = ?, revoked = 0 WHERE device_id = ?')
      .run(sha256(token), deviceId);
    if (r.changes === 0) throw new Error(`unknown device ${deviceId}`);
    return token;
  }

  revokeDevice(deviceId) {
    this.db.prepare('UPDATE devices SET revoked = 1 WHERE device_id = ?').run(deviceId);
  }

  authenticate(deviceId, token) {
    if (!deviceId || !token) return false;
    const row = this.db
      .prepare('SELECT token_hash, revoked FROM devices WHERE device_id = ?')
      .get(deviceId);
    if (!row || row.revoked) return false;
    const a = Buffer.from(row.token_hash, 'hex');
    const b = Buffer.from(sha256(token), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // --- tasks -------------------------------------------------------------
  addTask(taskId, issueNumber) {
    this.db
      .prepare(
        'INSERT INTO tasks (task_id, issue_number) VALUES (?, ?) ' +
          'ON CONFLICT(task_id) DO UPDATE SET issue_number = excluded.issue_number',
      )
      .run(taskId, issueNumber);
  }

  getTask(taskId) {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId);
  }

  getTaskByIssue(issueNumber) {
    return this.db.prepare('SELECT * FROM tasks WHERE issue_number = ?').get(issueNumber);
  }

  // Reserve a task for one device (or null for anyone). Does not disturb a claim already held.
  // This is the operator deciding who works on it, so it also ends a return (the way out if the owner has gone away).
  assignTask(taskId, deviceId) {
    if (!this.getTask(taskId)) return { ok: false, reason: 'unknown_task' };
    if (deviceId !== null) {
      const d = this.db.prepare('SELECT revoked, role FROM devices WHERE device_id = ?').get(deviceId);
      if (!d || d.revoked) return { ok: false, reason: 'unknown_device' };
      if (d.role !== 'builder') return { ok: false, reason: 'not_a_builder' };
    }
    this.db.prepare('UPDATE tasks SET assignee = ?, returned_to = NULL WHERE task_id = ?').run(deviceId, taskId);
    return { ok: true };
  }

  // Create or refresh a task mirrored from a GitHub issue. Keeps the comment id and generation.
  upsertSyncedTask(taskId, issueNumber, { title, assignee, closed }) {
    this.db
      .prepare(
        "INSERT INTO tasks (task_id, issue_number, title, assignee, closed, source) VALUES (?, ?, ?, ?, ?, 'github') " +
          'ON CONFLICT(task_id) DO UPDATE SET title = excluded.title, assignee = excluded.assignee, ' +
          "closed = excluded.closed, source = 'github'",
      )
      .run(taskId, issueNumber, title, assignee, closed ? 1 : 0);
  }

  isActiveBuilder(deviceId) {
    const d = this.db.prepare('SELECT revoked, role FROM devices WHERE device_id = ?').get(deviceId);
    return Boolean(d && !d.revoked && d.role === 'builder');
  }

  // What this device can work on: open tasks returned to it, then reserved for it, then open unreserved ones; oldest issue first.
  // `state`: yours (you hold the live lease) | available | busy (someone else holds a live lease)
  //        | returned (a failed review sent it back to another device, named in `returned_to`).
  tasksFor(deviceId, now) {
    const rows = this.db
      .prepare(
        'SELECT task_id, issue_number, title, assignee, returned_to FROM tasks ' +
          'WHERE closed = 0 AND (assignee = ? OR assignee IS NULL) ' +
          'ORDER BY (returned_to IS NOT ?), (assignee IS NULL), issue_number',
      )
      .all(deviceId, deviceId);
    return rows.map((t) => {
      const c = this.#claimRow(t.task_id);
      const live = c && c.state === 'held' && c.expires_at > now;
      const blocked = this.#returnBlocks(t, deviceId);
      return {
        task_id: t.task_id,
        issue: t.issue_number,
        title: t.title,
        reserved_for_you: t.assignee === deviceId,
        returned_to_you: t.returned_to === deviceId,
        state: live ? (c.device_id === deviceId ? 'yours' : 'busy') : blocked ? 'returned' : 'available',
        held_by: live ? c.device_id : null,
        returned_to: blocked ? t.returned_to : null,
        review: this.reviewBrief(t.task_id),
      };
    });
  }

  setTaskComment(taskId, commentId) {
    this.db.prepare('UPDATE tasks SET comment_id = ? WHERE task_id = ?').run(commentId, taskId);
  }

  setTaskApplied(taskId, ts) {
    this.db.prepare('UPDATE tasks SET applied_ts = ? WHERE task_id = ?').run(ts, taskId);
  }

  // --- events ------------------------------------------------------------
  // The row is committed (synchronous=FULL) before this returns, so the caller
  // may acknowledge the event. Returns 'created' | 'duplicate' | 'conflict'.
  insertEvent(event) {
    const payload = JSON.stringify(event);
    const payloadHash = sha256(payload);
    const existing = this.db
      .prepare('SELECT payload_hash FROM events WHERE event_id = ?')
      .get(event.event_id);
    if (existing) return existing.payload_hash === payloadHash ? 'duplicate' : 'conflict';
    this.db
      .prepare(
        'INSERT INTO events (event_id, task_id, device_id, payload, payload_hash, ts, received_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        event.event_id,
        event.task_id,
        event.device_id,
        payload,
        payloadHash,
        event.ts,
        new Date().toISOString(),
      );
    return 'created';
  }

  dueEvents(nowMs, limit = 50) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE status = 'pending' AND next_attempt_at <= ? " +
          'ORDER BY task_id, ts LIMIT ?',
      )
      .all(nowMs, limit);
  }

  markDone(eventId) {
    this.db
      .prepare("UPDATE events SET status = 'done', last_error = NULL WHERE event_id = ?")
      .run(eventId);
  }

  markSkipped(eventId, reason) {
    this.db
      .prepare("UPDATE events SET status = 'skipped', last_error = ? WHERE event_id = ?")
      .run(reason, eventId);
  }

  markFailed(eventId, error, nowMs) {
    const row = this.db.prepare('SELECT attempts FROM events WHERE event_id = ?').get(eventId);
    const attempts = row.attempts + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    const delayMs = Math.min(300_000, 2000 * 2 ** attempts);
    this.db
      .prepare(
        'UPDATE events SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ? ' +
          'WHERE event_id = ?',
      )
      .run(attempts, dead ? 'dead' : 'pending', nowMs + delayMs, String(error).slice(0, 500), eventId);
    return dead;
  }

  // Waits without using an attempt, so it can never go dead this way. For when the fault is not the event's: see the worker.
  holdEvent(eventId, error, nextAttemptAt) {
    this.db
      .prepare('UPDATE events SET next_attempt_at = ?, last_error = ? WHERE event_id = ?')
      .run(nextAttemptAt, String(error).slice(0, 500), eventId);
  }

  counts() {
    return Object.fromEntries(
      this.db
        .prepare('SELECT status, COUNT(*) AS n FROM events GROUP BY status')
        .all()
        .map((r) => [r.status, r.n]),
    );
  }
}
