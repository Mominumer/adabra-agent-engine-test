import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync, closeSync, copyFileSync, existsSync, fstatSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sqlite from 'node:sqlite';
import { Store } from '../coordinator/store.js';
import { ReviewStore } from '../reviewer/store.js';
import {
  applyRetention, backupConfig, backupName, copyDatabase, DATABASES, listBackups, parseBackupName, readStatus, runBackups, statusProblems,
  takeLock, verifyBackup, tableNames,
} from '../backup/backup.js';
import { runDrill } from '../backup/drill.js';

// Everything here uses temp folders and made-up data. Nothing opens a real database, and the only launchctl is a fake.
const { DatabaseSync } = sqlite;
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(REPO, 'backup', 'main.js');
const SERVICE = join(REPO, 'service', 'backup-service.sh');
const SECRET = 'FAKE-SECRET-VALUE-do-not-print-7f3a';
const available = typeof sqlite.backup === 'function';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 3, 3, 15, 0);

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function seedCoordinator(path, rows = 50) {
  const s = new Store(path);
  const token = s.addDevice('member-a');
  s.db.prepare('INSERT INTO devices (device_id, token_hash) VALUES (?, ?)').run(`dev-${SECRET}`, SECRET);
  s.addTask('TASK-1', 1);
  s.db.exec('BEGIN');
  const insert = s.db.prepare("INSERT INTO events (event_id, task_id, device_id, payload, payload_hash, ts, received_at) VALUES (?, 'TASK-1', 'member-a', ?, 'h', 't', 't')");
  for (let i = 0; i < rows; i++) insert.run(`seed-${i}`, `${SECRET} ${'x'.repeat(400)}`);
  s.db.exec('COMMIT');
  s.close();
  return token;
}

function seedReviewer(path) {
  const r = new ReviewStore(path);
  r.enqueue(7, 'a'.repeat(40), { branch: 'task/TASK-1', title: SECRET }, 1);
  r.close();
}

// A live folder with both databases, and a config pointing everything at temp paths.
function setup(t, { coordinator = true, reviewer = true } = {}) {
  const root = tempDir(t);
  const live = join(root, 'live');
  mkdirSync(live);
  const paths = { coordinator: join(live, 'coordinator.db'), reviewer: join(live, 'reviewer.db') };
  const token = coordinator ? seedCoordinator(paths.coordinator) : null;
  if (reviewer) seedReviewer(paths.reviewer);
  const env = {
    COORDINATOR_DB: paths.coordinator,
    REVIEW_DB: paths.reviewer,
    ADABRA_BACKUP_DIR: join(root, 'backups'),
    ADABRA_BACKUP_STATUS: join(root, 'status', 'backup-status.json'),
  };
  const cfg = backupConfig({ env, home: join(root, 'home'), repoDir: join(root, 'repo') });
  return { root, live, paths, env, cfg, token };
}

// Fixed clock: each call to now() is a second later, starting at `at`.
const clock = (at = T0) => {
  let n = 0;
  return () => new Date(at + 1000 * n++);
};

const files = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const finished = (dir, name) => listBackups(dir, name).map((b) => b.file);

// Overwrites whole pages after the first: the file still opens, and its structure is broken.
function damage(path, from = 2, to = 12) {
  const fd = openSync(path, 'r+');
  const pages = Math.floor(fstatSync(fd).size / 4096);
  assert.ok(pages > from + 1, 'the file must be big enough to damage');
  for (let p = from; p < Math.min(to, pages); p++) writeSync(fd, Buffer.alloc(4096, 0xab), 0, 4096, p * 4096);
  closeSync(fd);
}

const withDamage = async (source, dest) => {
  await copyDatabase(source, dest);
  damage(dest);
};

function query(path, sql) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).get();
  } finally {
    db.close();
  }
}

// Runs a real command with the temp paths and a temp HOME, so a default can never reach anything real.
function cli(setupResult, args, extraEnv = {}) {
  return spawnSync(process.execPath, [MAIN, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: join(setupResult.root, 'home'), ...setupResult.env, ...extraEnv },
  });
}

// --- configuration and names -------------------------------------------

test('config: defaults match the services and the manual backup folder', () => {
  const cfg = backupConfig({ env: {}, home: '/h', repoDir: '/r' });
  assert.equal(cfg.dir, '/h/adabra-backups');
  assert.equal(cfg.statusFile, '/h/Library/Logs/adabra-backup-status.json');
  assert.deepEqual(cfg.databases.map((d) => d.path), ['/r/coordinator.db', '/r/reviewer.db']);
});

test('names: a backup and its temp file are covered by the deny rules and .gitignore; the status file is not a .db and is outside ~/.adabra', { skip: !available }, async (t) => {
  const s = setup(t);
  const seen = [];
  await runBackups(s.cfg, {
    now: clock(),
    copy: async (source, dest) => {
      seen.push(dest);
      await copyDatabase(source, dest);
    },
  });
  for (const f of [...seen, ...finished(s.cfg.dir, 'coordinator')]) assert.match(f, /\.db$/);
  const deny = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8')).permissions.deny;
  assert.ok(deny.includes('Read(**/*.db)'));
  assert.match(readFileSync(join(REPO, '.gitignore'), 'utf8'), /^\*\.db$/m);
  const def = backupConfig({ env: {}, home: '/h', repoDir: '/r' }).statusFile;
  assert.doesNotMatch(def, /\.db($|-)/);
  assert.doesNotMatch(def, /\.adabra/);
  assert.ok(!def.startsWith('/h/adabra-backups/'), 'outside the backups, so the folder can be denied without hiding the status');
});

