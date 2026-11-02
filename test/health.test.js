import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  ageText, buildChecks, EXIT_BUSY, EXIT_FAILED, EXIT_USAGE, FAIL_AGAIN_MS, formatLine, healthCommand, healthStatusPath, JOB_EVERY_MS, LABELS, OVERDUE_MS,
  parseLaunchctl, parseServe, planNotifications, readLastStatus, realNotify, realProbes, REMIND_AGAIN_MS, runChecks, runTool, takeRunLock, worstLevel,
} from '../ops/health.js';
import { openQueueDb, readQueueState } from '../ops/health-queue.js';
import { KEEP_ROTATED, rotateLogs, ROTATE_OVER_BYTES, scanLogs } from '../ops/rotate-logs.js';
import { ReviewStore } from '../reviewer/store.js';
import { recordStop } from '../shared/stop.js';

// Everything here is fakes and temp folders. No test reaches a real service, database, log, launchctl, docker, Tailscale or notification:
// probes are replaced, or the tools on PATH are small scripts made below, and those always come first.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = join(REPO, 'ops', 'main.js');
const OPS = join(REPO, 'service', 'ops.sh');
const SERVICE = join(REPO, 'service', 'health-service.sh');
const QUEUE_SCRIPT = join(REPO, 'ops', 'health-queue.js');
const SECRET = 'FAKE-SECRET-VALUE-do-not-print-7f3a';
const TAILNET = 'made-up-tailnet';
const posixOnly = { skip: process.platform === 'win32' };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const SERVE_OK = `https://mini.${TAILNET}.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:8787\n`;

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-health-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// --- the checks, with fake probes -----------------------------------------------------------------------------------------

const running = { installed: true, known: true, loaded: true, state: 'running', pid: '42', lastExit: '0' };
const asleep = { ...running, state: 'not running', pid: 'unknown' };
const healthy = (over = {}) => ({
  port: 8787,
  stop: () => ({ stopped: false }),
  service: async (label) => (label === LABELS.backup || label === LABELS.health ? asleep : running),
  healthz: async () => ({ answered: true, ok: true, stopped: false }),
  helperStatus: () => ({ at: T0 - 5000, held: 1, pending: 0 }),
  docker: async () => ({ code: 0, stdout: '28.0.0\n' }),
  tailscaleStatus: async () => ({ backend: 'Running', keyExpiry: iso(T0 + 200 * DAY), hasTailnet: true }),
  tailscaleServe: async () => ({ code: 0, stdout: SERVE_OK }),
  loginPref: async () => ({ code: 0, stdout: '1\n' }),
  disk: async () => ({ freeBytes: 200e9, totalBytes: 500e9 }),
  backupStatus: () => ({ finished_at: iso(T0 - HOUR), databases: { coordinator: { ok: true }, reviewer: { ok: true } } }),
  queue: async () => ({
    jobs: { queued: 0, running: 0, done: 5, superseded: 1, failed: 0 }, due: 0, oldest_due_ms: null, failed_last_day: 0,
    task_results: { pending: 0, acked: 2, rejected: 0 }, pause_known: true, pause: null,
  }),
  scanLogs: async () => ({ folder: 'ok', files: 2, largest: 1000, over: [], skipped: 0, temps: [] }),
  rotateLogs: async () => ({ folder: 'ok', files: 2, largest: 1000, skipped: 0, rotated: [], failed: [] }),
  lastStatus: () => ({ at: iso(T0 - 15 * MINUTE), lines: [] }),
  ...over,
});

const NAMES = ['stop', 'coordinator', 'helper', 'reviewer', 'docker', 'tailscale', 'tailscale-serve', 'tailscale-key', 'tailscale-login', 'disk', 'backup', 'review-queue', 'review-pause', 'logs', 'health-job'];

async function report(over = {}, { job = false, nowMs = T0, ...run } = {}) {
  const lines = await runChecks(buildChecks(healthy(over), { nowMs, job }), run);
  return { lines, by: Object.fromEntries(lines.map((l) => [l.check, l])) };
}
async function lineFor(check, over, options) {
  return (await report(over, options)).by[check];
}
const queueWith = (fields) => async () => ({
  jobs: { queued: 1, running: 0, done: 0, superseded: 0, failed: 0 }, due: 1, oldest_due_ms: 5000, failed_last_day: 0,
  task_results: { pending: 0, acked: 0, rejected: 0 }, pause_known: true, pause: null, ...fields,
});

test('a healthy system: every check OK, in a fixed order, and every line holds a level, a word for its state and some words', async () => {
  const { lines } = await report();
  assert.deepEqual(lines.map((l) => l.check), NAMES);
  for (const l of lines) {
    assert.equal(l.level, 'OK', `${l.check}: ${l.detail}`);
    assert.ok(l.state && l.detail, l.check);
  }
  assert.equal(worstLevel(lines), 'OK');
  assert.match(formatLine(lines[0]), /^OK {4}stop {13}no emergency stop/);
});

test('stop: deliberate is a WARN and says since when, past a day it also asks for a reminder, and only an unreadable file is a FAIL', async () => {
  const since = iso(T0 - 3 * HOUR);
  const short = await lineFor('stop', { stop: () => ({ stopped: true, reason: `reason ${SECRET}`, since }) });
  assert.equal(short.level, 'WARN');
  assert.ok(short.detail.includes(since));
  assert.ok(!short.remind, 'a stop that has just been set tells nobody what they already know');
  assert.ok(!JSON.stringify(short).includes(SECRET), 'the reason stays in the stop file: status lines are states and counts');

  const long = await lineFor('stop', { stop: () => ({ stopped: true, reason: 'x', since: iso(T0 - 3 * DAY) }) });
  assert.equal(long.level, 'WARN', 'however long, a deliberate stop is not a failure');
  assert.equal(long.remind, true);
  assert.match(long.detail, /3d ago/);

  const unknown = await lineFor('stop', { stop: () => ({ stopped: true, reason: 'x', since: null }) });
  assert.equal(unknown.level, 'WARN');
  assert.match(unknown.detail, /unknown time/);

  const broken = await lineFor('stop', { stop: () => ({ stopped: true, unreadable: 'not JSON', reason: 'x', since: null }) });
  assert.equal(broken.level, 'FAIL');
  assert.match(broken.detail, /resume repairs it/);
});

test('stop: the real reader and the check agree, on a real file and a damaged one', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'stop.json');
  const probes = realProbes({ env: { ADABRA_STOP_FILE: path, PATH: dir }, home: dir });
  const line = () => lineFor('stop', { stop: probes.stop });
  assert.equal((await line()).level, 'OK');
  recordStop({ reason: SECRET, by: 'x', at: new Date(T0 - HOUR), path });
  assert.equal((await line()).level, 'WARN');
  assert.ok(!JSON.stringify(await line()).includes(SECRET));
  writeFileSync(path, 'not json {');
  assert.equal((await line()).level, 'FAIL');
});

test('coordinator: needs both the answer and the service, and says which is wrong', async () => {
  const svc = (s) => async (label) => (label === LABELS.coordinator ? s : running);
  const line = (over) => lineFor('coordinator', over);
  assert.equal((await line({ healthz: async () => ({ answered: false, ok: false, stopped: false }) })).level, 'FAIL');
  assert.match((await line({ healthz: async () => ({ answered: false, ok: false }), service: svc({ installed: true, known: true, loaded: false }) })).detail, /not loaded/);
  assert.equal((await line({ healthz: async () => ({ answered: true, ok: false, stopped: false }) })).state, 'bad-answer');
  const byHand = await line({ service: svc({ installed: false, known: true, loaded: false }) });
  assert.equal(byHand.level, 'WARN');
  assert.match(byHand.detail, /started by hand/);
  const noLaunchctl = await line({ service: svc({ installed: true, known: false, why: 'launchctl was not found' }) });
  assert.equal(noLaunchctl.level, 'WARN');
  assert.match(noLaunchctl.detail, /launchctl was not found/);
});

test('coordinator: a stop in force is healthy when both sides know of it, and worth a WARN when they differ', async () => {
  const stop = () => ({ stopped: true, reason: 'x', since: iso(T0 - HOUR) });
  const agreed = await lineFor('coordinator', { stop, healthz: async () => ({ answered: true, ok: true, stopped: true }) });
  assert.equal(agreed.level, 'OK');
  assert.match(agreed.detail, /reports the stop/);
  assert.equal((await lineFor('coordinator', { stop })).state, 'stop-differs');
  assert.equal((await lineFor('coordinator', { healthz: async () => ({ answered: true, ok: true, stopped: true }) })).state, 'stop-differs');
});

test('helper and reviewer: not installed, not loaded, not running, and a helper that has stopped passing', async () => {
  const svc = (s) => async () => s;
  const notInstalled = { installed: false, known: true, loaded: false };
  assert.equal((await lineFor('helper', { service: svc(notInstalled) })).level, 'WARN', 'a machine may not be a builder');
  assert.equal((await lineFor('reviewer', { service: svc(notInstalled) })).level, 'FAIL', 'this machine is the reviewer');
  for (const check of ['helper', 'reviewer']) {
    assert.equal((await lineFor(check, { service: svc({ installed: true, known: true, loaded: false }) })).state, 'not-loaded');
    const crashed = await lineFor(check, { service: svc({ ...running, state: 'spawn scheduled', lastExit: '1' }) });
    assert.equal(crashed.level, 'FAIL');
    assert.match(crashed.detail, /spawn scheduled, last exit code 1/);
    const gone = await lineFor(check, { service: svc({ installed: false, known: false, why: 'launchctl was not found' }) });
    assert.equal(gone.level, 'FAIL');
    assert.match(gone.detail, /launchctl was not found/);
  }
  assert.equal((await lineFor('helper', { helperStatus: () => null })).state, 'no-status');
  assert.equal((await lineFor('helper', { helperStatus: () => ({ unreadable: true }) })).state, 'unreadable');
  const stale = await lineFor('helper', { helperStatus: () => ({ at: T0 - 5 * MINUTE, held: 0, pending: 0 }) });
  assert.equal(stale.level, 'FAIL');
  assert.match(stale.detail, /5m ago/);
});

test('docker: answers, down, not found, stuck', async () => {
  const line = (r) => lineFor('docker', { docker: async () => r });
  assert.equal((await line({ code: 1, stdout: SECRET })).state, 'down');
  assert.equal((await line({ code: null, stdout: '', missing: true })).state, 'missing');
  assert.equal((await line({ code: null, stdout: '', timedOut: true })).state, 'stuck');
  assert.equal((await line({ code: null, stdout: '', overflow: true })).level, 'FAIL');
  assert.equal((await line({ code: null, stdout: '', failed: 'EACCES' })).level, 'FAIL');
  assert.ok(!JSON.stringify(await line({ code: 1, stdout: SECRET })).includes(SECRET));
});

