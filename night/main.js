#!/usr/bin/env node
// The overnight runner. Each command lives in its own module and takes one line in the table below.
//
//   node night/main.js check-approval <TASK-N> (--token-file <path> | --gh) [--create-ledger]
//        would this issue count as approved right now? Reads only: see check-approval.js, and approval.js for its settings
//   node night/main.js night-check
//        prove the session's containment on this machine, for real, through Docker, with no model and no real credential: see check.js
//        First, from the repository's top folder: docker build -t adabra-night:dev night/image
//        NIGHT_IMAGE      the image to check (default adabra-night:dev)
//        NIGHT_IMAGE_ID   when set, the image must be exactly this: docker image inspect <image> --format '{{.Id}}'
//        NIGHT_DOCKER     the docker command (default docker)
//   node night/main.js status
//        what is in force and what happened last. Local, fixed words and counts. Agents may run it
//   node night/main.js report [YYYY-MM-DD]
//        the morning report: local, with no model text. Agents may run it
//   node night/main.js run-once <TASK-N>
//        one supervised run of that task. A terminal and a typed confirmation. Ignores the night window and nothing else. Agents must not
//   node night/main.js serve [--check]
//        the unattended service: see service/night-service.sh. Refuses unless NIGHT_REQUIRED_REVIEW_ON=yes. Agents must not
//
// The last four take their settings from the environment: see settings.js.
import { checkApprovalCommand } from './check-approval.js';
import { nightCheckCommand } from './check.js';
import { reportCommand, runOnceCommand, serveCommand, statusCommand } from './commands.js';

const COMMANDS = {
  'check-approval': checkApprovalCommand,
  'night-check': nightCheckCommand,
  status: statusCommand,
  report: reportCommand,
  'run-once': runOnceCommand,
  serve: serveCommand,
};

const [cmd, ...args] = process.argv.slice(2);
if (!Object.hasOwn(COMMANDS, cmd ?? '')) {
  console.error(`usage: main.js ${Object.keys(COMMANDS).join(' | ')}`);
  process.exit(2);
}
process.exitCode = await COMMANDS[cmd]({ args });
