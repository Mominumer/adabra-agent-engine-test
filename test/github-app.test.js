import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { AppTokens, GitHubSettingsError, appAuthFromEnv, gitHubCheck, scrub } from '../shared/github-auth.js';
import { COORDINATOR_PERMISSIONS, GitHubClient, marker } from '../coordinator/github.js';
import { MAX_ATTEMPTS as EVENT_ATTEMPTS, Store } from '../coordinator/store.js';
import { syncTasks } from '../coordinator/sync.js';
import { Worker } from '../coordinator/worker.js';
import { Dispatcher } from '../reviewer/dispatcher.js';
import { REVIEW_MARKER, REVIEW_PERMISSIONS, ReviewGitHub } from '../reviewer/github.js';
import { MAX_ATTEMPTS as JOB_ATTEMPTS, ReviewStore } from '../reviewer/store.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const posixOnly = { skip: process.platform === 'win32' ? 'relies on POSIX file modes and shell scripts' : false };
const MIN = 60_000;
const HOUR = 60 * MIN;

// A throwaway key, made for this run and never written anywhere but a temp folder. PKCS#1 is the format GitHub hands out.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' });
const APP = { id: 12345, client_id: 'Iv23litestclient', slug: 'adabra-test' };
const INSTALLATION = 678;
const PAT = 'old-personal-token';
const sha = (n) => String(n).repeat(40).slice(0, 40);

function checkJwt(jwt, nowMs) {
  const [h, p, s] = jwt.split('.');
  if (!s) return null;
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  const nowS = Math.floor(nowMs / 1000);
  // The rules GitHub states: RS256, the app as issuer, issued in the past, expiring no more than 10 minutes ahead.
  const good = verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, 'base64url')) &&
    header.alg === 'RS256' && [String(APP.id), APP.client_id].includes(claims.iss) && claims.iat <= nowS && claims.exp > nowS && claims.exp - nowS <= 600;
  return good ? { header, claims } : null;
}

// What each endpoint needs, from GitHub's "Permissions required for GitHub Apps" table. Any one of the listed permissions will do.
const NEEDS = [
  ['GET', /^\/repos\/o\/r\/issues\?/, ['issues'], 'read'],
  ['GET', /^\/repos\/o\/r\/issues\/\d+\/comments/, ['issues', 'pull_requests'], 'read'],
  ['POST', /^\/repos\/o\/r\/issues\/\d+\/comments/, ['issues', 'pull_requests'], 'write'],
  ['PATCH', /^\/repos\/o\/r\/issues\/comments\/\d+$/, ['issues', 'pull_requests'], 'write'],
  ['GET', /^\/repos\/o\/r\/pulls\?/, ['pull_requests'], 'read'],
  ['POST', /^\/repos\/o\/r\/statuses\//, ['statuses'], 'write'],
  ['GET', /^\/repos\/o\/r\/tarball\//, ['contents'], 'read'],
  ['GET', /^\/repos\/o\/r\/compare\//, ['contents'], 'read'],
];
const allows = (permissions, method, url) => {
  const need = NEEDS.find(([m, re]) => m === method && re.test(url));
  return !need || need[2].some((p) => permissions[p] === 'write' || (need[3] === 'read' && permissions[p] === 'read'));
};
const NOT_ACCESSIBLE = { message: 'Resource not accessible by integration' };

// --- fake GitHub: mints installation tokens, and remembers who wrote each comment ----------------
function fakeGitHub(clock) {
  const s = {
    mints: [], // every token issued: {header, claims, body, value}
    jwts: [],
    tokens: new Map(),
    requests: [], // {method, url, token}
    comments: [], // {id, issue, body, user, performed_via_github_app}
    statuses: [],
    issues: [],
    pulls: [],
    codeload: [], // the headers each download was asked with
    mintStatus: null, // refuse every mint with this
    mintDelayMs: 0,
    mintReply: null, // answer a mint with exactly this
    apiStatus: null, // answer every other call with this
    rejectAllTokens: false,
    refuseForeignEdits: false,
    rateLimitEdits: false,
    refusePosts: false,
    missingIssues: new Set(),
    echoSecrets: false,
    nextId: 1,
  };
  const mintRequests = () => s.requests.filter((r) => r.url.startsWith('/app/installations/')).length;
  const apiRequests = () => s.requests.filter((r) => !r.url.startsWith('/app/installations/'));
  const byApp = (c) => Boolean(c.performed_via_github_app);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const json = (code, obj, headers = {}) => (res.writeHead(code, { 'content-type': 'application/json', ...headers }), res.end(JSON.stringify(obj)));
      const bearer = (req.headers.authorization ?? '').replace('Bearer ', '');
      s.requests.push({ method: req.method, url: req.url, token: bearer });

      if (req.url === `/app/installations/${INSTALLATION}/access_tokens` && req.method === 'POST') {
        s.jwts.push(bearer);
        if (s.mintDelayMs) await new Promise((r) => setTimeout(r, s.mintDelayMs));
        const jwt = checkJwt(bearer, clock.t);
        if (!jwt) return json(401, { message: 'A JSON web token could not be decoded' });
        if (s.mintStatus) return json(s.mintStatus, { message: s.echoSecrets ? `no thanks ${bearer}` : 'no thanks' });
        if (s.mintReply) return json(201, s.mintReply);
        const body = JSON.parse(raw);
        const value = `ghs_fake${s.mints.length + 1}`;
        s.mints.push({ ...jwt, body, value });
        s.tokens.set(value, { permissions: body.permissions, expiresAt: clock.t + HOUR });
        return json(201, { token: value, expires_at: new Date(clock.t + HOUR).toISOString(), permissions: { ...body.permissions, metadata: 'read' }, repository_selection: 'selected' });
      }
      if (req.url.startsWith('/app/')) return json(404, { message: 'Not Found' });

      if (s.apiStatus) return json(s.apiStatus, { message: s.echoSecrets ? `down ${req.headers.authorization}` : 'down' });
      const app = s.tokens.get(bearer);
      const personal = bearer === PAT;
      if (s.rejectAllTokens || (!personal && (!app || clock.t >= app.expiresAt))) return json(401, { message: s.echoSecrets ? `Bad credentials ${bearer}` : 'Bad credentials' });
      if (app && !allows(app.permissions, req.method, req.url)) return json(403, NOT_ACCESSIBLE);

      let m;
      if (req.method === 'GET' && req.url.startsWith('/repos/o/r/issues?')) return json(200, s.issues);
      if (req.method === 'GET' && req.url.startsWith('/repos/o/r/pulls?')) return json(200, s.pulls);
      if ((m = req.url.match(/^\/repos\/o\/r\/statuses\/([0-9a-f]+)$/)) && req.method === 'POST') {
        s.statuses.push({ sha: m[1], ...JSON.parse(raw) });
        return json(201, {});
      }
      if (req.method === 'GET' && req.url.startsWith('/repos/o/r/compare/')) return json(200, { files: [] });
      if ((m = req.url.match(/^\/repos\/o\/r\/tarball\/([0-9a-f]+)$/)) && req.method === 'GET') {
        res.writeHead(302, { location: `${s.codeloadUrl}/o/r/legacy.tar.gz/${m[1]}?token=short-lived` });
        return res.end();
      }
      if ((m = req.url.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments/))) {
        if (s.missingIssues.has(+m[1])) return json(404, { message: 'Not Found' });
        if (req.method === 'GET') return json(200, s.comments.filter((c) => c.issue === +m[1]));
        if (s.refusePosts) return json(403, NOT_ACCESSIBLE);
        const c = {
          id: s.nextId++, issue: +m[1], body: JSON.parse(raw).body,
          user: app ? { login: `${APP.slug}[bot]`, type: 'Bot' } : { login: 'old-person', type: 'User' },
          performed_via_github_app: app ? APP : null,
        };
        s.comments.push(c);
        return json(201, c);
      }
      if ((m = req.url.match(/^\/repos\/o\/r\/issues\/comments\/(\d+)$/)) && req.method === 'PATCH') {
        if (s.rateLimitEdits) return json(403, { message: 'You have exceeded a secondary rate limit' }, { 'retry-after': '60' });
        const c = s.comments.find((x) => x.id === +m[1]);
        if (!c) return json(404, { message: 'Not Found' });
        if (s.refuseForeignEdits && byApp(c) !== Boolean(app)) return json(403, NOT_ACCESSIBLE);
        c.body = JSON.parse(raw).body;
        return json(200, c);
      }
      return json(404, { message: 'Not Found' });
    });
  });
  // A different origin, as codeload.github.com is to api.github.com.
  const codeload = http.createServer((req, res) => {
    s.codeload.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/gzip' });
    res.end('tarball bytes');
  });
  return {
    s, mintRequests, apiRequests,
    revokeAll: () => s.tokens.clear(),
    // A comment written before the switch, by the person whose token the service used.
    oldComment(issue, body) {
      const c = { id: s.nextId++, issue, body, user: { login: 'old-person', type: 'User' }, performed_via_github_app: null };
      s.comments.push(c);
      return c;
    },
    async listen() {
      await new Promise((r) => codeload.listen(0, '127.0.0.1', r));
      s.codeloadUrl = `http://127.0.0.1:${codeload.address().port}`;
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      return server.address().port;
    },
    close: () => Promise.all([server, codeload].map((x) => new Promise((r) => (x.closeAllConnections?.(), x.close(r))))),
  };
}