test('tailscale: stopped, signed out and missing are FAILs; the key line never repeats the same FAIL', async () => {
  for (const backend of ['Stopped', 'NeedsLogin', 'NoState']) {
    const l = await lineFor('tailscale', { tailscaleStatus: async () => ({ backend, keyExpiry: null, hasTailnet: false }) });
    assert.equal(l.level, 'FAIL');
    assert.equal(l.state, `backend-${backend}`);
  }
  const missing = { tailscaleStatus: async () => ({ code: null, stdout: '', missing: true }) };
  assert.equal((await lineFor('tailscale', missing)).state, 'missing');
  assert.equal((await lineFor('tailscale-key', missing)).level, 'WARN');
  const stuck = { tailscaleStatus: async () => ({ code: null, stdout: '', timedOut: true }) };
  assert.equal((await lineFor('tailscale', stuck)).state, 'stuck');
  const nonsense = { tailscaleStatus: async () => ({ code: 0, unparsed: true }) };
  assert.equal((await lineFor('tailscale', nonsense)).state, 'unparsed');
  assert.equal((await lineFor('tailscale-key', nonsense)).level, 'WARN');
});

test('tailscale key: fine, a WARN that reminds inside 30 days, a FAIL once it has passed; no expiry is fine', async () => {
  const line = (keyExpiry) => lineFor('tailscale-key', { tailscaleStatus: async () => ({ backend: 'Running', keyExpiry, hasTailnet: true }) });
  assert.equal((await line(null)).state, 'no-expiry');
  assert.equal((await line('0001-01-01T00:00:00Z')).state, 'no-expiry');
  const far = await line(iso(T0 + 31 * DAY));
  assert.equal(far.level, 'OK');
  assert.ok(far.detail.includes(iso(T0 + 31 * DAY).slice(0, 10)));
  const soon = await line(iso(T0 + 29 * DAY));
  assert.equal(soon.level, 'WARN');
  assert.equal(soon.remind, true);
  assert.equal((await line(iso(T0 - DAY))).level, 'FAIL');
  assert.equal((await line('whenever')).level, 'WARN');
});

test('tailscale start at login: 0 is a WARN, and the line says its meaning is inferred', async () => {
  const line = (r) => lineFor('tailscale-login', { loginPref: async () => r });
  const off = await line({ code: 0, stdout: '0\n' });
  assert.equal(off.level, 'WARN');
  assert.match(off.detail, /inferred/);
  const on = await line({ code: 0, stdout: '1\n' });
  assert.equal(on.level, 'OK');
  assert.match(on.detail, /inferred/);
  assert.equal((await line({ code: 1, stdout: '' })).state, 'unknown');
  assert.equal((await line({ code: null, stdout: '', missing: true })).state, 'unknown');
  assert.equal((await line({ code: null, stdout: '', timedOut: true })).level, 'WARN');
});

test('tailscale serve: tailnet only is the only OK, and no line ever repeats the host name', async () => {
  assert.equal(parseServe(SERVE_OK, 8787), 'tailnet');
  assert.equal(parseServe(SERVE_OK, 9999), 'none');
  assert.equal(parseServe('No serve config\n', 8787), 'none');
  assert.equal(parseServe('https://x.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:8787\n', 8787), 'public');
  assert.equal(parseServe('https://x.ts.net\n|-- / proxy http://127.0.0.1:8787\n', 8787), 'public');
  assert.equal(parseServe('https://x.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:87870\n', 8787), 'none');
  assert.equal(parseServe('https://a.ts.net (tailnet only)\n|-- / proxy http://127.0.0.1:3000\n\nhttps://b.ts.net:8443 (Funnel on)\n|-- / proxy http://127.0.0.1:8787\n', 8787), 'public');

  const line = (r) => lineFor('tailscale-serve', { tailscaleServe: async () => r });
  const good = await line({ code: 0, stdout: SERVE_OK });
  assert.equal(good.level, 'OK');
  assert.ok(!JSON.stringify(good).includes(TAILNET));
  assert.equal((await line({ code: 0, stdout: 'No serve config\n' })).state, 'not-serving');
  const open = await line({ code: 0, stdout: `https://mini.${TAILNET}.ts.net (Funnel on)\n|-- / proxy http://127.0.0.1:8787\n` });
  assert.equal(open.state, 'public');
  assert.ok(!JSON.stringify(open).includes(TAILNET));
  assert.equal((await line({ code: 1, stdout: SERVE_OK })).state, 'not-serving');
  assert.equal((await line({ code: null, stdout: '', missing: true })).state, 'missing');
});

test('disk: plenty, getting low, and low enough that someone must act', async () => {
  const line = (freeBytes) => lineFor('disk', { disk: async () => ({ freeBytes, totalBytes: 500e9 }) });
  assert.equal((await line(21e9)).level, 'OK');
  assert.equal((await line(19e9)).level, 'WARN');
  assert.equal((await line(4e9)).level, 'FAIL');
  assert.match((await line(4e9)).detail, /4\.0 GB free of 500\.0 GB/);
});

test('backup: not installed yet is said plainly and is no failure; installed with no status is', async () => {
  const notInstalled = { installed: false, known: true, loaded: false };
  const service = (s) => async () => s;
  const fresh = await lineFor('backup', { service: service(notInstalled), backupStatus: () => null });
  assert.equal(fresh.level, 'WARN');
  assert.equal(fresh.state, 'not-installed');
  assert.match(fresh.detail, /not installed yet.*service\/backup-service\.sh install/);

  const removed = await lineFor('backup', { service: service(notInstalled), backupStatus: () => ({ finished_at: iso(T0 - 9 * DAY), databases: {} }) });
  assert.equal(removed.level, 'WARN');
  assert.match(removed.detail, /last recorded run was 9d ago/);

  const silent = await lineFor('backup', { service: service(asleep), backupStatus: () => null });
  assert.equal(silent.level, 'FAIL');
  assert.equal(silent.state, 'no-status');

  const unloaded = await lineFor('backup', { service: service({ installed: true, known: true, loaded: false }) });
  assert.equal(unloaded.state, 'not-loaded');
});

test('backup: uses readStatus and statusProblems: old, failed, unreadable', async () => {
  const line = (status) => lineFor('backup', { backupStatus: () => status });
  assert.equal((await line({ finished_at: iso(T0 - HOUR), databases: { reviewer: { ok: true } } })).level, 'OK');
  const old = await line({ finished_at: iso(T0 - 27 * HOUR), databases: { reviewer: { ok: true } } });
  assert.equal(old.level, 'FAIL');
  assert.match(old.detail, /more than 26 hours old/);
  const failed = await line({ finished_at: iso(T0 - HOUR), databases: { coordinator: { ok: false, error: 'integrity check failed' }, reviewer: { ok: false, error: 'database file is missing' } } });
  assert.equal(failed.level, 'FAIL');
  assert.match(failed.detail, /coordinator: integrity check failed \(and 1 more\)/);
  assert.equal((await line({ error: 'the status file could not be read' })).level, 'FAIL');
  assert.equal((await line({ finished_at: iso(T0 - HOUR), databases: { reviewer: null } })).state, 'check-broke', 'a status of the wrong shape is a line, not a crash');
});

test('review queue: counts, and a wait is judged only when nothing explains it', async () => {
  const line = (over, more) => lineFor('review-queue', { queue: queueWith(over), ...more });
  const ok = await line({});
  assert.equal(ok.level, 'OK');
  assert.match(ok.detail, /1 queued \(1 due\), 0 running, 0 failed, 0 result\(s\) undelivered/);
  assert.equal((await line({ oldest_due_ms: 3 * HOUR })).level, 'WARN');
  assert.equal((await line({ oldest_due_ms: 7 * HOUR })).level, 'FAIL');
  const stopped = await line({ oldest_due_ms: 7 * HOUR }, { stop: () => ({ stopped: true, reason: 'x', since: iso(T0 - 7 * HOUR) }) });
  assert.equal(stopped.level, 'OK', 'the stop has its own line');
  assert.match(stopped.detail, /waiting on the stop/);
  assert.equal((await line({ oldest_due_ms: 7 * HOUR, pause: { kind: 'limit', until: T0 + HOUR } })).level, 'OK');
  const gaveUp = await line({ failed_last_day: 2 });
  assert.equal(gaveUp.level, 'WARN');
  assert.match(gaveUp.detail, /2 gave up/);
});

test('review queue: a missing, locked, broken or stuck database is a line', async () => {
  const line = (r) => lineFor('review-queue', { queue: async () => r });
  assert.equal((await line({ error: 'missing' })).state, 'missing');
  assert.equal((await line({ error: 'no-tables' })).state, 'no-tables');
  const locked = await line({ error: 'locked', why: 'database is locked' });
  assert.equal(locked.level, 'WARN', 'it passes, and nobody needs to act');
  assert.equal((await line({ error: 'unreadable', why: 'file is not a database' })).level, 'FAIL');
  assert.equal((await line({ timedOut: true })).state, 'stuck');
  for (const r of [{ error: 'missing' }, { timedOut: true }]) assert.equal((await lineFor('review-pause', { queue: async () => r })).state, 'unknown');
});

test('review pause: a usage limit lifts by itself so it is a WARN; a sign-in failure waits for someone so it is a FAIL', async () => {
  const line = (over) => lineFor('review-pause', { queue: queueWith(over) });
  assert.equal((await line({})).level, 'OK');
  const limit = await line({ pause: { kind: 'limit', until: T0 + HOUR } });
  assert.equal(limit.level, 'WARN');
  assert.ok(limit.detail.includes(iso(T0 + HOUR)));
  assert.equal((await line({ pause: { kind: 'auth', until: null } })).level, 'FAIL');
  assert.equal((await line({ pause_known: false })).state, 'no-table');
});

test('health-job: in the report, whether the job is keeping up; in the job, only the gap since the run before', async () => {
  const notInstalled = async () => ({ installed: false, known: true, loaded: false });
  const report1 = (over) => lineFor('health-job', over);
  const atAge = (ms) => () => ({ at: iso(T0 - ms), lines: [] });
  assert.equal((await report1({ lastStatus: atAge(10 * MINUTE) })).level, 'OK');
  const dead = await report1({ lastStatus: atAge(OVERDUE_MS + MINUTE) });
  assert.equal(dead.level, 'FAIL');
  assert.equal(dead.state, 'overdue');
  assert.equal((await report1({ lastStatus: () => null })).state, 'no-status');
  assert.equal((await report1({ lastStatus: () => ({ unreadable: true }) })).state, 'unreadable');
  assert.equal((await report1({ service: notInstalled, lastStatus: () => null })).level, 'WARN');
  assert.equal((await report1({ service: async () => ({ installed: true, known: true, loaded: false }) })).state, 'not-loaded');

  const job = (over) => lineFor('health-job', over, { job: true });
  assert.equal((await job({ lastStatus: () => null })).state, 'first-run');
  assert.equal((await job({ lastStatus: atAge(10 * MINUTE) })).level, 'OK');
  const gap = await job({ lastStatus: atAge(8 * HOUR) });
  assert.equal(gap.level, 'WARN', 'a run that is happening proves the job is alive');
  assert.match(gap.detail, /8h ago/);
  assert.equal((await job({ lastStatus: () => ({ unreadable: true }) })).level, 'WARN');
});

