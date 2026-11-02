#!/usr/bin/env node
// Teammate's side of onboarding. Checks this machine, enrols it, saves the token, installs the background helper, and runs a
// first claim, checkpoint and release on a test task. Safe to run again. Start it with setup-mac.sh or setup-windows.ps1.
//
// One Node program behind two small scripts, so that what a Windows teammate runs is nearly all the same code the tests run,
// and no shell ever holds the token. The token arrives only on stdin, from the terminal with echo off, or from a file. It is
// written with Node, so as plain ASCII bytes on every platform, and read back only by the helper. It is never an argument.
import { spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ClaimFile, listTasks } from '../helper/claims.js';
import { decodeSecret, readSecretFile, stopSignals } from '../helper/platform.js';
import {
  checkCoordinatorAddress, connectionFailure, DEVICE_ID_RULE, isDeviceId, isTaskId, isThisMachine, MIN_NODE, nodeIsTooOld,
  serviceCommand, shellHints, tailscaleCandidates, tailscaleProblem, TOKEN_RE,
} from './common.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helperCli = join(repoDir, 'helper', 'cli.js');
const hints = shellHints();

// A helper command to show someone, with the folder it needs when that is not the usual one.
function helperCommand(o, args) {
  const command = `node "${helperCli}" ${args}`;
  return o.usualHome ? command : hints.withHome(o.home, command);
}

const lastLines = (r, n) => `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-n).join(' ');

const USAGE = `usage: setup-mac.sh or setup-windows.ps1 --coordinator <address> --device <device-id> --test-task <TASK-N>

Your operator gives you all three:
  --coordinator <address>  the coordinator's address: https://... (http://... only for this machine)
  --device <device-id>     this machine's device ID
  --test-task <TASK-N>     the task for the first test

Options:
  --token-file <file>      read the token from this file, if your operator sent one, instead of asking for it
  --home <folder>          use this new folder instead of the usual one, and leave the usual one and its background
                           helper alone. For trying this out on a machine that is already set up
  --skip-service           do not install the background helper

