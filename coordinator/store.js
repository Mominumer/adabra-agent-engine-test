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
    `);
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