test('logs: the report looks and the job rotates; a problem with either is a line', async () => {
  const scan = (fields) => async () => ({ folder: 'ok', files: 3, largest: 12e6, over: ['a'], skipped: 0, temps: [], ...fields });
  const rotated = (fields) => async () => ({ folder: 'ok', files: 3, largest: 12e6, skipped: 0, rotated: ['a'], failed: [], ...fields });
  const called = { n: 0 };
  const look = await lineFor('logs', { scanLogs: scan({}), rotateLogs: async () => { called.n += 1; return rotated({})(); } });
  assert.match(look.detail, /3 log\(s\), largest 12\.0 MB, 1 over the limit/);
  assert.equal(called.n, 0, 'the report never rotates');
  assert.match((await lineFor('logs', { rotateLogs: rotated({}) }, { job: true })).detail, /1 rotated/);
  assert.equal((await lineFor('logs', { rotateLogs: rotated({ failed: ['EACCES'] }) }, { job: true })).level, 'FAIL');
  assert.equal((await lineFor('logs', { rotateLogs: rotated({ skipped: 1 }) }, { job: true })).level, 'WARN');
  assert.equal((await lineFor('logs', { scanLogs: scan({ folder: 'missing' }) })).level, 'OK');
  assert.equal((await lineFor('logs', { scanLogs: scan({ folder: 'not-a-folder' }) })).level, 'FAIL');
});

// --- never hanging, never ending the report -------------------------------------------------------------------------------

test('a probe that throws or never answers becomes a FAIL line, and every other line still comes back', async () => {
  const started = Date.now();
  const { lines, by } = await report({
    docker: () => { throw Object.assign(new Error(SECRET), { code: 'EIO' }); },
    disk: async () => { throw new TypeError(SECRET); },
    tailscaleServe: () => new Promise(() => {}),
  }, { timeoutMs: 100 });
  assert.ok(Date.now() - started < 5000);
  assert.equal(lines.length, NAMES.length);
  assert.equal(by.docker.state, 'check-broke');
  assert.match(by.docker.detail, /EIO/);
  assert.match(by.disk.detail, /TypeError/);
  assert.equal(by['tailscale-serve'].state, 'timed-out');
  assert.equal(by.reviewer.level, 'OK');
  assert.ok(!JSON.stringify(lines).includes(SECRET), 'an error message could hold anything, so none is ever repeated');
});

test('runTool answers by its deadline: not found, a failure, stuck, a child holding the pipe, too much output', { ...posixOnly, timeout: 30_000 }, async (t) => {
  const dir = tempDir(t);
  const script = (name, body) => {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  assert.equal((await runTool(join(dir, 'nothing'), [])).missing, true);
  const failing = await runTool(script('failing', 'echo out; echo err >&2; exit 3'), []);
  assert.equal(failing.code, 3);
  assert.equal(failing.stdout, 'out\n');

  let started = Date.now();
  const stuck = await runTool(script('stuck', 'exec /bin/sleep 30'), [], { timeoutMs: 150 });
  assert.equal(stuck.timedOut, true);
  assert.ok(Date.now() - started < 5000);

  started = Date.now();
  const holding = await runTool(script('holding', '/bin/sleep 5 &\nwait'), [], { timeoutMs: 150 });
  assert.equal(holding.timedOut, true);
  assert.ok(Date.now() - started < 3000, 'a grandchild still holding the pipe does not keep the answer waiting');

  const flood = await runTool(script('flood', 'exec yes'), [], { timeoutMs: 10_000, maxBytes: 10_000 });
  assert.equal(flood.overflow, true);
  assert.equal(flood.stdout, '');

  const notExecutable = join(dir, 'plain');
  writeFileSync(notExecutable, 'x');
  assert.ok((await runTool(notExecutable, [])).failed);
});

test('the hard deadline ends a run stuck in a synchronous call, which no timer can do', { ...posixOnly, timeout: 30_000 }, async () => {
  const source = `
    import { hardDeadline } from ${JSON.stringify(join(REPO, 'ops', 'health.js'))};
    hardDeadline(200);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
    console.log('never');
  `;
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
  assert.equal(r.signal, 'SIGKILL');
  assert.ok(Date.now() - started < 10_000);
  assert.ok(!r.stdout.includes('never'));
});

test('launchctl output: only the state, pid and exit code are kept', () => {
  const printed = `gui/501/ai.adabra.x = {\n\tstate = running\n\tenvironment = {\n\t\tSOME_KEY => ${SECRET}\n\t}\n\tpid = 42\n\tstate = waiting\n\tlast exit code = 0\n}\n`;
  const s = parseLaunchctl({ code: 0, stdout: printed });
  assert.deepEqual(s, { known: true, loaded: true, state: 'running', pid: '42', lastExit: '0' });
  assert.deepEqual(parseLaunchctl({ code: 113, stdout: '' }), { known: true, loaded: false });
  assert.equal(parseLaunchctl({ code: null, stdout: '', missing: true }).known, false);
  assert.match(parseLaunchctl({ code: null, stdout: '', timedOut: true }).why, /no answer/);
});

test('ageText reads as a person would say it', () => {
  assert.equal(ageText(5000), '5s');
  assert.equal(ageText(20 * MINUTE), '20m');
  assert.equal(ageText(5 * HOUR), '5h');
  assert.equal(ageText(3 * DAY), '3d');
  assert.equal(ageText(-5000), '0s');
});

// --- the real probes, with fake tools ------------------------------------------------------------------------------------

function fakeBin(t, tools = {}) {
  const dir = tempDir(t);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const calls = join(dir, 'calls');
  const add = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(calls)}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const defaults = {
    launchctl: `printf '%s\\n' 'state = running' 'pid = 42' 'last exit code = 0' '  SOME_ENV => ${SECRET}'`,
    docker: `echo 28.0.0; echo "${SECRET}" >&2`,
    defaults: 'echo 0',
    osascript: 'exit 0',
    tailscale: `case "$1" in
  status) printf '%s' '{"BackendState":"Running","Self":{"KeyExpiry":"2099-01-01T00:00:00Z","HostName":"${SECRET}"},"CurrentTailnet":{"Name":"${TAILNET}"}}' ;;
  serve) printf '%s\\n' 'https://mini.${TAILNET}.ts.net (tailnet only)' "|-- / proxy http://127.0.0.1:$COORDINATOR_PORT" ;;
esac`,
  };
  for (const [name, body] of Object.entries({ ...defaults, ...tools })) {
    if (body !== null) add(name, body);
  }
  return { dir, bin, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : ''), tailscale: tools.tailscale === null ? join(bin, 'no-such-tailscale') : join(bin, 'tailscale') };
}

test('real probes: with no launchctl, docker or Tailscale at all, every line is clear and nothing throws', { ...posixOnly, timeout: 30_000 }, async (t) => {
  const f = fakeBin(t, { launchctl: null, docker: null, defaults: null, tailscale: null, osascript: null });
  const home = join(f.dir, 'home');
  mkdirSync(home);
  const env = {
    PATH: f.bin, HOME: home, ADABRA_TAILSCALE: f.tailscale, ADABRA_STOP_FILE: join(home, 'stop.json'), REVIEW_DB: join(home, 'none.db'),
    ADABRA_BACKUP_STATUS: join(home, 'none.json'), TEAM_AGENT_HOME: join(home, 'agent'), ADABRA_LOG_DIR: join(home, 'logs'), ADABRA_HEALTH_STATUS: join(home, 'status.json'),
    COORDINATOR_PORT: '1',
  };
  const result = await runChecks(buildChecks(realProbes({ env, home }), { nowMs: T0 }));
  const seen = Object.fromEntries(result.map((l) => [l.check, l]));
  assert.equal(result.length, NAMES.length);
  assert.equal(seen.docker.state, 'missing');
  assert.match(seen.docker.detail, /docker was not found/);
  assert.match(seen.reviewer.detail, /launchctl was not found/);
  assert.equal(seen.tailscale.state, 'missing');
  assert.equal(seen['tailscale-serve'].state, 'missing');
  assert.equal(seen['tailscale-login'].state, 'unknown');
  assert.equal(seen['review-queue'].state, 'missing');
  assert.equal(seen.backup.state, 'not-installed');
  assert.equal(seen.logs.state, 'no-folder');
  assert.equal(seen.coordinator.state, 'no-answer');
  assert.ok(!existsSync(env.REVIEW_DB), 'looking must never create a database');
  assert.ok(result.every((l) => l.state !== 'check-broke'), 'each one had something clear to say');
});

test('real probes: nothing a tool prints reaches a line, and the only calls are the read-only ones', { ...posixOnly, timeout: 30_000 }, async (t) => {
  const f = fakeBin(t);
  const home = join(f.dir, 'home');
  mkdirSync(home);
  const env = { PATH: f.bin, HOME: home, ADABRA_TAILSCALE: f.tailscale, ADABRA_STOP_FILE: join(home, 'stop.json'), REVIEW_DB: join(home, 'none.db'), ADABRA_BACKUP_STATUS: join(home, 'none.json'), TEAM_AGENT_HOME: join(home, 'agent'), ADABRA_LOG_DIR: join(home, 'logs'), ADABRA_HEALTH_STATUS: join(home, 'status.json'), COORDINATOR_PORT: '1' };
  const result = await runChecks(buildChecks(realProbes({ env, home, uid: 501 }), { nowMs: T0 }));
  const seen = Object.fromEntries(result.map((l) => [l.check, l]));
  assert.equal(seen.docker.level, 'OK');
  assert.equal(seen.reviewer.level, 'OK');
  assert.equal(seen.tailscale.level, 'OK');
  assert.equal(seen['tailscale-serve'].level, 'OK');
  assert.equal(seen['tailscale-login'].level, 'WARN');
  const text = JSON.stringify(result);
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes(TAILNET));
  const allowed = [
    /^launchctl print gui\/501\/ai\.adabra\.[a-z]+$/, /^docker info --format \{\{\.ServerVersion\}\}$/, /^tailscale status --json$/, /^tailscale serve status$/,
    /^defaults read io\.tailscale\.ipn\.macsys TailscaleStartOnLogin$/,
  ];
  for (const call of f.calls().trim().split('\n')) assert.ok(allowed.some((re) => re.test(call)), `unexpected call: ${call}`);
});

test('real probes: a stuck docker and a stuck tailscale become FAIL lines', { ...posixOnly, timeout: 30_000 }, async (t) => {
  const f = fakeBin(t, { docker: 'exec /bin/sleep 30', tailscale: 'exec /bin/sleep 30' });
  const home = join(f.dir, 'home');
  mkdirSync(home);
  const env = { PATH: f.bin, HOME: home, ADABRA_TAILSCALE: f.tailscale, ADABRA_STOP_FILE: join(home, 'stop.json'), REVIEW_DB: join(home, 'none.db'), ADABRA_BACKUP_STATUS: join(home, 'none.json'), TEAM_AGENT_HOME: join(home, 'agent'), ADABRA_LOG_DIR: join(home, 'logs'), ADABRA_HEALTH_STATUS: join(home, 'status.json'), COORDINATOR_PORT: '1' };
  const tool = (file, args, o) => runTool(file, args, { ...o, timeoutMs: 200 });
  const started = Date.now();
  const result = await runChecks(buildChecks(realProbes({ env, home, tool }), { nowMs: T0 }));
  assert.ok(Date.now() - started < 10_000);
  const seen = Object.fromEntries(result.map((l) => [l.check, l]));
  assert.equal(seen.docker.state, 'stuck');
  assert.equal(seen.tailscale.state, 'stuck');
  assert.equal(seen['tailscale-serve'].state, 'stuck');
});

