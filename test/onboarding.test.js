import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../coordinator/store.js';
import { ClaimFile } from '../helper/claims.js';
import {
  checkCoordinatorAddress, connectionFailure, isDeviceId, isTaskId, nodeIsTooOld, serviceCommand, setupCommands, shellHints,
  tailscaleCandidates, tailscaleProblem, TOKEN_RE,
} from '../onboarding/common.js';

// What these tests cover: the operator's command and the Mac script, end to end, against a real coordinator process in a temp
// folder on an ephemeral port with dry-run GitHub. Everything runs with a temp HOME, TEAM_AGENT_HOME and COORDINATOR_DB, and with
// fake git, tailscale and launchctl first on PATH, so the real launchctl can never run. They run in the review sandbox too: Linux,
// no network, no git. PowerShell cannot run here, so the Windows script only gets static checks, and those prove little.
const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const posixOnly = { skip: process.platform === 'win32' ? 'runs the Mac script' : false };
const macOnly = { skip: process.platform !== 'darwin' ? 'the background helper script is for macOS' : false };
const elsewhere = { skip: ['darwin', 'win32'].includes(process.platform) ? 'there is a background helper here' : false };

const world = { tokens: [] };

function tool(name, script) {
  const path = join(world.bin, name);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "$ONBOARD_TOOL_LOG"\n${script}\n`);
  chmodSync(path, 0o755);
}

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function waitFor(check, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

function env(extra = {}) {
  return {
    PATH: [world.bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
    HOME: world.userHome,
    TEAM_AGENT_HOME: join(world.dir, 'no-test-should-use-this-home'), // tests about the usual home clear this and set HOME
    COORDINATOR_DB: world.db,
    NODE_OPTIONS: `--import=${world.recorder}`,
    ONBOARD_RECORD: world.record,
    ONBOARD_TOOL_LOG: world.toolLog,
    LAUNCHCTL_STATE: join(world.dir, 'launchctl-loaded'),
    ...extra,
  };
}

before(async () => {
  world.dir = mkdtempSync(join(tmpdir(), 'adabra-onboard-'));
  world.bin = join(world.dir, 'bin');
  world.userHome = join(world.dir, 'user-home');
  world.db = join(world.dir, 'coordinator.db');
  world.toolLog = join(world.dir, 'tools.log');
  world.record = join(world.dir, 'node-processes.log');
  mkdirSync(world.bin);
  mkdirSync(world.userHome);
  writeFileSync(world.toolLog, '');
  writeFileSync(world.record, '');

  // Every Node process started in a test writes down its arguments and environment here, so a test can look for the token.
  const recorder = join(world.dir, 'record-process.mjs');
  writeFileSync(recorder, `import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.ONBOARD_RECORD, JSON.stringify({ argv: process.argv, env: process.env }) + '\\n');\n`);
  world.recorder = pathToFileURL(recorder).href;

  tool('git', `case "$*" in
  --version) echo 'git version 2.50.0' ;;
  *--is-inside-work-tree*) [ -z "$FAKE_NOT_A_CLONE" ] || exit 128; echo true ;;
  *'remote get-url origin'*) [ -n "$FAKE_GIT_REMOTE" ] || exit 2; echo "$FAKE_GIT_REMOTE" ;;
  *) exit 128 ;;
esac`);
  tool('tailscale', `printf '%s' "$FAKE_TAILSCALE_JSON"\nexit "\${FAKE_TAILSCALE_EXIT:-0}"`);
  tool('launchctl', `case "$1" in
  print) [ -f "$LAUNCHCTL_STATE" ] ;;
  bootstrap) : > "$LAUNCHCTL_STATE" ;;
  bootout) rm -f "$LAUNCHCTL_STATE" ;;
esac`);

  const port = await freePort();
  world.url = `http://127.0.0.1:${port}`;
  world.log = '';
  world.coordinator = spawn(process.execPath, [repo('coordinator/main.js'), 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env(), NODE_OPTIONS: undefined, COORDINATOR_PORT: String(port), COORDINATOR_HOST: '127.0.0.1', GITHUB_DRY_RUN: '1' },
  });
  world.coordinator.stdout.on('data', (d) => (world.log += d));
  world.coordinator.stderr.on('data', (d) => (world.log += d));
  await waitFor(async () => {
    try {
      return (await fetch(`${world.url}/healthz`)).ok;
    } catch {
      return false;
    }
  }, 'the coordinator to start');
  world.store = new Store(world.db);
});

after(() => {
  world.coordinator?.kill('SIGKILL');
  world.store?.close();
  rmSync(world.dir, { recursive: true, force: true });
});

function run(file, args, { input, env: extra, onOutput, onChild, stdinOpen } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env(extra) });
    onChild?.(child);
    let out = '';
    const collect = (d) => {
      out += d;
      onOutput?.(out, child);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.stdin.on('error', () => {}); // it may finish without reading what it was given
    if (!stdinOpen) child.stdin.end(input);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const operator = (args, opts) => run(process.execPath, [repo('onboarding/operator.js'), ...args], opts);
const setup = (args, opts) => run('/bin/bash', [repo('onboarding/setup-mac.sh'), ...args], opts);

function tempDir(t) {
  const dir = mkdtempSync(join(world.dir, 'case-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let serial = 0;
function newTask(reserve = {}) {
  serial += 1;
  const task = `TEST-${serial}`;
  world.store.addTask(task, 1000 + serial);
  if (reserve.for) world.store.assignTask(task, reserve.for);
  return { task, issue: 1000 + serial };
}

function otherDevice() {
  serial += 1;
  const id = `other-${serial}`;
  world.tokens.push(world.store.addDevice(id, 'builder'));
  return id;
}

// A device enrolled by the real operator command, with its token in a hand-over file, and the flags for the script.
async function newDevice(t) {
  const dir = tempDir(t);
  serial += 1;
  const device = `builder-${serial}`;
  const { task, issue } = newTask();
  const handover = join(dir, 'handover');
  const r = await operator(['add', device, '--coordinator', world.url, '--test-task', task, '--out', handover]);
  assert.equal(r.code, 0, r.out);
  const token = readFileSync(handover, 'utf8').trim();
  world.tokens.push(token);
  const home = join(dir, 'home');
  return { dir, device, task, issue, handover, token, home, flags: ['--coordinator', world.url, '--device', device, '--test-task', task, '--home', home], operatorOutput: r.out };
}

const SECRET_SHAPE = /[0-9a-f]{64}/;

// The token must not be on screen, in a log, or in any process's arguments or environment.
function assertNoTokenAnywhere(...outputs) {
  for (const output of outputs) assert.doesNotMatch(output, SECRET_SHAPE, 'output has something shaped like a token');
  const places = { 'the coordinator log': world.log, 'recorded arguments and environment': readFileSync(world.record, 'utf8'), 'tool log': readFileSync(world.toolLog, 'utf8') };
  for (const token of world.tokens) {
    for (const [name, text] of Object.entries(places)) assert.ok(!text.includes(token), `a token is in ${name}`);
  }
}

function assertNothingHeld(x) {
  assert.deepEqual(new ClaimFile(x.home).all(), {}, 'no claim recorded locally');
  const claim = world.store.currentClaim(x.task);
  assert.ok(!claim || claim.state === 'released', `not held on the coordinator: ${claim?.state}`);
}

const snapshot = (dir) => Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'latin1')]));

// --- operator's command -----------------------------------------------------------------------------------------------

test('add: enrols a builder, saves the token privately, shows only safe next steps', posixOnly, async (t) => {
  const x = await newDevice(t);
  assert.equal(statSync(x.handover).mode & 0o777, 0o600);
  assert.match(x.token, TOKEN_RE);
  assert.ok(world.store.authenticate(x.device, x.token));
  assert.equal(world.store.deviceRole(x.device), 'builder');
  assertNoTokenAnywhere(x.operatorOutput);

  for (const expected of [
    x.handover,
    `onboarding/setup-mac.sh --coordinator ${world.url} --device ${x.device} --test-task ${x.task}`,
    `onboarding\\setup-windows.ps1 --coordinator ${world.url} --device ${x.device} --test-task ${x.task}`,
    `rm "${x.handover}"`,
    `node onboarding/operator.js revoke ${x.device}`,
    `node onboarding/operator.js rotate ${x.device}`,
    'onboarding/GUIDE.md',
    `${x.task}'s public issue`,
  ]) assert.ok(x.operatorOutput.includes(expected), `next steps mention ${expected}`);
});

