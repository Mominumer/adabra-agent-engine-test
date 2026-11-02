// Turns GitHub's tarball of a commit into a tree that is safe to put in front of the review step. It runs inside a throwaway
// sandbox container with the tarball on stdin. It never runs PR code and never touches a disk: it reads headers and file
// bytes, keeps what is allowed, and writes a plain tar of regular files to stdout. The last line on stderr is a JSON report
// of what was dropped and why. It imports nothing from this repository, because its text is passed to `node -e`.
//
// Dropped: anything that is not a regular file (symlink, hardlink, device, fifo), unsafe paths (absolute, `..`, control or
// invisible characters), agent config at any depth, binaries, and files over the limits.
// Exit codes: 0 done, 2 the archive cannot be read, 3 it is too large once unpacked.
'use strict';
const zlib = require('node:zlib');

const MAX_FILE = 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_UNPACKED = 1024 * 1024 * 1024;
const MAX_META = 1024 * 1024;
const MAX_REPORTED = 500;
const BINARY_WINDOW = 8192;

// Compared after folding, because the host's disk ignores case and Unicode form, so AGENTS.md, agents.md and AGENTſ.md
// (a long s) can all open as one file. NFKC is broader than the disk's rule, which only ever drops more.
const AGENT_CONFIG = new Set(['.claude', 'claude.md', 'claude.local.md', 'agents.md', '.mcp.json']);
const fold = (s) => s.normalize('NFKC').toLowerCase().normalize('NFKC');

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

class Input {
  constructor(source) {
    this.it = source[Symbol.asyncIterator]();
    this.buf = Buffer.alloc(0);
    this.unpacked = 0;
  }

  async more() {
    const { value, done } = await this.it.next();
    if (done) return false;
    this.unpacked += value.length;
    if (this.unpacked > MAX_UNPACKED) fail(3, 'source is too large once unpacked');
    this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : value;
    return true;
  }

  // Exactly n bytes, or null at the end of the input.
  async take(n) {
    while (this.buf.length < n) if (!(await this.more())) return null;
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  // Consumes a file body and its padding, keeping at most `keep` bytes, so a file that is being dropped is never held.
  async body(size, keep) {
    const kept = [];
    let have = 0;
    let left = size + ((512 - (size % 512)) % 512);
    let dataLeft = size;
    while (left > 0) {
      if (!this.buf.length && !(await this.more())) fail(2, 'archive ends in the middle of a file');
      const piece = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(piece.length);
      left -= piece.length;
      const data = piece.subarray(0, Math.max(0, Math.min(piece.length, dataLeft)));
      dataLeft -= data.length;
      if (have < keep && data.length) {
        const part = data.subarray(0, keep - have);
        kept.push(Buffer.from(part));
        have += part.length;
      }
    }
    return Buffer.concat(kept);
  }
}

const field = (h, at, len) => {
  const f = h.subarray(at, at + len);
  const end = f.indexOf(0);
  return end < 0 ? f : f.subarray(0, end);
};

function number(h, at, len) {
  const f = h.subarray(at, at + len);
  if (f[0] & 0x80) {
    if (f[0] !== 0x80) fail(2, 'negative number in a tar header');
    let n = 0;
    for (const byte of f.subarray(1)) n = n * 256 + byte;
    if (!Number.isSafeInteger(n)) fail(2, 'number too large in a tar header');
    return n;
  }
  const s = field(h, at, len).toString('latin1').trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) fail(2, 'bad number in a tar header');
  return Number.parseInt(s, 8);
}

function checksumOk(h) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === number(h, 148, 8);
}

function paxRecords(data) {
  const out = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(32, at);
    if (space < 0) fail(2, 'bad pax record');
    const len = Number(data.subarray(at, space).toString('latin1'));
    if (!Number.isSafeInteger(len) || len <= space - at || at + len > data.length) fail(2, 'bad pax record');
    const record = data.subarray(space + 1, at + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += len;
  }
  return out;
}

// The path inside the commit, as segments, or a reason to drop it. GitHub wraps everything in one top-level directory.
function pathOf(raw) {
  if (raw.includes('�') || /[\\\p{C}]/u.test(raw) || raw.startsWith('/')) return { reason: 'unsafe path' };
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return { reason: 'unsafe path' };
  return { segments: segments.slice(1) };
}