test('real probes: /healthz, on a local server: healthy, stopped, not healthy, not JSON', async (t) => {
  let answer = { status: 200, body: '{"ok":true}' };
  const server = createServer((req, res) => {
    assert.equal(req.url, '/healthz');
    res.writeHead(answer.status);
    res.end(answer.body);
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const probes = realProbes({ env: { COORDINATOR_PORT: String(server.address().port), PATH: '/nonexistent' }, home: tmpdir() });
  assert.deepEqual(await probes.healthz(), { answered: true, ok: true, stopped: false });
  answer = { status: 200, body: '{"ok":true,"stopped":true}' };
  assert.deepEqual(await probes.healthz(), { answered: true, ok: true, stopped: true });
  answer = { status: 500, body: '{"ok":false}' };
  assert.deepEqual(await probes.healthz(), { answered: true, ok: false, stopped: false });
  answer = { status: 200, body: 'hello' };
  assert.deepEqual(await probes.healthz(), { answered: true, ok: false, stopped: false });
});

test('real probes: the helper status holds counts and a time, and a broken file says so', (t) => {
  const dir = tempDir(t);
  const probes = realProbes({ env: { TEAM_AGENT_HOME: dir, PATH: '/nonexistent' }, home: dir });
  assert.equal(probes.helperStatus(), null);
  writeFileSync(join(dir, 'agent-status.json'), JSON.stringify({ at: iso(T0), held: ['TASK-1', SECRET], outbox: { pending: 3 }, last: { secret: SECRET } }));
  assert.deepEqual(probes.helperStatus(), { at: T0, held: 2, pending: 3 });
  writeFileSync(join(dir, 'agent-status.json'), 'not json');
  assert.deepEqual(probes.helperStatus(), { unreadable: true });
  writeFileSync(join(dir, 'agent-status.json'), '{"at":"never"}');
  assert.deepEqual(probes.helperStatus(), { unreadable: true });
});

test('real probes: a stuck database reader becomes a line, and so does a reader that printed nothing', async (t) => {
  const dir = tempDir(t);
  const env = { PATH: '/nonexistent', REVIEW_DB: join(dir, 'x.db') };
  const withTool = (r) => realProbes({ env, home: dir, tool: async () => r });
  assert.deepEqual(await withTool({ code: null, timedOut: true, stdout: '' }).queue(), { timedOut: true });
  assert.equal((await withTool({ code: 1, stdout: '' }).queue()).error, 'unreadable');
  const line = await lineFor('review-queue', { queue: withTool({ code: null, timedOut: true, stdout: '' }).queue });
  assert.equal(line.level, 'FAIL');
});

// --- reading reviewer.db ------------------------------------------------------------------------------------------------

function seededDb(t) {
  const dir = tempDir(t);
  const path = join(dir, 'reviewer.db');
  const store = new ReviewStore(path);
  t.after(() => {
    try {
      store.close();
    } catch {
      // closed by the test
    }
  });
  return { dir, path, store };
}

test('queue: counts and state from a real database, and not a word of what is in it', (t) => {
  const { path, store } = seededDb(t);
  const sha = (c) => c.repeat(40);
  store.enqueue(1, sha('a'), { branch: SECRET, title: SECRET }, T0 - 3 * HOUR);
  store.enqueue(2, sha('b'), { branch: 'x', title: SECRET }, T0 - HOUR);
  store.enqueue(3, sha('c'), { title: SECRET }, T0 - MINUTE);
  store.markRunning(3, sha('c'));
  store.enqueue(4, sha('d'), { title: SECRET }, T0 - 2 * DAY);
  store.markDone(4, sha('d'), { tests: SECRET, review: SECRET });
  store.enqueue(5, sha('e'), { title: SECRET }, T0 - HOUR);
  store.db.prepare("UPDATE jobs SET state = 'failed', last_error = ? WHERE pr = 5").run(SECRET);
  store.enqueue(6, sha('f'), { title: SECRET }, T0 - 5 * DAY);
  store.db.prepare("UPDATE jobs SET state = 'failed', last_error = ? WHERE pr = 6").run(SECRET);
  store.holdJob(2, sha('b'), SECRET, T0 + HOUR);
  store.db.prepare("INSERT INTO task_results (result_id, task_id, pr, sha, payload, status, created_at) VALUES ('r', 'TASK-1', 1, 'a', ?, 'pending', 1)").run(SECRET);
  const q = readQueueState(path, { now: T0 });
  assert.deepEqual(q.jobs, { queued: 2, running: 1, done: 1, superseded: 0, failed: 2 });
  assert.equal(q.due, 1, 'the job on hold is queued but not due');
  assert.equal(q.oldest_due_ms, 3 * HOUR);
  assert.equal(q.failed_last_day, 1);
  assert.deepEqual(q.task_results, { pending: 1, acked: 0, rejected: 0 });
  assert.equal(q.pause, null);
  assert.ok(!JSON.stringify(q).includes(SECRET));
});

test('queue: an unexpected state word is counted, not repeated', (t) => {
  const { path, store } = seededDb(t);
  store.enqueue(1, 'a'.repeat(40), {}, T0);
  store.db.prepare('UPDATE jobs SET state = ?').run(SECRET);
  const q = readQueueState(path, { now: T0 });
  assert.equal(q.jobs.other, 1);
  assert.ok(!JSON.stringify(q).includes(SECRET));
});

test('queue: the pause reads the same as the store says, in every state', (t) => {
  const { path, store } = seededDb(t);
  const same = (now) => {
    const q = readQueueState(path, { now });
    assert.deepEqual(q.pause, store.reviewPause(now));
    return q.pause;
  };
  assert.equal(same(T0), null);
  const until = store.pauseForLimit(T0);
  assert.equal(same(T0).kind, 'limit');
  assert.equal(same(until - 1).until, until);
  assert.equal(same(until + 1), null, 'an expired limit lets a job through');
  store.pauseForLimit(T0, T0 + 5000);
  assert.equal(same(T0).until, T0 + 5000);
  store.pauseForAuth();
  assert.deepEqual(same(T0), { kind: 'auth', until: null });
  store.clearPause();
  assert.equal(same(T0), null);
  store.addStrike();
  assert.equal(same(T0), null, 'strikes alone are no pause');
});

test('queue: the connection really is read-only, and a read leaves the database and schema as they were', (t) => {
  const { path, store } = seededDb(t);
  store.enqueue(1, 'a'.repeat(40), {}, T0);
  store.close();
  const db = openQueueDb(path);
  try {
    for (const sql of ["UPDATE jobs SET state = 'x'", 'CREATE TABLE evil (x)', 'DROP TABLE jobs', 'DELETE FROM jobs', 'PRAGMA user_version = 9']) {
      assert.throws(() => db.exec(sql), /readonly/i, sql);
    }
  } finally {
    db.close();
  }
  const before = readFileSync(path);
  const schema = () => {
    const d = new DatabaseSync(path, { readOnly: true });
    try {
      return d.prepare('SELECT name, sql FROM sqlite_master ORDER BY name').all();
    } finally {
      d.close();
    }
  };
  const schemaBefore = schema();
  readQueueState(path, { now: T0 });
  assert.ok(readFileSync(path).equals(before), 'not a byte of the database changed');
  assert.deepEqual(schema(), schemaBefore);
});

test('queue: never built on the store, whose constructor would run CREATE TABLE', () => {
  for (const file of ['health-queue.js', 'health.js']) {
    const source = readFileSync(join(REPO, 'ops', file), 'utf8');
    assert.ok(!source.includes('ReviewStore('), file);
    assert.ok(!/from '.*reviewer\/store/.test(source), file);
  }
  const queue = readFileSync(join(REPO, 'ops', 'health-queue.js'), 'utf8');
  assert.match(queue, /readOnly: true/);
  for (const column of ['meta', 'result,', 'payload', 'last_error']) assert.ok(!new RegExp(`SELECT[^"\`']*\\b${column}`).test(queue), column);
});

test('queue: a missing file is a line and is not created; a file that is not a database, or has no queue, is a line', (t) => {
  const dir = tempDir(t);
  const none = join(dir, 'none.db');
  assert.deepEqual(readQueueState(none), { error: 'missing' });
  assert.ok(!existsSync(none));

  const junk = join(dir, 'junk.db');
  writeFileSync(junk, `${SECRET} this is not a database, not at all ${'x'.repeat(5000)}`);
  const r = readQueueState(junk);
  assert.equal(r.error, 'unreadable');
  assert.ok(!JSON.stringify(r).includes(SECRET));

  const other = join(dir, 'other.db');
  const d = new DatabaseSync(other);
  d.exec('CREATE TABLE something (x)');
  d.close();
  assert.deepEqual(readQueueState(other), { error: 'no-tables' });
});

test('queue: a database from before the pause or task results tables still reads', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'old.db');
  const d = new DatabaseSync(path);
  d.exec("CREATE TABLE jobs (pr INTEGER, sha TEXT, meta TEXT, state TEXT, attempts INTEGER, next_attempt_at INTEGER, result TEXT, last_error TEXT, created_at INTEGER); INSERT INTO jobs VALUES (1, 'a', '{}', 'queued', 0, 0, NULL, NULL, 5)");
  d.close();
  const q = readQueueState(path, { now: T0 });
  assert.equal(q.jobs.queued, 1);
  assert.equal(q.pause_known, false);
  assert.equal(q.pause, null);
  assert.equal(q.task_results, null);
});

test('queue: a locked database is a line within the short timeout, and the holder is not disturbed', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'locked.db');
  const holder = new DatabaseSync(path);
  holder.exec('PRAGMA journal_mode = DELETE; CREATE TABLE jobs (state TEXT, next_attempt_at INTEGER, created_at INTEGER); BEGIN EXCLUSIVE; INSERT INTO jobs VALUES (\'queued\', 0, 0)');
  t.after(() => holder.close());
  const started = Date.now();
  const r = readQueueState(path, { timeoutMs: 100 });
  assert.equal(r.error, 'locked');
  assert.match(r.why, /locked/);
  assert.ok(Date.now() - started < 3000);
  holder.exec('COMMIT');
  assert.equal(readQueueState(path, { timeoutMs: 100 }).jobs.queued, 1);
});

test('queue: reads while the reviewer holds a write open on the live WAL database, and does not get in its way', (t) => {
  const { path, store } = seededDb(t);
  store.enqueue(1, 'a'.repeat(40), {}, T0);
  store.db.exec('BEGIN IMMEDIATE');
  store.db.prepare("UPDATE jobs SET state = 'running'").run();
  const during = readQueueState(path, { now: T0, timeoutMs: 100 });
  assert.equal(during.jobs.queued, 1, 'sees the last committed state');
  store.db.exec('COMMIT');
  assert.equal(readQueueState(path, { now: T0 }).jobs.running, 1);
});

test('queue: as the separate process the report starts: one line of JSON', { timeout: 30_000 }, (t) => {
  const { path, store } = seededDb(t);
  store.enqueue(1, 'a'.repeat(40), { title: SECRET }, T0);
  const r = spawnSync(process.execPath, [QUEUE_SCRIPT, path], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).jobs.queued, 1);
  assert.ok(!r.stdout.includes(SECRET));
  const none = spawnSync(process.execPath, [QUEUE_SCRIPT, join(dirname(path), 'none.db')], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(none.stdout), { error: 'missing' });
});

// --- notifications ----------------------------------------------------------------------------------------------------