const tempDir = (t, prefix = 'adabra-app-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function harness(t) {
  const clock = { t: Date.now() };
  const gh = fakeGitHub(clock);
  const apiUrl = `http://127.0.0.1:${await gh.listen()}`;
  t.after(() => gh.close());
  const tokens = (permissions = COORDINATOR_PERMISSIONS, over = {}) =>
    new AppTokens({ appId: APP.id, installationId: INSTALLATION, key: privateKey, repoName: 'r', permissions, apiUrl, now: () => clock.t, timeoutMs: 2000, ...over });
  return { clock, gh, apiUrl, tokens };
}

let eventSeq = 0;
const checkpoint = (over = {}) => ({
  event_id: randomUUID(),
  task_id: 'TASK-1', run_id: 'RUN-1', device_id: 'member-a', claim_generation: 1, type: 'checkpoint',
  source_commit: 'a'.repeat(40), unpushed_commits: 0, summary: 'Payment screen implemented', verification: '8 passed', status: 'Building', next_action: 'Next',
  ts: new Date(1_800_000_000_000 + ++eventSeq * 1000).toISOString(),
  ...over,
});

async function coordinator(t, { token = null } = {}) {
  const h = await harness(t);
  const store = new Store(join(tempDir(t), 'coord.db'));
  t.after(() => store.close());
  store.addTask('TASK-1', 1);
  const logs = [];
  const github = token
    ? new GitHubClient({ apiUrl: h.apiUrl, repo: 'o/r', token, timeoutMs: 2000 })
    : new GitHubClient({ apiUrl: h.apiUrl, repo: 'o/r', auth: h.tokens(COORDINATOR_PERMISSIONS), timeoutMs: 2000 });
  const worker = new Worker({ store, github, log: (m) => logs.push(m) });
  const row = (id) => store.db.prepare('SELECT status, attempts, last_error FROM events WHERE event_id = ?').get(id);
  const add = (over) => {
    const e = checkpoint(over);
    store.insertEvent(e);
    return e;
  };
  // Enough time for anything due to be due, and for any wait after a failed mint to be over.
  const round = async () => {
    h.clock.t += 5 * MIN;
    await worker.tick(h.clock.t);
  };
  return { ...h, store, logs, github, worker, row, add, round };
}

async function reviewer(t, { runTests = async () => ({ state: 'success', summary: 'ok' }), token = null } = {}) {
  const h = await harness(t);
  const store = new ReviewStore(join(tempDir(t), 'reviewer.db'));
  t.after(() => store.close());
  const logs = [];
  const github = token
    ? new ReviewGitHub({ apiUrl: h.apiUrl, repo: 'o/r', token, timeoutMs: 2000 })
    : new ReviewGitHub({ apiUrl: h.apiUrl, repo: 'o/r', auth: h.tokens(REVIEW_PERMISSIONS), timeoutMs: 2000 });
  const d = new Dispatcher({
    store, github, repo: 'o/r', authors: ['alice'], now: () => h.clock.t, log: (m) => logs.push(m),
    runTests: (job) => runTests(job, github), runReview: async () => ({ state: 'success', summary: 'no findings' }),
  });
  const pull = (number, s) => ({ number, title: `PR ${number}`, body: '', draft: false, user: { login: 'alice' }, head: { sha: s, ref: `task/TASK-${number}`, repo: { full_name: 'o/r' } } });
  return { ...h, store, logs, github, d, pull };
}

