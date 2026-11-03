import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { Outbox } from '../helper/outbox.js';
import { ClaimFile } from '../helper/claims.js';
import { showNotification } from '../helper/platform.js';
import { EXIT_STOPPED } from '../ops/commands.js';
import { readStop, stopLine } from '../shared/stop.js';
import { hasTerminal, typed } from '../shared/terminal.js';
import { checkApproval, formatReport, issueOfTask } from './approval.js';
import { Ledger } from './ledger.js';
import { WRITE_PERMISSIONS } from './publish.js';
import { RunRecords } from './records.js';
import { COULD_NOT_START, OUTCOMES, nightContents, reportText } from './report.js';
import { NightRunner } from './runner.js';
import { READ_PERMISSIONS, appAuth, nightSettings, startupRefusals } from './settings.js';
import { nightLabel } from './window.js';

const RUN_ONCE_USAGE = 'usage: main.js run-once <TASK-N>';

// One runner at a time, on this machine. A second one's sweep would kill the first one's session. A lock left by a process that has gone,
// or from before the machine restarted, does not count.
function takeLock(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'runner.lock');
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  };
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(path, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    try {
      const pid = Number(readFileSync(path, 'utf8'));
      const fromThisBoot = statSync(path).mtimeMs >= Date.now() - uptime() * 1000;
      if (Number.isSafeInteger(pid) && pid > 0 && fromThisBoot && alive(pid)) return null;
    } catch {
      // Gone between the two calls: take it on the next try.
    }
    rmSync(path, { force: true });
  }
  return null;
}

function openRunner({ env, settings, ...options }) {
  return new NightRunner({
    settings,
    env,
    readAuth: appAuth({ env, settings, permissions: READ_PERMISSIONS }),
    writeAuth: appAuth({ env, settings, permissions: WRITE_PERMISSIONS }),
    notify: (title, message) => showNotification(title, message),
    log: (line) => console.error(`${new Date().toISOString()} ${line}`),
    ...options,
  });
}

// `run-once <TASK-N>`: one run of that task, for a person at the machine. It needs a terminal and a typed confirmation, and ignores the night
// window and nothing else. Agents must not run it: this and the deny rules are speed bumps, like override's, not a boundary.
export async function runOnceCommand({ args, env = process.env, say = console.log, terminal = hasTerminal(), confirm = typed, machineStopFile, ...options }) {
  if (!terminal) {
    say('run-once needs an interactive terminal: the operator runs it at the machine. Agents must not. Nothing started.');
    return 2;
  }
  const number = args.length === 1 ? issueOfTask(args[0]) : null;
  if (number === null) {
    say(RUN_ONCE_USAGE);
    return 2;
  }
  const settings = nightSettings(env);
  const refusals = startupRefusals(settings, { env, machineStopFile });
  if (refusals.length) {
    for (const r of refusals) say(`Refused: ${r}`);
    say('Nothing started.');
    return 2;
  }
  const unlock = takeLock(settings.nightHome);
  if (!unlock) {
    say('Refused: another runner is running on this machine. Nothing started.');
    return 2;
  }
  let runner;
  try {
    runner = openRunner({ env, settings, ...options });
    await runner.sweep();
    const stop = runner.stopNow();
    if (stop.stopped) {
      say(`${stopLine(stop)}. Nothing started.`);
      return EXIT_STOPPED;
    }
    const why = await runner.ready();
    if (why) {
      say(`Refused: ${COULD_NOT_START[why] ?? why}. Nothing started.`);
      return 1;
    }
    if (runner.runsLeftTonight() <= 0) {
      say(`Refused: tonight's limit of ${settings.runsPerNight} run(s) is used up. Nothing started.`);
      return 1;
    }
    const look = await checkApproval({ github: runner.github, settings: settings.approval, number, ledger: runner.ledger, clock: runner.clock });
    say(formatReport(look));
    if (!look.approved) {
      say('Refused: that is not an approved task. Nothing started.');
      return 1;
    }
    say('This runs one unattended model session on that task, uses up this approval however it ends, and may open a pull request.');
    if (!(await confirm(`Type "run TASK-${number}" to confirm: `, `run TASK-${number}`))) {
      say('Not confirmed. Nothing started.');
      return 1;
    }
    const result = await runner.attempt(number, { once: true });
    const { text, path } = runner.writeReport();
    say(text);
    say(`Saved to ${path}`);
    if (!result.started) {
      say('Nothing was spent.');
      return result.why === 'stopped' ? EXIT_STOPPED : 1;
    }
    if (result.outcome === 'stopped') return EXIT_STOPPED;
    return result.outcome === 'published' ? 0 : 1;
  } finally {
    runner?.close();
    unlock();
  }
}

