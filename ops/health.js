import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Worker } from 'node:worker_threads';
import { backupConfig, readStatus, statusProblems } from '../backup/backup.js';
import { notifyCommand } from '../helper/platform.js';
import { plain } from '../shared/sanitize.js';
import { MACHINE_DIR, readStop, stopFilePath, writeState } from '../shared/stop.js';
import { rotateLogs, scanLogs } from './rotate-logs.js';

// The health report. `health` only looks: it starts nothing, writes nothing and rotates nothing, so agents may run it. `health --job` is
// what the LaunchAgent runs (service/health-service.sh): the same checks, plus log rotation, the status file and notifications.
//
// OK    nothing to do.
// WARN  worth knowing, nothing broken: a deliberate stop, a pause that lifts by itself, something not installed yet.
// FAIL  someone should act. `health` exits 1 if any line is a FAIL.
//
// Every line is built here from counts, states, dates and fixed words. Nothing a tool printed reaches a line, and neither does anything
// from a database, a log or a token file, so the status file can be read by anyone who can reach it.

const REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE_SCRIPT = join(REPO_DIR, 'ops', 'health-queue.js');
const TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const TAILSCALE_PREF = ['io.tailscale.ipn.macsys', 'TailscaleStartOnLogin'];

export const LABELS = {
  coordinator: 'ai.adabra.coordinator', helper: 'ai.adabra.helper', reviewer: 'ai.adabra.reviewer', backup: 'ai.adabra.backup', health: 'ai.adabra.health',
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GB = 1e9;

const LAUNCHCTL_MS = 5000;
const DEFAULTS_MS = 5000;
const DOCKER_MS = 15_000; // what a busy Docker Desktop can take, and no more
const TAILSCALE_MS = 8000;
const HEALTHZ_MS = 3000;
const QUEUE_MS = 8000;
const NOTIFY_MS = 10_000;
export const CHECK_MS = 20_000; // for one check, whatever it waits on. Longer than any tool above, so the tool's own answer comes first
export const LOGS_CHECK_MS = 60_000;
export const HARD_DEADLINE_MS = 120_000; // the longest check, the notification and the writes, with room to spare

const MAX_TOOL_OUTPUT = 4 * 1024 * 1024;
const HELPER_STALE_MS = 120_000; // the same limit `helper/cli.js status` uses
const STOP_LONG_MS = DAY;
const KEY_WARN_MS = 30 * DAY;
const DISK_WARN_BYTES = 20 * GB;
const DISK_FAIL_BYTES = 5 * GB;
const QUEUE_WARN_MS = 2 * HOUR;
const QUEUE_FAIL_MS = 6 * HOUR;

export const JOB_EVERY_MS = 15 * MINUTE;
export const OVERDUE_MS = 3 * JOB_EVERY_MS; // two missed runs
export const FAIL_AGAIN_MS = DAY;
export const REMIND_AGAIN_MS = 7 * DAY;

export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_BUSY = 75; // the same as a backup run that finds another in progress

const USAGE = 'usage: main.js health [--job [--simulate-fail <check>]] | health --last';

const iso = (ms) => new Date(ms).toISOString();
const text = (s, max = 200) => plain(s ?? '').slice(0, max).toWellFormed();
const say = (level, state, detail, extra = {}) => ({ level, state, detail, ...extra });
const OK = (state, detail) => say('OK', state, detail);
const WARN = (state, detail, extra) => say('WARN', state, detail, extra);
const FAIL = (state, detail) => say('FAIL', state, detail);

export function ageText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

const gb = (bytes) => `${(bytes / GB).toFixed(1)} GB`;
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

export const healthStatusPath = (env = process.env, home = homedir()) =>
  resolve(env.ADABRA_HEALTH_STATUS?.trim() || join(home, '.adabra-control', 'health-status.json'));

// --- running a tool --------------------------------------------------------
// Always answers by the deadline. Only the first process is killed, and a child of it can go on holding the pipe, so at the deadline
// the pipe is dropped too and the answer given, whatever became of the process. stderr is ignored: nothing a tool says is ever reported.
export function runTool(file, args, { timeoutMs = LAUNCHCTL_MS, env = process.env, maxBytes = MAX_TOOL_OUTPUT } = {}) {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      done({ code: null, stdout: '', failed: err.code ?? 'failed' });
      return;
    }
    const out = [];
    let size = 0;
    let settled = false;
    let timer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ stdout: Buffer.concat(out).toString('utf8'), ...r });
    };
    const abandon = (r) => {
      if (settled) return;
      finish(r);
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.unref();
    };
    timer = setTimeout(() => abandon({ code: null, timedOut: true, stdout: '' }), timeoutMs);
    child.on('error', (err) => finish({ code: null, stdout: '', ...(err.code === 'ENOENT' ? { missing: true } : { failed: err.code ?? 'failed' }) }));
    child.stdout.on('error', () => {});
    child.stdout.on('data', (b) => {
      size += b.length;
      if (size > maxBytes) abandon({ code: null, overflow: true, stdout: '' });
      else out.push(b);
    });
    child.on('close', (code) => finish({ code }));
  });
}