The token is never given on the command line. You are asked for it, and what you paste stays hidden.`;

// A stop that has already been explained to the person running this.
class Stop extends Error {
  constructor(code = 1) {
    super('stop');
    this.exitCode = code;
  }
}

const say = (line = '') => console.log(line);
const ok = (line) => say(`  ok    ${line}`);
const note = (line) => say(`  note  ${line}`);
function problem(what, fix) {
  console.error(`  FAIL  ${what}`);
  if (fix) console.error(`        Fix: ${fix}`);
}
function refuse(what, ...ways) {
  console.error(`  REFUSED  ${what}`);
  for (const way of ways) console.error(`        ${way}`);
  throw new Stop();
}

function run(file, args, { env = process.env, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((done) => {
    // stdin is closed for everything started from here: a piped token is for this program alone.
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd, timeout: timeoutMs, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => done({ code: null, spawnError: err.code ?? 'failed', stdout, stderr }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

function options() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        coordinator: { type: 'string' },
        device: { type: 'string' },
        'test-task': { type: 'string' },
        home: { type: 'string' },
        'token-file': { type: 'string' },
        'skip-service': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }).values;
  } catch {
    parsed = null; // parseArgs's own message repeats what was typed, which could be a token in the wrong place
  }
  if (parsed?.help) {
    say(USAGE);
    throw new Stop(0);
  }
  if (!parsed || !parsed.coordinator || !parsed.device || !parsed['test-task']) {
    console.error(USAGE);
    throw new Stop(2);
  }
  const address = checkCoordinatorAddress(parsed.coordinator);
  if (address.error) {
    console.error(address.error);
    throw new Stop(2);
  }
  if (!isDeviceId(parsed.device)) {
    console.error(`--device is not a valid device ID. ${DEVICE_ID_RULE}`);
    throw new Stop(2);
  }
  if (!isTaskId(parsed['test-task'])) {
    console.error('--test-task is not a valid task ID. A task ID looks like TASK-7.');
    throw new Stop(2);
  }
  const usualHome = join(homedir(), '.team-agent');
  const home = resolve(parsed.home || process.env.TEAM_AGENT_HOME || usualHome);
  return {
    url: address.url,
    device: parsed.device,
    task: parsed['test-task'],
    home,
    tokenFile: parsed['token-file'],
    skipService: parsed['skip-service'],
    usualHome: home === resolve(usualHome),
  };
}

// --- what this machine needs ------------------------------------------------------------------------------------------

async function findTailscale() {
  for (const file of tailscaleCandidates()) {
    const r = await run(file, ['status', '--json'], { timeoutMs: 10_000 });
    if (r.spawnError !== 'ENOENT') return { found: true, code: r.code, stdout: r.stdout };
  }
  return { found: false };
}

async function reachCoordinator(url) {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(8000) });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.ok === true) return { ok: true };
    return {
      ok: false,
      what: 'Something answered at that address, but it is not the coordinator. Most likely the address is wrong.',
    };
  } catch (err) {
    return { ok: false, what: connectionFailure(err, url) };
  }
}

// Every check runs, so someone with three things to fix hears about all three at once.
async function checkMachine(o) {
  say('Checking this machine');
  let failed = false;
  const fail = (what, fix) => {
    problem(what, fix);
    failed = true;
  };

  if (nodeIsTooOld()) fail(`Node ${process.versions.node} is too old: this needs ${MIN_NODE.join('.')} or newer`, 'Install it from https://nodejs.org/en/download, open a new terminal, and run this again.');
  else ok(`Node ${process.versions.node}`);

  const git = await run('git', ['--version'], { timeoutMs: 15_000 });
  const hasGit = git.code === 0;
  if (hasGit) ok('git');
  else fail('git was not found', hints.git);

  const clone = hasGit ? await run('git', ['-C', repoDir, 'rev-parse', '--is-inside-work-tree'], { timeoutMs: 15_000 }) : null;
  if (clone?.code === 0 && clone.stdout.trim() === 'true') ok('the repository');
  else if (hasGit) fail('This folder is not a clone of the repository', 'Run git clone with the repository address from your operator, then run this script from the new folder.');

  const reach = await reachCoordinator(o.url);

  // Reaching the coordinator is what counts. So a Tailscale problem stops this only if the coordinator cannot be reached: the
  // command can't always read the state (some store builds), and that must not stop someone whose connection works.
  let tailscale = {};
  if (isThisMachine(o.url)) note('Tailscale is not needed for an address on this machine');
  else {
    tailscale = tailscaleProblem(await findTailscale());
    if (!tailscale.problem) ok('Tailscale is connected');
    else if (reach.ok) note(`${tailscale.problem}, but the coordinator answers, so carrying on`);
    else fail(tailscale.problem, tailscale.fix);
  }

  if (reach.ok) ok(`the coordinator answers at ${o.url}`);
  else {
    fail(
      `Could not reach the coordinator at ${o.url}. ${reach.what}`,
      tailscale.problem
        ? 'Sort out Tailscale as above first: the coordinator is only reachable through it.'
        : isThisMachine(o.url)
          ? 'Start the coordinator, or check the address.'
          : 'Check Tailscale is connected to the team\'s tailnet (ask your operator for an invitation if you have not joined it), and that the address is exactly what your operator sent. Then run this again.',
    );
  }
  if (failed) throw new Stop();
}

// --- enrolment and the token ------------------------------------------------------------------------------------------

// What is already in the folder. Anything that does not match what was asked for stays exactly as it is.
function inspectHome(o) {
  const configPath = join(o.home, 'config.json');
  const tokenPath = join(o.home, 'token');
  if (!existsSync(o.home)) return { enrolled: false, hasToken: false };
  if (!statSync(o.home).isDirectory()) refuse(`${o.home} exists and is not a folder. Nothing was changed.`, 'Use --home to choose another place.');

  if (!existsSync(configPath)) {
    if (readdirSync(o.home).length === 0) return { enrolled: false, hasToken: false };
    refuse(
      `${o.home} is not empty and has no enrolment in it. Nothing was changed.`,
      o.usualHome
        ? `If it is left over from an earlier attempt, move it away and run this again: ${hints.moveAway(o.home)}`
        : 'Use --home with a new or empty folder.',
    );
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    refuse(`${configPath} cannot be read as an enrolment. Nothing was changed.`, `Move the folder away and run this again: ${hints.moveAway(o.home)}`);
  }
  if (config.coordinator_url !== o.url || config.device_id !== o.device) {
    const ways = [];
    if (o.usualHome) ways.push('To try this out without touching it: add --home <a new folder>.');
    if (config.device_id === o.device) {
      ways.push(`If only the coordinator's address has changed, keep your token and run: ${helperCommand(o, `enroll ${o.url} ${o.device}`)}`);
    }
    ways.push(
      `To replace it on purpose: check that ${helperCommand(o, 'status')} shows nothing queued or held, then move the folder away and run this again: ${hints.moveAway(o.home)}`,
    );
    refuse(
      `${o.home} is already enrolled as device ${config.device_id} with coordinator ${config.coordinator_url}, and you asked for device ${o.device} with coordinator ${o.url}. Nothing was changed.`,
      ...ways,
    );
  }
  return { enrolled: true, hasToken: existsSync(tokenPath) };
}