test('names: only exact names with a real date count as this job\'s backups', () => {
  assert.deepEqual(parseBackupName('coordinator-20261103T031500Z.db'), { name: 'coordinator', at: T0 });
  assert.equal(backupName('reviewer', new Date(T0)), 'reviewer-20261103T031500Z.db');
  for (const bad of [
    'coordinator-20261103-0315.db', // the manual backup command's name
    'coordinator-20261399T999999Z.db',
    'coordinator-20261103T031500Z.db.bak',
    'other-20261103T031500Z.db',
    'xcoordinator-20261103T031500Z.db',
    'tmp-coordinator-20261103T031500Z-123.db',
    'coordinator.db',
  ]) assert.equal(parseBackupName(bad), null, bad);
});

test('the expected tables are ones the real stores create', (t) => {
  const dir = tempDir(t);
  for (const [name, Cls] of [['coordinator', Store], ['reviewer', ReviewStore]]) {
    const path = join(dir, `${name}.db`);
    new Cls(path).close();
    const db = new DatabaseSync(path);
    const present = tableNames(db);
    db.close();
    for (const table of DATABASES[name].tables) assert.ok(present.includes(table), `${name}.${table}`);
  }
});

// --- how the copy is taken ---------------------------------------------

test('backup: captures rows that are only in the WAL, which a copy of the .db file would miss', { skip: !available }, async (t) => {
  const s = setup(t);
  const writer = new DatabaseSync(s.paths.coordinator);
  t.after(() => writer.close());
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  writer.exec("INSERT INTO tasks (task_id, issue_number) VALUES ('TASK-WAL', 99)");
  assert.ok(statSync(`${s.paths.coordinator}-wal`).size > 0);

  // The plain file copy, to show what this test is telling apart. Temp data only.
  const plain = join(s.root, 'plain.db');
  copyFileSync(s.paths.coordinator, plain);
  assert.equal(query(plain, "SELECT COUNT(*) AS n FROM tasks WHERE task_id = 'TASK-WAL'").n, 0);

  const status = await runBackups(s.cfg, { now: clock() });
  assert.equal(status.ok, true);
  const file = join(s.cfg.dir, status.databases.coordinator.file);
  assert.equal(query(file, "SELECT COUNT(*) AS n FROM tasks WHERE task_id = 'TASK-WAL'").n, 1);
});

test('backup: recovers rows from the WAL a crash left behind', { skip: !available }, async (t) => {
  const s = setup(t);
  const writer = new DatabaseSync(s.paths.coordinator);
  t.after(() => writer.close());
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  writer.exec("INSERT INTO tasks (task_id, issue_number) VALUES ('TASK-CRASH', 99)");
  // What a crash leaves: the main file and the WAL, with nobody connected and no shared memory.
  const crashed = join(s.root, 'crashed');
  mkdirSync(crashed);
  copyFileSync(s.paths.coordinator, join(crashed, 'coordinator.db'));
  copyFileSync(`${s.paths.coordinator}-wal`, join(crashed, 'coordinator.db-wal'));

  const cfg = backupConfig({ env: { ...s.env, COORDINATOR_DB: join(crashed, 'coordinator.db') }, home: s.root, repoDir: s.root });
  const status = await runBackups(cfg, { now: clock() });
  assert.equal(status.databases.coordinator.ok, true);
  assert.equal(query(join(cfg.dir, status.databases.coordinator.file), "SELECT COUNT(*) AS n FROM tasks WHERE task_id = 'TASK-CRASH'").n, 1);
});

