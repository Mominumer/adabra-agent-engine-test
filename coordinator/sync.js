// Mirrors GitHub issues into tasks. An issue becomes TASK-<number> when it carries the `agent-task` label.
// An `assign:<device-id>` label reserves it for that enrolled device; no such label means anyone may claim it.
// Closing the issue (or removing the label) closes the task. Pull requests are ignored.
export const TASK_LABEL = 'agent-task';
const ASSIGN_PREFIX = 'assign:';

export async function syncTasks({ store, github, log = () => {} }) {
  const issues = await github.listIssues(TASK_LABEL);
  let created = 0;
  let updated = 0;
  const seen = new Set();
  for (const issue of issues) {
    if (issue.pull_request) continue;
    seen.add(issue.number);
    const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
    const wanted = labels.find((l) => l.startsWith(ASSIGN_PREFIX))?.slice(ASSIGN_PREFIX.length) ?? null;
    let assignee = null;
    if (wanted) {
      if (store.hasActiveDevice(wanted)) assignee = wanted;
      else log(`issue #${issue.number}: label names unknown or revoked device "${wanted}"; leaving it unassigned`);
    }
    const existing = store.getTaskByIssue(issue.number);
    if (existing && existing.source !== 'github') continue; // added by hand: the operator owns it
    const taskId = existing?.task_id ?? `TASK-${issue.number}`;
    const closed = issue.state === 'closed';
    const changed = !existing || existing.title !== issue.title || existing.assignee !== assignee || Boolean(existing.closed) !== closed;
    if (changed) {
      store.upsertSyncedTask(taskId, issue.number, { title: issue.title, assignee, closed });
      existing ? updated++ : created++;
    }
  }
  // A synced task whose issue no longer carries the label is closed, not forgotten.
  for (const t of store.db.prepare("SELECT * FROM tasks WHERE source = 'github' AND closed = 0").all()) {
    if (!seen.has(t.issue_number)) {
      store.upsertSyncedTask(t.task_id, t.issue_number, { title: t.title, assignee: t.assignee, closed: true });
      updated++;
    }
  }
  if (created || updated) log(`task sync: ${created} created, ${updated} updated`);
  return { created, updated };
}
