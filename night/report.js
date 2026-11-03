import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RULES, PROTECTED_WORDS, pathRefusal } from './validate.js';
import { FAILURE_WORDS } from './session-output.js';
import { REVIEW_DECISIONS } from './publish.js';
import { nextNightStart, nightStart } from './window.js';

// The morning report: local only, for the operator and for any agent they ask to read it. It holds no model text, so reading it exposes
// nobody to any. The session's numbers are in it, but they are numbers, and it says whose they are. Each value is checked again as it is
// written, so what ends up here is a fixed word, a number, an ID or a hash, whatever the record says.
export const OUTCOMES = Object.freeze({
  published: 'PR opened',
  no_changes: 'No PR: the session changed nothing',
  diff_refused: 'No PR: the diff was refused',
  stopped: 'No PR: stopped by the operator',
  deadline: 'No PR: time limit reached',
  window_end: 'No PR: the night window ended',
  approval_withdrawn: 'No PR: approval withdrawn during the run',
  claim_lost: 'No PR: the claim was lost during the run',
  coordinator_unreachable: 'No PR: the coordinator could not be reached before the lease ran out',
  session_failed: 'No PR: the session ended without handing back any work',
  session_reported_failure: 'No PR: the session reported that it did not finish',
  github_unreachable: 'Not published: GitHub could not be reached in time',
  pushed_no_pr: 'Branch pushed, but the PR could not be opened',
  aborted: 'No PR: the runner was told to stop during this run',
  crashed: 'The runner crashed during this run',
  interrupted: 'Interrupted: the machine restarted during this run',
  internal_error: 'No PR: the runner hit an error of its own',
});

export const COULD_NOT_START = Object.freeze({
  stopped: 'the emergency stop was in force',
  aborted: 'the runner was told to stop',
  docker_down: 'Docker did not answer',
  image_wrong: 'the image is not the one in NIGHT_IMAGE_ID',
  review_running: 'a review container was running',
  coordinator_down: 'the coordinator did not answer',
  credential_missing: 'the model credential could not be read',
  github_down: 'GitHub could not be read',
  unsettled: 'an earlier run has not been settled',
  review_not_required: 'the last published PR did not show a required review, so unattended runs are held',
  internal_error: 'the runner hit an error of its own',
});

const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TASK_RE = /^TASK-[1-9]\d{0,8}$/;
const RUN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BRANCH_RE = /^night\/TASK-[1-9]\d{0,8}-[A-Za-z0-9_-]{1,64}$/;
const CHECK_WORDS = new Set(['success', 'failure', 'error', 'pending', 'none', 'unknown']);
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isTime = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^[0-9TZ:.-]+$/.test(v);

const word = (value, allowed, fallback = 'unknown') => (allowed.includes?.(value) || allowed.has?.(value) ? value : fallback);
const count = (n) => (isCount(n) ? n : 0);

function refusedLine(r) {
  const session = r.session ?? {};
  const tunnel = r.tunnel ?? {};
  return `  ${TASK_RE.test(r.task) ? r.task : 'unknown task'} ${RUN_RE.test(r.runId) ? r.runId : 'unknown run'}: `
    + `tool calls refused ${count(session.denials)} (the session's own figure), connections refused by the tunnel ${count(tunnel.refused)}`;
}