function keyFile(t, { mode = 0o600, pem = PEM, name = 'app-key.pem', dir = tempDir(t) } = {}) {
  const path = join(dir, name);
  writeFileSync(path, pem, { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}

const settings = (t, over = {}) => ({ TEST_APP_ID: String(APP.id), TEST_APP_INSTALLATION_ID: String(INSTALLATION), TEST_APP_KEY_FILE: keyFile(t), ...over });
const fromEnv = (env, over = {}) => appAuthFromEnv({ prefix: 'TEST', repo: 'o/r', permissions: { issues: 'write' }, env, ...over });

// --- choosing between a token file and an app ---------------------------------------------------

test('no app settings at all: the service uses its token file, as it always has', () => {
  assert.equal(fromEnv({}), null);
  assert.equal(fromEnv({ TEST_APP_ID: '', TEST_APP_INSTALLATION_ID: '  ', TEST_APP_KEY_FILE: '' }), null, 'empty counts as not set');
});

test('incomplete app settings: refused, naming exactly what is missing', posixOnly, (t) => {
  const key = keyFile(t);
  const all = { TEST_APP_ID: '1', TEST_APP_INSTALLATION_ID: '2', TEST_APP_KEY_FILE: key };
  for (const missing of [['TEST_APP_ID'], ['TEST_APP_INSTALLATION_ID'], ['TEST_APP_KEY_FILE'], ['TEST_APP_ID', 'TEST_APP_KEY_FILE'], ['TEST_APP_INSTALLATION_ID', 'TEST_APP_KEY_FILE']]) {
    const env = { ...all };
    for (const m of missing) delete env[m];
    assert.throws(() => fromEnv(env), (err) => {
      assert.ok(err instanceof GitHubSettingsError);
      for (const m of missing) assert.ok(err.message.includes(m), err.message);
      return true;
    });
  }
});

test('invalid app settings: refused with the reason', posixOnly, (t) => {
  const dir = tempDir(t);
  const refused = (over, why, options) => assert.throws(() => fromEnv(settings(t, over), options), (err) => {
    assert.ok(err instanceof GitHubSettingsError, String(err));
    assert.match(err.message, why);
    return true;
  });
  refused({ TEST_APP_ID: 'not-an-app' }, /TEST_APP_ID is not an app ID/);
  refused({ TEST_APP_ID: '12 34' }, /TEST_APP_ID is not an app ID/);
  refused({ TEST_APP_INSTALLATION_ID: '12x' }, /TEST_APP_INSTALLATION_ID is not an installation ID/);
  refused({ TEST_APP_INSTALLATION_ID: '0' }, /TEST_APP_INSTALLATION_ID is not an installation ID/);
  refused({ TEST_APP_KEY_FILE: 'relative/key.pem' }, /absolute path/);
  refused({ TEST_APP_KEY_FILE: '~/key.pem' }, /absolute path/);
  refused({ TEST_APP_KEY_FILE: join(dir, 'nothing-here.pem') }, /cannot be read: ENOENT/);
  refused({ TEST_APP_KEY_FILE: dir }, /regular file/);
  const link = join(dir, 'link.pem');
  symlinkSync(keyFile(t), link);
  refused({ TEST_APP_KEY_FILE: link }, /regular file/);
  refused({ TEST_APP_KEY_FILE: keyFile(t, { pem: 'this is not a key' }) }, /usable private key/);
  refused({ TEST_APP_KEY_FILE: keyFile(t, { pem: publicKey.export({ type: 'spki', format: 'pem' }) }) }, /usable private key/);
  refused({ TEST_APP_KEY_FILE: keyFile(t, { pem: generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }) }, /not an RSA key/);
  refused({ TEST_APP_KEY_FILE: keyFile(t, { pem: 'x'.repeat(70_000) }) }, /too large/);
  const repoDir = tempDir(t);
  refused({ TEST_APP_KEY_FILE: keyFile(t, { dir: repoDir }) }, /inside the repository/, { repoDir });
  mkdirSync(join(repoDir, 'nested'));
  refused({ TEST_APP_KEY_FILE: keyFile(t, { dir: join(repoDir, 'nested') }) }, /inside the repository/, { repoDir });
  mkdirSync(join(repoDir, '..dotted'));
  refused({ TEST_APP_KEY_FILE: keyFile(t, { dir: join(repoDir, '..dotted') }) }, /inside the repository/, { repoDir });
  for (const repo of [undefined, '', 'no-slash', 'a/b/c']) refused({}, /GITHUB_REPO/, { repo });
});

test('a key that group or others can reach is refused, and one only its owner can read is accepted', posixOnly, (t) => {
  for (const mode of [0o640, 0o660, 0o604, 0o644, 0o666, 0o620, 0o602]) {
    assert.throws(() => fromEnv(settings(t, { TEST_APP_KEY_FILE: keyFile(t, { mode }) })), /group or others.*chmod 600/, mode.toString(8));
  }
  for (const mode of [0o600, 0o400]) assert.ok(fromEnv(settings(t, { TEST_APP_KEY_FILE: keyFile(t, { mode }) })) instanceof AppTokens, mode.toString(8));
});

test('a client ID is accepted as the issuer too, as GitHub allows', posixOnly, async (t) => {
  const h = await harness(t);
  const auth = fromEnv(settings(t, { TEST_APP_ID: APP.client_id, TEST_APP_INSTALLATION_ID: String(INSTALLATION) }), { apiUrl: h.apiUrl, now: () => h.clock.t });
  await auth.token();
  assert.equal(h.gh.s.mints[0].claims.iss, APP.client_id);
  assert.ok(auth.wrote({ performed_via_github_app: APP }));
});

test('each service reads only its own settings, and asks for only what it uses', posixOnly, (t) => {
  const key = keyFile(t);
  const coordinatorEnv = { GITHUB_APP_ID: '1', GITHUB_APP_INSTALLATION_ID: '2', GITHUB_APP_KEY_FILE: key };
  const reviewerEnv = { REVIEW_APP_ID: '1', REVIEW_APP_INSTALLATION_ID: '2', REVIEW_APP_KEY_FILE: key };
  assert.equal(appAuthFromEnv({ prefix: 'REVIEW', repo: 'o/r', permissions: REVIEW_PERMISSIONS, env: coordinatorEnv }), null);
  assert.equal(appAuthFromEnv({ prefix: 'GITHUB', repo: 'o/r', permissions: COORDINATOR_PERMISSIONS, env: reviewerEnv }), null);
  assert.ok(appAuthFromEnv({ prefix: 'REVIEW', repo: 'o/r', permissions: REVIEW_PERMISSIONS, env: reviewerEnv }));
  assert.deepEqual(COORDINATOR_PERMISSIONS, { issues: 'write' });
  assert.deepEqual(REVIEW_PERMISSIONS, { contents: 'read', pull_requests: 'write', statuses: 'write', issues: 'write' });
});

// --- the token itself ---------------------------------------------------------------------------

test('the JWT is RS256, issued a minute in the past, and expires within GitHub\'s 10 minutes; the token is asked for one repo and exact permissions', async (t) => {
  const { gh, clock, tokens } = await harness(t);
  await tokens(REVIEW_PERMISSIONS).token();
  const [{ header, claims, body }] = gh.s.mints;
  const nowS = Math.floor(clock.t / 1000);
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(claims.iss, String(APP.id));
  assert.equal(claims.iat, nowS - 60);
  assert.ok(claims.exp > nowS && claims.exp - nowS <= 600, 'at most 10 minutes ahead');
  assert.ok(claims.exp - nowS <= 540, 'and a minute to spare for a clock running fast');
  assert.deepEqual(body, { repositories: ['r'], permissions: REVIEW_PERMISSIONS });
});

test('a token is cached, renewed five minutes before it expires, and shared by concurrent callers', async (t) => {
  const { gh, clock, tokens } = await harness(t);
  const auth = tokens();
  const first = await auth.token();
  assert.equal(await auth.token(), first);
  clock.t += HOUR - 6 * MIN;
  assert.equal(await auth.token(), first, 'still more than the margin left');
  assert.equal(gh.s.mints.length, 1);
  clock.t += 2 * MIN; // four minutes left
  gh.s.mintDelayMs = 50;
  const all = await Promise.all(Array.from({ length: 8 }, () => auth.token()));
  assert.equal(new Set(all).size, 1, 'everyone gets the same new token');
  assert.notEqual(all[0], first);
  assert.equal(gh.s.mints.length, 2, 'and only one was asked for');
});

test('a refresh that fails early keeps the old token until it really expires; then callers fail fast until the wait is over', async (t) => {
  const { gh, clock, tokens } = await harness(t);
  const auth = tokens();
  const first = await auth.token();
  clock.t += HOUR - 4 * MIN;
  gh.s.mintStatus = 503;
  assert.equal(await auth.token(), first, 'not an outage yet');
  clock.t += 5 * MIN; // really expired now
  const before = gh.mintRequests();
  const outage = await auth.token().catch((e) => e);
  assert.equal(outage.authOutage, true);
  assert.equal(gh.mintRequests(), before + 1);
  for (let i = 0; i < 5; i++) assert.equal((await auth.token().catch((e) => e)).authOutage, true);
  assert.equal(gh.mintRequests(), before + 1, 'no new request while waiting');
  clock.t += 2 * MIN;
  gh.s.mintStatus = null;
  assert.notEqual(await auth.token(), first, 'and it recovers by itself');
});

test('every way of failing to get a token is an auth outage with no HTTP status of its own', async (t) => {
  const { gh, tokens } = await harness(t);
  const outage = async (auth, expected) => {
    const err = await auth.token().catch((e) => e);
    assert.equal(err.authOutage, true, String(err));
    assert.equal(err.status, undefined, 'a 404 here must not read as "that comment is gone"');
    assert.match(err.message, expected);
  };
  for (const [code, hint] of [[401, /clock/], [403, /suspended/], [422, /permission/], [500, /refused with 500/], [503, /refused with 503/]]) {
    gh.s.mintStatus = code;
    await outage(tokens(), hint);
  }
  gh.s.mintStatus = null;
  await outage(tokens(COORDINATOR_PERMISSIONS, { installationId: 999 }), /installation ID/);
  await outage(tokens(COORDINATOR_PERMISSIONS, { key: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey }), /key belongs/);
  await outage(tokens(COORDINATOR_PERMISSIONS, { apiUrl: 'http://127.0.0.1:1' }), /could not be reached/);
  for (const reply of [{}, { token: 'ghs_x' }, { expires_at: new Date().toISOString() }, { token: 'ghs_x', expires_at: 'soon' }, { token: 'two\nlines', expires_at: new Date().toISOString() }]) {
    gh.s.mintReply = reply;
    await outage(tokens(), /no usable token/);
  }
  gh.s.mintReply = { token: 'ghs_x', expires_at: new Date(Date.now() + HOUR).toISOString(), permissions: { issues: 'read' } };
  await outage(tokens(), /did not grant what this service asked for: issues/);
});

test('a token GitHub refuses is renewed once and the request tried once more; concurrent callers share that one renewal', async (t) => {
  const { gh, apiUrl, tokens } = await harness(t);
  const github = new GitHubClient({ apiUrl, repo: 'o/r', auth: tokens(), timeoutMs: 2000 });
  gh.s.issues.push({ number: 1 });
  assert.equal((await github.listIssues('agent-task')).length, 1);
  gh.revokeAll();
  assert.equal((await github.listIssues('agent-task')).length, 1);
  assert.equal(gh.s.mints.length, 2);
  assert.equal(gh.apiRequests().length, 3, 'ok, refused, ok');

  gh.revokeAll();
  gh.s.mintDelayMs = 50;
  const all = await Promise.all(Array.from({ length: 6 }, () => github.listIssues('agent-task')));
  assert.ok(all.every((r) => r.length === 1));
  assert.equal(gh.s.mints.length, 3, 'one renewal between the six of them');
});

test('a brand-new token refused as well: one retry only, then an auth outage carrying the 401', async (t) => {
  const { gh, apiUrl, tokens } = await harness(t);
  const github = new GitHubClient({ apiUrl, repo: 'o/r', auth: tokens(), timeoutMs: 2000 });
  gh.s.rejectAllTokens = true;
  const err = await github.listIssues('agent-task').catch((e) => e);
  assert.equal(err.status, 401);
  assert.equal(err.authOutage, true);
  assert.equal(gh.apiRequests().length, 2, 'not a loop');
  assert.equal(gh.s.mints.length, 2);
});

test('a token from a file is left alone: no renewal, no retry, and no auth outage', async (t) => {
  const { gh, apiUrl } = await harness(t);
  const github = new GitHubClient({ apiUrl, repo: 'o/r', token: 'wrong', timeoutMs: 2000 });
  const err = await github.listIssues('agent-task').catch((e) => e);
  assert.equal(err.status, 401);
  assert.equal(err.authOutage, undefined);
  assert.equal(gh.apiRequests().length, 1);
  assert.equal(gh.s.jwts.length, 0, 'never asks for an app token');
});

// --- what each service's narrow token can do -------------------------------------------------------

test('coordinator: its issues-only token does everything the coordinator does, and nothing the reviewer does', async (t) => {
  const { gh, apiUrl, tokens } = await harness(t);
  const auth = tokens(COORDINATOR_PERMISSIONS);
  const github = new GitHubClient({ apiUrl, repo: 'o/r', auth, timeoutMs: 2000 });
  gh.s.issues.push({ number: 1, title: 'x', state: 'open', labels: [{ name: 'agent-task' }] });
  assert.equal((await github.listIssues('agent-task')).length, 1);
  const id = await github.createComment(1, `${marker('TASK-1')}\nhello`);
  assert.equal(await github.findProgressComment(1, 'TASK-1'), id);
  await github.updateComment(id, `${marker('TASK-1')}\nagain`);
  assert.equal(gh.s.comments[0].body, `${marker('TASK-1')}\nagain`);

  const token = await auth.token();
  const call = (method, path) => fetch(`${apiUrl}${path}`, { method, redirect: 'manual', headers: { authorization: `Bearer ${token}` }, body: method === 'POST' ? '{}' : undefined });
  assert.equal((await call('POST', `/repos/o/r/statuses/${sha(1)}`)).status, 403);
  assert.equal((await call('GET', '/repos/o/r/pulls?state=open')).status, 403);
  assert.equal((await call('GET', `/repos/o/r/tarball/${sha(1)}`)).status, 403);
  assert.equal((await call('GET', `/repos/o/r/compare/main...${sha(1)}`)).status, 403);
});

test('coordinator: task sync works with an app token, and reads its list of issues the same way', async (t) => {
  const c = await coordinator(t);
  c.gh.s.issues.push({ number: 9, title: 'Do it', state: 'open', labels: [{ name: 'agent-task' }] });
  assert.deepEqual(await syncTasks({ store: c.store, github: c.github }), { created: 1, updated: 0 });
  assert.equal(c.store.getTask('TASK-9').title, 'Do it');
});

test('reviewer: its token does everything the reviewer does', async (t) => {
  const { gh, apiUrl, tokens } = await harness(t);
  const github = new ReviewGitHub({ apiUrl, repo: 'o/r', auth: tokens(REVIEW_PERMISSIONS), timeoutMs: 2000 });
  gh.s.pulls.push({ number: 5, title: 'x', body: '', user: { login: 'alice' }, head: { sha: sha(1), ref: 'b', repo: { full_name: 'o/r' } } });
  assert.equal((await github.openPulls())[0].author, 'alice', 'REVIEW_AUTHORS still sees the PR author, whoever the service posts as');
  await github.setStatus(sha(1), 'adabra/tests', 'success', 'ok');
  assert.equal(gh.s.statuses.length, 1);
  assert.deepEqual(await github.compareFiles('main', sha(1)), { files: [], truncated: false });
  assert.equal((await github.downloadTarball(sha(1))).toString(), 'tarball bytes');
  const id = await github.createComment(5, `${REVIEW_MARKER}\nhello`);
  assert.equal(await github.findReviewComment(5), id);
  await github.updateComment(id, `${REVIEW_MARKER}\nagain`);
});

// --- downloads ---------------------------------------------------------------------------------

test('a tarball download sends the app token to the API and never onward to codeload', async (t) => {
  const { gh, apiUrl, tokens } = await harness(t);
  const github = new ReviewGitHub({ apiUrl, repo: 'o/r', auth: tokens(REVIEW_PERMISSIONS), timeoutMs: 2000 });
  assert.equal((await github.downloadTarball(sha(1))).toString(), 'tarball bytes');
  const asked = gh.apiRequests().find((r) => r.url.includes('/tarball/'));
  assert.equal(asked.token, 'ghs_fake1', 'the API hop has the app token');
  assert.equal(gh.s.codeload.length, 1);
  assert.equal(gh.s.codeload[0].authorization, undefined, 'the redirect hop does not');
});

test('a tarball download recovers from a refused token, and starts with enough token life left', async (t) => {
  const { gh, clock, apiUrl, tokens } = await harness(t);
  const github = new ReviewGitHub({ apiUrl, repo: 'o/r', auth: tokens(REVIEW_PERMISSIONS), timeoutMs: 2000 });
  await github.downloadTarball(sha(1));
  gh.revokeAll();
  assert.equal((await github.downloadTarball(sha(1))).toString(), 'tarball bytes');
  assert.equal(gh.s.mints.length, 2);
  assert.ok(gh.s.codeload.every((h) => h.authorization === undefined));

  clock.t += HOUR - 4 * MIN; // four minutes of life left, and a download may take two
  await github.downloadTarball(sha(1));
  assert.equal(gh.s.mints.length, 3, 'renewed before it started');
});

test('a failed tarball download during an outage is an auth outage, so the sandbox runner passes it on', async (t) => {
  const { gh, clock, apiUrl, tokens } = await harness(t);
  const github = new ReviewGitHub({ apiUrl, repo: 'o/r', auth: tokens(REVIEW_PERMISSIONS), timeoutMs: 2000 });
  gh.s.mintStatus = 503;
  assert.equal((await github.downloadTarball(sha(1)).catch((e) => e)).authOutage, true);
  gh.s.mintStatus = null;
  clock.t += 2 * MIN;
  gh.s.rejectAllTokens = true;
  const err = await github.downloadTarball(sha(1)).catch((e) => e);
  assert.equal(err.authOutage, true);
  assert.equal(err.status, 401);
});

// --- an outage of our own credentials: the coordinator ---------------------------------------------

for (const [name, breakIt] of [
  ['GitHub refusing to mint (503)', (c) => (c.gh.s.mintStatus = 503)],
  ['a wrong key or app ID (401 at mint)', (c) => (c.gh.s.mintStatus = 401)],
  ['the app uninstalled (404 at mint)', (c) => (c.gh.s.mintStatus = 404)],
  ['fresh tokens refused (401 on use)', (c) => (c.gh.s.rejectAllTokens = true)],
  ['the app missing a permission (403 on use)', (c) => (c.gh.s.refusePosts = true)],
]) {
  test(`coordinator: ${name} never kills an event or uses an attempt, and it is applied once when things recover`, async (t) => {
    const c = await coordinator(t);
    const e = c.add();
    breakIt(c);
    for (let i = 0; i < EVENT_ATTEMPTS * 3; i++) await c.round();
    assert.deepEqual({ status: c.row(e.event_id).status, attempts: c.row(e.event_id).attempts }, { status: 'pending', attempts: 0 });
    assert.ok(c.row(e.event_id).last_error, 'the reason is on record');
    assert.equal(c.store.counts().dead, undefined);
    assert.equal(c.gh.s.comments.length, 0);
    assert.ok(c.logs.some((l) => l.includes('not counted as an attempt')));

    c.gh.s.mintStatus = null;
    c.gh.s.rejectAllTokens = false;
    c.gh.s.refusePosts = false;
    await c.round();
    assert.equal(c.row(e.event_id).status, 'done');
    assert.equal(c.gh.s.comments.length, 1);
  });
}

test('coordinator: held events keep their order and do not hide the next task', async (t) => {
  const c = await coordinator(t);
  c.store.addTask('TASK-2', 2);
  const a1 = c.add({ summary: 'first' });
  const a2 = c.add({ summary: 'second' });
  const b = c.add({ task_id: 'TASK-2', summary: 'other task' });
  c.gh.s.mintStatus = 503;
  await c.round();
  c.gh.s.mintStatus = null;
  await c.round();
  assert.equal(c.row(a2.event_id).status, 'done');
  assert.equal(c.row(b.event_id).status, 'done');
  assert.ok(['done', 'skipped'].includes(c.row(a1.event_id).status), 'the older one never replaces the newer');
  assert.match(c.gh.s.comments.find((x) => x.issue === 1).body, /second/);
});

test('coordinator: a failure that has nothing to do with the credentials still counts, and can still go dead', async (t) => {
  const c = await coordinator(t);
  const e = c.add();
  c.gh.s.missingIssues.add(1);
  await c.round();
  assert.equal(c.row(e.event_id).attempts, 1);
  for (let i = 1; i < EVENT_ATTEMPTS; i++) await c.round();
  assert.equal(c.row(e.event_id).status, 'dead');
});

test('coordinator: GitHub itself down, with a good token, is the ordinary retry as before', async (t) => {
  const c = await coordinator(t);
  const e = c.add();
  await c.github.auth.token();
  c.gh.s.apiStatus = 503;
  await c.round();
  assert.deepEqual({ status: c.row(e.event_id).status, attempts: c.row(e.event_id).attempts }, { status: 'pending', attempts: 1 });
  c.gh.s.apiStatus = null;
  await c.round();
  assert.equal(c.row(e.event_id).status, 'done');
});

test('coordinator with a token from a file: a bad token still counts, as it always has', async (t) => {
  const c = await coordinator(t, { token: 'wrong' });
  const e = c.add();
  for (let i = 0; i < EVENT_ATTEMPTS; i++) await c.round();
  assert.equal(c.row(e.event_id).status, 'dead');
  assert.equal(c.gh.s.jwts.length, 0);
});

test('coordinator: a review result waits out an outage and is not lost', async (t) => {
  const c = await coordinator(t);
  const result = {
    result_id: randomUUID(), task_id: 'TASK-1', pr: 7, sha: sha(1), tests: 'success', review: 'success', tests_summary: 'ok', review_summary: 'ok',
    findings: [], findings_total: 0, reviewer: 'mock-v1', commit_seen_at: 1000, reviewed_at: 2000,
  };
  assert.equal(c.store.recordReviewResult(result, 'mini-reviewer', c.clock.t).outcome, 'accepted');
  c.gh.s.mintStatus = 503;
  for (let i = 0; i < 12; i++) await c.round();
  assert.equal(c.gh.s.comments.length, 0);
  c.gh.s.mintStatus = null;
  await c.round();
  assert.equal(c.gh.s.comments.length, 1);
  assert.match(c.gh.s.comments[0].body, /review passed/i);
});

// --- an outage of our own credentials: the reviewer -------------------------------------------------

test('reviewer: an outage while posting results never fails the job or uses an attempt; it finishes once things recover', async (t) => {
  const r = await reviewer(t);
  r.gh.s.pulls.push(r.pull(5, sha(1)));
  await r.d.poll();
  r.gh.revokeAll();
  r.gh.s.mintStatus = 503;
  for (let i = 0; i < JOB_ATTEMPTS * 3; i++) {
    r.clock.t += 5 * MIN;
    assert.deepEqual(await r.d.runOnce(), { pr: 5, sha: sha(1), retry: true, failed: false });
    const job = r.store.getJob(5, sha(1));
    assert.deepEqual({ state: job.state, attempts: job.attempts }, { state: 'queued', attempts: 0 });
  }
  assert.equal(r.gh.s.statuses.filter((s) => s.state !== 'pending').length, 0);
  assert.ok(r.logs.some((l) => l.includes('not counted as an attempt')));

  r.gh.s.mintStatus = null;
  r.clock.t += 5 * MIN;
  assert.deepEqual(await r.d.runOnce(), { pr: 5, sha: sha(1), tests: 'success', review: 'success' });
  assert.equal(r.store.getJob(5, sha(1)).state, 'done');
  assert.equal(r.gh.s.comments.length, 1);
});

test('reviewer: an outage that hits the download is held the same way, and the wait is honoured', async (t) => {
  const r = await reviewer(t, { runTests: async (job, github) => (await github.downloadTarball(job.sha), { state: 'success', summary: 'ok' }) });
  r.gh.s.pulls.push(r.pull(5, sha(1)));
  await r.d.poll();
  r.gh.revokeAll();
  r.gh.s.mintStatus = 401;
  r.clock.t += 5 * MIN;
  assert.equal((await r.d.runOnce()).retry, true);
  assert.equal(await r.d.runOnce(), null, 'not due again yet');
  assert.equal(r.store.getJob(5, sha(1)).attempts, 0);
});

test('reviewer: a failure that has nothing to do with the credentials still counts', async (t) => {
  const r = await reviewer(t, { runTests: async () => { throw new Error('docker is not available'); } });
  r.gh.s.pulls.push(r.pull(5, sha(1)));
  await r.d.poll();
  for (let i = 0; i < JOB_ATTEMPTS; i++) {
    r.clock.t += 20 * MIN;
    await r.d.runOnce();
  }
  assert.equal(r.store.getJob(5, sha(1)).state, 'failed');
});

test('reviewer: polling through an outage rejects, which the serve loop logs and retries, and queues nothing it cannot see', async (t) => {
  const r = await reviewer(t);
  r.gh.s.mintStatus = 503;
  assert.equal((await r.d.poll().catch((e) => e)).authOutage, true);
  r.gh.s.mintStatus = null;
  r.gh.s.pulls.push(r.pull(5, sha(1)));
  r.clock.t += 5 * MIN;
  assert.equal(await r.d.poll(), 1);
});

// --- comments written under the old identity: the coordinator --------------------------------------

test('coordinator: a comment from the old identity is still found by its marker, and edited in place when GitHub allows', async (t) => {
  const c = await coordinator(t);
  const old = c.gh.oldComment(1, `${marker('TASK-1')}\nolder text`);
  assert.equal(await c.github.findProgressComment(1, 'TASK-1'), old.id);
  c.add();
  await c.round();
  assert.equal(c.gh.s.comments.length, 1, 'no second comment');
  assert.match(old.body, /Payment screen/);
  assert.equal(c.store.getTask('TASK-1').comment_id, old.id);
});

for (const [name, remembered] of [['its id remembered', true], ['only its marker to go on', false]]) {
  test(`coordinator: GitHub refuses to let the app edit an old comment (${name}): one new comment, no retry loop, no lost event`, async (t) => {
    const c = await coordinator(t);
    const old = c.gh.oldComment(1, `${marker('TASK-1')}\nolder text`);
    if (remembered) c.store.setTaskComment('TASK-1', old.id);
    c.gh.s.refuseForeignEdits = true;
    const e = c.add({ summary: 'first after the switch' });
    await c.round();
    assert.equal(c.row(e.event_id).status, 'done');
    assert.equal(c.row(e.event_id).attempts, 0);
    assert.equal(c.gh.s.comments.length, 2);
    assert.equal(old.body, `${marker('TASK-1')}\nolder text`, 'the old comment is left as it was');
    const fresh = c.gh.s.comments[1];
    assert.match(fresh.body, /first after the switch/);
    assert.equal(c.store.getTask('TASK-1').comment_id, fresh.id);
    assert.ok(c.logs.some((l) => l.includes('refused an edit')));

    const patches = () => c.gh.s.requests.filter((x) => x.method === 'PATCH').map((x) => x.url);
    const before = patches().length;
    c.add({ summary: 'second after the switch' });
    await c.round();
    assert.equal(c.gh.s.comments.length, 2, 'still two');
    assert.match(fresh.body, /second after the switch/);
    assert.deepEqual(patches().slice(before), [`/repos/o/r/issues/comments/${fresh.id}`], 'and the old one is not tried again');
  });
}

test('coordinator: after moving off an old comment, a lost id or a crash before remembering the new one makes no third comment', async (t) => {
  const c = await coordinator(t);
  const old = c.gh.oldComment(1, `${marker('TASK-1')}\nolder text`);
  c.store.setTaskComment('TASK-1', old.id);
  c.gh.s.refuseForeignEdits = true;
  c.add();
  await c.round();
  const fresh = c.gh.s.comments[1];

  c.store.setTaskComment('TASK-1', old.id); // the crash: the new comment exists and its id was never saved
  c.add({ summary: 'after the crash' });
  await c.round();
  assert.equal(c.gh.s.comments.length, 2);
  assert.match(fresh.body, /after the crash/);
  assert.equal(c.store.getTask('TASK-1').comment_id, fresh.id);

  c.store.setTaskComment('TASK-1', null); // the id lost altogether
  c.add({ summary: 'after losing the id' });
  await c.round();
  assert.equal(c.gh.s.comments.length, 2);
  assert.match(fresh.body, /after losing the id/);
});

test('coordinator: a rate limit on an edit is not a refusal, so it posts no extra comment', async (t) => {
  const c = await coordinator(t);
  const old = c.gh.oldComment(1, `${marker('TASK-1')}\nolder text`);
  c.store.setTaskComment('TASK-1', old.id);
  c.gh.s.rateLimitEdits = true;
  const e = c.add();
  await c.round();
  assert.equal(c.gh.s.comments.length, 1);
  assert.deepEqual({ status: c.row(e.event_id).status, attempts: c.row(e.event_id).attempts }, { status: 'pending', attempts: 1 });
  c.gh.s.rateLimitEdits = false;
  await c.round();
  assert.equal(c.row(e.event_id).status, 'done');
  assert.equal(c.gh.s.comments.length, 1);
});

test('coordinator: edit refused and new comment refused too: the event waits and nothing piles up on the issue', async (t) => {
  const c = await coordinator(t);
  const old = c.gh.oldComment(1, `${marker('TASK-1')}\nolder text`);
  c.store.setTaskComment('TASK-1', old.id);
  c.gh.s.refuseForeignEdits = true;
  c.gh.s.refusePosts = true;
  const e = c.add();
  for (let i = 0; i < EVENT_ATTEMPTS * 2; i++) await c.round();
  assert.deepEqual({ status: c.row(e.event_id).status, attempts: c.row(e.event_id).attempts }, { status: 'pending', attempts: 0 });
  assert.equal(c.gh.s.comments.length, 1);
  c.gh.s.refusePosts = false;
  await c.round();
  assert.equal(c.row(e.event_id).status, 'done');
  assert.equal(c.gh.s.comments.length, 2);
});

test('coordinator: switching back to a token from a file cannot loop either, if GitHub refuses it the app\'s comment', async (t) => {
  const c = await coordinator(t, { token: PAT });
  c.gh.s.tokens.set('ghs_earlier', { permissions: { issues: 'write' }, expiresAt: c.clock.t + 24 * HOUR });
  const byApp = await new GitHubClient({ apiUrl: c.apiUrl, repo: 'o/r', token: 'ghs_earlier', timeoutMs: 2000 }).createComment(1, `${marker('TASK-1')}\nfrom the app`);
  c.store.setTaskComment('TASK-1', byApp);
  c.gh.s.refuseForeignEdits = true;
  const e = c.add({ summary: 'back on the token' });
  await c.round();
  assert.equal(c.row(e.event_id).status, 'done');
  assert.equal(c.gh.s.comments.length, 2);
  assert.match(c.gh.s.comments[1].body, /back on the token/);
  c.gh.s.refuseForeignEdits = false;
  c.add({ summary: 'and again' });
  await c.round();
  assert.equal(c.gh.s.comments.length, 2);
});

test('a token from a file still takes the first marker comment and stops looking, as it always has', async (t) => {
  const { gh, apiUrl } = await harness(t);
  const github = new GitHubClient({ apiUrl, repo: 'o/r', token: PAT, timeoutMs: 2000 });
  const first = gh.oldComment(1, `${marker('TASK-1')}\none`);
  gh.oldComment(1, `${marker('TASK-1')}\ntwo`);
  assert.equal(await github.findProgressComment(1, 'TASK-1'), first.id);
});

// --- comments written under the old identity: the reviewer -----------------------------------------

test('reviewer: an old review comment is found and edited in place when GitHub allows', async (t) => {
  const r = await reviewer(t);
  const old = r.gh.oldComment(5, `${REVIEW_MARKER}\nolder text`);
  r.gh.s.pulls.push(r.pull(5, sha(1)));
  await r.d.poll();
  await r.d.runOnce();
  assert.equal(r.gh.s.comments.length, 1);
  assert.match(old.body, /Adabra review/);
  assert.equal(r.store.commentId(5), old.id);
});

for (const [name, remembered] of [['its id remembered', true], ['only its marker to go on', false]]) {
  test(`reviewer: GitHub refuses to let the app edit an old review comment (${name}): one new comment, and the statuses still land`, async (t) => {
    const r = await reviewer(t);
    const old = r.gh.oldComment(5, `${REVIEW_MARKER}\nolder text`);
    if (remembered) r.store.setCommentId(5, old.id);
    r.gh.s.refuseForeignEdits = true;
    r.gh.s.pulls.push(r.pull(5, sha(1)));
    await r.d.poll();
    assert.deepEqual(await r.d.runOnce(), { pr: 5, sha: sha(1), tests: 'success', review: 'success' });
    assert.equal(r.store.getJob(5, sha(1)).state, 'done');
    assert.equal(r.gh.s.comments.length, 2);
    assert.equal(old.body, `${REVIEW_MARKER}\nolder text`);
    const fresh = r.gh.s.comments[1];
    assert.equal(r.store.commentId(5), fresh.id);

    r.gh.s.pulls[0].head.sha = sha(2); // a new push
    await r.d.poll();
    await r.d.runOnce();
    assert.equal(r.gh.s.comments.length, 2, 'still two');
    assert.match(fresh.body, new RegExp(sha(2).slice(0, 12)));

    r.store.setCommentId(5, old.id); // a crash before the new id was saved
    r.gh.s.pulls[0].head.sha = sha(3);
    await r.d.poll();
    await r.d.runOnce();
    assert.equal(r.gh.s.comments.length, 2, 'finds its own comment rather than making a third');
    assert.match(fresh.body, new RegExp(sha(3).slice(0, 12)));
  });
}

test('REVIEW_AUTHORS is about who wrote the PR: posting as the app changes nothing about who may run', async (t) => {
  const r = await reviewer(t);
  r.gh.s.pulls.push(r.pull(5, sha(1)), { ...r.pull(6, sha(2)), user: { login: `${APP.slug}[bot]` } });
  assert.equal(await r.d.poll(), 1, 'the listed author runs; a PR by the app itself would not');
  assert.equal(r.store.next(r.clock.t).pr, 5);
});

// --- secrets -----------------------------------------------------------------------------------

test('secrets never reach an error, a log, the database or a status, even when GitHub echoes them back', async (t) => {
  const c = await coordinator(t);
  const r = await reviewer(t);
  const seen = [];
  const collect = async (promise) => {
    const err = await promise.catch((e) => e);
    if (err instanceof Error) seen.push(err.message, String(err.stack));
  };
  for (const x of [c, r]) x.gh.s.echoSecrets = true;

  // A token is issued, then GitHub answers with the Authorization header in its body.
  await c.github.auth.token();
  await r.github.auth.token();
  c.gh.s.apiStatus = 503;
  r.gh.s.apiStatus = 503;
  c.add();
  await c.round();
  await collect(c.github.listIssues('agent-task'));
  await collect(r.github.openPulls());
  await collect(r.github.downloadTarball(sha(1)));
  c.gh.s.apiStatus = null;
  r.gh.s.apiStatus = null;

  // A used token is refused, with the token quoted back.
  c.gh.s.rejectAllTokens = true;
  await collect(c.github.listIssues('agent-task'));
  c.gh.s.rejectAllTokens = false;

  // A mint refused with the JWT quoted back. Then a malformed token, which would make fetch quote the header.
  c.gh.revokeAll();
  c.gh.s.mintStatus = 500;
  c.clock.t += 2 * HOUR;
  await collect(c.github.listIssues('agent-task'));
  c.add();
  await c.round();
  c.gh.s.mintStatus = null;
  c.gh.s.mintReply = { token: 'ghs_secret\nsecond line', expires_at: new Date(c.clock.t + HOUR).toISOString() };
  c.clock.t += 5 * MIN;
  await collect(c.github.listIssues('agent-task'));
  c.gh.s.mintReply = null;

  // The job is held and the reason saved, with the mint failure quoted.
  r.gh.s.pulls.push(r.pull(5, sha(1)));
  r.gh.s.statuses.length = 0;
  await r.d.poll();
  r.gh.revokeAll();
  r.gh.s.mintStatus = 500;
  r.clock.t += 2 * HOUR;
  await r.d.runOnce();

  const text = [
    ...seen, ...c.logs, ...r.logs,
    JSON.stringify(c.store.db.prepare('SELECT last_error FROM events').all()),
    JSON.stringify(r.store.db.prepare('SELECT last_error FROM jobs').all()),
    JSON.stringify(r.gh.s.statuses),
    JSON.stringify(c.github), JSON.stringify(c.github.auth), inspect(c.github, { depth: 10, showHidden: true }), inspect(c.github.auth, { depth: 10, showHidden: true }),
  ].join('\n');
  const secrets = [
    ...c.gh.s.mints.map((m) => m.value), ...r.gh.s.mints.map((m) => m.value), ...c.gh.s.jwts, ...r.gh.s.jwts,
    'ghs_secret', 'PRIVATE KEY', PEM.split('\n')[1],
  ];
  assert.ok(c.gh.s.jwts.length && r.gh.s.jwts.length && seen.length >= 5, 'the scenarios really ran');
  for (const secret of secrets) assert.ok(!text.includes(secret), `leaked: ${secret.slice(0, 12)}`);
  assert.match(text, /\[hidden\]/, 'and the echoes really happened');
});

test('scrub hides tokens, JWTs and key blocks, whole or cut short, and leaves ordinary text alone', () => {
  for (const secret of ['ghs_abc123', 'ghp_abc', 'gho_abc', 'ghu_abc', 'ghr_abc', 'github_pat_ABC_def', 'Bearer anything', 'eyJhbGciOi.eyJpYXQ.sig', 'eyJhbGciOiJSUzI1']) {
    assert.ok(!scrub(`before ${secret} after`).includes(secret), secret);
  }
  assert.equal(scrub(`a ${PEM.trim()} b`), 'a [hidden] b');
  assert.equal(scrub(`a ${PEM.slice(0, 100)}`), 'a [hidden]');
  const plain = 'GitHub PATCH /repos/o/r/issues/comments/5 -> 403 Resource not accessible by integration';
  assert.equal(scrub(plain), plain);
});

test('settings errors never quote what the key file holds', posixOnly, (t) => {
  const texts = [
    keyFile(t, { pem: 'SECRET-LOOKING-MATERIAL' }),
    keyFile(t, { mode: 0o644 }),
  ].map((path) => {
    try {
      fromEnv(settings(t, { TEST_APP_KEY_FILE: path }));
    } catch (err) {
      return `${err.message}\n${err.stack}`;
    }
    throw new Error('should have been refused');
  });
  for (const text of texts) {
    assert.ok(!text.includes('SECRET-LOOKING-MATERIAL'));
    assert.ok(!text.includes(PEM.split('\n')[1]));
  }
});

test('no key file can be committed: git ignores them, and none is in the tree', () => {
  const ignored = readFileSync(join(REPO, '.gitignore'), 'utf8').split('\n');
  assert.ok(ignored.includes('*.pem'));
  assert.ok(ignored.includes('*.key'));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name === '.git') return [];
    return e.isDirectory() ? walk(join(dir, e.name)) : [e.name];
  });
  assert.deepEqual(walk(REPO).filter((n) => /\.(pem|key)$/.test(n)), []);
});