const failing = (check = 'docker', state = 'down', detail = 'the Docker daemon is not answering') => ({ check, level: 'FAIL', state, detail });
const fine = (check = 'docker') => ({ check, level: 'OK', state: 'running', detail: 'fine' });

test('notifications: once when it first fails, not again while it stays the same, once more when it clears', () => {
  const first = planNotifications({}, [failing()], T0);
  assert.equal(first.due, true);
  assert.equal(first.title, 'Adabra health: 1 failing');
  assert.match(first.message, /^docker: the Docker daemon is not answering/);
  assert.equal(first.shown.docker.notified_at, iso(T0));

  const second = planNotifications(first.shown, [failing()], T0 + JOB_EVERY_MS);
  assert.equal(second.due, false);
  assert.deepEqual(second.shown, first.shown, 'when it was first told stays as it was');

  const cleared = planNotifications(second.shown, [fine()], T0 + 2 * JOB_EVERY_MS);
  assert.equal(cleared.due, true);
  assert.equal(cleared.title, 'Adabra health: recovered');
  assert.match(cleared.message, /recovered: docker/);
  assert.deepEqual(cleared.shown, {});

  assert.equal(planNotifications(cleared.shown, [fine()], T0 + 3 * JOB_EVERY_MS).due, false);
});

test('notifications: a change of state or level is news; a changing number in the words is not', () => {
  const first = planNotifications({}, [failing('helper', 'stale', 'last pass 5m ago')], T0).shown;
  assert.equal(planNotifications(first, [failing('helper', 'stale', 'last pass 20m ago')], T0 + JOB_EVERY_MS).due, false);
  const changed = planNotifications(first, [failing('helper', 'not-running', 'crashed')], T0 + JOB_EVERY_MS);
  assert.equal(changed.due, true);
  assert.match(changed.message, /crashed/);
  assert.equal(changed.shown.helper.since, first.helper.since, 'it has been failing since the first time');
});

test('notifications: a FAIL that lasts is raised again once a day, not more', () => {
  const first = planNotifications({}, [failing()], T0).shown;
  assert.equal(planNotifications(first, [failing()], T0 + FAIL_AGAIN_MS - 1).due, false);
  const later = planNotifications(first, [failing()], T0 + FAIL_AGAIN_MS);
  assert.equal(later.due, true);
  assert.match(later.message, /^still: docker/);
  assert.equal(later.shown.docker.notified_at, iso(T0 + FAIL_AGAIN_MS));
  assert.equal(planNotifications(later.shown, [failing()], T0 + FAIL_AGAIN_MS + HOUR).due, false);
});

test('notifications: an ordinary WARN never notifies; one that asks for a reminder does, and only once a week', () => {
  const warn = { check: 'disk', level: 'WARN', state: 'low', detail: 'getting low' };
  const plain = planNotifications({}, [warn], T0);
  assert.equal(plain.due, false);
  assert.deepEqual(plain.shown, {});

  const key = { check: 'tailscale-key', level: 'WARN', state: 'expiring', detail: 'expires soon', remind: true };
  const first = planNotifications({}, [key], T0);
  assert.equal(first.due, true);
  assert.equal(first.title, 'Adabra health: please look');
  assert.equal(planNotifications(first.shown, [key], T0 + DAY).due, false);
  assert.equal(planNotifications(first.shown, [key], T0 + REMIND_AGAIN_MS).due, true);
  assert.equal(planNotifications(first.shown, [{ ...key, level: 'OK', state: 'valid', remind: undefined }], T0 + DAY).title, 'Adabra health: recovered');
  assert.equal(planNotifications(first.shown, [{ check: 'tailscale-key', level: 'FAIL', state: 'expired', detail: 'expired' }], T0 + DAY).due, true, 'WARN to FAIL is news');
});

test('notifications: what could not be shown stays due, for a new failure, a repeat and a recovery', () => {
  const first = planNotifications({}, [failing()], T0);
  assert.equal(first.unshown.docker.notified_at, null);
  const retry = planNotifications(first.unshown, [failing()], T0 + JOB_EVERY_MS);
  assert.equal(retry.due, true);

  const told = planNotifications({}, [failing()], T0).shown;
  const repeat = planNotifications(told, [failing()], T0 + FAIL_AGAIN_MS);
  assert.equal(repeat.unshown.docker.notified_at, iso(T0));
  assert.equal(planNotifications(repeat.unshown, [failing()], T0 + FAIL_AGAIN_MS + JOB_EVERY_MS).due, true);

  const recovery = planNotifications(told, [fine()], T0 + HOUR);
  assert.deepEqual(recovery.unshown.docker, told.docker);
  assert.equal(planNotifications(recovery.unshown, [fine()], T0 + 2 * HOUR).due, true);
  assert.equal(planNotifications(recovery.shown, [fine()], T0 + 2 * HOUR).due, false);
});

test('notifications: many at once are one message; junk in the memory only costs a repeat', () => {
  const many = planNotifications({}, [failing('docker'), failing('reviewer', 'not-running'), fine('disk')], T0);
  assert.equal(many.title, 'Adabra health: 2 failing');
  assert.equal(many.message, 'docker, reviewer');
  const both = planNotifications({ disk: { level: 'FAIL', state: 'x', notified_at: iso(T0) } }, [failing('docker'), fine('disk')], T0);
  assert.equal(both.message, 'docker: the Docker daemon is not answering. recovered: disk');
  for (const junk of [null, 42, 'x', []]) assert.equal(planNotifications(junk, [failing()], T0).due, true);
  assert.equal(planNotifications({ docker: { level: 'FAIL', state: 'down', notified_at: 'whenever' } }, [failing()], T0).due, true);
  assert.equal(planNotifications({ __proto__: null, toString: 'x' }, [failing('toString')], T0).due, true);
  assert.ok(planNotifications({}, [failing('docker', 'down', 'x'.repeat(500))], T0).message.length <= 240);
});

test('notifying: the helper\'s own display notification, bounded, and never System Events; no notifier off macOS and Windows', { ...posixOnly, timeout: 30_000 }, async (t) => {
  const f = fakeBin(t);
  assert.equal(await realNotify({ platform: 'darwin', env: { PATH: f.bin } })('Title "x"', 'Message; quit app "y"'), true);
  const call = f.calls();
  assert.match(call, /display notification/);
  assert.ok(!/System Events/i.test(call));
  assert.ok(call.includes('Title "x" Message; quit app "y"'), 'title and message go as arguments, never as script text');
  assert.equal(await realNotify({ platform: 'linux', env: { PATH: f.bin } })('t', 'm'), false);

  const down = fakeBin(t, { osascript: 'exit 1' });
  assert.equal(await realNotify({ platform: 'darwin', env: { PATH: down.bin } })('t', 'm'), false);
  const none = fakeBin(t, { osascript: null });
  assert.equal(await realNotify({ platform: 'darwin', env: { PATH: none.bin } })('t', 'm'), false);
  const stuck = fakeBin(t, { osascript: 'exec /bin/sleep 30' });
  const started = Date.now();
  const tool = (file, args, o) => runTool(file, args, { ...o, timeoutMs: 200 });
  assert.equal(await realNotify({ platform: 'darwin', env: { PATH: stuck.bin }, tool })('t', 'm'), false);
  assert.ok(Date.now() - started < 5000);
});

test('no osascript in this code except the helper\'s, and no System Events anywhere', () => {
  for (const file of ['ops/health.js', 'ops/health-queue.js', 'ops/rotate-logs.js', 'service/health-service.sh']) {
    const source = readFileSync(join(REPO, file), 'utf8');
    assert.ok(!source.includes('osascript'), file);
    assert.ok(!/tell application "System Events"/i.test(source), file);
  }
});

// --- the job, end to end with fake probes --------------------------------------------------------------------------------

function jobWorld(t) {
  const dir = tempDir(t);
  const statusFile = join(dir, 'control', 'health-status.json');
  const told = [];
  const said = [];
  const run = (over = {}, { now = T0, args = ['--job'], notify = async (title, message) => (told.push({ title, message }), true) } = {}) => {
    said.length = 0;
    const lastStatus = () => readLastStatus(statusFile);
    const helperStatus = () => ({ at: now - 5000, held: 0, pending: 0 });
    return healthCommand({
      args, env: { ADABRA_HEALTH_STATUS: statusFile }, home: dir, now: () => now, out: (m) => said.push(m), deadlineMs: 0, notify, probes: healthy({ lastStatus, helperStatus, ...over }),
    });
  };
  return { dir, statusFile, told, said, run, status: () => JSON.parse(readFileSync(statusFile, 'utf8')) };
}
const dockerDown = { docker: async () => ({ code: 1, stdout: '' }) };

test('the job: a whole sequence through the status file alone, as one process per run: fail, quiet, daily, recover, quiet', async (t) => {
  const w = jobWorld(t);
  assert.equal(await w.run(dockerDown, { now: T0 }), EXIT_FAILED);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].message, /docker/);
  assert.equal(await w.run(dockerDown, { now: T0 + JOB_EVERY_MS }), EXIT_FAILED);
  assert.equal(w.told.length, 1, 'no nagging');
  await w.run(dockerDown, { now: T0 + FAIL_AGAIN_MS });
  assert.equal(w.told.length, 2, 'raised again a day later');
  assert.equal(await w.run({}, { now: T0 + FAIL_AGAIN_MS + JOB_EVERY_MS }), 0);
  assert.equal(w.told.length, 3);
  assert.match(w.told[2].message, /recovered: docker/);
  await w.run({}, { now: T0 + FAIL_AGAIN_MS + 2 * JOB_EVERY_MS });
  assert.equal(w.told.length, 3);
  assert.deepEqual(w.status().alerts, {});
});

test('the job: a notification that cannot be shown is tried again, and a notifier that throws harms nothing', async (t) => {
  const w = jobWorld(t);
  assert.equal(await w.run(dockerDown, { notify: async () => false }), EXIT_FAILED);
  assert.equal(w.status().alerts.docker.notified_at, null);
  assert.ok(w.said.some((m) => /not shown, due again/.test(m)));
  assert.equal(await w.run(dockerDown, { now: T0 + JOB_EVERY_MS, notify: () => { throw new Error('nope'); } }), EXIT_FAILED);
  assert.equal(w.told.length, 0);
  await w.run(dockerDown, { now: T0 + 2 * JOB_EVERY_MS });
  assert.equal(w.told.length, 1);
  assert.equal(w.status().alerts.docker.notified_at, iso(T0 + 2 * JOB_EVERY_MS));
  await w.run(dockerDown, { now: T0 + 3 * JOB_EVERY_MS });
  assert.equal(w.told.length, 1);
});

test('the status file: whole, readable by others, with its time and when the next is due, and no temp file left', async (t) => {
  const w = jobWorld(t);
  await w.run(dockerDown);
  const s = w.status();
  assert.equal(s.version, 1);
  assert.equal(s.at, iso(T0));
  assert.equal(s.next_by, iso(T0 + OVERDUE_MS));
  assert.equal(s.worst, 'FAIL');
  assert.equal(s.simulated, null);
  assert.deepEqual(s.lines.map((l) => l.check), NAMES);
  assert.deepEqual(Object.keys(s.lines[0]).sort(), ['check', 'detail', 'level', 'state']);
  assert.equal(s.counts.OK + s.counts.WARN + s.counts.FAIL, NAMES.length);
  assert.equal(statSync(w.statusFile).mode & 0o777, 0o644);
  assert.deepEqual(readdirSync(dirname(w.statusFile)), ['health-status.json'], 'no temp file and no lock left behind');
  assert.equal(statSync(dirname(w.statusFile)).mode & 0o777, 0o755);
});