function readHidden(prompt) {
  const input = process.stdin;
  return new Promise((done, cancelled) => {
    let value = '';
    const finish = (settle) => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      settle();
    };
    function onData(chunk) {
      // A terminal may wrap a paste in markers; they are not part of what was pasted.
      for (const ch of chunk.replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n' || ch === '\x04') return finish(() => done(value));
        if (ch === '\x03') return finish(() => cancelled(new Stop(130)));
        if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ' && value.length < 4096) value += ch;
      }
      return undefined;
    }
    input.setEncoding('utf8');
    input.setRawMode(true); // no echo, and the terminal keeps no line of it to recall with the up arrow
    input.on('data', onData);
    input.resume();
    process.stderr.write(prompt); // only now: a paste the moment the prompt appears must already be hidden
  });
}

async function readPiped() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > 4096) break;
  }
  return decodeSecret(Buffer.concat(chunks));
}

async function obtainToken(o) {
  let token;
  if (o.tokenFile) {
    try {
      token = readSecretFile(o.tokenFile);
    } catch (err) {
      refuse(`Could not read the token file (${err.code}). Nothing was saved.`, 'Check the path, and run this again.');
    }
  } else if (process.stdin.isTTY) {
    try {
      token = await readHidden('Paste your device token and press Enter. Nothing will show as you paste: ');
    } catch (err) {
      console.error('Cancelled. No token was saved.');
      throw err;
    }
  } else {
    token = await readPiped();
  }
  if (!token) refuse('No token was given. Nothing was saved.', 'Run this again and paste it when asked. In a window with no prompt, use --token-file.');
  if (!TOKEN_RE.test(token)) {
    refuse(
      `That is not a device token: one is 64 characters of 0-9 and a-f, and this was ${token.length}. Nothing was saved.`,
      'Copy it again from what your operator sent, and run this again.',
    );
  }
  return token;
}

// Asks the coordinator whether this device and token are good, before a wrong one gets anywhere near the disk.
async function verifyToken(o, token, { saved }) {
  let r;
  try {
    r = await listTasks({ url: o.url, deviceId: o.device, token, timeoutMs: 8000 });
  } catch (err) {
    problem(`Could not reach the coordinator at ${o.url}. ${connectionFailure(err, o.url)}`, 'Check your connection, and run this again.');
    throw new Stop();
  }
  if (r.ok) return;
  const remove = hints.remove(join(o.home, 'token'));
  if (r.status === 401) {
    if (saved) {
      problem(
        `The coordinator refused the token saved in ${o.home} for device ${o.device}. It may have been replaced, or the device revoked. The file was left as it is.`,
        `Ask your operator for a new token. Then delete the old one and run this again: ${remove}`,
      );
    } else {
      problem(
        `The coordinator refused that token for device ${o.device}. It was not saved.`,
        'Copy it again and run this again. If it is still refused, ask your operator to check the device ID: it may be for another device, or revoked, or added to a different coordinator.',
      );
    }
  } else if (r.status === 403) {
    problem(`Device ${o.device} is not a builder, so it cannot work on tasks.`, 'Ask your operator for a builder device.');
  } else {
    problem(`The coordinator could not check the token (${r.data.error ?? `http ${r.status}`}).`, 'Run this again in a minute. If it keeps happening, ask your operator.');
  }
  throw new Stop();
}

// Only ever a new or empty folder, or one that already holds an enrolment (inspectHome refuses the rest), so this can never
// tighten a folder like a home directory by mistake.
async function protectHome(o) {
  mkdirSync(o.home, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    chmodSync(o.home, 0o700);
    return;
  }
  // On Windows the folder's access list does the job of the mode, and service/helper-service.ps1 owns that logic. It also warns if
  // anyone else can still open the folder or the token, and reads nothing from either.
  const c = serviceCommand('protect', { repoDir });
  const r = await run(c.file, c.args, { env: { ...process.env, TEAM_AGENT_HOME: o.home } });
  if (r.code !== 0 || /can also be opened by/.test(`${r.stdout}${r.stderr}`)) {
    problem(`Could not make ${o.home} private to you. ${lastLines(r, 2)}`.trim(), 'Send this message to your operator. The token has not been saved anywhere it should not be.');
    throw new Stop();
  }
}

