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
import { ClaimFile } from '../helper/claims.js';
import { tick } from '../helper/tick.js';

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
        if (!c) return json(404, { message: 'Not Found' });
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

const LEASE = 60_000;

async function setup({ preclaim = true } = {}) {
  const clock = { t: Date.now() };
  const dir = mkdtempSync(join(tmpdir(), 'adabra-'));
  const gh = fakeGitHub();
  const ghPort = await gh.listen();
  const store = new Store(join(dir, 'coord.db'));
  const token = store.addDevice('member-a');
  store.addTask('TASK-1', 1);
  if (preclaim) store.claimTask('TASK-1', 'member-a', 'RUN-1', clock.t, LEASE); // generation 1
  const github = new GitHubClient({ apiUrl: `http://127.0.0.1:${ghPort}`, repo: 'o/r', token: 'gh-test-token', timeoutMs: 2000 });
  const worker = new Worker({ store, github });
  const server = createServer({ store, now: () => clock.t, leaseMs: LEASE });
  const port = await listen(server);
  const outbox = new Outbox(join(dir, 'outbox.db'));
  const ctx = {
    dir, gh, store, worker, server, port, outbox, token, clock,
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

test('rotating a device token invalidates the old one and the new one works', async () => {
  const t = await setup();
  try {
    const post = (token) =>
      fetch(`${t.url}/v1/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-device-id': 'member-a', authorization: `Bearer ${token}` },
        body: JSON.stringify(makeEvent()),
      });
    const fresh = t.store.rotateDevice('member-a');
    assert.equal((await post(t.token)).status, 401);
    assert.equal((await post(fresh)).status, 200);
    assert.throws(() => t.store.rotateDevice('nobody'), /unknown device/);
  } finally {
    await t.teardown();
  }
});

test('a remembered comment id that no longer exists is recovered, not retried forever', async () => {
  const t = await setup();
  try {
    t.store.setTaskComment('TASK-1', 1001); // stale id GitHub has never heard of
    t.outbox.add(makeEvent());
    await t.send();
    await t.worker.tick();
    assert.equal(t.gh.comments.length, 1);
    assert.equal(t.store.counts().done, 1);
    assert.notEqual(t.store.getTask('TASK-1').comment_id, 1001);
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
    t.server = createServer({ store: t.store, now: () => t.clock.t, leaseMs: LEASE });
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

// --- claims -----------------------------------------------------------------
const api = (t, device, token, path, body) =>
  fetch(`${t.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-device-id': device, authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, data: await r.json() }));

async function claimSetup() {
  const t = await setup({ preclaim: false });
  t.tokenB = t.store.addDevice('member-b');
  return t;
}

test('two devices race for one task: exactly one wins', async () => {
  const t = await claimSetup();
  try {
    const [a, b] = await Promise.all([
      api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' }),
      api(t, 'member-b', t.tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    const loser = a.status === 409 ? a : b;
    assert.equal(loser.data.error, 'claimed');
    assert.equal(t.store.getTask('TASK-1').generation, 1);
  } finally {
    await t.teardown();
  }
});

test('asking again as the same owner is idempotent (same generation)', async () => {
  const t = await claimSetup();
  try {
    const first = await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    const again = await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    assert.equal(again.status, 200);
    assert.equal(again.data.generation, first.data.generation);
  } finally {
    await t.teardown();
  }
});

test('events need the current claim: none, wrong run, and wrong device are all fenced', async () => {
  const t = await claimSetup();
  try {
    const ev = (over) => makeEvent({ claim_generation: 1, run_id: 'RUN-A', ...over });
    const send = (e, dev = 'member-a', tok = t.token) => api(t, dev, tok, '/v1/events', e);
    assert.equal((await send(ev())).status, 409); // nobody holds the task yet
    await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    assert.equal((await send(ev({ run_id: 'RUN-OTHER' }))).status, 409);
    assert.equal((await send(ev({ claim_generation: 2 }))).status, 409);
    assert.equal((await send(ev({ device_id: 'member-b' }), 'member-b', t.tokenB)).status, 409);
    assert.equal((await send(ev())).status, 200);
    assert.equal(t.store.db.prepare('SELECT COUNT(*) n FROM events').get().n, 1);
  } finally {
    await t.teardown();
  }
});

test('renewal extends the lease and blocks takeover until it lapses', async () => {
  const t = await claimSetup();
  try {
    await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    t.clock.t += LEASE - 1000;
    const renewed = await api(t, 'member-a', t.token, '/v1/claims/renew', { task_id: 'TASK-1', run_id: 'RUN-A', generation: 1 });
    assert.equal(renewed.status, 200);
    t.clock.t += LEASE - 1000; // past the ORIGINAL expiry, inside the renewed lease
    const early = await api(t, 'member-b', t.tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' });
    assert.equal(early.status, 409);
  } finally {
    await t.teardown();
  }
});

test('expired lease: another device takes over, and the old owner is fenced everywhere', async () => {
  const t = await claimSetup();
  try {
    await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    t.clock.t += LEASE + 1;
    const takeover = await api(t, 'member-b', t.tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' });
    assert.equal(takeover.status, 200);
    assert.equal(takeover.data.generation, 2);

    // the old owner comes back from sleep with generation 1
    const staleEvent = await api(t, 'member-a', t.token, '/v1/events', makeEvent({ claim_generation: 1, run_id: 'RUN-A' }));
    assert.equal(staleEvent.status, 409);
    const staleRenew = await api(t, 'member-a', t.token, '/v1/claims/renew', { task_id: 'TASK-1', run_id: 'RUN-A', generation: 1 });
    assert.equal(staleRenew.status, 409);
    assert.equal(staleRenew.data.error, 'superseded');
    const staleRelease = await api(t, 'member-a', t.token, '/v1/claims/release', { task_id: 'TASK-1', run_id: 'RUN-A', generation: 1 });
    assert.equal(staleRelease.status, 409);

    const fresh = await api(t, 'member-b', t.tokenB, '/v1/events', makeEvent({ device_id: 'member-b', claim_generation: 2, run_id: 'RUN-B' }));
    assert.equal(fresh.status, 200);
  } finally {
    await t.teardown();
  }
});

test('an expired lease cannot be renewed; the owner must claim again (new generation)', async () => {
  const t = await claimSetup();
  try {
    await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    t.clock.t += LEASE + 1;
    const renew = await api(t, 'member-a', t.token, '/v1/claims/renew', { task_id: 'TASK-1', run_id: 'RUN-A', generation: 1 });
    assert.equal(renew.status, 409);
    assert.equal(renew.data.error, 'expired');
    const reclaim = await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    assert.equal(reclaim.data.generation, 2);
  } finally {
    await t.teardown();
  }
});

test('release frees the task for someone else and fences the releasing owner', async () => {
  const t = await claimSetup();
  try {
    await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    const rel = await api(t, 'member-a', t.token, '/v1/claims/release', { task_id: 'TASK-1', run_id: 'RUN-A', generation: 1 });
    assert.equal(rel.status, 200);
    const b = await api(t, 'member-b', t.tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' });
    assert.equal(b.status, 200);
    assert.equal(b.data.generation, 2);
    const old = await api(t, 'member-a', t.token, '/v1/events', makeEvent({ claim_generation: 1, run_id: 'RUN-A' }));
    assert.equal(old.status, 409);
  } finally {
    await t.teardown();
  }
});

test('operator cancel fences the current owner immediately', async () => {
  const t = await claimSetup();
  try {
    await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    t.store.cancelClaim('TASK-1');
    const ev = await api(t, 'member-a', t.token, '/v1/events', makeEvent({ claim_generation: 1, run_id: 'RUN-A' }));
    assert.equal(ev.status, 409);
    const renew = await api(t, 'member-a', t.token, '/v1/claims/renew', { task_id: 'TASK-1', run_id: 'RUN-A', generation: 1 });
    assert.equal(renew.status, 409);
    const b = await api(t, 'member-b', t.tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' });
    assert.equal(b.data.generation, 3);
  } finally {
    await t.teardown();
  }
});

test('claim requests: unknown task, bad body and bad credentials are refused', async () => {
  const t = await claimSetup();
  try {
    assert.equal((await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-99', run_id: 'RUN-A' })).status, 422);
    assert.equal((await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'nope', run_id: 'RUN-A' })).status, 400);
    assert.equal((await api(t, 'member-a', t.token, '/v1/claims/renew', { task_id: 'TASK-1', run_id: 'RUN-A' })).status, 400);
    assert.equal((await api(t, 'member-a', 'wrong', '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' })).status, 401);
  } finally {
    await t.teardown();
  }
});

// --- background agent (one pass = tick) -------------------------------------
async function agentSetup() {
  const t = await claimSetup();
  const claims = new ClaimFile(t.dir);
  const cfg = { coordinator_url: t.url, device_id: 'member-a', token: t.token };
  const notices = [];
  const pass = (over = {}) =>
    tick({ claims, outbox: t.outbox, cfg, now: t.clock.t, notify: (title, msg) => notices.push(`${title}: ${msg}`), ...over });
  const claim = async () => {
    const r = await api(t, 'member-a', t.token, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-A' });
    claims.set('TASK-1', { run_id: 'RUN-A', generation: r.data.generation, expires_at: r.data.expires_at });
  };
  return { t, claims, cfg, notices, pass, claim };
}

test('agent pass renews held leases and delivers queued checkpoints', async () => {
  const { t, claims, pass, claim } = await agentSetup();
  try {
    await claim();
    t.outbox.add(makeEvent({ run_id: 'RUN-A', claim_generation: 1 }));
    t.clock.t += LEASE - 1000;
    const r = await pass();
    assert.deepEqual(r.renewed, ['TASK-1']);
    assert.equal(r.sent.acked, 1);
    assert.ok(claims.get('TASK-1').expires_at > t.clock.t + LEASE - 2000, 'expiry moved forward');
    t.clock.t += LEASE - 1000; // beyond the original lease: still ours only because the agent renewed
    const early = await api(t, 'member-b', t.tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' });
    assert.equal(early.status, 409);
  } finally {
    await t.teardown();
  }
});

test('agent pass drops a claim the coordinator no longer honours and says so', async () => {
  const { t, claims, notices, pass, claim } = await agentSetup();
  try {
    await claim();
    t.clock.t += LEASE + 1; // lease lapses with no renewal
    await api(t, 'member-b', t.tokenB, '/v1/claims', { task_id: 'TASK-1', run_id: 'RUN-B' }); // someone else takes over
    const r = await pass();
    assert.equal(r.lost.length, 1);
    assert.equal(claims.get('TASK-1'), null);
    assert.match(notices[0], /Lost TASK-1/);
  } finally {
    await t.teardown();
  }
});

test('agent keeps a claim through a coordinator outage until the lease would have lapsed', async () => {
  const { t, claims, notices, pass, claim } = await agentSetup();
  try {
    await claim();
    await close(t.server);
    t.clock.t += 10_000;
    const during = await pass();
    assert.deepEqual(during.retrying, ['TASK-1']);
    assert.ok(claims.get('TASK-1'));
    t.clock.t += LEASE; // past the local expiry
    const after = await pass();
    assert.equal(after.lost.length, 1);
    assert.equal(claims.get('TASK-1'), null);
    assert.match(notices[0], /unreachable/);
    t.server = createServer({ store: t.store, now: () => t.clock.t, leaseMs: LEASE }); // so teardown has something to close
  } finally {
    await t.teardown();
  }
});

test('agent does not drop a claim because of a bad token (401 is a setup problem, not a lost claim)', async () => {
  const { t, claims, cfg, claim, pass } = await agentSetup();
  try {
    await claim();
    cfg.token = 'wrong';
    const r = await pass();
    assert.deepEqual(r.retrying, ['TASK-1']);
    assert.ok(claims.get('TASK-1'));
  } finally {
    await t.teardown();
  }
});
