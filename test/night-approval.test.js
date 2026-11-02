import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { StaticToken } from '../shared/github-auth.js';
import {
  APPROVAL_LABEL, MAX_AGE_MS, MAX_CLOCK_SKEW_MS, MAX_PAGES, REASONS, TASK_LABEL,
  approvalSettings, beginAttempt, checkApproval, formatReport, issueOfTask, recheckApproval, selectApproval, textHash,
} from '../night/approval.js';
import { checkApprovalCommand } from '../night/check-approval.js';
import { MAX_REPLY_BYTES, ghReader, parseGhReply, tokenReader } from '../night/github-read.js';
import { Ledger, LedgerError, UNREADABLE_LEDGER } from '../night/ledger.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'owner/repo';
const APPROVER = 1001;
const SECOND_AUTHOR = 1002;
const WRITER = 1003; // has write access to the repository, and may not approve
const STRANGER = 1004;
const APPROVED_ID = 'LA_approved';
const TASK_ID = 'LA_task';
const OTHER_ID = 'LA_other';
const NOW = Date.parse('2026-11-02T21:00:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

const ENV = {
  GITHUB_REPO: REPO,
  NIGHT_APPROVER_ID: String(APPROVER),
  NIGHT_AUTHOR_IDS: `${APPROVER}, ${SECOND_AUTHOR}`,
  NIGHT_APPROVAL_LABEL_ID: APPROVED_ID,
};
const SETTINGS = approvalSettings(ENV);

const person = (id, type = 'User') => ({ login: `user${id}`, id, node_id: `U_${id}`, type, site_admin: false });

// One made-up issue, from which the REST and GraphQL replies are both built, so they agree unless a test makes them differ. The
// shapes copy GitHub's real replies for an issue in this repository, cut down to fields that matter or that show their form.
function newWorld() {
  const w = {
    now: NOW,
    issue: {
      id: 5001, node_id: 'I_5001', number: 21, state: 'open', title: 'a title', body: 'a body', user: person(APPROVER),
      repository_url: `https://api.github.com/repos/${REPO}`, performed_via_github_app: null, comments: 3, locked: false,
    },
    labels: {
      [TASK_ID]: { id: TASK_ID, name: TASK_LABEL, updatedAt: iso(NOW - 30 * DAY) },
      [APPROVED_ID]: { id: APPROVED_ID, name: APPROVAL_LABEL, updatedAt: iso(NOW - 30 * DAY) },
      [OTHER_ID]: { id: OTHER_ID, name: 'other', updatedAt: iso(NOW - 30 * DAY) },
    },
    onIssue: [TASK_ID, APPROVED_ID],
    lastEditedAt: null,
    edits: [],
    events: [],
    nextEventId: 34935428000,
    calls: [],
  };
  addEvent(w, 'labeled', TASK_ID, { at: NOW - 3 * HOUR });
  addEvent(w, 'labeled', APPROVED_ID, { at: NOW - HOUR });
  return w;
}

function addEvent(w, event, labelId, { at, actor = person(APPROVER), via = null, restName } = {}) {
  const id = w.nextEventId++;
  const row = {
    id, node_id: `LE_${id}`, url: `https://api.github.com/repos/${REPO}/issues/events/${id}`, actor, event, commit_id: null, commit_url: null,
    created_at: iso(at), performed_via_github_app: via, intent: null,
  };
  if (labelId) {
    row.labelId = labelId;
    row.label = { name: restName ?? w.labels[labelId].name, color: 'ededed' };
  }
  w.events.push(row);
  return row;
}

const addRename = (w, at) => {
  const row = addEvent(w, 'renamed', null, { at });
  row.rename = { from: 'old', to: 'new' };
  return row;
};
const addFiller = (w, count, at = NOW - 2 * HOUR) => {
  for (let i = 0; i < count; i++) addEvent(w, 'mentioned', null, { at });
};
// The approval event itself: the last label event for the approval label.
const approvalEvent = (w) => w.events.findLast((e) => e.labelId === APPROVED_ID);

const TIMELINE_TYPES = { labeled: 'LabeledEvent', unlabeled: 'UnlabeledEvent', renamed: 'RenamedTitleEvent' };

function timelineNode(w, e) {
  const node = { __typename: TIMELINE_TYPES[e.event], id: e.node_id, createdAt: e.created_at };
  if (e.event === 'labeled') {
    node.actor = e.actor ? { __typename: e.actor.type, ...(e.actor.type === 'User' ? { databaseId: e.actor.id } : {}) } : null;
    node.label = { ...w.labels[e.labelId] };
  } else if (e.event === 'unlabeled') {
    const { id, name } = w.labels[e.labelId];
    node.label = { id, name };
  }
  return node;
}

function fakeGitHub(w) {
  const reply = (kind, page, value, link = null) => {
    const r = { status: 200, headers: { date: w.serverDate === undefined ? new Date(w.now).toUTCString() : w.serverDate, link }, text: JSON.stringify(value) };
    return w.reply?.(kind, page, r) ?? r;
  };
  const get = async (path) => {
    w.calls.push({ method: 'GET', path });
    const issuePath = `/repos/${REPO}/issues/21`;
    if (path === issuePath) {
      const issue = structuredClone(w.issue);
      issue.labels = w.onIssue.map((id) => ({ id: 77, node_id: id, url: 'x', name: w.labels[id].name, color: 'ededed', default: false, description: null }));
      w.tweakRest?.(issue);
      return reply('issue', 1, issue);
    }
    const m = /^\/repos\/owner\/repo\/issues\/21\/events\?per_page=100&page=(\d+)$/.exec(path);
    if (!m) throw new Error(`the fake was asked for ${path}`);
    const page = Number(m[1]);
    const rows = w.events.slice((page - 1) * 100, page * 100).map(({ labelId, ...rest }) => structuredClone(rest));
    const more = w.events.length > page * 100;
    w.tweakEvents?.(rows, page);
    return reply('events', page, rows, more ? `<https://api.github.com/repositories/1/issues/21/events?per_page=100&page=${page + 1}>; rel="next", <https://api.github.com/repositories/1/issues/21/events?per_page=100&page=99>; rel="last"` : null);
  };
  const graphql = async (query, variables) => {
    w.calls.push({ method: 'POST', query, variables });
    const repository = { nameWithOwner: REPO };
    if (query.includes('timelineItems')) {
      const rows = w.events.filter((e) => TIMELINE_TYPES[e.event]);
      const start = variables.after ? Number(variables.after) : 0;
      const end = start + 100;
      const timelineItems = {
        totalCount: rows.length,
        pageInfo: { hasNextPage: end < rows.length, endCursor: String(end) },
        nodes: rows.slice(start, end).map((e) => timelineNode(w, e)),
      };
      w.tweakTimeline?.(timelineItems, start);
      repository.issue = { timelineItems };
      const out = { data: { repository } };
      w.tweakGqlTop?.(out, 'timeline');
      return reply('timeline', start, out);
    }
    repository.issue = {
      id: w.issue.node_id, databaseId: w.issue.id, number: w.issue.number, state: w.issue.state.toUpperCase(), title: w.issue.title, body: w.issue.body ?? '',
      lastEditedAt: w.lastEditedAt,
      author: { __typename: w.issue.user.type, ...(w.issue.user.type === 'User' ? { databaseId: w.issue.user.id } : {}) },
      labels: { totalCount: w.onIssue.length, pageInfo: { hasNextPage: false }, nodes: w.onIssue.map((id) => ({ id, name: w.labels[id].name })) },
      userContentEdits: { totalCount: w.edits.length, pageInfo: { hasNextPage: false }, nodes: w.edits.map((editedAt) => ({ editedAt })) },
    };
    w.tweakGql?.(repository.issue, repository);
    const out = { data: { repository } };
    w.tweakGqlTop?.(out, 'issue');
    return reply('gql', 1, out);
  };
  return { get, graphql };
}

const noLedger = { get: () => null };
const run = (w, over = {}) => checkApproval({ github: fakeGitHub(w), settings: SETTINGS, number: 21, ledger: noLedger, clock: () => w.now, ...over });

function assertRefused(report, reason) {
  assert.equal(report.approved, false);
  assert.ok(report.reasons.includes(reason), `wanted ${reason}, got ${report.reasons.join(', ')}`);
  for (const r of report.reasons) assert.ok(REASONS.includes(r), `${r} is not on the closed list`);
  assert.doesNotMatch(report.reasons.join(','), /internal_error/);
}

function assertApproved(report) {
  assert.deepEqual(report.reasons, []);
  assert.equal(report.approved, true);
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-night-approval-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- what passes ------------------------------------------------------------

test('an approval by the approver passes, and the report holds only IDs, times and a hash', async () => {
  const w = newWorld();
  const report = await run(w);
  assertApproved(report);
  assert.deepEqual({ ...report, reasons: [...report.reasons] }, {
    approved: true,
    reasons: [],
    task: 'TASK-21',
    issue: 21,
    eventId: approvalEvent(w).id,
    actorId: APPROVER,
    labeledAt: approvalEvent(w).created_at,
    textSha256: textHash('a title', 'a body'),
  });
});

test('passes: the second allowed author', async () => {
  const w = newWorld();
  w.issue.user = person(SECOND_AUTHOR);
  assertApproved(await run(w));
});

test('passes: an edit and a rename before the approval', async () => {
  const w = newWorld();
  w.events.pop();
  addRename(w, NOW - 2 * HOUR);
  const at = NOW - HOUR;
  addEvent(w, 'labeled', APPROVED_ID, { at });
  w.lastEditedAt = iso(at - SECOND);
  w.edits = [iso(at - SECOND), iso(at - HOUR)];
  assertApproved(await run(w));
});

test('passes: removed, then added again by the approver, and the new event is the approval', async () => {
  const w = newWorld();
  const first = approvalEvent(w).id;
  addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - 30 * MINUTE });
  const second = addEvent(w, 'labeled', APPROVED_ID, { at: NOW - 20 * MINUTE });
  const report = await run(w);
  assertApproved(report);
  assert.equal(report.eventId, second.id);
  assert.notEqual(report.eventId, first);
});