// --- the commands ------------------------------------------------------------------------------

const main = (script, cmd, env) =>
  spawnSync(process.execPath, [join(REPO, script), cmd], { encoding: 'utf8', timeout: 30_000, env: { PATH: process.env.PATH, ...env } });

test('coordinator will not start half-configured, and does not fall back to the token file it was given', posixOnly, (t) => {
  const dir = tempDir(t);
  const base = { COORDINATOR_DB: join(dir, 'c.db'), GITHUB_REPO: 'o/r', GITHUB_TOKEN_FILE: keyFile(t, { name: 'not-a-key', pem: 'a-working-personal-token' }) };
  const partial = main('coordinator/main.js', 'serve', { ...base, GITHUB_APP_ID: '1' });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /GITHUB_APP_INSTALLATION_ID, GITHUB_APP_KEY_FILE not set/);
  assert.doesNotMatch(partial.stdout, /listening/);

  const dryRun = main('coordinator/main.js', 'serve', { ...base, GITHUB_APP_ID: '1', GITHUB_DRY_RUN: '1' });
  assert.equal(dryRun.status, 1, 'a dry run does not excuse it');

  const open = main('coordinator/main.js', 'serve', { ...base, GITHUB_APP_ID: '1', GITHUB_APP_INSTALLATION_ID: '2', GITHUB_APP_KEY_FILE: keyFile(t, { mode: 0o644 }) });
  assert.equal(open.status, 1);
  assert.match(open.stderr, /group or others/);
  assert.ok(!`${open.stdout}${open.stderr}`.includes(PEM.split('\n')[1]));
});

