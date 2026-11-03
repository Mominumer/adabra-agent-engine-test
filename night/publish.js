import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { READ_YOURSELF } from '../reviewer/precheck.js';
import { sendAuthorized } from '../shared/github-auth.js';
import { runCommand } from './containers.js';
import { tokenReader } from './github-read.js';
import { agreeWithBase, agreeWithGit, agreeWithTree, pathRefusal } from './validate.js';

// Turns a validated diff into one branch and one pull request. The session's work reaches a commit in one way: as a patch applied to the
// pinned commit's tree, in a fresh temp repository with no working tree at all. So the patch cannot write a file, wherever its paths
// point, and nothing the session's own .git held (hooks, config, odd objects, forged authors) is ever seen by this machine.
//
// What goes public: the tree that patch produced, and otherwise only fixed text and values this file has checked. No model text is in the
// commit, the branch name or the pull request. A path is text the session chose, so a path is only named if it already existed at the
// pinned commit. A new file is counted and not named.
export const WRITE_PERMISSIONS = Object.freeze({ contents: 'write', pull_requests: 'write' });
export const GIT_IDENTITY = Object.freeze({ name: 'adabra-night', email: 'adabra-night@users.noreply.github.com' });
export const REVIEW_DECISIONS = Object.freeze(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED', 'none', 'unknown']);

const API_VERSION = '2022-11-28';
const GIT_MS = 120_000;
const NETWORK_GIT_MS = 180_000;
const HTTP_MS = 15_000;
const READ_YOURSELF_SHOWN = 50;
const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const TASK_RE = /^TASK-[1-9]\d{0,8}$/;
const RUN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const COUNT_RE = /^\d{1,9}$/;

// Stops a publish from going further for now. The final gates couldn't tell: the runner may try again while it holds the claim.
export class PublishHold extends Error {}

export const commitMessage = (task) => `${task}: overnight run`;
export const pullTitle = commitMessage;
export const branchName = (task, runId) => `night/${task}-${runId}`;

const isReadYourself = (path) => READ_YOURSELF.some((re) => re.test(path));

// Which of the changed paths the reviewer flags for a person. By now git has applied the patch to the pinned commit and agreed with the
// parser, so a modified or deleted path is one that was already at that commit: nothing the session wrote. A new file's name is its own.
export function readYourself(files) {
  const flagged = files.filter((f) => isReadYourself(f.path));
  return Object.freeze({
    existing: Object.freeze(flagged.filter((f) => f.status !== 'added').map((f) => f.path)),
    newFiles: flagged.filter((f) => f.status === 'added').length,
  });
}

// The whole description of the pull request. Every value is checked again here, so a mistake elsewhere throws instead of posting.
export function pullBody({ task, runId, textSha256, baseCommit, totals, flagged }) {
  const counts = [totals.files, totals.added, totals.modified, totals.deleted, totals.addedLines, totals.removedLines];
  const good = TASK_RE.test(task) && RUN_RE.test(runId) && SHA256_RE.test(textSha256) && SHA_RE.test(baseCommit)
    && counts.every((n) => COUNT_RE.test(String(n))) && COUNT_RE.test(String(flagged.newFiles)) && flagged.existing.every((p) => pathRefusal(p) === null);
  if (!good) throw new Error('a value for the pull request failed its check');

  const shown = flagged.existing.slice(0, READ_YOURSELF_SHOWN);
  const more = flagged.existing.length - shown.length;
  const list = [];
  if (flagged.existing.length || flagged.newFiles) {
    list.push('**Read these yourself.** These paths change how this system runs or how its work is checked:', '');
    if (shown.length) list.push('```', ...shown, ...(more ? [`and ${more} more`] : []), '```', '');
    if (flagged.newFiles) list.push(`Also ${flagged.newFiles} new file(s) in such paths. Their names were chosen by the session, so they are not repeated here: see the Files tab.`, '');
  } else {
    list.push('No changed path is on the reviewer\'s read-it-yourself list. That says nothing about whether the change is safe.', '');
  }
  return [
    `Task: ${task}`,
    '',
    '**Written by a model, unattended. Treat all of it as untrusted.** Nobody watched this run, and it may have read something written to mislead it.',
    '',
    'Green checks do not make this safe. An automated review can pass after reading only part of a large change, and a change can edit its own tests. Read the whole diff, including any file GitHub collapses, before you approve it.',
    '',
    `- Run: \`${runId}\``,
    `- Approved issue text, SHA-256: \`${textSha256}\``,
    `- Base commit: \`${baseCommit}\``,
    `- Files: ${totals.files} (${totals.added} added, ${totals.modified} changed, ${totals.deleted} deleted). Lines: +${totals.addedLines} -${totals.removedLines}`,
    '',
    ...list,
    'This description is fixed text and values the runner checked. Nothing in it was written by the model.',
  ].join('\n');
}

// Git, from nothing: no config, no hooks, no prompt and no variable from this process's environment, so nothing outside this one folder
// changes what it does. The token is in the environment and not in an argument. It is sent only to the host being fetched from.
export function gitEnvironment({ dir, gitUrl, token = null, path = process.env.PATH }) {
  const url = new URL(gitUrl);
  const env = {
    PATH: path ?? '/usr/bin:/bin',
    HOME: dir,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: url.protocol.slice(0, -1),
    GIT_DIR: join(dir, 'repo.git'),
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: GIT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: GIT_IDENTITY.email,
    GIT_COMMITTER_NAME: GIT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: GIT_IDENTITY.email,
  };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = `http.${url.origin}/.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

const HARDENED = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null', '-c', 'core.excludesFile=/dev/null', '-c', 'gc.auto=0', '-c', 'commit.gpgsign=false', '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=60'];

export function gitRunner({ gitCommand, env }) {
  return (args, { input = null, timeoutMs = GIT_MS, extraEnv = {} } = {}) => runCommand(gitCommand, [...HARDENED, ...args], { env: { ...env, ...extraEnv }, input, timeoutMs });
}

// Applies the patch and makes the commit, with no working tree. Resolves { commit, flagged } or { refused: { rule, file, word } } or
// { unreachable: true }. The date is the run's own, so a second try makes the same commit and its push changes nothing.
export async function prepareCommit({ diff, validated, baseCommit, task, gitUrl, git, dateMs }) {
  const made = await git(['init', '-q', '--bare', '--template=']);
  if (made.code !== 0) return { unreachable: true };
  const fetched = await git(['fetch', '-q', '--no-tags', '--no-recurse-submodules', '--depth=1', gitUrl, baseCommit], { timeoutMs: NETWORK_GIT_MS });
  if (fetched.code !== 0) return { unreachable: true };
  const have = await git(['rev-parse', '--verify', `${baseCommit}^{commit}`]);
  if (have.code !== 0 || have.stdout.trim() !== baseCommit) return { unreachable: true };
  if ((await git(['read-tree', baseCommit])).code !== 0) return { unreachable: true };

  const before = await agreeWithGit({ diff, validated, git });
  if (!before.ok) return { refused: before };

  const listed = await git(['ls-tree', '-r', '-z', '--name-only', baseCommit]);
  if (listed.code !== 0) return { refused: { rule: 'git_disagrees', file: null, word: null } };
  const spelt = agreeWithBase({ validated, listed: listed.stdout });
  if (!spelt.ok) return { refused: spelt };

  const applied = await git(['apply', '--cached', '--whitespace=nowarn'], { input: diff });
  if (applied.code !== 0) return { refused: { rule: 'does_not_apply', file: null, word: null } };
  const tree = await git(['write-tree']);
  if (tree.code !== 0) return { refused: { rule: 'does_not_apply', file: null, word: null } };
  const treeId = tree.stdout.trim();

  const raw = await git(['diff-tree', '-r', '-z', '--raw', '--abbrev=40', '--no-renames', baseCommit, treeId]);
  const regenerated = await git(['diff-tree', '-r', '-p', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', baseCommit, treeId]);
  if (raw.code !== 0 || regenerated.code !== 0) return { refused: { rule: 'git_disagrees', file: null, word: null } };
  const after = agreeWithTree({ validated, raw: raw.stdout, regenerated: regenerated.stdout });
  if (!after.ok) return { refused: after };

  const stamp = `${Math.floor(dateMs / 1000)} +0000`;
  const commit = await git(['commit-tree', treeId, '-p', baseCommit, '-m', commitMessage(task)], { extraEnv: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } });
  if (commit.code !== 0 || !SHA_RE.test(commit.stdout.trim())) return { refused: { rule: 'git_disagrees', file: null, word: null } };
  return { commit: commit.stdout.trim(), flagged: readYourself(validated.files) };
}

const apiHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': API_VERSION,
  'content-type': 'application/json',
  'user-agent': 'adabra-night',
});

// Resolves { number } or { failed: true }. The address to show is built from the number, never taken from the reply.
async function openPull({ apiUrl, auth, repo, branch, title, body, commit }) {
  let res;
  let text;
  try {
    res = await sendAuthorized(auth, (token) => fetch(`${apiUrl}/repos/${repo}/pulls`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_MS),
      headers: apiHeaders(token),
      body: JSON.stringify({ title, head: branch, base: 'main', body, draft: false }),
    }));
    text = await res.text();
  } catch {
    return { failed: true };
  }
  if (res.status !== 201) return { failed: true };
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    return { failed: true };
  }
  if (!Number.isSafeInteger(reply?.number) || reply.number <= 0 || reply.head?.sha !== commit) return { failed: true };
  return { number: reply.number };
}

const DECISION_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewDecision}}}';

// Whether GitHub says this pull request is waiting for a required review. Unattended running depends on the answer, so it is recorded
// whichever way it goes.
export async function readReviewDecision({ apiUrl, auth, repo, number }) {
  try {
    const [owner, name] = repo.split('/');
    const reply = await tokenReader({ auth, apiUrl }).graphql(DECISION_QUERY, { owner, name, number });
    if (reply.status !== 200) return 'unknown';
    const parsed = JSON.parse(reply.text);
    if (parsed.errors?.length) return 'unknown';
    const value = parsed.data?.repository?.pullRequest?.reviewDecision;
    if (value === null) return 'none';
    return REVIEW_DECISIONS.includes(value) ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Ends the token now, instead of when it would expire. If this fails it still expires by itself within the hour.
async function revokeToken({ apiUrl, auth }) {
  let token;
  try {
    token = await auth.token();
    const res = await fetch(`${apiUrl}/installation/token`, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(HTTP_MS), headers: apiHeaders(token) });
    return res.status === 204;
  } catch {
    return false;
  } finally {
    if (token) auth.invalidate?.(token);
  }
}

// The whole publish. `gate(name)` runs before each stage and may throw: a PublishHold means try again later, and anything else goes
// straight back to the caller, after the token is revoked. Resolves one of:
//   { state: 'published', branch, commit, pull, url, reviewDecision, flagged }
//   { state: 'refused', rule, file, word }
//   { state: 'unreachable', stage }             nothing went public, or the push may be tried again
//   { state: 'pushed_no_pr', branch, commit }
export async function publish({
  diff, validated, baseCommit, task, runId, textSha256, repo, gitUrl, apiUrl, auth, dateMs, tempRoot, gate = async () => {}, gitCommand = 'git', onPushed = () => {}, path,
}) {
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(tempRoot, 'publish-'));
  let minted = false;
  try {
    await gate('prepare');
    let token;
    try {
      token = await auth.token();
    } catch {
      return { state: 'unreachable', stage: 'mint' };
    }
    minted = true;
    const git = gitRunner({ gitCommand, env: gitEnvironment({ dir, gitUrl, token, path }) });
    const prepared = await prepareCommit({ diff, validated, baseCommit, task, gitUrl, git, dateMs });
    if (prepared.unreachable) return { state: 'unreachable', stage: 'fetch' };
    if (prepared.refused) {
      const { rule, file, word } = prepared.refused;
      return { state: 'refused', rule, file: file ?? null, word: word ?? null };
    }
    const { commit, flagged } = prepared;
    const branch = branchName(task, runId);

    await gate('push');
    // A plain push of a new ref, with no + and no --force. If the name is somehow taken by something else, git refuses it.
    const pushed = await git(['push', '-q', gitUrl, `${commit}:refs/heads/${branch}`], { timeoutMs: NETWORK_GIT_MS });
    if (pushed.code !== 0) return { state: 'unreachable', stage: 'push' };
    onPushed({ branch, commit });

    await gate('pull');
    const body = pullBody({ task, runId, textSha256, baseCommit, totals: validated.totals, flagged });
    const opened = await openPull({ apiUrl, auth, repo, branch, title: pullTitle(task), body, commit });
    if (opened.failed) return { state: 'pushed_no_pr', branch, commit, flagged };

    const reviewDecision = await readReviewDecision({ apiUrl, auth, repo, number: opened.number });
    return { state: 'published', branch, commit, pull: opened.number, url: `https://github.com/${repo}/pull/${opened.number}`, reviewDecision, flagged };
  } catch (err) {
    if (err instanceof PublishHold) return { state: 'unreachable', stage: 'gate' };
    throw err;
  } finally {
    if (minted) await revokeToken({ apiUrl, auth });
    rmSync(dir, { recursive: true, force: true });
  }
}