test('add: the default place is a private folder outside the repository', posixOnly, async (t) => {
  const dir = tempDir(t);
  const { task } = newTask();
  serial += 1;
  const device = `builder-${serial}`;
  const r = await operator(['add', device, '--coordinator', world.url, '--test-task', task], { env: { HOME: dir } });
  assert.equal(r.code, 0, r.out);
  const folder = join(dir, 'adabra-handover');
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  const file = join(folder, `${device}.token`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  world.tokens.push(readFileSync(file, 'utf8').trim());
  assertNoTokenAnywhere(r.out);
});

test('add: the repository address goes in the next steps, without any credential it was cloned with', posixOnly, async (t) => {
  const dir = tempDir(t);
  const secret = 'not-a-real-credential';
  const add = async (remote, name) => {
    const r = await operator(['add', name, '--coordinator', world.url, '--test-task', newTask().task, '--out', join(dir, name)], { env: { FAKE_GIT_REMOTE: remote } });
    assert.equal(r.code, 0, r.out);
    world.tokens.push(readFileSync(join(dir, name), 'utf8').trim());
    return r.out;
  };
  const withCredential = await add(`https://someone:${secret}@code.example/o/r.git`, `cred-${++serial}`);
  assert.match(withCredential, /Repository: https:\/\/code\.example\/o\/r\.git/);
  assert.ok(!withCredential.includes(secret));
  assert.match(await add('git@code.example:o/r.git', `ssh-${++serial}`), /Repository: git@code\.example:o\/r\.git/);
  assert.match((await operator(['add', `none-${++serial}`, '--coordinator', world.url, '--test-task', newTask().task, '--out', join(dir, 'none')])).out, /Repository: <this repository's address>/);
  world.tokens.push(readFileSync(join(dir, 'none'), 'utf8').trim());
});

test('add: an existing ID is refused and left working; a revoked one is refused with its way back', posixOnly, async (t) => {
  const x = await newDevice(t);
  const again = join(x.dir, 'again');
  const r = await operator(['add', x.device, '--coordinator', world.url, '--test-task', newTask().task, '--out', again]);
  assert.equal(r.code, 1);
  assert.match(r.out, /already exists and was not changed/);
  assert.match(r.out, new RegExp(`operator\\.js rotate ${x.device}`));
  assert.ok(!existsSync(again), 'no file left behind');
  assert.ok(world.store.authenticate(x.device, x.token));

  world.store.revokeDevice(x.device);
  const revoked = await operator(['add', x.device, '--coordinator', world.url, '--test-task', newTask().task, '--out', again]);
  assert.equal(revoked.code, 1);
  assert.match(revoked.out, /was revoked earlier/);
  assert.match(revoked.out, /--restore/);
  assert.ok(!existsSync(again));
});

test('add: bad IDs, addresses and tasks are refused before anything is created, and not repeated back', posixOnly, async (t) => {
  const dir = tempDir(t);
  const out = join(dir, 'never');
  const good = newTask().task;
  const nasty = 'c'.repeat(64);
  const cases = [
    [['add', 'Has-Capitals', '--coordinator', world.url, '--test-task', good], /not a valid device ID/],
    [['add', '-leading', '--coordinator', world.url, '--test-task', good], /usage/], // parsed as an option
    [['add', 'a_b', '--coordinator', world.url, '--test-task', good], /not a valid device ID/],
    [['add', `x${'y'.repeat(63)}`, '--coordinator', world.url, '--test-task', good], /not a valid device ID/],
    [['add', 'fine-id', '--coordinator', 'http://coordinator.example', '--test-task', good], /must start with https:\/\//],
    [['add', 'fine-id', '--test-task', good], /not a valid address/],
    [['add', 'fine-id', '--coordinator', `https://user:${nasty}@coordinator.example`, '--test-task', good], /just the address/],
    [['add', 'fine-id', '--coordinator', world.url], /--test-task is required/],
    [['add', 'fine-id', '--coordinator', world.url, '--test-task', 'nonsense'], /--test-task is required/],
    [['add', 'fine-id', '--coordinator', world.url, '--test-task', 'GONE-1'], /no task GONE-1/],
    [['add', `${nasty}_x`, '--coordinator', world.url, '--test-task', good], /not a valid device ID/],
    [['add'], /usage/],
    [['destroy', 'fine-id'], /usage/],
  ];
  for (const [args, expected] of cases) {
    const r = await operator([...args, '--out', out]);
    assert.notEqual(r.code, 0, args.join(' '));
    assert.match(r.out, expected, args.join(' '));
    assert.ok(!r.out.includes(nasty), 'does not repeat what was given');
    assert.ok(!existsSync(out));
  }
  assert.equal(world.store.deviceRole('fine-id'), null);
});

test('add: a test task the claim would be refused on is refused now, with no device created', posixOnly, async (t) => {
  const dir = tempDir(t);
  const other = otherDevice();
  const closed = newTask().task;
  world.store.db.prepare('UPDATE tasks SET closed = 1 WHERE task_id = ?').run(closed);
  const held = newTask().task;
  world.store.claimTask(held, other, 'RUN-OTHER', Date.now(), 60_000);
  const cases = [
    [closed, /is closed/],
    [newTask({ for: other }).task, new RegExp(`reserved for ${other}`)],
    [held, new RegExp(`being worked on by ${other}`)],
  ];
  for (const [task, expected] of cases) {
    const r = await operator(['add', 'never-made', '--coordinator', world.url, '--test-task', task, '--out', join(dir, 'never')]);
    assert.equal(r.code, 1);
    assert.match(r.out, expected);
    assert.equal(world.store.deviceRole('never-made'), null);
    assert.ok(!existsSync(join(dir, 'never')));
  }
});

test('add: an existing hand-over file is never overwritten, and no device is created', posixOnly, async (t) => {
  const dir = tempDir(t);
  const out = join(dir, 'taken');
  writeFileSync(out, 'something precious');
  const r = await operator(['add', 'never-made-2', '--coordinator', world.url, '--test-task', newTask().task, '--out', out]);
  assert.equal(r.code, 1);
  assert.match(r.out, /already exists and was not changed/);
  assert.equal(readFileSync(out, 'utf8'), 'something precious');
  assert.equal(world.store.deviceRole('never-made-2'), null);
});

test('add: the token file may not go inside the repository', posixOnly, async () => {
  const r = await operator(['add', 'never-made-3', '--coordinator', world.url, '--test-task', newTask().task, '--out', repo('never-made-3.token')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /inside the repository/);
  assert.equal(world.store.deviceRole('never-made-3'), null);
});

test('operator commands refuse a missing database rather than making an empty one', posixOnly, async (t) => {
  const dir = tempDir(t);
  const db = join(dir, 'wrong.db');
  for (const args of [['add', 'x-1', '--coordinator', world.url, '--test-task', 'TEST-1', '--out', join(dir, 'f')], ['rotate', 'x-1'], ['revoke', 'x-1']]) {
    const r = await operator(args, { env: { COORDINATOR_DB: db } });
    assert.equal(r.code, 1);
    assert.match(r.out, /no coordinator database/);
    assert.ok(!existsSync(db));
  }
});

test('rotate: a new token in a file, the old one stops working, and neither is shown', posixOnly, async (t) => {
  const x = await newDevice(t);
  const file = join(x.dir, 'rotated');
  const r = await operator(['rotate', x.device, '--out', file]);
  assert.equal(r.code, 0, r.out);
  const fresh = readFileSync(file, 'utf8').trim();
  world.tokens.push(fresh);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.notEqual(fresh, x.token);
  assert.ok(world.store.authenticate(x.device, fresh));
  assert.ok(!world.store.authenticate(x.device, x.token));
  assertNoTokenAnywhere(r.out);
});

test('rotate: refuses an unknown or a reviewer device, and brings back a revoked one only if asked', posixOnly, async (t) => {
  const x = await newDevice(t);
  const file = join(x.dir, 'rotated');
  const unknown = await operator(['rotate', 'no-such-device', '--out', file]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /no device no-such-device/);

  serial += 1;
  const reviewer = `reviewer-${serial}`;
  world.tokens.push(world.store.addDevice(reviewer, 'reviewer'));
  const role = await operator(['rotate', reviewer, '--out', file]);
  assert.equal(role.code, 1);
  assert.match(role.out, /only handles builders/);

  world.store.revokeDevice(x.device);
  const refused = await operator(['rotate', x.device, '--out', file]);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /--restore/);
  assert.ok(!existsSync(file));
  const restored = await operator(['rotate', x.device, '--restore', '--out', file]);
  assert.equal(restored.code, 0, restored.out);
  const fresh = readFileSync(file, 'utf8').trim();
  world.tokens.push(fresh);
  assert.ok(world.store.authenticate(x.device, fresh));
});

test('revoke: the token stops working, and it says so only when that is true', posixOnly, async (t) => {
  const x = await newDevice(t);
  const r = await operator(['revoke', x.device]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /is revoked/);
  assert.ok(!world.store.authenticate(x.device, x.token));
  assert.match((await operator(['revoke', x.device])).out, /already revoked/);
  const unknown = await operator(['revoke', 'no-such-device']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /Nothing was revoked/);
});

test('revoke: points at a token file still in the default place', posixOnly, async (t) => {
  const dir = tempDir(t);
  serial += 1;
  const device = `builder-${serial}`;
  const added = await operator(['add', device, '--coordinator', world.url, '--test-task', newTask().task], { env: { HOME: dir } });
  assert.equal(added.code, 0, added.out);
  const file = join(dir, 'adabra-handover', `${device}.token`);
  world.tokens.push(readFileSync(file, 'utf8').trim());
  const r = await operator(['revoke', device], { env: { HOME: dir } });
  assert.ok(r.out.includes(`rm "${file}"`));
});

// --- the Mac script, end to end ---------------------------------------------------------------------------------------

test('end to end: hidden input from a pipe, claim, checkpoint, release, with no token anywhere and nothing left held', posixOnly, async (t) => {
  const x = await newDevice(t);
  const r = await setup(x.flags, { input: `${x.token}\n` });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`SUCCESS: device ${x.device} is set up\\. It claimed, checkpointed and released ${x.task}, and nothing is left held\\.`));

  assert.equal(readFileSync(join(x.home, 'token'), 'latin1'), x.token, 'exactly the token, with no line ending');
  assert.equal(statSync(join(x.home, 'token')).mode & 0o777, 0o600);
  assert.equal(statSync(x.home).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(join(x.home, 'config.json'), 'utf8')), { coordinator_url: world.url, device_id: x.device });

  assertNothingHeld(x);
  assert.equal(world.store.currentClaim(x.task).device_id, x.device, 'it really did claim');
  assert.equal(world.store.currentClaim(x.task).state, 'released');

  // What the public issue shows, line by line: fixed words, the device ID, and nothing else about this person or machine.
  const start = await waitFor(() => { const at = world.log.indexOf(`comment on #${x.issue}:`); return at >= 0 && at; }, 'the dry-run comment');
  const body = await waitFor(() => { const m = world.log.slice(start).match(/comment on #\d+:\n([\s\S]*?)\n\d{4}-\d\d-\d\dT.* applied /); return m?.[1]; }, 'the whole comment');
  const lines = body.split('\n');
  assert.deepEqual(lines.slice(0, 9), [
    `<!-- adabra-progress:${x.task} -->`,
    `**${x.task}: Building**`,
    '',
    'Onboarding test: this device can claim, checkpoint and release.',
    '',
    '- Verification: Automated first-run test.',
    '- Next action: None: the test claim is released straight after this.',
    '- Source commit: none',
    '- Unpublished work: unknown',
  ]);
  assert.match(lines[9], new RegExp(`^- Device: ${x.device} \u00b7 run RUN-[0-9a-f]{8} \u00b7 claim generation 1$`));
  assert.match(lines[10], /^- Updated: [-0-9T:.Z]+$/);
  assert.equal(lines.length, 11);

  // The token is on disk in exactly one file of this folder, and in no database anywhere.
  for (const [file, content] of Object.entries(snapshot(x.home))) {
    if (file !== 'token') assert.ok(!content.includes(x.token), `the token is in ${file}`);
  }
  for (const file of readdirSync(world.dir).filter((f) => f.startsWith('coordinator.db'))) {
    assert.ok(!readFileSync(join(world.dir, file), 'latin1').includes(x.token), `the token is in ${file}`);
  }
  assertNoTokenAnywhere(r.out, x.operatorOutput);
});

test('the token stays out of every process: the check itself sees what it is looking for', posixOnly, async (t) => {
  const x = await newDevice(t);
  const marker = 'marker-in-an-argument';
  const r = await setup(x.flags, { input: `${x.token}\n`, env: { ONBOARD_EXTRA: marker } });
  assert.equal(r.code, 0, r.out);
  const lines = readFileSync(world.record, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const here = lines.filter((l) => l.env.ONBOARD_EXTRA === marker);
  const started = here.map((l) => l.argv.slice(1).map((a) => a.split('/').slice(-2).join('/')).join(' '));
  for (const expected of ['onboarding/setup.js', 'helper/cli.js enroll', 'helper/cli.js claim', 'helper/cli.js checkpoint', 'helper/cli.js release']) {
    assert.ok(started.some((s) => s.includes(expected)), `recorded ${expected}: ${started.join(' | ')}`);
  }
  assert.ok(!JSON.stringify(here).includes(x.token));
});

test('a token piped the ways Windows tools write it is saved as plain ASCII', posixOnly, async (t) => {
  for (const encode of [
    (token) => Buffer.from(`\ufeff${token}\r\n`, 'utf16le'),
    (token) => Buffer.from(`\ufeff${token}\r\n`),
    (token) => Buffer.from(`${token}\r\n`),
  ]) {
    const x = await newDevice(t);
    const r = await setup(x.flags, { input: encode(x.token) });
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(readFileSync(join(x.home, 'token')), Buffer.from(x.token, 'ascii'));
  }
});

test('--token-file: reads it, leaves it for the teammate to delete, and tells them to', posixOnly, async (t) => {
  const x = await newDevice(t);
  const r = await setup([...x.flags, '--token-file', x.handover]);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(x.home, 'token'), 'latin1'), x.token);
  assert.ok(existsSync(x.handover));
  assert.ok(r.out.includes(`now delete the file you were sent: rm "${x.handover}"`));
  assertNoTokenAnywhere(r.out);

  const missing = await setup(['--coordinator', world.url, '--device', x.device, '--test-task', x.task, '--home', join(x.dir, 'h2'), '--token-file', join(x.dir, 'nope')]);
  assert.equal(missing.code, 1);
  assert.match(missing.out, /Could not read the token file \(ENOENT\)/);
});

test('safe to re-run: keeps enrolment and token, asks for nothing, and does the test again', posixOnly, async (t) => {
  const x = await newDevice(t);
  assert.equal((await setup(x.flags, { input: `${x.token}\n` })).code, 0);
  const before2 = readFileSync(join(x.home, 'config.json'), 'latin1');
  const r = await setup(x.flags, { input: '' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already enrolled/);
  assert.match(r.out, /it was kept/);
  assert.match(r.out, /SUCCESS/);
  assert.doesNotMatch(r.out, /Paste your device token/);
  assert.equal(readFileSync(join(x.home, 'token'), 'latin1'), x.token);
  assert.equal(readFileSync(join(x.home, 'config.json'), 'latin1'), before2);
  assert.equal(world.store.currentClaim(x.task).generation, 2, 'it did test again');
  assertNothingHeld(x);
  assertNoTokenAnywhere(r.out);
});

test('re-run after an interrupted first run: an enrolment with no token asks for the token and finishes', posixOnly, async (t) => {
  const x = await newDevice(t);
  const first = await setup(x.flags, { input: `${x.token}\n` });
  assert.equal(first.code, 0, first.out);
  rmSync(join(x.home, 'token'));
  const r = await setup(x.flags, { input: `${x.token}\n` });
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(x.home, 'token'), 'latin1'), x.token);
});

test('re-run for another device or coordinator is refused with the way forward, and changes nothing', posixOnly, async (t) => {
  const x = await newDevice(t);
  assert.equal((await setup(x.flags, { input: `${x.token}\n` })).code, 0);
  const saved = snapshot(x.home);
  const otherToken = 'b'.repeat(64);

  const device = await setup(['--coordinator', world.url, '--device', 'someone-else', '--test-task', x.task, '--home', x.home], { input: `${otherToken}\n` });
  assert.equal(device.code, 1);
  assert.match(device.out, /REFUSED/);
  assert.match(device.out, new RegExp(`already enrolled as device ${x.device}`));
  assert.match(device.out, /Nothing was changed/);
  assert.match(device.out, /move the folder away/);
  assert.deepEqual(snapshot(x.home), saved);

  // The same coordinator by another name stands in for one that moved to a new address.
  const moved = world.url.replace('127.0.0.1', 'localhost');
  const address = await setup(['--coordinator', moved, '--device', x.device, '--test-task', x.task, '--home', x.home], { input: `${otherToken}\n` });
  assert.equal(address.code, 1);
  assert.match(address.out, /keep your token and run/);
  assert.ok(address.out.includes(`enroll ${moved} ${x.device}`));
  assert.deepEqual(snapshot(x.home), saved);
  assertNoTokenAnywhere(device.out, address.out);
});

test('a folder that is not an enrolment is refused and left alone', posixOnly, async (t) => {
  const x = await newDevice(t);
  mkdirSync(x.home, { mode: 0o755 });
  writeFileSync(join(x.home, 'token'), 'an existing token');
  const mode = statSync(x.home).mode;
  const orphan = await setup(x.flags, { input: `${x.token}\n` });
  assert.equal(orphan.code, 1);
  assert.match(orphan.out, /REFUSED/);
  assert.match(orphan.out, /no enrolment in it/);
  assert.equal(readFileSync(join(x.home, 'token'), 'utf8'), 'an existing token');
  assert.equal(statSync(x.home).mode, mode, 'a folder that is refused keeps its permissions');

  writeFileSync(join(x.home, 'config.json'), 'not json');
  const broken = await setup(x.flags, { input: `${x.token}\n` });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /cannot be read as an enrolment/);
});