// `serve`: the unattended service. Refuses to run unless the operator has said that main requires their review. `--check` looks at the
// settings and starts nothing, for the service script to ask before it touches a running service.
export async function serveCommand({ args, env = process.env, say = console.log, machineStopFile, signal = null, ...options }) {
  if (args.some((a) => a !== '--check')) {
    say('usage: main.js serve [--check]');
    return 2;
  }
  const settings = nightSettings(env);
  const refusals = startupRefusals(settings, { env, machineStopFile });
  if (!settings.requiredReviewOn) refusals.push('NIGHT_REQUIRED_REVIEW_ON is not yes: nothing runs unattended until main requires your review, and you say so here');
  if (refusals.length) {
    for (const r of refusals) say(`Refused: ${r}`);
    say('Nothing started.');
    return 2;
  }
  if (args.includes('--check')) {
    say('The settings are complete. The night window, the stop and the approval check still apply.');
    return 0;
  }
  const unlock = takeLock(settings.nightHome);
  if (!unlock) {
    say('Refused: another runner is running on this machine. Nothing started.');
    return 2;
  }
  let runner;
  const ended = new AbortController();
  const end = () => {
    ended.abort();
    void runner?.abort();
  };
  signal?.addEventListener('abort', end, { once: true });
  process.once('SIGTERM', end);
  process.once('SIGINT', end);
  try {
    runner = openRunner({ env, settings, ...options });
    await runner.serve({ signal: ended.signal });
    return 0;
  } finally {
    process.removeListener('SIGTERM', end);
    process.removeListener('SIGINT', end);
    runner?.close();
    unlock();
  }
}

// `status`: what is in force and what happened last. Local, reads only, and prints fixed words, IDs and counts. Agents may run it.
export async function statusCommand({ args = [], env = process.env, say = console.log } = {}) {
  if (args.length) {
    say('usage: main.js status');
    return 2;
  }
  const s = nightSettings(env);
  for (const p of s.problems) say(`not set up: ${p}`);
  if (s.stopFile) {
    const stop = readStop({ path: s.stopFile, machineDir: dirname(s.stopFile) });
    say(stop.stopped ? stopLine(stop) : 'stop: not in force');
  }
  say(`required review confirmed by the operator: ${s.requiredReviewOn ? 'yes' : 'no, so serve refuses'}`);
  if (s.approval.ledgerPath && existsSync(s.approval.ledgerPath)) {
    let ledger;
    try {
      ledger = new Ledger(s.approval.ledgerPath, { readOnly: true });
      say(`attempts with no recorded end: ${ledger.unfinished().length}`);
    } catch {
      say('the ledger could not be read');
    } finally {
      ledger?.close();
    }
  } else {
    say('no ledger yet');
  }
  if (s.agentHome && existsSync(join(s.agentHome, 'config.json'))) {
    say(`claims held: ${Object.keys(new ClaimFile(s.agentHome).all()).length}`);
    const outbox = new Outbox(join(s.agentHome, 'outbox.db'));
    say(`checkpoints waiting to send: ${outbox.counts().pending ?? 0}`);
    outbox.close();
  }
  if (s.nightHome && existsSync(s.nightHome)) {
    const runs = new RunRecords(s.nightHome).all().slice(-5);
    if (!runs.length) say('no runs yet');
    for (const r of runs) {
      say(`${new Date(r.startedAt).toISOString()} ${r.task} ${r.runId}: ${OUTCOMES[r.outcome] ?? 'not settled yet'}${r.pull > 0 ? ` (PR #${r.pull})` : ''}`);
    }
    say('the morning report: node night/main.js report');
  }
  return 0;
}

// `report [YYYY-MM-DD]`: the report for that night, or for the current one. Local, reads only, and holds no model text. Agents may run it.
export async function reportCommand({ args = [], env = process.env, say = console.log, clock = Date.now } = {}) {
  if (args.length > 1 || (args.length === 1 && !/^\d{4}-\d{2}-\d{2}$/.test(args[0]))) {
    say('usage: main.js report [YYYY-MM-DD]');
    return 2;
  }
  const s = nightSettings(env);
  if (!s.nightHome) {
    say('NIGHT_HOME is not set, so there are no records to read');
    return 2;
  }
  // Inside the night's window, which puts it unmistakably in that night whatever the clock says now.
  const [y, m, d] = (args[0] ?? '').split('-').map(Number);
  const at = args.length ? new Date(y, m - 1, d, 1, 0, 0, 0).getTime() : clock();
  const records = new RunRecords(s.nightHome);
  const contents = nightContents({ records: records.all(), notes: records.notes(), now: at });
  say(reportText({ label: nightLabel(at), ...contents }).trimEnd());
  return 0;
}
