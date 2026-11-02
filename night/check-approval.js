import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { StaticToken } from '../shared/github-auth.js';
import { approvalSettings, checkApproval, formatReport, issueOfTask } from './approval.js';
import { ghReader, tokenReader } from './github-read.js';
import { Ledger, UNREADABLE_LEDGER } from './ledger.js';

// The `check-approval` command: would this issue count as approved right now? Reads GitHub and the ledger and changes neither.
// The one local write it can make is an empty ledger, and only if asked. Prints the report and nothing else from GitHub.
//
// Exit codes: 0 approved, 1 not approved, 2 wrong usage.
export const USAGE = 'usage: main.js check-approval <TASK-N> (--token-file <path> | --gh) [--create-ledger]';
const TOKEN_FILE_BAD = 'the token file could not be read, or is empty';

function openLedger(path, create) {
  if (!path) return null;
  try {
    if (create) new Ledger(path, { create: true }).close();
    return new Ledger(path, { readOnly: true });
  } catch {
    return UNREADABLE_LEDGER;
  }
}

function readToken(path) {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export async function checkApprovalCommand({ args, env = process.env, print = console.log, makeGh = ghReader, reader = null, clock = Date.now }) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: { 'token-file': { type: 'string' }, gh: { type: 'boolean' }, 'create-ledger': { type: 'boolean' } },
    });
  } catch {
    print(USAGE);
    return 2;
  }
  const { positionals, values } = parsed;
  const number = positionals.length === 1 ? issueOfTask(positionals[0]) : null;
  const tokenFile = values['token-file'];
  const useGh = Boolean(values.gh);
  if (number === null || Boolean(tokenFile) === useGh) {
    print(USAGE);
    return 2;
  }

  let github = reader;
  if (!github && useGh) github = makeGh();
  if (!github) {
    const token = readToken(tokenFile);
    if (!token) {
      print(TOKEN_FILE_BAD);
      return 2;
    }
    github = tokenReader({ auth: new StaticToken(token) });
  }

  const settings = approvalSettings(env);
  const ledger = openLedger(settings.ledgerPath, Boolean(values['create-ledger']));
  try {
    const report = await checkApproval({ github, settings, number, ledger, clock });
    print(formatReport(report));
    return report.approved ? 0 : 1;
  } finally {
    ledger?.close?.();
  }
}
