#!/usr/bin/env node
// Keeps helper/agent.js running and sends everything it prints to a log file. The Windows scheduled task starts this
// (see service/helper-service.ps1): Task Scheduler has no equivalent of launchd's StandardOutPath or KeepAlive.
//
//   node helper/supervisor.js run [--home <dir>] [--log <file>]
//
// Defaults: --home $TEAM_AGENT_HOME or ~/.team-agent, --log <home>/agent.log.
// Environment: TEAM_AGENT_RESTART_MS (default 10000, the same pause as the LaunchAgent's ThrottleInterval).
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { stopSignals, watchParent } from './platform.js';

function pause(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

// Runs the command, restarts it whenever it ends (whatever the exit code, like KeepAlive), and stops it when the
// signal aborts. The log is opened for appending and handed to the child, so a crash's stack trace lands there too.
export async function supervise({ command = process.execPath, args = [], logPath, restartMs = 10_000, env = process.env, signal }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const log = openSync(logPath, 'a');
  const note = (m) => writeSync(log, `${new Date().toISOString()} supervisor: ${m}\n`);
  note(`started, pid ${process.pid}`);
  let runs = 0;
  while (!signal?.aborted) {
    runs++;
    const child = spawn(command, args, { env, stdio: ['ignore', log, log], windowsHide: true });
    if (child.pid) note(`agent started, pid ${child.pid}`);
    const stop = () => child.kill();
    signal?.addEventListener('abort', stop, { once: true });
    const ended = await new Promise((resolve) => {
      child.once('error', (err) => resolve(`could not start: ${err.code ?? err.message}`));
      child.once('exit', (code, sig) => resolve(sig ? `ended by ${sig}` : `exit code ${code}`));
    });
    signal?.removeEventListener('abort', stop);
    note(`agent ${ended}`);
    if (signal?.aborted) break;
    note(`restarting in ${restartMs / 1000}s`);
    await pause(restartMs, signal);
  }
  note('stopped');
  closeSync(log);
  return { runs };
}

if (process.argv[2] === 'run') {
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { home: { type: 'string' }, log: { type: 'string' } },
  });
  const home = values.home ?? process.env.TEAM_AGENT_HOME ?? join(homedir(), '.team-agent');
  const ac = new AbortController();
  for (const sig of stopSignals()) process.on(sig, () => ac.abort());
  watchParent(() => ac.abort());
  await supervise({
    args: [fileURLToPath(new URL('./agent.js', import.meta.url))],
    logPath: values.log ?? join(home, 'agent.log'),
    restartMs: Number(process.env.TEAM_AGENT_RESTART_MS ?? 10_000),
    env: { ...process.env, TEAM_AGENT_HOME: home, TEAM_AGENT_SUPERVISED: '1' },
    signal: ac.signal,
  });
}