test('the status file: the default is beside the stop file, outside ~/.adabra', () => {
  assert.equal(healthStatusPath({}, '/home/x'), '/home/x/.adabra-control/health-status.json');
  assert.equal(healthStatusPath({ ADABRA_HEALTH_STATUS: '/elsewhere/h.json' }, '/home/x'), '/elsewhere/h.json');
  assert.ok(!healthStatusPath({}, '/home/x').includes('.adabra/'));
});

test('the status file: a broken one costs a repeat and a WARN, and is replaced', async (t) => {
  const w = jobWorld(t);
  mkdirSync(dirname(w.statusFile));
  for (const junk of ['not json', 'null', '{"at":"never","lines":[]}', '{"at":"2026-11-03T00:00:00Z","lines":[null]}']) {
    writeFileSync(w.statusFile, junk);
    assert.deepEqual(readLastStatus(w.statusFile), { unreadable: true }, junk);
  }
  writeFileSync(w.statusFile, 'not json');
  await w.run(dockerDown);
  assert.equal(w.told.length, 1);
  assert.equal(w.status().lines.find((l) => l.check === 'health-job').level, 'WARN');
  assert.equal(w.status().at, iso(T0));
});

test('the status file: if it cannot be written that is a FAIL line and a notification, and the report still finishes', async (t) => {
  const w = jobWorld(t);
  mkdirSync(dirname(w.statusFile));
  mkdirSync(w.statusFile); // a folder where the file should go
  assert.equal(await w.run({}), EXIT_FAILED);
  assert.ok(w.said.some((m) => /status-file/.test(m) && /could not be written/.test(m)));
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].message, /status-file/);
});

test('the report only looks: it writes no status, rotates nothing and notifies nobody', async (t) => {
  const w = jobWorld(t);
  let rotations = 0;
  const code = await w.run({ ...dockerDown, rotateLogs: async () => { rotations += 1; return {}; } }, { args: [] });
  assert.equal(code, EXIT_FAILED);
  assert.equal(existsSync(dirname(w.statusFile)), false, 'not even the folder');
  assert.equal(w.told.length, 0);
  assert.equal(rotations, 0);
  assert.ok(w.said.some((m) => /^FAIL {2}docker/.test(m)));
  assert.match(w.said.at(-1), /FAIL$/);
  const onTime = { lastStatus: () => ({ at: iso(T0 - MINUTE), lines: [] }) };
  assert.equal(await w.run(onTime, { args: [] }), 0, 'all OK exits 0');
  assert.equal(await w.run({ ...onTime, loginPref: async () => ({ code: 0, stdout: '0\n' }) }, { args: [] }), 0, 'a WARN exits 0 too');
});

test('a run that finds another in progress does nothing; a lock left by a killed run does not block', async (t) => {
  const w = jobWorld(t);
  mkdirSync(dirname(w.statusFile));
  const lock = `${w.statusFile}.lock`;
  const release = takeRunLock(lock, Date.now());
  assert.ok(release);
  assert.equal(takeRunLock(lock, Date.now()), null);
  const code = await w.run(dockerDown, { now: Date.now() });
  assert.equal(code, EXIT_BUSY);
  assert.equal(existsSync(w.statusFile), false);
  assert.equal(w.told.length, 0);
  release();
  assert.equal(existsSync(lock), false);

  writeFileSync(lock, '');
  assert.ok(takeRunLock(lock, Date.now() + 10 * 60_000), 'older than any run can be');
  rmSync(lock, { force: true });
});

test('the drill: fails one check without running its probe, is marked, reaches the notifier, and the next real run recovers', async (t) => {
  const w = jobWorld(t);
  let dockerRan = false;
  const docker = async () => { dockerRan = true; return { code: 0, stdout: '' }; };
  assert.equal(await w.run({ docker }, { args: ['--job', '--simulate-fail', 'docker'] }), EXIT_FAILED);
  assert.equal(dockerRan, false, 'the real probe is not run, so nothing real is touched');
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].message, /docker: SIMULATED/);
  const s = w.status();
  assert.equal(s.simulated, 'docker');
  assert.equal(s.lines.find((l) => l.check === 'docker').level, 'FAIL');
  assert.equal(s.counts.FAIL, 1);

  assert.equal(await w.run({ docker }, { now: T0 + MINUTE }), 0);
  assert.equal(dockerRan, true);
  assert.match(w.told[1].message, /recovered: docker/);
  assert.equal(w.status().simulated, null);
});

test('the drill: it can only make a check fail, and it refuses anything else', async (t) => {
  const w = jobWorld(t);
  // A real failure of another check stays, and a real failure of this one is not hidden.
  assert.equal(await w.run({ service: async () => ({ installed: false, known: true, loaded: false }) }, { args: ['--job', '--simulate-fail', 'docker'] }), EXIT_FAILED);
  assert.equal(w.status().lines.find((l) => l.check === 'reviewer').level, 'FAIL');

  for (const args of [['--simulate-fail', 'docker'], ['--job', '--simulate-fail', 'no-such-check'], ['--job', '--simulate-fail', '__proto__'], ['--nonsense'], ['--last', '--job'], ['positional']]) {
    const before = w.told.length;
    assert.equal(await w.run({}, { args }), EXIT_USAGE, args.join(' '));
    assert.equal(w.told.length, before);
  }
  await w.run({}, { args: ['--job', '--simulate-fail', 'no-such-check'] });
  assert.match(w.said[0], /The checks are: stop, coordinator/);
});

test('--last reads the status file only, and is unhappy about a failure, a dead job and no file', async (t) => {
  const w = jobWorld(t);
  const untouchable = new Proxy({}, { get: () => { throw new Error('--last must not run a probe'); } });
  const last = (now) => {
    w.said.length = 0;
    return healthCommand({ args: ['--last'], env: { ADABRA_HEALTH_STATUS: w.statusFile }, home: w.dir, now: () => now, out: (m) => w.said.push(m), deadlineMs: 0, notify: async () => true, probes: untouchable });
  };
  assert.equal(await last(T0), EXIT_FAILED);
  assert.match(w.said[0], /no health run recorded yet/);

  await w.run({});
  assert.equal(await last(T0 + MINUTE), 0);
  assert.match(w.said[0], new RegExp(`last run ${iso(T0)}, 60s ago`));
  assert.ok(w.said.some((m) => /^OK {4}docker/.test(m)));
  assert.equal(await last(T0 + OVERDUE_MS + MINUTE), EXIT_FAILED);
  assert.ok(w.said.some((m) => /^OVERDUE/.test(m)));

  await w.run(dockerDown, { now: T0 + 2 * MINUTE });
  assert.equal(await last(T0 + 3 * MINUTE), EXIT_FAILED);

  writeFileSync(w.statusFile, 'not json');
  assert.equal(await last(T0 + 3 * MINUTE), EXIT_FAILED);
  assert.match(w.said[0], /could not be read/);
});

// --- log rotation --------------------------------------------------------------------------------------------------------

const logs = (t) => {
  const dir = join(tempDir(t), 'Logs');
  mkdirSync(dir);
  return dir;
};

test('rotation: over the limit is copied and truncated in place; under it is left alone', async (t) => {
  const dir = logs(t);
  const big = join(dir, 'adabra-reviewer.log');
  const small = join(dir, 'adabra-helper.log');
  writeFileSync(big, 'x'.repeat(2000));
  writeFileSync(small, 'y'.repeat(100));
  chmodSync(big, 0o640);
  const inode = statSync(big).ino;
  const r = await rotateLogs(dir, { maxBytes: 1000 });
  assert.deepEqual(r.rotated, ['adabra-reviewer.log']);
  assert.equal(r.files, 2);
  assert.equal(r.largest, 2000);
  assert.deepEqual(r.failed, []);
  assert.equal(statSync(big).size, 0);
  assert.equal(statSync(big).ino, inode, 'the same file, which launchd still holds open');
  assert.equal(statSync(big).mode & 0o777, 0o640, 'its mode is left as it was');
  assert.equal(readFileSync(`${big}.1`, 'utf8'), 'x'.repeat(2000));
  assert.equal(statSync(`${big}.1`).mode & 0o777, 0o640, 'the copy is no wider than the log');
  assert.equal(readFileSync(small, 'utf8'), 'y'.repeat(100));
  assert.ok(!existsSync(`${small}.1`));
});

test('rotation: exactly at the limit stays, and the defaults are 10 MB and three kept', async (t) => {
  assert.equal(ROTATE_OVER_BYTES, 10 * 1024 * 1024);
  assert.equal(KEEP_ROTATED, 3);
  const dir = logs(t);
  writeFileSync(join(dir, 'adabra-a.log'), 'x'.repeat(1000));
  assert.deepEqual((await rotateLogs(dir, { maxBytes: 1000 })).rotated, []);
  const big = join(dir, 'adabra-b.log');
  writeFileSync(big, '');
  truncateSync(big, ROTATE_OVER_BYTES + 1);
  assert.deepEqual((await rotateLogs(dir)).rotated, ['adabra-b.log']);
  assert.equal(statSync(`${big}.1`).size, ROTATE_OVER_BYTES + 1);
});

test('rotation: keeps a few, newest first, and drops the oldest', async (t) => {
  const dir = logs(t);
  const log = join(dir, 'adabra-a.log');
  for (const n of [1, 2, 3, 4, 5]) {
    writeFileSync(log, String(n).repeat(500));
    assert.deepEqual((await rotateLogs(dir, { maxBytes: 100, keep: 3 })).rotated, ['adabra-a.log']);
  }
  assert.deepEqual(readdirSync(dir).sort(), ['adabra-a.log', 'adabra-a.log.1', 'adabra-a.log.2', 'adabra-a.log.3']);
  assert.equal(readFileSync(`${log}.1`, 'utf8')[0], '5');
  assert.equal(readFileSync(`${log}.2`, 'utf8')[0], '4');
  assert.equal(readFileSync(`${log}.3`, 'utf8')[0], '3');
});

test('rotation: touches only files matching adabra-*.log', async (t) => {
  const dir = logs(t);
  const others = ['other.log', 'adabra-x.txt', 'xadabra-y.log', 'adabra-.log', 'adabra-x.log.1', 'adabra-backup-status.json', 'adabra-x.logs'];
  for (const name of others) writeFileSync(join(dir, name), 'z'.repeat(5000));
  const r = await rotateLogs(dir, { maxBytes: 100 });
  assert.deepEqual(r.rotated, []);
  assert.equal(r.files, 0);
  for (const name of others) assert.equal(statSync(join(dir, name)).size, 5000, name);
  assert.deepEqual(readdirSync(dir).sort(), [...others].sort());
});