test('passes: a null body hashes as empty text, as GraphQL shows it', async () => {
  const w = newWorld();
  w.issue.body = null;
  const report = await run(w);
  assertApproved(report);
  assert.equal(report.textSha256, textHash('a title', ''));
});

test('passes: just inside the 7 days', async () => {
  const w = newWorld();
  approvalEvent(w).created_at = iso(NOW - MAX_AGE_MS + SECOND);
  w.events[0].created_at = iso(NOW - MAX_AGE_MS - HOUR);
  w.labels[APPROVED_ID].updatedAt = iso(NOW - 30 * DAY);
  assertApproved(await run(w));
});

// --- every rule, one at a time ----------------------------------------------

const atEvent = (w) => Date.parse(approvalEvent(w).created_at);
const REFUSALS = [
  ['a closed issue', (w) => { w.issue.state = 'closed'; }, 'not_open'],
  ['a pull request', (w) => { w.tweakRest = (i) => { i.pull_request = { url: 'x' }; }; }, 'is_pull_request'],
  ['no agent-task label', (w) => { w.onIssue = [APPROVED_ID]; }, 'task_label_missing'],
  ['no approval label on the issue, whatever the events say', (w) => { w.onIssue = [TASK_ID]; }, 'approval_label_missing'],
  ['no event for the label', (w) => { w.events = [w.events[0]]; }, 'no_approval_event'],
  ['label removed', (w) => { addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - MINUTE }); }, 'label_removed'],
  ['removed, then added back by someone else', (w) => {
    addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - 2 * MINUTE });
    addEvent(w, 'labeled', APPROVED_ID, { at: NOW - MINUTE, actor: person(WRITER) });
  }, 'not_approver'],
  ['added by another user with write access', (w) => { approvalEvent(w).actor = person(WRITER); }, 'not_approver'],
  ['the approver\'s login on someone else\'s ID', (w) => { approvalEvent(w).actor = { ...person(APPROVER), id: STRANGER }; }, 'not_approver'],
  ['no actor', (w) => { approvalEvent(w).actor = null; }, 'not_approver'],
  ['the approver\'s ID, but not a User', (w) => { approvalEvent(w).actor = person(APPROVER, 'Bot'); }, 'actor_not_user'],
  ['added through an app', (w) => { approvalEvent(w).performed_via_github_app = { id: 9, slug: 'an-app' }; }, 'via_app'],
  ['the app field is missing', (w) => { w.tweakEvents = (rows) => { delete rows.at(-1).performed_via_github_app; }; }, 'via_app'],
  ['edited after the approval', (w) => { w.lastEditedAt = iso(atEvent(w) + MINUTE); w.edits = [w.lastEditedAt]; }, 'edited_after'],
  ['edited in the same second', (w) => { w.lastEditedAt = iso(atEvent(w)); w.edits = [w.lastEditedAt]; }, 'edited_after'],
  ['lastEditedAt in the same second, with an older history', (w) => { w.lastEditedAt = iso(atEvent(w)); w.edits = [iso(atEvent(w) - HOUR)]; }, 'edited_after'],
  ['the edit history is newer than lastEditedAt says', (w) => { w.lastEditedAt = iso(atEvent(w) - HOUR); w.edits = [iso(atEvent(w) + MINUTE)]; }, 'edited_after'],
  ['an edit history with no lastEditedAt', (w) => { w.edits = [iso(atEvent(w) - HOUR)]; }, 'disagree_edits'],
  ['retitled after the approval', (w) => { addRename(w, atEvent(w) + MINUTE); }, 'renamed_after'],
  ['retitled in the same second', (w) => { addRename(w, atEvent(w)); }, 'renamed_after'],
  ['retitled in the same second, listed just before the approval', (w) => {
    const at = atEvent(w);
    w.events.pop();
    addRename(w, at);
    addEvent(w, 'labeled', APPROVED_ID, { at });
  }, 'renamed_after'],
  ['an author who is not allowed', (w) => { w.issue.user = person(STRANGER); }, 'author_not_allowed'],
  ['an allowed author\'s login on someone else\'s ID', (w) => { w.issue.user = { ...person(APPROVER), id: STRANGER }; }, 'author_not_allowed'],
  ['exactly 7 days old', (w) => { const e = approvalEvent(w); e.created_at = iso(NOW - MAX_AGE_MS); w.events[0].created_at = iso(NOW - MAX_AGE_MS - HOUR); }, 'expired'],
  ['older than 7 days', (w) => { const e = approvalEvent(w); e.created_at = iso(NOW - 8 * DAY); w.events[0].created_at = iso(NOW - 9 * DAY); }, 'expired'],
];

for (const [name, change, reason] of REFUSALS) {
  test(`refused: ${name}`, async () => {
    const w = newWorld();
    change(w);
    assertRefused(await run(w), reason);
  });
}

test('refused: an event already in the ledger', async () => {
  const w = newWorld();
  const seen = [];
  const report = await run(w, { ledger: { get: (id) => (seen.push(id), { event_id: id, state: 'finished' }) } });
  assertRefused(report, 'already_used');
  assert.deepEqual(seen, [approvalEvent(w).id]);
});

// --- settings: unset means nothing is approved ------------------------------

test('no setting has a default', () => {
  assert.deepEqual({ ...approvalSettings({}), authorIds: [...approvalSettings({}).authorIds] }, {
    repo: null, approverId: null, authorIds: [], labelId: null, ledgerPath: null,
  });
});

for (const [name, env, reason] of [
  ['no approver', { NIGHT_APPROVER_ID: undefined }, 'approver_not_set'],
  ['an empty approver', { NIGHT_APPROVER_ID: '' }, 'approver_not_set'],
  ['a login as approver', { NIGHT_APPROVER_ID: 'someone' }, 'approver_not_set'],
  ['a zero approver', { NIGHT_APPROVER_ID: '0' }, 'approver_not_set'],
  ['an approver too large to be exact', { NIGHT_APPROVER_ID: '9999999999999999' }, 'approver_not_set'],
  ['a scientific approver', { NIGHT_APPROVER_ID: '1e3' }, 'approver_not_set'],
  ['no authors', { NIGHT_AUTHOR_IDS: undefined }, 'authors_not_set'],
  ['an empty author list', { NIGHT_AUTHOR_IDS: ' , ' }, 'authors_not_set'],
  ['a login in the author list', { NIGHT_AUTHOR_IDS: `${APPROVER},someone` }, 'authors_not_set'],
  ['no label ID', { NIGHT_APPROVAL_LABEL_ID: undefined }, 'label_id_not_set'],
  ['a label name in place of its ID', { NIGHT_APPROVAL_LABEL_ID: APPROVAL_LABEL }, 'label_id_not_set'],
  ['no repository', { GITHUB_REPO: undefined }, 'repo_not_set'],
  ['a malformed repository', { GITHUB_REPO: 'owner/repo/../x' }, 'repo_not_set'],
]) {
  test(`refused: ${name}`, async () => {
    const settings = approvalSettings({ ...ENV, ...env });
    assertRefused(await run(newWorld(), { settings }), reason);
  });
}

