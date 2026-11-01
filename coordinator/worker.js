import { renderComment } from './github.js';

// Applies stored events to GitHub. Retries with backoff; never regresses a task
// to an older event (events are applied in timestamp order per task).
export class Worker {
  constructor({ store, github, log = () => {} }) {
    this.store = store;
    this.github = github;
    this.log = log;
    this.timer = null;
    this.running = false;
  }

  start(intervalMs = 2000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      const failedTasks = new Set();
      for (const row of this.store.dueEvents(now)) {
        // If an earlier event for this task failed this round, wait: keep order.
        if (failedTasks.has(row.task_id)) continue;
        const event = JSON.parse(row.payload);
        try {
          await this.#apply(event);
        } catch (err) {
          failedTasks.add(row.task_id);
          const dead = this.store.markFailed(row.event_id, err.message, now);
          this.log(`${dead ? 'DEAD' : 'retry'} ${row.event_id}: ${err.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async #apply(event) {
    const task = this.store.getTask(event.task_id);
    if (!task) throw new Error(`no issue mapping for ${event.task_id}`);

    if (task.applied_ts && Date.parse(event.ts) <= Date.parse(task.applied_ts)) {
      this.store.markSkipped(event.event_id, 'older than the applied state');
      return;
    }

    const body = renderComment(event);
    let commentId = task.comment_id;
    if (commentId) {
      try {
        await this.github.updateComment(commentId, body);
      } catch (err) {
        // The remembered comment is gone (deleted, or an id from another repo). Look it up again.
        if (err.status !== 404) throw err;
        this.log(`comment ${commentId} for ${event.task_id} not found; looking it up again`);
        this.store.setTaskComment(event.task_id, null);
        commentId = null;
      }
    }
    if (!commentId) {
      commentId = await this.github.findProgressComment(task.issue_number, event.task_id);
      if (!commentId) commentId = await this.github.createComment(task.issue_number, body);
      else await this.github.updateComment(commentId, body);
      this.store.setTaskComment(event.task_id, commentId);
    }
    this.store.setTaskApplied(event.task_id, event.ts);
    this.store.markDone(event.event_id);
    this.log(`applied ${event.event_id} to ${event.task_id}`);
  }
}