function saveToken(path, token) {
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600); // never replaces a file, even if one appeared just now
  } catch (err) {
    refuse(`Could not create ${path} (${err.code}). Nothing was overwritten.`, 'Run this again.');
  }
  let written = false;
  try {
    writeSync(fd, token); // plain ASCII bytes with no BOM or line ending on every platform, unlike PowerShell's own commands
    written = true;
  } finally {
    closeSync(fd);
    if (!written) rmSync(path, { force: true });
  }
}

function tightenExistingToken(path) {
  if (process.platform === 'win32') return; // the folder's access list, checked by protectHome
  if (statSync(path).mode & 0o077) {
    chmodSync(path, 0o600);
    note('the saved token could be read by others: now only you can read it');
  }
}

async function enrol(o) {
  say();
  say('Enrolling');
  const state = inspectHome(o);
  const tokenPath = join(o.home, 'token');

  let token;
  if (state.hasToken) {
    await verifyToken(o, readSecretFile(tokenPath), { saved: true });
    if (o.tokenFile) note('a token is already saved here, so --token-file was not used');
  } else {
    token = await obtainToken(o);
    await verifyToken(o, token, { saved: false });
  }

  await protectHome(o);
  if (state.enrolled) ok(`already enrolled as ${o.device}; your enrolment was kept`);
  else {
    // The real helper command writes the enrolment. Its output is a by-hand way to save the token, which is done here instead.
    const r = await run(process.execPath, [helperCli, 'enroll', o.url, o.device], { env: { ...process.env, TEAM_AGENT_HOME: o.home } });
    if (r.code !== 0) {
      problem(`Could not enrol in ${o.home}.`, 'Check you can write there, and run this again.');
      throw new Stop();
    }
    ok(`enrolled as ${o.device}, in ${o.home}`);
  }

  if (state.hasToken) {
    tightenExistingToken(tokenPath);
    ok('the token already saved here works; it was kept');
  } else {
    saveToken(tokenPath, token);
    ok('the token is saved, and only you can read it');
  }
  await protectHome(o); // on Windows this now also checks the token file itself

  // Now rather than at the end, so these are still said if a later step fails.
  if (o.tokenFile) note(`now delete the file you were sent: ${hints.remove(resolve(o.tokenFile))}`);
  else if (!state.hasToken && process.stdin.isTTY) note('now copy something else, so the token is not left on your clipboard');
}

// --- the background helper --------------------------------------------------------------------------------------------

async function installHelper(o) {
  say();
  say('Background helper');
  // There is one such service per user, and it serves one folder. Installing it for a test folder would replace the real one.
  if (!o.usualHome) {
    note('not installed: this is a separate folder, and the real helper and its service were left alone');
    return;
  }
  if (o.skipService) {
    note(`not installed, as you asked. Install it later with: ${hints.service(repoDir)}`);
    return;
  }
  const status = serviceCommand('status', { repoDir });
  if (!status) {
    note('not installed: there is none for this kind of machine, only for Mac and Windows');
    return;
  }
  const env = { ...process.env, TEAM_AGENT_HOME: o.home };
  const current = await run(status.file, status.args, { env });
  if (current.code !== 0) {
    problem(`Could not check the background helper (${current.spawnError ?? `exit code ${current.code}`}).`, 'Run this again. If it keeps happening, ask your operator.');
    throw new Stop();
  }
  if (!`${current.stdout}${current.stderr}`.includes('service not loaded')) {
    ok('already running; it was left alone');
    return;
  }
  const install = serviceCommand('install', { repoDir });
  const r = await run(install.file, install.args, { env });
  if (r.code !== 0) {
    problem(`The background helper did not install. ${lastLines(r, 3)}`.trim(), 'Run this again: enrolment and token are kept. If it keeps happening, send this message to your operator.');
    throw new Stop();
  }
  ok('installed and running; it starts when you log in');
}

// --- the first test ---------------------------------------------------------------------------------------------------

// A checkpoint goes to a public issue, so these words are fixed, and it runs where git finds no repository: the comment then
// shows no commit from this machine, and the only thing on it about this machine is the device ID.
const TEST_CHECKPOINT = [
  '--status', 'Building',
  '--summary', 'Onboarding test: this device can claim, checkpoint and release.',
  '--verification', 'Automated first-run test.',
  '--next', 'None: the test claim is released straight after this.',
];

const REFUSAL_FIX = 'Ask your operator for another test task, then run this again.';

