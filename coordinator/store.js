import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export const MAX_ATTEMPTS = 8;

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
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
    `);
    // Databases created before claims existed: add the per-task generation counter.
    const cols = this.db.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    if (!cols.includes('generation')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    }
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
      const cur = this.#claimRow(taskId);
      if (cur && cur.state === 'held' && cur.expires_at > now) {
        if (cur.device_id === deviceId && cur.run_id === runId) {
          // Same owner asking again (e.g. a lost reply): idempotent, extend the lease.
          this.db.prepare('UPDATE claims SET expires_at = ? WHERE task_id = ?').run(now + ttlMs, taskId);
          return { ok: true, generation: cur.generation, expires_at: now + ttlMs };
        }
        return { ok: false, reason: 'claimed', owner: cur.device_id, expires_at: cur.expires_at };
      }
      const generation = task.generation + 1;
      this.db.prepare('UPDATE tasks SET generation = ? WHERE task_id = ?').run(generation, taskId);
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
      this.db.prepare('UPDATE tasks SET generation = generation + 1 WHERE task_id = ?').run(taskId);
      this.db.prepare("UPDATE claims SET state = 'cancelled' WHERE task_id = ?").run(taskId);
      return { ok: true, generation: task.generation + 1 };
    });
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

  // --- devices -----------------------------------------------------------
  addDevice(deviceId) {
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare('INSERT INTO devices (device_id, token_hash) VALUES (?, ?)')
      .run(deviceId, sha256(token));
    return token; // shown once, never stored in clear
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

  counts() {
    return Object.fromEntries(
      this.db
        .prepare('SELECT status, COUNT(*) AS n FROM events GROUP BY status')
        .all()
        .map((r) => [r.status, r.n]),
    );
  }
}
