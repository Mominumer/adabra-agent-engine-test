import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { MACHINE_DIR, perUserStopFile, readStop, recordResume, recordStop, stopBrief, stopFilePath, stopLine, writeState } from '../shared/stop.js';
import { hasTerminal, typed } from '../shared/terminal.js';

export const EXIT_STOPPED = 3;

const whoAmI = () => {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
};

// Stopping is the safe direction: no terminal needed, no confirmation, and it never refuses over how it was asked.
function reasonFrom(args) {
  try {
    const { values, positionals } = parseArgs({ args, options: { reason: { type: 'string' } }, allowPositionals: true });
    return values.reason ?? positionals.join(' ');
  } catch {
    return args.join(' ');
  }
}

export function stopCommand({ args = [], machineDir = MACHINE_DIR, path = stopFilePath(undefined, undefined, machineDir), terminal = hasTerminal(), say = console.log, at = new Date() } = {}) {
  let r;
  try {
    r = recordStop({ reason: reasonFrom(args), by: whoAmI(), from: terminal ? 'terminal' : 'no terminal', at, path, machineDir });
  } catch (err) {
    const why = err.code ?? err.message;
    if (readStop({ path, machineDir }).stopped) {
      say(`Could not write ${path} (${why}), but what is there already counts as stopped. Everything is stopped.`);
      return 0;
    }
    say(`STOP DID NOT TAKE EFFECT: could not write ${path}: ${why}`);
    say('Stop the services by hand: launchctl bootout gui/$(id -u)/ai.adabra.reviewer, then the same for ai.adabra.coordinator');
    return 1;
  }
  if (r.already) {
    say(`Already stopped; nothing changed. ${stopLine(r.state)}`);
  } else {
    say(stopLine(r.state));
    say('  Coordinator: refuses claims, renewals, checkpoints and review results now, and keeps every held lease alive.');
    say('  Reviewer: starts nothing, ends a running job within seconds and puts it back in the queue. Posts nothing about it.');
    say('  Helpers: tell their owners on their next pass. Claims stay theirs; checkpoints wait in the outbox.');
  }
  say('This stays in force, across restarts and reboots, until: service/ops.sh resume');
  return 0;
}

