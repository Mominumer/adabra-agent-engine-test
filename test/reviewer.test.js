import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewStore, MAX_ATTEMPTS } from '../reviewer/store.js';
import { ReviewGitHub, REVIEW_MARKER } from '../reviewer/github.js';
import { Dispatcher, notConfigured, CONTEXTS } from '../reviewer/dispatcher.js';

// --- fake GitHub: pulls, commit statuses, issue comments ----------------------
function fakeGitHub() {
  const pulls = []; // raw GitHub shape
  const statuses = []; // {sha, context, state, description}
  const comments = []; // {id, issue, body}
  let nextId = 1;
  let failing = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (code, obj) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
      if (failing) return json(503, { message: 'down' });
      if (req.headers.authorization !== 'Bearer review-token') return json(401, {});
      let m;
      if (req.method === 'GET' && req.url.startsWith('/repos/o/r/pulls?')) return json(200, pulls);
      if ((m = req.url.match(/^\/repos\/o\/r\/statuses\/([0-9a-f]+)$/)) && req.method === 'POST') {
        statuses.push({ sha: m[1], ...JSON.parse(raw) });
        return json(201, {});
      }
      if ((m = req.url.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments/))) {
        if (req.method === 'GET') return json(200, comments.filter((c) => c.issue === +m[1]));
        const c = { id: nextId++, issue: +m[1], body: JSON.parse(raw).body };
        comments.push(c);
        return json(201, c);
      }
      if ((m = req.url.match(/^\/repos\/o\/r\/issues\/comments\/(\d+)$/)) && req.method === 'PATCH') {
        const c = comments.find((x) => x.id === +m[1]);
        if (!c) return json(404, { message: 'Not Found' });
        c.body = JSON.parse(raw).body;
        return json(200, c);
      }
      return json(404, {});
    });
  });
  return {
    pulls, statuses, comments,
    setFailing: (v) => (failing = v),
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))),
  };
}

const sha = (n) => String(n).repeat(40).slice(0, 40);
const pull = (number, s, over = {}) => ({
  number, title: `PR ${number}`, body: '', draft: false,
  user: { login: 'alice' },
  head: { sha: s, ref: `task/TASK-${number}`, repo: { full_name: 'o/r' } },
  ...over,
});
const ok = (summary = 'ok') => async () => ({ state: 'success', summary });

async function setup({ runTests = ok('2 passed'), runReview = ok('no findings') } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-review-'));
  const gh = fakeGitHub();
  const port = await gh.listen();
  const store = new ReviewStore(join(dir, 'reviewer.db'));
  const clock = { t: 1_000_000 };
  const github = new ReviewGitHub({ apiUrl: `http://127.0.0.1:${port}`, repo: 'o/r', token: 'review-token', timeoutMs: 2000 });
  const logs = [];
  const d = new Dispatcher({
    store, github, repo: 'o/r', authors: ['alice'], runTests, runReview, now: () => clock.t, log: (m) => logs.push(m),
  });
  return {
    gh, store, clock, d, logs,
    final: (s) => gh.statuses.filter((x) => x.sha === s && x.state !== 'pending'),
    async teardown() {
      store.close();
      await gh.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('poll queues each new head commit once and marks both checks pending', async () => {
  const t = await setup();
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    assert.equal(await t.d.poll(), 1);
    assert.equal(await t.d.poll(), 0, 'same commit is not queued again');
    assert.deepEqual(t.gh.statuses.map((s) => [s.context, s.state]), [[CONTEXTS.tests, 'pending'], [CONTEXTS.review, 'pending']]);
  } finally {
    await t.teardown();
  }
});

test('drafts, forks and authors not on the allowlist never run on the mini', async () => {
  const t = await setup();
  try {
    t.gh.pulls.push(
      pull(1, sha(1), { draft: true }),
      pull(2, sha(2), { head: { sha: sha(2), ref: 'x', repo: { full_name: 'evil/r' } } }),
      pull(3, sha(3), { head: { sha: sha(3), ref: 'x', repo: null } }),
      pull(4, sha(4), { user: { login: 'mallory' } }),
    );
    assert.equal(await t.d.poll(), 0);
    await t.d.poll();
    assert.equal(t.gh.statuses.length, 0);
    assert.equal(await t.d.runOnce(), null);
    assert.equal(t.logs.filter((l) => l.includes('skipped')).length, 4, 'each skip is logged once');
  } finally {
    await t.teardown();
  }
});

test('a reviewed commit gets final statuses and one PR comment; a new push is checked again and edits the same comment', async () => {
  const t = await setup();
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    await t.d.poll();
    assert.deepEqual(await t.d.runOnce(), { pr: 5, sha: sha(1), tests: 'success', review: 'success' });
    assert.deepEqual(t.final(sha(1)).map((s) => s.state), ['success', 'success']);
    assert.equal(t.gh.comments.length, 1);
    assert.ok(t.gh.comments[0].body.startsWith(REVIEW_MARKER));

    t.gh.pulls[0].head.sha = sha(2); // new push
    assert.equal(await t.d.poll(), 1);
    await t.d.runOnce();
    assert.equal(t.final(sha(2)).length, 2);
    assert.equal(t.gh.comments.length, 1, 'still one comment');
    assert.match(t.gh.comments[0].body, new RegExp(sha(2).slice(0, 12)));
  } finally {
    await t.teardown();
  }
});

test('a newer push supersedes a queued older commit, which is never run', async () => {
  let runs = 0;
  const t = await setup({ runTests: async () => (runs++, { state: 'success', summary: 'ok' }) });
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    await t.d.poll();
    t.gh.pulls[0].head.sha = sha(2);
    await t.d.poll();
    const r = await t.d.runOnce();
    assert.equal(r.sha, sha(2));
    assert.equal(await t.d.runOnce(), null);
    assert.equal(runs, 1);
    assert.equal(t.store.getJob(5, sha(1)).state, 'superseded');
  } finally {
    await t.teardown();
  }
});