test('backup: taken during concurrent writes, each copy is one consistent moment and passes its check', { skip: !available, timeout: 120_000 }, async (t) => {
  const s = setup(t, { coordinator: false });
  seedCoordinator(s.paths.coordinator, 3000); // more than one default backup step, so a stepped copy would have to restart

  // Every transaction adds one task and one event, so any consistent moment has the same number of each.
  const writer = spawn(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { timeout: 5000 });
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;');
    const task = db.prepare('INSERT INTO tasks (task_id, issue_number) VALUES (?, 1)');
    const event = db.prepare("INSERT INTO events (event_id, task_id, device_id, payload, payload_hash, ts, received_at) VALUES (?, 'x', 'x', 'p', 'h', 't', 't')");
    for (let n = 1; ; n++) {
      db.exec('BEGIN IMMEDIATE');
      task.run('W-' + n);
      event.run('W-' + n);
      db.exec('COMMIT');
      if (n === 200) console.log('ready');
    }
  `, s.paths.coordinator], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => writer.kill('SIGKILL'));
  await once(writer.stdout, 'data');

  const counts = [];
  for (let i = 0; i < 3; i++) {
    const status = await runBackups(s.cfg, { now: clock(T0 + i * 60_000) });
    assert.equal(status.databases.coordinator.ok, true, status.databases.coordinator.error);
    assert.equal(status.databases.coordinator.integrity, 'ok');
    const file = join(s.cfg.dir, status.databases.coordinator.file);
    const tasks = query(file, "SELECT COUNT(*) AS n FROM tasks WHERE task_id LIKE 'W-%'").n;
    const events = query(file, "SELECT COUNT(*) AS n FROM events WHERE event_id LIKE 'W-%'").n;
    assert.equal(tasks, events, 'a transaction was cut in half');
    assert.ok(tasks >= 200);
    counts.push(tasks);
  }
  assert.equal(writer.exitCode, null, 'the writer was still running');
  assert.ok(counts[0] < counts[1] && counts[1] < counts[2], `writes were going on throughout: ${counts}`);
});

test('backup: leaves a database nobody is using exactly as it was, and is a single private file', { skip: !available }, async (t) => {
  const s = setup(t);
  const before = readFileSync(s.paths.coordinator);
  const status = await runBackups(s.cfg, { now: clock() });
  assert.equal(status.ok, true);
  assert.ok(before.equals(readFileSync(s.paths.coordinator)));

  assert.equal(statSync(s.cfg.dir).mode & 0o777, 0o700);
  for (const name of ['coordinator', 'reviewer']) {
    const file = join(s.cfg.dir, status.databases[name].file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(file).size, status.databases[name].size_bytes);
    for (const side of ['-wal', '-shm', '-journal']) assert.equal(existsSync(`${file}${side}`), false, side);
  }
  assert.deepEqual(files(s.cfg.dir).filter((f) => f.startsWith('tmp-')), []);
});

test('backup: an existing folder is made private', { skip: !available }, async (t) => {
  const s = setup(t);
  mkdirSync(s.cfg.dir, { mode: 0o755 });
  chmodSync(s.cfg.dir, 0o755);
  await runBackups(s.cfg, { now: clock() });
  assert.equal(statSync(s.cfg.dir).mode & 0o777, 0o700);
});

test('backup: refuses to use the live databases\' folder, says so, and does not touch its permissions', { skip: !available }, async (t) => {
  const s = setup(t);
  chmodSync(s.live, 0o755);
  const cfg = backupConfig({ env: { ...s.env, ADABRA_BACKUP_DIR: s.live }, home: s.root, repoDir: s.root });
  const status = await runBackups(cfg, { now: clock() });
  assert.equal(status.ok, false);
  assert.match(status.databases.coordinator.error, /folder of the live coordinator database/);
  assert.equal(statSync(s.live).mode & 0o777, 0o755);
  assert.deepEqual(files(s.live), ['coordinator.db', 'reviewer.db']);
});

test('backup: two runs in one second never replace a good backup', { skip: !available }, async (t) => {
  const s = setup(t);
  await runBackups(s.cfg, { now: () => new Date(T0) });
  await runBackups(s.cfg, { now: () => new Date(T0) });
  assert.equal(finished(s.cfg.dir, 'coordinator').length, 2);
});

// --- failures are visible and cost nothing ------------------------------

test('a damaged backup is rejected: nothing replaced, nothing deleted, and the status and exit say so', { skip: !available }, async (t) => {
  const s = setup(t, { coordinator: false });
  seedCoordinator(s.paths.coordinator, 300);
  // Good backups from long ago, past the limit, which a good run would remove.
  await runBackups(s.cfg, { now: clock(T0 - 30 * DAY) });
  await runBackups(s.cfg, { now: clock(T0 - 20 * DAY) });
  const before = files(s.cfg.dir);
  const bytes = readFileSync(join(s.cfg.dir, finished(s.cfg.dir, 'coordinator')[0]));

  const status = await runBackups(s.cfg, { now: clock(T0), copy: withDamage });
  assert.equal(status.ok, false);
  const d = status.databases.coordinator;
  assert.deepEqual([d.ok, d.file, d.size_bytes, d.integrity], [false, null, null, 'failed']);
  assert.ok(d.error);
  assert.equal(d.removed, 0);
  assert.equal(d.newest_good_file, finished(s.cfg.dir, 'coordinator')[0]);
  assert.deepEqual(files(s.cfg.dir), before, 'the temp file is gone and everything else is as it was');
  assert.ok(bytes.equals(readFileSync(join(s.cfg.dir, finished(s.cfg.dir, 'coordinator')[0]))));
  assert.ok(statusProblems(status, T0).some((p) => p.startsWith('coordinator: ')));
});

test('a damaged live database fails its check at the source, and the CLI exits 1', { skip: !available }, async (t) => {
  const s = setup(t, { coordinator: false });
  seedCoordinator(s.paths.coordinator, 300);
  damage(s.paths.coordinator);
  const r = cli(s, ['run']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /coordinator: FAILED/);
  assert.match(r.stdout, /reviewer: reviewer-.*integrity ok/);
  assert.match(r.stdout, /finished: FAILED/);
  assert.deepEqual(finished(s.cfg.dir, 'coordinator'), []);
  assert.equal(readStatus(s.cfg.statusFile).ok, false);
});

test('a file that is not a database, or has none of the tables, is not a good backup', { skip: !available }, async (t) => {
  const s = setup(t);
  await runBackups(s.cfg, { now: clock(T0 - 30 * DAY) });
  const good = finished(s.cfg.dir, 'coordinator');

  writeFileSync(s.paths.coordinator, 'not a database '.repeat(500));
  let status = await runBackups(s.cfg, { now: clock(T0 - 2000) });
  assert.equal(status.databases.coordinator.ok, false);
  assert.match(status.databases.coordinator.error, /not a database/);

  // An empty file passes an integrity check, and would otherwise push out the real backups.
  writeFileSync(s.paths.coordinator, '');
  status = await runBackups(s.cfg, { now: clock(T0) });
  assert.equal(status.databases.coordinator.ok, false);
  assert.equal(status.databases.coordinator.integrity, 'ok');
  assert.match(status.databases.coordinator.error, /expected tables missing: devices/);
  assert.deepEqual(finished(s.cfg.dir, 'coordinator'), good);
});

test('a missing database is a reported failure; the other is still backed up and nothing is created', { skip: !available }, async (t) => {
  const s = setup(t, { reviewer: false });
  await runBackups(s.cfg, { now: clock(T0 - 30 * DAY) });
  const r = cli(s, ['run']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /reviewer: FAILED \(database file is missing\)/);
  const status = readStatus(s.cfg.statusFile);
  assert.equal(status.ok, false);
  assert.deepEqual([status.databases.reviewer.ok, status.databases.reviewer.integrity], [false, 'not_checked']);
  assert.equal(status.databases.coordinator.ok, true);
  assert.equal(existsSync(s.paths.reviewer), false, 'a backup must never create the database it could not find');
});

test('a copy that fails or never finishes is reported and leaves nothing behind', { skip: !available }, async (t) => {
  const s = setup(t);
  let status = await runBackups(s.cfg, {
    now: clock(),
    copy: async () => {
      throw Object.assign(new Error(`disk full, and here is ${SECRET}`), { code: 'ENOSPC' });
    },
  });
  assert.equal(status.databases.coordinator.error, 'ENOSPC', 'the code, not the free-form message');
  status = await runBackups(s.cfg, { now: clock(), copy: () => new Promise(() => {}), timeoutMs: 20 });
  assert.equal(status.databases.coordinator.error, 'timed out');
  assert.equal(status.ok, false);
  assert.deepEqual(files(s.cfg.dir), ['backup.lock.db']);
});

test('temp files left by a run that died are removed; lookalikes are not', { skip: !available }, async (t) => {
  const s = setup(t);
  mkdirSync(s.cfg.dir);
  const stale = ['tmp-coordinator-20261103T031500Z-123.db', 'tmp-coordinator-20261103T031500Z-123.db-journal'];
  const others = ['tmp-notes.db', 'tmp-coordinator.txt', 'coordinator-20261103-0315.db'];
  for (const f of [...stale, ...others]) writeFileSync(join(s.cfg.dir, f), 'x');
  await runBackups(s.cfg, { now: clock() });
  for (const f of stale) assert.equal(existsSync(join(s.cfg.dir, f)), false, f);
  for (const f of others) assert.equal(existsSync(join(s.cfg.dir, f)), true, f);
});

// --- retention ---------------------------------------------------------

test('retention: keeps 14 days and removes only this job\'s older backups of a database that just passed', { skip: !available }, async (t) => {
  const s = setup(t);
  mkdirSync(s.cfg.dir);
  const name = (ago, db = 'coordinator') => backupName(db, new Date(T0 - ago * DAY));
  const own = [name(15), name(30), name(15, 'reviewer')];
  const recent = [name(13), name(1), name(13, 'reviewer')];
  const others = [
    'coordinator-20200101-0300.db', // made by the manual backup command
    'coordinator-20200101T030000Z.db.bak',
    'my-coordinator-20200101T030000Z.db',
    'coordinator-20201399T999999Z.db',
    'notes.txt',
  ];
  for (const f of [...own, ...recent, ...others]) writeFileSync(join(s.cfg.dir, f), 'x');
  mkdirSync(join(s.cfg.dir, 'coordinator-20200102T030000Z.db')); // a folder with a backup's name
  mkdirSync(join(s.cfg.dir, 'before-restore-20200101T000000Z'));
  writeFileSync(join(s.cfg.dir, 'before-restore-20200101T000000Z', 'coordinator.db'), 'x');
  const target = join(s.root, 'elsewhere');
  writeFileSync(target, 'x');
  symlinkSync(target, join(s.cfg.dir, 'coordinator-20200103T030000Z.db'));

  const status = await runBackups(s.cfg, { now: clock() });
  assert.equal(status.ok, true);
  assert.equal(status.databases.coordinator.removed, 2);
  assert.equal(status.databases.reviewer.removed, 1);
  for (const f of own) assert.equal(existsSync(join(s.cfg.dir, f)), false, f);
  for (const f of [...recent, ...others, 'coordinator-20200102T030000Z.db', 'before-restore-20200101T000000Z', 'coordinator-20200103T030000Z.db']) {
    assert.equal(existsSync(join(s.cfg.dir, f)), true, f);
  }
  assert.equal(existsSync(target), true);
});

test('retention: the newest backup stays however old it is', (t) => {
  const dir = tempDir(t);
  const name = (ago) => backupName('coordinator', new Date(T0 - ago * DAY));
  for (const ago of [400, 500, 600]) writeFileSync(join(dir, name(ago)), 'x');
  const r = applyRetention({ dir, name: 'coordinator', now: new Date(T0) });
  assert.deepEqual(r.removed.sort(), [name(600), name(500)].sort());
  assert.deepEqual(finished(dir, 'coordinator'), [name(400)]);
  assert.deepEqual(applyRetention({ dir, name: 'coordinator', now: new Date(T0) }).removed, []);
});

test('retention: keep protects the backup just verified, even if a file with a later date exists', (t) => {
  const dir = tempDir(t);
  const old = backupName('coordinator', new Date(T0 - 30 * DAY));
  const future = backupName('coordinator', new Date(T0 + 30 * DAY));
  for (const f of [old, future]) writeFileSync(join(dir, f), 'x');
  assert.deepEqual(applyRetention({ dir, name: 'coordinator', now: new Date(T0), keep: old }).removed, []);
});

test('retention: a failed database keeps its old backups while the healthy one is tidied', { skip: !available }, async (t) => {
  const s = setup(t);
  await runBackups(s.cfg, { now: clock(T0 - 30 * DAY) });
  rmSync(s.paths.coordinator);
  const status = await runBackups(s.cfg, { now: clock(T0) });
  assert.equal(status.databases.coordinator.removed, 0);
  assert.equal(finished(s.cfg.dir, 'coordinator').length, 1);
  assert.equal(status.databases.reviewer.removed, 1);
  assert.equal(finished(s.cfg.dir, 'reviewer').length, 1);
});

test('retention: a backup that cannot be removed is reported, not ignored', { skip: process.getuid?.() === 0 }, (t) => {
  const dir = tempDir(t);
  for (const ago of [20, 30]) writeFileSync(join(dir, backupName('reviewer', new Date(T0 - ago * DAY))), 'x');
  chmodSync(dir, 0o500);
  let r;
  try {
    r = applyRetention({ dir, name: 'reviewer', now: new Date(T0) });
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(r.error, 'EACCES');
  assert.deepEqual(r.removed, []);
  assert.deepEqual(statusProblems({
    finished_at: new Date(T0).toISOString(),
    databases: { reviewer: { ok: true, retention_error: r.error } },
  }, T0), ['reviewer: old backups could not be removed (EACCES)']);
});

// --- only one at a time ------------------------------------------------

test('lock: a second run does nothing while one is in progress', { skip: !available }, async (t) => {
  const s = setup(t);
  mkdirSync(s.cfg.dir);
  const release = takeLock(s.cfg.dir);
  assert.equal(takeLock(s.cfg.dir), null);
  const status = await runBackups(s.cfg, { now: clock() });
  assert.deepEqual(status, { busy: true, ok: false });
  assert.equal(existsSync(s.cfg.statusFile), false);
  assert.deepEqual(finished(s.cfg.dir, 'coordinator'), []);
  const r = cli(s, ['run']);
  assert.equal(r.status, 75);
  release();
  assert.equal((await runBackups(s.cfg, { now: clock() })).ok, true);
});

test('lock: a run that was killed cannot block the next one', { skip: !available, timeout: 60_000 }, async (t) => {
  const s = setup(t);
  mkdirSync(s.cfg.dir);
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { takeLock } from ${JSON.stringify(new URL('../backup/backup.js', import.meta.url).href)};
    if (!takeLock(process.argv[1])) process.exit(9);
    console.log('held');
    setInterval(() => {}, 1000);
  `, s.cfg.dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill('SIGKILL'));
  await once(holder.stdout, 'data');
  assert.equal((await runBackups(s.cfg, { now: clock() })).busy, true);
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  assert.equal((await runBackups(s.cfg, { now: clock() })).ok, true);
});