test('refused: no ledger given', async () => {
  assertRefused(await run(newWorld(), { ledger: null }), 'ledger_not_set');
  assertRefused(await run(newWorld(), { ledger: undefined }), 'ledger_not_set');
});

test('refused: a ledger that cannot be read, even when no approval event was found to look up', async () => {
  assertRefused(await run(newWorld(), { ledger: UNREADABLE_LEDGER }), 'ledger_unreadable');
  const w = newWorld();
  w.events = [w.events[0]];
  assertRefused(await run(w, { ledger: UNREADABLE_LEDGER }), 'ledger_unreadable');
});

// --- pagination -------------------------------------------------------------

test('events: a removal on the second page is found', async () => {
  const w = newWorld();
  addFiller(w, 150, NOW - 50 * MINUTE);
  addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - MINUTE });
  assertRefused(await run(w), 'label_removed');
});

test('events: an approval on the third page is the one found', async () => {
  const w = newWorld();
  w.events.pop();
  addFiller(w, 250);
  const e = addEvent(w, 'labeled', APPROVED_ID, { at: NOW - HOUR });
  const report = await run(w);
  assertApproved(report);
  assert.equal(report.eventId, e.id);
  assert.equal(w.calls.filter((c) => /events/.test(c.path ?? '')).length, 3);
});

test('events: an exactly full last page is followed by asking for the next, which is empty', async () => {
  const w = newWorld();
  w.events.pop();
  addFiller(w, 98);
  addEvent(w, 'labeled', APPROVED_ID, { at: NOW - HOUR });
  assert.equal(w.events.length, 100);
  assertApproved(await run(w));
  assert.ok(w.calls.some((c) => c.path?.endsWith('page=2')));
});

test('events: a full page with no Link header does not end the list', async () => {
  const w = newWorld();
  addFiller(w, 150, NOW - 50 * MINUTE);
  addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - MINUTE });
  w.reply = (kind, page, r) => (kind === 'events' ? { ...r, headers: { ...r.headers, link: null } } : r);
  assertRefused(await run(w), 'label_removed');
});

for (const [name, reply, reason] of [
  ['fails', (r) => ({ ...r, status: 500 }), 'github_status'],
  ['is cut short', (r) => ({ ...r, text: r.text.slice(0, r.text.length >> 1) }), 'reply_not_json'],
  ['is not a list', (r) => ({ ...r, text: '{"message":"oops"}' }), 'reply_shape'],
]) {
  test(`events: the second page ${name}`, async () => {
    const w = newWorld();
    addFiller(w, 150, NOW - 50 * MINUTE);
    w.reply = (kind, page, r) => (kind === 'events' && page === 2 ? reply(r) : r);
    assertRefused(await run(w), reason);
  });
}

test('events: the second page cannot be reached', async () => {
  const w = newWorld();
  addFiller(w, 150, NOW - 50 * MINUTE);
  const github = fakeGitHub(w);
  const report = await run(w, { github: { ...github, get: async (p) => { if (p.endsWith('page=2')) throw new Error('reset'); return github.get(p); } } });
  assertRefused(report, 'github_unreachable');
});

test('events: a short page that says more follows', async () => {
  const w = newWorld();
  w.reply = (kind, page, r) => (kind === 'events' ? { ...r, headers: { ...r.headers, link: '<https://x/?page=2>; rel="next"' } } : r);
  assertRefused(await run(w), 'events_incomplete');
});

test('events: a short page hiding the real last event disagrees with GraphQL', async () => {
  const w = newWorld();
  addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - MINUTE });
  w.tweakEvents = (rows) => { rows.pop(); };
  assertRefused(await run(w), 'disagree_events');
});

test('events: more pages than the limit', async () => {
  const w = newWorld();
  addFiller(w, MAX_PAGES * 100 + 1, NOW - 2 * HOUR);
  assertRefused(await run(w), 'events_too_many');
});

test('events: a page larger than was asked for', async () => {
  const w = newWorld();
  w.tweakEvents = (rows) => { rows.push(...Array.from({ length: 101 }, () => rows[0])); };
  assertRefused(await run(w), 'reply_shape');
});

test('events: repeated, or out of order', async () => {
  const dup = newWorld();
  dup.tweakEvents = (rows) => { rows.splice(1, 0, rows[0]); };
  assertRefused(await run(dup), 'events_out_of_order');
  const back = newWorld();
  back.tweakEvents = (rows) => { rows.reverse(); };
  assertRefused(await run(back), 'events_out_of_order');
  const time = newWorld();
  approvalEvent(time).created_at = iso(NOW - 4 * HOUR);
  assertRefused(await run(time), 'events_out_of_order');
});

const addLabelNoise = (w, count) => {
  w.events.pop();
  w.onIssue = [TASK_ID, APPROVED_ID];
  for (let i = 0; i < count; i++) addEvent(w, i % 2 ? 'unlabeled' : 'labeled', OTHER_ID, { at: NOW - 2 * HOUR });
};

test('timeline: read to the end across pages', async () => {
  const w = newWorld();
  addLabelNoise(w, 150);
  const e = addEvent(w, 'labeled', APPROVED_ID, { at: NOW - HOUR });
  const report = await run(w);
  assertApproved(report);
  assert.equal(report.eventId, e.id);
  const pages = w.calls.filter((c) => c.query?.includes('timelineItems'));
  assert.deepEqual(pages.map((c) => c.variables.after), [null, '100']);
});

test('timeline: the second page fails, or changes the count', async () => {
  const w = newWorld();
  addLabelNoise(w, 150);
  addEvent(w, 'labeled', APPROVED_ID, { at: NOW - HOUR });
  w.reply = (kind, start, r) => (kind === 'timeline' && start === 100 ? { ...r, status: 502 } : r);
  assertRefused(await run(w), 'github_status');
  delete w.reply;
  w.tweakTimeline = (t, start) => { if (start === 100) t.totalCount += 1; };
  assertRefused(await run(w), 'timeline_incomplete');
});

for (const [name, tweak] of [
  ['a total larger than what was sent', (t) => { t.totalCount += 1; }],
  ['more to come, with no cursor', (t) => { t.pageInfo = { hasNextPage: true, endCursor: null }; }],
  ['no word on whether more is to come', (t) => { t.pageInfo = { endCursor: 'x' }; }],
]) {
  test(`timeline: ${name}`, async () => {
    const w = newWorld();
    w.tweakTimeline = tweak;
    assertRefused(await run(w), 'timeline_incomplete');
  });
}

// --- partial or broken replies ---------------------------------------------

for (const kind of ['issue', 'events', 'gql', 'timeline']) {
  for (const [name, reply, reason] of [
    ['is cut short', (r) => ({ ...r, text: r.text.slice(0, r.text.length >> 1) }), 'reply_not_json'],
    ['is empty', (r) => ({ ...r, text: '' }), 'reply_not_json'],
    ['has status 500', (r) => ({ ...r, status: 500 }), 'github_status'],
    ['has status 404', (r) => ({ ...r, status: 404 }), 'github_status'],
    ['has status 204', (r) => ({ ...r, status: 204 }), 'github_status'],
    ['has no text', (r) => ({ ...r, text: undefined }), 'github_status'],
    ['is JSON null', (r) => ({ ...r, text: 'null' }), 'reply_shape'],
  ]) {
    test(`${kind} reply ${name}`, async () => {
      const w = newWorld();
      w.reply = (k, page, r) => (k === kind ? reply(r) : r);
      assertRefused(await run(w), reason);
    });
  }
}

test('GitHub cannot be reached', async () => {
  const boom = async () => { throw new Error('ECONNRESET'); };
  const github = fakeGitHub(newWorld());
  assertRefused(await run(newWorld(), { github: { ...github, get: boom } }), 'github_unreachable');
  assertRefused(await run(newWorld(), { github: { ...github, graphql: boom } }), 'github_unreachable');
  assertRefused(await run(newWorld(), { github: { get: async () => undefined, graphql: async () => undefined } }), 'github_status');
});

test('GraphQL: errors beside data refuse the whole answer', async () => {
  for (const which of ['issue', 'timeline']) {
    const w = newWorld();
    w.tweakGqlTop = (out, k) => { if (k === which) out.errors = [{ message: 'partly failed' }]; };
    assertRefused(await run(w), 'graphql_errors');
  }
  const odd = newWorld();
  odd.tweakGqlTop = (out) => { out.errors = 'x'; };
  assertRefused(await run(odd), 'graphql_errors');
});

