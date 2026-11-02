#!/usr/bin/env node
// The overnight runner. Each command lives in its own module and takes one line in the table below.
//
//   node night/main.js check-approval <TASK-N> (--token-file <path> | --gh) [--create-ledger]
//        would this issue count as approved right now? Reads only: see check-approval.js, and approval.js for its settings
import { checkApprovalCommand } from './check-approval.js';

const COMMANDS = {
  'check-approval': checkApprovalCommand,
};

const [cmd, ...args] = process.argv.slice(2);
if (!Object.hasOwn(COMMANDS, cmd ?? '')) {
  console.error(`usage: main.js ${Object.keys(COMMANDS).join(' | ')}`);
  process.exit(2);
}
process.exitCode = await COMMANDS[cmd]({ args });