// --- the status file ---------------------------------------------------

test('status: says when, and for each database the file, size and check; nothing else', { skip: !available }, async (t) => {
  const s = setup(t);
  const status = await runBackups(s.cfg, { now: clock() });
  const written = readStatus(s.cfg.statusFile);
  assert.deepEqual(written, status);
  assert.deepEqual(Object.keys(written).sort(), ['backup_dir', 'databases', 'finished_at', 'ok', 'retention_days', 'started_at', 'version']);
  assert.equal(written.version, 1);
  assert.equal(written.retention_days, 14);
  assert.ok(Date.parse(written.finished_at) >= Date.parse(written.started_at));
  assert.deepEqual(Object.keys(written.databases).sort(), ['coordinator', 'reviewer']);
  const d = written.databases.coordinator;
  assert.deepEqual(Object.keys(d).sort(), [
    'error', 'file', 'integrity', 'kept', 'newest_good_at', 'newest_good_file', 'ok', 'removed', 'retention_error', 'size_bytes',
  ]);
  assert.deepEqual([d.ok, d.integrity, d.error, d.kept, d.removed], [true, 'ok', null, 1, 0]);
  assert.equal(d.file, d.newest_good_file);
  assert.equal(typeof d.size_bytes, 'number');
  assert.equal(statSync(s.cfg.statusFile).mode & 0o777, 0o600);
  assert.deepEqual(files(dirname(s.cfg.statusFile)), ['backup-status.json']);
  assert.deepEqual(statusProblems(written, Date.parse(written.finished_at)), []);
});

