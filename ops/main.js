#!/usr/bin/env node
// Emergency stop (run at the Mac mini; service/ops.sh is the usual way in). Needs no service and no database.
//
//   node ops/main.js stop [--reason "..."]   stop everything; agents may run this too
//   node ops/main.js resume                  undo it; asks for a typed confirmation at a terminal; agents must not run this
//   node ops/main.js status                  what is in force, and why
//   node ops/main.js check                   one line of JSON. Exit 0 = go; any other exit = do not start anything
//   node ops/main.js health                  the health report, read-only: see ops/health.js. Exit 1 if any line is a FAIL
//   node ops/main.js health --last           what the health job found last, without checking anything again
//   node ops/main.js health --job            the LaunchAgent's run: also rotates logs, writes the status file, and notifies
//
// Environment: ADABRA_STOP_FILE (default ~/.adabra-control/stop.json)
//
// The override for adabra/review is `node reviewer/main.js override`, because it belongs with the reviewer's GitHub client.
import { checkCommand, resumeCommand, statusCommand, stopCommand } from './commands.js';

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  stop: () => stopCommand({ args }),
  resume: () => resumeCommand(),
  status: () => statusCommand(),
  check: () => checkCommand(),
  // Loaded only when asked for: nothing in the health code can ever get in the way of stopping.
  health: async () => (await import('./health.js')).healthCommand({ args }),
};

if (!Object.hasOwn(commands, cmd ?? '')) {
  console.error('usage: main.js stop [--reason "..."] | resume | status | check | health [--last | --job]');
  process.exit(2);
}
process.exit(await commands[cmd]());