test('GraphQL: an issue that came back null', async () => {
  const w = newWorld();
  w.tweakGql = (_issue, repository) => { repository.issue = null; };
  assertRefused(await run(w), 'reply_shape');
});

test('GraphQL: more labels or edits than one page shows', async () => {
  const labels = newWorld();
  labels.tweakGql = (i) => { i.labels.pageInfo.hasNextPage = true; };
  assertRefused(await run(labels), 'labels_incomplete');
  const count = newWorld();
  count.tweakGql = (i) => { i.labels.totalCount += 1; };
  assertRefused(await run(count), 'labels_incomplete');
  const edits = newWorld();
  edits.tweakGql = (i) => { i.userContentEdits.pageInfo.hasNextPage = true; };
  assertRefused(await run(edits), 'edits_incomplete');
  const editCount = newWorld();
  editCount.tweakGql = (i) => { i.userContentEdits.totalCount = 1; };
  assertRefused(await run(editCount), 'edits_incomplete');
});

// A reply that has lost any one field it needs is refused, however it failed. A missing field must never read as "nothing there".
for (const key of ['id', 'node_id', 'state', 'title', 'body', 'user', 'labels', 'repository_url', 'number']) {
  test(`REST issue with no ${key}`, async () => {
    const w = newWorld();
    w.tweakRest = (i) => { delete i[key]; };
    assert.equal((await run(w)).approved, false);
  });
}
for (const key of ['id', 'databaseId', 'number', 'state', 'title', 'body', 'lastEditedAt', 'author', 'labels', 'userContentEdits']) {
  test(`GraphQL issue with no ${key}`, async () => {
    const w = newWorld();
    w.tweakGql = (i) => { delete i[key]; };
    assert.equal((await run(w)).approved, false);
  });
}
for (const key of ['id', 'node_id', 'event', 'created_at', 'actor', 'label', 'performed_via_github_app']) {
  test(`REST approval event with no ${key}`, async () => {
    const w = newWorld();
    w.tweakEvents = (rows) => { delete rows.at(-1)[key]; };
    assert.equal((await run(w)).approved, false);
  });
}
for (const key of ['__typename', 'id', 'createdAt', 'actor', 'label']) {
  test(`GraphQL approval event with no ${key}`, async () => {
    const w = newWorld();
    w.tweakTimeline = (t) => { delete t.nodes.at(-1)[key]; };
    assert.equal((await run(w)).approved, false);
  });
}
for (const key of ['id', 'name', 'updatedAt']) {
  test(`GraphQL approval label with no ${key}`, async () => {
    const w = newWorld();
    w.tweakTimeline = (t) => { delete t.nodes.at(-1).label[key]; };
    assert.equal((await run(w)).approved, false);
  });
}
for (const stamp of ['yesterday', '2026-11-02', '2026-11-02T20:00:00+04:00', '2026-13-45T00:00:00Z', 1793653200]) {
  test(`a time written as ${stamp}`, async () => {
    const event = newWorld();
    event.tweakEvents = (rows) => { rows.at(-1).created_at = stamp; };
    assert.equal((await run(event)).approved, false);
    const edited = newWorld();
    edited.lastEditedAt = stamp;
    assert.equal((await run(edited)).approved, false);
  });
}

test('wrong issue: another number, or another repository', async () => {
  const number = newWorld();
  number.tweakRest = (i) => { i.number = 22; };
  assertRefused(await run(number), 'wrong_issue');
  const repo = newWorld();
  repo.tweakRest = (i) => { i.repository_url = 'https://api.github.com/repos/owner/moved'; };
  assertRefused(await run(repo), 'wrong_issue');
  const gql = newWorld();
  gql.tweakGql = (_i, repository) => { repository.nameWithOwner = 'owner/moved'; };
  assertRefused(await run(gql), 'wrong_issue');
});

// --- REST and GraphQL disagreeing -------------------------------------------

for (const [name, change, reason] of [
  ['the title', (w) => { w.tweakGql = (i) => { i.title = 'another'; }; }, 'disagree_text'],
  ['the body', (w) => { w.tweakRest = (i) => { i.body = 'another'; }; }, 'disagree_text'],
  ['the author', (w) => { w.tweakGql = (i) => { i.author.databaseId = SECOND_AUTHOR; }; }, 'disagree_author'],
  ['what kind of author', (w) => { w.tweakGql = (i) => { i.author = { __typename: 'Bot' }; }; }, 'disagree_author'],
  ['the state', (w) => { w.tweakGql = (i) => { i.state = 'CLOSED'; }; }, 'disagree_issue'],
  ['the issue ID', (w) => { w.tweakGql = (i) => { i.databaseId = 5002; }; }, 'disagree_issue'],
  ['the issue node ID', (w) => { w.tweakGql = (i) => { i.id = 'I_other'; }; }, 'disagree_issue'],
  ['the labels', (w) => { w.tweakGql = (i) => { i.labels.nodes = [i.labels.nodes[0]]; i.labels.totalCount = 1; }; }, 'disagree_labels'],
  ['a label\'s ID', (w) => { w.tweakRest = (i) => { i.labels[1].node_id = OTHER_ID; }; }, 'disagree_labels'],
  ['an event only GraphQL has', (w) => { w.tweakEvents = (rows) => { rows.pop(); }; }, 'disagree_events'],
  ['an event only REST has', (w) => {
    addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - MINUTE });
    w.tweakTimeline = (t) => { t.nodes.pop(); t.totalCount -= 1; };
  }, 'disagree_events'],
  ['an event\'s type', (w) => { w.tweakTimeline = (t) => { const n = t.nodes.at(-1); n.__typename = 'UnlabeledEvent'; }; }, 'disagree_events'],
  ['an event\'s node ID', (w) => { w.tweakTimeline = (t) => { t.nodes.at(-1).id = 'LE_other'; }; }, 'disagree_events'],
  ['an event\'s time', (w) => { w.tweakTimeline = (t) => { t.nodes.at(-1).createdAt = iso(NOW); }; }, 'disagree_events'],
  ['who added the label', (w) => { w.tweakTimeline = (t) => { t.nodes.at(-1).actor.databaseId = WRITER; }; }, 'disagree_actor'],
  ['what kind of actor added the label', (w) => { w.tweakTimeline = (t) => { t.nodes.at(-1).actor = { __typename: 'Bot' }; }; }, 'disagree_actor'],
  ['the approval event\'s label name', (w) => { w.tweakTimeline = (t) => { t.nodes.at(-1).label.name = 'other'; }; }, 'label_identity'],
  ['the approval event\'s label ID', (w) => { w.tweakTimeline = (t) => { t.nodes.at(-1).label.id = OTHER_ID; }; }, 'label_identity'],
]) {
  test(`REST and GraphQL disagree on ${name}`, async () => {
    const w = newWorld();
    change(w);
    assertRefused(await run(w), reason);
  });
}

// --- clocks -----------------------------------------------------------------

test('clock: a local clock that is not a number', async () => {
  for (const bad of [NaN, Infinity, undefined]) {
    assertRefused(await run(newWorld(), { clock: () => bad }), 'clock_invalid');
  }
});

test('clock: a local clock that throws is refused, and the error goes no further', async () => {
  const report = await run(newWorld(), { clock: () => { throw new Error('secret words'); } });
  assert.equal(report.approved, false);
  assert.deepEqual([...report.reasons], ['internal_error']);
});

test('clock: GitHub sends no usable date', async () => {
  for (const date of [null, '', 'soon']) {
    const w = newWorld();
    w.serverDate = date;
    assertRefused(await run(w), 'server_date_missing');
  }
});

test('clock: one reply without a date is enough to refuse', async () => {
  const w = newWorld();
  w.reply = (kind, page, r) => (kind === 'timeline' ? { ...r, headers: { ...r.headers, date: null } } : r);
  assertRefused(await run(w), 'server_date_missing');
});

test('clock: too far from GitHub, either way', async () => {
  for (const offset of [MAX_CLOCK_SKEW_MS + SECOND, -MAX_CLOCK_SKEW_MS - SECOND]) {
    const w = newWorld();
    w.now = NOW + offset;
    w.serverDate = new Date(NOW).toUTCString();
    assertRefused(await run(w), 'clock_skew');
  }
});

test('clock: a small difference from GitHub passes', async () => {
  for (const offset of [MAX_CLOCK_SKEW_MS - SECOND, -MAX_CLOCK_SKEW_MS + SECOND]) {
    const w = newWorld();
    w.now = NOW + offset;
    w.serverDate = new Date(NOW).toUTCString();
    assertApproved(await run(w));
  }
});