test('status: too old, missing and unreadable all count as problems', { skip: !available }, async (t) => {
  const s = setup(t);
  assert.deepEqual(statusProblems(readStatus(s.cfg.statusFile)), ['no backup has finished yet']);
  const r0 = cli(s, ['status']);
  assert.equal(r0.status, 1);
  assert.match(r0.stdout, /PROBLEM: no backup has finished yet/);

  const past = Date.now() - 3 * DAY;
  const status = await runBackups(s.cfg, { now: clock(past) });
  const finishedAt = Date.parse(status.finished_at);
  assert.deepEqual(statusProblems(status, finishedAt + 25 * 3_600_000), []);
  assert.match(statusProblems(status, finishedAt + 27 * 3_600_000)[0], /more than 26 hours old/);
  const stale = cli(s, ['status']);
  assert.equal(stale.status, 1, 'that run was three days ago');
  assert.match(stale.stdout, /coordinator: coordinator-.*integrity ok/);

  await runBackups(s.cfg);
  const fresh = cli(s, ['status']);
  assert.equal(fresh.status, 0, fresh.stdout);
  assert.doesNotMatch(fresh.stdout, /PROBLEM/);

  writeFileSync(s.cfg.statusFile, '{half a file');
  assert.deepEqual(statusProblems(readStatus(s.cfg.statusFile)), ['the status file could not be read']);
  assert.equal(cli(s, ['status']).status, 1);
});

// --- nothing from inside a database comes out ---------------------------

