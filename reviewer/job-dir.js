import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { readCleanTar } from './tar.js';

// The read-only directory the review step works in. The dispatcher's user owns the job root, and the review user reaches it
// only through the root's group, which everything created inside inherits. So the review user can read a job and cannot
// change it, and there is no directory both users can write to.
export const JOB_ROOT = '/opt/adabra-review/in';
export const JOB_ID_RE = /^[1-9][0-9]{0,8}-[0-9a-f]{40}-[0-9]{10,16}$/;
const BUILDING_RE = /^\.building-[1-9][0-9]{0,8}-[0-9a-f]{40}-[0-9]{10,16}$/;
const DIR_MODE = 0o750;
const FILE_MODE = 0o640;
export const PAID_MARK = 'paid-run';
export const STREAM_MARK = 'stream-output'; // the wrapper then asks the CLI for line-by-line output, which is the only record of what the review read

export function jobId(pr, sha, now = Date.now()) {
  const id = `${pr}-${sha}-${now}`;
  if (!JOB_ID_RE.test(id)) throw new Error('cannot make a job id from this PR and commit');
  return id;
}

function writeNew(path, data) {
  // O_EXCL and O_NOFOLLOW: never through anything already there, and a second file differing only by case is an error.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, FILE_MODE);
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, FILE_MODE); // an owner's explicit mode, whatever the umask is
}

function makeDir(path) {
  try {
    mkdirSync(path, { mode: DIR_MODE });
  } catch (err) {
    // A disk that ignores case makes Src/ and src/ one directory. That is harmless, unless it is not a real directory.
    if (err.code !== 'EEXIST' || !lstatSync(path).isDirectory()) throw err;
  }
  chmodSync(path, DIR_MODE);
}

function writeBelow(dest, path, data, made) {
  const target = join(dest, path);
  const parents = [];
  for (let d = dirname(target); d !== dest; d = dirname(d)) parents.unshift(d);
  for (const d of parents) {
    if (made.has(d)) continue;
    makeDir(d);
    made.add(d);
  }
  writeNew(target, data);
}

// Unpacks only what the cleaning step produced. No owners or modes come from the archive. Returns [{ path, size }].
export function unpackCleanTar(tar, dest) {
  const files = readCleanTar(tar);
  const made = new Set();
  for (const { path, data } of files) writeBelow(dest, path, data, made);
  return files.map(({ path, data }) => ({ path, size: data.length }));
}

// Builds the job under a name the wrapper refuses, then renames it, so the review user can never see a half-written job.
// Returns { id, dir, files }. `report` is the cleaning step's report of what it dropped.
// `paid` writes the mark the wrapper requires before it starts the model, and the one for line-by-line output. Off by default, so a job built for any other
// reason cannot spend. They sit beside tree/, which is the only place PR content goes, so a PR cannot plant them.
// `besideTree` is more files beside tree/, for the live check. No path that takes a PR's content sets it.
export function buildJobDir({ root = JOB_ROOT, pr, sha, tar, report, diff = '', title = '', body = '', task = null, now = Date.now(), paid = false, besideTree = {} }) {
  const id = jobId(pr, sha, now);
  const building = join(root, `.building-${id}`);
  const dir = join(root, id);
  makeDir(building);
  try {
    makeDir(join(building, 'tree'));
    const files = unpackCleanTar(tar, join(building, 'tree'));
    writeNew(join(building, 'diff.patch'), diff);
    writeNew(join(building, 'pr.json'), JSON.stringify({ pr, sha, title, body, task }, null, 2));
    writeNew(join(building, 'manifest.json'), JSON.stringify({
      sha,
      files,
      dropped_total: report?.dropped_total ?? 0,
      dropped: report?.dropped ?? [],
    }, null, 2));
    if (paid) {
      writeNew(join(building, PAID_MARK), '');
      writeNew(join(building, STREAM_MARK), '');
    }
    const made = new Set();
    for (const [path, data] of Object.entries(besideTree)) writeBelow(building, path, data, made);
    renameSync(building, dir);
    return { id, dir, files };
  } catch (err) {
    rmSync(building, { recursive: true, force: true });
    throw err;
  }
}

export function removeJobDir(root, id) {
  if (!JOB_ID_RE.test(id)) throw new Error('not a job id');
  rmSync(join(root, id), { recursive: true, force: true });
}

// Removes jobs left by a crash. Only names this module makes: anything else in the root is not ours to delete.
export function sweepJobDirs(root = JOB_ROOT) {
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (JOB_ID_RE.test(name) || BUILDING_RE.test(name)) {
      rmSync(join(root, name), { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

// Every path below `dir` with its lstat, for checking what was really written.
export function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    out.push({ path: relative(dir, path), stat });
    if (stat.isDirectory()) for (const e of walk(path)) out.push({ path: join(name, e.path), stat: e.stat });
  }
  return out;
}
