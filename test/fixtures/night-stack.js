// Everything the overnight runner talks to, in a temp folder: a fake GitHub on a local port, a real bare git repository as its remote, the
// real coordinator with its own database, a fake docker, and the runner's own folders. Nothing here touches anything real. The credential
// and the App's key are throwaways made here. Tests that reach a push need git, and the review sandbox has none, so they skip there.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../coordinator/server.js';
import { Store } from '../../coordinator/store.js';
import { APPROVAL_LABEL, TASK_LABEL } from '../../night/approval.js';
import { Ledger } from '../../night/ledger.js';
import { readStop } from '../../shared/stop.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FAKE_DOCKER = join(HERE, 'fake-docker-runner.js');
export const REPO = 'owner/repo';
export const APPROVER = 1001;
export const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
export const hasGit = spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
export const needsGit = hasGit ? {} : { skip: 'this needs git, and the review sandbox has none' };
const APPROVED_ID = 'LA_approved';
const TASK_ID = 'LA_task';
const FALLBACK_SHA = 'c'.repeat(40);

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const gitEnv = (home) => ({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' });

const STARTING_FILES = Object.freeze({
  'README.md': 'A small repository.\nIts second line.\n',
  'night/existing.js': 'export const a = 1;\n',
  'src/a.js': 'export const b = 2;\n',
  'package.json': '{ "name": "x" }\n',
});

// A real bare repository with one commit on main. Returns { remote, sha, git }.
export function makeRemote(dir, files = STARTING_FILES) {
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'remote-work');
  const env = gitEnv(dir);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  mkdirSync(work, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(work, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', remote, 'main');
  return { remote, work, sha: git(work, 'rev-parse', 'HEAD'), git: (...args) => git(remote, ...args) };
}

// The starting repository is the same every time, so it is made once and copied: this file's tests make a great many.
let template = null;
function copyOfStartingRemote(dir) {
  if (!template) {
    const made = mkdtempSync(join(tmpdir(), 'adabra-night-template-'));
    process.once('exit', () => rmSync(made, { recursive: true, force: true }));
    template = { dir: made, sha: makeRemote(made).sha };
  }
  const remote = join(dir, 'remote.git');
  const work = join(dir, 'remote-work');
  cpSync(join(template.dir, 'remote.git'), remote, { recursive: true });
  cpSync(join(template.dir, 'remote-work'), work, { recursive: true });
  const env = gitEnv(dir);
  return { remote, work, sha: template.sha, git: (...args) => execFileSync('git', args, { cwd: remote, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
}

// One approved issue. The REST and GraphQL replies are both built from this, so they agree unless a test makes them differ.
export function approvedWorld({ now, title = 'A task', body = 'Do a small thing.', number = 21 }) {
  const labeledAt = iso(now - 60 * 60_000);
  const world = {
    number,
    title,
    body,
    state: 'open',
    labels: [TASK_LABEL, APPROVAL_LABEL],
    lastEditedAt: null,
    events: [
      { id: 7001, event: 'labeled', label: TASK_LABEL, at: iso(now - 2 * 60 * 60_000) },
      { id: 7002, event: 'labeled', label: APPROVAL_LABEL, at: labeledAt },
    ],
    pulls: [],
    statuses: {},
    reviewDecision: 'REVIEW_REQUIRED',
    down: false, // every read answers 503
    pullStatus: 201,
    requests: [],
    mints: [],
    revoked: [],
  };
  return world;
}

const LABEL_NODE = { [TASK_LABEL]: TASK_ID, [APPROVAL_LABEL]: APPROVED_ID };

function fakeGitHub({ world, clock, mainSha, tarball }) {
  const user = (id) => ({ login: `user${id}`, id, node_id: `U_${id}`, type: 'User', site_admin: false });
  const labelsRest = () => world.labels.map((name) => ({ id: 1, node_id: LABEL_NODE[name], name }));
  const issueRest = () => ({
    id: 5000 + world.number, node_id: `I_${world.number}`, number: world.number, state: world.state, title: world.title, body: world.body, user: user(APPROVER),
    repository_url: `https://api.github.com/repos/${REPO}`, labels: labelsRest(),
  });
  const eventRest = (e) => ({
    id: e.id, node_id: `E_${e.id}`, event: e.event, created_at: e.at, actor: user(APPROVER), performed_via_github_app: null, label: { name: e.label },
  });
  const graphql = (query, variables) => {
    if (query.includes('reviewDecision')) return { data: { repository: { pullRequest: { reviewDecision: world.reviewDecision } } } };
    const issue = query.includes('timelineItems')
      ? {
        timelineItems: {
          totalCount: world.events.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: world.events.map((e) => ({
            __typename: e.event === 'labeled' ? 'LabeledEvent' : 'UnlabeledEvent',
            id: `E_${e.id}`,
            createdAt: e.at,
            ...(e.event === 'labeled' ? { actor: { __typename: 'User', databaseId: APPROVER } } : {}),
            label: { id: LABEL_NODE[e.label], name: e.label, ...(e.event === 'labeled' ? { updatedAt: iso(clock() - 30 * 24 * 60 * 60_000) } : {}) },
          })),
        },
      }
      : {
        id: `I_${world.number}`, databaseId: 5000 + world.number, number: world.number, state: world.state.toUpperCase(), title: world.title, body: world.body, lastEditedAt: world.lastEditedAt,
        author: { __typename: 'User', databaseId: APPROVER },
        labels: { totalCount: world.labels.length, pageInfo: { hasNextPage: false }, nodes: labelsRest().map((l) => ({ id: l.node_id, name: l.name })) },
        userContentEdits: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
      };
    return { data: { repository: { nameWithOwner: REPO, issue } } };
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      world.requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json', date: new Date(clock()).toUTCString() });
        res.end(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
      };
      const path = req.url;
      if (req.method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
        if (world.down) return send(503, { message: 'down' });
        const asked = JSON.parse(raw);
        const value = `ghs_fake${world.mints.length}`;
        world.mints.push({ value, permissions: asked.permissions, repositories: asked.repositories });
        return send(201, { token: value, expires_at: new Date(clock() + 60 * 60_000).toISOString(), permissions: asked.permissions });
      }
      if (req.method === 'DELETE' && path === '/installation/token') {
        world.revoked.push(req.headers.authorization.replace(/^Bearer /, ''));
        res.writeHead(204);
        return res.end();
      }
      if (world.down) return send(503, { message: 'down' });
      if (req.method === 'POST' && path === '/graphql') {
        const { query, variables } = JSON.parse(raw);
        return send(200, graphql(query, variables));
      }
      if (req.method === 'GET' && path === `/repos/${REPO}/issues/${world.number}`) return send(200, issueRest());
      if (req.method === 'GET' && path.startsWith(`/repos/${REPO}/issues/${world.number}/events?`)) return send(200, world.events.map(eventRest));
      if (req.method === 'GET' && path.startsWith(`/repos/${REPO}/issues?`)) return send(200, world.state === 'open' && world.labels.includes(APPROVAL_LABEL) ? [issueRest()] : []);
      if (req.method === 'GET' && path === `/repos/${REPO}/commits/main`) return send(200, { sha: world.mainSha ?? mainSha });
      if (req.method === 'GET' && path === `/repos/${REPO}/tarball/${mainSha}`) return send(200, tarball);
      if (req.method === 'GET' && /^\/repos\/owner\/repo\/commits\/[0-9a-f]{40}\/status$/.test(path)) return send(200, { statuses: Object.entries(world.statuses).map(([context, state]) => ({ context, state })) });
      if (req.method === 'POST' && path === `/repos/${REPO}/pulls`) {
        if (world.pullStatus !== 201) return send(world.pullStatus, { message: 'refused' });
        const asked = JSON.parse(raw);
        const pull = { number: 900 + world.pulls.length, ...asked };
        pull.head = asked.head;
        world.pulls.push(pull);
        const sha = world.remote?.git('rev-parse', `refs/heads/${asked.head}`) ?? 'd'.repeat(40);
        return send(201, { number: pull.number, head: { sha } });
      }
      return send(404, { message: `the fake was asked for ${req.method} ${path}` });
    });
  });
  return server;
}

const listen = (server) => new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

// `now` is what the clock reads now. The clock runs on from there, and `advance` moves it.
export async function makeStack({ now = Date.now(), title, body, runsPerNight, leaseMs = 180_000, requiredReview = true, device = 'night-runner' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-night-run-'));
  let offset = now - Date.now();
  const clock = () => Date.now() + offset;
  const advance = (ms) => {
    offset += ms;
  };

  const state = join(dir, 'docker');
  mkdirSync(state);
  const setDocker = (control) => writeFileSync(join(state, 'control.json'), JSON.stringify(control));
  const setDiff = (bytes) => writeFileSync(join(state, 'diff'), bytes);
  const claudeControl = join(dir, 'claude.json');
  const setClaude = (control) => writeFileSync(claudeControl, JSON.stringify(control));
  setClaude({ result: { result: 'Finished.\ndone' } });

  const remote = hasGit ? copyOfStartingRemote(dir) : null;
  const mainSha = remote?.sha ?? FALLBACK_SHA;
  const tarball = Buffer.from('a fake source tarball');
  const world = approvedWorld({ now, title, body });
  world.remote = remote;
  const github = fakeGitHub({ world, clock, mainSha, tarball });
  const githubPort = await listen(github);

  const stopFile = join(dir, 'stop.json');
  writeFileSync(stopFile, JSON.stringify({ stopped: false }));
  const setStop = (stopped) => writeFileSync(stopFile, JSON.stringify(stopped ? { stopped: true, reason: 'a drill', since: new Date().toISOString() } : { stopped: false }));
  const store = new Store(join(dir, 'coordinator.sqlite'));
  const deviceToken = store.addDevice(device);
  store.addTask(`TASK-${world.number}`, world.number);
  const coordinator = createServer({ store, now: clock, leaseMs, stopState: () => readStop({ path: stopFile, machineDir: dir }) });
  const coordinatorPort = await listen(coordinator);

  const agentHome = join(dir, 'agent');
  mkdirSync(agentHome, { mode: 0o700 });
  writeFileSync(join(agentHome, 'config.json'), JSON.stringify({ coordinator_url: `http://127.0.0.1:${coordinatorPort}`, device_id: device }));
  writeFileSync(join(agentHome, 'token'), deviceToken, { mode: 0o600 });
  const keyFile = join(dir, 'app-key');
  writeFileSync(keyFile, PEM, { mode: 0o600 });
  const credentialFile = join(dir, 'model-credential');
  const credential = 'a-dummy-credential-for-tests';
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  const ledgerPath = join(dir, 'ledger.sqlite');
  new Ledger(ledgerPath, { create: true }).close();

  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GITHUB_REPO: REPO,
    NIGHT_APPROVER_ID: String(APPROVER),
    NIGHT_AUTHOR_IDS: String(APPROVER),
    NIGHT_APPROVAL_LABEL_ID: APPROVED_ID,
    NIGHT_DB: ledgerPath,
    NIGHT_STOP_FILE: stopFile,
    NIGHT_HOME: join(dir, 'night-home'),
    TEAM_AGENT_HOME: agentHome,
    NIGHT_APP_ID: '12345',
    NIGHT_APP_INSTALLATION_ID: '678',
    NIGHT_APP_KEY_FILE: keyFile,
    NIGHT_CREDENTIAL_FILE: credentialFile,
    NIGHT_IMAGE_ID: IMAGE_ID,
    NIGHT_DOCKER: FAKE_DOCKER,
    NIGHT_API_URL: `http://127.0.0.1:${githubPort}`,
    NIGHT_GIT_URL: remote ? `file://${remote.remote}` : 'file:///nonexistent/remote.git',
    NIGHT_REPORT_DIR: join(dir, 'reports'),
    ...(runsPerNight ? { NIGHT_RUNS_PER_NIGHT: String(runsPerNight) } : {}),
    ...(requiredReview ? { NIGHT_REQUIRED_REVIEW_ON: 'yes' } : {}),
    FAKE_RUNNER_STATE: state,
    FAKE_RUNNER_IMAGE_ID: IMAGE_ID,
    FAKE_CLAUDE_CONTROL: claudeControl,
  };

  const close = async () => {
    github.closeAllConnections?.();
    coordinator.closeAllConnections?.();
    await new Promise((resolve) => {
      github.close(resolve);
    });
    if (coordinator.listening) {
      await new Promise((resolve) => {
        coordinator.close(resolve);
      });
    }
    store.close?.();
    // A session still waiting to be killed exits as soon as its file has gone with the folder. A last docker call may still be writing there.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  };

  const calls = () => {
    const file = join(state, 'calls.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const liveContainers = () => {
    const d = join(state, 'containers');
    return existsSync(d) ? readdirSync(d) : [];
  };
  const liveVolumes = () => {
    const d = join(state, 'volumes');
    return existsSync(d) ? readdirSync(d) : [];
  };
  const remoteBranches = () => (remote ? remote.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/night') : '').split('\n').filter(Boolean);

  return {
    dir, env, world, store, coordinator, clock, advance, stopFile, setStop, setDocker, setDiff, setClaude, credential, remote, mainSha, tarball, state,
    calls, liveContainers, liveVolumes, remoteBranches, close,
  };
}

// A diff that real git printed, from a real change to the starting files. Needs git.
export function realDiff(stack, change) {
  const { work } = stack.remote;
  const env = gitEnv(stack.dir);
  change(work);
  execFileSync('git', ['add', '-A'], { cwd: work, env });
  const diff = execFileSync('git', ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color'], { cwd: work, env });
  execFileSync('git', ['reset', '-q', '--hard', 'HEAD'], { cwd: work, env });
  return diff;
}

// A diff adding one new file, as git prints it, with no need for git to make it.
export function addFileDiff(path = 'added.txt', text = 'hello\n') {
  const blob = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex').slice(0, 7);
  const lines = text.slice(0, -1).split('\n');
  return `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..${blob}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@\n${lines.map((l) => `+${l}\n`).join('')}`;
}

// Whether a file's mode lets anyone else in.
export const isPrivate = (path) => (statSync(path).mode & 0o077) === 0;
