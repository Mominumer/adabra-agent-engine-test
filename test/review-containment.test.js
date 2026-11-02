import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Sandbox } from '../reviewer/sandbox.js';
import { buildJobDir, JOB_ID_RE, jobId, removeJobDir, sweepJobDirs, unpackCleanTar, walk } from '../reviewer/job-dir.js';
import { HOSTILE_KEPT, hostileTarball, isSafeTreePath, paxPathEntry, rawTarball, rawTarEntry, readCleanTar } from '../reviewer/tar.js';
import { expectedProbes, judgeProbes, parseProbes, reviewCheck } from '../reviewer/review-check.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(REPO, 'reviewer', 'clean-worker.cjs');
const USER_DIR = join(REPO, 'reviewer', 'review-user');
const FAKE_DOCKER = join(REPO, 'test', 'fixtures', 'fake-docker.js');
const SHA = 'a'.repeat(40);

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-containment-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Runs the cleaning step the way the container does, without Docker.
function cleanWith(tarball) {
  const r = spawnSync(process.execPath, [WORKER], { input: tarball, maxBuffer: 500 * 1024 * 1024 });
  const stderr = r.stderr.toString();
  return {
    code: r.status,
    stderr,
    tar: r.stdout,
    report: r.status === 0 ? JSON.parse(stderr.trim().split('\n').at(-1)) : null,
  };
}

const TOP = 'owner-repo-abc';
const file = (path, body = 'text\n') => rawTarEntry({ name: `${TOP}/${path}`, body: Buffer.from(body) });
const kept = (r) => readCleanTar(r.tar).map((f) => f.path).sort();
const reasonFor = (r, fragment) => r.report.dropped.find((d) => d.path.includes(fragment))?.reason;

// --- the cleaning step ----------------------------------------------------

test('cleaning: the hostile archive keeps only ordinary files, whatever the tricks', () => {
  const r = cleanWith(hostileTarball());
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kept(r), HOSTILE_KEPT);
  assert.equal(reasonFor(r, 'link-out'), 'symlink');
  assert.equal(reasonFor(r, 'link-up'), 'symlink');
  assert.equal(reasonFor(r, '/hardlink'), 'hardlink');
  assert.equal(reasonFor(r, 'char-device'), 'device');
  assert.equal(reasonFor(r, 'block-device'), 'device');
  assert.equal(reasonFor(r, '/fifo'), 'fifo');
  assert.equal(reasonFor(r, '../escape.txt'), 'unsafe path');
  assert.equal(reasonFor(r, 'escape-deep.txt'), 'unsafe path');
  assert.equal(reasonFor(r, '/tmp/absolute.txt'), 'unsafe path');
  assert.equal(reasonFor(r, 'bad\nname'), 'unsafe path');
  assert.equal(reasonFor(r, '/binary.bin'), 'binary');
  assert.equal(reasonFor(r, '/huge.txt'), 'file too large');
  assert.equal(r.report.kept, HOSTILE_KEPT.length);
});

test('cleaning: agent config goes at any depth and in any case, and near misses stay', () => {
  const r = cleanWith(rawTarball([
    file('.claude/settings.json'),
    file('deep/er/.claude/x'),
    file('.Claude/x'),
    file('CLAUDE.md'),
    file('a/claude.md'),
    file('a/CLAUDE.LOCAL.MD'),
    file('AGENTS.md'),
    file('a/Agents.md'),
    file('.mcp.json'),
    file('a/.MCP.JSON'),
    file('CLAUDE.md/inside-a-directory-so-named'),
    file('notes/claude.md.txt'),
    file('claude/README'),
    file('my-agents.md'),
    file('.claude-notes'),
  ]));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kept(r), ['.claude-notes', 'claude/README', 'my-agents.md', 'notes/claude.md.txt']);
  assert.ok(r.report.dropped.every((d) => d.reason === 'agent config'));
  assert.equal(r.report.dropped_total, 11);
});

test('cleaning: a Unicode spelling of a config name that the disk could open as the same file is caught', () => {
  const r = cleanWith(rawTarball([
    file('AGENTſ.md'), // a long s, which case folding turns into s
    file('sub/.mcp.jſon'),
    file('sub/CLAUDＥ.md'), // a fullwidth E
    file('ok.txt'),
    file('café.txt'),
  ]));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kept(r), ['café.txt', 'ok.txt']);
  assert.equal(r.report.dropped_total, 3);
  assert.ok(r.report.dropped.every((d) => d.reason === 'agent config'));
  const invisible = cleanWith(rawTarball([file('.mcp​.json')])); // a zero-width space is invisible, so never kept
  assert.equal(reasonFor(invisible, '.mcp'), 'unsafe path');
});

test('cleaning: invisible and control characters in a name are refused', () => {
  const r = cleanWith(rawTarball([file('a‮b.txt'), file('tab\tname'), file('back\\slash'), file('fine name.txt')]));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kept(r), ['fine name.txt']);
  assert.equal(r.report.dropped_total, 3);
});

test('cleaning: a name that is not valid text is refused', () => {
  const h = rawTarEntry({ name: `${TOP}/plain`, body: Buffer.from('x') });
  const bad = Buffer.from(h);
  bad.write('\xff', TOP.length + 1, 'latin1');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : bad[i];
  bad.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const r = cleanWith(gzipSync(Buffer.concat([bad, Buffer.alloc(1024)])));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kept(r), []);
  assert.equal(r.report.dropped[0].reason, 'unsafe path');
});

