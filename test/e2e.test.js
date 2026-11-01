import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../coordinator/store.js';
import { createServer } from '../coordinator/server.js';
import { Worker } from '../coordinator/worker.js';
import { GitHubClient } from '../coordinator/github.js';
import { Outbox } from '../helper/outbox.js';
import { flush } from '../helper/sender.js';

// --- fake GitHub: issue comments only ---------------------------------------
function fakeGitHub() {
  const comments = []; // {id, issue, body}
  let nextId = 1;
  let failing = false;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const json = (code, obj) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(obj)));
      if (failing) return json(503, { message: 'down' });
      if (req.headers.authorization !== 'Bearer gh-test-token') return json(401, {});
      let m;
      if ((m = req.url.match(/^\/repos\/o\/r\/issues\/(\d+)\/comments/))) {
        if (req.method === 'GET') return json(200, comments.filter((c) => c.issue === +m[1]));
        if (req.method === 'POST') {
          const c = { id: nextId++, issue: +m[1], body: JSON.parse(raw).body };
          comments.push(c);
          return json(201, c);
        }
      }
      if ((m = req.url.match(/^\/repos\/o\/r\/issues\/comments\/(\d+)$/)) && req.method === 'PATCH') {
        const c = comments.find((x) => x.id === +m[1]);
        c.body = JSON.parse(raw).body;
        return json(200, c);
      }
      return json(404, {});
    });
  });
  return {
    comments,
    setFailing: (v) => (failing = v),
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise((r) => server.close(r)),
  };
}

const listen = (server, port = 0) =>
  new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port)));
const close = (server) => new Promise((r) => (server.closeAllConnections?.(), server.close(r)));

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-'));
  const gh = fakeGitHub();
  const ghPort = await gh.listen();
  const store = new Store(join(dir, 'coord.db'));
  const token = store.addDevice('member-a');
  store.addTask('TASK-1', 1);
  const github = new GitHubClient({ apiUrl: `http://127.0.0.1:${ghPort}`, repo: 'o/r', token: 'gh-test-token', timeoutMs: 2000 });
  const worker = new Worker({ store, github });
  const server = createServer({ store });
  const port = await listen(server);
  const outbox = new Outbox(join(dir, 'outbox.db'));
  const ctx = {
    dir, gh, store, worker, server, port, outbox, token,
    url: `http://127.0.0.1:${port}`,
    send: (opts = {}) => flush({ outbox, url: ctx.url, deviceId: 'member-a', token, ...opts }),
    async teardown() {
      outbox.close();
      await close(ctx.server);
      store.close();
      await gh.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return ctx;
}

const makeEvent = (over = {}) => ({
  event_id: randomUUID(),
  task_id: 'TASK-1',
  run_id: 'RUN-1',
  device_id: 'member-a',
  claim_generation: 1,
  type: 'checkpoint',
  source_commit: 'a'.repeat(40),
  unpushed_commits: 0,
  summary: 'Payment screen implemented',
  verification: '8 passed, 1 failed',
  status: 'Building',
  next_action: 'Fix failed payment handling',
  ts: new Date().toISOString(),
  ...over,
});

test('normal path: one checkpoint becomes exactly one GitHub comment', async () => {
  const t = await setup();
  try {
    const e = makeEvent();
    t.outbox.add(e);
    assert.deepEqual(await t.send(), { acked: 1, rejected: 0, retry: 0 });
    await t.worker.tick();
    assert.equal(t.gh.comments.length, 1);
    assert.match(t.gh.comments[0].body, /TASK-1: Building/);
    assert.match(t.gh.comments[0].body, /Payment screen implemented/);
    assert.equal(t.store.counts().done, 1);
  } finally {
    await t.teardown();
  }
});

test('duplicate event (same id sent twice) updates GitHub once', async () => {
  const t = await setup();
  try {
    const e = makeEvent();
    t.outbox.add(e);
    await t.send();
    // simulate a lost ack: the helper sends the very same event again
    const r = await fetch(`${t.url}/v1/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-device-id': 'member-a', authorization: `Bearer ${t.token}` },
      body: JSON.stringify(e),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).status, 'duplicate');
    await t.worker.tick();
    await t.worker.tick();
    assert.equal(t.gh.comments.length, 1);
    assert.equal(t.store.counts().done, 1);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  } finally {
    await t.teardown();
  }
});

test('same event id with a different payload is refused (409)', async () => {
  const t = await setup();
  try {
    const e = makeEvent();
    const post = (body) =>
      fetch(`${t.url}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device-id': 'member-a', authorization: `Bearer ${t.token}` },
        body: JSON.stringify(body),
      });
    assert.equal((await post(e)).status, 200);
    assert.equal((await post({ ...e, summary: 'tampered' })).status, 409);
  } finally {
    await t.teardown();
  }
});