function explainRefusedClaim(o, r) {
  const reason = /not claimed: (.*)/.exec(r.stderr)?.[1]?.trim();
  if (!reason) {
    problem(
      `Could not reach the coordinator to claim ${o.task}. If the request did get through, the claim ends by itself within a few minutes.`,
      'Check your connection, and run this again.',
    );
  } else if (reason === 'no such task') {
    problem(`${o.task} does not exist on the coordinator. Nothing was claimed, and nothing is held.`, REFUSAL_FIX);
  } else if (reason === 'unauthorized') {
    problem(`The coordinator refused this device's token. Nothing was claimed, and nothing is held.`, 'Ask your operator whether the device was revoked or given a new token.');
  } else {
    problem(`The coordinator refused the claim on ${o.task}: ${reason}. Nothing was claimed, and nothing is held.`, REFUSAL_FIX);
  }
}

// A checkpoint that could not be delivered at once waits out a short backoff, and release will not go ahead while one is queued.
async function releaseTest(o, cli, claims) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 2500 * attempt));
    if (!claims.get(o.task)) return true; // the background helper may have dropped a claim the coordinator had ended
    if ((await cli('release', o.task)).code === 0) return true;
  }
  problem(
    `The test claim on ${o.task} could not be released, so it is still held. It stays that way while the background helper runs, and otherwise ends by itself within a few minutes.`,
    `When the coordinator is back, run: ${helperCommand(o, `release ${o.task}`)}`,
  );
  return false;
}

async function firstTest(o) {
  say();
  say(`First test, on ${o.task}`);
  const claims = new ClaimFile(o.home);
  if (claims.get(o.task)) {
    refuse(
      `This device already holds ${o.task}. It was left alone: it may be real work, or an earlier run that was cut off.`,
      `If it is left over, release it and run this again: ${helperCommand(o, `release ${o.task}`)}`,
    );
  }

  const env = { ...process.env, TEAM_AGENT_HOME: o.home, GIT_DIR: join(o.home, 'not-a-repository') };
  const cli = (...args) => run(process.execPath, [helperCli, ...args], { env, cwd: o.home, timeoutMs: 30_000 });

  // Ctrl+C goes to the helper command too, which ends it. What must not end is the release that follows.
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
  };
  for (const sig of stopSignals()) process.on(sig, onSignal);
  try {
    const claim = await cli('claim', o.task);
    if (claim.code !== 0 && !claims.get(o.task)) {
      explainRefusedClaim(o, claim);
      throw new Stop(interrupted ? 130 : 1);
    }
    ok('claimed');

    let delivered = false;
    if (!interrupted) {
      const checkpoint = await cli('checkpoint', '--task', o.task, ...TEST_CHECKPOINT);
      delivered = checkpoint.stdout.includes('acknowledged by the coordinator');
      if (delivered) ok(`checkpoint delivered; it shows on ${o.task}'s public issue, with this device's ID and nothing else about it`);
      else if (!interrupted) {
        problem(
          `The coordinator did not accept the checkpoint on ${o.task}. It may have stopped answering, or the claim may have been cancelled.`,
          'Run this again. If it keeps happening, ask your operator.',
        );
      }
    }

    const released = await releaseTest(o, cli, claims);
    if (released) ok('released; nothing is left held');
    if (interrupted) {
      console.error('Stopped.');
      throw new Stop(130);
    }
    if (!delivered || !released) throw new Stop();
  } finally {
    for (const sig of stopSignals()) process.removeListener(sig, onSignal);
  }
}

// --- start ------------------------------------------------------------------------------------------------------------

async function main() {
  const o = options();
  say(`Setting up device ${o.device}`);
  if (!o.usualHome) say(`Using a separate folder, ${o.home}. The usual one and its background helper are not touched.`);
  say();

  await checkMachine(o);
  await enrol(o);
  await installHelper(o);
  await firstTest(o);

  say();
  say(`SUCCESS: device ${o.device} is set up. It claimed, checkpointed and released ${o.task}, and nothing is left held.`);
  if (o.usualHome) say(`To see what you can work on: node "${helperCli}" tasks`);
}

main().catch((err) => {
  if (err instanceof Stop) {
    process.exitCode = err.exitCode;
    if (err.exitCode === 1) {
      console.error();
      console.error('NOT SET UP. Fix what is above and run this again: it is safe to repeat, and keeps what is already done.');
    }
    return;
  }
  // No stack or detail from anything else: this is never where a token is, but there is no need to find that out the hard way.
  console.error(`NOT SET UP: this script stopped unexpectedly (${err.code ?? err.name}). Send that to your operator.`);
  process.exitCode = 1;
});
