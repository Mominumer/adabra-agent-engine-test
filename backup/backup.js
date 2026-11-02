import * as sqlite from 'node:sqlite';
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Nightly backups of the coordinator's and the reviewer's databases. Everything this reports (log, status file, errors) is
// file names, sizes, check results and SQLite's or the system's own fixed error texts. It never reports what is in a database.

const { DatabaseSync } = sqlite;

export const RETENTION_DAYS = 14;
export const STALE_AFTER_MS = 26 * 3_600_000; // a nightly job, plus some slack
const DAY_MS = 86_400_000;
const COPY_TIMEOUT_MS = 15 * 60_000;
const LOCK_FILE = 'backup.lock.db';
const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `tables` are what each store creates. A file without them is not a backup of that database, however healthy it is: an empty
// file passes an integrity check, and counting it as good would let retention push out the real backups.
export const DATABASES = {
  coordinator: { env: 'COORDINATOR_DB', file: 'coordinator.db', tables: ['devices', 'tasks', 'events', 'claims', 'review_results', 'task_reviews'] },
  reviewer: { env: 'REVIEW_DB', file: 'reviewer.db', tables: ['jobs', 'prs', 'task_results'] },
};

// The same variables and defaults the services use, so the job looks where they keep their data.
export function backupConfig({ env = process.env, home = homedir(), repoDir = REPO_DIR } = {}) {
  return {
    dir: resolve(env.ADABRA_BACKUP_DIR?.trim() || join(home, 'adabra-backups')),
    statusFile: resolve(env.ADABRA_BACKUP_STATUS?.trim() || join(home, 'Library', 'Logs', 'adabra-backup-status.json')),
    databases: Object.entries(DATABASES).map(([name, d]) => ({
      name,
      path: resolve(env[d.env]?.trim() || join(repoDir, d.file)),
      tables: d.tables,
    })),
  };
}

// Only SQLite's fixed error texts and system error codes: never a free-form message that could quote data.
export const errorText = (err) => err?.errstr ?? err?.code ?? 'unknown error';
const problem = (code) => Object.assign(new Error(code), { code });

// --- names -------------------------------------------------------------
// coordinator-20261103T031500Z.db: ends in .db so the deny rules and .gitignore cover it, and a manual backup
// (coordinator-20261103-0315.db) never matches, so retention leaves those alone. Temp names end in .db for the same reason.
const stamp = (date) => date.toISOString().replace(/[-:]|\.\d+/g, '');
export const backupName = (name, date) => `${name}-${stamp(date)}.db`;
const TEMP_RE = /^tmp-[a-z]+-\d{8}T\d{6}Z-\d+\.db(-journal|-wal|-shm)?$/;

// { name, at } for exactly the names this job gives its finished backups, else null.
export function parseBackupName(file) {
  const m = file.match(/^([a-z]+)-((\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z)\.db$/);
  if (!m || !DATABASES[m[1]]) return null;
  const at = Date.UTC(+m[3], +m[4] - 1, +m[5], +m[6], +m[7], +m[8]);
  return stamp(new Date(at)) === m[2] ? { name: m[1], at } : null; // 20261399 is not a date
}

// Finished backups of one database, newest first: regular files with exactly this job's names, nothing else.
export function listBackups(dir, name) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => ({ file: e.name, parsed: parseBackupName(e.name) }))
    .filter((b) => b.parsed?.name === name)
    .map((b) => ({ file: b.file, at: b.parsed.at }))
    .sort((a, b) => b.at - a.at);
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return join(real(dirname(path)), basename(path));
  }
}
export const sameDir = (a, b) => real(a) === real(b);

// --- the copy ----------------------------------------------------------
// SQLite's online backup reads through SQLite itself, so it sees what is in the WAL as well as the main file. The source is
// opened read-only: this job can never change a live database, and never holds up a writer, because in WAL mode a reader does
// not block one. Copying every page in one step keeps it inside one read transaction, so the copy is one consistent moment.
// In smaller steps it would start again each time another connection wrote, and might never finish on a busy database.
const ALL_PAGES = 2 ** 31 - 1;

