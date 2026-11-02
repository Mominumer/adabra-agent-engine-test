import { constants, ftruncateSync, readSync, writeSync } from 'node:fs';
import { lstat, open, readdir, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';

// Keeps ~/Library/Logs/adabra-*.log from growing without limit, with no service restarted. It runs inside the health job: see ops/health.js.
//
// launchd holds each log open for the service's whole life, so renaming one would only make the service go on writing to the renamed
// file. So the bytes are copied out and the same file is truncated in place: its inode and mode do not change, and launchd opens logs
// for appending, so the next write lands at the new start of the file.
//
// What can be lost: anything written between the last read of the copy and the truncate. That gap is one read and one truncate with
// nothing in between, so at most a line or two, once per rotation. That is accepted: the alternative is restarting the services.
//
// These files hold untrusted PR output. They are only ever copied as bytes: nothing here parses them or prints a byte of them.
export const ROTATE_OVER_BYTES = 10 * 1024 * 1024;
export const KEEP_ROTATED = 3;
const LOG_RE = /^adabra-.+\.log$/; // adabra-x.log.1 does not match, so a rotated file is never rotated again
const TEMP_RE = /^adabra-.+\.log\.rotating$/;
const CHUNK = 1024 * 1024;
const CATCH_UP_LIMIT = 64 * 1024 * 1024;
const OPEN_LOG = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const CREATE_COPY = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

const problem = (code) => Object.assign(new Error(code), { code });

// Looks and changes nothing. Only lstat, so a symlink is seen as one and never followed. A symlinked log folder is refused outright.
export async function scanLogs(dir, { maxBytes = ROTATE_OVER_BYTES } = {}) {
  const scan = { folder: 'ok', files: 0, largest: 0, over: [], skipped: 0, temps: [] };
  let info;
  try {
    info = await lstat(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { ...scan, folder: 'missing' };
    throw err;
  }
  if (!info.isDirectory()) return { ...scan, folder: 'not-a-folder' };
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (TEMP_RE.test(e.name)) scan.temps.push(e.name);
    if (!LOG_RE.test(e.name)) continue;
    if (!e.isFile()) {
      scan.skipped += 1;
      continue;
    }
    const { size } = await lstat(join(dir, e.name));
    scan.files += 1;
    scan.largest = Math.max(scan.largest, size);
    if (size > maxBytes) scan.over.push(e.name);
  }
  return scan;
}

async function writeAll(handle, buf, length) {
  for (let done = 0; done < length;) done += (await handle.write(buf, done, length - done)).bytesWritten;
}

function writeAllSync(fd, buf, length) {
  for (let done = 0; done < length;) done += writeSync(fd, buf, done, length - done);
}

// Whatever arrived during the copy. Synchronous, so nothing else runs between its last read and the truncate.
function copyRest(from, to, start) {
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = start;
  while (pos - start < CATCH_UP_LIMIT) {
    const n = readSync(from, buf, 0, CHUNK, pos);
    if (!n) return;
    writeAllSync(to, buf, n);
    pos += n;
  }
}

const moveIfThere = (from, to) => rename(from, to).catch((err) => {
  if (err.code !== 'ENOENT') throw err;
});

// Returns 'rotated', 'unchanged' or 'skipped'. Everything is checked on the open file, not on the name, which could have changed.
async function rotateOne(dir, name, { maxBytes, keep, signal }) {
  const path = join(dir, name);
  let log;
  try {
    log = await open(path, OPEN_LOG);
  } catch (err) {
    if (err.code === 'ELOOP') return 'skipped'; // it became a symlink since the scan
    throw err;
  }
  try {
    const st = await log.stat();
    if (!st.isFile() || st.nlink !== 1) return 'skipped'; // truncating a hard link would empty a file that may live elsewhere
    if (st.size <= maxBytes) return 'unchanged';
    const { bavail, bsize } = await statfs(dir);
    if (bavail * bsize < st.size) throw problem('not enough free disk for the copy');
    const temp = `${path}.rotating`;
    const mode = st.mode & 0o777;
    await rm(temp, { force: true });
    const copy = await open(temp, CREATE_COPY, mode);
    let placed = false;
    try {
      await copy.chmod(mode); // no wider or narrower than the log itself, whatever the umask
      const buf = Buffer.allocUnsafe(CHUNK);
      let pos = 0;
      for (;;) {
        if (signal?.aborted) throw problem('timed out');
        const { bytesRead } = await log.read(buf, 0, CHUNK, pos);
        if (!bytesRead) break;
        await writeAll(copy, buf, bytesRead);
        pos += bytesRead;
      }
      for (let i = keep - 1; i >= 1; i--) await moveIfThere(`${path}.${i}`, `${path}.${i + 1}`);
      await rename(temp, `${path}.1`);
      placed = true;
      copyRest(log.fd, copy.fd, pos);
      ftruncateSync(log.fd, 0);
      await copy.sync();
    } finally {
      await copy.close();
      if (!placed) await rm(temp, { force: true });
    }
    return 'rotated';
  } finally {
    await log.close();
  }
}

// One file's failure never stops the rest. The result holds names and counts; a failure is only a system code or a fixed text.
export async function rotateLogs(dir, { maxBytes = ROTATE_OVER_BYTES, keep = KEEP_ROTATED, signal } = {}) {
  const scan = await scanLogs(dir, { maxBytes });
  const result = { folder: scan.folder, files: scan.files, largest: scan.largest, skipped: scan.skipped, rotated: [], failed: [] };
  if (scan.folder !== 'ok') return result;
  for (const name of scan.temps) await rm(join(dir, name), { force: true }).catch(() => {}); // left by a run that was killed
  for (const name of scan.over) {
    try {
      const outcome = await rotateOne(dir, name, { maxBytes, keep, signal });
      if (outcome === 'rotated') result.rotated.push(name);
      if (outcome === 'skipped') result.skipped += 1;
    } catch (err) {
      result.failed.push(err.code ?? 'failed');
    }
  }
  return result;
}
