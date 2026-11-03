import { createHash } from 'node:crypto';

// Has the operator approved this issue for one overnight run? Runs at selection and again just before publishing.
//
// An approval is one `labeled` event on the issue, made by one numeric user ID, directly and not through an app, with the issue's
// text unchanged since. GitHub sets the event's actor, so nobody else can fake it. Comments are never read: anyone may comment on
// a public issue. Everything else fails closed. Anything unset, unreadable, partial or inconsistent means not approved.
//
// Replies come from two independent reads, REST and GraphQL, and must agree. Issue text is untrusted, so the report holds only
// fixed words, IDs, times and a hash. The text itself leaves this file in one place: a pin, for the session.
//
// Settings, none with a default:
//   GITHUB_REPO              owner/name
//   NIGHT_APPROVER_ID        the numeric user ID of the one person who may approve. Logins can be reused; IDs cannot
//   NIGHT_AUTHOR_IDS         comma-separated numeric user IDs whose issues may be approved at all
//   NIGHT_APPROVAL_LABEL_ID  the node ID of the approval label: gh api repos/OWNER/NAME/labels/overnight-approved --jq .node_id
//   NIGHT_DB                 the ledger's absolute path (see ledger.js)
//
// Why the label's ID as well as its name. Whether renaming a label rewrites the name in old events is not known, and in either case
// names alone can be fooled by someone who can edit labels. If names are rewritten, renaming a label the approver added long ago
// turns that old event into an apparent approval. If they are not, renaming the real label, removing it and renaming it back hides
// the removal. So events belong to the label by ID: a different label's event is never an approval whatever it is called now, and a
// removal under another name still counts. As a second line, the label must not have changed since the event, which also covers a
// wrong ID in the setting.
export const APPROVAL_LABEL = 'overnight-approved';
export const TASK_LABEL = 'agent-task';
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000; // between this machine and GitHub's Date header
export const FUTURE_TOLERANCE_MS = 60_000; // an event's time against GitHub's own clock
export const PER_PAGE = 100;
export const MAX_PAGES = 20;

// Every word a report can hold.
export const REASONS = Object.freeze([
  // settings
  'repo_not_set', 'approver_not_set', 'authors_not_set', 'label_id_not_set', 'ledger_not_set',
  // reading
  'github_unreachable', 'github_status', 'reply_not_json', 'reply_shape', 'graphql_errors', 'wrong_issue',
  'events_incomplete', 'events_out_of_order', 'events_too_many', 'timeline_incomplete', 'labels_incomplete', 'edits_incomplete',
  // REST and GraphQL disagree
  'disagree_issue', 'disagree_text', 'disagree_author', 'disagree_labels', 'disagree_events', 'disagree_actor', 'disagree_edits',
  // clocks
  'clock_invalid', 'server_date_missing', 'clock_skew', 'event_in_future',
  // the rules
  'not_open', 'is_pull_request', 'task_label_missing', 'approval_label_missing', 'no_approval_event', 'label_removed', 'label_identity', 'label_changed_after',
  'not_approver', 'actor_not_user', 'via_app', 'edited_after', 'renamed_after', 'author_not_allowed', 'expired',
  // the ledger
  'ledger_unreadable', 'already_used', 'ledger_mismatch',
  // since selection
  'approval_changed', 'text_changed',
  'internal_error',
]);

const ID_RE = /^[1-9]\d{0,15}$/;
const LABEL_ID_RE = /^LA_[A-Za-z0-9_-]{1,200}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASK_RE = /^TASK-([1-9]\d{0,8})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (n) => Number.isSafeInteger(n) && n > 0;

class Refusal extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const refuse = (reason) => {
  throw new Refusal(reason);
};

function timeOf(s) {
  if (typeof s !== 'string' || !ISO_RE.test(s)) refuse('reply_shape');
  const t = Date.parse(s);
  if (!Number.isFinite(t)) refuse('reply_shape');
  return t;
}

const idSetting = (v) => {
  const s = String(v ?? '').trim();
  return ID_RE.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : null;
};

// A list with any bad entry counts as unset, so a mistake such as a login in place of an ID cannot pass as a shorter list.
function idListSetting(v) {
  const parts = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ids = parts.map(idSetting);
  return ids.length && ids.every((n) => n !== null) ? Object.freeze(ids) : Object.freeze([]);
}

