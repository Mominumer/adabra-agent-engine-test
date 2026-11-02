// GitHub client for the review dispatcher. Uses its OWN token (never the coordinator's), scoped to:
// Contents read, Pull requests read, Commit statuses write, Issues write (PR comments).
export const REVIEW_MARKER = '<!-- adabra-review -->';

export class ReviewGitHub {
  constructor({ apiUrl = 'https://api.github.com', repo, token, timeoutMs = 15_000 }) {
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
        'user-agent': 'adabra-reviewer',
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

  // Open PRs, reduced to what the dispatcher needs.
  async openPulls() {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const list = await this.#req('GET', `/repos/${this.repo}/pulls?state=open&per_page=100&page=${page}`);
      for (const p of list) {
        out.push({
          number: p.number,
          sha: p.head.sha,
          branch: p.head.ref,
          head_repo: p.head.repo?.full_name ?? null, // null when the fork was deleted
          author: p.user?.login ?? null,
          title: p.title,
          body: p.body ?? '',
          draft: Boolean(p.draft),
        });
      }
      if (list.length < 100) break;
    }
    return out;
  }

  // state: pending | success | failure | error. GitHub limits description to 140 characters.
  async setStatus(sha, context, state, description) {
    await this.#req('POST', `/repos/${this.repo}/statuses/${sha}`, {
      state,
      context,
      description: String(description).slice(0, 140),
    });
  }

  async findReviewComment(pr) {
    for (let page = 1; page <= 10; page++) {
      const list = await this.#req('GET', `/repos/${this.repo}/issues/${pr}/comments?per_page=100&page=${page}`);
      const hit = list.find((c) => typeof c.body === 'string' && c.body.startsWith(REVIEW_MARKER));
      if (hit) return hit.id;
      if (list.length < 100) break;
    }
    return null;
  }

  async createComment(pr, body) {
    return (await this.#req('POST', `/repos/${this.repo}/issues/${pr}/comments`, { body })).id;
  }

  async updateComment(commentId, body) {
    await this.#req('PATCH', `/repos/${this.repo}/issues/comments/${commentId}`, { body });
  }
}
