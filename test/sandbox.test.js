import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox, dockerArgs, DEFAULTS } from '../reviewer/sandbox.js';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-docker.js');
const job = { pr: 5, sha: 'a'.repeat(40) };
const tarball = Buffer.from('pretend .tar.gz bytes');

function make(mode, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-sandbox-'));
  const record = join(dir, 'runs.jsonl');
  const sandbox = new Sandbox({
    docker: FAKE,
    env: { ...process.env, FAKE_DOCKER_MODE: mode, FAKE_DOCKER_RECORD: record },
    ...over,
  });
  const github = { downloadTarball: async () => tarball };
  return {
    sandbox, github,
    runs: () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('container flags: no network, no host mounts, not root, read-only, limited, no secrets passed in', () => {
  const a = dockerArgs({ ...DEFAULTS, name: 'x' });
  const after = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(after('--network'), 'none');
  assert.equal(after('--user'), '1000:1000');
  assert.equal(after('--cap-drop'), 'ALL');
  assert.equal(after('--security-opt'), 'no-new-privileges');
  assert.equal(after('--pull'), 'never');
  assert.equal(after('--memory'), after('--memory-swap'));
  assert.ok(a.includes('--read-only') && a.includes('--rm') && a.includes('--pids-limit') && a.includes('--cpus'));
  for (const bad of ['-v', '--volume', '--mount', '--privileged', '--env-file', '--network=host']) assert.ok(!a.includes(bad), bad);
  assert.ok(!a.join(' ').includes('docker.sock'));
  const env = a.flatMap((x, i) => (a[i - 1] === '-e' ? [x.split('=')[0]] : []));
  assert.deepEqual(env.sort(), ['CI', 'HOME', 'NPM_CONFIG_UPDATE_NOTIFIER']);
  assert.equal(a.at(-1), DEFAULTS.image);
});

test('passing tests: success, and the exact tarball is streamed into the container', async () => {
  const t = make('pass');
  try {
    const r = await t.sandbox.testRunner(t.github)(job);
    assert.equal(r.state, 'success');
    assert.match(r.log, /pass 3/);
    const [run] = t.runs();
    assert.equal(Buffer.from(run.stdin, 'base64').toString(), tarball.toString());
    assert.deepEqual(run.args.slice(-5), ['sh', '-c', 'tar -xzf - --strip-components=1 --exclude=node_modules --exclude=.npmrc -C /work && exec sh -c "$1"', 'sandbox', 'npm test']);
  } finally {
    t.done();
  }
});

test('failing tests: failure with the output', async () => {
  const t = make('fail');
  try {
    const r = await t.sandbox.testRunner(t.github)(job);
    assert.equal(r.state, 'failure');
    assert.match(r.summary, /exit 1/);
    assert.match(r.log, /payments/);
  } finally {
    t.done();
  }
});

test('a PR that never finishes is killed at the time limit and reported as a failure', async () => {
  const t = make('hang', { timeoutMs: 300 });
  try {
    const started = Date.now();
    const r = await t.sandbox.testRunner(t.github)(job);
    assert.equal(r.state, 'failure');
    assert.match(r.summary, /Timed out/);
    assert.ok(Date.now() - started < 15_000);
  } finally {
    t.done();
  }
});

test('huge output is cut to the last part, so it cannot exhaust memory', async () => {
  const t = make('biglog', { maxLogBytes: 10_000 });
  try {
    const r = await t.sandbox.testRunner(t.github)(job);
    assert.ok(r.log.length < 11_000);
    assert.match(r.log, /THE-END/);
    assert.match(r.log, /earlier bytes dropped/);
  } finally {
    t.done();
  }
});

test('hitting the memory or process limit is a failure of the PR', async () => {
  const t = make('oom');
  try {
    const r = await t.sandbox.testRunner(t.github)(job);
    assert.equal(r.state, 'failure');
    assert.match(r.summary, /limit/);
  } finally {
    t.done();
  }
});

test('Docker down or unable to start the container is OUR problem: thrown, so the job is retried', async () => {
  for (const mode of ['daemon-down', 'docker-error']) {
    const t = make(mode);
    try {
      await assert.rejects(t.sandbox.testRunner(t.github)(job), /docker/);
    } finally {
      t.done();
    }
  }
  const missing = new Sandbox({ docker: '/nonexistent/docker' });
  await assert.rejects(missing.testRunner({ downloadTarball: async () => tarball })(job), /docker/);
});

test('a source tarball over the size cap fails the PR instead of retrying forever', async () => {
  const t = make('pass');
  try {
    const big = { downloadTarball: async () => { throw Object.assign(new Error('Source is larger than 100 MB'), { code: 'TOO_LARGE' }); } };
    const r = await t.sandbox.testRunner(big)(job);
    assert.equal(r.state, 'failure');
    assert.equal(t.runs().length, 0, 'nothing was run');
  } finally {
    t.done();
  }
});