test('a secret inside a database never reaches any output or the status file, in success or failure', { skip: !available }, async (t) => {
  const s = setup(t);
  const outputs = [];
  const check = (r) => {
    outputs.push(r.stdout, r.stderr);
    return r;
  };
  assert.equal(check(cli(s, ['run'])).status, 0);
  assert.equal(check(cli(s, ['status'])).status, 0);
  assert.equal(check(cli(s, ['drill'])).status, 0);
  outputs.push(readFileSync(s.cfg.statusFile, 'utf8'));

  // The control: the secret really is in the backup, so its absence everywhere else means something.
  const backup = join(s.cfg.dir, finished(s.cfg.dir, 'coordinator')[0]);
  assert.ok(readFileSync(backup).includes(SECRET));

  // Now with a damaged database and a damaged backup, where error messages come into it.
  damage(backup, 2, 40);
  assert.equal(check(cli(s, ['drill'])).status, 1);
  seedCoordinatorMore(s.paths.coordinator);
  damage(s.paths.coordinator, 2, 40);
  assert.equal(check(cli(s, ['run'])).status, 1);
  assert.equal(check(cli(s, ['status'])).status, 1);
  outputs.push(readFileSync(s.cfg.statusFile, 'utf8'));

  const all = outputs.join('\n');
  assert.ok(all.includes('integrity'), 'the outputs were captured');
  assert.equal(all.includes(SECRET), false);
  assert.equal(all.includes('x'.repeat(50)), false);
});

function seedCoordinatorMore(path) {
  const s = new Store(path);
  s.db.exec('BEGIN');
  const insert = s.db.prepare("INSERT INTO events (event_id, task_id, device_id, payload, payload_hash, ts, received_at) VALUES (?, 'TASK-1', 'member-a', ?, 'h', 't', 't')");
  for (let i = 0; i < 300; i++) insert.run(`more-${i}`, `${SECRET} ${'x'.repeat(400)}`);
  s.db.exec('COMMIT');
  s.close();
}

// --- the drill ---------------------------------------------------------

function drill(s, opts = {}) {
  const lines = [];
  const r = runDrill(s.cfg, { say: (l) => lines.push(l), ...opts });
  return { ...r, lines, text: lines.join('\n') };
}

test('drill: restores the newest backup to a temp copy, prints only table names and row counts, and deletes the copy', { skip: !available }, async (t) => {
  const s = setup(t);
  await runBackups(s.cfg, { now: clock(T0 - DAY) });
  const newer = new Store(s.paths.coordinator);
  newer.addTask('TASK-2', 2);
  newer.close();
  const newest = (await runBackups(s.cfg, { now: clock(T0) })).databases.coordinator.file;
  const tmpRoot = join(s.root, 'tmp');
  mkdirSync(tmpRoot);
  const before = { live: files(s.live), backups: files(s.cfg.dir), bytes: readFileSync(s.paths.coordinator) };

  const r = drill(s, { tmpRoot });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, new RegExp(`coordinator: ${newest}`), 'the newest');
  assert.match(r.text, /tables: claims 0, devices 2, events 50, review_results 0, task_reviews 0, tasks 2/);
  assert.match(r.text, /tables: jobs 1, prs 0, review_pause 0, review_runs 0, task_results 0/);
  assert.match(r.text, /integrity_check: ok/);
  assert.match(r.text, /drill passed$/);
  assert.doesNotMatch(r.text, new RegExp(SECRET));
  assert.deepEqual(files(tmpRoot), [], 'the copy is gone');
  assert.deepEqual(files(s.live), before.live, 'nothing appeared beside the live databases');
  assert.ok(before.bytes.equals(readFileSync(s.paths.coordinator)));
  assert.deepEqual(files(s.cfg.dir), before.backups, 'nothing appeared beside the backups');
});

test('drill: can check one chosen backup', { skip: !available }, async (t) => {
  const s = setup(t);
  const older = (await runBackups(s.cfg, { now: clock(T0 - DAY) })).databases.coordinator.file;
  await runBackups(s.cfg, { now: clock(T0) });
  const r = drill(s, { file: join(s.cfg.dir, older) });
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, new RegExp(older));
  assert.doesNotMatch(r.text, /reviewer/);
});

test('drill: refuses a live database, however it is named', { skip: !available }, async (t) => {
  const s = setup(t);
  await runBackups(s.cfg, { now: clock() });
  const before = readFileSync(s.paths.coordinator);
  const refused = (r) => {
    assert.deepEqual([r.ok, r.refused], [false, true], r.text);
    assert.match(r.text, /^refused: /);
  };

  refused(drill(s, { file: s.paths.coordinator })); // its real name
  refused(drill(s, { file: join(s.root, 'copy', 'reviewer.db') }));

  const name = backupName('coordinator', new Date(T0));
  const asSymlink = join(s.root, 'links', name);
  mkdirSync(dirname(asSymlink));
  symlinkSync(s.paths.coordinator, asSymlink);
  refused(drill(s, { file: asSymlink }));

  const asHardLink = join(s.root, 'hard', name);
  mkdirSync(dirname(asHardLink));
  linkSync(s.paths.coordinator, asHardLink);
  refused(drill(s, { file: asHardLink }));
  rmSync(asHardLink);

  // A backup's name, but in the same folder as the live databases.
  const beside = join(s.live, name);
  copyFileSync(join(s.cfg.dir, finished(s.cfg.dir, 'coordinator')[0]), beside);
  refused(drill(s, { file: beside }));
  rmSync(beside);

  // A file in use: a backup is one file, and this has a WAL beside it.
  const inUse = join(s.root, 'in-use', name);
  mkdirSync(dirname(inUse));
  copyFileSync(join(s.cfg.dir, finished(s.cfg.dir, 'coordinator')[0]), inUse);
  writeFileSync(`${inUse}-wal`, '');
  refused(drill(s, { file: inUse }));

  refused(drill(s, { file: join(s.root, 'none', name) }));
  assert.ok(before.equals(readFileSync(s.paths.coordinator)));
});

