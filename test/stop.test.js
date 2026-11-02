import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Store } from '../coordinator/store.js';
import { createServer } from '../coordinator/server.js';
import { Worker } from '../coordinator/worker.js';
import { keepLeasesWhileStopped } from '../coordinator/stop-keeper.js';
import { Outbox } from '../helper/outbox.js';
import { flush } from '../helper/sender.js';
import { ClaimFile, claimRefusal, heartbeat, renewClaim } from '../helper/claims.js';
import { tick } from '../helper/tick.js';
import { ReviewStore, MAX_ATTEMPTS } from '../reviewer/store.js';
import { CONTEXTS, Dispatcher } from '../reviewer/dispatcher.js';
import { ReviewGitHub } from '../reviewer/github.js';
import { buildResult, deliverResults, startTaskResults } from '../reviewer/task-results.js';
import { OVERRIDE_TEXT, overrideCommand, overrideLogPath, parseOverride, runOverride } from '../reviewer/override.js';
import { checkCommand, EXIT_STOPPED, resumeCommand, statusCommand, stopCommand } from '../ops/commands.js';
import { operatorText } from '../shared/sanitize.js';
import { isStopped, readStop, recordResume, recordStop, RUNNING, stopFilePath, stopLine, watchStop } from '../shared/stop.js';
import { hasTerminal, typed } from '../shared/terminal.js';

// Everything here uses temp directories, ephemeral ports and fakes. Nothing opens a real database, stop file, token or Docker.
const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const run = promisify(execFile);
const LEASE = 60_000;
const sha = (n) => String(n).repeat(40).slice(0, 40);
const noMention = /@[^\u{200B}]/u;

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-stop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const stopFile = (t) => join(tempDir(t), 'control', 'stop.json');

// A real command run with no terminal, the way a headless agent runs it. Resolves { code, out } and never rejects.
function cli(args, env = {}) {
  return run(process.execPath, args.map((a, i) => (i === 0 ? repo(a) : a)), { env: { ...process.env, ...env } }).then(
    ({ stdout, stderr }) => ({ code: 0, out: stdout + stderr }),
    (err) => ({ code: err.code, out: `${err.stdout}${err.stderr}` }),
  );
}

// --- the state file --------------------------------------------------------------------------------------------------

test('stop and resume: no file means running, a stop is on disk until a resume, and the state is readable by others', (t) => {
  const path = stopFile(t);
  assert.deepEqual(readStop({ path }), RUNNING);
  const old = process.umask(0o077); // a shell left at 077 by the README's token steps
  try {
    const { state, already } = recordStop({ reason: 'disk is full', by: 'some-user', from: 'terminal', path });
    assert.equal(already, false);
    assert.equal(state.stopped, true);
    assert.equal(state.reason, 'disk is full');
    assert.ok(Date.parse(state.since));
    assert.equal(statSync(path).mode & 0o777, 0o644);
    assert.equal(statSync(join(path, '..')).mode & 0o777, 0o755);
  } finally {
    process.umask(old);
  }
  assert.equal(readStop({ path }).stopped, true, 'a new reader, as after a restart, still sees it');
  assert.equal(isStopped({ path }), true);
  const after = recordResume({ path });
  assert.equal(after.stopped, false);
  assert.equal(after.last_stop.reason, 'disk is full');
  assert.equal(isStopped({ path }), false);
});

test('a second stop changes nothing: an agent cannot rewrite why, or since when', (t) => {
  const path = stopFile(t);
  const first = recordStop({ reason: 'first', at: new Date(1000), path }).state;
  const again = recordStop({ reason: 'second', at: new Date(2000), path });
  assert.equal(again.already, true);
  assert.deepEqual(readStop({ path }), first);
});

test('the check fails safe: anything but "no file" and a well-formed "not stopped" counts as stopped', (t) => {
  const dir = tempDir(t);
  const file = (name, content) => {
    const p = join(dir, name);
    writeFileSync(p, content);
    return p;
  };
  const bad = {
    'half-written JSON': file('a', '{"stopped": fal'),
    'empty file': file('b', ''),
    'wrong type': file('c', '{"stopped": "false"}'),
    'no field': file('d', '{}'),
    'null': file('e', 'null'),
    'a directory': dir,
    'a file for a parent folder': join(file('f', '{}'), 'stop.json'),
  };
  for (const [what, path] of Object.entries(bad)) {
    const s = readStop({ path });
    assert.equal(s.stopped, true, what);
    assert.ok(s.unreadable, what);
    assert.match(s.reason, /could not be read/, what);
  }
  assert.equal(readStop({ path: join(dir, 'missing', 'stop.json') }).stopped, false);
  assert.equal(readStop({ path: file('g', '{"stopped": false}') }).stopped, false);
});

test('the check fails safe when the file cannot be opened', { skip: process.getuid?.() === 0 ? 'root can open anything' : false }, (t) => {
  const path = stopFile(t);
  recordResume({ path });
  chmodSync(path, 0o000);
  assert.equal(readStop({ path }).unreadable, 'EACCES');
});

