#!/usr/bin/env node
// Stands in for the docker CLI in the overnight runner's tests. Containers are files in a state folder, so a crash of the runner leaves
// them behind as a real one would, and a later process can find and remove them. A session is the fake claude, then a wait to be killed,
// which is what the image's entry.sh does.
//
// FAKE_RUNNER_STATE is the state folder. Its control.json is read on every call, so a test can change the world between calls:
//   dockerDown       `info` fails, and so does everything else
//   imageId          what `image inspect` says
//   reviewRunning    a review container is running
//   tunnelSilent     the tunnel never says it is listening
//   tunnelFails      the tunnel cannot start
//   tunnelLog        more lines for the tunnel's log
//   sessionDies      the session ends without handing back any work
//   sessionHangs     the CLI never ends, so only a kill stops it
//   exportExit       the export's exit code
//   exportFlood      the export prints this many bytes instead of the diff
//   exportHangs      the export never ends
//   killFails        this many `kill` calls fail and leave things running
// The diff is the file `diff` in the state folder, byte for byte. The session's stdin is saved as `session-input`.
// calls.jsonl gets one line per call: its arguments, and the credential this process was handed.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
if (!argv.length) process.exit(0); // `node --test test/` runs this file too

const STATE = process.env.FAKE_RUNNER_STATE;
if (!existsSync(STATE)) process.exit(1); // the test has finished and gone
const CONTAINERS = join(STATE, 'containers');
const VOLUMES = join(STATE, 'volumes');
mkdirSync(CONTAINERS, { recursive: true });
mkdirSync(VOLUMES, { recursive: true });
const controlFile = join(STATE, 'control.json');
const control = existsSync(controlFile) ? JSON.parse(readFileSync(controlFile, 'utf8')) : {};
appendFileSync(join(STATE, 'calls.jsonl'), `${JSON.stringify({ args: argv, credential: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null })}\n`);

const say = (text) => process.stdout.write(`${text}\n`);
const valueOf = (flag) => argv.filter((_, i) => argv[i - 1] === flag);
const labelsOf = () => valueOf('--label');
const filters = valueOf('--filter');
const nameFile = (name) => join(CONTAINERS, `${name}.json`);
const containers = () => readdirSync(CONTAINERS).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(CONTAINERS, f), 'utf8')));
const matches = (c) => filters.every((f) => {
  if (f.startsWith('label=')) return c.labels.includes(f.slice(6));
  if (f === 'status=running') return true; // a killed container is removed, as --rm does
  return false;
});

// True if this call should pretend to fail, and counts it.
function killShouldFail() {
  const left = control.killFails ?? 0;
  const file = join(STATE, 'kills-failed');
  const done = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  if (done >= left) return false;
  writeFileSync(file, String(done + 1));
  return true;
}

// The image's entry.sh, as far as the runner can tell from outside: the CLI's output, one line on stderr when it ends, then it waits.
async function runSession(name) {
  const input = [];
  for await (const chunk of process.stdin) input.push(chunk);
  writeFileSync(join(STATE, 'session-input'), Buffer.concat(input));
  const stillThere = () => existsSync(nameFile(name));
  const waitToDie = () => new Promise(() => {
    setInterval(() => {
      if (!stillThere()) process.exit(137);
    }, 5);
  });
  if (control.sessionDies) {
    rmSync(nameFile(name), { force: true });
    process.exit(70);
  }
  if (control.sessionHangs) return waitToDie();
  const fakeClaude = join(dirname(fileURLToPath(import.meta.url)), 'fake-claude.js');
  const child = spawn(process.execPath, [fakeClaude, '-p', '--output-format', 'stream-json', '--verbose', 'Do the task.'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const code = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c ?? 1));
  });
  process.stderr.write(`entry: cli exited ${code}\n`);
  return waitToDie();
}

if (control.dockerDown) {
  console.error('Cannot connect to the Docker daemon');
  process.exit(1);
}

switch (argv[0]) {
  case 'info':
    say('29.0.0');
    break;
  case 'image':
    say(control.imageId ?? process.env.FAKE_RUNNER_IMAGE_ID);
    break;
  case 'volume':
    if (argv[1] === 'create') writeFileSync(join(VOLUMES, argv.at(-1)), JSON.stringify({ labels: labelsOf() }));
    if (argv[1] === 'ls') {
      for (const f of readdirSync(VOLUMES)) {
        const { labels } = JSON.parse(readFileSync(join(VOLUMES, f), 'utf8'));
        if (filters.every((x) => labels.includes(x.slice(6)))) say(f);
      }
    }
    if (argv[1] === 'rm') for (const name of argv.slice(2).filter((a) => a !== '-f')) rmSync(join(VOLUMES, name), { force: true });
    break;
  case 'network':
    break;
  case 'ps':
    if (filters.includes('label=adabra-review=1')) {
      if (control.reviewRunning) say('review-container');
      break;
    }
    for (const c of containers().filter(matches)) say(c.name);
    break;
  case 'logs':
    if (!control.tunnelSilent) say('{"event":"listening"}');
    for (const line of control.tunnelLog ?? []) say(JSON.stringify(line));
    break;
  case 'kill':
    if (killShouldFail()) process.exit(1);
    for (const name of argv.slice(1)) rmSync(nameFile(name), { force: true });
    break;
  case 'rm':
    for (const name of argv.slice(1).filter((a) => a !== '-f')) rmSync(nameFile(name), { force: true });
    break;
  case 'run': {
    const name = valueOf('--name')[0];
    if (argv.includes('-d')) {
      if (control.tunnelFails) process.exit(125);
      writeFileSync(nameFile(name), JSON.stringify({ name, labels: labelsOf(), kind: 'tunnel' }));
      say('tunnel-container-id');
      break;
    }
    writeFileSync(nameFile(name), JSON.stringify({ name, labels: labelsOf(), kind: 'session' }));
    await runSession(name);
    break;
  }
  case 'exec': {
    if (control.exportHangs) {
      setInterval(() => {}, 1000);
      break;
    }
    if (control.exportFlood) {
      process.stdout.write('x'.repeat(control.exportFlood), () => process.exit(0));
      break;
    }
    const file = join(STATE, 'diff');
    process.stdout.write(existsSync(file) ? readFileSync(file) : '', () => process.exit(control.exportExit ?? 0));
    break;
  }
  default:
    break;
}