test('clock: a machine clock set back cannot revive an old approval', async () => {
  const w = newWorld();
  const e = approvalEvent(w);
  e.created_at = iso(NOW - 8 * DAY);
  w.events[0].created_at = iso(NOW - 9 * DAY);
  w.now = NOW - 2 * DAY; // the event looks 6 days old from here
  w.serverDate = new Date(NOW).toUTCString();
  const report = await run(w);
  assertRefused(report, 'clock_skew');
  assertRefused(report, 'expired');
});

test('clock: within the skew allowed, the later clock decides the age', async () => {
  const w = newWorld();
  const e = approvalEvent(w);
  e.created_at = iso(NOW - MAX_AGE_MS + MINUTE);
  w.events[0].created_at = iso(NOW - MAX_AGE_MS - HOUR);
  w.now = NOW + 2 * MINUTE; // past 7 days by this clock, not by GitHub's
  w.serverDate = new Date(NOW).toUTCString();
  assertRefused(await run(w), 'expired');
});

test('clock: an event from the future', async () => {
  const w = newWorld();
  approvalEvent(w).created_at = iso(NOW + HOUR);
  assertRefused(await run(w), 'event_in_future');
});

// --- renaming a label -------------------------------------------------------
//
// Whether a rename rewrites the name in old events is not known, so each attack runs in both possible worlds. `restName` is what an
// old event's REST reply shows: the new name if names are rewritten, the old one if each event keeps a copy. GraphQL's label is the
// label as it is now, so it shows the new name either way.

function plantedRenameWorld({ rewritten }) {
  const w = newWorld();
  w.events.pop();
  // Days ago the approver added another label for some ordinary reason. Today, someone with write access moved the real label
  // out of the way and renamed that other label to take its name.
  w.labels[APPROVED_ID] = { ...w.labels[APPROVED_ID], name: 'moved-away', updatedAt: iso(NOW - 10 * MINUTE) };
  w.labels[OTHER_ID] = { ...w.labels[OTHER_ID], name: APPROVAL_LABEL, updatedAt: iso(NOW - 10 * MINUTE) };
  addEvent(w, 'labeled', OTHER_ID, { at: NOW - 2 * DAY, restName: rewritten ? APPROVAL_LABEL : 'other' });
  w.events.sort((a, b) => a.id - b.id);
  w.events[0].created_at = iso(NOW - 3 * DAY);
  w.onIssue = [TASK_ID, OTHER_ID];
  return w;
}

for (const rewritten of [true, false]) {
  const world = rewritten ? 'names rewritten' : 'names kept';
  test(`rename (${world}): another label renamed into the approval label is not an approval`, async () => {
    const report = await run(plantedRenameWorld({ rewritten }));
    assertRefused(report, 'label_identity');
    assertRefused(report, 'label_changed_after');
  });

  test(`rename (${world}): the same, when the setting names the planted label, is caught by the label's change time`, async () => {
    const settings = approvalSettings({ ...ENV, NIGHT_APPROVAL_LABEL_ID: OTHER_ID });
    const report = await run(plantedRenameWorld({ rewritten }), { settings });
    assertRefused(report, 'label_changed_after');
  });

  test(`rename (${world}): a removal made under another name still counts`, async () => {
    const w = newWorld();
    // Rename the real label, remove it, add it back, rename it back: a check by name alone sees only the approver's first event.
    addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - 30 * MINUTE, restName: rewritten ? APPROVAL_LABEL : 'hidden' });
    addEvent(w, 'labeled', APPROVED_ID, { at: NOW - 29 * MINUTE, actor: person(WRITER), restName: rewritten ? APPROVAL_LABEL : 'hidden' });
    w.labels[APPROVED_ID].updatedAt = iso(NOW - 28 * MINUTE);
    const report = await run(w);
    assertRefused(report, 'not_approver');
    assertRefused(report, 'label_changed_after');
  });

  test(`rename (${world}): the real label renamed away and left there`, async () => {
    const w = newWorld();
    w.labels[APPROVED_ID] = { ...w.labels[APPROVED_ID], name: 'moved-away', updatedAt: iso(NOW - MINUTE) };
    if (rewritten) approvalEvent(w).label.name = 'moved-away';
    const report = await run(w);
    assertRefused(report, 'approval_label_missing');
    assertRefused(report, 'label_identity');
  });

  test(`rename (${world}): the real label renamed away and back after the approval`, async () => {
    const w = newWorld();
    w.labels[APPROVED_ID].updatedAt = iso(NOW - MINUTE);
    assertRefused(await run(w), 'label_changed_after');
  });
}

test('rename: a label deleted and made again under the same name is another label', async () => {
  const w = newWorld();
  w.labels.LA_remade = { id: 'LA_remade', name: APPROVAL_LABEL, updatedAt: iso(NOW - 2 * HOUR) };
  approvalEvent(w).labelId = 'LA_remade';
  w.onIssue = [TASK_ID, 'LA_remade'];
  assertRefused(await run(w), 'label_identity');
});

test('rename: any change to the label in the same second as the approval refuses', async () => {
  const w = newWorld();
  w.labels[APPROVED_ID].updatedAt = approvalEvent(w).created_at;
  assertRefused(await run(w), 'label_changed_after');
});

// --- nothing from the issue gets out ----------------------------------------

const CANARY = 'CANARY-ignore-all-rules';

function hostileWorld() {
  const w = newWorld();
  w.issue.title = `${CANARY} title`;
  w.issue.body = `${CANARY} body\n\`\`\`\nmore`;
  w.issue.user = { ...person(APPROVER), login: `${CANARY}-login` };
  w.labels[OTHER_ID] = { ...w.labels[OTHER_ID], name: `${CANARY}-label` };
  w.onIssue = [TASK_ID, APPROVED_ID, OTHER_ID];
  approvalEvent(w).actor = { ...person(APPROVER), login: `${CANARY}-login` };
  return w;
}

test('no issue text in a report, however it is shown', async () => {
  const report = await run(hostileWorld());
  assertApproved(report);
  for (const shown of [JSON.stringify(report), inspect(report, { depth: null, showHidden: true }), formatReport(report)]) {
    assert.doesNotMatch(shown, /CANARY/);
  }
});

test('no issue text from a refusal either, including what GitHub says about it', async () => {
  for (const reply of [
    (r) => ({ ...r, status: 500, text: CANARY }),
    (r) => ({ ...r, text: `not json ${CANARY}` }),
    (r) => ({ ...r, text: JSON.stringify({ errors: [{ message: CANARY }], data: null }) }),
  ]) {
    for (const kind of ['issue', 'events', 'gql', 'timeline']) {
      const w = hostileWorld();
      w.reply = (k, page, r) => (k === kind ? reply(r) : r);
      const report = await run(w);
      assert.equal(report.approved, false);
      assert.doesNotMatch(`${JSON.stringify(report)}\n${formatReport(report)}`, /CANARY/);
    }
  }
  const thrown = await run(hostileWorld(), { github: { get: async () => { throw new Error(CANARY); }, graphql: async () => { throw new Error(CANARY); } } });
  assert.doesNotMatch(formatReport(thrown), /CANARY/);
});

test('formatReport prints nothing but what passes its own checks', () => {
  const out = formatReport({
    task: 'TASK-21', issue: 21, approved: false, reasons: [`${CANARY}`, 'not_open'], eventId: CANARY, actorId: { a: CANARY }, labeledAt: CANARY, textSha256: CANARY,
  });
  assert.doesNotMatch(out, /CANARY/);
  assert.match(out, /reason internal_error/);
  assert.match(out, /reason not_open/);
});

test('comments are never asked for, and only reads are sent', async () => {
  const w = newWorld();
  await run(w);
  assert.ok(w.calls.length >= 4);
  for (const c of w.calls) {
    assert.doesNotMatch(c.path ?? '', /comment/i);
    assert.doesNotMatch(c.query ?? '', /comment/i);
    if (c.path) assert.equal(c.method, 'GET');
    else assert.match(c.query, /^query\b/);
    assert.doesNotMatch(c.query ?? '', /mutation/i);
  }
});

// --- pinning, the ledger and the second check ------------------------------

function openWorld(t) {
  const dir = tempDir(t);
  const ledger = new Ledger(join(dir, 'night.sqlite'), { create: true });
  t.after(() => ledger.close());
  return { dir, ledger, w: newWorld() };
}