test('the default place is outside ~/.adabra, and the environment can move it', () => {
  assert.equal(stopFilePath({}, () => '/home/x'), join('/home/x', '.adabra-control', 'stop.json'));
  assert.equal(stopFilePath({ ADABRA_STOP_FILE: '/tmp/y' }, () => '/home/x'), '/tmp/y');
  assert.doesNotMatch(stopFilePath({}, () => '/home/x'), /\.adabra\//);
});

test('a reason is plain text everywhere, however it got into the file', (t) => {
  const path = stopFile(t);
  const hostile = 'ping @everyone\n## injected\u001b[31m‮red `code` <img src=x> | [link](http://x) ![i](http://y)\r\n```\n@octocat';
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ stopped: true, reason: hostile, since: 'not a date', by: 'a\nb' }));
  const s = readStop({ path });
  const shown = [s.reason, stopLine(s), stopLine({ reason: hostile }), operatorText(operatorText(hostile))];
  for (const text of shown) {
    assert.doesNotMatch(text, noMention);
    assert.doesNotMatch(text, /[\n\r\u001b‮`<>|[\]]/u);
  }
  assert.equal(operatorText(operatorText(hostile)), operatorText(hostile), 'safe to apply twice');
  assert.equal(s.since, null);
  assert.equal(s.by, 'a b');
  assert.ok(operatorText('x'.repeat(5000)).length <= 200);
  assert.equal(recordStop({ reason: '\n\u001b', path: join(tempDir(t), 's.json') }).state.reason, 'no reason given');
});

test('watchStop: logs each change once, acts on every pass while stopped, and survives a failing action', async () => {
  const logs = [];
  let state = RUNNING;
  let calls = 0;
  const w = watchStop({
    read: () => state,
    intervalMs: 1e9,
    log: (m) => logs.push(m),
    whileStopped: () => {
      calls++;
      if (calls === 2) throw new Error('boom');
    },
  });
  try {
    await w.pass();
    assert.equal(calls, 0);
    state = { stopped: true, reason: 'why', since: null };
    await w.pass();
    await w.pass();
    await w.pass();
    assert.equal(calls, 3);
    assert.equal(logs.filter((l) => l.includes('STOPPED by the operator: why')).length, 1);
    assert.ok(logs.some((l) => l.includes('boom')));
    state = RUNNING;
    await w.pass();
    assert.equal(logs.at(-1), 'stop lifted: the operator resumed');
  } finally {
    w.stop();
  }
});

// --- the commands -----------------------------------------------------------------------------------------------------

test('stop works headless and with nothing else running; check says go or do not start; status gives the reason', async (t) => {
  const env = { ADABRA_STOP_FILE: stopFile(t) };
  const go = await cli(['ops/main.js', 'check'], env);
  assert.equal(go.code, 0);
  assert.deepEqual(JSON.parse(go.out), { stopped: false });

  const stop = await cli(['ops/main.js', 'stop', '--reason', 'tests @everyone are failing'], env);
  assert.equal(stop.code, 0, stop.out);
  assert.match(stop.out, /STOPPED by the operator/);

  const no = await cli(['ops/main.js', 'check'], env);
  assert.equal(no.code, EXIT_STOPPED);
  const brief = JSON.parse(no.out);
  assert.equal(brief.stopped, true);
  assert.doesNotMatch(brief.reason, noMention);

  const status = await cli(['ops/main.js', 'status'], env);
  assert.match(status.out, /tests @\u{200B}everyone are failing/u);
  assert.match(status.out, /no terminal/, 'a stop by an agent shows as one');

  // An emergency is no time to be fussy about how it was asked.
  const env2 = { ADABRA_STOP_FILE: stopFile(t) };
  assert.equal((await cli(['ops/main.js', 'stop', '--unknown', 'flag'], env2)).code, 0);
  assert.equal(isStopped({ path: env2.ADABRA_STOP_FILE }), true);
  const env3 = { ADABRA_STOP_FILE: stopFile(t) };
  assert.equal((await cli(['ops/main.js', 'stop'], env3)).code, 0);
  assert.equal(readStop({ path: env3.ADABRA_STOP_FILE }).reason, 'no reason given');
});

test('resume refuses without a terminal, and stays stopped', async (t) => {
  const path = stopFile(t);
  recordStop({ reason: 'x', path });
  const r = await cli(['ops/main.js', 'resume'], { ADABRA_STOP_FILE: path });
  assert.equal(r.code, 2);
  assert.match(r.out, /interactive terminal/);
  assert.equal(isStopped({ path }), true);
  assert.equal(hasTerminal({ stdin: { isTTY: true }, stdout: {} }), false, 'output piped away is not a person at a terminal');
  assert.equal(hasTerminal({ stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
});

test('resume needs the word typed, warns if the coordinator is down, and repairs an unreadable file', async (t) => {
  const path = stopFile(t);
  recordStop({ reason: 'x', path });
  const said = [];
  const go = (typedRight, up = true) =>
    resumeCommand({ path, terminal: true, say: (m) => said.push(m), coordinatorUp: async () => up, confirm: async (_q, expected) => (assert.equal(expected, 'resume'), typedRight) });

  assert.equal(await go(false), 1);
  assert.equal(isStopped({ path }), true);
  assert.equal(said.some((m) => m.includes('WARNING')), false);

  assert.equal(await go(true, false), 0);
  assert.ok(said.some((m) => m.includes('WARNING: the coordinator is not answering')));
  assert.equal(isStopped({ path }), false);
  assert.equal(await go(true), 0, 'nothing to do is not an error');

  writeFileSync(path, 'garbage');
  assert.equal(isStopped({ path }), true);
  assert.equal(await go(true), 0);
  assert.equal(readStop({ path }).stopped, false);
  assert.equal(readStop({ path }).unreadable, undefined);
});

test('stop says plainly when it could not take effect, and when the state already counts as stopped', (t) => {
  const dir = tempDir(t);
  const said = [];
  const say = (m) => said.push(m);
  const inFile = join(dir, 'a-file');
  writeFileSync(inFile, '');
  const blocked = join(inFile, 'stop.json');
  // A parent that is a file reads as stopped (ENOTDIR), and cannot be written.
  assert.equal(stopCommand({ path: blocked, terminal: false, say }), 0);
  assert.match(said.at(-1), /already counts as stopped/);
  assert.equal(checkCommand({ path: blocked, say }), EXIT_STOPPED);
  assert.ok(JSON.parse(said.at(-1)).unreadable);
  assert.equal(statusCommand({ path: blocked, say }), 0);
  assert.equal(stopCommand({ path: join(dir, 'ok.json'), terminal: false, say, args: ['free', 'text'] }), 0);
  assert.equal(readStop({ path: join(dir, 'ok.json') }).reason, 'free text');
});

test('the typed confirmation: exact words only, and end of input is a no', async () => {
  const ask = async (text, end = true) => {
    const input = new PassThrough();
    const answer = typed('? ', 'override 5', { input, output: new PassThrough() });
    if (text) input.write(text);
    if (end) input.end();
    return answer;
  };
  assert.equal(await ask('override 5\n'), true);
  assert.equal(await ask('  override 5  \n'), true);
  assert.equal(await ask('y\n'), false);
  assert.equal(await ask('override 6\n'), false);
  assert.equal(await ask('override\n'), false);
  assert.equal(await ask(''), false);
});

test('the deny rules forbid override and resume, allow stop and status, and the shell entry point works', async (t) => {
  const { deny, allow } = JSON.parse(readFileSync(repo('.claude/settings.json'), 'utf8')).permissions;
  for (const rule of ['Bash(*main.js override*)', 'Bash(*ops.sh override*)', 'Bash(*main.js resume*)', 'Bash(*ops.sh resume*)', 'Edit(~/.adabra-control/**)', 'Write(~/.adabra-control/**)']) {
    assert.ok(deny.includes(rule), rule);
  }
  assert.equal(allow.filter((r) => /override|resume/.test(r)).length, 0);
  assert.ok(allow.includes('Bash(service/ops.sh stop:*)'));
  assert.ok(allow.includes('Bash(service/ops.sh check)'));

  const env = { ...process.env, ADABRA_STOP_FILE: stopFile(t) };
  const sh = (...args) => run('bash', [repo('service/ops.sh'), ...args], { env, cwd: tmpdir() }).then(() => 0, (e) => e.code);
  assert.equal(await sh('check'), 0);
  assert.equal(await sh('stop', '--reason', 'from the shell'), 0);
  assert.equal(await sh('check'), EXIT_STOPPED);
  assert.equal(await sh('resume'), 2);
  assert.equal(await sh('nonsense'), 2);
});

// --- coordinator ------------------------------------------------------------------------------------------------------

async function coordinator(t) {
  const dir = tempDir(t);
  const path = join(dir, 'control', 'stop.json');
  const clock = { t: Date.now() };
  const store = new Store(join(dir, 'coord.db'));
  const tokens = {
    'member-a': store.addDevice('member-a'),
    'member-b': store.addDevice('member-b'),
    'mini-reviewer': store.addDevice('mini-reviewer', 'reviewer'),
  };
  store.addTask('TASK-1', 1);
  store.addTask('TASK-2', 2);
  const stopState = () => readStop({ path });
  const logs = [];
  const server = createServer({ store, now: () => clock.t, leaseMs: LEASE, stopState, log: (m) => logs.push(m) });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const keeper = keepLeasesWhileStopped({ store, leaseMs: LEASE, read: stopState, now: () => clock.t, intervalMs: 1e9 });
  const ctx = {
    dir, path, clock, store, tokens, logs, keeper, stopState, url: `http://127.0.0.1:${port}`,
    stop: (reason = 'emergency drill') => recordStop({ reason, at: new Date(clock.t), path }),
    resume: () => recordResume({ path }),
    async call(device, method, url, body) {
      const res = await fetch(`${ctx.url}${url}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-device-id': device, authorization: `Bearer ${tokens[device]}` },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    },
    claim: (device, task = 'TASK-1', run = `RUN-${device}`) => ctx.call(device, 'POST', '/v1/claims', { task_id: task, run_id: run }),
    renew: (device, generation = 1, task = 'TASK-1', run = `RUN-${device}`) => ctx.call(device, 'POST', '/v1/claims/renew', { task_id: task, run_id: run, generation }),
    // Time passing during a stop, with the coordinator's timer doing its job.
    async pass(ms) {
      for (let done = 0; done < ms; done += 30_000) {
        clock.t += 30_000;
        await keeper.pass();
      }
    },
  };
  t.after(async () => {
    keeper.stop();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    store.close();
  });
  return ctx;
}

const checkpoint = (over = {}) => ({
  event_id: randomUUID(),
  task_id: 'TASK-1',
  run_id: 'RUN-member-a',
  device_id: 'member-a',
  claim_generation: 1,
  type: 'checkpoint',
  source_commit: 'a'.repeat(40),
  unpushed_commits: 0,
  summary: 'work done so far',
  verification: '',
  status: 'Building',
  next_action: '',
  ts: new Date().toISOString(),
  ...over,
});

test('while stopped the coordinator refuses claims, renewals, checkpoints and results, with the reason; release still works', async (t) => {
  const c = await coordinator(t);
  assert.deepEqual((await (await fetch(`${c.url}/healthz`)).json()), { ok: true });
  assert.equal((await c.claim('member-a')).status, 200);
  assert.equal((await c.claim('member-b', 'TASK-2')).status, 200);
  c.stop('drill');

  const refused = [
    await c.claim('member-b'),
    await c.claim('member-a', 'TASK-2'),
    await c.renew('member-a'),
    await c.call('member-a', 'POST', '/v1/events', checkpoint()),
    await c.call('mini-reviewer', 'POST', '/v1/review-results', { result_id: 'x' }),
  ];
  for (const r of refused) {
    assert.equal(r.status, 503);
    assert.equal(r.data.error, 'stopped');
    assert.equal(r.data.reason, 'drill');
    assert.ok(r.data.since);
  }
  assert.equal(c.store.counts().pending, undefined, 'the checkpoint was not stored');
  assert.deepEqual(await (await fetch(`${c.url}/healthz`)).json(), { ok: true, stopped: true });

  const mine = await c.call('member-a', 'GET', '/v1/tasks/mine');
  assert.equal(mine.status, 200);
  assert.equal(mine.data.stop.reason, 'drill');
  assert.equal(mine.data.tasks.find((x) => x.task_id === 'TASK-1').state, 'yours');
  assert.equal((await c.call('mini-reviewer', 'GET', '/v1/stop')).data.stopped, true);
  assert.equal((await fetch(`${c.url}/v1/stop`)).status, 401, 'the reason is for enrolled devices');

  assert.equal((await c.call('member-b', 'POST', '/v1/claims/release', { task_id: 'TASK-2', run_id: 'RUN-member-b', generation: 1 })).status, 200);
  assert.ok(c.logs.some((l) => l.includes('claim by member-b refused: stopped')));

  c.resume();
  assert.equal((await c.call('member-a', 'GET', '/v1/stop')).data.stopped, false);
  assert.deepEqual((await c.call('member-a', 'GET', '/v1/tasks/mine')).data.stop, { stopped: false });
});

test('an unreadable state refuses too (fail safe), and tells the builder no file path', async (t) => {
  const c = await coordinator(t);
  mkdirSync(join(c.path, '..'), { recursive: true });
  writeFileSync(c.path, 'garbage');
  const r = await c.claim('member-a');
  assert.equal(r.status, 503);
  assert.match(r.data.reason, /could not be read/);
  assert.doesNotMatch(JSON.stringify(r.data), /stop\.json|unreadable|garbage/);
});

test('a held lease outlives a long stop: same owner, same generation, and no other device can take the task on resume', async (t) => {
  const c = await coordinator(t);
  const claim = await c.claim('member-a');
  assert.equal(claim.data.generation, 1);
  c.stop();

  await c.pass(3_600_000); // an hour, sixty leases' worth
  const during = await c.renew('member-a');
  assert.equal(during.status, 503);
  assert.ok(during.data.expires_at > c.clock.t + LEASE - 40_000, 'the owner is told how long it has');
  assert.equal((await c.renew('member-b')).data.expires_at, undefined, 'and nobody else is');
  assert.equal(c.store.getTask('TASK-1').generation, 1);

  c.resume();
  const stolen = await c.claim('member-b');
  assert.equal(stolen.status, 409);
  assert.equal(stolen.data.error, 'claimed');
  assert.equal(stolen.data.owner, 'member-a');

  c.clock.t += 20_000; // before the helper's next pass
  const renewed = await c.renew('member-a');
  assert.equal(renewed.status, 200);
  assert.equal(renewed.data.generation, 1);
  assert.equal((await c.call('member-a', 'POST', '/v1/events', checkpoint())).data.status, 'accepted');
});

test('only what was live when the stop began is kept; an ordinary lapse after resume still happens', async (t) => {
  const c = await coordinator(t);
  await c.claim('member-a'); // TASK-1
  await c.claim('member-b', 'TASK-2');
  c.clock.t += LEASE + 1; // both lapse, and only then does the stop begin
  assert.equal((await c.renew('member-a')).data.error, 'expired');
  c.stop();
  await c.pass(300_000);
  c.resume();
  assert.equal((await c.claim('member-b')).status, 200, 'a lease that lapsed before the stop was free to take');
  assert.equal(c.store.currentClaim('TASK-2').expires_at < c.clock.t, true, 'and stays lapsed');

  // Released and cancelled claims are not brought back either.
  await c.claim('member-a', 'TASK-2');
  c.store.cancelClaim('TASK-2');
  const expires = c.store.currentClaim('TASK-2').expires_at;
  c.stop();
  await c.pass(LEASE * 2);
  assert.equal(c.store.currentClaim('TASK-2').expires_at, expires);
  assert.equal(c.store.currentClaim('TASK-2').state, 'cancelled');
  c.resume();

  // After a resume, a lease nobody renews lapses as usual: a stop does not keep a device that has gone away forever.
  c.stop();
  await c.pass(LEASE * 2);
  c.resume();
  assert.equal((await c.claim('member-a')).status, 409, 'member-b still has its full lease');
  c.clock.t += LEASE + 1;
  assert.equal((await c.claim('member-a')).status, 200);
});

test('a coordinator that was down during a stop keeps a lease that ran out meanwhile, even if the file cannot say since when', async (t) => {
  const c = await coordinator(t);
  await c.claim('member-a');
  c.stop();
  c.clock.t += LEASE * 3; // down: no timer ran
  await c.keeper.pass(); // what serve does first thing on starting
  assert.ok(c.store.currentClaim('TASK-1').expires_at > c.clock.t);

  // No `since`: keeps what is live now, and nothing else.
  const held = c.store.currentClaim('TASK-1').expires_at;
  writeFileSync(c.path, 'garbage');
  c.clock.t += 1000;
  await c.keeper.pass();
  assert.ok(c.store.currentClaim('TASK-1').expires_at > held);
});

// --- helper -----------------------------------------------------------------------------------------------------------

function helperFor(t, c, device = 'member-a') {
  const dir = tempDir(t);
  const outbox = new Outbox(join(dir, 'outbox.db'));
  t.after(() => outbox.close());
  const claims = new ClaimFile(dir);
  const cfg = { coordinator_url: c.url, device_id: device, token: c.tokens[device] };
  const notices = [];
  const memory = {};
  return {
    dir, outbox, claims, cfg, notices, memory,
    pass: () => tick({ claims, outbox, cfg, now: c.clock.t, notify: (title, msg) => notices.push(`${title}: ${msg}`), memory }),
    async claim() {
      const r = await c.claim(device);
      claims.set('TASK-1', { run_id: `RUN-${device}`, generation: r.data.generation, expires_at: r.data.expires_at });
    },
  };
}

test('nothing is lost: a claim, its checkpoints and what waits for GitHub all come through a long stop', async (t) => {
  const c = await coordinator(t);
  const h = helperFor(t, c);
  const comments = [];
  const github = {
    findProgressComment: async () => null,
    createComment: async (_issue, body) => (comments.push(body), comments.length),
    updateComment: async (id, body) => void (comments[id - 1] = body),
  };
  const worker = new Worker({ store: c.store, github, stopState: c.stopState });

  await h.claim();
  const before = checkpoint({ summary: 'accepted before the stop' });
  h.outbox.add(before);
  assert.equal((await h.pass()).sent.acked, 1);
  c.stop('drill @everyone');

  // The worker holds what it has: nothing reaches GitHub, and no attempts are used up.
  await worker.tick();
  assert.equal(comments.length, 0);
  assert.deepEqual(c.store.counts(), { pending: 1 });
  assert.equal(c.store.dueEvents(c.clock.t)[0].attempts, 0);

  // The first pass tells the owner, once. The claim stays, and so does what is queued, untouched.
  const queued = checkpoint({ summary: 'queued during the stop' });
  h.outbox.add(queued);
  const first = await h.pass();
  assert.deepEqual(first.paused, ['TASK-1']);
  assert.deepEqual(first.lost, []);
  assert.equal(first.stop.stopped, true);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0], /^Stopped by the operator: drill @\u{200B}everyone\. Stop work\. Your claims are kept \(TASK-1\)/u);

  // Longer than any lease. Without the keeper and the helper's own handling, this is where the claim would go.
  for (let i = 0; i < 20; i++) {
    await c.pass(30_000);
    const r = await h.pass();
    assert.deepEqual(r.lost, []);
    assert.equal(r.sent.acked, 0);
  }
  assert.ok(h.claims.get('TASK-1'), 'the local claim is still there');
  assert.equal(h.claims.get('TASK-1').generation, 1);
  assert.equal(h.notices.length, 1, 'told once, not every pass');
  const row = h.outbox.db.prepare('SELECT * FROM outbox WHERE event_id = ?').get(queued.event_id);
  assert.deepEqual([row.status, row.attempts, row.next_attempt_at], ['pending', 0, 0], 'no failure, and no backoff built up');
  assert.equal((await c.claim('member-b')).status, 503);

  c.resume();
  // One pass after resume: renewed, delivered, and told.
  const after = await h.pass();
  assert.deepEqual(after.renewed, ['TASK-1']);
  assert.equal(after.sent.acked, 1);
  assert.equal(after.stop, null);
  assert.equal(h.notices.at(-1).startsWith('Resumed'), true);
  assert.deepEqual(h.outbox.counts(), { acked: 2 });
  assert.equal(c.store.currentClaim('TASK-1').generation, 1);

  await worker.tick(c.clock.t);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /queued during the stop/);
  assert.deepEqual(c.store.counts(), { done: 2 });
  assert.doesNotMatch(comments.join('\n'), /drill/, 'the reason never reaches GitHub');
});

test('flush while stopped leaves the row untouched; a plain 503 still backs off as before', async (t) => {
  const c = await coordinator(t);
  const h = helperFor(t, c);
  await h.claim();
  const e = checkpoint();
  h.outbox.add(e);
  c.stop();
  const r = await flush({ outbox: h.outbox, url: c.url, deviceId: 'member-a', token: c.tokens['member-a'], now: c.clock.t });
  assert.equal(r.stopped.error, 'stopped');
  assert.equal(r.retry, 0);
  assert.equal(h.outbox.due(c.clock.t).length, 1);

  const plain503 = http.createServer((_req, res) => (res.writeHead(503), res.end('{}')));
  await new Promise((res) => plain503.listen(0, '127.0.0.1', res));
  t.after(() => new Promise((res) => plain503.close(res)));
  const other = await flush({ outbox: h.outbox, url: `http://127.0.0.1:${plain503.address().port}`, deviceId: 'member-a', token: 'x', now: c.clock.t });
  assert.deepEqual(other, { acked: 0, rejected: 0, retry: 1 });
});

test('known to be stopped, an unreachable coordinator does not cost the claim; the coordinator has the last word when it answers', async (t) => {
  const c = await coordinator(t);
  const h = helperFor(t, c);
  await h.claim();
  c.stop();
  await h.pass();
  const realUrl = h.cfg.coordinator_url;
  h.cfg.coordinator_url = 'http://127.0.0.1:9'; // nothing listens here
  c.clock.t += LEASE * 3;
  const r = await h.pass();
  assert.deepEqual(r.retrying, ['TASK-1']);
  assert.deepEqual(r.lost, []);
  assert.ok(h.claims.get('TASK-1'));
  assert.equal(h.notices.length, 1, 'no second notice');

  // If the lease really did go (say the coordinator was down until after a resume), the owner hears about it.
  c.resume();
  c.store.db.prepare('UPDATE claims SET expires_at = 1').run();
  h.cfg.coordinator_url = realUrl;
  const later = await h.pass();
  assert.equal(later.lost.length, 1);
  assert.ok(h.notices.some((n) => n.startsWith('Lost TASK-1')));
});

test('with no stop known, an outage still gives the claim up at the end of its lease', async (t) => {
  const c = await coordinator(t);
  const h = helperFor(t, c);
  await h.claim();
  h.cfg.coordinator_url = 'http://127.0.0.1:9';
  c.clock.t += LEASE + 1;
  assert.equal((await h.pass()).lost.length, 1);
});

test('the heartbeat command keeps the claim through a stop, and still reports a real refusal', async (t) => {
  const c = await coordinator(t);
  await c.claim('member-a');
  const cfg = { url: c.url, deviceId: 'member-a', token: c.tokens['member-a'] };
  const claim = c.store.currentClaim('TASK-1');
  const held = { run_id: claim.run_id, generation: claim.generation, expires_at: claim.expires_at };
  c.stop('drill');

  const ac = new AbortController();
  const logs = [];
  let beats = 0;
  const sleep = async () => {
    if (++beats === 3) ac.abort();
  };
  const out = await heartbeat(cfg, 'TASK-1', held, { signal: ac.signal, sleep, log: (m) => logs.push(m) });
  assert.equal(out.stopped, 'aborted');
  assert.ok(logs.some((l) => l.includes('STOPPED by the operator') && l.includes('kept')));

  c.resume();
  c.store.cancelClaim('TASK-1');
  const refused = await heartbeat(cfg, 'TASK-1', held, { sleep: async () => {} });
  assert.equal(refused.stopped, 'refused');
});

test('upgrades: an older helper or reviewer sees a stop only as "try again later", so it drops and rejects nothing', async (t) => {
  const c = await coordinator(t);
  await c.claim('member-a');
  c.stop();
  // The lists the shipped helper and reviewer act on: helper/tick.js (lost), helper/sender.js (rejected), task-results.js (rejected).
  const renew = await renewClaim({ url: c.url, deviceId: 'member-a', token: c.tokens['member-a'] }, 'TASK-1', 'RUN-member-a', 1);
  assert.equal([403, 404, 409].includes(renew.status), false);
  const event = await c.call('member-a', 'POST', '/v1/events', checkpoint());
  assert.equal([400, 403, 409, 422].includes(event.status), false);
  const result = await c.call('mini-reviewer', 'POST', '/v1/review-results', {});
  assert.equal([400, 409, 413, 422].includes(result.status), false);
  c.resume();
  // And a running coordinator's answers only gain fields.
  assert.deepEqual((await c.renew('member-a')).data.status, 'ok');
  assert.ok(Array.isArray((await c.call('member-a', 'GET', '/v1/tasks/mine')).data.tasks));
});

test('upgrades: against an older coordinator, which has no /v1/stop, the new helper behaves as it did', async (t) => {
  const seen = [];
  const old = http.createServer((req, res) => {
    seen.push(req.url);
    const json = (code, obj) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
    if (req.url === '/v1/claims/renew') return json(200, { status: 'ok', generation: 1, expires_at: 999_999_999_999_999 });
    if (req.url === '/v1/events') return json(200, { status: 'accepted' });
    return json(404, { error: 'not found' });
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => old.close(r)));
  const dir = tempDir(t);
  const outbox = new Outbox(join(dir, 'outbox.db'));
  t.after(() => outbox.close());
  const claims = new ClaimFile(dir);
  claims.set('TASK-1', { run_id: 'R', generation: 1, expires_at: Date.now() + LEASE });
  outbox.add(checkpoint());
  const notices = [];
  const r = await tick({
    claims, outbox, cfg: { coordinator_url: `http://127.0.0.1:${old.address().port}`, device_id: 'member-a', token: 't' }, notify: (x) => notices.push(x), memory: {},
  });
  assert.deepEqual(r.renewed, ['TASK-1']);
  assert.equal(r.sent.acked, 1);
  assert.equal(r.stop, null);
  assert.deepEqual(notices, []);
  assert.ok(seen.includes('/v1/stop'));
});

test('the helper commands show the stop and its reason; a checkpoint is queued, not lost; a claim is refused in plain words', async (t) => {
  const c = await coordinator(t);
  const home = tempDir(t);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ coordinator_url: c.url, device_id: 'member-a' }));
  writeFileSync(join(home, 'token'), c.tokens['member-a']);
  const env = { TEAM_AGENT_HOME: home };
  const helper = (...args) => cli(['helper/cli.js', ...args], env);

  assert.equal((await helper('claim', 'TASK-1')).code, 0);
  const before = await helper('status');
  assert.doesNotMatch(before.out, /STOPPED/);
  c.stop('drill @everyone\nsecond line');

  const tasks = await helper('tasks');
  assert.equal(tasks.code, 0);
  assert.match(tasks.out, /^STOPPED by the operator since .*: drill @\u{200B}everyone second line\n/u);
  assert.match(tasks.out, /TASK-1 \(#1\)/);

  const status = await helper('status');
  assert.match(status.out, /STOPPED by the operator since .*: drill/);
  assert.match(status.out, /claims held: TASK-1/);

  const refused = await helper('claim', 'TASK-2');
  assert.equal(refused.code, 1);
  assert.match(refused.out, /not claimed: STOPPED by the operator/);
  assert.match(claimRefusal({ status: 503, data: { error: 'stopped', reason: 'x', since: null } }), /until the operator resumes/);

  const point = await helper('checkpoint', '--task', 'TASK-1', '--summary', 'still here');
  assert.equal(point.code, 0, point.out);
  assert.match(point.out, /queued: STOPPED by the operator.*delivered after the operator resumes/);

  const release = await helper('release', 'TASK-1');
  assert.equal(release.code, 1);
  assert.match(release.out, /still queued; not releasing/);

  // The agent's last sight of it is what status shows if the coordinator cannot be reached.
  writeFileSync(join(home, 'agent-status.json'), JSON.stringify({ at: new Date().toISOString(), stop: { stopped: true, reason: 'seen earlier', since: null } }));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ coordinator_url: 'http://127.0.0.1:9', device_id: 'member-a' }));
  assert.match((await helper('status')).out, /seen earlier \(as last seen by the background agent/);
  writeFileSync(join(home, 'config.json'), JSON.stringify({ coordinator_url: c.url, device_id: 'member-a' }));

  c.resume();
  const flushed = await helper('flush');
  assert.match(flushed.out, /acked: 1/);
  assert.doesNotMatch((await helper('status')).out, /STOPPED/);
  assert.doesNotMatch((await helper('tasks')).out, /STOPPED/);
  assert.equal((await helper('release', 'TASK-1')).code, 0);
});

