import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { operatorText, plain } from '../shared/sanitize.js';
import { hasTerminal, typed } from '../shared/terminal.js';
import { CONTEXTS } from './dispatcher.js';

// The operator's way past a wrong or stuck adabra/review. It says `success` on the PR's current head commit and on nothing else:
// statuses belong to a commit, so a new push loses it. It never touches adabra/tests, and it puts nothing the operator typed on
// GitHub: the reason goes to the reviewer's log only.
//
// Agents are forbidden from running this, like merging. The deny rules in .claude/settings.json and the terminal and typed
// confirmation below are speed bumps, not a boundary, for as long as builder sessions run as the same user as the reviewer.
export const OVERRIDE_TEXT = 'operator override';

export const overrideLogPath = (env = process.env, home = homedir) =>
  env.REVIEW_LOG_FILE?.trim() || join(home(), 'Library', 'Logs', 'adabra-reviewer.log');

const USAGE = 'usage: override <pr> --reason "..."';
const whoAmI = () => {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
};

export function parseOverride(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: { reason: { type: 'string' } }, allowPositionals: true });
  } catch {
    return { error: USAGE };
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1 || !/^[1-9]\d{0,8}$/.test(positionals[0])) return { error: USAGE };
  const reason = operatorText(values.reason);
  if (!reason) return { error: `a reason is required. ${USAGE}` };
  return { pr: Number(positionals[0]), reason };
}

// `github` and `store` are the reviewer's own. Returns the exit code.
export async function runOverride({
  pr, reason, github, store, confirm, say = console.log, logFile = overrideLogPath(), by = whoAmI(), now = () => new Date(), dryRun = false,
}) {
  const record = (line) => {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${now().toISOString()} ${dryRun ? '[dry-run] ' : ''}override PR #${pr} ${line}\n`);
  };

  // The PR as it is right now, or the reason not to go on.
  const look = async () => {
    const pull = await github.getPull(pr);
    if (!pull) return { refuse: `there is no pull request #${pr}` };
    if (pull.merged) return { refuse: `PR #${pr} is already merged` };
    if (pull.state !== 'open') return { refuse: `PR #${pr} is closed` };
    const job = store.getJob(pr, pull.sha);
    if (job?.state === 'queued' || job?.state === 'running') {
      return { refuse: `a review of ${pull.sha.slice(0, 12)} is ${job.state}, and its result would replace the override. Wait for it to finish, then run this again` };
    }
    return { pull, known: Boolean(job) };
  };

  const first = await look();
  if (first.refuse) {
    say(`Refused: ${first.refuse}. Nothing posted.`);
    return 1;
  }
  const { pull } = first;
  say(`PR #${pr}: ${plain(pull.title ?? '').slice(0, 120)}`);
  say(`  author ${plain(pull.author ?? 'unknown')}, branch ${plain(pull.branch ?? 'unknown')}`);
  say(`  head commit ${pull.sha}`);
  say(`  reason: ${reason}`);
  say(`This sets ${CONTEXTS.review} to success on that commit only. ${CONTEXTS.tests} is not touched. A new push loses it.`);
  if (!first.known) say('The reviewer has not seen this commit. If it is eligible for review, the next poll queues it and replaces the override.');
  if (!(await confirm(`Type "override ${pr}" to confirm: `, `override ${pr}`))) {
    say('Not confirmed. Nothing posted.');
    return 1;
  }

  // A person takes time to type, and the PR may have moved on: look again, and act only on the commit that was shown.
  const second = await look();
  if (second.refuse) {
    say(`Refused: ${second.refuse}. Nothing posted.`);
    return 1;
  }
  if (second.pull.sha !== pull.sha) {
    say(`Refused: PR #${pr} has a new head commit (${second.pull.sha.slice(0, 12)}) since you were asked. Nothing posted.`);
    return 1;
  }

  // On the record first: an override that cannot be logged does not happen.
  try {
    record(`requested sha=${pull.sha} ${CONTEXTS.review}=success by=${by} reason=${reason}`);
  } catch (err) {
    say(`Refused: could not write to the log ${logFile}: ${err.code ?? err.message}. Nothing posted.`);
    return 1;
  }
  // From here on a log failure only gets a mention: the request is on record, and what happened on GitHub has to be reported.
  const note = (line) => {
    try {
      record(line);
    } catch (err) {
      say(`Could not add to the log ${logFile}: ${err.code ?? err.message}`);
    }
  };
  try {
    await github.setStatus(pull.sha, CONTEXTS.review, 'success', OVERRIDE_TEXT);
  } catch (err) {
    const why = plain(err.message).slice(0, 300);
    note(`FAILED sha=${pull.sha}: ${why}`);
    say(`Could not post the status: ${why}`);
    return 1;
  }
  note(`posted sha=${pull.sha}`);
  say(`${dryRun ? '[dry-run] Would have set' : 'Set'} ${CONTEXTS.review} to success on ${pull.sha.slice(0, 12)}. Logged in ${logFile}`);
  return 0;
}

// The command. Refuses before it reads a token or asks GitHub anything if nobody is at a terminal to confirm.
export async function overrideCommand({ args, store, github, terminal = hasTerminal(), confirm = typed, say = console.log, ...rest }) {
  if (!terminal) {
    say('override needs an interactive terminal: the operator runs it at the mini. Agents must not. Nothing posted.');
    return 2;
  }
  const { pr, reason, error } = parseOverride(args);
  if (error) {
    say(error);
    return 2;
  }
  try {
    return await runOverride({ pr, reason, github: await github(), store, confirm, say, ...rest });
  } catch (err) {
    say(`Failed, nothing posted: ${plain(err.message).slice(0, 300)}`);
    return 1;
  }
}