export function approvalSettings(env = process.env) {
  const repo = String(env.GITHUB_REPO ?? '').trim();
  const labelId = String(env.NIGHT_APPROVAL_LABEL_ID ?? '').trim();
  return Object.freeze({
    repo: REPO_RE.test(repo) ? repo : null,
    approverId: idSetting(env.NIGHT_APPROVER_ID),
    authorIds: idListSetting(env.NIGHT_AUTHOR_IDS),
    labelId: LABEL_ID_RE.test(labelId) ? labelId : null,
    ledgerPath: String(env.NIGHT_DB ?? '').trim() || null,
  });
}

// TASK-21 is issue 21. Null for anything else.
export function issueOfTask(task) {
  const m = TASK_RE.exec(String(task));
  return m ? Number(m[1]) : null;
}

// JSON, so that no title and body can run together to look like another pair.
export const textHash = (title, body) => createHash('sha256').update(JSON.stringify([title, body])).digest('hex');

// --- reading GitHub ---------------------------------------------------------

const ISSUE_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){nameWithOwner issue(number:$number){
  id databaseId number state title body lastEditedAt
  author{__typename ... on User{databaseId}}
  labels(first:100){totalCount pageInfo{hasNextPage} nodes{id name}}
  userContentEdits(first:100){totalCount pageInfo{hasNextPage} nodes{editedAt}}
}}}`;

const TIMELINE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){nameWithOwner issue(number:$number){
  timelineItems(first:100,after:$after,itemTypes:[LABELED_EVENT,UNLABELED_EVENT,RENAMED_TITLE_EVENT]){
    totalCount pageInfo{hasNextPage endCursor}
    nodes{__typename
      ... on LabeledEvent{id createdAt actor{__typename ... on User{databaseId}} label{id name updatedAt}}
      ... on UnlabeledEvent{id createdAt label{id name}}
      ... on RenamedTitleEvent{id createdAt}
    }
  }
}}}`;

const hasNextLink = (link) => /<[^>]*>\s*;\s*rel="next"/.test(String(link ?? ''));

// The REST issue comes first. Its title and body are what gets pinned, and an edit made after that read shows in the later reads.
async function readAll(github, repo, number) {
  const dates = [];
  const read = async (send) => {
    let reply;
    try {
      reply = await send();
    } catch {
      refuse('github_unreachable');
    }
    if (reply?.status !== 200 || typeof reply.text !== 'string') refuse('github_status');
    dates.push(Date.parse(reply.headers?.date ?? ''));
    try {
      return { value: JSON.parse(reply.text), link: reply.headers?.link };
    } catch {
      return refuse('reply_not_json');
    }
  };
  const graphqlIssue = async (query, variables) => {
    const { value } = await read(() => github.graphql(query, variables));
    if (!isObject(value)) refuse('reply_shape');
    // A partial answer still has `data`, so any error at all refuses it.
    if (value.errors !== undefined && !(Array.isArray(value.errors) && value.errors.length === 0)) refuse('graphql_errors');
    const repository = value.data?.repository;
    if (!isObject(repository) || !isObject(repository.issue)) refuse('reply_shape');
    if (String(repository.nameWithOwner).toLowerCase() !== repo.toLowerCase()) refuse('wrong_issue');
    return repository.issue;
  };

  const rest = (await read(() => github.get(`/repos/${repo}/issues/${number}`))).value;

  // A short page ends the list. A full page never does, because the last page can be exactly full: then the next one is empty.
  const events = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) refuse('events_too_many');
    const { value, link } = await read(() => github.get(`/repos/${repo}/issues/${number}/events?per_page=${PER_PAGE}&page=${page}`));
    if (!Array.isArray(value) || value.length > PER_PAGE) refuse('reply_shape');
    if (value.length < PER_PAGE && hasNextLink(link)) refuse('events_incomplete');
    events.push(...value);
    if (value.length < PER_PAGE) break;
  }

  const [owner, name] = repo.split('/');
  const gql = await graphqlIssue(ISSUE_QUERY, { owner, name, number });

  const timeline = [];
  let after = null;
  let total = null;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) refuse('events_too_many');
    const items = (await graphqlIssue(TIMELINE_QUERY, { owner, name, number, after })).timelineItems;
    if (!isObject(items) || !Number.isSafeInteger(items.totalCount) || !Array.isArray(items.nodes) || !isObject(items.pageInfo)) refuse('reply_shape');
    if (total !== null && items.totalCount !== total) refuse('timeline_incomplete');
    total = items.totalCount;
    timeline.push(...items.nodes);
    if (items.pageInfo.hasNextPage === false) break;
    if (items.pageInfo.hasNextPage !== true || typeof items.pageInfo.endCursor !== 'string' || !items.pageInfo.endCursor) refuse('timeline_incomplete');
    after = items.pageInfo.endCursor;
  }
  if (timeline.length !== total) refuse('timeline_incomplete');

  return { rest, events, gql, timeline, serverNow: dates.some(Number.isNaN) ? NaN : Math.max(...dates) };
}

