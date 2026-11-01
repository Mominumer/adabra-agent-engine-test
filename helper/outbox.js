import { DatabaseSync } from 'node:sqlite';

// Local durable outbox. An event is written here before any network call, and is
// removed from the "pending" set only after the coordinator acknowledges it.
export class Outbox {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS outbox (
        event_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',   -- pending | acked | rejected
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  add(event) {
    this.db
      .prepare('INSERT INTO outbox (event_id, payload, created_at) VALUES (?, ?, ?)')
      .run(event.event_id, JSON.stringify(event), new Date().toISOString());
  }

  due(nowMs) {
    return this.db
      .prepare("SELECT * FROM outbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at")
      .all(nowMs);
  }

  ack(eventId) {
    this.db.prepare("UPDATE outbox SET status = 'acked', last_error = NULL WHERE event_id = ?").run(eventId);
  }

  reject(eventId, error) {
    this.db.prepare("UPDATE outbox SET status = 'rejected', last_error = ? WHERE event_id = ?").run(String(error).slice(0, 500), eventId);
  }

  retryLater(eventId, error, nowMs) {
    const row = this.db.prepare('SELECT attempts FROM outbox WHERE event_id = ?').get(eventId);
    const attempts = row.attempts + 1;
    const delayMs = Math.min(300_000, 1000 * 2 ** attempts);
    this.db
      .prepare('UPDATE outbox SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE event_id = ?')
      .run(attempts, nowMs + delayMs, String(error).slice(0, 500), eventId);
  }

  counts() {
    return Object.fromEntries(
      this.db
        .prepare('SELECT status, COUNT(*) AS n FROM outbox GROUP BY status')
        .all()
        .map((r) => [r.status, r.n]),
    );
  }
}