test('an already-saved token that others could read is tightened, not replaced', posixOnly, async (t) => {
  const x = await newDevice(t);
  assert.equal((await setup(x.flags, { input: `${x.token}\n` })).code, 0);
  chmodSync(join(x.home, 'token'), 0o644);
  chmodSync(x.home, 0o755);
  const r = await setup(x.flags, { input: '' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /could be read by others/);
  assert.equal(statSync(join(x.home, 'token')).mode & 0o777, 0o600);
  assert.equal(statSync(x.home).mode & 0o777, 0o700);
  assert.equal(readFileSync(join(x.home, 'token'), 'latin1'), x.token);
});

// --- things that go wrong ---------------------------------------------------------------------------------------------

test('failed connection: says what it probably means, and creates nothing', posixOnly, async (t) => {
  const x = await newDevice(t);
  const closed = `http://127.0.0.1:${await freePort()}`;
  const local = await setup(['--coordinator', closed, '--device', x.device, '--test-task', x.task, '--home', x.home], { input: `${x.token}\n` });
  assert.equal(local.code, 1);
  assert.match(local.out, /FAIL  Could not reach the coordinator/);
  assert.match(local.out, /Most likely the coordinator is not running on this machine/);
  assert.match(local.out, /NOT SET UP/);
  assert.ok(!existsSync(x.home));

  const flags = ['--coordinator', 'https://coordinator.invalid', '--device', x.device, '--test-task', x.task, '--home', x.home];
  const running = await setup(flags, { input: `${x.token}\n`, env: { FAKE_TAILSCALE_JSON: '{"BackendState":"Running","Self":{"HostName":"secret-host"}}' } });
  assert.equal(running.code, 1);
  assert.match(running.out, /ok    Tailscale is connected/);
  assert.match(running.out, /Most likely this machine is not on the tailnet yet, or the address is wrong/);
  assert.match(running.out, /Fix: Check Tailscale is connected/);
  assert.doesNotMatch(running.out, /secret-host/, 'nothing from Tailscale but the state is repeated');
  assert.ok(!existsSync(x.home));
  assertNoTokenAnywhere(local.out, running.out);
});

test('Tailscale off, signed out or not running: names that as the fix, even though the connection fails too', posixOnly, async (t) => {
  const x = await newDevice(t);
  const flags = ['--coordinator', 'https://coordinator.invalid', '--device', x.device, '--test-task', x.task, '--home', x.home];
  for (const [fake, expected] of [
    [{ FAKE_TAILSCALE_JSON: '{"BackendState":"Stopped"}' }, /FAIL  Tailscale is switched off/],
    [{ FAKE_TAILSCALE_JSON: '{"BackendState":"NeedsLogin"}' }, /FAIL  Tailscale is not signed in/],
    [{ FAKE_TAILSCALE_EXIT: '1' }, /FAIL  Tailscale is installed, but it is not running/],
  ]) {
    const r = await setup(flags, { input: '', env: fake });
    assert.equal(r.code, 1);
    assert.match(r.out, expected);
    assert.match(r.out, /Sort out Tailscale as above first/);
    assert.ok(!existsSync(x.home));
  }
});

test('something other than a coordinator at the address is called out', posixOnly, async (t) => {
  const x = await newDevice(t);
  const server = http.createServer((req, res) => (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<html>hello</html>')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => (server.closeAllConnections(), server.close(r))));
  const r = await setup(['--coordinator', `http://127.0.0.1:${server.address().port}`, '--device', x.device, '--test-task', x.task, '--home', x.home], { input: `${x.token}\n` });
  assert.equal(r.code, 1);
  assert.match(r.out, /it is not the coordinator/);
  assert.ok(!existsSync(x.home));
  assertNoTokenAnywhere(r.out);
});

test('bad input: an address, ID or task is checked first, and never repeated back', posixOnly, async (t) => {
  const dir = tempDir(t);
  const nasty = 'd'.repeat(64);
  const home = join(dir, 'home');
  const good = ['--coordinator', world.url, '--device', 'a-device', '--test-task', 'TEST-1', '--home', home];
  const cases = [
    [['--device', 'a-device', '--test-task', 'TEST-1'], /usage/],
    [['--coordinator', 'http://coordinator.example', '--device', 'a-device', '--test-task', 'TEST-1'], /must start with https:\/\//],
    [['--coordinator', 'ftp://coordinator.example', '--device', 'a-device', '--test-task', 'TEST-1'], /must start with https:\/\//],
    [['--coordinator', 'https://coordinator.example/some/path', '--device', 'a-device', '--test-task', 'TEST-1'], /just the address/],
    [['--coordinator', nasty, '--device', 'a-device', '--test-task', 'TEST-1'], /not a valid address/],
    [['--coordinator', world.url, '--device', nasty.toUpperCase(), '--test-task', 'TEST-1'], /not a valid device ID/],
    [['--coordinator', world.url, '--device', 'a-device', '--test-task', nasty], /not a valid task ID/],
    [[...good, '--token', nasty], /usage/],
    [[...good, nasty], /usage/],
  ];
  for (const [args, expected] of cases) {
    const r = await setup(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.out, expected);
    assert.ok(!r.out.toLowerCase().includes(nasty), `repeats what was given: ${args.join(' ')}`);
    assert.ok(!existsSync(home));
  }
  assert.equal((await setup(['--help'])).code, 0);
});

test('a token of the wrong form, the wrong token, or none: nothing is saved, and the input is not repeated', posixOnly, async (t) => {
  const x = await newDevice(t);
  const wrongForm = 'not-the-right-shape-of-token';
  const form = await setup(x.flags, { input: `${wrongForm}\n` });
  assert.equal(form.code, 1);
  assert.match(form.out, new RegExp(`not a device token: one is 64 characters of 0-9 and a-f, and this was ${wrongForm.length}`));
  assert.ok(!form.out.includes(wrongForm));

  const wrong = 'e'.repeat(64);
  const refused = await setup(x.flags, { input: `${wrong}\n` });
  assert.equal(refused.code, 1);
  assert.match(refused.out, /The coordinator refused that token/);
  assert.match(refused.out, /It was not saved/);
  assert.ok(!refused.out.includes(wrong));

  const none = await setup(x.flags, { input: '' });
  assert.equal(none.code, 1);
  assert.match(none.out, /No token was given/);

  assert.ok(!existsSync(x.home), 'nothing written, so the next run starts clean');
  assert.ok(!world.log.includes(wrong), 'a refused token is not logged either');
});

test('a device revoked later: the saved token is left as it is, and the way forward is clear', posixOnly, async (t) => {
  const x = await newDevice(t);
  assert.equal((await setup(x.flags, { input: `${x.token}\n` })).code, 0);
  world.store.revokeDevice(x.device);
  const r = await setup(x.flags, { input: '' });
  assert.equal(r.code, 1);
  assert.match(r.out, /refused the token saved/);
  assert.ok(r.out.includes(`rm "${join(x.home, 'token')}"`));
  assert.equal(readFileSync(join(x.home, 'token'), 'latin1'), x.token);
  assertNoTokenAnywhere(r.out);
});

test('a reviewer device cannot be set up as a builder', posixOnly, async (t) => {
  const dir = tempDir(t);
  serial += 1;
  const device = `reviewer-${serial}`;
  const token = world.store.addDevice(device, 'reviewer');
  world.tokens.push(token);
  const r = await setup(['--coordinator', world.url, '--device', device, '--test-task', newTask().task, '--home', join(dir, 'h')], { input: `${token}\n` });
  assert.equal(r.code, 1);
  assert.match(r.out, /not a builder/);
  assert.ok(!existsSync(join(dir, 'h')));
});

test('a refused claim says why in plain words, and nothing is left held', posixOnly, async (t) => {
  const other = otherDevice();
  const held = newTask();
  world.store.claimTask(held.task, other, 'RUN-OTHER', Date.now(), 60_000);
  const cases = [
    [newTask({ for: other }).task, new RegExp(`refused the claim on \\S+: reserved for ${other}\\. Nothing was claimed, and nothing is held\\.`)],
    [held.task, new RegExp(`refused the claim on \\S+: already being worked on by ${other}\\. Nothing was claimed`)],
    ['GONE-999', /GONE-999 does not exist on the coordinator\. Nothing was claimed, and nothing is held\./],
  ];
  for (const [task, expected] of cases) {
    const x = await newDevice(t);
    const r = await setup(['--coordinator', world.url, '--device', x.device, '--test-task', task, '--home', x.home], { input: `${x.token}\n` });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, expected);
    assert.match(r.out, /Ask your operator for another test task/);
    assert.doesNotMatch(r.out, /SUCCESS/);
    assert.deepEqual(new ClaimFile(x.home).all(), {});
    assert.notEqual(world.store.currentClaim(task)?.device_id, x.device);
    // Enrolment and token are kept, so the next run needs only the new task.
    assert.equal(readFileSync(join(x.home, 'token'), 'latin1'), x.token);
    assertNoTokenAnywhere(r.out);
  }
  world.store.db.prepare("UPDATE claims SET state = 'released' WHERE task_id = ?").run(held.task);
});

test('a task this device already holds is left alone: it may be real work', posixOnly, async (t) => {
  const x = await newDevice(t);
  assert.equal((await setup(x.flags, { input: `${x.token}\n` })).code, 0);
  const real = world.store.claimTask(x.task, x.device, 'RUN-REAL', Date.now(), 60_000);
  assert.ok(real.ok);
  const claims = new ClaimFile(x.home);
  claims.set(x.task, { run_id: 'RUN-REAL', generation: real.generation, expires_at: real.expires_at });
  const r = await setup(x.flags, { input: '' });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`already holds ${x.task}`));
  assert.match(r.out, new RegExp(`release ${x.task}`));
  assert.equal(world.store.currentClaim(x.task).state, 'held');
  assert.equal(world.store.currentClaim(x.task).run_id, 'RUN-REAL');
  assert.equal(claims.get(x.task).run_id, 'RUN-REAL');
  world.store.releaseClaim(x.task, x.device, 'RUN-REAL', real.generation);
  claims.remove(x.task);
});

// A coordinator that misbehaves on purpose, for what a real one will not do on request. Answers everything else as a real one does.
async function stubCoordinator(t, handlers) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    const json = (code, obj) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
    req.resume();
    req.on('end', () => {
      const custom = handlers[req.url];
      if (custom) return custom(json);
      if (req.url === '/healthz') return json(200, { ok: true });
      if (req.url === '/v1/tasks/mine') return json(200, { tasks: [] });
      if (req.url === '/v1/claims') return json(200, { status: 'ok', generation: 1, expires_at: Date.now() + 60_000, lease_ms: 60_000 });
      if (req.url === '/v1/events') return json(200, { status: 'accepted' });
      if (req.url === '/v1/claims/release') return json(200, { status: 'ok' });
      return json(404, {});
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => (server.closeAllConnections(), server.close(r))));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

const stubFlags = (stub, dir) => ['--coordinator', stub.url, '--device', 'stub-device', '--test-task', 'TEST-1', '--home', join(dir, 'home')];

test('a checkpoint the coordinator refuses still ends with the claim released, and counts as a failure', posixOnly, async (t) => {
  const stub = await stubCoordinator(t, { '/v1/events': (json) => json(409, { error: 'stale or missing claim' }) });
  const dir = tempDir(t);
  const r = await setup(stubFlags(stub, dir), { input: `${'a'.repeat(64)}\n` });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /did not accept the checkpoint/);
  assert.match(r.out, /released; nothing is left held/);
  assert.doesNotMatch(r.out, /SUCCESS/);
  assert.equal(stub.calls.filter((c) => c === '/v1/claims/release').length, 1);
  assert.deepEqual(new ClaimFile(join(dir, 'home')).all(), {});
});

test('a claim that cannot be released says so plainly, and how to end it', posixOnly, async (t) => {
  const stub = await stubCoordinator(t, { '/v1/claims/release': (json) => json(500, { error: 'internal error' }) });
  const dir = tempDir(t);
  const r = await setup(stubFlags(stub, dir), { input: `${'a'.repeat(64)}\n` });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /could not be released, so it is still held/);
  assert.match(r.out, /release TEST-1/);
  assert.doesNotMatch(r.out, /SUCCESS/);
  assert.equal(stub.calls.filter((c) => c === '/v1/claims/release').length, 3, 'it tries more than once');
});

