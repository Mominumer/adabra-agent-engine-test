import { renderComment } from './github.js';
import { AUTH_HOLD_MS, upsertComment } from '../shared/github-auth.js';

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
          // Our own credentials are out, which says nothing about this event: it waits, however long that takes, and no attempt is used.
          if (err.authOutage) {
            this.store.holdEvent(row.event_id, err.message, now + AUTH_HOLD_MS);
            this.log(`held ${row.event_id}, not counted as an attempt: ${err.message}`);
            continue;
          }
          const dead = this.store.markFailed(row.event_id, err.message, now);
          this.log(`${dead ? 'DEAD' : 'retry'} ${row.event_id}: ${err.message}`);
        }
      }
      for (const row of this.store.dueReviewComments(now)) {
        if (failedTasks.has(row.task_id)) continue; // GitHub just refused this task's comment: back off with the event
        try {
          await this.#applyReview(row);
        } catch (err) {
          this.store.reviewCommentFailed(row.task_id, row.result_id, err.message, now);
          this.log(`retry review ${row.result_id}: ${err.message}`);
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

    await this.#writeComment(task, renderComment(event, this.store.reviewForComment(event.task_id)));
    this.store.setTaskApplied(event.task_id, event.ts);
    this.store.markDone(event.event_id);
    this.log(`applied ${event.event_id} to ${event.task_id}`);
  }

  // A review result never takes part in the ordering of checkpoints above: reviewer and builder clocks differ.
  async #applyReview({ task_id: taskId, result_id: resultId }) {
    const review = this.store.reviewForComment(taskId);
    await this.#writeComment(this.store.getTask(taskId), renderComment(this.store.lastAppliedEvent(taskId), review));
    this.store.reviewCommentDone(taskId, resultId);
    this.log(`applied review ${resultId} to ${taskId}: ${review.verdict}`);
  }

  async #writeComment(task, body) {
    const id = await upsertComment({
      remembered: task.comment_id,
      label: task.task_id,
      log: this.log,
      find: () => this.github.findProgressComment(task.issue_number, task.task_id),
      update: (commentId) => this.github.updateComment(commentId, body),
      create: () => this.github.createComment(task.issue_number, body),
    });
    if (id !== task.comment_id) this.store.setTaskComment(task.task_id, id);
  }
}