// What went wrong running a tool, in fixed words, or null if it ran. Whether it succeeded is a separate question.
function toolTrouble(r, name, timeoutMs) {
  if (r.missing) return { state: 'missing', detail: `${name} was not found` };
  if (r.timedOut) return { state: 'stuck', detail: `${name} gave no answer within ${timeoutMs / 1000}s` };
  if (r.overflow) return { state: 'overflow', detail: `${name} printed far more than expected` };
  if (r.failed) return { state: 'failed', detail: `${name} could not be started (${r.failed})` };
  return null;
}

// --- the real probes ---------------------------------------------------------
// Everything that touches the machine. Tests replace this whole object, or give it fake tools on PATH.
export function parseLaunchctl(r) {
  const trouble = toolTrouble(r, 'launchctl', LAUNCHCTL_MS);
  if (trouble) return { known: false, why: trouble.detail };
  if (r.code !== 0) return { known: true, loaded: false };
  const first = (re) => text(r.stdout.match(re)?.[1] ?? 'unknown', 40);
  return { known: true, loaded: true, state: first(/^\s*state = (.+)$/m), pid: first(/^\s*pid = (\d+)$/m), lastExit: first(/^\s*last exit code = (.+)$/m) };
}

// 'tailnet', 'public' or 'none', for what proxies to the coordinator. The host name is read past and never kept.
export function parseServe(output, port) {
  const blocks = [];
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (/^[a-z+]+:\/\//i.test(line)) blocks.push({ head: line, routes: [] });
    else if (line.startsWith('|--') && blocks.length) blocks.at(-1).routes.push(line);
  }
  const target = new RegExp(`\\bproxy https?://(127\\.0\\.0\\.1|localhost):${Number(port)}(/\\S*)?\\s*$`);
  const mine = blocks.filter((b) => b.routes.some((r) => target.test(r)));
  if (!mine.length) return 'none';
  return mine.every((b) => /\(tailnet only\)/i.test(b.head)) ? 'tailnet' : 'public';
}

