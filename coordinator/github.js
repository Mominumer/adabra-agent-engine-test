// Minimal GitHub client: one progress comment per task, found by a hidden marker
// so a crash between "create" and "remember the id" cannot produce duplicates.

export function marker(taskId) {
  return `<!-- adabra-progress:${taskId} -->`;
}

export function renderComment(event) {
  const commit = event.source_commit ? `\`${event.source_commit.slice(0, 12)}\`` : 'none';
  const unpushed =
    event.unpushed_commits === null
      ? 'unknown'
      : event.unpushed_commits === 0
        ? 'none'
        : `${event.unpushed_commits} commit(s) exist only on the laptop`;
  return [
    marker(event.task_id),
    `**${event.task_id}: ${event.status}**`,
    '',
    event.summary,
    '',
    `- Verification: ${event.verification || 'not reported'}`,
    `- Next action: ${event.next_action || 'not reported'}`,
    `- Source commit: ${commit}`,
    `- Unpublished work: ${unpushed}`,
    `- Device: ${event.device_id} · run ${event.run_id} · claim generation ${event.claim_generation}`,
    `- Updated: ${event.ts}`,
  ].join('\n');
}

export class GitHubClient {
  constructor({ apiUrl = 'https://api.github.com', repo, token, timeoutMs = 10_000 }) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.repo = repo;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async #req(method, path, body) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'adabra-agent-engine-test',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitHub ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  }

  async findProgressComment(issue, taskId) {
    const m = marker(taskId);
    for (let page = 1; page <= 10; page++) {
      const list = await this.#req(
        'GET',
        `/repos/${this.repo}/issues/${issue}/comments?per_page=100&page=${page}`,
      );
      const hit = list.find((c) => typeof c.body === 'string' && c.body.startsWith(m));
      if (hit) return hit.id;
      if (list.length < 100) break;
    }
    return null;
  }

  // Open and closed issues with a label (pull requests are included by GitHub and must be filtered by the caller).
  async listIssues(label) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const list = await this.#req(
        'GET',
        `/repos/${this.repo}/issues?labels=${encodeURIComponent(label)}&state=all&per_page=100&page=${page}`,
      );
      out.push(...list);
      if (list.length < 100) break;
    }
    return out;
  }

  async createComment(issue, body) {
    return (await this.#req('POST', `/repos/${this.repo}/issues/${issue}/comments`, { body })).id;
  }

  async updateComment(commentId, body) {
    await this.#req('PATCH', `/repos/${this.repo}/issues/comments/${commentId}`, { body });
  }
}