test('reviewer will not start half-configured either', posixOnly, (t) => {
  const dir = tempDir(t);
  const base = { REVIEW_DB: join(dir, 'r.db'), REVIEW_AUTHORS: 'alice', GITHUB_REPO: 'o/r', REVIEW_TOKEN_FILE: keyFile(t, { name: 'not-a-key', pem: 'a-working-personal-token' }), HOME: dir };
  const partial = main('reviewer/main.js', 'serve', { ...base, REVIEW_APP_KEY_FILE: keyFile(t) });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /REVIEW_APP_ID, REVIEW_APP_INSTALLATION_ID not set/);
  assert.doesNotMatch(partial.stdout, /reviewer started/);
});

test('github-check refuses bad settings, and leaves no database behind', posixOnly, (t) => {
  const dir = tempDir(t);
  const c = main('coordinator/main.js', 'github-check', { COORDINATOR_DB: join(dir, 'c.db'), GITHUB_REPO: 'o/r', GITHUB_APP_ID: '1' });
  assert.equal(c.status, 1);
  assert.match(c.stderr, /GITHUB_APP_INSTALLATION_ID/);
  assert.ok(!existsSync(join(dir, 'c.db')));
  const r = main('reviewer/main.js', 'github-check', { REVIEW_DB: join(dir, 'r.db'), GITHUB_REPO: 'o/r', REVIEW_APP_ID: '1', HOME: dir });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REVIEW_APP_INSTALLATION_ID/);
  assert.ok(!existsSync(join(dir, 'r.db')));
});