// A ustar header for a regular file with fixed owner, time and mode, or null when the path does not fit the format.
function ustarHeader(path, size) {
  const bytes = Buffer.from(path);
  let name = bytes;
  let prefix = Buffer.alloc(0);
  if (bytes.length > 100) {
    let cut = -1;
    for (let i = bytes.indexOf(47); i >= 0; i = bytes.indexOf(47, i + 1)) {
      if (i <= 155 && bytes.length - i - 1 <= 100) {
        cut = i;
        break;
      }
    }
    if (cut < 0) return null;
    prefix = bytes.subarray(0, cut);
    name = bytes.subarray(cut + 1);
  }
  const h = Buffer.alloc(512);
  name.copy(h, 0);
  h.write('0000640\0', 100, 'latin1');
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write('0', 156, 'latin1');
  h.write('ustar\0' + '00', 257, 'latin1');
  prefix.copy(h, 345);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

const LINK_OR_DEVICE = { 1: 'hardlink', 2: 'symlink', 3: 'device', 4: 'device', 6: 'fifo' };

async function clean(input) {
  const output = [];
  const fileKeys = new Set();
  const dirKeys = new Set();
  const dropped = [];
  let droppedTotal = 0;
  let total = 0;
  let longPath = null;
  let longSize = null;

  const drop = (path, reason) => {
    droppedTotal++;
    if (dropped.length < MAX_REPORTED) dropped.push({ path: path.slice(0, 200), reason });
  };

  for (;;) {
    const h = await input.take(512);
    if (!h) fail(2, 'archive has no end marker');
    if (h.every((b) => b === 0)) break;
    if (!checksumOk(h)) fail(2, 'bad checksum in a tar header');

    const type = String.fromCharCode(h[156]);
    const headerSize = number(h, 124, 12);
    if (type === 'x' || type === 'g' || type === 'L' || type === 'K') {
      if (headerSize > MAX_META) fail(2, 'tar metadata entry is too large');
      const data = await input.body(headerSize, MAX_META);
      if (type === 'x') {
        const records = paxRecords(data);
        if (records.path !== undefined) longPath = records.path;
        if (records.size !== undefined) {
          longSize = Number(records.size);
          if (!Number.isSafeInteger(longSize) || longSize < 0) fail(2, 'bad size in a pax record');
        }
      } else if (type === 'L') {
        longPath = field(data, 0, data.length).toString('utf8');
      }
      continue;
    }

    const name = field(h, 0, 100);
    // Only POSIX ustar has a prefix here: the GNU format, with "ustar " as its magic, keeps other data in those bytes.
    const posix = h.subarray(257, 263).toString('latin1') === 'ustar\0';
    const prefix = posix ? field(h, 345, 155) : Buffer.alloc(0);
    const raw = longPath ?? (prefix.length ? `${prefix.toString('utf8')}/${name.toString('utf8')}` : name.toString('utf8'));
    const size = longSize ?? headerSize;
    longPath = null;
    longSize = null;

    if (LINK_OR_DEVICE[type]) {
      drop(raw, LINK_OR_DEVICE[type]);
      continue; // these types carry no data
    }
    if (type === '5') continue; // the tree is built from the files; an empty directory has nothing to review

    const isFile = type === '0' || type === '\0' || type === '7';
    const { segments, reason } = isFile ? pathOf(raw) : { reason: 'unsupported entry type' };
    let refusal = reason ?? null;
    if (!refusal && !segments.length) refusal = 'unsafe path';
    let keys = null;
    let path = null;
    if (!refusal) {
      path = segments.join('/');
      keys = segments.map((_, i) => fold(segments.slice(0, i + 1).join('/')));
      if (segments.some((s) => AGENT_CONFIG.has(fold(s)))) refusal = 'agent config';
      else if (keys.slice(0, -1).some((k) => fileKeys.has(k)) || fileKeys.has(keys.at(-1)) || dirKeys.has(keys.at(-1))) refusal = 'path conflict';
      else if (size > MAX_FILE) refusal = 'file too large';
      else if (fileKeys.size >= MAX_FILES) refusal = 'over the file limit';
      else if (total + size > MAX_TOTAL) refusal = 'over the size limit';
    }

    const data = await input.body(size, refusal ? 0 : size);
    let header = null;
    if (!refusal) {
      if (data.subarray(0, BINARY_WINDOW).includes(0)) refusal = 'binary';
      else if (!(header = ustarHeader(path, size))) refusal = 'path too long';
    }
    if (refusal) {
      drop(raw, refusal);
      continue;
    }

    fileKeys.add(keys.at(-1));
    for (const k of keys.slice(0, -1)) dirKeys.add(k);
    total += size;
    output.push(header, data);
    if (size % 512) output.push(Buffer.alloc(512 - (size % 512)));
  }

  output.push(Buffer.alloc(1024));
  return { output, report: { kept: fileKeys.size, bytes: total, dropped_total: droppedTotal, dropped } };
}

async function main() {
  const gunzip = zlib.createGunzip();
  process.stdin.pipe(gunzip);
  let result;
  try {
    result = await clean(new Input(gunzip));
  } catch {
    fail(2, 'not a readable gzip archive');
  }
  for (const chunk of result.output) {
    if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once('drain', resolve));
  }
  await new Promise((resolve) => process.stdout.end(resolve));
  process.stderr.write(`${JSON.stringify(result.report)}\n`, () => process.exit(0));
}

main();