export function realProbes({ env = process.env, home = homedir(), repoDir = REPO_DIR, uid = process.getuid?.() ?? 0, tool = runTool, machineDir = MACHINE_DIR } = {}) {
  const run = (file, args, timeoutMs) => tool(file, args, { env, timeoutMs });
  const cfg = backupConfig({ env, home, repoDir });
  const reviewDb = cfg.databases.find((d) => d.name === 'reviewer').path;
  const helperHome = env.TEAM_AGENT_HOME?.trim() || join(home, '.team-agent');
  const logDir = resolve(env.ADABRA_LOG_DIR?.trim() || join(home, 'Library', 'Logs'));
  const statusFile = healthStatusPath(env, home);
  const tailscale = env.ADABRA_TAILSCALE?.trim() || (existsSync(TAILSCALE_APP) ? TAILSCALE_APP : 'tailscale');
  return {
    stop: () => readStop({ path: stopFilePath(env, () => home, machineDir), machineDir }),
    service: async (label) => ({
      installed: existsSync(join(home, 'Library', 'LaunchAgents', `${label}.plist`)),
      ...parseLaunchctl(await run('launchctl', ['print', `gui/${uid}/${label}`], LAUNCHCTL_MS)),
    }),
    healthz: async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${coordinatorPort(env)}/healthz`, { signal: AbortSignal.timeout(HEALTHZ_MS) });
        const body = await res.json();
        return { answered: true, ok: res.ok && body?.ok === true, stopped: body?.stopped === true };
      } catch (err) {
        return { answered: err.name === 'SyntaxError', ok: false, stopped: false };
      }
    },
    helperStatus: () => {
      let s;
      try {
        s = JSON.parse(readFileSync(join(helperHome, 'agent-status.json'), 'utf8'));
      } catch (err) {
        return err.code === 'ENOENT' ? null : { unreadable: true };
      }
      const at = Date.parse(s?.at);
      if (Number.isNaN(at)) return { unreadable: true };
      return { at, held: Array.isArray(s.held) ? s.held.length : 0, pending: Number(s.outbox?.pending) || 0 };
    },
    docker: () => run('docker', ['info', '--format', '{{.ServerVersion}}'], DOCKER_MS),
    tailscaleStatus: async () => {
      const r = await run(tailscale, ['status', '--json'], TAILSCALE_MS);
      if (toolTrouble(r, 'tailscale', TAILSCALE_MS)) return r;
      try {
        const j = JSON.parse(r.stdout);
        return { backend: text(j.BackendState ?? 'unknown', 40), keyExpiry: typeof j.Self?.KeyExpiry === 'string' ? j.Self.KeyExpiry : null, hasTailnet: Boolean(j.CurrentTailnet) };
      } catch {
        return { code: r.code, unparsed: true };
      }
    },
    tailscaleServe: () => run(tailscale, ['serve', 'status'], TAILSCALE_MS),
    loginPref: () => run('defaults', ['read', ...TAILSCALE_PREF], DEFAULTS_MS),
    disk: async () => {
      const s = await statfs(home);
      return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    },
    backupStatus: () => readStatus(cfg.statusFile),
    queue: async () => {
      const r = await tool(process.execPath, [QUEUE_SCRIPT, reviewDb], { env, timeoutMs: QUEUE_MS });
      if (r.timedOut) return { timedOut: true };
      try {
        return JSON.parse(r.stdout);
      } catch {
        return { error: 'unreadable', why: `the reader exited with ${r.code ?? 'no code'}` };
      }
    },
    scanLogs: () => scanLogs(logDir),
    rotateLogs: (signal) => rotateLogs(logDir, { signal }),
    lastStatus: () => readLastStatus(statusFile),
    port: coordinatorPort(env),
  };
}

const coordinatorPort = (env) => Number(env.COORDINATOR_PORT ?? 8787);

// --- the checks --------------------------------------------------------------
function once(fn) {
  let result;
  return () => (result ??= Promise.resolve().then(fn));
}

// A LaunchAgent that should be running. Null if it is.
function serviceTrouble(svc, name, { required }) {
  if (!svc.known) return FAIL('launchctl', `${svc.why}, so the ${name} service cannot be checked`);
  if (!svc.loaded) {
    if (svc.installed) return FAIL('not-loaded', `${name} is installed but launchd has not loaded it`);
    return required ? FAIL('not-installed', `${name} is not installed`) : WARN('not-installed', `${name} is not installed: fine unless this machine should run it`);
  }
  if (svc.state !== 'running') return FAIL('not-running', `${name} is loaded but ${svc.state}, last exit code ${svc.lastExit}`);
  return null;
}

// In report order. Each returns { level, state, detail }. `state` is a short word that says when something has changed, because
// the detail holds ages and sizes that differ on every run. `remind` asks for a notification on a WARN: see planNotifications.
export function buildChecks(p, { nowMs, job = false }) {
  const stop = once(() => p.stop());
  const queue = once(() => p.queue());
  const tailscale = once(() => p.tailscaleStatus());

  return {
    // Deliberate, whatever its age, so never a FAIL. Past a day it asks for a notification, because a forgotten stop idles everything.
    // A file that cannot be read is another matter: nobody chose that, it has stopped everything, and someone must look.
    stop: async () => {
      const s = await stop();
      if (!s.stopped) return OK('running', 'no emergency stop in force');
      if (s.unreadable) return FAIL('unreadable', `the stop file could not be read (${text(s.unreadable, 40)}), so everything is stopped. service/ops.sh resume repairs it`);
      if (!s.since) return WARN('stopped', 'emergency stop in force, since an unknown time: service/ops.sh status');
      const held = nowMs - Date.parse(s.since);
      if (held > STOP_LONG_MS) return WARN('stopped-long', `emergency stop in force since ${s.since}, ${ageText(held)} ago: is it still wanted? service/ops.sh resume ends it`, { remind: true });
      return WARN('stopped', `emergency stop in force since ${s.since}, ${ageText(held)} ago: deliberate. service/ops.sh resume ends it`);
    },

    coordinator: async () => {
      const [svc, hz, s] = await Promise.all([p.service(LABELS.coordinator), p.healthz(), stop()]);
      const where = `127.0.0.1:${p.port ?? 8787}`;
      if (!hz.answered) return FAIL('no-answer', `no answer on ${where}${svc.known && !svc.loaded ? ', and its service is not loaded' : ''}`);
      if (!hz.ok) return FAIL('bad-answer', `${where} answered, but not with a healthy /healthz`);
      if (!svc.known) return WARN('launchctl', `answers on ${where}, but ${svc.why}, so its service cannot be checked`);
      if (!svc.loaded) return WARN('not-a-service', `answers on ${where}, but its service is not loaded: started by hand? It would not restart by itself`);
      if (hz.stopped !== s.stopped) return WARN('stop-differs', `answers on ${where}, but it ${hz.stopped ? 'reports a stop' : 'does not report the stop'} this check ${hz.stopped ? 'cannot see' : 'can see'}: are they reading the same stop file?`);
      return OK(hz.stopped ? 'running-stopped' : 'running', `answers on ${where}${hz.stopped ? ' and reports the stop' : ''}, service running`);
    },

    helper: async () => {
      const svc = await p.service(LABELS.helper);
      const trouble = serviceTrouble(svc, 'the helper', { required: false });
      if (trouble) return trouble;
      const st = await p.helperStatus();
      if (!st) return FAIL('no-status', 'the helper is running but has never finished a pass: is this device enrolled?');
      if (st.unreadable) return FAIL('unreadable', 'the helper is running but its status file could not be read');
      const age = nowMs - st.at;
      if (age > HELPER_STALE_MS) return FAIL('stale', `the helper's last pass was ${ageText(age)} ago, and it should report every 30s`);
      return OK('running', `last pass ${ageText(age)} ago, ${st.held} claim(s) held, ${st.pending} waiting in the outbox`);
    },

    reviewer: async () => {
      const svc = await p.service(LABELS.reviewer);
      return serviceTrouble(svc, 'the reviewer', { required: true }) ?? OK('running', 'service running');
    },

    docker: async () => {
      const r = await p.docker();
      const trouble = toolTrouble(r, 'docker', DOCKER_MS);
      if (trouble) return FAIL(trouble.state, trouble.detail);
      if (r.code !== 0) return FAIL('down', 'the Docker daemon is not answering, so PRs cannot be tested');
      return OK('running', 'the Docker daemon answers');
    },

    tailscale: async () => {
      const t = await tailscale();
      const trouble = toolTrouble(t, 'tailscale', TAILSCALE_MS);
      if (trouble) return FAIL(trouble.state, trouble.detail);
      if (t.unparsed) return FAIL('unparsed', 'tailscale status gave no usable answer');
      if (t.backend !== 'Running') return FAIL(`backend-${t.backend}`, `tailscale is ${t.backend}, not Running: builders cannot reach the coordinator`);
      return OK('running', t.hasTailnet ? 'running, on a tailnet' : 'running');
    },

    'tailscale-serve': async () => {
      const r = await p.tailscaleServe();
      const trouble = toolTrouble(r, 'tailscale', TAILSCALE_MS);
      if (trouble) return FAIL(trouble.state, trouble.detail);
      const seen = r.code === 0 ? parseServe(r.stdout, p.port ?? 8787) : 'none';
      if (seen === 'none') return FAIL('not-serving', 'tailscale serve does not proxy to the coordinator: builders cannot reach it');
      if (seen === 'public') return FAIL('public', 'tailscale serve proxies to the coordinator and is NOT marked tailnet only: it may be public');
      return OK('serving', 'proxies to the coordinator, tailnet only');
    },

    'tailscale-key': async () => {
      const t = await tailscale();
      if (toolTrouble(t, 'tailscale', TAILSCALE_MS) || t.unparsed) return WARN('unknown', 'the key expiry could not be read: see the tailscale line');
      if (!t.keyExpiry) return OK('no-expiry', 'this device has no key expiry');
      const at = Date.parse(t.keyExpiry);
      if (Number.isNaN(at)) return WARN('unreadable', 'the key expiry could not be understood');
      if (at < Date.UTC(2000, 0, 1)) return OK('no-expiry', 'this device has no key expiry'); // Go's zero time
      const left = at - nowMs;
      const date = iso(at).slice(0, 10);
      if (left <= 0) return FAIL('expired', `this device's key expired on ${date}: sign in again, or turn key expiry off for it`);
      if (left <= KEY_WARN_MS) return WARN('expiring', `this device's key expires on ${date}, in ${ageText(left)}: sign in again, or turn key expiry off for it`, { remind: true });
      return OK('valid', `this device's key expires on ${date}`);
    },

    // What 0 and 1 mean is inferred from the preference's name: Tailscale does not document it. So the line says so.
    'tailscale-login': async () => {
      const r = await p.loginPref();
      const value = r.code === 0 ? r.stdout.trim() : null;
      if (value === '1') return OK('on', 'TailscaleStartOnLogin reads 1: appears to start at login (meaning inferred from the name)');
      if (value === '0') return WARN('off', 'TailscaleStartOnLogin reads 0: may not start after a reboot (meaning inferred from the name)');
      return WARN('unknown', 'TailscaleStartOnLogin could not be read, so whether Tailscale starts at login is unknown');
    },

    disk: async () => {
      const { freeBytes, totalBytes } = await p.disk();
      const room = `${gb(freeBytes)} free of ${gb(totalBytes)}`;
      if (freeBytes < DISK_FAIL_BYTES) return FAIL('critical', `${room}: databases, backups and reviews need room now`);
      if (freeBytes < DISK_WARN_BYTES) return WARN('low', `${room}: getting low`);
      return OK('ok', room);
    },

    // Not installed yet is a different thing from installed and failing. The first is said plainly and is no failure.
    backup: async () => {
      const [svc, status] = await Promise.all([p.service(LABELS.backup), p.backupStatus()]);
      const installed = svc.installed || svc.loaded;
      const finished = Date.parse(status?.finished_at);
      const last = Number.isNaN(finished) ? null : `${ageText(nowMs - finished)} ago`;
      if (!installed) {
        return WARN('not-installed', `backups are not installed${last ? `; the last recorded run was ${last}` : ' yet, so nothing is being backed up'}: service/backup-service.sh install`);
      }
      if (svc.known && !svc.loaded) return FAIL('not-loaded', 'backups are installed but launchd has not loaded the job');
      if (!status) return FAIL('no-status', 'backups are installed, but no run has recorded a status');
      const problems = statusProblems(status, nowMs).map((x) => text(x, 120));
      if (problems.length) return FAIL(text(problems.join('|'), 80), `${problems[0]}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
      return OK('ok', `last run ${last}, every database backed up and checked`);
    },

    'review-queue': async () => {
      const [q, s] = await Promise.all([queue(), stop()]);
      if (q.timedOut) return FAIL('stuck', `the reviewer's database gave no answer within ${QUEUE_MS / 1000}s`);
      if (q.error === 'missing') return FAIL('missing', "the reviewer's database was not found: check REVIEW_DB");
      if (q.error === 'locked') return WARN('locked', "the reviewer's database is busy right now; the next run tries again");
      if (q.error === 'no-tables') return FAIL('no-tables', "that file has no review queue in it: check REVIEW_DB");
      if (q.error) return FAIL('unreadable', `the reviewer's database could not be read (${text(q.why, 60)})`);
      const j = q.jobs;
      const undelivered = q.task_results?.pending ?? 0;
      const counts = `${j.queued} queued (${q.due} due), ${j.running} running, ${j.failed} failed, ${undelivered} result(s) undelivered`;
      const age = q.oldest_due_ms ?? 0;
      if (age > QUEUE_WARN_MS) {
        // A stop or a pause explains a wait, and has its own line.
        if (s.stopped || q.pause) return OK('held', `${counts}: waiting on the ${s.stopped ? 'stop' : 'pause'}`);
        if (age > QUEUE_FAIL_MS) return FAIL('stuck', `${counts}: the oldest has waited ${ageText(age)}`);
        return WARN('slow', `${counts}: the oldest has waited ${ageText(age)}`);
      }
      if (q.failed_last_day) return WARN('failed-recently', `${counts}: ${q.failed_last_day} gave up in the last day. reviewer/main.js retry <pr> runs one again`);
      return OK('ok', counts);
    },

    // A usage limit lifts by itself, so it is a WARN. A sign-in failure waits for the operator however long it takes, so it is a FAIL.
    'review-pause': async () => {
      const q = await queue();
      if (q.timedOut || q.error) return WARN('unknown', 'whether reviews are paused could not be read: see the review-queue line');
      if (!q.pause_known) return OK('no-table', 'not paused: the reviewer has not recorded a pause yet');
      if (!q.pause) return OK('running', 'real reviews are not paused');
      if (q.pause.kind === 'auth') return FAIL('auth', 'real reviews are paused until the operator fixes the sign-in, then restarts the reviewer or runs retry');
      const until = q.pause.until ? iso(q.pause.until) : 'an unknown time';
      return WARN(q.pause.kind, `real reviews are paused (${q.pause.kind}) until ${until}, and that lifts by itself`);
    },

    // In the job this rotates; in the report it only looks.
    logs: async (signal) => {
      const r = job ? await p.rotateLogs(signal) : await p.scanLogs();
      if (r.folder === 'missing') return OK('no-folder', 'no log folder yet');
      if (r.folder !== 'ok') return FAIL('not-a-folder', 'the log folder is not a real folder, so nothing was rotated');
      const size = `${r.files} log(s), largest ${mb(r.largest)}`;
      if (r.failed?.length) return FAIL('rotate-failed', `${size}: ${r.failed.length} could not be rotated (${text(r.failed[0], 60)})`);
      if (r.skipped) return WARN('skipped', `${size}: left alone ${r.skipped} that is a symlink, a hard link or not a file`);
      if (job) return OK('ok', `${size}, ${r.rotated.length} rotated`);
      return OK('ok', `${size}, ${r.over.length} over the limit for the job to rotate`);
    },

    // In the job, the gap since the run before: this run is the proof it is alive, and a gap after a sleep is nobody's failure.
    // In the report, whether the job is keeping up. Nothing else can say so: a dead job raises no notification about itself.
    'health-job': async () => {
      const last = await p.lastStatus();
      const lastAt = last && !last.unreadable ? Date.parse(last.at) : NaN;
      const age = nowMs - lastAt;
      if (job) {
        if (!last) return OK('first-run', 'this is the first recorded run');
        if (Number.isNaN(lastAt)) return WARN('unreadable', 'the previous status could not be read: it is replaced now, and what was notified is forgotten');
        if (age > OVERDUE_MS) return WARN('gap', `the previous run was ${ageText(age)} ago: asleep, logged out, or the job was down`);
        return OK('on-time', `the previous run was ${ageText(age)} ago`);
      }
      const svc = await p.service(LABELS.health);
      if (!svc.installed && !svc.loaded) return WARN('not-installed', 'the health job is not installed, so nothing checks this between runs by hand: service/health-service.sh install');
      if (svc.known && !svc.loaded) return FAIL('not-loaded', 'the health job is installed but launchd has not loaded it');
      if (!last) return FAIL('no-status', 'the health job is installed but has recorded no run');
      if (Number.isNaN(lastAt)) return FAIL('unreadable', 'the health job is installed but its status file could not be read');
      if (age > OVERDUE_MS) return FAIL('overdue', `the health job last ran ${ageText(age)} ago, and it should run every ${JOB_EVERY_MS / MINUTE}m`);
      return OK('on-time', `last ran ${ageText(age)} ago`);
    },
  };
}