// --- do the replies hold up? ------------------------------------------------

function checkIssueReplies({ rest, gql }, repo, number) {
  const restOk = isObject(rest) && Number.isSafeInteger(rest.id) && typeof rest.node_id === 'string' && typeof rest.state === 'string' &&
    typeof rest.title === 'string' && (typeof rest.body === 'string' || rest.body === null) && isObject(rest.user) &&
    Number.isSafeInteger(rest.user.id) && typeof rest.user.type === 'string' && typeof rest.repository_url === 'string' &&
    Array.isArray(rest.labels) && rest.labels.every((l) => isObject(l) && typeof l.name === 'string' && typeof l.node_id === 'string');
  if (!restOk) refuse('reply_shape');
  if (rest.number !== number || !rest.repository_url.toLowerCase().endsWith(`/repos/${repo.toLowerCase()}`)) refuse('wrong_issue');

  const edits = gql.userContentEdits;
  const gqlOk = typeof gql.title === 'string' && typeof gql.body === 'string' && typeof gql.state === 'string' &&
    Object.hasOwn(gql, 'lastEditedAt') && isObject(gql.author) &&
    isObject(gql.labels) && Array.isArray(gql.labels.nodes) && gql.labels.nodes.every((l) => isObject(l) && typeof l.name === 'string' && typeof l.id === 'string') &&
    isObject(edits) && Array.isArray(edits.nodes) && edits.nodes.every(isObject);
  if (!gqlOk) refuse('reply_shape');

  if (gql.labels.pageInfo?.hasNextPage !== false || gql.labels.totalCount !== gql.labels.nodes.length) refuse('labels_incomplete');
  if (edits.pageInfo?.hasNextPage !== false || edits.totalCount !== edits.nodes.length) refuse('edits_incomplete');

  if (gql.databaseId !== rest.id || gql.id !== rest.node_id || gql.number !== number || gql.state !== rest.state.toUpperCase()) refuse('disagree_issue');
  if (gql.title !== rest.title || gql.body !== (rest.body ?? '')) refuse('disagree_text');
  if (gql.author.__typename !== 'User' || rest.user.type !== 'User' || gql.author.databaseId !== rest.user.id) refuse('disagree_author');
  const labelKey = (id, name) => JSON.stringify([id, name]);
  const a = rest.labels.map((l) => labelKey(l.node_id, l.name)).sort();
  const b = gql.labels.nodes.map((l) => labelKey(l.id, l.name)).sort();
  if (a.length !== b.length || a.some((k, i) => k !== b[i])) refuse('disagree_labels');
}

const TIMELINE_TYPE = Object.freeze({ labeled: 'LabeledEvent', unlabeled: 'UnlabeledEvent', renamed: 'RenamedTitleEvent' });
const isLabelEvent = (e) => e.event === 'labeled' || e.event === 'unlabeled';

// The label and title events, in order, each as both sources saw it. If the REST pages lost any, the two lists differ.
function joinEvents(events, timeline) {
  let lastId = 0;
  let lastAt = -Infinity;
  for (const e of events) {
    if (!isObject(e) || !isId(e.id) || typeof e.node_id !== 'string' || typeof e.event !== 'string') refuse('reply_shape');
    const at = timeOf(e.created_at);
    if (e.id <= lastId || at < lastAt) refuse('events_out_of_order');
    lastId = e.id;
    lastAt = at;
    if (isLabelEvent(e) && !(isObject(e.label) && typeof e.label.name === 'string')) refuse('reply_shape');
  }
  const restRows = events.filter((e) => Object.hasOwn(TIMELINE_TYPE, e.event));
  if (restRows.length !== timeline.length) refuse('disagree_events');
  return restRows.map((rest, i) => {
    const gql = timeline[i];
    if (!isObject(gql)) refuse('reply_shape');
    if (gql.__typename !== TIMELINE_TYPE[rest.event] || gql.id !== rest.node_id || timeOf(gql.createdAt) !== timeOf(rest.created_at)) refuse('disagree_events');
    if (isLabelEvent(rest) && !(isObject(gql.label) && typeof gql.label.id === 'string' && typeof gql.label.name === 'string')) refuse('reply_shape');
    return { rest, gql, at: timeOf(rest.created_at) };
  });
}