test('cleaning: long paths from pax and GNU headers are read correctly, and traversal through them is caught', () => {
  const long = `${TOP}/${'d'.repeat(120)}/${'e'.repeat(90)}.txt`;
  const tooLong = `${TOP}/${'f'.repeat(200)}/${'g'.repeat(200)}.txt`;
  const gnu = `${TOP}/${'h'.repeat(120)}/gnu.txt`;
  const r = cleanWith(rawTarball([
    paxPathEntry(long), rawTarEntry({ name: 'short-name-ignored', body: Buffer.from('long\n') }),
    paxPathEntry(tooLong), rawTarEntry({ name: 'short-name-2', body: Buffer.from('x') }),
    paxPathEntry(`${TOP}/../../pax-escape.txt`), rawTarEntry({ name: `${TOP}/innocent.txt`, body: Buffer.from('x') }),
    paxPathEntry(`${TOP}/.claude/pax.json`), rawTarEntry({ name: `${TOP}/innocent2.txt`, body: Buffer.from('x') }),
    rawTarEntry({ name: '././@LongLink', type: 'L', body: Buffer.from(`${gnu}\0`) }), rawTarEntry({ name: 'gnu-short', body: Buffer.from('gnu\n') }),
    file('after.txt', 'still in step\n'),
  ]));
  assert.equal(r.code, 0, r.stderr);
  const files = readCleanTar(r.tar);
  assert.deepEqual(files.map((f) => f.path).sort(), [long, gnu, `${TOP}/after.txt`].map((p) => p.slice(TOP.length + 1)).sort());
  assert.equal(files.find((f) => f.path.endsWith('.txt') && f.path.includes('eee')).data.toString(), 'long\n');
  assert.equal(reasonFor(r, 'fff'), 'path too long');
  assert.equal(reasonFor(r, 'pax-escape'), 'unsafe path');
  assert.equal(reasonFor(r, 'pax.json'), 'agent config');
});

test('cleaning: a pax size is honoured, so the bytes after it are not read as headers', () => {
  const body = Buffer.alloc(600, 'y');
  const pax = '12 size=600\n';
  const r = cleanWith(rawTarball([
    rawTarEntry({ name: 'PaxHeader/x', type: 'x', body: Buffer.from(pax) }),
    rawTarEntry({ name: `${TOP}/sized.txt`, size: 0, body }),
    file('after.txt'),
  ]));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kept(r), ['after.txt', 'sized.txt']);
  assert.equal(readCleanTar(r.tar).find((f) => f.path === 'sized.txt').data.length, 600);
});

test('cleaning: names that collide on a case-insensitive disk keep the first, and a file cannot also be a directory', () => {
  const r = cleanWith(rawTarball([
    file('Readme.txt', 'first\n'),
    file('README.TXT', 'second\n'),
    file('thing', 'a file\n'),
    file('thing/inside.txt'),
    file('dir/inner.txt'),
    file('dir', 'a file with a directory name\n'),
  ]));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kept(r), ['Readme.txt', 'dir/inner.txt', 'thing']);
  assert.equal(readCleanTar(r.tar).find((f) => f.path === 'Readme.txt').data.toString(), 'first\n');
  assert.ok(r.report.dropped.every((d) => d.reason === 'path conflict'));
});

test('cleaning: limits on one file, the total and the number of files', () => {
  const justFits = Buffer.alloc(1024 * 1024, 'a');
  const oneFile = cleanWith(rawTarball([rawTarEntry({ name: `${TOP}/fits.txt`, body: justFits }), rawTarEntry({ name: `${TOP}/over.txt`, body: Buffer.alloc(justFits.length + 1, 'a') })]));
  assert.deepEqual(kept(oneFile), ['fits.txt']);

  const big = Array.from({ length: 51 }, (_, i) => rawTarEntry({ name: `${TOP}/big-${i}.txt`, body: justFits }));
  const total = cleanWith(rawTarball(big));
  assert.equal(total.code, 0, total.stderr);
  assert.equal(total.report.kept, 50);
  assert.equal(total.report.bytes, 50 * 1024 * 1024);
  assert.equal(reasonFor(total, 'big-50.txt'), 'over the size limit');

  const many = Array.from({ length: 20_002 }, (_, i) => file(`m/${i}.txt`, ''));
  const count = cleanWith(rawTarball(many));
  assert.equal(count.report.kept, 20_000);
  assert.equal(count.report.dropped_total, 2);
  assert.equal(count.report.dropped[0].reason, 'over the file limit');
});

test('cleaning: a binary is judged by a NUL in the first 8 KB only, and the report stays bounded', () => {
  const late = Buffer.concat([Buffer.alloc(8192, 'a'), Buffer.from([0])]);
  const early = Buffer.concat([Buffer.alloc(8191, 'a'), Buffer.from([0])]);
  const r = cleanWith(rawTarball([rawTarEntry({ name: `${TOP}/late.txt`, body: late }), rawTarEntry({ name: `${TOP}/early.bin`, body: early })]));
  assert.deepEqual(kept(r), ['late.txt']);

  const lots = cleanWith(rawTarball(Array.from({ length: 700 }, (_, i) => file(`CLAUDE.md/${'x'.repeat(40)}-${i}`))));
  assert.equal(lots.report.dropped_total, 700);
  assert.equal(lots.report.dropped.length, 500);
});

