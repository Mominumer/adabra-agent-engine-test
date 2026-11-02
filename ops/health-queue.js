#!/usr/bin/env node
// Counts and state from the reviewer's queue, for the health report. It runs as its own process, started by ops/health.js, because
// a SQLite call holds its thread and no timer can interrupt it: this way a stuck database becomes a report line.
//
//   node ops/health-queue.js <path-to-reviewer.db>     prints one line of JSON
//
// Read-only, always: the database is opened with SQLite's read-only flag, so this cannot write, cannot create a missing file and
// cannot change the schema. It never uses ReviewStore, whose constructor runs CREATE TABLE. As with the backup job, if nothing else
// has the database open, SQLite itself can leave an empty -wal and -shm beside it. A short busy timeout means it gives up rather than
// waits, and in WAL mode a reader does not hold up a writer.
//
// It selects counts, times and the kind of pause, and never a column that holds PR data (meta, result, payload, last_error).
import { existsSync, realpathSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { errorText, tableNames } from '../backup/backup.js';

const BUSY_TIMEOUT_MS = 500;
const DAY_MS = 86_400_000;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const JOB_STATES = ['queued', 'running', 'done', 'superseded', 'failed'];
const RESULT_STATES = ['pending', 'acked', 'rejected'];

export const openQueueDb = (path, { timeoutMs = BUSY_TIMEOUT_MS } = {}) => new DatabaseSync(path, { readOnly: true, timeout: timeoutMs });

// Only the words the reviewer itself writes come through: anything else in the column is counted as `other`.
function countBy(rows, known, key) {
  const counts = Object.fromEntries(known.map((k) => [k, 0]));
  for (const r of rows) {
    if (known.includes(r[key])) counts[r[key]] = r.n;
    else counts.other = (counts.other ?? 0) + r.n;
  }
  return counts;
}

// The same answer as ReviewStore.reviewPause, without its connection. A test holds the two together.
function pauseFrom(row, now) {
  if (row?.kind === 'auth') return { kind: 'auth', until: null };
  if (!row?.kind || !(row.until_at > now)) return null;
  return { kind: row.kind === 'limit' ? 'limit' : 'other', until: row.until_at };
}

// Never throws. Counts and state, or { error, why }, where `why` is only ever SQLite's own fixed text or a system error code.
export function readQueueState(path, { now = Date.now(), timeoutMs = BUSY_TIMEOUT_MS } = {}) {
  if (!existsSync(path)) return { error: 'missing' };
  let db;
  try {
    db = openQueueDb(path, { timeoutMs });
    const tables = tableNames(db);
    if (!tables.includes('jobs')) return { error: 'no-tables' };
    const due = db
      .prepare("SELECT COUNT(*) AS n, MIN(MAX(created_at, next_attempt_at)) AS oldest FROM jobs WHERE state = 'queued' AND next_attempt_at <= ?")
      .get(now);
    return {
      jobs: countBy(db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all(), JOB_STATES, 'state'),
      due: due.n,
      oldest_due_ms: due.oldest === null ? null : Math.max(0, now - due.oldest),
      failed_last_day: db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'failed' AND created_at >= ?").get(now - DAY_MS).n,
      task_results: tables.includes('task_results')
        ? countBy(db.prepare('SELECT status, COUNT(*) AS n FROM task_results GROUP BY status').all(), RESULT_STATES, 'status')
        : null,
      // The reviewer creates this table when it starts, so a database from before it has no pause to report.
      pause_known: tables.includes('review_pause'),
      pause: tables.includes('review_pause') ? pauseFrom(db.prepare('SELECT kind, until_at FROM review_pause WHERE id = 1').get(), now) : null,
    };
  } catch (err) {
    const busy = err.errcode === SQLITE_BUSY || err.errcode === SQLITE_LOCKED;
    return { error: busy ? 'locked' : 'unreadable', why: errorText(err) };
  } finally {
    db?.close();
  }
}

const isMain = () => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (isMain()) console.log(JSON.stringify(readQueueState(process.argv[2])));