export async function copyDatabase(source, dest) {
  if (typeof sqlite.backup !== 'function') throw problem('this Node has no sqlite backup(); it needs 22.16 or newer');
  const db = new DatabaseSync(source, { readOnly: true, timeout: 5000 });
  try {
    await sqlite.backup(db, dest, { rate: ALL_PAGES });
  } finally {
    db.close();
  }
}

// A copy of a WAL database says "WAL" in its header, and opening it like that would put -wal and -shm files beside it. Switching
// it to a plain single file first means a backup is exactly one file. The services switch it back when they open it.
// The check's own messages are never passed on: only that it failed.
export function verifyBackup(path, tables) {
  try {
    const rw = new DatabaseSync(path, { timeout: 5000 });
    try {
      rw.exec('PRAGMA journal_mode = DELETE');
    } finally {
      rw.close();
    }
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db.prepare('PRAGMA integrity_check').all();
      if (rows.length !== 1 || rows[0].integrity_check !== 'ok') return { ok: false, integrity: 'failed', error: 'integrity check failed' };
      const present = tableNames(db);
      const missing = tables.filter((t) => !present.includes(t));
      if (missing.length) return { ok: false, integrity: 'ok', error: `expected tables missing: ${missing.join(', ')}` };
      return { ok: true, integrity: 'ok', error: null };
    } finally {
      db.close();
    }
  } catch (err) {
    return { ok: false, integrity: 'failed', error: errorText(err) };
  }
}