test('rotation: never follows a symlink out of the folder, in the log\'s name, the copy\'s name or the folder itself', { ...posixOnly }, async (t) => {
  const dir = logs(t);
  const outside = join(dirname(dir), 'outside.txt');
  writeFileSync(outside, 'precious '.repeat(1000));
  const size = statSync(outside).size;
  symlinkSync(outside, join(dir, 'adabra-link.log'));

  // A real log whose rotated names have been planted as links to the same outside file.
  const real = join(dir, 'adabra-real.log');
  writeFileSync(real, 'r'.repeat(5000));
  symlinkSync(outside, `${real}.1`);
  symlinkSync(outside, `${real}.rotating`);

  const r = await rotateLogs(dir, { maxBytes: 100 });
  assert.deepEqual(r.rotated, ['adabra-real.log']);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.failed, []);
  assert.equal(statSync(outside).size, size, 'the file outside is untouched');
  assert.ok(readFileSync(outside, 'utf8').startsWith('precious'));
  assert.ok(lstatSync(join(dir, 'adabra-link.log')).isSymbolicLink(), 'the link stays and is reported');
  assert.equal(readFileSync(`${real}.1`, 'utf8'), 'r'.repeat(5000), 'the planted link was replaced by the copy');
  assert.ok(lstatSync(`${real}.2`).isSymbolicLink(), 'moved, never opened');

  const folder = join(dirname(dir), 'linked-logs');
  symlinkSync(dir, folder);
  assert.equal((await rotateLogs(folder, { maxBytes: 100 })).folder, 'not-a-folder');
  assert.equal((await scanLogs(folder)).folder, 'not-a-folder');
});

test('rotation: a hard link is left alone, because truncating it would empty a file that may live elsewhere', { ...posixOnly }, async (t) => {
  const dir = logs(t);
  const outside = join(dirname(dir), 'outside.txt');
  writeFileSync(outside, 'precious '.repeat(1000));
  linkSync(outside, join(dir, 'adabra-hard.log'));
  const r = await rotateLogs(dir, { maxBytes: 100 });
  assert.deepEqual(r.rotated, []);
  assert.equal(r.skipped, 1);
  assert.ok(readFileSync(outside, 'utf8').startsWith('precious'));
  assert.ok(!existsSync(join(dir, 'adabra-hard.log.1')));
});