function runLines(r) {
  const lines = [`${TASK_RE.test(r.task) ? r.task : 'unknown task'}  ${RUN_RE.test(r.runId) ? r.runId : 'unknown run'}`];
  const add = (name, text) => lines.push(`  ${name.padEnd(12)} ${text}`);
  add('outcome', OUTCOMES[r.outcome] ?? 'Not settled yet');
  if (isCount(r.pull) && r.pull > 0 && typeof r.url === 'string' && r.url.endsWith(`/pull/${r.pull}`) && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/.test(r.url)) add('pull request', r.url);
  if (BRANCH_RE.test(r.branch ?? '')) add('branch', r.branch);
  if (r.rule) {
    const place = isCount(r.ruleFile) && r.ruleFile > 0 ? `, file ${r.ruleFile} in the saved diff` : '';
    const name = r.ruleWord && PROTECTED_WORDS.includes(r.ruleWord) ? ` (${r.ruleWord})` : '';
    add('rule', `${word(r.rule, RULES)}${name}${place}`);
  }
  if (r.failureWord) add('session said', word(r.failureWord, FAILURE_WORDS));
  add('approval', `event ${count(r.eventId)}, approver ${count(r.actorId)}, labeled ${isTime(r.labeledAt) ? r.labeledAt : 'unknown'}`);
  add('issue text', `sha256 ${SHA256_RE.test(r.textSha256) ? r.textSha256 : 'unknown'}`);
  add('base commit', SHA_RE.test(r.baseCommit) ? r.baseCommit : 'unknown');
  if (isCount(r.pull) && r.pull > 0) {
    add('checks', `adabra/tests ${word(r.checks?.tests, CHECK_WORDS)}, adabra/review ${word(r.checks?.review, CHECK_WORDS)}`);
    const decision = word(r.reviewDecision, REVIEW_DECISIONS);
    add('review rule', decision === 'REVIEW_REQUIRED' ? 'reviewDecision REVIEW_REQUIRED: the merge waits for your approval' : `reviewDecision ${decision}: GitHub did NOT say a review is required`);
  }
  if (isCount(r.startedAt) && isCount(r.finishedAt)) add('time', `${Math.round((r.finishedAt - r.startedAt) / 60_000)} minute(s)`);
  const session = r.session ?? {};
  if (r.session) add('by its count', `turns ${count(session.turns)}, estimated cost $${(Number.isFinite(session.costUsd) ? session.costUsd : 0).toFixed(2)}. The session's own figures: nothing is decided on them`);
  const flagged = r.flagged ?? { existing: [], newFiles: 0 };
  const shown = (flagged.existing ?? []).filter((p) => typeof p === 'string' && pathRefusal(p) === null);
  if (shown.length || count(flagged.newFiles)) {
    lines.push('  read these yourself');
    for (const p of shown) lines.push(`    ${p}`);
    if (count(flagged.newFiles)) lines.push(`    and ${count(flagged.newFiles)} new file(s) on that list, not named here because the session chose their names`);
  }
  if (r.savedDiff === true) lines.push('  A copy of the diff is in this runner\'s private folder. It is hostile text: do not paste it anywhere, or hand it to an agent.');
  if (r.pushed && !(r.pull > 0)) lines.push('  A branch may remain on GitHub with no PR. Nothing tidies it automatically.');
  if (r.stopNotConfirmed) lines.push('  STOP NOT CONFIRMED at the time: Docker did not confirm the kill straight away. Check `docker ps`.');
  if (r.pull > 0) {
    lines.push('  next         read the diff yourself. Only you can merge it.');
    if (TASK_RE.test(r.task)) lines.push(`               if a failed review returned the task to this runner: node coordinator/main.js task-assign ${r.task} <device|none>`);
  } else if (r.outcome) {
    lines.push('  next         one attempt per approval is used up. To try again, remove the label and add it again.');
  }
  return lines;
}

export function reportText({ label, records, notes = [] }) {
  const lines = [`Overnight runner report, night of ${/^\d{4}-\d{2}-\d{2}$/.test(label) ? label : 'unknown'}`, ''];
  lines.push('REFUSED CALLS AND CONNECTIONS (read these first)');
  if (records.length) lines.push(...records.map(refusedLine));
  else lines.push('  no runs');
  lines.push(
    'A high number here is the best sign of an injection this report has. A low one means little. A session prints its own output, so it',
    'can report any number of refused calls or none, and a careful one makes no connection the tunnel would refuse. A clean report proves',
    'nothing about a run: only reading the diff does.',
    '',
  );
  if (records.length) lines.push('RUNS');
  for (const r of records) lines.push(...runLines(r), '');
  const seen = [...new Set(notes.map((n) => n.why))].filter((w) => Object.hasOwn(COULD_NOT_START, w));
  if (seen.length) {
    lines.push('COULD NOT START');
    for (const w of seen) lines.push(`  ${COULD_NOT_START[w]}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// What belongs to the night this moment falls in.
export function nightContents({ records, notes, now }) {
  const from = nightStart(now);
  const to = nextNightStart(now);
  const inNight = (t) => t >= from && t < to;
  return { records: records.filter((r) => inNight(r.startedAt)), notes: notes.filter((n) => inNight(n.at)) };
}

export const reportPath = (dir, label) => join(dir, `${label}.txt`);

export function writeReport({ dir, label, text }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = reportPath(dir, label);
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}