async function coordinatorAnswers(env = process.env) {
  try {
    const res = await fetch(`http://127.0.0.1:${env.COORDINATOR_PORT ?? 8787}/healthz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// The dangerous direction: only a person at a terminal, who has typed the word.
export async function resumeCommand({
  machineDir = MACHINE_DIR, path = stopFilePath(undefined, undefined, machineDir), terminal = hasTerminal(), confirm = typed, coordinatorUp = coordinatorAnswers, say = console.log,
} = {}) {
  if (!terminal) {
    say('resume needs an interactive terminal: the operator runs it at the mini. Agents must not. Nothing changed.');
    return 2;
  }
  const s = readStop({ path, machineDir });
  if (!s.stopped) {
    say('Not stopped; nothing to resume.');
    return 0;
  }
  say(stopLine(s));
  if (s.unreadable) say(`  The state file could not be read (${s.unreadable}). Resuming replaces it.`);
  if (!(await coordinatorUp())) {
    say('  WARNING: the coordinator is not answering. A lease that ran out while it was down is not restored once this is');
    say('  lifted, and another device could then claim that task. Start the coordinator first if anyone held a claim.');
  }
  if (!(await confirm('Type "resume" to start everything again: ', 'resume'))) {
    say('Not confirmed. Still stopped.');
    return 1;
  }
  try {
    recordResume({ at: new Date(), path, machineDir }); // now, and not when the prompt appeared: someone may take minutes to type
  } catch (err) {
    say(`RESUME FAILED, still stopped: could not write ${path}: ${err.code ?? err.message}`);
    return 1;
  }
  say('Resumed. Helpers renew and deliver on their next pass; the reviewer picks up its queue within seconds.');
  return 0;
}

export function statusCommand({ machineDir = MACHINE_DIR, path = stopFilePath(undefined, undefined, machineDir), say = console.log } = {}) {
  const s = readStop({ path, machineDir });
  if (s.stopped) {
    say(stopLine(s));
    if (s.unreadable) say(`  The state file could not be read: ${s.unreadable}`);
    else say(`  Set by ${s.by || 'unknown'} (${s.from || 'unknown'})`);
    say('  Undo with: service/ops.sh resume');
  } else {
    say('Running: no stop in force.');
    if (s.last_stop) say(`  Last stop: ${s.last_stop.since} to ${s.last_stop.resumed_at}: ${s.last_stop.reason}`);
  }
  say(`  State file: ${path}`);
  return 0;
}

// For the overnight runner and a health check: exit 0 = go; any other exit = do not start.
export function checkCommand({ machineDir = MACHINE_DIR, path = stopFilePath(undefined, undefined, machineDir), say = console.log } = {}) {
  const s = readStop({ path, machineDir });
  say(JSON.stringify(s.unreadable ? { ...stopBrief(s), unreadable: s.unreadable } : stopBrief(s)));
  return s.stopped ? EXIT_STOPPED : 0;
}

const realSudo = (args) => spawnSync('sudo', args, { stdio: 'inherit' }).status === 0;

// Older installs wrote this into the health job's plist. It wins over everything, so that job would go on reading the old file.
function healthJobNamesStopFile(home) {
  try {
    return readFileSync(join(home(), 'Library', 'LaunchAgents', 'ai.adabra.health.plist'), 'utf8').includes('ADABRA_STOP_FILE');
  } catch {
    return false;
  }
}

// Moves the stop from this user's file to the machine folder, once. For a person at the mini: the README gives the order. Two things
// must not happen:
//
//   A false stop. A service that finds the folder with no file in it counts as stopped. So the folder and its file are built under a
//   temporary name and one rename makes both appear together: until then a service finds no folder and reads the old file, and from
//   then on it finds the new one.
//
//   A lost stop. Once the folder exists nothing reads the old file. So this refuses to start while a stop is in force there. A stop can
//   still arrive while this runs, so after the rename it looks again and carries over anything it finds. It waits first: a stop command
//   that chose the old file just before the rename has that long to finish writing. Any stop after the rename goes to the new file.
export async function switchStopCommand({
  env = process.env, home = homedir, machineDir = MACHINE_DIR, terminal = hasTerminal(), confirm = typed, sudo = realSudo, user = whoAmI(), say = console.log, settleMs = 1000,
} = {}) {
  if (!terminal) {
    say('switch-stop needs an interactive terminal: the operator runs it at the mini. Agents must not. Nothing changed.');
    return 2;
  }
  if (env.ADABRA_STOP_FILE?.trim()) {
    say('ADABRA_STOP_FILE is set here, and it wins over the machine folder. Unset it, here and for any service that has it, then run this again. Nothing changed.');
    return 1;
  }
  const newFile = join(machineDir, 'stop.json');
  if (existsSync(machineDir)) {
    say(`Already switched: ${machineDir} exists. Nothing changed.`);
    return statusCommand({ path: newFile, machineDir, say });
  }
  if (healthJobNamesStopFile(home)) {
    say('The health job still names a stop file in its settings. Run service/health-service.sh install first. Nothing changed.');
    return 1;
  }
  const oldFile = perUserStopFile(home);
  const before = readStop({ path: oldFile, machineDir });
  if (before.stopped) {
    say(stopLine(before));
    say('A stop is in force, and the switch would leave it behind. Run this once it has been resumed. Nothing changed.');
    return 1;
  }
  say('The coordinator and the reviewer must already be running this code, or they will go on reading the old file and miss a stop.');
  say('Restart them after pulling, if that has not been done: see the README.');
  if (!(await confirm('Type "switch" to move the stop to the machine folder: ', 'switch'))) {
    say('Not confirmed. Nothing changed.');
    return 1;
  }

  const temp = `${machineDir}.new`;
  try {
    if (!sudo(['install', '-d', '-o', user, '-g', 'wheel', '-m', '755', temp])) throw new Error(`could not create ${temp}`);
    writeState(join(temp, 'stop.json'), { stopped: false, last_stop: before.last_stop ?? null });
    if (!sudo(['mv', temp, machineDir])) throw new Error(`could not move ${temp} into place`);
  } catch (err) {
    say(`SWITCH FAILED: ${err.code ?? err.message}. Services still read ${oldFile}, and any stop there still holds. Run this again to retry.`);
    return 1;
  }

  await sleep(settleMs);
  const late = readStop({ path: oldFile, machineDir });
  if (late.stopped) {
    try {
      recordStop({ reason: late.reason, by: late.by ?? '', from: late.from ?? '', at: late.since ? new Date(late.since) : new Date(), path: newFile, machineDir });
    } catch (err) {
      say(`A STOP ARRIVED DURING THE SWITCH AND WAS NOT CARRIED OVER (${err.code ?? err.message}). Nothing is stopped now. Run service/ops.sh stop.`);
      return 1;
    }
    say('A stop arrived during the switch, and it has been carried over.');
  }
  say(`Switched. Every service running this code now reads ${newFile}, with no restart. Nothing reads ${oldFile} any more.`);
  return statusCommand({ path: newFile, machineDir, say });
}
