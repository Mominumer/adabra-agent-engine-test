import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readStop } from '../shared/stop.js';
import { OPT, readPaths } from './review-check.js';
import { ReviewStore } from './store.js';

// What the two commands that spend on purpose share: the live check and the seeded run. Both ask before they start, both refuse in the same
// situations, and neither prints what came back. Raw output can quote hostile text, so it only goes to files of mode 600, outside any repo.

// A credential must not end up in a file of the dispatcher's user, even if a review did somehow get hold of one.
const CREDENTIAL_SHAPE = /sk-ant-[\w-]+/g;
export const looksLikeCredential = (text) => String(text).search(CREDENTIAL_SHAPE) >= 0;
const redact = (text) => String(text).replace(CREDENTIAL_SHAPE, '[redacted]');

// Where local results go, made private. Refuses anywhere inside a git checkout, so none of this can be committed by accident.
export function runsDir(env = process.env, home = homedir) {
  const dir = resolve(env.REVIEW_RUNS_DIR?.trim() || join(home(), '.adabra-review-runs'));
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) throw new Error(`${dir} is inside a git checkout: set REVIEW_RUNS_DIR to a folder outside it`);
    if (dirname(d) === d) break;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

const PRIVATE = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW;

function writePrivate(path, flags, text) {
  const fd = openSync(path, PRIVATE | flags, 0o600);
  try {
    writeSync(fd, redact(text));
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

// Whole or not at all, so a run killed halfway leaves the last complete copy. Returns the path.
export function saveLocal(dir, name, text) {
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writePrivate(tmp, constants.O_TRUNC, text);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return path;
}

export function appendLocal(path, text) {
  writePrivate(path, constants.O_APPEND, text);
}

// The database the service counts in, because that is the cap these runs must count against. Never a new empty one, which would count
// nothing: that is what the service's own folder, written down by the installer, is for.
export function openServiceStore({ env = process.env, opt = OPT } = {}) {
  const path = env.REVIEW_DB?.trim() || join(readPaths(opt).SERVICE_DIR, 'reviewer.db');
  if (!existsSync(path)) throw new Error(`${path} does not exist: set REVIEW_DB to the service's database`);
  return new ReviewStore(path);
}

// Why no paid run may start now, or null.
export function spendRefusal({ opt = OPT, store, now = Date.now(), stop = readStop() }) {
  if (stop.stopped) return 'the emergency stop is in force';
  if (!existsSync(join(opt, 'etc', 'model-enabled'))) return 'the model step is off: sudo service/review-user.sh install --enable-model turns it on';
  const pause = store.reviewPause(now);
  if (pause) return `real reviews are paused (${pause.kind}) ${pause.until ? `until ${new Date(pause.until).toISOString()}` : 'until retry or a restart of the service'}`;
  return null;
}

// Says what it is about to spend, whichever way it was allowed to. True to go on.
export async function agreedToSpend({ yes, terminal, confirm, say, statement }) {
  say(statement);
  if (yes) return true;
  if (terminal && (await confirm('Type "spend" to start: ', 'spend'))) return true;
  say('Not confirmed. Nothing was spent.');
  return false;
}

// Where a finding sits, as seen from the job directory, against where a defect is. Near enough, as a model may name the start of the
// statement or function. Only ever compares: a finding's text is not looked at.
export const LINE_WINDOW = 5;
const treePath = (file, jobDir) => {
  if (typeof file !== 'string') return null;
  let p = file;
  if (jobDir && p.startsWith(`${jobDir}/`)) p = p.slice(jobDir.length + 1);
  if (p.startsWith('./')) p = p.slice(2);
  return p.startsWith('tree/') ? p.slice(5) : p;
};
export const findingAt = (finding, { file, line }, jobDir = null) =>
  treePath(finding?.file, jobDir) === file && Number.isInteger(finding.line) && Math.abs(finding.line - line) <= LINE_WINDOW;

// The line of `text` holding `match`, from 1.
export function lineOf(text, match) {
  const at = text.split('\n').findIndex((l) => l.includes(match));
  if (at < 0) throw new Error(`nothing in this file matches ${match}`);
  return at + 1;
}