export const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(problem('timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function syncPath(path, flags) {
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function removeTemp(tmp) {
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${tmp}${suffix}`, { force: true });
}

// Two runs in the same second must not replace a good backup, so the later one takes the next free second.
function freeName(dir, name, date) {
  let at = date.getTime();
  while (existsSync(join(dir, backupName(name, new Date(at))))) at += 1000;
  return backupName(name, new Date(at));
}

// Temp name, verify, then rename: a file with a finished name has always passed its check.
async function backupOne(cfg, db, { date, copy, timeoutMs }) {
  const failed = (error, integrity = 'not_checked') => ({ ok: false, file: null, size_bytes: null, integrity, error });
  if (!existsSync(db.path)) return failed('database file is missing');
  const tmp = join(cfg.dir, `tmp-${db.name}-${stamp(date)}-${process.pid}.db`);
  try {
    closeSync(openSync(tmp, 'wx', 0o600)); // mode 600 from the first moment; SQLite gives its side files the same mode
    await withTimeout(copy(db.path, tmp), timeoutMs);
    const check = verifyBackup(tmp, db.tables);
    if (!check.ok) return failed(check.error, check.integrity);
    syncPath(tmp, 'r+');
    const file = freeName(cfg.dir, db.name, date);
    renameSync(tmp, join(cfg.dir, file));
    syncPath(cfg.dir, 'r');
    return { ok: true, file, size_bytes: statSync(join(cfg.dir, file)).size, integrity: 'ok', error: null };
  } catch (err) {
    return failed(errorText(err));
  } finally {
    removeTemp(tmp);
  }
}

// --- retention ---------------------------------------------------------
// Removes this job's own backups of one database that are older than the limit, except the newest, however old, and `keep`.
// runBackups calls this only straight after that database's backup passed, so a failed run can never cost a good backup.
export function applyRetention({ dir, name, now, keep = null, days = RETENTION_DAYS }) {
  const cutoff = now.getTime() - days * DAY_MS;
  const removed = [];
  let error = null;
  for (const b of listBackups(dir, name).slice(1)) {
    if (b.file === keep || b.at >= cutoff) continue;
    try {
      unlinkSync(join(dir, b.file));
      removed.push(b.file);
    } catch (err) {
      error = errorText(err);
    }
  }
  return { removed, error };
}

// --- one run -----------------------------------------------------------
// launchd never starts a job that is still running, but someone may also run this by hand. SQLite's lock on this empty file
// belongs to the process, so it goes away if the process dies: no stale lock can ever stop the backups. Null if already held.
export function takeLock(dir) {
  const path = join(dir, LOCK_FILE);
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
  const db = new DatabaseSync(path, { timeout: 0 });
  try {
    db.exec('BEGIN EXCLUSIVE');
  } catch (err) {
    db.close();
    if (err.errcode === 5) return null; // SQLITE_BUSY
    throw err;
  }
  return () => db.close();
}

function prepareFolder(cfg) {
  for (const db of cfg.databases) {
    if (sameDir(cfg.dir, dirname(db.path))) throw problem(`the backup folder is the folder of the live ${db.name} database`);
  }
  mkdirSync(cfg.dir, { recursive: true, mode: 0o700 });
  chmodSync(cfg.dir, 0o700);
}

// Left by a run that died. Only called holding the lock, so no run is using them.
function removeStaleTemps(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && TEMP_RE.test(e.name)) rmSync(join(dir, e.name), { force: true });
  }
}

function writeStatus(path, status) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  syncPath(tmp, 'r+');
  renameSync(tmp, path);
}

function safeList(dir, name) {
  try {
    return listBackups(dir, name);
  } catch {
    return [];
  }
}

// One database's failure never stops the other's backup. Returns the status it wrote, or { busy: true } if another run holds
// the lock, in which case it has changed nothing. Any failure shows in the status file and in `ok`, which sets the exit code.
export async function runBackups(cfg, {
  now = () => new Date(), copy = copyDatabase, timeoutMs = COPY_TIMEOUT_MS, days = RETENTION_DAYS, log = () => {},
} = {}) {
  const startedAt = now();
  let release = null;
  let setupError = null;
  try {
    prepareFolder(cfg);
    release = takeLock(cfg.dir);
    if (!release) {
      log('another backup run is in progress; this one did nothing');
      return { busy: true, ok: false };
    }
    removeStaleTemps(cfg.dir);
  } catch (err) {
    setupError = errorText(err);
  }
  try {
    const databases = {};
    for (const db of cfg.databases) {
      const result = setupError
        ? { ok: false, file: null, size_bytes: null, integrity: 'not_checked', error: setupError }
        : await backupOne(cfg, db, { date: now(), copy, timeoutMs });
      const retention = result.ok
        ? applyRetention({ dir: cfg.dir, name: db.name, now: now(), keep: result.file, days })
        : { removed: [], error: null };
      const remaining = safeList(cfg.dir, db.name);
      databases[db.name] = {
        ...result,
        newest_good_file: remaining[0]?.file ?? null,
        newest_good_at: remaining[0] ? new Date(remaining[0].at).toISOString() : null,
        kept: remaining.length,
        removed: retention.removed.length,
        retention_error: retention.error,
      };
      log(describeDatabase(db.name, databases[db.name]));
    }
    const status = {
      version: 1,
      started_at: startedAt.toISOString(),
      finished_at: now().toISOString(),
      ok: Object.values(databases).every((d) => d.ok && !d.retention_error),
      backup_dir: cfg.dir,
      retention_days: days,
      databases,
    };
    writeStatus(cfg.statusFile, status);
    log(`backup run finished: ${status.ok ? 'OK' : 'FAILED'}`);
    return status;
  } finally {
    release?.();
  }
}

// --- reading the status ------------------------------------------------
export function readStatus(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' ? null : { error: 'the status file could not be read' };
  }
}

// Everything wrong with the last run, in plain words. Empty means healthy. A run that died writes no status, so an old
// `finished_at` is how that shows up.
export function statusProblems(status, nowMs = Date.now()) {
  if (!status) return ['no backup has finished yet'];
  if (status.error || !status.databases) return [status.error ?? 'the status file has no results'];
  const problems = [];
  if (!(nowMs - Date.parse(status.finished_at) <= STALE_AFTER_MS)) problems.push(`the last run is more than ${STALE_AFTER_MS / 3_600_000} hours old`);
  for (const [name, d] of Object.entries(status.databases)) {
    if (!d.ok) problems.push(`${name}: ${d.error}`);
    if (d.retention_error) problems.push(`${name}: old backups could not be removed (${d.retention_error})`);
  }
  return problems;
}

export function describeDatabase(name, d) {
  const kept = `${d.kept} kept, ${d.removed} removed`;
  if (d.ok) return `${name}: ${d.file}, ${d.size_bytes} bytes, integrity ${d.integrity}, ${kept}`;
  return `${name}: FAILED (${d.error}), integrity ${d.integrity}, newest good backup ${d.newest_good_file ?? 'none'}, ${kept}`;
}