test('gitHubCheck says what the token can do, never the token, and fails plainly', async (t) => {
  const { gh, apiUrl, tokens } = await harness(t);
  const auth = tokens(REVIEW_PERMISSIONS);
  const github = new ReviewGitHub({ apiUrl, repo: 'o/r', auth, timeoutMs: 2000 });
  const lines = [];
  const check = (a, read) => gitHubCheck({ auth: a, read, print: (l) => lines.push(l) });
  assert.equal(await check(auth, async () => `read check: ${(await github.openPulls()).length} open`), true);
  const text = lines.join('\n');
  assert.match(text, /GitHub App 12345, installation 678/);
  assert.match(text, /contents=read/);
  assert.match(text, /metadata=read/, 'everything GitHub actually granted is shown');
  assert.match(text, /read check: 0 open/);
  assert.match(text, /github-check passed/);
  assert.ok(!text.includes('ghs_fake'));

  lines.length = 0;
  gh.s.mintStatus = 404;
  assert.equal(await check(tokens(), async () => 'never reached'), false);
  assert.match(lines.join('\n'), /github-check FAILED: .*installation ID/);
  assert.doesNotMatch(lines.join('\n'), /never reached/);
});

// --- the install scripts, with launchctl and friends standing in ------------------------------------

function fakeBin(t) {
  const dir = tempDir(t);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'calls.log');
  const script = (name, body) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  script('launchctl', `echo "launchctl $*" >> "${log}"
case "$1" in
  print) [ -f "${log}.loaded" ] ;;
  bootstrap) touch "${log}.loaded" ;;
  bootout) rm -f "${log}.loaded" ;;
esac`);
  script('node', `echo "node $* key=$GITHUB_APP_KEY_FILE$REVIEW_APP_KEY_FILE" >> "${log}"
exit "\${FAKE_NODE_EXIT:-0}"`);
  script('lsof', 'exit 1');
  script('curl', 'echo ok');
  script('sleep', 'exit 0');
  const home = join(dir, 'home');
  mkdirSync(home);
  return {
    home, log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    run: (service, env) => spawnSync(join(REPO, 'service', `${service}-service.sh`), ['install'], {
      encoding: 'utf8', timeout: 30_000, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
    }),
    plist: (service) => join(home, 'Library', 'LaunchAgents', `ai.adabra.${service}.plist`),
  };
}