test('stopping it during the test still releases the claim', posixOnly, async (t) => {
  let script;
  const stub = await stubCoordinator(t, {
    // The checkpoint is on its way when the signal arrives, and gets through.
    '/v1/events': (json) => {
      script.kill('SIGINT');
      setTimeout(() => json(200, { status: 'accepted' }), 100);
    },
  });
  const dir = tempDir(t);
  const r = await setup(stubFlags(stub, dir), { input: `${'a'.repeat(64)}\n`, onChild: (child) => { script = child; } });
  assert.equal(r.code, 130, r.out);
  assert.match(r.out, /Stopped\./);
  assert.match(r.out, /released; nothing is left held/);
  assert.equal(stub.calls.filter((c) => c === '/v1/claims/release').length, 1);
  assert.deepEqual(new ClaimFile(join(dir, 'home')).all(), {});
});

// --- a machine that already has a helper ------------------------------------------------------------------------------

function pretendRealMachine(t) {
  const dir = tempDir(t);
  const home = join(dir, 'home-folder');
  const real = join(home, '.team-agent');
  mkdirSync(real, { recursive: true, mode: 0o700 });
  writeFileSync(join(real, 'config.json'), JSON.stringify({ coordinator_url: 'https://real-coordinator.example', device_id: 'real-device' }));
  writeFileSync(join(real, 'token'), 'f'.repeat(64), { mode: 0o600 });
  const agents = join(home, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  const plist = join(agents, 'ai.adabra.helper.plist');
  writeFileSync(plist, 'the real service');
  return { dir, home, real, plist, state: join(dir, 'launchctl-loaded') };
}

const launchctlCalls = () => readFileSync(world.toolLog, 'utf8').split('\n').filter((l) => l.startsWith('launchctl'));

test('--home on a machine with a helper: the real folder and service are untouched, even without --skip-service', posixOnly, async (t) => {
  const m = pretendRealMachine(t);
  const savedReal = snapshot(m.real);
  const calls = launchctlCalls().length;
  const x = await newDevice(t);
  const r = await setup(x.flags, { input: `${x.token}\n`, env: { HOME: m.home, TEAM_AGENT_HOME: undefined, LAUNCHCTL_STATE: m.state } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not installed: this is a separate folder/);
  assert.match(r.out, /SUCCESS/);
  assert.deepEqual(snapshot(m.real), savedReal);
  assert.equal(readFileSync(m.plist, 'utf8'), 'the real service');
  assert.equal(launchctlCalls().length, calls, 'launchctl was not called');
});

test('a separate folder through TEAM_AGENT_HOME is treated just as --home is', posixOnly, async (t) => {
  const m = pretendRealMachine(t);
  const savedReal = snapshot(m.real);
  const calls = launchctlCalls().length;
  const x = await newDevice(t);
  const flags = ['--coordinator', world.url, '--device', x.device, '--test-task', x.task];
  const r = await setup(flags, { input: `${x.token}\n`, env: { HOME: m.home, TEAM_AGENT_HOME: x.home, LAUNCHCTL_STATE: m.state } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not installed: this is a separate folder/);
  assert.equal(readFileSync(join(x.home, 'token'), 'latin1'), x.token);
  assert.deepEqual(snapshot(m.real), savedReal);
  assert.equal(launchctlCalls().length, calls);
});

test('without --home on that machine: refused, with the way to test named first', posixOnly, async (t) => {
  const m = pretendRealMachine(t);
  const savedReal = snapshot(m.real);
  const calls = launchctlCalls().length;
  const x = await newDevice(t);
  const flags = ['--coordinator', world.url, '--device', x.device, '--test-task', x.task];
  const r = await setup(flags, { input: `${x.token}\n`, env: { HOME: m.home, TEAM_AGENT_HOME: undefined, LAUNCHCTL_STATE: m.state } });
  assert.equal(r.code, 1);
  assert.match(r.out, /already enrolled as device real-device/);
  assert.match(r.out, /add --home <a new folder>/);
  assert.deepEqual(snapshot(m.real), savedReal);
  assert.equal(launchctlCalls().length, calls);
});

test('--skip-service on the usual folder: enrols and tests, and says how to install it later', posixOnly, async (t) => {
  const dir = tempDir(t);
  const calls = launchctlCalls().length;
  const x = await newDevice(t);
  const flags = ['--coordinator', world.url, '--device', x.device, '--test-task', x.task, '--skip-service'];
  const r = await setup(flags, { input: `${x.token}\n`, env: { HOME: dir, TEAM_AGENT_HOME: undefined } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not installed, as you asked/);
  assert.ok(r.out.includes(`"${repo('service/helper-service.sh')}" install`));
  assert.equal(readFileSync(join(dir, '.team-agent', 'token'), 'latin1'), x.token);
  assert.equal(launchctlCalls().length, calls);
});

test('the background helper: installed through the real script with a fake launchctl, then left alone on a re-run', macOnly, async (t) => {
  const dir = tempDir(t);
  const state = join(dir, 'launchctl-loaded');
  const x = await newDevice(t);
  const flags = ['--coordinator', world.url, '--device', x.device, '--test-task', x.task];
  const envFor = { HOME: dir, TEAM_AGENT_HOME: undefined, LAUNCHCTL_STATE: state };
  assert.equal(execFileSync('/bin/sh', ['-c', 'command -v launchctl'], { env: env(envFor), encoding: 'utf8' }).trim(), join(world.bin, 'launchctl'), 'the real launchctl must never run');

  const r = await setup(flags, { input: `${x.token}\n`, env: envFor });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /installed and running/);
  assert.match(r.out, /SUCCESS/);
  const plist = readFileSync(join(dir, 'Library', 'LaunchAgents', 'ai.adabra.helper.plist'), 'utf8');
  assert.ok(plist.includes(`<string>${join(dir, '.team-agent')}</string>`));
  assert.ok(!plist.includes(x.token));
  assert.equal(launchctlCalls().filter((l) => l.startsWith('launchctl bootstrap')).length >= 1, true);

  const bootstraps = launchctlCalls().filter((l) => l.startsWith('launchctl bootstrap')).length;
  const again = await setup(flags, { input: '', env: envFor });
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /already running; it was left alone/);
  assert.equal(launchctlCalls().filter((l) => l.startsWith('launchctl bootstrap')).length, bootstraps);
  assertNoTokenAnywhere(r.out, again.out);
});

test('where there is no background helper at all, it says so and carries on', elsewhere, async (t) => {
  const dir = tempDir(t);
  const x = await newDevice(t);
  const flags = ['--coordinator', world.url, '--device', x.device, '--test-task', x.task];
  const r = await setup(flags, { input: `${x.token}\n`, env: { HOME: dir, TEAM_AGENT_HOME: undefined } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /there is none for this kind of machine/);
});

// --- prerequisites ----------------------------------------------------------------------------------------------------

const realTool = (name) => execFileSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim();

function binWith(t, tools) {
  const bin = join(tempDir(t), 'bin');
  mkdirSync(bin);
  for (const [name, target] of Object.entries(tools)) {
    if (target.startsWith('#!')) {
      writeFileSync(join(bin, name), target);
      chmodSync(join(bin, name), 0o755);
    } else symlinkSync(target, join(bin, name));
  }
  return bin;
}

test('no Node: the exact fix, before anything else happens', posixOnly, async (t) => {
  const bin = binWith(t, { dirname: realTool('dirname') });
  const r = await setup(['--coordinator', world.url, '--device', 'a', '--test-task', 'TEST-1'], { env: { PATH: bin } });
  assert.equal(r.code, 1);
  assert.match(r.out, /Node was not found: this needs Node 22\.13 or newer/);
  assert.match(r.out, /https:\/\/nodejs\.org\/en\/download/);
});

test('an old or broken Node: the exact fix, and the version it found', posixOnly, async (t) => {
  for (const old of ['20.11.0', '22.12.0']) {
    const bin = binWith(t, { dirname: realTool('dirname'), node: `#!/bin/sh\necho ${old}\n` });
    const r = await setup(['--coordinator', world.url, '--device', 'a', '--test-task', 'TEST-1'], { env: { PATH: bin } });
    assert.equal(r.code, 1);
    assert.ok(r.out.includes(`Node ${old} is too old: this needs Node 22.13 or newer`), r.out);
  }
  const bin = binWith(t, { dirname: realTool('dirname'), node: '#!/bin/sh\nexit 7\n' });
  const broken = await setup(['--help'], { env: { PATH: bin } });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /did not run: this needs Node 22\.13 or newer/);
});

test('no git, or not a clone: named with the exact fix, with nothing else done', posixOnly, async (t) => {
  const x = await newDevice(t);
  const bin = binWith(t, { dirname: realTool('dirname'), node: process.execPath });
  const noGit = await setup(x.flags, { input: `${x.token}\n`, env: { PATH: bin } });
  assert.equal(noGit.code, 1, noGit.out);
  assert.match(noGit.out, /FAIL  git was not found/);
  assert.match(noGit.out, /xcode-select --install|git-scm/);
  assert.ok(!existsSync(x.home));

  const notClone = await setup(x.flags, { input: `${x.token}\n`, env: { FAKE_NOT_A_CLONE: '1' } });
  assert.equal(notClone.code, 1);
  assert.match(notClone.out, /This folder is not a clone of the repository/);
  assert.match(notClone.out, /Fix: Run git clone/);
  assert.ok(!existsSync(x.home));
});

test('every prerequisite problem is reported in one run', posixOnly, async (t) => {
  const bin = binWith(t, { dirname: realTool('dirname'), node: process.execPath });
  const r = await setup(['--coordinator', `http://127.0.0.1:${await freePort()}`, '--device', 'a-device', '--test-task', 'TEST-1', '--home', join(tempDir(t), 'h')], { env: { PATH: bin } });
  assert.equal(r.code, 1);
  assert.match(r.out, /git was not found/);
  assert.match(r.out, /Could not reach the coordinator/);
});

test('no repository around the script: says to clone it', posixOnly, async (t) => {
  const copy = join(tempDir(t), 'onboarding');
  mkdirSync(copy);
  writeFileSync(join(copy, 'setup-mac.sh'), readFileSync(repo('onboarding/setup-mac.sh')));
  const r = await run('/bin/bash', [join(copy, 'setup-mac.sh'), '--help']);
  assert.equal(r.code, 1);
  assert.match(r.out, /The repository was not found around this script/);
  assert.match(r.out, /git clone/);
});

test('with real git: the checkpoint names no commit, even in a repository that has one', posixOnly, async (t) => {
  let git;
  try {
    git = realTool('git');
    execFileSync(git, ['-C', repo('.'), 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
  } catch {
    t.skip('no git, or not a clone (the review sandbox has neither)');
    return;
  }
  const bin = binWith(t, { git, dirname: realTool('dirname'), node: process.execPath });
  const x = await newDevice(t);
  const parent = dirname(x.home);
  const gitEnv = { PATH: `/usr/bin:/bin`, HOME: parent, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  execFileSync(git, ['init', '-q', parent], { env: gitEnv });
  execFileSync(git, ['-C', parent, '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'x'], { env: gitEnv });
  mkdirSync(x.home);
  const r = await setup(x.flags, { input: `${x.token}\n`, env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(r.code, 0, r.out);
  const start = await waitFor(() => { const at = world.log.indexOf(`comment on #${x.issue}:`); return at >= 0 && at; }, 'the dry-run comment');
  const body = await waitFor(() => world.log.slice(start).match(/comment on #\d+:\n([\s\S]*?)\n\d{4}-\d\d-\d\dT.* applied /)?.[1], 'the whole comment');
  assert.match(body, /- Source commit: none/);
});

// --- a real terminal --------------------------------------------------------------------------------------------------

// `script` runs a command in a real pseudo-terminal, so echo really is at stake. Skipped where it does not work. The `cat` is
// there because macOS's `script` will not start with the socket Node gives a child for stdin, but takes a plain pipe.
function inTerminal(args) {
  const scriptArgs = process.platform === 'darwin' ? ['-q', '/dev/null', ...args] : ['-qec', args.map((a) => `'${a}'`).join(' '), '/dev/null'];
  return { file: '/bin/sh', args: ['-c', 'cat | exec script "$@"', 'sh', ...scriptArgs] };
}

async function terminalWorks() {
  const c = inTerminal([process.execPath, '-e', 'console.log(process.stdin.isTTY === true ? "yes-a-tty" : "no-tty")']);
  return (await run(c.file, c.args, { env: { NODE_OPTIONS: undefined } })).out.includes('yes-a-tty');
}

test('in a real terminal: the prompt shows, what is pasted does not, and it works', posixOnly, async (t) => {
  if (!(await terminalWorks())) {
    t.skip('no working pseudo-terminal here');
    return;
  }
  const x = await newDevice(t);
  const c = inTerminal(['/bin/bash', repo('onboarding/setup-mac.sh'), ...x.flags]);
  let sent = false;
  const r = await run(c.file, c.args, {
    stdinOpen: true,
    onOutput: (out, child) => {
      if (!sent && out.includes('Nothing will show as you paste')) {
        sent = true;
        child.stdin.end(`${x.token}\r`); // only now: echo is on until the prompt has turned it off
      }
    },
  });
  assert.ok(sent, r.out);
  assert.match(r.out, /SUCCESS/, r.out);
  assert.equal(readFileSync(join(x.home, 'token'), 'latin1'), x.token);
  assert.match(r.out, /copy something else, so the token is not left on your clipboard/);
  assertNoTokenAnywhere(r.out);
});

test('in a real terminal: Ctrl+C at the prompt cancels and saves nothing', posixOnly, async (t) => {
  if (!(await terminalWorks())) {
    t.skip('no working pseudo-terminal here');
    return;
  }
  const x = await newDevice(t);
  const c = inTerminal(['/bin/bash', repo('onboarding/setup-mac.sh'), ...x.flags]);
  let sent = false;
  const r = await run(c.file, c.args, {
    stdinOpen: true,
    onOutput: (out, child) => {
      if (!sent && out.includes('Nothing will show as you paste')) {
        sent = true;
        child.stdin.end(`${x.token.slice(0, 10)}\x03`);
      }
    },
  });
  assert.ok(sent, r.out);
  assert.match(r.out, /Cancelled\. No token was saved\./);
  assert.ok(!existsSync(join(x.home, 'token')));
  assert.ok(!r.out.includes(x.token.slice(0, 10)));
});

// --- the rules ---------------------------------------------------------------------------------------------------------

test('addresses: https, or http only for this machine; only ever the address', () => {
  for (const [input, url] of [
    ['https://coordinator.example', 'https://coordinator.example'],
    ['https://coordinator.example/', 'https://coordinator.example'],
    ['HTTPS://Coordinator.Example:8443', 'https://coordinator.example:8443'],
    ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
    ['http://localhost:8787/', 'http://localhost:8787'],
    ['http://[::1]:8787', 'http://[::1]:8787'],
  ]) assert.deepEqual(checkCoordinatorAddress(input), { url }, input);
  for (const input of [
    undefined, '', 'coordinator.example', 'http://coordinator.example', 'http://10.0.0.5:8787', 'ftp://coordinator.example',
    'https://user:pw@coordinator.example', 'https://coordinator.example/path', 'https://coordinator.example/?a=1', 'https://coordinator.example/#x',
    'file:///etc/passwd',
  ]) assert.ok(checkCoordinatorAddress(input).error, String(input));
});

test('IDs follow the rules the coordinator already checks', () => {
  for (const good of ['a', 'builder-3', '0x', 'a'.repeat(63)]) assert.ok(isDeviceId(good), good);
  for (const bad of ['', 'A', '-a', 'a_b', 'a b', 'a'.repeat(64), undefined]) assert.ok(!isDeviceId(bad), String(bad));
  for (const good of ['TASK-1', 'T2-999999999']) assert.ok(isTaskId(good), good);
  for (const bad of ['task-1', 'TASK', 'TASK-', 'TASK-1234567890', undefined]) assert.ok(!isTaskId(bad), String(bad));
});

test('Node versions: 22.13 is the first that will do', () => {
  for (const old of ['18.0.0', '22.5.1', '22.12.9']) assert.ok(nodeIsTooOld(old), old);
  for (const fine of ['22.13.0', '22.20.0', '23.0.0', '26.13.0']) assert.ok(!nodeIsTooOld(fine), fine);
});

test('the form the script checks is the form the coordinator issues', (t) => {
  const dir = tempDir(t);
  const store = new Store(join(dir, 'c.db'));
  t.after(() => store.close());
  assert.match(store.addDevice('some-device'), TOKEN_RE);
  assert.match(store.rotateDevice('some-device'), TOKEN_RE);
});

test('connection failures: says what it probably means for each kind', () => {
  const via = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
  const tailnet = /not on the tailnet yet, or the address is wrong/;
  const url = 'https://coordinator.example';
  assert.match(connectionFailure(via('ENOTFOUND'), url), /does not resolve/);
  assert.match(connectionFailure(via('ENOTFOUND'), url), tailnet);
  assert.match(connectionFailure(via('ECONNREFUSED'), url), /Nothing is listening/);
  assert.match(connectionFailure(via('UND_ERR_CONNECT_TIMEOUT'), url), /Nothing answered in time/);
  assert.match(connectionFailure(via('DEPTH_ZERO_SELF_SIGNED_CERT'), url), /secure connection failed/);
  assert.match(connectionFailure(via('EWHATEVER'), url), /\(EWHATEVER\)/);
  const timeout = new DOMException('timed out', 'TimeoutError');
  assert.match(connectionFailure(timeout, url), /Nothing answered in time.*\(TimeoutError\)/);
  assert.match(connectionFailure(via('ECONNREFUSED'), 'http://127.0.0.1:8787'), /coordinator is not running on this machine/);
});

test('Tailscale states: only Running passes, and each other state has its own fix', () => {
  assert.deepEqual(tailscaleProblem({ found: true, code: 0, stdout: '{"BackendState":"Running"}' }), {});
  for (const [state, expected] of [
    ['Stopped', /switched off/], ['NeedsLogin', /not signed in/], ['NoState', /not signed in/],
    ['NeedsMachineAuth', /to be approved/], ['Starting', /still starting/], ['Whatever', /not running/],
  ]) {
    const r = tailscaleProblem({ found: true, code: 0, stdout: JSON.stringify({ BackendState: state }) });
    assert.match(r.problem, expected, state);
    assert.ok(r.fix, state);
  }
  assert.match(tailscaleProblem({ found: true, code: 1, stdout: '' }).problem, /not running/);
  assert.match(tailscaleProblem({ found: true, code: 0, stdout: 'not json' }).problem, /not running/);
  assert.match(tailscaleProblem({ found: false }).problem, /not installed/);
  assert.match(tailscaleProblem({ found: false }).fix, /tailscale\.com\/download/);
  assert.equal(tailscaleCandidates('darwin')[1], '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  assert.equal(tailscaleCandidates('win32', { ProgramFiles: 'D:\\P' })[1], 'D:\\P\\Tailscale\\tailscale.exe');
  assert.deepEqual(tailscaleCandidates('linux'), ['tailscale']);
});

test('the service command fits the platform, and on Windows is the built-in PowerShell by full path', () => {
  assert.deepEqual(serviceCommand('status', { repoDir: '/r', platform: 'darwin' }), { file: '/r/service/helper-service.sh', args: ['status'] });
  assert.equal(serviceCommand('install', { repoDir: '/r', platform: 'linux' }), null);
  const win = serviceCommand('protect', { repoDir: 'C:\\My Repo', platform: 'win32', env: { SystemRoot: 'D:\\Win' } });
  assert.equal(win.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(win.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\My Repo\\service\\helper-service.ps1', 'protect']);
});

test('the hints fit the platform, and quote paths with spaces', () => {
  const win = shellHints('win32');
  assert.equal(win.remove('C:\\A B\\token'), 'Remove-Item -LiteralPath "C:\\A B\\token"');
  assert.equal(win.moveAway('C:\\A B'), 'Move-Item -LiteralPath "C:\\A B" -Destination "C:\\A B.old"');
  assert.equal(win.withHome('C:\\A B', 'node x'), '$env:TEAM_AGENT_HOME = "C:\\A B"; node x');
  assert.match(win.service('C:\\A B'), /-File "C:\\A B\\service\\helper-service\.ps1" install/);
  const mac = shellHints('darwin');
  assert.equal(mac.remove('/a b/token'), 'rm "/a b/token"');
  assert.equal(mac.withHome('/a b', 'node x'), 'TEAM_AGENT_HOME="/a b" node x');
  assert.match(mac.git, /xcode-select --install/);
});

test('the commands to send hold no secret, and name only what they were given', () => {
  const { mac, windows } = setupCommands({ coordinator: 'https://coordinator.example', device: 'builder-3', task: 'TASK-7' });
  assert.equal(mac, 'onboarding/setup-mac.sh --coordinator https://coordinator.example --device builder-3 --test-task TASK-7');
  assert.equal(windows, 'powershell -NoProfile -ExecutionPolicy Bypass -File onboarding\\setup-windows.ps1 --coordinator https://coordinator.example --device builder-3 --test-task TASK-7');
});

// --- what the kit may say ---------------------------------------------------------------------------------------------

const kitFiles = ['onboarding/GUIDE.md', 'onboarding/common.js', 'onboarding/operator.js', 'onboarding/setup.js', 'onboarding/setup-mac.sh', 'onboarding/setup-windows.ps1'];

test('no file in the kit names a real tailnet, machine, person or team', () => {
  const allowedSites = new Set(['nodejs.org', 'git-scm.com', 'tailscale.com', 'coordinator.example']);
  for (const file of kitFiles) {
    const text = readFileSync(repo(file), 'utf8');
    assert.doesNotMatch(text, /\.ts\.net|\btail[0-9a-f]{6}\b|mac-mini|macbook/i, file);
    assert.doesNotMatch(text, /[\w.-]+@[\w-]+\.[a-z]/i, `${file} has something like an email address`);
    for (const [, site] of text.matchAll(/https:\/\/([a-z0-9][\w.-]*)/gi)) assert.ok(allowedSites.has(site), `${file} names ${site}`);
    assert.doesNotMatch(text, /github\.com/, `${file} names a repository`);
  }
});

test('the guide is one page, with the parts a newcomer needs', () => {
  const guide = readFileSync(repo('onboarding/GUIDE.md'), 'utf8');
  assert.ok(guide.split('\n').length <= 65, 'one page');
  assert.ok(guide.length <= 3800, 'one page');
  for (const heading of ['What you need', 'What to run', 'What success looks like', 'When something fails', 'Who to ask']) {
    assert.match(guide, new RegExp(`^## ${heading}$`, 'm'));
  }
  assert.match(guide, /setup-mac\.sh/);
  assert.match(guide, /setup-windows\.ps1/);
  assert.match(guide, /SUCCESS/);
  assert.match(guide, /not yet been run on a real Windows machine/);
});

test('output stays plain ASCII, for a Windows console', () => {
  for (const file of ['onboarding/setup.js', 'onboarding/common.js', 'onboarding/operator.js', 'onboarding/setup-mac.sh']) {
    assert.doesNotMatch(readFileSync(repo(file), 'utf8'), /[^\x00-\x7f]/, file);
  }
});

// --- static checks on the Windows script. No PowerShell here, so none of this runs it, and it proves little. ------------

const windows = readFileSync(repo('onboarding/setup-windows.ps1'), 'utf8');
const service = readFileSync(repo('service/helper-service.ps1'), 'utf8');
const mac = readFileSync(repo('onboarding/setup-mac.sh'), 'utf8');
const codeLines = (src) => src.split('\n').filter((l) => !l.trimStart().startsWith('#'));

// The same lexical walk as in windows-helper.test.js: it catches slips, not wrong commands.
function lexicalProblems(src) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') line++;
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '`') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= src.length) return [`string at line ${line} never closes`];
        if (c === '"' && src[j] === '`') { j += 2; continue; }
        if (src[j] === c) {
          if (src[j + 1] === c) { j += 2; continue; }
          break;
        }
        if (src[j] === '\n') line++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if ('([{'.includes(c)) stack.push({ c, line });
    if (c in pairs) {
      const open = stack.pop();
      if (open?.c !== pairs[c]) return [`${c} at line ${line} does not match ${open ? `${open.c} at line ${open.line}` : 'anything'}`];
    }
    i++;
  }
  return stack.map((o) => `${o.c} at line ${o.line} never closes`);
}

test('Windows script: brackets and strings balance, and it is plain ASCII', () => {
  assert.deepEqual(lexicalProblems(windows), []);
  assert.doesNotMatch(windows, /[^\x00-\x7f]/, 'Windows PowerShell 5.1 misreads a UTF-8 script that has no BOM');
  assert.doesNotMatch(codeLines(windows).join('\n'), /\$(home|host|input|args|pid|error|event|matches|profile)\s*=[^=]/i, 'assigns to an automatic variable');
});

test('Windows script: never handles the token, and installs or elevates nothing', () => {
  const code = codeLines(windows).join('\n');
  assert.doesNotMatch(code, /token/i, 'the token belongs to setup.js alone');
  assert.doesNotMatch(code, /Read-Host|Set-Content|Out-File|Add-Content|Get-Clipboard|\s>\s/, 'nothing here reads a secret or writes a file');
  assert.doesNotMatch(code, /Set-ExecutionPolicy|-Verb RunAs|winget|choco|Invoke-WebRequest|Start-BitsTransfer|msiexec/);
});

test('Windows script: hands every argument to setup.js and returns its exit code', () => {
  assert.doesNotMatch(windows, /^param\(/m, 'with a param block, PowerShell would try to bind --coordinator itself');
  assert.match(windows, /& \$found\.Source \$Setup @args\nexit \$LASTEXITCODE/);
  assert.doesNotMatch(codeLines(windows).join('\n'), /Test-Path (?!-LiteralPath)/);
  assert.ok(windows.indexOf("$ErrorActionPreference = 'Continue'") < windows.indexOf('& $found.Source $Setup'), 'Node writing to stderr must not stop PowerShell');
});

test('Windows and Mac scripts: the same checks, in the same words', () => {
  for (const message of ['this needs Node 22.13 or newer', 'is too old', 'Node was not found', 'The repository was not found around this script', 'https://nodejs.org/en/download']) {
    assert.ok(mac.includes(message), `Mac script says: ${message}`);
    assert.ok(windows.includes(message), `Windows script says: ${message}`);
  }
});

test('Windows: the token folder is made private by the service script, which never opens the token', () => {
  const block = service.slice(service.indexOf("'protect' {"), service.indexOf("default {"));
  assert.ok(block.includes('Protect-AgentHome') && block.includes('Show-AccessWarnings'));
  assert.doesNotMatch(block, /Get-Content|\$TokenFile/);
  assert.ok(service.includes('can also be opened by'), 'setup.js looks for this phrase to know the folder is not private');
  assert.ok(readFileSync(repo('onboarding/setup.js'), 'utf8').includes('can also be opened by'));
  assert.ok(service.includes('service not loaded'), 'setup.js looks for this phrase to know nothing is installed');
});