test('unknown device and wrong token are refused; nothing is stored', async () => {
  const t = await setup();
  try {
    const e = makeEvent({ device_id: 'intruder' });
    const post = (headers) =>
      fetch(`${t.url}/v1/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(e) });
    assert.equal((await post({ 'x-device-id': 'intruder', authorization: `Bearer ${t.token}` })).status, 401);
    assert.equal((await post({ 'x-device-id': 'member-a', authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post({})).status, 401);
    t.store.revokeDevice('member-a');
    assert.equal((await post({ 'x-device-id': 'member-a', authorization: `Bearer ${t.token}` })).status, 401);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  } finally {
    await t.teardown();
  }
});

test('a device cannot report as another device; bad schema and unknown task are refused', async () => {
  const t = await setup();
  try {
    t.store.addDevice('member-b');
    const post = (body) =>
      fetch(`${t.url}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device-id': 'member-a', authorization: `Bearer ${t.token}` },
        body: JSON.stringify(body),
      });
    assert.equal((await post(makeEvent({ device_id: 'member-b' }))).status, 403);
    assert.equal((await post(makeEvent({ status: 'Done!!' }))).status, 400);
    assert.equal((await post({ ...makeEvent(), extra: 1 })).status, 400);
    assert.equal((await post(makeEvent({ task_id: 'TASK-99' }))).status, 422);
  } finally {
    await t.teardown();
  }
});

test('coordinator unreachable: event stays in the outbox and is delivered later', async () => {
  const t = await setup();
  try {
    const e = makeEvent();
    t.outbox.add(e);
    await close(t.server); // coordinator goes away
    const r1 = await t.send({ timeoutMs: 500 });
    assert.equal(r1.retry, 1);
    assert.equal(t.outbox.counts().pending, 1);

    // back up on the same port, later than the backoff window
    t.server = createServer({ store: t.store });
    await listen(t.server, t.port);
    const r2 = await t.send({ now: Date.now() + 10_000 });
    assert.equal(r2.acked, 1);
    assert.equal(t.outbox.counts().acked, 1);
    await t.worker.tick();
    assert.equal(t.gh.comments.length, 1);
  } finally {
    await t.teardown();
  }
});

test('GitHub down: the coordinator already stored the event, retries, then applies once', async () => {
  const t = await setup();
  try {
    t.outbox.add(makeEvent());
    t.gh.setFailing(true);
    await t.send(); // acknowledged: stored durably even though GitHub is down
    assert.equal(t.outbox.counts().acked, 1);
    await t.worker.tick();
    assert.equal(t.store.counts().pending, 1);
    assert.equal(t.gh.comments.length, 0);

    t.gh.setFailing(false);
    await t.worker.tick(Date.now() + 60_000);
    assert.equal(t.gh.comments.length, 1);
    assert.equal(t.store.counts().done, 1);
  } finally {
    await t.teardown();
  }
});

test('later checkpoints edit the same comment; an older event never regresses it', async () => {
  const t = await setup();
  try {
    const t0 = Date.now();
    const first = makeEvent({ summary: 'first', ts: new Date(t0).toISOString() });
    const second = makeEvent({ summary: 'second', status: 'In review', ts: new Date(t0 + 5000).toISOString() });
    const stale = makeEvent({ summary: 'stale', ts: new Date(t0 + 1000).toISOString() });
    t.outbox.add(first);
    t.outbox.add(second);
    await t.send();
    await t.worker.tick();
    assert.equal(t.gh.comments.length, 1);
    assert.match(t.gh.comments[0].body, /second/);

    t.outbox.add(stale); // arrives late
    await t.send();
    await t.worker.tick();
    assert.equal(t.gh.comments.length, 1);
    assert.match(t.gh.comments[0].body, /second/);
    assert.doesNotMatch(t.gh.comments[0].body, /stale/);
  } finally {
    await t.teardown();
  }
});