test('drill: refuses to look in the live folder or to write near the live databases', { skip: !available }, async (t) => {
  const s = setup(t);
  const cfg = backupConfig({ env: { ...s.env, ADABRA_BACKUP_DIR: s.live }, home: s.root, repoDir: s.root });
  const say = () => {};
  assert.equal(runDrill(cfg, { say }).refused, true);

  await runBackups(s.cfg, { now: clock() });
  mkdirSync(join(s.live, 'sub'));
  for (const tmpRoot of [s.live, join(s.live, 'sub')]) {
    const before = files(tmpRoot);
    const r = drill(s, { tmpRoot });
    assert.equal(r.refused, true, r.text);
    assert.match(r.text, /too close to a live database/);
    assert.deepEqual(files(tmpRoot), before);
  }
});

test('drill: a damaged backup, a missing table or no backup fails, and the copy is still deleted', { skip: !available }, async (t) => {
  const s = setup(t, { coordinator: false });
  seedCoordinator(s.paths.coordinator, 300);
  const tmpRoot = join(s.root, 'tmp');
  mkdirSync(tmpRoot);

  let r = drill(s, { tmpRoot });
  assert.equal(r.ok, false);
  assert.match(r.text, /coordinator: FAILED \(no backup found\)/);
  assert.match(r.text, /drill FAILED$/);

  await runBackups(s.cfg, { now: clock() });
  const file = join(s.cfg.dir, finished(s.cfg.dir, 'coordinator')[0]);
  const good = readFileSync(file);
  damage(file);
  r = drill(s, { tmpRoot });
  assert.equal(r.ok, false);
  assert.match(r.text, /coordinator: .*\n {2}integrity_check: failed/);
  assert.doesNotMatch(r.text, /tables: claims/);
  assert.deepEqual(files(tmpRoot), []);

  writeFileSync(file, good);
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE claims');
  db.close();
  r = drill(s, { tmpRoot });
  assert.equal(r.ok, false);
  assert.match(r.text, /expected tables missing: claims/);
  assert.deepEqual(files(tmpRoot), []);
});

test('drill: the CLI exits 1 for a refusal and 0 for a pass', { skip: !available }, (t) => {
  const s = setup(t);
  assert.equal(cli(s, ['run']).status, 0);
  const pass = cli(s, ['drill']);
  assert.equal(pass.status, 0, pass.stdout + pass.stderr);
  const refused = cli(s, ['drill', '--file', s.paths.coordinator]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /refused: /);
  assert.equal(cli(s, ['drill', '--nonsense']).status, 2);
  assert.equal(cli(s, ['nonsense']).status, 2);
});

// --- a restore gives the data back ---------------------------------------

test('restore: the README steps give back the coordinator\'s data, its tokens, and a working WAL database', { skip: !available }, async (t) => {
  const s = setup(t);
  const status = await runBackups(s.cfg, { now: clock() });
  const backup = join(s.cfg.dir, status.databases.coordinator.file);

  // Changes after the backup, which the restore loses.
  const later = new Store(s.paths.coordinator);
  later.addTask('TASK-LATER', 50);
  const laterToken = later.addDevice('member-later');
  later.revokeDevice('member-a');
  later.close();

  // Keep the current file, with its side files, then put the backup in its place.
  const keep = join(s.cfg.dir, 'before-restore-test');
  mkdirSync(keep, { mode: 0o700 });
  const moved = [];
  for (const f of ['coordinator.db', 'coordinator.db-wal', 'coordinator.db-shm']) {
    if (existsSync(join(s.live, f))) {
      copyFileSync(join(s.live, f), join(keep, f));
      rmSync(join(s.live, f));
      moved.push(f);
    }
  }
  assert.ok(moved.includes('coordinator.db'));
  copyFileSync(backup, s.paths.coordinator);
  chmodSync(s.paths.coordinator, 0o600);

  const restored = new Store(s.paths.coordinator);
  t.after(() => restored.close());
  assert.equal(restored.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.ok(restored.getTask('TASK-1'));
  assert.equal(restored.getTask('TASK-LATER'), undefined, 'everything since the backup is gone');
  assert.equal(restored.authenticate('member-a', s.token), true, 'and a device revoked since then works again, which is why the README says to revoke it again');
  assert.equal(restored.authenticate('member-later', laterToken), false);
  assert.equal(restored.counts().pending, 50);
  assert.equal(query(join(keep, 'coordinator.db'), "SELECT COUNT(*) AS n FROM tasks WHERE task_id = 'TASK-LATER'").n, 1, 'the kept file still has them');
  assert.equal(verifyBackup(backup, DATABASES.coordinator.tables).ok, true, 'the backup itself is untouched by the restore');
});

test('restore: fencing as the README says stops the old owner, and the task can be claimed again', { skip: !available }, async (t) => {
  const s = setup(t);
  const seeded = new Store(s.paths.coordinator);
  const now = Date.now();
  const first = seeded.claimTask('TASK-1', 'member-a', 'RUN-old', now, 180_000);
  seeded.close();
  const status = await runBackups(s.cfg, { now: clock() });

  const restoredPath = join(s.root, 'restored.db');
  copyFileSync(join(s.cfg.dir, status.databases.coordinator.file), restoredPath);
  const store = new Store(restoredPath);
  t.after(() => store.close());
  const stale = { task_id: 'TASK-1', device_id: 'member-a', run_id: 'RUN-old', claim_generation: first.generation };
  assert.equal(store.eventMatchesClaim(stale), true, 'without the fence, the owner at backup time could still report');
  assert.equal(store.cancelClaim('TASK-1').ok, true);
  assert.equal(store.eventMatchesClaim(stale), false);
  const again = store.claimTask('TASK-1', 'member-a', 'RUN-new', now, 180_000);
  assert.equal(again.ok, true);
  assert.equal(again.generation, first.generation + 2);
});

test('restore: the reviewer\'s data comes back', { skip: !available }, async (t) => {
  const s = setup(t);
  const status = await runBackups(s.cfg, { now: clock() });
  const restoredPath = join(s.root, 'restored-reviewer.db');
  copyFileSync(join(s.cfg.dir, status.databases.reviewer.file), restoredPath);
  const store = new ReviewStore(restoredPath);
  t.after(() => store.close());
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.getJob(7, 'a'.repeat(40)).meta.title, SECRET);
});