const SCRIPTS = [
  { service: 'coordinator', prefix: 'GITHUB', tokenEnv: 'GITHUB_TOKEN_FILE', extra: {} },
  { service: 'reviewer', prefix: 'REVIEW', tokenEnv: 'REVIEW_TOKEN_FILE', extra: { REVIEW_AUTHORS: 'alice' } },
];

for (const { service, prefix, tokenEnv, extra } of SCRIPTS) {
  test(`${service} install, token file: writes what it always has, and asks GitHub nothing`, posixOnly, (t) => {
    const f = fakeBin(t);
    const tokenFile = join(f.home, 'the-token-file');
    writeFileSync(tokenFile, 'x');
    const r = f.run(service, { ...extra, [tokenEnv]: tokenFile });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const plist = readFileSync(f.plist(service), 'utf8');
    assert.ok(plist.includes(`    <key>${tokenEnv}</key><string>${tokenFile}</string>\n`));
    assert.doesNotMatch(plist, /_APP_/);
    assert.doesNotMatch(f.calls(), /github-check/);

    const missing = fakeBin(t);
    const r2 = missing.run(service, { ...extra, [tokenEnv]: join(missing.home, 'nope') });
    assert.equal(r2.status, 1);
    assert.match(r2.stdout, /missing .*token file/);
    assert.ok(!existsSync(missing.plist(service)));
  });

  test(`${service} install, GitHub App: checks first, then writes the app settings and no token file`, posixOnly, (t) => {
    const f = fakeBin(t);
    const key = join(f.home, 'app-key.pem');
    const app = { [`${prefix}_APP_ID`]: '1', [`${prefix}_APP_INSTALLATION_ID`]: '2', [`${prefix}_APP_KEY_FILE`]: key };
    const r = f.run(service, { ...extra, ...app, [tokenEnv]: join(f.home, 'still-set-but-unused') });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = f.calls();
    assert.ok(calls.indexOf('github-check') >= 0 && calls.indexOf('github-check') < calls.indexOf('launchctl'), `checked first:\n${calls}`);
    assert.ok(calls.includes(`key=${key}`), 'the check is given the settings');
    const plist = readFileSync(f.plist(service), 'utf8');
    for (const [k, v] of Object.entries(app)) assert.ok(plist.includes(`    <key>${k}</key><string>${v}</string>\n`), k);
    assert.ok(!plist.includes(tokenEnv), 'the service has no token to fall back on');
  });

  test(`${service} install, GitHub App that fails the check: the running service is not touched`, posixOnly, (t) => {
    const f = fakeBin(t);
    const r = f.run(service, { ...extra, [`${prefix}_APP_ID`]: '1', FAKE_NODE_EXIT: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /did not pass; the running service was not touched/);
    assert.ok(!existsSync(f.plist(service)));
    assert.doesNotMatch(f.calls(), /launchctl/);
  });
}