test('cleaning: damaged or misleading archives fail instead of giving a partial tree', () => {
  assert.equal(cleanWith(Buffer.from('not gzip at all')).code, 2);
  assert.equal(cleanWith(Buffer.alloc(0)).code, 2);
  assert.equal(cleanWith(gzipSync(Buffer.from('short'))).code, 2);

  const good = rawTarEntry({ name: `${TOP}/a.txt`, body: Buffer.alloc(1000, 'a') });
  assert.equal(cleanWith(gzipSync(good)).code, 2, 'no end marker');
  assert.equal(cleanWith(gzipSync(good.subarray(0, 700))).code, 2, 'cut inside a file');

  const damaged = Buffer.from(good);
  damaged[0] ^= 1;
  assert.equal(cleanWith(gzipSync(Buffer.concat([damaged, Buffer.alloc(1024)]))).code, 2, 'bad checksum');

  const truncatedGzip = rawTarball([good]).subarray(0, 40);
  assert.equal(cleanWith(truncatedGzip).code, 2, 'truncated gzip');
});

test('cleaning: an unknown entry type is dropped, and its bytes are skipped', () => {
  const r = cleanWith(rawTarball([rawTarEntry({ name: `${TOP}/weird`, type: 'Z', body: Buffer.from('data') }), file('after.txt')]));
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(kept(r), ['after.txt']);
  assert.equal(reasonFor(r, 'weird'), 'unsupported entry type');
});