test('failures are reported as failures; missing or malformed results count as errors, never success', async () => {
  const t = await setup({
    runTests: async () => ({ state: 'failure', summary: '1 failed', log: 'AssertionError: expected 2' }),
    runReview: async () => ({ verdict: 'looks fine' }), // wrong shape
  });
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    await t.d.poll();
    await t.d.runOnce();
    const s = Object.fromEntries(t.final(sha(1)).map((x) => [x.context, x.state]));
    assert.deepEqual(s, { [CONTEXTS.tests]: 'failure', [CONTEXTS.review]: 'error' });
    assert.match(t.gh.comments[0].body, /AssertionError/);
  } finally {
    await t.teardown();
  }
});

test('phase 1 placeholder runners block the PR with errors', async () => {
  const t = await setup({ runTests: notConfigured('test'), runReview: notConfigured('review') });
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    await t.d.poll();
    await t.d.runOnce();
    assert.deepEqual(t.final(sha(1)).map((s) => s.state), ['error', 'error']);
  } finally {
    await t.teardown();
  }
});

test('a runner crash (e.g. Docker down) shows an error, retries with backoff, and gives up after the limit', async () => {
  let fail = true;
  const t = await setup({ runTests: async () => { if (fail) throw new Error('docker: connection refused'); return { state: 'success', summary: 'ok' }; } });
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    await t.d.poll();
    const r = await t.d.runOnce();
    assert.equal(r.retry, true);
    assert.ok(t.final(sha(1)).every((s) => s.state === 'error'));
    assert.equal(await t.d.runOnce(), null, 'waits for the backoff');
    t.clock.t += 60_000;
    fail = false;
    assert.equal((await t.d.runOnce()).tests, 'success');

    // a different commit that keeps failing
    fail = true;
    t.gh.pulls[0].head.sha = sha(2);
    await t.d.poll();
    let last;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      t.clock.t += 1_000_000;
      last = await t.d.runOnce();
    }
    assert.equal(last.failed, true);
    assert.equal(t.store.getJob(5, sha(2)).state, 'failed');
    assert.match(t.gh.statuses.at(-1).description, /operator/);
    assert.equal(t.store.retry(5), true);
    assert.equal(t.store.getJob(5, sha(2)).state, 'queued');
  } finally {
    await t.teardown();
  }
});

test('GitHub down while posting results: the job is retried, not lost or marked done', async () => {
  const t = await setup();
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    await t.d.poll();
    t.gh.setFailing(true);
    assert.equal((await t.d.runOnce()).retry, true);
    assert.equal(t.store.getJob(5, sha(1)).state, 'queued');
    t.gh.setFailing(false);
    t.clock.t += 60_000;
    assert.equal((await t.d.runOnce()).tests, 'success');
    assert.equal(t.final(sha(1)).length, 2);
  } finally {
    await t.teardown();
  }
});

test('a job interrupted by a restart is run again', async () => {
  const t = await setup();
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    await t.d.poll();
    t.store.markRunning(5, sha(1)); // crashed mid-job
    assert.equal(await t.d.runOnce(), null);
    assert.equal(t.store.requeueInterrupted(), 1);
    assert.equal((await t.d.runOnce()).tests, 'success');
  } finally {
    await t.teardown();
  }
});

test('a deleted review comment is recreated once, not duplicated', async () => {
  const t = await setup();
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    await t.d.poll();
    await t.d.runOnce();
    t.gh.comments.length = 0; // someone deleted it
    t.gh.pulls[0].head.sha = sha(2);
    await t.d.poll();
    await t.d.runOnce();
    assert.equal(t.gh.comments.length, 1);
    t.store.setCommentId(5, null); // forgot the id, comment still exists
    t.gh.pulls[0].head.sha = sha(3);
    await t.d.poll();
    await t.d.runOnce();
    assert.equal(t.gh.comments.length, 1, 'found again by its marker');
  } finally {
    await t.teardown();
  }
});

test('untrusted text cannot ping people or break out of the log block', async () => {
  const t = await setup({
    runTests: async () => ({ state: 'failure', summary: 'ping @everyone', log: 'x\n```\n## injected heading\n@octocat' }),
    runReview: async () => ({ state: 'failure', summary: 'bad', findings: [{ file: 'a.js', line: 3, severity: 'blocker', message: 'hi @admin' }] }),
  });
  try {
    t.gh.pulls.push(pull(5, sha(1)));
    await t.d.poll();
    await t.d.runOnce();
    const body = t.gh.comments[0].body;
    assert.doesNotMatch(body, /(^|[^​])@(everyone|octocat|admin)/);
    assert.equal(body.split('```').length - 1, 4, 'only our own fences open and close the findings and the log');
  } finally {
    await t.teardown();
  }
});