// One check, whatever happens to it: a line by its deadline. A broken check says so and the rest go on.
async function guarded(name, fn, timeoutMs) {
  const ac = new AbortController();
  let timer;
  const late = new Promise((done) => {
    timer = setTimeout(() => {
      ac.abort();
      done(FAIL('timed-out', `the check gave no answer within ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });
  let r;
  try {
    r = await Promise.race([Promise.resolve().then(() => fn(ac.signal)), late]);
  } catch (err) {
    r = FAIL('check-broke', `the check itself failed (${text(err?.code ?? err?.name ?? 'unknown', 40)})`);
  } finally {
    clearTimeout(timer);
  }
  return { check: name, level: r.level, state: text(r.state, 80), detail: text(r.detail), ...(r.remind ? { remind: true } : {}) };
}

// In parallel, so one slow check never makes another late, and in report order. A simulated failure stands in for that one check, so
// its real probe is not run and no real service is touched. It can only ever produce a FAIL: there is no way to make a check pass.
export function runChecks(checks, { simulate = null, timeoutMs = CHECK_MS, logsTimeoutMs = LOGS_CHECK_MS } = {}) {
  return Promise.all(Object.entries(checks).map(([name, fn]) => {
    if (name === simulate) return guarded(name, () => FAIL('simulated', 'SIMULATED failure from a drill: the real check was not run'), timeoutMs);
    return guarded(name, fn, name === 'logs' ? logsTimeoutMs : timeoutMs);
  }));
}

export const worstLevel = (lines) => (lines.some((l) => l.level === 'FAIL') ? 'FAIL' : lines.some((l) => l.level === 'WARN') ? 'WARN' : 'OK');

const countLevels = (lines) => Object.fromEntries(['OK', 'WARN', 'FAIL'].map((level) => [level, lines.filter((l) => l.level === level).length]));

export const formatLine = (l) => `${l.level.padEnd(4)}  ${l.check.padEnd(15)}  ${l.detail}`;

// --- not nagging -------------------------------------------------------------
// What has been said is remembered in the status file itself, under `alerts`: for each check now alerting, its level, its state, since
// when, and when a person was last told. It survives restarts and reboots. Losing it costs one repeat of what is failing, nothing more.
//
//   A FAIL, or a WARN that asks with `remind`, notifies once when it appears and once when its level or state changes.
//   A FAIL still there a day after that is raised again; a reminder, after a week.
//   Once it clears, one more notification says so, and it is forgotten.
//   If a notification could not be shown it stays due, so it is tried again on the next run.
//
// All of it in one notification per run, so a reboot that fails five checks is one message rather than five.
export function planNotifications(previous, lines, nowMs, { failAgainMs = FAIL_AGAIN_MS, remindAgainMs = REMIND_AGAIN_MS } = {}) {
  const prev = previous !== null && typeof previous === 'object' ? previous : {};
  const shown = {}; // the memory if this notification reaches someone
  const unshown = {}; // and if it does not
  const fresh = [];
  const again = [];
  const recovered = [];
  for (const line of lines) {
    const before = Object.hasOwn(prev, line.check) ? prev[line.check] : null;
    if (line.level !== 'FAIL' && !line.remind) {
      if (before) {
        recovered.push(line);
        unshown[line.check] = before;
      }
      continue;
    }
    const entry = { level: line.level, state: line.state, since: before?.since ?? iso(nowMs) };
    const told = Date.parse(before?.notified_at);
    if (!before || before.level !== line.level || before.state !== line.state || Number.isNaN(told)) {
      fresh.push(line);
      shown[line.check] = { ...entry, notified_at: iso(nowMs) };
      unshown[line.check] = { ...entry, notified_at: null };
    } else if (nowMs - told >= (line.level === 'FAIL' ? failAgainMs : remindAgainMs)) {
      again.push(line);
      shown[line.check] = { ...entry, notified_at: iso(nowMs) };
      unshown[line.check] = { ...entry, notified_at: before.notified_at };
    } else {
      shown[line.check] = { ...entry, notified_at: before.notified_at };
      unshown[line.check] = shown[line.check];
    }
  }
  const failing = lines.filter((l) => l.level === 'FAIL').length;
  const parts = [];
  const raised = [...fresh, ...again];
  if (raised.length === 1) parts.push(`${again.length ? 'still: ' : ''}${raised[0].check}: ${raised[0].detail}`);
  else if (raised.length) parts.push(raised.map((l) => l.check).join(', '));
  if (recovered.length) parts.push(`recovered: ${recovered.map((l) => l.check).join(', ')}`);
  const title = failing ? `Adabra health: ${failing} failing` : raised.length ? 'Adabra health: please look' : 'Adabra health: recovered';
  return { due: parts.length > 0, title, message: text(parts.join('. '), 240), shown, unshown, fresh, again, recovered };
}

// Best effort and bounded. False if it could not be shown, which keeps it due. A true only means macOS took it: it may sit behind Do
// Not Disturb, and nobody may be looking. Plain `display notification`, the helper's own command: never System Events.
export function realNotify({ env = process.env, platform = process.platform, tool = runTool } = {}) {
  return async (title, message) => {
    const c = notifyCommand(title, message, { platform, env });
    if (!c) return false;
    const r = await tool(c.file, c.args, { env: c.options.env ?? env, timeoutMs: NOTIFY_MS });
    return r.code === 0;
  };
}

// --- the status file ---------------------------------------------------------
// Replaced whole (shared/stop.js: temp, fsync, rename), mode 644, in ~/.adabra-control whichever stop file is in force: this user's own
// job writing its own file, never into the machine folder beside the stop state. Readable by agents running as this user, and not in
// ~/.adabra. Lines, levels, times and states only: a reader can trust there is nothing else in it.
export function readLastStatus(path) {
  let s;
  try {
    s = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' ? null : { unreadable: true };
  }
  const shaped = s !== null && typeof s === 'object' && !Number.isNaN(Date.parse(s.at)) && Array.isArray(s.lines) && s.lines.every((l) => l !== null && typeof l === 'object');
  return shaped ? s : { unreadable: true };
}

const statusDoc = (lines, alerts, nowMs, simulate) => ({
  version: 1,
  at: iso(nowMs),
  next_by: iso(nowMs + OVERDUE_MS), // after this, the job has stopped running: nothing else will say so
  worst: worstLevel(lines),
  counts: countLevels(lines),
  simulated: simulate,
  lines: lines.map(({ check, level, state, detail }) => ({ check, level, state, detail })),
  alerts,
});

// launchd never starts a job that is still running. This is for someone running --job by hand beside it, and only for that: the hard
// deadline ends any run, so a lock older than that belongs to a run that was killed.
export function takeRunLock(path, nowMs, { staleMs = HARD_DEADLINE_MS } = {}) {
  ensureFolder(dirname(path));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(path, 'wx', 0o600));
      return () => rmSync(path, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let held;
    try {
      held = statSync(path).mtimeMs;
    } catch {
      continue; // it has just gone
    }
    if (nowMs - held < staleMs) return null;
    rmSync(path, { force: true });
  }
  return null;
}

function ensureFolder(dir) {
  if (mkdirSync(dir, { recursive: true })) chmodSync(dir, 0o755); // as shared/stop.js does: readable whatever the umask
}

// --- the commands ------------------------------------------------------------
async function reportCommand({ probes, nowMs, out }) {
  const lines = await runChecks(buildChecks(probes, { nowMs }));
  for (const l of lines) out(formatLine(l));
  const c = countLevels(lines);
  out(`${c.OK} OK, ${c.WARN} WARN, ${c.FAIL} FAIL`);
  return c.FAIL ? EXIT_FAILED : 0;
}

// The status is written before the notification is tried, so a stuck notifier cannot hold up the report, and again after with what was
// told. If it cannot be written at all, that is a line of its own, and what was told cannot be remembered: this is the one case where a
// notification repeats on every run, because nothing else is left to say so.
async function jobCommand({ probes, statusFile, nowMs, notify, out, simulate }) {
  let release = () => {};
  try {
    const held = takeRunLock(`${statusFile}.lock`, nowMs);
    if (!held) {
      out(`${iso(nowMs)} another health run is in progress; this one did nothing`);
      return EXIT_BUSY;
    }
    release = held;
  } catch {
    // The folder cannot be written. The report still matters, and the status line below will say so.
  }
  try {
    const previous = await guardedRead(() => probes.lastStatus());
    const lines = await runChecks(buildChecks(probes, { nowMs, job: true }), { simulate });
    const write = (alerts) => writeState(statusFile, statusDoc(lines, alerts, nowMs, simulate));
    let writable = true;
    try {
      write(previous?.alerts ?? {});
    } catch (err) {
      writable = false;
      lines.push({ check: 'status-file', level: 'FAIL', state: 'unwritable', detail: `the status file could not be written (${text(err.code ?? 'failed', 40)})` });
    }
    const plan = planNotifications(previous?.alerts, lines, nowMs);
    const shown = plan.due ? await Promise.resolve().then(() => notify(plan.title, plan.message)).catch(() => false) : true;
    if (plan.due) out(`${iso(nowMs)} notification ${shown ? 'shown' : 'not shown, due again next run'}: ${plan.title}`);
    if (writable) {
      try {
        write(shown ? plan.shown : plan.unshown);
      } catch {
        // The first write said what it found. What was told is forgotten, so at worst this notifies again.
      }
    }
    const c = countLevels(lines);
    out(`${iso(nowMs)} health: ${c.OK} OK, ${c.WARN} WARN, ${c.FAIL} FAIL`);
    for (const l of lines) if (l.level !== 'OK') out(formatLine(l));
    return c.FAIL ? EXIT_FAILED : 0;
  } finally {
    release();
  }
}

async function guardedRead(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

function lastCommand({ statusFile, nowMs, out }) {
  const last = readLastStatus(statusFile);
  if (!last) {
    out(`no health run recorded yet at ${statusFile}`);
    return EXIT_FAILED;
  }
  if (last.unreadable) {
    out(`the status file could not be read: ${statusFile}`);
    return EXIT_FAILED;
  }
  const age = nowMs - Date.parse(last.at);
  out(`last run ${last.at}, ${ageText(age)} ago${last.simulated ? `, a drill of ${text(last.simulated, 40)}` : ''}`);
  for (const l of last.lines) out(formatLine({ check: text(l.check, 40), level: text(l.level, 4), detail: text(l.detail) }));
  out(`status file: ${statusFile}`);
  if (age > OVERDUE_MS) {
    out(`OVERDUE: the job should run every ${JOB_EVERY_MS / MINUTE}m. Is it loaded? service/health-service.sh status`);
    return EXIT_FAILED;
  }
  return last.lines.some((l) => l.level === 'FAIL') ? EXIT_FAILED : 0;
}

// A timer cannot fire while a synchronous call is stuck, and a run launchd thinks is still going stops all later runs. So this waits on
// its own thread and ends the whole process. That leaves the status file as it was, and its time then shows the run did not finish.
export function hardDeadline(ms) {
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData);
    require('node:fs').writeSync(2, 'health: the run reached its hard deadline and is being ended\\n');
    process.kill(process.pid, 'SIGKILL');
  `, { eval: true, workerData: ms, execArgv: [] });
  worker.on('error', () => {}); // a deadline that could not start must not end the report
  worker.unref();
  return worker;
}

export async function healthCommand({
  args = [], env = process.env, home = homedir(), repoDir = REPO_DIR, out = console.log, now = Date.now,
  probes = realProbes({ env, home, repoDir }), notify = realNotify({ env }), deadlineMs = HARD_DEADLINE_MS,
} = {}) {
  let o;
  try {
    o = parseArgs({ args, options: { job: { type: 'boolean' }, last: { type: 'boolean' }, 'simulate-fail': { type: 'string' } } }).values;
  } catch {
    out(USAGE);
    return EXIT_USAGE;
  }
  const simulate = o['simulate-fail'] ?? null;
  if ((simulate !== null && !o.job) || (o.last && (o.job || simulate !== null))) {
    out(USAGE);
    return EXIT_USAGE;
  }
  const statusFile = healthStatusPath(env, home);
  const nowMs = now();
  if (o.last) return lastCommand({ statusFile, nowMs, out });
  if (simulate !== null) {
    const names = Object.keys(buildChecks(probes, { nowMs }));
    if (!names.includes(simulate)) {
      out(`no check called ${text(simulate, 40)}. The checks are: ${names.join(', ')}`);
      return EXIT_USAGE;
    }
  }
  const watchdog = deadlineMs ? hardDeadline(deadlineMs) : null;
  try {
    if (o.job) return await jobCommand({ probes, statusFile, nowMs, notify, out, simulate });
    return await reportCommand({ probes, nowMs, out });
  } finally {
    void watchdog?.terminate();
  }
}