const select = (w, ledger) => selectApproval({ github: fakeGitHub(w), settings: SETTINGS, number: 21, ledger, clock: () => w.now });
const recheck = (w, ledger, attempt) => recheckApproval({ github: fakeGitHub(w), settings: SETTINGS, number: 21, ledger, attempt, clock: () => w.now });

async function started(t) {
  const world = openWorld(t);
  const { pin } = await select(world.w, world.ledger);
  const attempt = beginAttempt({ ledger: world.ledger, pin, runId: 'run-1', clock: () => world.w.now });
  return { ...world, pin, attempt };
}

test('select: the text is pinned, with its hash, and cannot be printed by accident', async (t) => {
  const { ledger, w } = openWorld(t);
  w.issue.title = `${CANARY} title`;
  w.issue.body = `${CANARY} body`;
  const { report, pin } = await select(w, ledger);
  assertApproved(report);
  assert.deepEqual({ ...pin.text }, { title: `${CANARY} title`, body: `${CANARY} body` });
  assert.equal(pin.textSha256, textHash(`${CANARY} title`, `${CANARY} body`));
  assert.ok(Object.isFrozen(pin));
  assert.doesNotMatch(JSON.stringify(pin), /CANARY/);
  assert.doesNotMatch(inspect(pin), /CANARY/);
  assert.doesNotMatch(JSON.stringify({ ...pin }), /CANARY/);
});

test('select: not approved gives no pin', async (t) => {
  const { ledger, w } = openWorld(t);
  w.issue.state = 'closed';
  const { report, pin } = await select(w, ledger);
  assert.equal(report.approved, false);
  assert.equal(pin, null);
});

test('the hash cannot be fooled by moving text between title and body', () => {
  assert.notEqual(textHash('ab', 'c'), textHash('a', 'bc'));
  assert.notEqual(textHash('a","b', ''), textHash('a', 'b'));
  assert.match(textHash('a', 'b'), /^[0-9a-f]{64}$/);
});

test('the ledger records started, with the hash and no text, before anything else can happen', async (t) => {
  const { dir, ledger, pin } = await started(t);
  const row = ledger.get(pin.eventId);
  assert.equal(row.state, 'started');
  assert.equal(row.text_sha256, pin.textSha256);
  assert.equal(row.task, 'TASK-21');
  assert.equal(row.actor_id, APPROVER);
  assert.equal(row.run_id, 'run-1');
  assert.equal(row.started_at, NOW);
  assert.deepEqual(ledger.unfinished().map((r) => r.event_id), [pin.eventId]);
  assert.doesNotMatch(JSON.stringify(row), /a title|a body/);
  assert.ok(existsSync(join(dir, 'night.sqlite')));
});

test('one attempt per approval: a second start, and a second selection, are refused', async (t) => {
  const { ledger, pin, w } = await started(t);
  assert.throws(() => beginAttempt({ ledger, pin, runId: 'run-2', clock: () => w.now }), /already been used/);
  assert.equal(ledger.get(pin.eventId).run_id, 'run-1');
  const { report } = await select(w, ledger);
  assertRefused(report, 'already_used');
});

test('leaving the label on does nothing, and removing and adding it again is a new approval', async (t) => {
  const { ledger, pin, w } = await started(t);
  ledger.finish(pin.eventId, 'pr_failed', NOW);
  assertRefused((await select(w, ledger)).report, 'already_used');
  addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - 10 * MINUTE });
  addEvent(w, 'labeled', APPROVED_ID, { at: NOW - 9 * MINUTE });
  const again = await select(w, ledger);
  assertApproved(again.report);
  assert.notEqual(again.pin.eventId, pin.eventId);
});

test('a stop uses up the approval', async (t) => {
  const { ledger, pin, w } = await started(t);
  assert.equal(ledger.finish(pin.eventId, 'stopped', NOW), true);
  assertRefused((await select(w, ledger)).report, 'already_used');
  assert.deepEqual(ledger.unfinished(), []);
});

test('a crash after started uses up the approval, and a reopened ledger still knows it', async (t) => {
  const { dir, w, ledger: first } = openWorld(t);
  const { pin } = await select(w, first);
  const path = join(dir, 'night.sqlite');
  const code = `
    import { Ledger } from ${JSON.stringify(pathToFileURL(join(ROOT, 'night/ledger.js')).href)};
    import { beginAttempt } from ${JSON.stringify(pathToFileURL(join(ROOT, 'night/approval.js')).href)};
    const ledger = new Ledger(process.env.LEDGER);
    beginAttempt({ ledger, pin: JSON.parse(process.env.PIN), runId: 'crashing', clock: () => 1 });
    process.kill(process.pid, 'SIGKILL');
  `;
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { env: { ...process.env, LEDGER: path, PIN: JSON.stringify(pin) }, encoding: 'utf8' });
  assert.equal(r.signal, 'SIGKILL', r.stderr);
  const reopened = new Ledger(path, { readOnly: true });
  t.after(() => reopened.close());
  assert.equal(reopened.get(pin.eventId).run_id, 'crashing');
  assert.deepEqual(reopened.unfinished().map((x) => x.state), ['started']);
  assertRefused((await select(w, reopened)).report, 'already_used');
});

test('no session may start when the ledger cannot record it', async (t) => {
  const { ledger, w } = openWorld(t);
  const { pin } = await select(w, ledger);
  assert.throws(() => beginAttempt({ ledger: { start: () => { throw new Error('disk full'); } }, pin, runId: 'run-1' }), /disk full/);
  assert.throws(() => beginAttempt({ ledger, pin, runId: 'has spaces and text' }), /run ID/);
  assert.throws(() => beginAttempt({ ledger, pin, runId: 'run-1', clock: () => NaN }), LedgerError);
  assert.equal(ledger.get(pin.eventId), null);
});

test('recheck: nothing changed, so it passes', async (t) => {
  const { ledger, w, attempt, pin } = await started(t);
  const report = await recheck(w, ledger, attempt);
  assertApproved(report);
  assert.equal(report.eventId, pin.eventId);
});

test('recheck needs an attempt, so it cannot quietly be a selection', async (t) => {
  const { ledger, w } = openWorld(t);
  await assert.rejects(recheckApproval({ github: fakeGitHub(w), settings: SETTINGS, number: 21, ledger, clock: () => w.now }), /needs the attempt/);
});

for (const [name, change, reason] of [
  ['label removed during the run', (w) => { addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - MINUTE }); }, 'label_removed'],
  ['label removed and added back during the run', (w) => {
    addEvent(w, 'unlabeled', APPROVED_ID, { at: NOW - 2 * MINUTE });
    addEvent(w, 'labeled', APPROVED_ID, { at: NOW - MINUTE });
  }, 'approval_changed'],
  ['issue edited during the run', (w) => { w.lastEditedAt = iso(NOW - MINUTE); w.edits = [w.lastEditedAt]; }, 'edited_after'],
  ['issue retitled during the run', (w) => { addRename(w, NOW - MINUTE); }, 'renamed_after'],
  ['issue closed during the run', (w) => { w.issue.state = 'closed'; }, 'not_open'],
  ['text changed with no trace of an edit', (w) => { w.issue.body = 'changed'; }, 'text_changed'],
  ['approval lapsed during the run', (w) => { w.now = NOW + 7 * DAY; }, 'expired'],
  ['GitHub unreachable', (w) => { w.reply = () => { throw new Error('reset'); }; }, 'github_unreachable'],
]) {
  test(`recheck refused: ${name}`, async (t) => {
    const { ledger, w, attempt } = await started(t);
    change(w);
    assertRefused(await recheck(w, ledger, attempt), reason);
  });
}

test('recheck refused: the ledger row has gone, is another run\'s, or has finished', async (t) => {
  const { ledger, w, attempt } = await started(t);
  assertRefused(await recheck(w, { get: () => null }, attempt), 'ledger_mismatch');
  assertRefused(await recheck(w, ledger, { ...attempt, runId: 'run-2' }), 'ledger_mismatch');
  assertRefused(await recheck(w, UNREADABLE_LEDGER, attempt), 'ledger_unreadable');
  ledger.finish(attempt.eventId, 'stopped', NOW);
  assertRefused(await recheck(w, ledger, attempt), 'ledger_mismatch');
});

// --- the ledger file --------------------------------------------------------

