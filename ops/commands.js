import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { readStop, recordResume, recordStop, stopBrief, stopFilePath, stopLine } from '../shared/stop.js';
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

export function stopCommand({ args = [], path = stopFilePath(), terminal = hasTerminal(), say = console.log, at = new Date() } = {}) {
  let r;
  try {
    r = recordStop({ reason: reasonFrom(args), by: whoAmI(), from: terminal ? 'terminal' : 'no terminal', at, path });
  } catch (err) {
    const why = err.code ?? err.message;
    if (readStop({ path }).stopped) {
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
  path = stopFilePath(), terminal = hasTerminal(), confirm = typed, coordinatorUp = coordinatorAnswers, say = console.log, at = new Date(),
} = {}) {
  if (!terminal) {
    say('resume needs an interactive terminal: the operator runs it at the mini. Agents must not. Nothing changed.');
    return 2;
  }
  const s = readStop({ path });
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
    recordResume({ at, path });
  } catch (err) {
    say(`RESUME FAILED, still stopped: could not write ${path}: ${err.code ?? err.message}`);
    return 1;
  }
  say('Resumed. Helpers renew and deliver on their next pass; the reviewer picks up its queue within seconds.');
  return 0;
}

export function statusCommand({ path = stopFilePath(), say = console.log } = {}) {
  const s = readStop({ path });
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
export function checkCommand({ path = stopFilePath(), say = console.log } = {}) {
  const s = readStop({ path });
  say(JSON.stringify(s.unreadable ? { ...stopBrief(s), unreadable: s.unreadable } : stopBrief(s)));
  return s.stopped ? EXIT_STOPPED : 0;
}