// --- the rules --------------------------------------------------------------

function judge(facts, settings, now, why) {
  const { rest, gql } = facts;

  if (rest.state !== 'open') why.add('not_open');
  if (rest.pull_request !== undefined) why.add('is_pull_request');
  if (!settings.authorIds.includes(rest.user.id)) why.add('author_not_allowed');
  if (!rest.labels.some((l) => l.name === TASK_LABEL)) why.add('task_label_missing');
  const onIssue = rest.labels.find((l) => l.name === APPROVAL_LABEL);
  if (!onIssue) why.add('approval_label_missing');
  else if (onIssue.node_id !== settings.labelId) why.add('label_identity');

  if (!Number.isFinite(now)) why.add('clock_invalid');
  if (!Number.isFinite(facts.serverNow)) why.add('server_date_missing');
  const clocksOk = Number.isFinite(now) && Number.isFinite(facts.serverNow);
  if (clocksOk && Math.abs(now - facts.serverNow) > MAX_CLOCK_SKEW_MS) why.add('clock_skew');

  const joined = joinEvents(facts.events, facts.timeline);
  const ours = (j) => isLabelEvent(j.rest) && (j.rest.label.name === APPROVAL_LABEL || j.gql.label.name === APPROVAL_LABEL || j.gql.label.id === settings.labelId);
  const index = joined.findLastIndex(ours);
  const found = { title: rest.title, body: rest.body ?? '', textSha256: textHash(rest.title, rest.body ?? '') };
  if (index < 0) {
    why.add('no_approval_event');
    return found;
  }

  const { rest: event, gql: node, at } = joined[index];
  found.eventId = event.id;
  found.labeledAt = event.created_at;
  found.actorId = isId(event.actor?.id) ? event.actor.id : null;
  if (event.event !== 'labeled') {
    why.add('label_removed');
    return found;
  }

  if (node.label.id !== settings.labelId || event.label.name !== APPROVAL_LABEL || node.label.name !== APPROVAL_LABEL) why.add('label_identity');
  // Same-second ties count against the approval throughout: the order within a second cannot be told from these times.
  if (!(timeOf(node.label.updatedAt) < at)) why.add('label_changed_after');

  if (!isObject(event.actor) || event.actor.id !== settings.approverId) why.add('not_approver');
  if (event.actor?.type !== 'User') why.add('actor_not_user');
  if (event.performed_via_github_app !== null) why.add('via_app');
  if (!isObject(node.actor) || node.actor.__typename !== 'User' || node.actor.databaseId !== event.actor?.id) why.add('disagree_actor');

  if (gql.lastEditedAt !== null && !(timeOf(gql.lastEditedAt) < at)) why.add('edited_after');
  const edits = gql.userContentEdits;
  if (gql.lastEditedAt === null && edits.totalCount > 0) why.add('disagree_edits');
  if (edits.nodes.some((e) => !(timeOf(e.editedAt) < at))) why.add('edited_after');
  if (joined.some((j, i) => j.rest.event === 'renamed' && (i > index || j.at >= at))) why.add('renamed_after');

  if (clocksOk) {
    if (at > facts.serverNow + FUTURE_TOLERANCE_MS) why.add('event_in_future');
    // The later of the two clocks, so a machine clock set back cannot make an old approval look fresh.
    if (Math.max(now, facts.serverNow) - at >= MAX_AGE_MS) why.add('expired');
  }
  return found;
}

function checkLedger({ ledger, attempt, found, why }) {
  if (!ledger) {
    why.add('ledger_not_set');
    return;
  }
  let row;
  try {
    row = ledger.get(attempt?.eventId ?? found.eventId ?? 0); // 0 is no event: this still proves the ledger can be read
  } catch {
    why.add('ledger_unreadable');
    return;
  }
  if (!attempt) {
    if (row) why.add('already_used');
    return;
  }
  // After selection the approval's row must exist, and must be this run's.
  if (!row || row.state !== 'started' || row.run_id !== attempt.runId || row.text_sha256 !== attempt.textSha256) why.add('ledger_mismatch');
}