test('the ledger refuses another service\'s database by name, whatever the case, and through a link', (t) => {
  const dir = tempDir(t);
  for (const name of ['reviewer.db', 'coordinator.db', 'Reviewer.DB']) {
    assert.throws(() => new Ledger(join(dir, name), { create: true }), LedgerError);
    assert.equal(existsSync(join(dir, name)), false);
  }
  const real = join(dir, 'reviewer.db');
  writeFileSync(real, '');
  const link = join(dir, 'night.sqlite');
  symlinkSync(real, link);
  assert.throws(() => new Ledger(link, { create: true }), LedgerError);
  assert.equal(statSync(real).size, 0);
});

test('the ledger refuses any other database, and leaves it as it was', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'elsewhere.sqlite');
  const other = new DatabaseSync(path);
  other.exec('CREATE TABLE jobs (id INTEGER); INSERT INTO jobs VALUES (1)');
  other.close();
  const before = readFileSync(path);
  assert.throws(() => new Ledger(path, { create: true }), LedgerError);
  assert.throws(() => new Ledger(path, { readOnly: true }), LedgerError);
  assert.deepEqual(readFileSync(path), before);
});

test('the ledger path must be absolute and there must be one: no memory database, no default', (t) => {
  for (const path of [undefined, null, '', ':memory:', 'night.sqlite', './night.sqlite', 'file:night.sqlite']) {
    assert.throws(() => new Ledger(path, { create: true }), LedgerError);
  }
  const dir = tempDir(t);
  assert.throws(() => new Ledger(join(dir, 'missing', 'night.sqlite'), { create: true }));
});

test('a missing ledger is an error, not an empty one, unless creating one was asked for', (t) => {
  const path = join(tempDir(t), 'night.sqlite');
  assert.throws(() => new Ledger(path), LedgerError);
  assert.throws(() => new Ledger(path, { readOnly: true }), LedgerError);
  assert.throws(() => new Ledger(path, { create: true, readOnly: true }), LedgerError);
  assert.equal(existsSync(path), false);
  new Ledger(path, { create: true }).close();
  new Ledger(path).close();
});

test('a damaged ledger, or a file that stopped short of being one, is refused', (t) => {
  const dir = tempDir(t);
  const junk = join(dir, 'junk.sqlite');
  writeFileSync(junk, 'not a database at all, and long enough to be read as one and fail');
  assert.throws(() => new Ledger(junk, { readOnly: true }));
  const empty = join(dir, 'empty.sqlite');
  writeFileSync(empty, '');
  assert.throws(() => new Ledger(empty), LedgerError);
});

test('a new ledger only its owner can read, and a read-only one that cannot write', { skip: process.platform === 'win32' }, (t) => {
  const path = join(tempDir(t), 'night.sqlite');
  new Ledger(path, { create: true }).close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const ro = new Ledger(path, { readOnly: true });
  t.after(() => ro.close());
  assert.throws(() => ro.start({ eventId: 1, runId: 'r', task: 'TASK-1', issue: 1, actorId: 1, labeledAt: iso(NOW), textSha256: 'a'.repeat(64), startedAt: NOW }));
  assert.equal(ro.get(1), null);
});

test('the ledger takes fixed words and valid values only', (t) => {
  const ledger = new Ledger(join(tempDir(t), 'night.sqlite'), { create: true });
  t.after(() => ledger.close());
  const good = { eventId: 7, runId: 'run-7', task: 'TASK-7', issue: 7, actorId: 1, labeledAt: iso(NOW), textSha256: 'a'.repeat(64), startedAt: NOW };
  for (const bad of [{ eventId: 0 }, { eventId: 1.5 }, { runId: 'two words' }, { task: 'a task' }, { issue: 0 }, { actorId: null }, { labeledAt: 1 }, { textSha256: 'short' }, { startedAt: NaN }]) {
    assert.throws(() => ledger.start({ ...good, ...bad }), LedgerError);
  }
  assert.equal(ledger.start(good), true);
  assert.equal(ledger.start(good), false);
  assert.throws(() => ledger.finish(7, 'Words from a model', NOW), LedgerError);
  assert.equal(ledger.finish(99, 'stopped', NOW), false);
  assert.equal(ledger.finish(7, 'stopped', NOW), true);
  assert.equal(ledger.finish(7, 'pr_opened', NOW), false, 'an ending is written once');
  assert.equal(ledger.get(7).outcome, 'stopped');
});

// --- the two ways to read ---------------------------------------------------

function serve(t, handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

test('token reader: the whole check against a local server, with the token and only reads', async (t) => {
  const w = newWorld();
  const github = fakeGitHub(w);
  const seen = [];
  const apiUrl = await serve(t, async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const reply = req.url === '/graphql' ? await github.graphql(JSON.parse(body).query, JSON.parse(body).variables) : await github.get(req.url);
    const headers = { date: reply.headers.date, 'content-type': 'application/json' };
    if (reply.headers.link) headers.link = reply.headers.link;
    res.writeHead(reply.status, headers);
    res.end(reply.text);
  });
  const report = await run(w, { github: tokenReader({ auth: new StaticToken('test-value'), apiUrl }) });
  assertApproved(report);
  assert.ok(seen.every((s) => s.auth === 'Bearer test-value'));
  assert.ok(seen.every((s) => s.method === 'GET' || (s.method === 'POST' && s.url === '/graphql')));
  assert.equal(new Set(seen.map((s) => s.url)).size, 3);
});

test('token reader: a redirect is not followed, so the token goes nowhere else', async (t) => {
  const w = newWorld();
  let reached = 0;
  const elsewhere = await serve(t, (_req, res) => { reached++; res.end('{}'); });
  const apiUrl = await serve(t, (_req, res) => { res.writeHead(301, { location: `${elsewhere}/moved` }); res.end(); });
  assertRefused(await run(w, { github: tokenReader({ auth: new StaticToken('test-value'), apiUrl }) }), 'github_unreachable');
  assert.equal(reached, 0);
});

test('token reader: a reply over the size limit is not read to its end', async (t) => {
  const w = newWorld();
  const apiUrl = await serve(t, (_req, res) => {
    res.writeHead(200, { date: new Date(NOW).toUTCString() });
    res.end(`"${'x'.repeat(MAX_REPLY_BYTES)}"`);
  });
  assertRefused(await run(w, { github: tokenReader({ auth: new StaticToken('test-value'), apiUrl }) }), 'github_unreachable');
});

test('token reader: refuses to send anything but a query', async () => {
  const reader = tokenReader({ auth: new StaticToken('test-value'), apiUrl: 'http://127.0.0.1:9' });
  await assert.rejects(reader.graphql('mutation { x }', {}), /only a query/);
});

// `gh api --include`, as it prints a real reply: a plain newline after the status line, then CRLF between the headers.
const ghOut = (r, status = '200 OK') => `HTTP/2.0 ${status}\nDate: ${r.headers.date}\r\n${r.headers.link ? `Link: ${r.headers.link}\r\n` : ''}X-Other: y\r\n\r\n${r.text}`;

function fakeGh(w) {
  const github = fakeGitHub(w);
  const args = [];
  const run = async (a) => {
    args.push(a);
    assert.equal(a[0], 'api');
    assert.ok(a.includes('--include'));
    if (a.includes('graphql')) {
      const field = (k) => {
        const i = a.findIndex((x) => x.startsWith(`${k}=`));
        return i < 0 ? null : a[i].slice(k.length + 1);
      };
      const reply = await github.graphql(field('query'), { owner: field('owner'), name: field('name'), number: Number(field('number')), after: field('after') });
      return ghOut(reply);
    }
    assert.deepEqual(a.slice(2, 4), ['--method', 'GET']);
    return ghOut(await github.get(`/${a[4]}`));
  };
  return { run, args };
}

test('gh reader: the whole check, with typed numbers, reads only and no pagination by gh', async () => {
  const w = newWorld();
  const { run: gh, args } = fakeGh(w);
  assertApproved(await run(w, { github: ghReader({ run: gh }) }));
  assert.ok(args.every((a) => !a.includes('--paginate')));
  const gql = args.filter((a) => a.includes('graphql'));
  assert.equal(gql.length, 2);
  for (const a of gql) {
    assert.equal(a[a.indexOf('number=21') - 1], '-F');
    assert.ok(!a.some((x) => x.startsWith('after=')));
  }
});

test('gh reader: gh failing, or printing nonsense, refuses', async () => {
  const fail = async () => { throw new Error(`gh: ${CANARY}`); };
  assertRefused(await run(newWorld(), { github: ghReader({ run: fail }) }), 'github_unreachable');
  assertRefused(await run(newWorld(), { github: ghReader({ run: async () => 'nonsense' }) }), 'github_unreachable');
  assertRefused(await run(newWorld(), { github: ghReader({ run: async () => 'not a status\n\n{}' }) }), 'github_unreachable');
  assertRefused(await run(newWorld(), { github: ghReader({ run: async () => 'HTTP/2.0 403 Forbidden\nDate: x\r\n\r\n{}' }) }), 'github_status');
});