// --- the service script, with a fake launchctl ----------------------------

function fakeService(t, { retriesBeforeLoad = 1 } = {}) {
  const s = setup(t);
  const bin = join(s.root, 'bin');
  mkdirSync(bin);
  const state = join(s.root, 'launchctl');
  mkdirSync(state);
  // Fails the first bootstrap, as launchd does while the old service is still going away.
  writeFileSync(join(bin, 'launchctl'), `#!/bin/bash
echo "$*" >> ${JSON.stringify(join(state, 'calls'))}
case "$1" in
  print) [ -f ${JSON.stringify(join(state, 'loaded'))} ] && echo "state = not running" ;;
  bootstrap)
    n=$(cat ${JSON.stringify(join(state, 'tries'))} 2>/dev/null || echo 0)
    echo $((n + 1)) > ${JSON.stringify(join(state, 'tries'))}
    [ "$n" -ge ${retriesBeforeLoad} ] && touch ${JSON.stringify(join(state, 'loaded'))} ;;
  bootout) rm -f ${JSON.stringify(join(state, 'loaded'))} ;;
esac
`);
  chmodSync(join(bin, 'launchctl'), 0o755);
  const home = join(s.root, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, ...s.env };
  const run = (...args) => spawnSync(SERVICE, args, { encoding: 'utf8', env });
  return { ...s, home, run, calls: () => readFileSync(join(state, 'calls'), 'utf8') };
}

test('service: the script parses, and anything but a known command is refused', () => {
  execFileSync('bash', ['-n', SERVICE]);
  assert.equal(spawnSync(SERVICE, [], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(SERVICE, ['nonsense'], { encoding: 'utf8' }).status, 2);
});

test('service: install writes a nightly, non-restarting plist and retries a bootstrap that lost the race', { timeout: 60_000 }, (t) => {
  const f = fakeService(t);
  const r = f.run('install');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const plistPath = join(f.home, 'Library', 'LaunchAgents', 'ai.adabra.backup.plist');
  const plist = readFileSync(plistPath, 'utf8');
  assert.equal(statSync(plistPath).mode & 0o777, 0o600);
  assert.match(plist, /<key>StartCalendarInterval<\/key>\s*<dict><key>Hour<\/key><integer>3<\/integer><key>Minute<\/key><integer>15<\/integer><\/dict>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(plist, /KeepAlive/, 'a job that finishes must not be restarted');
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  assert.ok(plist.includes(`<string>${join(REPO, 'backup', 'main.js')}</string><string>run</string><string>--notify</string>`));
  for (const [key, value] of Object.entries(f.env)) assert.ok(plist.includes(`<key>${key}</key><string>${value}</string>`), key);
  if (process.platform === 'darwin') execFileSync('/usr/bin/plutil', ['-lint', plistPath]);

  const calls = f.calls();
  assert.equal(calls.match(/^bootstrap /gm).length, 2, 'the first attempt failed and it tried again');
  assert.doesNotMatch(calls, /kickstart -k/, 'it must not kill a run in progress');
  assert.match(r.stdout, /state = not running/);
  assert.match(r.stdout, /PROBLEM: no backup has finished yet/, 'the fake launchd runs nothing, and status says so');

  assert.equal(f.run('run').status, 0);
  assert.match(f.calls(), /^kickstart gui\/\d+\/ai\.adabra\.backup$/m);
  assert.equal(f.run('status').status, 1, 'no backup yet, so status is unhappy');

  mkdirSync(f.cfg.dir);
  writeFileSync(join(f.cfg.dir, 'keep-me'), 'x');
  const u = f.run('uninstall');
  assert.equal(u.status, 0);
  assert.equal(existsSync(plistPath), false);
  assert.equal(existsSync(join(f.cfg.dir, 'keep-me')), true, 'uninstall leaves the backups');
  assert.match(f.run('status').stdout, /service not loaded/);
});

test('service: install refuses when a database is not where it would look', (t) => {
  const f = fakeService(t);
  rmSync(f.paths.reviewer);
  const r = f.run('install');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no database at /);
  assert.equal(existsSync(join(f.home, 'Library', 'LaunchAgents', 'ai.adabra.backup.plist')), false);
  assert.throws(() => f.calls(), { code: 'ENOENT' }, 'launchctl was never called');
});

test('service: reports a plist launchd will not load', { timeout: 60_000 }, (t) => {
  const f = fakeService(t, { retriesBeforeLoad: 99 });
  const r = f.run('install');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /could not load ai\.adabra\.backup/);
});

test('service: drill passes its arguments through and needs no launchctl', { skip: !available }, async (t) => {
  const f = fakeService(t);
  await runBackups(f.cfg, { now: clock() });
  const older = finished(f.cfg.dir, 'coordinator')[0];
  const r = f.run('drill', '--file', join(f.cfg.dir, older));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /tables: claims 0/);
  assert.equal(f.run('drill').status, 0);
  assert.throws(() => f.calls(), { code: 'ENOENT' });
});