async function verify({ github, settings, number, ledger = null, clock = Date.now, attempt = null }) {
  const why = new Set();
  if (!settings.repo) why.add('repo_not_set');
  if (settings.approverId === null) why.add('approver_not_set');
  if (!settings.authorIds.length) why.add('authors_not_set');
  if (settings.labelId === null) why.add('label_id_not_set');
  let found = {};
  try {
    if (settings.repo) {
      const facts = await readAll(github, settings.repo, number);
      checkIssueReplies(facts, settings.repo, number);
      found = judge(facts, settings, clock(), why);
      if (attempt && found.eventId !== attempt.eventId) why.add('approval_changed');
      if (attempt && found.textSha256 !== attempt.textSha256) why.add('text_changed');
    }
  } catch (err) {
    why.add(err instanceof Refusal ? err.reason : 'internal_error');
  }
  checkLedger({ ledger, attempt, found, why });
  const reasons = [...new Set([...why].map((r) => (REASONS.includes(r) ? r : 'internal_error')))];
  const report = Object.freeze({
    approved: reasons.length === 0,
    reasons: Object.freeze(reasons),
    task: `TASK-${number}`,
    issue: number,
    eventId: found.eventId ?? null,
    actorId: found.actorId ?? null,
    labeledAt: found.labeledAt ?? null,
    textSha256: found.textSha256 ?? null,
  });
  return { report, found };
}

// For a look at an issue: a report and nothing else.
export async function checkApproval(options) {
  return (await verify(options)).report;
}

// At selection. When approved, also returns the pin: the only copy of the text the session will ever get, as this code never fetches
// it for a session again. The text is not enumerable, so logging or serializing a pin cannot print it by accident.
export async function selectApproval(options) {
  const { report, found } = await verify(options);
  if (!report.approved) return { report, pin: null };
  const pin = {
    task: report.task, issue: report.issue, eventId: report.eventId, actorId: report.actorId, labeledAt: report.labeledAt, textSha256: report.textSha256,
  };
  Object.defineProperty(pin, 'text', { value: Object.freeze({ title: found.title, body: found.body }), enumerable: false });
  return { report, pin: Object.freeze(pin) };
}

// Before any session starts. This write is what makes a crash use up the approval. Throws if the approval is already spent, or if the
// ledger cannot record it: either way no session may start.
export function beginAttempt({ ledger, pin, runId, clock = Date.now }) {
  if (!RUN_ID_RE.test(String(runId))) throw new Error('that is not a run ID');
  const started = ledger.start({
    eventId: pin.eventId, runId, task: pin.task, issue: pin.issue, actorId: pin.actorId, labeledAt: pin.labeledAt, textSha256: pin.textSha256, startedAt: clock(),
  });
  if (!started) throw new Error('that approval has already been used');
  return Object.freeze({ eventId: pin.eventId, textSha256: pin.textSha256, runId });
}

// During a run and just before publishing. The same checks, except that the ledger must now hold this run's own row, and the
// approval and the text must be the ones selected.
export async function recheckApproval(options) {
  if (!isObject(options.attempt)) throw new Error('recheckApproval needs the attempt');
  return (await verify(options)).report;
}

// The only way a report becomes text. Each value is checked again here, so the output stays free of anything an issue could put there.
export function formatReport(r) {
  const lines = [`${r.task} (issue ${r.issue}): ${r.approved ? 'APPROVED' : 'NOT APPROVED'}`];
  for (const reason of r.reasons) lines.push(`reason ${REASONS.includes(reason) ? reason : 'internal_error'}`);
  if (isId(r.eventId)) lines.push(`event ${r.eventId}`);
  if (isId(r.actorId)) lines.push(`actor ${r.actorId}`);
  if (typeof r.labeledAt === 'string' && ISO_RE.test(r.labeledAt)) lines.push(`labeled_at ${r.labeledAt}`);
  if (typeof r.textSha256 === 'string' && SHA256_RE.test(r.textSha256)) lines.push(`text_sha256 ${r.textSha256}`);
  return lines.join('\n');
}