// --- coordinator process: the real thing ----------------------------------------------------------------------------

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function serve(t, env) {
  const child = spawn(process.execPath, [repo('coordinator/main.js'), 'serve'], { env: { ...process.env, ...env, GITHUB_DRY_RUN: '1' }, stdio: 'ignore' });
  const gone = new Promise((r) => child.once('exit', r));
  t.after(() => (child.kill('SIGKILL'), gone));
  return { end: () => (child.kill('SIGKILL'), gone) };
}

async function until(fn, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('the real coordinator process: a stop outlasts a restart, and a lease that ran out while it was down is still the owner\'s', async (t) => {
  const dir = tempDir(t);
  const db = join(dir, 'coord.db');
  const path = join(dir, 'control', 'stop.json');
  const store = new Store(db);
  const tokenA = store.addDevice('member-a');
  const tokenB = store.addDevice('member-b');
  store.addTask('TASK-1', 1);
  const t0 = Date.now();
  // The stop began 10 s ago; the lease was live then and has since run out, with nothing running to keep it.
  store.claimTask('TASK-1', 'member-a', 'RUN-A', t0 - 12_000, 5000);
  store.close();
  recordStop({ reason: 'real process', at: new Date(t0 - 10_000), path });

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const env = { COORDINATOR_DB: db, COORDINATOR_PORT: String(port), ADABRA_STOP_FILE: path };
  const post = (device, token, route, body) =>
    fetch(`${url}${route}`, { method: 'POST', headers: { 'x-device-id': device, authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const health = () => until(() => fetch(`${url}/healthz`).then((r) => r.json()), 'healthz');

  const first = serve(t, env);
  assert.deepEqual(await health(), { ok: true, stopped: true });
  assert.equal((await post('member-b', tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' })).status, 503);
  await first.end();

  serve(t, env);
  assert.deepEqual(await health(), { ok: true, stopped: true }, 'still stopped after a restart');
  assert.equal((await post('member-b', tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' })).status, 503);

  recordResume({ path }); // what `resume` does, once a person has typed the word
  assert.deepEqual(await (await fetch(`${url}/healthz`)).json(), { ok: true }, 'a resume needs no restart');
  const stolen = await post('member-b', tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' });
  assert.equal(stolen.status, 409);
  const renewed = await post('member-a', tokenA, '/v1/claims/renew', { task_id: 'TASK-1', run_id: 'RUN-A', generation: 1 });
  assert.equal(renewed.status, 200);
});

test('coordinator commands show the stop', async (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'stop.json');
  const env = { COORDINATOR_DB: join(dir, 'coord.db'), ADABRA_STOP_FILE: path };
  assert.doesNotMatch((await cli(['coordinator/main.js', 'tasks'], env)).out, /STOPPED/);
  recordStop({ reason: 'drill', path });
  for (const cmd of ['tasks', 'claims', 'status']) {
    assert.match((await cli(['coordinator/main.js', cmd], env)).out, /STOPPED by the operator since .*: drill/, cmd);
  }
});

// --- reviewer ---------------------------------------------------------------------------------------------------------

function reviewer(t, { runTests, runReview, stopped = false } = {}) {
  const dir = tempDir(t);
  const store = new ReviewStore(join(dir, 'reviewer.db'));
  t.after(() => store.close());
  const pulls = [];
  const posted = [];
  const comments = [];
  const github = {
    openPulls: async () => pulls,
    getPull: async (n) => pulls.find((p) => p.number === n) ?? null,
    setStatus: async (s, context, state, description) => {
      posted.push({ sha: s, context, state, description });
      github.onPost?.();
    },
    findReviewComment: async () => null,
    createComment: async (_pr, body) => (comments.push(body), comments.length),
    updateComment: async () => {},
  };
  const state = { stopped };
  const logs = [];
  const clock = { t: 1_000_000 };
  const d = new Dispatcher({
    store, github, repo: 'o/r', authors: ['alice'], now: () => clock.t, log: (m) => logs.push(m), isStopped: () => state.stopped,
    runTests: runTests ?? (async () => ({ state: 'success', summary: 'tests passed' })),
    runReview: runReview ?? (async () => ({ state: 'success', summary: 'no findings' })),
  });
  const pull = (number, s, over = {}) => ({
    number, sha: s, branch: `task/TASK-${number}`, base: 'main', head_repo: 'o/r', author: 'alice', title: `PR ${number}`, body: '', draft: false, state: 'open', merged: false, ...over,
  });
  return { dir, store, pulls, posted, comments, github, state, logs, clock, d, pull };
}

const finals = (r, s) => r.posted.filter((x) => x.sha === s && x.state !== 'pending');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};

test('while stopped the reviewer starts nothing and posts nothing; a queued review stays queued, then runs on resume', async (t) => {
  const r = reviewer(t);
  r.pulls.push(r.pull(5, sha(1)));
  await r.d.poll();
  assert.equal(r.posted.length, 2, 'pending on both');
  r.posted.length = 0;

  r.state.stopped = true;
  r.pulls.push(r.pull(6, sha(2))); // a new PR during the stop
  assert.equal(await r.d.poll(), 0);
  assert.equal(await r.d.runOnce(), null);
  assert.equal(r.store.getJob(5, sha(1)).state, 'queued');
  assert.equal(r.store.getJob(5, sha(1)).attempts, 0);
  assert.equal(r.store.getJob(6, sha(2)), null);
  assert.deepEqual(r.posted, [], 'no status of any kind, so no failure because of the stop');

  r.state.stopped = false;
  assert.equal((await r.d.runOnce()).tests, 'success');
  assert.deepEqual(finals(r, sha(1)).map((s) => s.state), ['success', 'success']);
  assert.equal(await r.d.poll(), 1, 'the push made during the stop is picked up');
});

for (const [what, end] of [
  ['returns what looks like a failure, as a killed container does', (g) => g.resolve({ state: 'failure', summary: 'Killed: memory or process limit reached', log: 'x' })],
  ['throws, as Docker going away does', (g) => g.reject(new Error('docker could not run the container'))],
]) {
  test(`a job stopped while running ${what}: nothing is posted, and it runs again in full after resume, not counted as an attempt`, async (t) => {
    let gate = deferred();
    let reviews = 0;
    const r = reviewer(t, { runTests: () => gate.promise, runReview: async () => (reviews++, { state: 'success', summary: 'ok' }) });
    r.pulls.push(r.pull(5, sha(1)));
    await r.d.poll();
    r.posted.length = 0;

    const running = r.d.runOnce();
    await new Promise((res) => setImmediate(res));
    assert.equal(r.store.getJob(5, sha(1)).state, 'running');
    r.state.stopped = true;
    assert.equal(r.d.interrupt(), true, 'the service then ends its containers');
    end(gate);
    assert.deepEqual(await running, { pr: 5, sha: sha(1), parked: true });

    assert.deepEqual(r.posted, []);
    assert.deepEqual(r.comments, []);
    assert.equal(reviews, 0, 'the review step never started');
    const job = r.store.getJob(5, sha(1));
    assert.deepEqual([job.state, job.attempts, job.next_attempt_at, job.last_error], ['queued', 0, 0, null]);

    r.state.stopped = false;
    gate = deferred();
    gate.resolve({ state: 'success', summary: 'tests passed' });
    assert.equal((await r.d.runOnce()).review, 'success');
    assert.deepEqual(finals(r, sha(1)).map((s) => s.state), ['success', 'success']);
    assert.equal(r.d.interrupt(), false, 'nothing running now');
  });
}

test('a stop lifted before a killed job comes back still posts nothing about that run', async (t) => {
  const gate = deferred();
  const r = reviewer(t, { runTests: () => gate.promise });
  r.pulls.push(r.pull(5, sha(1)));
  await r.d.poll();
  r.posted.length = 0;
  const running = r.d.runOnce();
  await new Promise((res) => setImmediate(res));
  r.state.stopped = true;
  r.d.interrupt();
  r.state.stopped = false; // resumed at once
  gate.resolve({ state: 'failure', summary: 'Killed: memory or process limit reached' });
  assert.equal((await running).parked, true);
  assert.deepEqual(r.posted, []);
});

test('many stops cost a job nothing, however often they hit it', async (t) => {
  const r = reviewer(t, { runTests: async () => ((r.state.stopped = true), { state: 'failure', summary: 'Killed' }) });
  r.pulls.push(r.pull(5, sha(1)));
  await r.d.poll();
  for (let i = 0; i < MAX_ATTEMPTS * 2; i++) {
    r.state.stopped = false;
    assert.equal((await r.d.runOnce()).parked, true);
  }
  assert.equal(r.store.getJob(5, sha(1)).state, 'queued');
  assert.equal(r.store.getJob(5, sha(1)).attempts, 0);
});

test('a stop that arrives during posting lets the result finish: never half-posted', async (t) => {
  const r = reviewer(t);
  r.pulls.push(r.pull(5, sha(1)));
  await r.d.poll();
  r.posted.length = 0;
  r.github.onPost = () => (r.state.stopped = true);
  assert.equal((await r.d.runOnce()).tests, 'success');
  assert.deepEqual(r.posted.map((p) => [p.context, p.state]), [[CONTEXTS.tests, 'success'], [CONTEXTS.review, 'success']]);
  assert.equal(r.comments.length, 1);
  assert.equal(r.store.getJob(5, sha(1)).state, 'done');
});

test('results for the coordinator wait through a stop; an older reviewer\'s are refused for now, never rejected', async (t) => {
  const c = await coordinator(t);
  const r = reviewer(t);
  const job = { pr: 5, sha: sha(1), created_at: 1000 };
  const ok = { state: 'success', summary: 'ok', findings: [] };
  const result = buildResult({ taskId: 'TASK-1', job, tests: ok, review: ok, now: 2000 });
  r.store.enqueue(5, sha(1), {}, 1000);
  r.store.markDone(5, sha(1), { tests: 'success', review: 'success' }, result);
  const tokenFile = join(r.dir, 'device-token');
  writeFileSync(tokenFile, c.tokens['mini-reviewer']);
  const env = { REVIEW_DEVICE_ID: 'mini-reviewer', REVIEW_COORDINATOR_URL: c.url, REVIEW_DEVICE_TOKEN_FILE: tokenFile, REVIEW_DELIVERY_MS: '100000000' };
  const delivery = startTaskResults({ store: r.store, env, isStopped: () => c.stopState().stopped });
  t.after(() => delivery.stop());

  c.stop();
  await delivery.pass();
  assert.equal(r.store.getTaskResult(result.result_id).attempts, 0, 'not even tried, so no backoff');

  // What a reviewer that does not know about stops does: it keeps the result and tries again.
  const old = await deliverResults({ store: r.store, url: c.url, deviceId: 'mini-reviewer', token: c.tokens['mini-reviewer'], now: 0 });
  assert.deepEqual(old, { acked: 0, rejected: 0, retry: 1 });
  assert.equal(r.store.getTaskResult(result.result_id).status, 'pending');
  r.store.db.prepare('UPDATE task_results SET next_attempt_at = 0').run();

  c.resume();
  await delivery.pass();
  assert.equal(r.store.getTaskResult(result.result_id).status, 'acked');
  assert.equal(c.store.reviewBrief('TASK-1').verdict, 'passed');
});

// The real `reviewer/main.js`, stopped: it needs no GitHub, and with PATH empty it cannot reach Docker, so it cannot touch real containers.
test('the real reviewer process, stopped: it says so, leaves the queue alone and never calls GitHub', async (t) => {
  const dir = tempDir(t);
  const db = join(dir, 'reviewer.db');
  const path = join(dir, 'stop.json');
  const store = new ReviewStore(db);
  store.enqueue(5, sha(1), { branch: 'x' }, 1000);
  store.close();
  recordStop({ reason: 'drill', path });
  writeFileSync(join(dir, 'token'), 'not-a-real-token');
  const env = {
    GITHUB_REPO: 'o/r', REVIEW_AUTHORS: 'alice', REVIEW_DB: db, REVIEW_TOKEN_FILE: join(dir, 'token'), ADABRA_STOP_FILE: path, PATH: join(dir, 'empty'),
  };

  const poll = await cli(['reviewer/main.js', 'poll-once'], env);
  assert.equal(poll.code, 0, poll.out);
  assert.match(poll.out, /queued 0 new commit/);
  const status = await cli(['reviewer/main.js', 'status'], env);
  assert.match(status.out, /STOPPED by the operator since .*: drill/);
  assert.match(status.out, /queued: 1/);

  const child = spawn(process.execPath, [repo('reviewer/main.js'), 'serve'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const gone = new Promise((r) => child.once('exit', r));
  t.after(() => (child.kill('SIGKILL'), gone));
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));
  await until(async () => out.includes('STOPPED by the operator'), 'the stop in the log');
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGKILL');
  await gone;
  assert.doesNotMatch(out, /running|poll failed|run failed/);
  const after = new ReviewStore(db);
  t.after(() => after.close());
  assert.equal(after.getJob(5, sha(1)).state, 'queued');
  assert.equal(after.getJob(5, sha(1)).attempts, 0);
});

// --- override ---------------------------------------------------------------------------------------------------------

async function fakeGitHub(t) {
  const pulls = new Map();
  const statuses = [];
  const requests = [];
  const state = { failing: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (code, obj) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
      requests.push(`${req.method} ${req.url} ${raw}`);
      if (req.headers.authorization !== 'Bearer review-token-secret') return json(401, {});
      let m;
      if ((m = req.url.match(/^\/repos\/o\/r\/pulls\/(\d+)$/)) && req.method === 'GET') {
        const p = pulls.get(+m[1]);
        return p ? json(200, p) : json(404, { message: 'Not Found' });
      }
      if ((m = req.url.match(/^\/repos\/o\/r\/statuses\/([0-9a-f]+)$/)) && req.method === 'POST') {
        if (state.failing) return json(500, { message: 'down' });
        statuses.push({ sha: m[1], ...JSON.parse(raw) });
        return json(201, {});
      }
      return json(404, {});
    });
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  t.after(() => new Promise((r) => (server.closeAllConnections?.(), server.close(r))));
  const pull = (number, s, over = {}) => {
    pulls.set(number, { number, title: `PR ${number} @octocat`, state: 'open', merged: false, user: { login: 'alice' }, head: { sha: s, ref: `task/TASK-${number}` }, ...over });
  };
  return { pulls, statuses, requests, state, pull, client: new ReviewGitHub({ apiUrl: `http://127.0.0.1:${port}`, repo: 'o/r', token: 'review-token-secret', timeoutMs: 2000 }) };
}

function overrideSetup(t, gh) {
  const dir = tempDir(t);
  const store = new ReviewStore(join(dir, 'reviewer.db'));
  t.after(() => store.close());
  const logFile = join(dir, 'Logs', 'adabra-reviewer.log');
  const said = [];
  const run5 = (over = {}) =>
    runOverride({
      pr: 5, reason: 'the review is wrong @everyone', github: gh.client, store, logFile, say: (m) => said.push(m), by: 'some-user',
      confirm: async () => true, ...over,
    });
  return { store, logFile, said, run5, log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '') };
}

test('override posts success on the current head commit, for adabra/review only, and leaves a record in the reviewer\'s log', async (t) => {
  const gh = await fakeGitHub(t);
  gh.pull(5, sha(1), { title: 'a title\n\u001b[2Jwith tricks' });
  const o = overrideSetup(t, gh);
  o.store.enqueue(5, sha(1), {}, 1000);
  o.store.markDone(5, sha(1), { tests: 'success', review: 'failure' });
  let question;
  assert.equal(await o.run5({ reason: operatorText('the review is wrong @everyone\nnext'), confirm: async (q, expected) => ((question = [q, expected]), true) }), 0);

  assert.deepEqual(gh.statuses, [{ sha: sha(1), state: 'success', context: 'adabra/review', description: OVERRIDE_TEXT }]);
  assert.equal(OVERRIDE_TEXT, 'operator override');
  assert.equal(question[1], 'override 5');

  const log = o.log();
  assert.match(log, new RegExp(`override PR #5 requested sha=${sha(1)} adabra/review=success by=some-user reason=the review is wrong @\\u200Beveryone next\\n`, 'u'));
  assert.match(log, new RegExp(`override PR #5 posted sha=${sha(1)}\\n`));
  assert.equal(log.trim().split('\n').length, 2, 'the reason cannot add a line to the log');
  assert.ok(o.said.includes('PR #5: a title [2Jwith tricks'), 'the PR title is untrusted: one line, no terminal escapes');
});

test('override refuses a closed PR, a merged PR, a missing PR, and a review of this commit that is still to finish', async (t) => {
  const gh = await fakeGitHub(t);
  const o = overrideSetup(t, gh);
  const refused = async (pattern) => {
    o.said.length = 0;
    let asked = false;
    assert.equal(await o.run5({ confirm: async () => ((asked = true), true) }), 1);
    assert.match(o.said.join('\n'), pattern);
    assert.equal(asked, false, 'not even asked');
  };
  await refused(/no pull request #5/);
  gh.pull(5, sha(1), { state: 'closed' });
  await refused(/PR #5 is closed/);
  gh.pull(5, sha(1), { state: 'closed', merged: true });
  await refused(/PR #5 is already merged/);
  gh.pull(5, sha(1));
  o.store.enqueue(5, sha(1), {}, 1000);
  await refused(/is queued, and its result would replace the override/);
  o.store.markRunning(5, sha(1));
  await refused(/is running/);
  assert.deepEqual(gh.statuses, []);
  assert.equal(o.log(), '');
});

test('override: a commit the reviewer has not seen gets a warning, and is still the operator\'s call', async (t) => {
  const gh = await fakeGitHub(t);
  gh.pull(5, sha(1));
  const o = overrideSetup(t, gh);
  assert.equal(await o.run5(), 0);
  assert.match(o.said.join('\n'), /has not seen this commit/);
  assert.equal(gh.statuses.length, 1);
});

test('override acts only on the commit that was shown: a push or a merge while asking stops it', async (t) => {
  const gh = await fakeGitHub(t);
  gh.pull(5, sha(1));
  const o = overrideSetup(t, gh);
  assert.equal(await o.run5({ confirm: async () => (gh.pull(5, sha(2)), true) }), 1);
  assert.match(o.said.join('\n'), /has a new head commit/);
  gh.pull(5, sha(1));
  assert.equal(await o.run5({ confirm: async () => (gh.pull(5, sha(1), { state: 'closed', merged: true }), true) }), 1);
  assert.match(o.said.at(-1), /already merged/);
  gh.pull(5, sha(1));
  assert.equal(await o.run5({ confirm: async () => (o.store.enqueue(5, sha(1), {}, 1000), true) }), 1);
  assert.match(o.said.at(-1), /is queued/);
  assert.deepEqual(gh.statuses, []);
  assert.equal(o.log(), '');
});

test('override: the wrong words post nothing; no log means no override; a failed post is on record; no output ever shows the token', async (t) => {
  const gh = await fakeGitHub(t);
  gh.pull(5, sha(1));
  const o = overrideSetup(t, gh);
  assert.equal(await o.run5({ confirm: async () => false }), 1);
  assert.deepEqual(gh.statuses, []);
  assert.equal(o.log(), '');

  const blocked = join(o.logFile, '..', 'a-file');
  mkdirSync(join(o.logFile, '..'), { recursive: true });
  writeFileSync(blocked, '');
  assert.equal(await o.run5({ logFile: join(blocked, 'log') }), 1);
  assert.match(o.said.at(-1), /could not write to the log.*Nothing posted/);
  assert.deepEqual(gh.statuses, []);

  gh.state.failing = true;
  assert.equal(await o.run5(), 1);
  assert.match(o.log(), /override PR #5 FAILED/);
  assert.deepEqual(gh.statuses, []);

  // A bad token, GitHub refusing every call.
  const bad = new ReviewGitHub({ apiUrl: gh.client.apiUrl, repo: 'o/r', token: 'wrong-secret-value', timeoutMs: 2000 });
  const r = await overrideCommand({ args: ['5', '--reason', 'x'], store: o.store, github: () => bad, terminal: true, confirm: async () => true, say: (m) => o.said.push(m), logFile: o.logFile });
  assert.equal(r, 1);
  const everything = o.said.join('\n') + o.log();
  assert.doesNotMatch(everything, /review-token-secret|wrong-secret-value/);
});

test('a new push loses the override: statuses belong to a commit, and a later override acts on the new head only', async (t) => {
  const gh = await fakeGitHub(t);
  gh.pull(5, sha(1));
  const o = overrideSetup(t, gh);
  assert.equal(await o.run5(), 0);
  const onCommit = (s, context = CONTEXTS.review) => gh.statuses.filter((x) => x.sha === s && x.context === context);
  assert.equal(onCommit(sha(1))[0].state, 'success');

  // The push, seen by the real dispatcher with the same GitHub.
  gh.pull(5, sha(2));
  const r = reviewer(t);
  r.github.setStatus = (...a) => gh.client.setStatus(...a);
  r.pulls.push(r.pull(5, (await gh.client.getPull(5)).sha));
  assert.equal(await r.d.poll(), 1);
  assert.deepEqual(onCommit(sha(2)).map((x) => x.state), ['pending'], 'the new head has no success, so branch protection blocks it');
  assert.equal(onCommit(sha(1)).length, 1, 'the override stays where it was, on the old commit');

  assert.equal(await o.run5(), 0);
  assert.deepEqual(onCommit(sha(2)).map((x) => x.state), ['pending', 'success']);
  assert.equal(onCommit(sha(1)).length, 1);
});

test('override never touches adabra/tests, and the reason never reaches GitHub', async (t) => {
  const gh = await fakeGitHub(t);
  gh.pull(5, sha(1));
  const o = overrideSetup(t, gh);
  assert.equal(await o.run5({ reason: 'secret-looking reason text' }), 0);
  assert.equal(gh.statuses.filter((s) => s.context === CONTEXTS.tests).length, 0);
  assert.equal(gh.requests.filter((r) => r.startsWith('POST') || r.startsWith('PATCH') || r.startsWith('DELETE')).length, 1, 'one write, the status');
  assert.doesNotMatch(gh.requests.join('\n'), /secret-looking/);
});

test('override needs an interactive terminal: a headless run stops before it reads a token or asks GitHub anything', async (t) => {
  const dir = tempDir(t);
  const logFile = join(dir, 'log');
  const r = await cli(['reviewer/main.js', 'override', '5', '--reason', 'x'], {
    GITHUB_REPO: 'o/r', REVIEW_DB: join(dir, 'reviewer.db'), REVIEW_TOKEN_FILE: join(dir, 'there-is-no-token'), REVIEW_LOG_FILE: logFile,
  });
  assert.equal(r.code, 2);
  assert.match(r.out, /needs an interactive terminal/);
  assert.equal(existsSync(logFile), false);

  let read = false;
  const said = [];
  const code = await overrideCommand({ args: ['5', '--reason', 'x'], store: null, github: () => ((read = true), null), terminal: false, say: (m) => said.push(m) });
  assert.equal(code, 2);
  assert.equal(read, false);
});

test('override\'s record goes to the reviewer service\'s own log by default', () => {
  assert.equal(overrideLogPath({}, () => '/home/x'), join('/home/x', 'Library', 'Logs', 'adabra-reviewer.log'));
  assert.equal(overrideLogPath({ REVIEW_LOG_FILE: '/tmp/l' }, () => '/home/x'), '/tmp/l');
  assert.ok(readFileSync(repo('service/reviewer-service.sh'), 'utf8').includes('LOG="$HOME/Library/Logs/adabra-reviewer.log"'));
});

test('override wants a real PR number and a reason', async () => {
  assert.deepEqual(parseOverride(['12', '--reason', 'because']), { pr: 12, reason: 'because' });
  for (const args of [[], ['12'], ['12', '--reason', ''], ['12', '--reason', '\n '], ['abc', '--reason', 'x'], ['-1', '--reason', 'x'], ['1.5', '--reason', 'x'], ['0', '--reason', 'x'], ['1', '2', '--reason', 'x'], ['--reason', 'x'], ['1', '--bad', 'x']]) {
    assert.ok(parseOverride(args).error, JSON.stringify(args));
  }
  const said = [];
  assert.equal(await overrideCommand({ args: ['abc'], store: null, github: () => null, terminal: true, say: (m) => said.push(m) }), 2);
  assert.match(said[0], /usage: override/);
});

test('GitHub client: getPull gives the PR as it is now, and null when there is none', async (t) => {
  const gh = await fakeGitHub(t);
  gh.pull(7, sha(3), { state: 'closed', merged: true });
  assert.deepEqual(await gh.client.getPull(7), {
    number: 7, sha: sha(3), branch: 'task/TASK-7', state: 'closed', merged: true, author: 'alice', title: 'PR 7 @octocat',
  });
  assert.equal(await gh.client.getPull(8), null);
});
