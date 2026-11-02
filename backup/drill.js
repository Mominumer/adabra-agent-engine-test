import { DatabaseSync } from 'node:sqlite';
import { chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { errorText, listBackups, parseBackupName, sameDir, tableNames } from './backup.js';

// The restore drill: a backup is only worth something if it restores. Copies a backup into a fresh temp folder, opens the copy the
// way a service would, checks it, prints only table names and row counts, and deletes it. It writes nowhere else, and it refuses
// anything that could be a live database. No row's contents are ever read: COUNT(*) is the only query on a table.

const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isInside(path, folder) {
  for (let p = path; ; p = dirname(p)) {
    if (sameDir(p, folder)) return true;
    if (dirname(p) === p) return false;
  }
}

// Why this file must not be used, or null. A symlink or a hard link to a live database can carry a backup's name, so the name
// alone proves nothing. A backup is one file, so a -wal or -shm beside it means something has it open.
function whyNotABackup(path, live) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 'there is no such file';
  }
  if (!st.isFile()) return 'it is not a regular file';
  for (const db of live) {
    if (existsSync(db)) {
      const l = statSync(db);
      if (l.dev === st.dev && l.ino === st.ino) return 'it is a live database';
    }
    if (sameDir(dirname(path), dirname(db))) return 'it is in the same folder as a live database';
  }
  for (const side of ['-wal', '-shm', '-journal']) {
    if (existsSync(`${path}${side}`)) return `it has a ${side} file beside it`;
  }
  return null;
}

function drillOne(db, path, tmpRoot) {
  const out = { ok: false, size: statSync(path).size, integrity: 'not_checked', tables: [], other: 0, error: null };
  const folder = mkdtempSync(join(tmpRoot, 'adabra-drill-'));
  try {
    const copy = join(folder, `${db.name}.db`);
    copyFileSync(path, copy, constants.COPYFILE_EXCL);
    chmodSync(copy, 0o600);
    const conn = new DatabaseSync(copy);
    try {
      conn.exec('PRAGMA journal_mode = WAL'); // the first thing a service does to a restored file
      const rows = conn.prepare('PRAGMA integrity_check').all();
      out.integrity = rows.length === 1 && rows[0].integrity_check === 'ok' ? 'ok' : 'failed';
      if (out.integrity === 'ok') {
        const names = tableNames(conn);
        const missing = db.tables.filter((t) => !names.includes(t));
        if (missing.length) out.error = `expected tables missing: ${missing.join(', ')}`;
        for (const name of names) {
          if (SAFE_TABLE.test(name)) out.tables.push(`${name} ${conn.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n}`);
          else out.other++;
        }
        out.ok = !missing.length;
      } else {
        out.error = 'integrity check failed';
      }
    } finally {
      conn.close();
    }
  } catch (err) {
    out.integrity = 'failed';
    out.error = errorText(err);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  if (existsSync(folder)) {
    out.ok = false;
    out.error = 'the temp copy could not be deleted';
  }
  return out;
}

// Drills the newest backup of each database, or just `file`. Returns { ok, refused }.
export function runDrill(cfg, { file = null, tmpRoot = tmpdir(), say = console.log } = {}) {
  const live = cfg.databases.map((d) => d.path);
  const refuse = (why) => {
    say(`refused: ${why}`);
    say('drill FAILED');
    return { ok: false, refused: true };
  };
  if (live.some((db) => isInside(tmpRoot, dirname(db)))) return refuse('the temp folder is too close to a live database (check TMPDIR)');

  let picks;
  if (file) {
    const parsed = parseBackupName(basename(file));
    if (!parsed) return refuse('that is not the name of a backup this job made');
    picks = [{ db: cfg.databases.find((d) => d.name === parsed.name), path: resolve(file) }];
  } else {
    if (live.some((db) => sameDir(cfg.dir, dirname(db)))) return refuse('the backup folder is the folder of a live database');
    picks = cfg.databases.map((db) => {
      const newest = listBackups(cfg.dir, db.name)[0];
      return { db, path: newest ? join(cfg.dir, newest.file) : null };
    });
  }

  let ok = true;
  for (const { db, path } of picks) {
    if (!path) {
      ok = false;
      say(`${db.name}: FAILED (no backup found)`);
      continue;
    }
    const why = whyNotABackup(path, live);
    if (why) return refuse(`${basename(path)}: ${why}`);
    const r = drillOne(db, path, tmpRoot);
    say(`${db.name}: ${basename(path)}, ${r.size} bytes`);
    say(`  integrity_check: ${r.integrity}`);
    if (r.tables.length) say(`  tables: ${r.tables.join(', ')}`);
    if (r.other) say(`  and ${r.other} table(s) with unexpected names`);
    if (r.error) say(`  FAILED (${r.error})`);
    say('  temp copy deleted');
    ok &&= r.ok;
  }
  say(ok ? 'drill passed' : 'drill FAILED');
  return { ok, refused: false };
}