test('cleaning: a gzip bomb stops at the unpacked limit without holding it in memory', { timeout: 120_000 }, () => {
  // Repeated gzip members: small to build and to send, more than the limit once unpacked.
  const header = gzipSync(rawTarEntry({ name: `${TOP}/bomb.txt`, size: 2 * 1024 * 1024 * 1024 }).subarray(0, 512));
  const zeroes = gzipSync(Buffer.alloc(64 * 1024 * 1024));
  const r = spawnSync(process.execPath, ['--max-old-space-size=128', WORKER], {
    input: Buffer.concat([header, ...Array.from({ length: 21 }, () => zeroes)]),
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 3, r.stderr.toString());
});

// --- reading the clean result on the host ---------------------------------

const cleanEntry = (over) => rawTarEntry({ name: 'ok.txt', body: Buffer.from('x'), ...over });
const asTar = (...entries) => Buffer.concat([...entries, Buffer.alloc(1024)]);

test('host reader: accepts what the cleaning step writes, byte for byte', () => {
  const body = Buffer.from('some text\n');
  const r = cleanWith(rawTarball([rawTarEntry({ name: `${TOP}/sub/dir/file.txt`, body })]));
  const [f] = readCleanTar(r.tar);
  assert.equal(f.path, 'sub/dir/file.txt');
  assert.deepEqual(Buffer.from(f.data), body);
});

test('host reader: anything but a plain regular file with a safe path is an error, not something to skip', () => {
  assert.throws(() => readCleanTar(asTar(cleanEntry({ name: 'link', type: '2', linkname: '/Users' }))), /other than a regular file/);
  assert.throws(() => readCleanTar(asTar(cleanEntry({ name: 'hard', type: '1', linkname: 'ok.txt' }))), /other than a regular file/);
  assert.throws(() => readCleanTar(asTar(cleanEntry({ name: 'dev', type: '3' }))), /other than a regular file/);
  assert.throws(() => readCleanTar(asTar(cleanEntry({ name: 'dir/', type: '5' }))), /other than a regular file/);
  for (const name of ['../up.txt', 'a/../../up.txt', '/abs.txt', 'a//b.txt', './a.txt', 'a/./b', 'a\\b', 'tab\tname']) {
    assert.throws(() => readCleanTar(asTar(cleanEntry({ name }))), /unsafe path/, name);
  }
  assert.throws(() => readCleanTar(cleanEntry({})), /no end marker/);
  assert.throws(() => readCleanTar(asTar(cleanEntry({ size: 5000 }))), /ends in the middle/);
  const damaged = asTar(cleanEntry({}));
  damaged[10] ^= 1;
  assert.throws(() => readCleanTar(damaged), /bad checksum/);
  assert.throws(() => readCleanTar(Buffer.alloc(0)), /no end marker/);
});

test('isSafeTreePath: the rule the unpacking depends on', () => {
  for (const good of ['a', 'a/b.txt', 'fine name.txt', '.hidden', 'a/.b/c', 'naïve.txt']) assert.ok(isSafeTreePath(good), good);
  for (const bad of ['', '/a', 'a/', '../a', 'a/..', '.', 'a//b', 'a‮b', 'a\nb', 'a\\b', 'a�b', 42, null]) assert.ok(!isSafeTreePath(bad), String(bad));
});

// --- the job directory ----------------------------------------------------

function jobFixture(t, tarball = hostileTarball()) {
  const root = tempDir(t);
  const { tar, report } = cleanWith(tarball);
  const job = buildJobDir({ root, pr: 12, sha: SHA, tar, report, diff: 'the diff\n', title: 'Title', body: 'Body', task: 'TASK-13', now: 1700000000000 });
  return { root, job, report };
}

test('job directory: holds the tree and the inputs, with fixed modes and nothing from the archive', (t) => {
  const { job, report } = jobFixture(t);
  assert.match(job.id, JOB_ID_RE);
  assert.deepEqual(readdirSync(job.dir).sort(), ['diff.patch', 'manifest.json', 'pr.json', 'tree']);
  assert.deepEqual(job.files.map((f) => f.path).sort(), HOSTILE_KEPT);
  assert.equal(readFileSync(join(job.dir, 'diff.patch'), 'utf8'), 'the diff\n');
  assert.deepEqual(JSON.parse(readFileSync(join(job.dir, 'pr.json'), 'utf8')), { pr: 12, sha: SHA, title: 'Title', body: 'Body', task: 'TASK-13' });
  const manifest = JSON.parse(readFileSync(join(job.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sha, SHA);
  assert.equal(manifest.dropped_total, report.dropped_total);
  assert.deepEqual(manifest.files.map((f) => f.path).sort(), HOSTILE_KEPT);
  for (const { path, stat } of walk(job.dir)) {
    assert.ok(stat.isFile() || stat.isDirectory(), `${path} is neither a file nor a directory`);
    assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o750 : 0o640, path);
  }
  assert.equal(lstatSync(job.dir).mode & 0o777, 0o750);
});

test('job directory: modes hold under any umask', (t) => {
  const old = process.umask(0o077);
  t.after(() => process.umask(old));
  const { job } = jobFixture(t);
  for (const { stat, path } of walk(job.dir)) assert.equal(stat.mode & 0o777, stat.isDirectory() ? 0o750 : 0o640, path);
});

test('job directory: a tar the cleaning step did not write leaves nothing behind', (t) => {
  const root = tempDir(t);
  const hostile = asTar(cleanEntry({ name: 'link', type: '2', linkname: '/Users' }));
  assert.throws(() => buildJobDir({ root, pr: 1, sha: SHA, tar: hostile, report: {}, now: 1700000000000 }), /other than a regular file/);
  assert.deepEqual(readdirSync(root), []);
});

test('job directory: unpacking refuses to write through a link or over a file', (t) => {
  const dest = tempDir(t);
  const outside = tempDir(t);
  symlinkSync(outside, join(dest, 'sub'));
  assert.throws(() => unpackCleanTar(asTar(cleanEntry({ name: 'sub/evil.txt' })), dest));
  assert.deepEqual(readdirSync(outside), []);
  writeFileSync(join(dest, 'taken.txt'), 'first');
  assert.throws(() => unpackCleanTar(asTar(cleanEntry({ name: 'taken.txt' })), dest), /EEXIST/);
  symlinkSync(join(outside, 'target'), join(dest, 'dangling'));
  assert.throws(() => unpackCleanTar(asTar(cleanEntry({ name: 'dangling' })), dest));
  assert.ok(!existsSync(join(outside, 'target')));
});

test('job ids: strict, and the wrapper and the dispatcher agree on them', (t) => {
  const { dir, env } = installWrapper(t);
  const good = jobId(7, SHA, 1700000000000);
  assert.equal(good, `7-${SHA}-1700000000000`);
  for (const [pr, sha] of [[0, SHA], [-1, SHA], ['1/..', SHA], [7, 'abc'], [7, 'G'.repeat(40)], [1234567890, SHA]]) {
    assert.throws(() => jobId(pr, sha, 1700000000000), /job id/, `${pr} ${sha}`);
  }
  mkdirSync(join(dir, 'in', good), { recursive: true });
  const cases = [
    [good, 78],
    ['', 64],
    ['../../etc', 64],
    ['$(id)', 64],
    [`0-${SHA}-1700000000000`, 64],
    [`7-${SHA.slice(1)}-1700000000000`, 64],
    [`7-${SHA}-170`, 64],
    [`7-${SHA.toUpperCase()}-1700000000000`, 64],
    [`${good}\nmore`, 64],
    [`more\n${good}`, 64],
    [`${good}-`, 64],
    [`8-${SHA}-1700000000000`, 64],
  ];
  for (const [id, code] of cases) {
    assert.equal(JOB_ID_RE.test(id), code === 78 || id === `8-${SHA}-1700000000000`, `JS rule for ${JSON.stringify(id)}`);
    assert.equal(wrapper(dir, env, [id]).status, code, `wrapper for ${JSON.stringify(id)}`);
  }
});

test('job directory: removal takes only job ids, and the sweep leaves what is not ours', (t) => {
  const { root, job } = jobFixture(t);
  assert.throws(() => removeJobDir(root, '../elsewhere'), /not a job id/);
  assert.throws(() => removeJobDir(root, ''), /not a job id/);
  mkdirSync(join(root, 'keep-me'));
  writeFileSync(join(root, 'keep-me', 'file'), 'x');
  mkdirSync(join(root, `.building-${job.id}`));
  mkdirSync(join(root, '.building-nonsense'));
  assert.equal(sweepJobDirs(root), 2);
  assert.deepEqual(readdirSync(root).sort(), ['.building-nonsense', 'keep-me']);
  assert.equal(sweepJobDirs(join(root, 'does-not-exist')), 0);
});

// --- the sandbox's binary-safe mode ---------------------------------------

function fakeSandbox(t, mode) {
  const dir = tempDir(t);
  const record = join(dir, 'runs.jsonl');
  const sandbox = new Sandbox({ docker: FAKE_DOCKER, env: { ...process.env, FAKE_DOCKER_MODE: mode, FAKE_DOCKER_RECORD: record } });
  return { sandbox, runs: () => readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

test('cleanTree: same locked-down container as the tests, input streamed in, output kept byte for byte', async (t) => {
  const { sandbox, runs } = fakeSandbox(t, 'clean-ok');
  const tarball = Buffer.from('pretend .tar.gz');
  const { tar, report } = await sandbox.cleanTree({ name: 'n', tarball });
  assert.deepEqual(tar, Buffer.from([0, 255, 1, 254, 0, 10, 13]), 'bytes survive unchanged');
  assert.deepEqual(report, { kept: 1, bytes: 7, dropped_total: 0, dropped: [] });
  const [run] = runs();
  assert.equal(Buffer.from(run.stdin, 'base64').toString(), tarball.toString());
  const after = (flag) => run.args[run.args.indexOf(flag) + 1];
  assert.equal(after('--network'), 'none');
  assert.equal(after('--cap-drop'), 'ALL');
  assert.equal(after('--user'), '1000:1000');
  assert.ok(run.args.includes('--read-only'));
  assert.ok(!run.args.includes('-v') && !run.args.includes('--mount'));
  const i = run.args.indexOf('-c');
  assert.equal(run.args[i + 1], 'exec node -e "$1"');
  assert.equal(run.args[i + 3], readFileSync(WORKER, 'utf8'));
});

test('cleanTree: every kind of failure throws, and the source problems say so', async (t) => {
  const outcomes = [
    ['clean-unreadable', 'UNREADABLE'],
    ['clean-too-large', 'TOO_LARGE'],
    ['oom', 'TOO_LARGE'],
    ['docker-error', undefined],
    ['fail', undefined],
    ['clean-no-report', undefined],
    ['clean-bad-report', undefined],
  ];
  for (const [mode, code] of outcomes) {
    const { sandbox } = fakeSandbox(t, mode);
    await assert.rejects(sandbox.cleanTree({ name: 'n', tarball: Buffer.from('x') }), (err) => err.code === code, mode);
  }
});

test('cleanTree: stops a container that writes too much or runs too long', async (t) => {
  const { sandbox } = fakeSandbox(t, 'hang');
  await assert.rejects(sandbox.cleanTree({ name: 'n', tarball: Buffer.from('x'), timeoutMs: 100 }), /timed out/);
  const big = fakeSandbox(t, 'clean-flood');
  const r = await big.sandbox.exec({ name: 'n', script: 's', stdoutLimit: 1000 });
  assert.equal(r.overflow, true);
  assert.equal(r.stdout.length, 0, 'an over-limit result is never used');
});

test('exec without stdoutLimit is unchanged: output goes to the log and there is no stdout field', async (t) => {
  const { sandbox } = fakeSandbox(t, 'pass');
  const r = await sandbox.exec({ name: 'n', script: 's' });
  assert.match(r.log, /pass 3/);
  assert.ok(!('stdout' in r) && !('overflow' in r));
});

// --- the wrapper ----------------------------------------------------------

// A copy of the real wrapper pointed at a temp folder, with this test's user as the review user.
function installWrapper(t, { reviewUser = userInfo().username, withCredential = false } = {}) {
  const dir = tempDir(t);
  const home = join(dir, 'review-home');
  const dispatcherHome = join(dir, 'dispatcher-home');
  for (const d of ['bin', 'etc', 'skill', 'in']) mkdirSync(join(dir, d));
  mkdirSync(home);
  mkdirSync(dispatcherHome);
  const text = readFileSync(join(USER_DIR, 'run-review'), 'utf8').replaceAll('/opt/adabra-review', dir);
  writeFileSync(join(dir, 'bin', 'run-review'), text);
  chmodSync(join(dir, 'bin', 'run-review'), 0o755);
  writeFileSync(join(dir, 'bin', 'claude'), '#!/bin/sh\necho MODEL-WAS-CALLED\n');
  chmodSync(join(dir, 'bin', 'claude'), 0o755);
  writeFileSync(join(dir, 'etc', 'paths.sh'), `REVIEW_USER=${reviewUser}\nREVIEW_HOME=${home}\nDISPATCHER_HOME=${dispatcherHome}\nSERVICE_DIR=${dispatcherHome}/code\n`);
  writeFileSync(join(dir, 'etc', 'settings.json'), readFileSync(join(USER_DIR, 'settings.json')));
  writeFileSync(join(dir, 'etc', 'review-schema.json'), readFileSync(join(USER_DIR, 'review-schema.json')));
  writeFileSync(join(dir, 'skill', 'review-v1.md'), readFileSync(join(USER_DIR, 'review-v1.md')));
  if (withCredential) writeFileSync(join(home, '.review-credential'), 'SECRET-CREDENTIAL-TEXT');
  return { dir, home, dispatcherHome, env: { ...process.env, LEAK_ME: 'caller-secret', CLAUDE_CODE_OAUTH_TOKEN: 'caller-token' } };
}

function wrapper(dir, env, args) {
  const r = spawnSync(join(dir, 'bin', 'run-review'), args, { env, encoding: 'utf8', cwd: dir });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('wrapper: the shipped file cannot call a model or load the credential', () => {
  const text = readFileSync(join(USER_DIR, 'run-review'), 'utf8');
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(!/bin\/claude["\s]*-p|claude\s+-p/.test(code), 'no model invocation');
  assert.ok(!/cat[^\n]*review-credential|<[^\n]*review-credential/.test(code), 'never opens the credential');
  assert.ok(!/OAUTH_TOKEN|ANTHROPIC_API_KEY/.test(code), 'never sets a credential variable');
  assert.ok(lstatSync(join(USER_DIR, 'run-review')).mode & 0o100, 'executable in the repository');
});

test('wrapper: exits 78 with no output for a valid job, and never starts the CLI', (t) => {
  const { dir, env } = installWrapper(t);
  const id = `7-${SHA}-1700000000000`;
  mkdirSync(join(dir, 'in', id));
  const r = wrapper(dir, env, [id]);
  assert.equal(r.status, 78);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /model step is not installed/);
  assert.ok(!r.stderr.includes('MODEL-WAS-CALLED'));
});

test('wrapper: refuses anyone but the review user, and a missing install', (t) => {
  const other = installWrapper(t, { reviewUser: 'someone-else' });
  const r = wrapper(other.dir, other.env, ['check']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /must run as the review user/);
  assert.equal(r.stdout, '');
  const gone = installWrapper(t);
  rmSync(join(gone.dir, 'etc', 'paths.sh'));
  const missing = wrapper(gone.dir, gone.env, ['check']);
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /not installed/);
});

test('wrapper: nothing from the caller\'s environment gets through', (t) => {
  const { dir, env, home } = installWrapper(t);
  const r = wrapper(dir, { ...env, ADABRA_WRAPPER_CLEAN: '', HOME: '/somewhere/else', PATH: '/evil:/usr/bin:/bin' }, ['check']);
  assert.equal(r.status, 0, r.stderr);
  const seen = parseProbes(r.stdout);
  const names = seen.env.split(',');
  for (const bad of ['LEAK_ME', 'CLAUDE_CODE_OAUTH_TOKEN', 'ADABRA_WRAPPER_CLEAN']) assert.ok(!names.includes(bad), bad);
  assert.ok(names.includes('HOME') && names.includes('PATH'));
  const judged = judgeProbes(seen, { reviewUser: seen.user, canaryName: 'LEAK_ME', withJob: false });
  assert.equal(judged.find((x) => x.check === 'env.only_allowed').got, 'no others', seen.env);
  assert.equal(judged.find((x) => x.check === 'env.canary').got, 'absent');
  assert.ok(home);
});

test('wrapper: probes report a real answer and never a file\'s contents', (t) => {
  const { dir, env, dispatcherHome, home } = installWrapper(t, { withCredential: true });
  mkdirSync(join(dispatcherHome, '.adabra'));
  writeFileSync(join(dispatcherHome, '.adabra', 'review-token'), 'SECRET-TOKEN-TEXT');
  writeFileSync(join(dispatcherHome, '.adabra-review-canary'), 'SECRET-CANARY-TEXT');
  // Locked the way the real home is. Skipped below when this test runs as root, which ignores modes.
  writeFileSync(join(dispatcherHome, '.adabra', 'github-token'), 'SECRET-TOKEN-TEXT');
  chmodSync(join(dispatcherHome, '.adabra', 'github-token'), 0o000);

  const r = wrapper(dir, env, ['check']);
  assert.equal(r.status, 0, r.stderr);
  const seen = parseProbes(r.stdout);
  assert.equal(seen['read.review_token'], 'open', 'opened, because this test runs as the owner');
  assert.equal(seen['read.canary'], 'open');
  assert.equal(seen['read.helper_token'], 'missing');
  if (process.getuid() !== 0) assert.equal(seen['read.github_token'], 'denied');
  assert.equal(seen.credential, 'present');
  assert.equal(seen['socket.docker_home'], 'refused');
  assert.equal(seen['writable.wrapper'], 'yes', 'this test owns its copy');
  for (const secret of ['SECRET-TOKEN-TEXT', 'SECRET-CANARY-TEXT', 'SECRET-CREDENTIAL-TEXT']) {
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), `${secret} must not be printed`);
  }
  assert.ok(existsSync(join(home, '.review-credential')));
});

test('wrapper: a job that is a link, or holds one, is refused', (t) => {
  const { dir, env, home } = installWrapper(t, { withCredential: true });
  const asLink = `7-${SHA}-1700000000000`;
  symlinkSync(home, join(dir, 'in', asLink));
  for (const args of [[asLink], ['check', asLink]]) {
    const r = wrapper(dir, env, args);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /no such job/);
    assert.ok(!r.stdout.includes('job.tree'));
  }
  const holding = `8-${SHA}-1700000000000`;
  mkdirSync(join(dir, 'in', holding, 'tree'), { recursive: true });
  symlinkSync(join(home, '.review-credential'), join(dir, 'in', holding, 'tree', 'innocent.txt'));
  for (const args of [[holding], ['check', holding]]) {
    const r = wrapper(dir, env, args);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /holds a symbolic link/);
  }
});

test('wrapper: job probes can see a real job, and creating files inside is detected', (t) => {
  const { dir, env } = installWrapper(t);
  const { tar, report } = cleanWith(hostileTarball());
  const job = buildJobDir({ root: join(dir, 'in'), pr: 7, sha: SHA, tar, report, diff: 'd', now: 1700000000000 });
  const r = wrapper(dir, env, ['check', job.id]);
  assert.equal(r.status, 0, r.stderr);
  const seen = parseProbes(r.stdout);
  assert.equal(seen['job.tree'], 'open');
  assert.equal(seen['job.diff'], 'open');
  assert.equal(seen['job.pr'], 'open');
  assert.equal(seen['job.file'], 'open');
  // Owner here, so these show a write being noticed. review-check needs the opposite from the real review user.
  assert.equal(seen['job.create'], 'CREATED');
  assert.equal(seen['job.create_tree'], 'CREATED');
  assert.deepEqual(readdirSync(job.dir).sort(), ['diff.patch', 'manifest.json', 'pr.json', 'tree'], 'the probe cleans up');
});

test('wrapper: argument handling', (t) => {
  const { dir, env } = installWrapper(t);
  assert.equal(wrapper(dir, env, []).status, 64);
  assert.equal(wrapper(dir, env, ['check', 'bad id', 'third']).status, 64);
  assert.equal(wrapper(dir, env, ['check', 'bad id']).status, 64);
  assert.equal(wrapper(dir, env, [`7-${SHA}-1700000000000`, 'second']).status, 64);
});

// --- judging the results --------------------------------------------------

const goodProbes = (reviewUser) => ({
  ...expectedProbes({ reviewUser }),
  env: 'HOME,PATH,PWD,SHLVL,_',
});

test('judging: all expected answers pass, including an environment holding only allowed names', () => {
  const results = judgeProbes(goodProbes('rev'), { reviewUser: 'rev', canaryName: 'CANARY_X' });
  assert.deepEqual(results.filter((x) => !x.ok), []);
});

test('judging: any single wrong or missing answer fails, and missing is never a pass', () => {
  for (const key of Object.keys(expectedProbes({ reviewUser: 'rev' }))) {
    const wrong = { ...goodProbes('rev'), [key]: 'open-or-whatever' };
    assert.ok(judgeProbes(wrong, { reviewUser: 'rev', canaryName: 'C' }).some((x) => x.check === key && !x.ok), `wrong ${key}`);
    const missing = goodProbes('rev');
    delete missing[key];
    assert.ok(judgeProbes(missing, { reviewUser: 'rev', canaryName: 'C' }).some((x) => x.check === key && !x.ok), `missing ${key}`);
  }
  const noEnv = goodProbes('rev');
  delete noEnv.env;
  const judged = judgeProbes(noEnv, { reviewUser: 'rev', canaryName: 'C' });
  assert.ok(!judged.find((x) => x.check === 'env.only_allowed').ok);
  assert.ok(!judged.find((x) => x.check === 'env.canary').ok);
  assert.ok(judgeProbes({}, { reviewUser: 'rev', canaryName: 'C' }).every((x) => !x.ok), 'an empty report passes nothing');
});

test('judging: an unexpected or canary variable fails, by name only', () => {
  const extra = judgeProbes({ ...goodProbes('rev'), env: 'HOME,PATH,GITHUB_TOKEN' }, { reviewUser: 'rev', canaryName: 'C' });
  assert.equal(extra.find((x) => x.check === 'env.only_allowed').got, 'GITHUB_TOKEN');
  assert.ok(!extra.find((x) => x.check === 'env.only_allowed').ok);
  const canary = judgeProbes({ ...goodProbes('rev'), env: 'HOME,CANARY_X' }, { reviewUser: 'rev', canaryName: 'CANARY_X' });
  assert.equal(canary.find((x) => x.check === 'env.canary').got, 'PRESENT');
});

test('judging: the probe list covers every protected path and socket', () => {
  const want = expectedProbes({ reviewUser: 'rev' });
  for (const k of ['review_token', 'github_token', 'device_token', 'helper_token', 'gh_login', 'keychains', 'coordinator_db', 'reviewer_db', 'canary', 'home']) {
    assert.equal(want[`read.${k}`], 'denied', k);
  }
  assert.equal(want['socket.docker_home'], 'refused');
  assert.equal(want['socket.docker_var'], 'refused');
  const text = readFileSync(join(USER_DIR, 'run-review'), 'utf8');
  for (const key of Object.keys(want)) {
    const name = key.includes('.') ? key.split('.')[1] : key;
    assert.ok(text.includes(name), `the wrapper reports ${key}`);
  }
  assert.ok(!expectedProbes({ reviewUser: 'rev', withJob: false })['job.tree']);
});

// A stand-in for sudo that enforces the one sudoers line: this wrapper, no variables, no -E, and a reset environment.
function fakeSudo(dir, wrapperPath, env = {}) {
  const path = join(dir, 'fake-sudo');
  writeFileSync(path, `#!/bin/sh
[ "$1" = -n ] || exit 1
shift
[ "$1" = -u ] || exit 1
shift 2
[ "$1" = ${JSON.stringify(wrapperPath)} ] || { echo 'sudo: a password is required' >&2; exit 1; }
exec /usr/bin/env -i ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')} PATH=/usr/bin:/bin "$@"
`);
  chmodSync(path, 0o755);
  return path;
}

// Stands in for the sandbox: the real worker without a container.
const localSandbox = { cleanTree: async ({ tarball }) => {
  const r = cleanWith(tarball);
  return { tar: r.tar, report: r.report };
} };

function runCheck(t, over = {}, prepare = () => {}) {
  const installed = installWrapper(t, { withCredential: true });
  chmodSync(join(installed.dir, 'in'), 0o750);
  prepare(installed);
  return { installed, promise: reviewCheck({
    sandbox: localSandbox,
    opt: installed.dir,
    sudo: fakeSudo(installed.dir, join(installed.dir, 'bin', 'run-review')),
    home: installed.dispatcherHome,
    rootUid: process.getuid(),
    ...over,
  }) };
}

test('review-check, end to end with the real wrapper: refuses to pass when the review user is not actually separate', async (t) => {
  const { installed, promise } = runCheck(t);
  const r = await promise;
  const get = (check) => r.results.find((x) => x.check === check);
  assert.equal(r.ok, false);
  // Same user here, so the positive control shows the probe working, and the check fails as it must.
  assert.equal(get('read.canary').got, 'open');
  assert.equal(get('read.canary').ok, false);
  assert.equal(get('control.canary_readable_here').ok, true);
  // What does not depend on separate users holds.
  assert.equal(get('clean.kept_only').ok, true, get('clean.kept_only').got);
  assert.equal(get('clean.no_special_files').ok, true);
  assert.equal(get('job.modes').ok, true);
  assert.equal(get('env.only_allowed').ok, true, get('env.only_allowed').got);
  assert.equal(get('env.canary').ok, true);
  assert.equal(get('wrapper.runs').ok, true);
  assert.equal(get('wrapper.no_model_step').got, 'exit 78');
  assert.equal(get('wrapper.no_model_output').ok, true);
  assert.equal(get('wrapper.job_is_link').ok, true);
  assert.equal(get('wrapper.job_holds_link').ok, true);
  for (const id of ['traversal', 'empty', 'command', 'short', 'newline', 'unknown']) assert.equal(get(`wrapper.id.${id}`).ok, true, id);
  assert.equal(get('wrapper.extra_argument').ok, true);
  assert.equal(get('sudo.other_command').ok, true);
  assert.equal(get('sudo.shell').ok, true);
  assert.equal(get('sudo.set_variable').ok, true);
  // Leaves nothing behind, even though it failed.
  assert.deepEqual(readdirSync(join(installed.dir, 'in')), []);
  assert.ok(!existsSync(join(installed.dispatcherHome, '.adabra-review-canary')));
});

test('review-check: a result never carries a file\'s contents', async (t) => {
  const r = await runCheck(t).promise;
  const everything = JSON.stringify(r.results);
  assert.ok(!everything.includes('SECRET-CREDENTIAL-TEXT'));
  assert.ok(!everything.includes('must not reach the review user'));
});

test('review-check: a failure while running still removes the canary and the jobs', async (t) => {
  const { promise, installed } = runCheck(t, { sandbox: { cleanTree: async () => { throw new Error('docker went away'); } } });
  await assert.rejects(promise, /docker went away/);
  assert.ok(!existsSync(join(installed.dispatcherHome, '.adabra-review-canary')));
  assert.deepEqual(readdirSync(join(installed.dir, 'in')), []);
});

test('review-check: a tampered install is caught before anything runs', async (t) => {
  const notRoot = await runCheck(t, { rootUid: process.getuid() + 1 }).promise;
  assert.equal(notRoot.results.find((x) => x.check === 'owner.bin/run-review').got, 'not root-owned');
  const writable = await runCheck(t, {}, (i) => chmodSync(join(i.dir, 'etc', 'settings.json'), 0o666)).promise;
  assert.equal(writable.results.find((x) => x.check === 'owner.etc/settings.json').got, 'writable by others');
  const missing = await runCheck(t, {}, (i) => rmSync(join(i.dir, 'skill', 'review-v1.md'))).promise;
  assert.equal(missing.results.find((x) => x.check === 'owner.skill/review-v1.md').got, 'missing');
  const linked = await runCheck(t, {}, (i) => {
    rmSync(join(i.dir, 'etc', 'review-schema.json'));
    symlinkSync(join(i.dispatcherHome, 'anywhere'), join(i.dir, 'etc', 'review-schema.json'));
  }).promise;
  assert.equal(linked.results.find((x) => x.check === 'owner.etc/review-schema.json').got, 'missing', 'a dangling link is not an install');
});

// --- what the installer ships ---------------------------------------------

const INSTALLER = join(REPO, 'service', 'review-user.sh');

test('installer: refuses to run without sudo and does nothing', () => {
  if (process.getuid() === 0) return;
  const r = spawnSync(INSTALLER, ['install'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run this with sudo/);
  const u = spawnSync(INSTALLER, ['uninstall'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(u.status, 1);
  assert.match(u.stderr, /run this with sudo/);
  assert.equal(spawnSync(INSTALLER, [], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(INSTALLER, ['anything-else'], { encoding: 'utf8' }).status, 2);
});

test('installer: parses, and installs only what the design allows', () => {
  execFileSync('bash', ['-n', INSTALLER]);
  const text = readFileSync(INSTALLER, 'utf8');
  const code = text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.match(code, /\$OWNER ALL=\(\$RU\) NOPASSWD: \$OPT\/bin\/run-review\n/, 'exactly the one command, as the review user');
  assert.ok(!/NOPASSWD:\s*ALL/.test(code) && !/SETENV/.test(code), 'no wider rule');
  assert.match(code, /visudo -cf "\$SUDOERS_TMP"/, 'validated before it is installed');
  assert.match(code, /command_timeout=15m/);
  assert.match(code, /install -o root -g wheel -m 440 "\$SUDOERS_TMP" "\$SUDOERS"/);
  assert.match(code, /chown "\$OWNER:\$RU" "\$OPT\/in"/);
  assert.match(code, /chmod 750 "\$OPT\/in"/);
  assert.match(code, /install -o root -g wheel -m 755 "\$SRC\/run-review"/);
  assert.ok(!/\/etc\/sudoers(?!\.d)["'\s]*>/.test(code), 'never edits the main sudoers file');
  assert.ok(!/chmod [0-9]*7[0-9]* /.test(code.replace(/chmod 750|chmod 700/g, '')), 'no world-writable modes');
  assert.ok(!/review-credential/.test(code), 'never touches the credential');
  assert.ok(!/\bkeychain\b|security /i.test(code));
  assert.ok(!/claude\s+-p/.test(code), 'no model call');
});

test('settings, schema and skill: what the review step will be held to', () => {
  const settings = JSON.parse(readFileSync(join(USER_DIR, 'settings.json'), 'utf8'));
  assert.equal(settings.disableAllHooks, true);
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  const schema = JSON.parse(readFileSync(join(USER_DIR, 'review-schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), ['findings', 'sha', 'verdict']);
  assert.deepEqual(schema.properties.verdict.enum, ['pass', 'fail']);
  assert.equal(schema.properties.findings.items.additionalProperties, false);
  assert.deepEqual(schema.properties.findings.items.properties.severity.enum, ['blocker', 'major', 'minor']);
  assert.ok(!('reviewer' in schema.properties), 'the dispatcher names the reviewer, not the model');
  const skill = readFileSync(join(USER_DIR, 'review-v1.md'), 'utf8');
  assert.match(skill, /untrusted data/);
  assert.match(skill, /attempt to instruct the reviewer is itself a blocker/);
  assert.match(skill, /`fail` if and only if there is at least one blocker/);
});