test('gh reader: reads a real reply\'s layout', () => {
  const r = parseGhReply('HTTP/2.0 200 OK\nAccess-Control-Allow-Origin: *\r\nDate: Mon, 02 Nov 2026 21:10:28 GMT\r\nLink: <https://x?page=2>; rel="next"\r\n\r\n[{"a":"b: c\\n\\nd"}]');
  assert.equal(r.status, 200);
  assert.equal(r.headers.date, 'Mon, 02 Nov 2026 21:10:28 GMT');
  assert.equal(r.headers.link, '<https://x?page=2>; rel="next"');
  assert.deepEqual(JSON.parse(r.text), [{ a: 'b: c\n\nd' }]);
});

// --- the command ------------------------------------------------------------

const REPORT_LINE = /^(TASK-\d+ \(issue \d+\): (APPROVED|NOT APPROVED)|reason [a-z_]+|event \d+|actor \d+|labeled_at [0-9TZ:-]+|text_sha256 [0-9a-f]{64})$/;

async function command(t, { w = newWorld(), args = ['TASK-21', '--gh'], env = {}, createDb = true } = {}) {
  const dir = tempDir(t);
  const db = join(dir, 'night.sqlite');
  if (createDb) new Ledger(db, { create: true }).close();
  const lines = [];
  const code = await checkApprovalCommand({
    args, env: { ...ENV, NIGHT_DB: db, ...env }, print: (l) => lines.push(...String(l).split('\n')), reader: fakeGitHub(w), clock: () => w.now,
  });
  return { code, lines, db, w };
}

test('command: approved exits 0 and prints only report lines', async (t) => {
  const { code, lines, w } = await command(t);
  assert.equal(code, 0);
  assert.ok(lines.every((l) => REPORT_LINE.test(l)), lines.join('|'));
  assert.equal(lines[0], 'TASK-21 (issue 21): APPROVED');
  assert.ok(lines.includes(`event ${approvalEvent(w).id}`));
});

test('command: not approved exits 1', async (t) => {
  const w = newWorld();
  w.onIssue = [TASK_ID];
  const { code, lines } = await command(t, { w });
  assert.equal(code, 1);
  assert.equal(lines[0], 'TASK-21 (issue 21): NOT APPROVED');
  assert.ok(lines.includes('reason approval_label_missing'));
});

test('command: nothing from the issue is printed, approved or not', async (t) => {
  const approved = await command(t, { w: hostileWorld() });
  assert.equal(approved.code, 0);
  assert.doesNotMatch(approved.lines.join('\n'), /CANARY/);
  const closed = hostileWorld();
  closed.issue.state = 'closed';
  const refused = await command(t, { w: closed });
  assert.equal(refused.code, 1);
  assert.doesNotMatch(refused.lines.join('\n'), /CANARY/);
  assert.ok(refused.lines.every((l) => REPORT_LINE.test(l)));
});

test('command: with no settings at all, nothing is approved', async (t) => {
  const w = newWorld();
  const lines = [];
  const code = await checkApprovalCommand({ args: ['TASK-21', '--gh'], env: { GITHUB_REPO: REPO }, print: (l) => lines.push(...l.split('\n')), reader: fakeGitHub(w), clock: () => w.now });
  assert.equal(code, 1);
  for (const r of ['approver_not_set', 'authors_not_set', 'label_id_not_set', 'ledger_not_set']) assert.ok(lines.includes(`reason ${r}`));
});

test('command: writes nothing to the ledger, and can be run twice with the same answer', async (t) => {
  const first = await command(t);
  const before = readFileSync(first.db);
  assert.equal(first.code, 0);
  const lines = [];
  const code = await checkApprovalCommand({ args: ['TASK-21', '--gh'], env: { ...ENV, NIGHT_DB: first.db }, print: (l) => lines.push(l), reader: fakeGitHub(first.w), clock: () => first.w.now });
  assert.equal(code, 0);
  assert.deepEqual(readFileSync(first.db), before);
});

test('command: a missing ledger is not made up, unless asked for; another database stays untouched', async (t) => {
  const missing = await command(t, { createDb: false });
  assert.equal(missing.code, 1);
  assert.ok(missing.lines.includes('reason ledger_unreadable'));
  assert.equal(existsSync(missing.db), false);

  const made = await command(t, { createDb: false, args: ['TASK-21', '--gh', '--create-ledger'] });
  assert.equal(made.code, 0);
  assert.equal(existsSync(made.db), true);

  const dir = tempDir(t);
  const reviewerDb = join(dir, 'reviewer.db');
  const refused = await command(t, { createDb: false, args: ['TASK-21', '--gh', '--create-ledger'], env: { NIGHT_DB: reviewerDb } });
  assert.equal(refused.code, 1);
  assert.ok(refused.lines.includes('reason ledger_unreadable'));
  assert.equal(existsSync(reviewerDb), false);
});

test('command: wrong usage exits 2 and reads nothing', async (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'a-file');
  writeFileSync(file, 'test-value\n');
  for (const args of [
    [], ['TASK-21'], ['TASK-21', '--gh', '--token-file', file], ['21', '--gh'], ['TASK-0', '--gh'], ['TASK-21', 'TASK-22', '--gh'],
    ['TASK-21', '--gh', '--yes'], ['task-21', '--gh'], ['TASK-21; ls', '--gh'],
  ]) {
    const w = newWorld();
    const lines = [];
    const code = await checkApprovalCommand({ args, env: ENV, print: (l) => lines.push(l), reader: fakeGitHub(w), clock: () => w.now });
    assert.equal(code, 2, args.join(' '));
    assert.match(lines.join('\n'), /^usage: /);
    assert.equal(w.calls.length, 0);
  }
});

test('command: an unreadable or empty token file exits 2 and sends nothing', async (t) => {
  const dir = tempDir(t);
  const empty = join(dir, 'empty');
  writeFileSync(empty, ' \n');
  for (const path of [join(dir, 'missing'), empty, dir]) {
    const lines = [];
    const code = await checkApprovalCommand({ args: ['TASK-21', '--token-file', path], env: ENV, print: (l) => lines.push(l) });
    assert.equal(code, 2);
    assert.doesNotMatch(lines.join('\n'), new RegExp(dir));
  }
});

test('command: --gh and --token-file reach their own readers, and the token is never printed', async (t) => {
  const w = newWorld();
  const { run: gh } = fakeGh(w);
  const lines = [];
  const dir = tempDir(t);
  const db = join(dir, 'night.sqlite');
  new Ledger(db, { create: true }).close();
  const code = await checkApprovalCommand({ args: ['TASK-21', '--gh'], env: { ...ENV, NIGHT_DB: db }, print: (l) => lines.push(l), makeGh: () => ghReader({ run: gh }), clock: () => w.now });
  assert.equal(code, 0);

  const file = join(dir, 'a-file');
  writeFileSync(file, 'test-value\n');
  const printed = [];
  // The command must answer rather than throw, and an error that quotes the value must not reach the output.
  const previous = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.headers.authorization, 'Bearer test-value');
    throw new Error('refused test-value');
  };
  t.after(() => { globalThis.fetch = previous; });
  const failed = await checkApprovalCommand({ args: ['TASK-21', '--token-file', file], env: { ...ENV, NIGHT_DB: db }, print: (l) => printed.push(l), clock: () => w.now });
  assert.equal(failed, 1);
  assert.match(printed.join('\n'), /reason github_unreachable/);
  assert.doesNotMatch(printed.join('\n'), /test-value/);
});

test('the program: an unknown command and bad usage exit 2 with no network', () => {
  const main = join(ROOT, 'night/main.js');
  const env = { PATH: process.env.PATH };
  for (const args of [[], ['nonsense'], ['constructor'], ['check-approval'], ['check-approval', 'TASK-21']]) {
    const r = spawnSync(process.execPath, ['--no-warnings', main, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
});

test('issueOfTask takes only the exact form', () => {
  assert.equal(issueOfTask('TASK-21'), 21);
  for (const bad of ['TASK-0', 'task-21', 'TASK-21 ', ' TASK-21', 'TASK-1e3', 'TASK-', '21', null, undefined, 'TASK-1234567890']) {
    assert.equal(issueOfTask(bad), null, String(bad));
  }
});
