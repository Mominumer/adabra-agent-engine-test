import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { operatorText, plain } from './sanitize.js';

// The operator's emergency stop is one small file. No service owns it, so it can be set with any service down and each service
// reads it for itself. It is outside ~/.adabra because agents are denied that folder and a health check must be able to read
// this. It is on disk, so a stop stays in force across restarts and reboots until someone resumes.
//
// There is one for the whole machine once /opt/adabra-control exists. Without it each user would have their own, in a home folder
// the others may not be able to enter: a process running as anyone else would find no file, read that as running and miss the
// operator's stop. Which file is in force is worked out on every read, so a process already running this code needs no restart
// when the folder appears. service/ops.sh switch-stop makes the folder: see the README.
//
// Anyone may read it and only its owner may write it: a later separate builder user can check it but not change it. So a reason
// must never hold a secret.
//
// Reading fails safe. A well-formed "not stopped" means running, and so does "no file yet" outside the machine folder, which is a
// machine with no stop feature set up. Anything else counts as stopped, and that includes no file inside the machine folder.
//
// One gap: if the folder is ever removed, the default falls back to the per-user file, where no file reads as running. So a later
// unattended service must name /opt/adabra-control/stop.json in its own settings, pass that to readStop({ path }), where a missing
// file counts as stopped with or without the folder, and refuse to start if it is missing. Nothing does that yet.
//
// A long-running job (the overnight runner, say) checks before it starts anything and between steps, either way:
//   service/ops.sh check                    exit 0 = go; any other exit = do not start. Prints one line of JSON.
//   import { isStopped } from 'shared/stop.js'
export const RUNNING = Object.freeze({ stopped: false });
const NO_REASON = 'no reason given';
const UNREADABLE = 'the stop state could not be read, so everything stays stopped until the operator runs resume';
const MISSING = 'the machine-wide stop state is missing, so everything stays stopped until the operator runs resume';

export const MACHINE_DIR = '/opt/adabra-control';

export const perUserStopFile = (home = homedir) => join(home(), '.adabra-control', 'stop.json');

// machineDir is only ever passed by tests, so that nothing they do depends on the real folder.
export const stopFilePath = (env = process.env, home = homedir, machineDir = MACHINE_DIR) =>
  env.ADABRA_STOP_FILE?.trim() || (existsSync(machineDir) ? join(machineDir, 'stop.json') : perUserStopFile(home));

const failSafe = (why, reason = UNREADABLE) => ({ stopped: true, unreadable: String(why), reason, since: null });
const isoOrNull = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

// Never throws. { stopped: false } or { stopped: true, reason, since, by, from }, plus `unreadable` when it failed safe.
export function readStop({ path, machineDir = MACHINE_DIR } = {}) {
  const file = path ?? stopFilePath(undefined, undefined, machineDir);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') return failSafe(err.code ?? err.message);
    return dirname(resolve(file)) === resolve(machineDir) ? failSafe('file missing', MISSING) : RUNNING;
  }
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    return failSafe('not JSON');
  }
  if (s === null || typeof s !== 'object' || typeof s.stopped !== 'boolean') return failSafe('unexpected contents');
  if (!s.stopped) return { stopped: false, last_stop: s.last_stop ?? null };
  return {
    stopped: true,
    reason: operatorText(s.reason) || NO_REASON,
    since: isoOrNull(s.since),
    by: plain(s.by ?? '').slice(0, 40),
    from: plain(s.from ?? '').slice(0, 40),
  };
}

export const isStopped = (options) => readStop(options).stopped;

// Whole or not at all, and on disk before this returns, so a power cut leaves the old state or the new one.
export function writeState(path, state) {
  const dir = dirname(path);
  // Readable whatever the umask (the README's token steps leave a shell at 077): a health check or another user must be able to read it.
  if (mkdirSync(dir, { recursive: true })) chmodSync(dir, 0o755);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const fd = openSync(tmp, 'w', 0o644);
    try {
      writeSync(fd, `${JSON.stringify(state, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o644);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  try {
    const d = openSync(dir, 'r');
    fsyncSync(d);
    closeSync(d);
  } catch {
    // Not every filesystem lets a directory be synced. The rename itself has happened.
  }
}

// A stop already in force is left alone, so a second caller cannot rewrite the first one's reason or when it began.
// A file that cannot be read is replaced: that is the one case where writing a good state helps.
export function recordStop({ reason, by = '', from = '', at = new Date(), machineDir = MACHINE_DIR, path = stopFilePath(undefined, undefined, machineDir) } = {}) {
  const current = readStop({ path, machineDir });
  if (current.stopped && !current.unreadable) return { already: true, state: current };
  writeState(path, { stopped: true, reason: operatorText(reason) || NO_REASON, since: at.toISOString(), by, from });
  return { already: false, state: readStop({ path, machineDir }) };
}

export function recordResume({ at = new Date(), machineDir = MACHINE_DIR, path = stopFilePath(undefined, undefined, machineDir) } = {}) {
  const current = readStop({ path, machineDir });
  const last = current.stopped ? { reason: current.reason, since: current.since, resumed_at: at.toISOString() } : (current.last_stop ?? null);
  writeState(path, { stopped: false, last_stop: last });
  return readStop({ path, machineDir });
}

// What a builder is told, whatever came down the wire: never more than this, and never the file's path.
export const stopBrief = (s) => (s?.stopped ? { stopped: true, reason: s.reason, since: s.since ?? null } : { stopped: false });

// One line for a person or an agent. Applies operatorText again, because this text may have arrived over the network.
export const stopLine = (s) =>
  `STOPPED by the operator${s.since ? ` since ${plain(s.since)}` : ''}: ${operatorText(s.reason) || NO_REASON}`;

// For a service: logs each change of state, and calls whileStopped on every pass while stopped.
export function watchStop({ read = readStop, intervalMs = 5000, log = () => {}, whileStopped = () => {} } = {}) {
  let was = false;
  let busy = false;
  const pass = async () => {
    if (busy) return;
    busy = true;
    try {
      const s = read();
      if (s.stopped !== was) log(s.stopped ? `${stopLine(s)}${s.unreadable ? ` (${s.unreadable})` : ''}` : 'stop lifted: the operator resumed');
      was = s.stopped;
      if (s.stopped) await whileStopped(s);
    } catch (err) {
      log(`stop watch pass failed, will try again: ${err.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void pass(), intervalMs);
  timer.unref?.();
  return { pass, stop: () => clearInterval(timer) };
}