test('rotation: bytes go across exactly as they are, whatever is in them, and none reach the result', async (t) => {
  const dir = logs(t);
  const log = join(dir, 'adabra-a.log');
  const nasty = Buffer.concat([Buffer.from(`\x1b]0;evil\x07$(rm -rf /) \`id\` <script> ${SECRET}\n`), Buffer.from([0, 255, 254, 0, 10]), Buffer.alloc(3_000_000, 'y')]);
  writeFileSync(log, nasty);
  const r = await rotateLogs(dir, { maxBytes: 100 });
  assert.ok(readFileSync(`${log}.1`).equals(nasty));
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('rotation: a writer holding the log open for appending goes on writing at the start of the same file, with no hole', async (t) => {
  const dir = logs(t);
  const log = join(dir, 'adabra-a.log');
  const fd = openSync(log, 'a');
  t.after(() => closeSync(fd));
  writeSync(fd, 'before\n'.repeat(100));
  await rotateLogs(dir, { maxBytes: 100 });
  writeSync(fd, 'after\n');
  assert.equal(readFileSync(log, 'utf8'), 'after\n');
  assert.equal(readFileSync(`${log}.1`, 'utf8'), 'before\n'.repeat(100));
});

test('rotation: a service writing throughout loses at most the small gap, and every line it kept is whole and in order', { ...posixOnly, timeout: 60_000 }, async (t) => {
  const dir = logs(t);
  const log = join(dir, 'adabra-a.log');
  const fd = openSync(log, 'a');
  const writer = spawn(process.execPath, ['-e', `
    let n = 0;
    const tick = () => { for (let i = 0; i < 50; i++) console.log('line ' + n++); if (n < 200000) setImmediate(tick); };
    tick();
  `], { stdio: ['ignore', fd, 'ignore'] });
  closeSync(fd);
  const ended = new Promise((done) => writer.on('close', done));
  let rotations = 0;
  let finished = false;
  void ended.then(() => { finished = true; });
  while (!finished) {
    rotations += (await rotateLogs(dir, { maxBytes: 20_000, keep: 200 })).rotated.length;
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.ok(rotations >= 1, 'it did rotate while the writer was going');
  const names = readdirSync(dir).filter((n) => /\.log\.\d+$/.test(n)).sort((a, b) => Number(b.split('.').pop()) - Number(a.split('.').pop()));
  const bytes = Buffer.concat([...names.map((n) => readFileSync(join(dir, n))), readFileSync(log)]);
  assert.equal(bytes.indexOf(0), -1, 'no hole: nothing wrote past a truncated end');
  const seen = bytes.toString('utf8').split('\n').filter(Boolean).map((l) => {
    assert.match(l, /^line \d+$/);
    return Number(l.slice(5));
  });
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] > seen[i - 1], 'in order');
  assert.equal(seen.at(-1), 199_999);
  // The accepted gap is one read to one truncate on each rotation. Generous, because a test machine may be busy.
  assert.ok(200_000 - seen.length <= rotations * 2000, `lost ${200_000 - seen.length} of 200000 over ${rotations} rotation(s)`);
});

test('rotation: a timed-out run stops before it truncates, leaves nothing behind, and the next run finishes the job', async (t) => {
  const dir = logs(t);
  const log = join(dir, 'adabra-a.log');
  writeFileSync(log, 'x'.repeat(5000));
  const ac = new AbortController();
  ac.abort();
  const r = await rotateLogs(dir, { maxBytes: 100, signal: ac.signal });
  assert.deepEqual(r.rotated, []);
  assert.deepEqual(r.failed, ['timed out']);
  assert.equal(statSync(log).size, 5000, 'nothing lost');
  assert.deepEqual(readdirSync(dir), ['adabra-a.log']);
  assert.deepEqual((await rotateLogs(dir, { maxBytes: 100 })).rotated, ['adabra-a.log']);
});

test('rotation: a copy left by a killed run is cleared, and one file that fails does not stop the rest', async (t) => {
  const dir = logs(t);
  writeFileSync(join(dir, 'adabra-gone.log.rotating'), 'stale');
  const bad = join(dir, 'adabra-a.log');
  const good = join(dir, 'adabra-b.log');
  writeFileSync(bad, 'x'.repeat(5000));
  writeFileSync(good, 'y'.repeat(5000));
  mkdirSync(`${bad}.1`); // a folder where the copy must go
  const r = await rotateLogs(dir, { maxBytes: 100, keep: 1 });
  assert.deepEqual(r.rotated, ['adabra-b.log']);
  assert.equal(r.failed.length, 1);
  assert.equal(statSync(bad).size, 5000, 'not truncated when the copy could not be put in place');
  assert.ok(!existsSync(`${bad}.rotating`));
  assert.ok(!existsSync(join(dir, 'adabra-gone.log.rotating')));
});

test('rotation: the scan changes nothing, and a missing folder is not an error', async (t) => {
  const dir = logs(t);
  writeFileSync(join(dir, 'adabra-a.log'), 'x'.repeat(5000));
  writeFileSync(join(dir, 'adabra-a.log.rotating'), 'stale');
  const before = statSync(join(dir, 'adabra-a.log')).mtimeMs;
  const s = await scanLogs(dir, { maxBytes: 100 });
  assert.deepEqual(s.over, ['adabra-a.log']);
  assert.equal(statSync(join(dir, 'adabra-a.log')).mtimeMs, before);
  assert.ok(existsSync(join(dir, 'adabra-a.log.rotating')));
  assert.equal((await scanLogs(join(dir, 'none'))).folder, 'missing');
  assert.equal((await rotateLogs(join(dir, 'none'))).folder, 'missing');
});

// --- the command line, with fake tools -----------------------------------------------------------------------------------

function cliWorld(t, tools) {
  const f = fakeBin(t, tools);
  const home = join(f.dir, 'home');
  const agents = join(home, 'Library', 'LaunchAgents');
  const logDir = join(home, 'Library', 'Logs');
  const helper = join(home, 'agent');
  mkdirSync(agents, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  mkdirSync(helper);
  for (const label of Object.values(LABELS)) writeFileSync(join(agents, `${label}.plist`), '<plist/>');
  writeFileSync(join(helper, 'agent-status.json'), JSON.stringify({ at: new Date().toISOString(), held: [], outbox: { pending: 0 } }));
  const backupStatus = join(home, 'backup-status.json');
  writeFileSync(backupStatus, JSON.stringify({ finished_at: new Date().toISOString(), databases: { coordinator: { ok: true }, reviewer: { ok: true } } }));
  const reviewDb = join(home, 'reviewer.db');
  const store = new ReviewStore(reviewDb);
  store.enqueue(1, 'a'.repeat(40), { title: SECRET }, Date.now());
  store.close();
  const statusFile = join(home, '.adabra-control', 'health-status.json');
  const env = {
    HOME: home, PATH: `${f.bin}:${dirname(process.execPath)}:/usr/bin:/bin`, ADABRA_TAILSCALE: f.tailscale, REVIEW_DB: reviewDb, ADABRA_BACKUP_STATUS: backupStatus,
    TEAM_AGENT_HOME: helper, ADABRA_STOP_FILE: join(home, '.adabra-control', 'stop.json'), ADABRA_LOG_DIR: logDir,
  };
  const exec = (file, args) => new Promise((done) => {
    execFile(file, args, { env, cwd: tmpdir(), encoding: 'utf8' }, (err, stdout, stderr) => done({ code: err ? err.code : 0, signal: err?.signal, stdout, stderr }));
  });
  return { ...f, home, env, logDir, statusFile, store, cli: (...args) => exec(process.execPath, [MAIN, 'health', ...args]), ops: (...args) => exec('bash', [OPS, ...args]), exec };
}

async function fakeCoordinator(t, world) {
  const server = createServer((req, res) => res.end('{"ok":true}'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  world.env.COORDINATOR_PORT = String(server.address().port);
}

test('the command: a full report over the real probes and fake tools, with the exit code the lines call for', { ...posixOnly, timeout: 60_000 }, async (t) => {
  const w = cliWorld(t);
  await fakeCoordinator(t, w);
  const r = await w.cli();
  for (const name of NAMES) assert.match(r.stdout, new RegExp(`^(OK|WARN|FAIL) +${name} `, 'm'), name);
  assert.equal(r.code, /^FAIL/m.test(r.stdout) ? 1 : 0);
  // Disk is the test machine's own. Everything else has a known answer here.
  const notOk = r.stdout.split('\n').filter((l) => /^(WARN|FAIL) /.test(l) && !/^(WARN|FAIL) +disk /.test(l));
  assert.deepEqual(notOk.map((l) => l.split(/ +/)[1]).sort(), ['health-job', 'tailscale-login'], r.stdout);
  assert.ok(!r.stdout.includes(SECRET));
  assert.ok(!r.stdout.includes(TAILNET));
  assert.equal(existsSync(w.statusFile), false, 'the report writes nothing');
  assert.ok(!w.calls().includes('osascript'), 'the report notifies nobody');
  assert.ok(!/launchctl (bootout|bootstrap|kickstart|kill|stop|load|unload)/.test(w.calls()));
});

test('the command: --job rotates, writes the status file, notifies, and no secret gets anywhere', { ...posixOnly, timeout: 60_000 }, async (t) => {
  const w = cliWorld(t, { docker: `echo "${SECRET}"; exit 1` });
  await fakeCoordinator(t, w);
  const log = join(w.logDir, 'adabra-reviewer.log');
  writeFileSync(log, `${SECRET}\n`);
  appendFileSync(log, 'x'.repeat(ROTATE_OVER_BYTES));
  const first = await w.cli('--job');
  assert.equal(first.code, EXIT_FAILED, first.stdout);
  assert.equal(statSync(log).size, 0, 'the oversized log was rotated');
  assert.ok(readFileSync(`${log}.1`, 'utf8').startsWith(SECRET));

  const statusText = readFileSync(w.statusFile, 'utf8');
  const s = JSON.parse(statusText);
  assert.equal(s.lines.find((l) => l.check === 'docker').state, 'down');
  assert.equal(s.lines.find((l) => l.check === 'review-queue').level, 'OK');
  assert.match(s.lines.find((l) => l.check === 'logs').detail, /1 rotated/);
  for (const text of [statusText, first.stdout, first.stderr]) {
    assert.ok(!text.includes(SECRET), 'no secret');
    assert.ok(!text.includes(TAILNET), 'no tailnet name');
    assert.ok(!text.includes('xxxxxxxx'), 'no log content');
  }
  if (process.platform === 'darwin') {
    assert.equal(w.calls().match(/^osascript /gm)?.length, 1);
    assert.match(w.calls(), /Adabra health: \d failing/);
    await w.cli('--job');
    assert.equal(w.calls().match(/^osascript /gm).length, 1, 'once only');
    assert.ok(!w.calls().includes(SECRET));
  }
  assert.deepEqual(readdirSync(dirname(w.statusFile)).sort(), ['health-status.json'], 'no lock or temp left');

  const last = await w.cli('--last');
  assert.equal(last.code, EXIT_FAILED);
  assert.match(last.stdout, /^FAIL +docker +the Docker daemon/m);
});

test('the command: the drill through the service script, then the real run shows the recovery', { ...posixOnly, timeout: 60_000 }, async (t) => {
  const w = cliWorld(t);
  await fakeCoordinator(t, w);
  const drill = await w.exec('bash', [SERVICE, 'drill', 'docker']);
  assert.equal(drill.code, EXIT_FAILED, drill.stdout);
  assert.match(drill.stdout, /no real service is touched/);
  assert.match(drill.stdout, /^FAIL +docker +SIMULATED/m);
  assert.ok(!w.calls().includes('docker info'), 'docker was not even asked');
  const s = JSON.parse(readFileSync(w.statusFile, 'utf8'));
  assert.equal(s.simulated, 'docker');
  assert.equal(s.lines.find((l) => l.check === 'docker').level, 'FAIL');

  await w.cli('--job');
  assert.ok(w.calls().includes('docker info'));
  const after = JSON.parse(readFileSync(w.statusFile, 'utf8'));
  assert.equal(after.lines.find((l) => l.check === 'docker').level, 'OK');
  assert.equal(after.simulated, null);
  if (process.platform === 'darwin') {
    assert.match(w.calls(), /recovered: docker/);
    assert.equal(after.alerts.docker, undefined, 'told, so forgotten');
  } else {
    assert.equal(after.alerts.docker.state, 'simulated', 'nothing here can show a notification, so the recovery stays due');
  }

  assert.equal((await w.exec('bash', [SERVICE, 'drill'])).code, EXIT_USAGE);
  assert.equal((await w.exec('bash', [SERVICE, 'drill', 'no-such-check'])).code, EXIT_USAGE);
});

test('the command: through service/ops.sh, from any folder, with no tools at all it still reports', { ...posixOnly, timeout: 60_000 }, async (t) => {
  const w = cliWorld(t);
  await fakeCoordinator(t, w);
  const r = await w.ops('health');
  assert.match(r.stdout, /^OK +reviewer /m);
  assert.equal((await w.ops('nonsense')).code, EXIT_USAGE);

  const none = cliWorld(t, { launchctl: null, docker: null, defaults: null, tailscale: null, osascript: null });
  none.env.PATH = none.bin;
  none.env.COORDINATOR_PORT = '1';
  const bare = await none.cli();
  assert.equal(bare.code, EXIT_FAILED);
  assert.match(bare.stdout, /^FAIL +docker +docker was not found/m);
  assert.match(bare.stdout, /^FAIL +reviewer +launchctl was not found/m);
  assert.match(bare.stdout, /^FAIL +tailscale +tailscale was not found/m);
  assert.equal(bare.stderr.includes('Error'), false, bare.stderr);
});

test('the command: a usage error says so, and a stop still works with the health code out of the way', { ...posixOnly, timeout: 60_000 }, async (t) => {
  const w = cliWorld(t);
  assert.equal((await w.cli('--nonsense')).code, EXIT_USAGE);
  const main = readFileSync(MAIN, 'utf8');
  assert.ok(!/^import .*health/m.test(main), 'loaded only when asked for: nothing in it can get in the way of stopping');
  assert.match(main, /await import\('\.\/health\.js'\)/);
});

// --- the service script, with a fake launchctl ---------------------------------------------------------------------------

function fakeService(t) {
  const dir = tempDir(t);
  const bin = join(dir, 'bin');
  const state = join(dir, 'launchctl');
  mkdirSync(bin);
  mkdirSync(state);
  // Fails the first bootstrap, as launchd does while the old service is still going away.
  writeFileSync(join(bin, 'launchctl'), `#!/bin/bash
echo "$*" >> ${JSON.stringify(join(state, 'calls'))}
case "$1" in
  print) [ -f ${JSON.stringify(join(state, 'loaded'))} ] && echo "state = not running" ;;
  bootstrap)
    n=$(cat ${JSON.stringify(join(state, 'tries'))} 2>/dev/null || echo 0)
    echo $((n + 1)) > ${JSON.stringify(join(state, 'tries'))}
    [ "$n" -ge 1 ] && touch ${JSON.stringify(join(state, 'loaded'))} ;;
  bootout) rm -f ${JSON.stringify(join(state, 'loaded'))} ;;
esac
`);
  chmodSync(join(bin, 'launchctl'), 0o755);
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` };
  return { dir, home, env, run: (...args) => spawnSync(SERVICE, args, { encoding: 'utf8', env }), calls: () => readFileSync(join(state, 'calls'), 'utf8') };
}

test('service: the script parses, and anything but a known command is refused', () => {
  execFileSyncQuiet('bash', ['-n', SERVICE]);
  execFileSyncQuiet('bash', ['-n', OPS]);
  assert.equal(spawnSync(SERVICE, [], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(SERVICE, ['nonsense'], { encoding: 'utf8' }).status, 2);
});

function execFileSyncQuiet(file, args) {
  const r = spawnSync(file, args, { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}

test('service: install writes a 15-minute job that launchd never overlaps or restarts, and retries a bootstrap that lost the race', { ...posixOnly, timeout: 60_000 }, (t) => {
  const f = fakeService(t);
  const r = f.run('install');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const plistPath = join(f.home, 'Library', 'LaunchAgents', 'ai.adabra.health.plist');
  const plist = readFileSync(plistPath, 'utf8');
  assert.equal(statSync(plistPath).mode & 0o777, 0o600);
  assert.match(plist, /<key>StartInterval<\/key><integer>900<\/integer>/);
  assert.equal(900_000, JOB_EVERY_MS);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.doesNotMatch(plist, /KeepAlive/, 'a job that finishes must not be restarted');
  assert.ok(plist.includes(`<string>${join(REPO, 'ops', 'main.js')}</string><string>health</string><string>--job</string>`));
  assert.ok(plist.includes(`<key>REVIEW_DB</key><string>${join(REPO, 'reviewer.db')}</string>`));
  assert.ok(plist.includes(`<key>ADABRA_HEALTH_STATUS</key><string>${join(f.home, '.adabra-control', 'health-status.json')}</string>`));
  assert.ok(plist.includes(`<string>${join(f.home, 'Library', 'Logs', 'adabra-health.log')}</string>`));
  assert.match(plist, /<key>PATH<\/key><string>[^<]*\.docker\/bin/);
  assert.doesNotMatch(plist, /simulate/, 'no drill can be left switched on in the service');
  if (process.platform === 'darwin') {
    const lint = spawnSync('/usr/bin/plutil', ['-lint', plistPath], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stdout);
  }
  const calls = f.calls();
  assert.equal(calls.match(/^bootstrap /gm).length, 2, 'the first attempt failed and it tried again');
  assert.doesNotMatch(calls, /kickstart -k/, 'it must not kill a run in progress');
  assert.match(r.stdout, /state = not running/);
  assert.match(r.stdout, /no health run recorded yet/, 'the fake launchd runs nothing, and status says so');

  assert.equal(f.run('run').status, 0);
  assert.match(f.calls(), /^kickstart gui\/\d+\/ai\.adabra\.health$/m);
  assert.equal(f.run('status').status, EXIT_FAILED, 'no run yet, so status is unhappy');

  const statusFile = join(f.home, '.adabra-control', 'health-status.json');
  mkdirSync(dirname(statusFile));
  writeFileSync(statusFile, JSON.stringify({ at: new Date().toISOString(), lines: [{ check: 'docker', level: 'OK', detail: 'fine' }] }));
  const status = f.run('status');
  assert.equal(status.status, 0, status.stdout);
  assert.match(status.stdout, /^OK +docker +fine/m);

  const u = f.run('uninstall');
  assert.equal(u.status, 0);
  assert.equal(existsSync(plistPath), false);
  assert.equal(existsSync(statusFile), true, 'uninstall leaves the status file');
  assert.match(f.run('status').stdout, /service not loaded/);
});

test('service: follows the shape of its neighbours, and starts nothing it should not', () => {
  const script = readFileSync(SERVICE, 'utf8');
  assert.match(script, /bootout returns before the old service is gone/);
  assert.match(script, /launchctl print "\$DOMAIN\/\$LABEL" >\/dev\/null 2>&1 \|\| break; sleep 0\.5/);
  assert.ok(!script.split('\n').some((l) => !l.trim().startsWith('#') && l.includes('kickstart -k')));
  assert.ok(!script.includes('sudo'));
});

test('settings: agents may run the report, by exact words only, and not the job or the drill', () => {
  const { allow, deny } = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8')).permissions;
  for (const rule of ['Bash(service/ops.sh health)', 'Bash(service/ops.sh health --last)', 'Bash(node ops/main.js health)', 'Bash(node ops/main.js health --last)', 'Bash(service/health-service.sh status)']) {
    assert.ok(allow.includes(rule), rule);
  }
  const mine = allow.filter((r) => /health/.test(r));
  assert.equal(mine.length, 5);
  assert.ok(mine.every((r) => !r.includes('*')), 'no wildcards');
  assert.ok(!mine.some((r) => /--job|drill|simulate|install/.test(r)));
  assert.ok(deny.includes('Write(~/.adabra-control/**)'), 'the status file sits where agents may read it and may not write it');
});

test('nothing here can stop or restart a service: the probes only ever print, and the code holds no such command', () => {
  for (const file of ['ops/health.js', 'ops/health-queue.js', 'ops/rotate-logs.js']) {
    const source = readFileSync(join(REPO, file), 'utf8');
    for (const word of ['bootout', 'kickstart', 'bootstrap', "'kill'", 'docker stop', 'docker rm']) assert.ok(!source.includes(word), `${file}: ${word}`);
  }
});
