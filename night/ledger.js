import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The overnight runner's own record of which approvals have been spent. One row per approval event, written before any session
// starts and never removed: if the row exists the approval is used, whatever happened afterwards, so a crash cannot earn a second
// attempt. It holds fixed words, IDs and a hash, and never the text of an issue.
//
// It has its own file and refuses to touch any other database. There is no default path, and a missing file is an error rather
// than an empty ledger: a ledger that was moved or lost must not make every old approval look unused. Only an explicit `create`
// makes a new one.
const APPLICATION_ID = 0x4e474854; // marks a file as this ledger; a new file has 0 and every other database has its own value
const OTHER_STORES = new Set(['reviewer.db', 'coordinator.db']);
const WORD_RE = /^[a-z][a-z_]{0,39}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

const isId = (n) => Number.isSafeInteger(n) && n > 0;

export class LedgerError extends Error {}

function checkPath(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new LedgerError('the ledger path must be absolute');
  // Lower case because macOS's file names usually ignore case, and the real path in case of a link.
  const names = [path, existsSync(path) ? realpathSync(path) : path].map((p) => basename(p).toLowerCase());
  if (names.some((n) => OTHER_STORES.has(n))) throw new LedgerError('the ledger must not share a file with another service');
}

export class Ledger {
  #db;

  constructor(path, { create = false, readOnly = false } = {}) {
    checkPath(path);
    const isNew = !existsSync(path);
    if (isNew && (!create || readOnly)) throw new LedgerError('no ledger at that path');
    if (isNew) closeSync(openSync(path, 'wx', 0o600));
    this.#db = new DatabaseSync(path, { readOnly });
    try {
      this.#db.exec('PRAGMA busy_timeout = 5000');
      if (isNew) this.#setUp();
      if (this.#db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID) throw new LedgerError('that file is not a ledger');
      if (!readOnly) this.#db.exec('PRAGMA fullfsync = ON; PRAGMA synchronous = FULL'); // `started` must survive a power cut
      this.#db.prepare('SELECT event_id FROM attempts LIMIT 0').all();
    } catch (err) {
      this.#db.close();
      throw err;
    }
  }

  #setUp() {
    this.#db.exec(`
      PRAGMA application_id = ${APPLICATION_ID};
      CREATE TABLE attempts (
        event_id INTEGER PRIMARY KEY,      -- GitHub's ID for the labeled event: one attempt per approval
        run_id TEXT NOT NULL UNIQUE,
        task TEXT NOT NULL,
        issue INTEGER NOT NULL,
        actor_id INTEGER NOT NULL,
        labeled_at TEXT NOT NULL,
        text_sha256 TEXT NOT NULL,         -- title and body as pinned at selection
        state TEXT NOT NULL CHECK (state IN ('started', 'finished')),
        outcome TEXT,                      -- a fixed word, once finished
        started_at INTEGER NOT NULL,
        finished_at INTEGER
      );
    `);
  }

  // The row for this approval event, or null.
  get(eventId) {
    return this.#db.prepare('SELECT * FROM attempts WHERE event_id = ?').get(eventId) ?? null;
  }

  // Spends the approval. False when it was already spent. The write is on disk before this returns.
  start({ eventId, runId, task, issue, actorId, labeledAt, textSha256, startedAt }) {
    const good = isId(eventId) && RUN_ID_RE.test(runId) && /^TASK-[1-9]\d{0,8}$/.test(task) && isId(issue) && isId(actorId) &&
      typeof labeledAt === 'string' && SHA256_RE.test(textSha256) && Number.isFinite(startedAt);
    if (!good) throw new LedgerError('that is not a valid attempt');
    const r = this.#db.prepare(`
      INSERT INTO attempts (event_id, run_id, task, issue, actor_id, labeled_at, text_sha256, state, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?) ON CONFLICT (event_id) DO NOTHING
    `).run(eventId, runId, task, issue, actorId, labeledAt, textSha256, startedAt);
    return r.changes === 1;
  }

  // Records how an attempt ended. The approval stays spent.
  finish(eventId, outcome, finishedAt) {
    if (!WORD_RE.test(outcome) || !Number.isFinite(finishedAt)) throw new LedgerError('that is not a valid outcome');
    return this.#db.prepare(`UPDATE attempts SET state = 'finished', outcome = ?, finished_at = ? WHERE event_id = ? AND state = 'started'`)
      .run(outcome, finishedAt, eventId).changes === 1;
  }

  // Attempts with no recorded end: a crash, for a runner that is only now starting up.
  unfinished() {
    return this.#db.prepare(`SELECT * FROM attempts WHERE state = 'started' ORDER BY started_at`).all();
  }

  close() {
    this.#db.close();
  }
}

// Stands in for a ledger that could not be opened, so the check refuses in the normal way.
export const UNREADABLE_LEDGER = Object.freeze({
  get() {
    throw new LedgerError('the ledger could not be read');
  },
});
