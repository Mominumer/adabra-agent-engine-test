#!/usr/bin/env node
// A runner that dies for real, by SIGKILL, when it reaches the named step: no finally block runs and nothing is tidied, as in a real crash.
// The test then starts a new runner on what this left on disk. Its settings come from the environment, as the real service's do.
import { NightRunner } from '../../night/runner.js';
import { WRITE_PERMISSIONS } from '../../night/publish.js';
import { READ_PERMISSIONS, appAuth, nightSettings } from '../../night/settings.js';

const [step, number] = process.argv.slice(2);
if (!step) process.exit(0); // `node --test test/` runs this file too

const env = process.env;
const settings = nightSettings(env);
const runner = new NightRunner({
  settings,
  env,
  readAuth: appAuth({ env, settings, permissions: READ_PERMISSIONS }),
  writeAuth: appAuth({ env, settings, permissions: WRITE_PERMISSIONS }),
  timings: { stopPollMs: 10, approvalEveryMs: 1000, leaseEveryMs: 1000, checksWaitMs: 0, checksPollMs: 1 },
  onStep: (name) => {
    if (name === step) process.kill(process.pid, 'SIGKILL');
  },
});
await runner.attempt(Number(number), { once: true });
runner.close();
