import { apiError, findMarkedComment, sendAuthorized, StaticToken } from '../shared/github-auth.js';

// GitHub client for the review dispatcher. Uses its OWN credentials (never the coordinator's), scoped to:
// Contents read, Pull requests read+write (needed to comment on a PR), Commit statuses write, Issues write.
export const REVIEW_MARKER = '<!-- adabra-review -->';

// The same scope, as an app token is asked for it.
export const REVIEW_PERMISSIONS = { contents: 'read', pull_requests: 'write', statuses: 'write', issues: 'write' };

export class ReviewGitHub {
  // `token` is a fine-grained token; `auth` is a GitHub App's tokens instead (shared/github-auth.js).
  constructor({ apiUrl = 'https://api.github.com', repo, token, auth = null, timeoutMs = 15_000 }) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.repo = repo;
    this.auth = auth ?? new StaticToken(token);
    this.timeoutMs = timeoutMs;
  }

  async #req(method, path, body) {
    const res = await sendAuthorized(this.auth, (token) =>
      fetch(`${this.apiUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'content-type': 'application/json',
          'user-agent': 'adabra-reviewer',
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw apiError(this.auth, res, `GitHub ${method} ${path} -> ${res.status} ${text.slice(0, 200)}`, text);
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
          base: p.base?.ref ?? 'main',
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

  // One PR as it is right now, or null when there is no such PR.
  async getPull(number) {
    let p;
    try {
      p = await this.#req('GET', `/repos/${this.repo}/pulls/${number}`);
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
    return {
      number: p.number,
      sha: p.head.sha,
      branch: p.head.ref,
      base: p.base?.ref ?? null,
      state: p.state,
      merged: Boolean(p.merged),
      author: p.user?.login ?? null,
      title: p.title,
    };
  }

  // state: pending | success | failure | error. GitHub limits description to 140 characters.
  async setStatus(sha, context, state, description) {
    await this.#req('POST', `/repos/${this.repo}/statuses/${sha}`, {
      state,
      context,
      description: String(description).slice(0, 140),
    });
  }

  // The exact commit as a .tar.gz, capped so a huge repository cannot fill memory. Needs Contents: read.
  // GitHub redirects to codeload with a short-lived URL; fetch drops our Authorization header on that hop.
  async downloadTarball(sha, maxBytes = 100 * 1024 * 1024) {
    const res = await sendAuthorized(this.auth, (token) =>
      fetch(`${this.apiUrl}/repos/${this.repo}/tarball/${sha}`, {
        signal: AbortSignal.timeout(120_000),
        headers: { authorization: `Bearer ${token}`, 'user-agent': 'adabra-reviewer', 'x-github-api-version': '2022-11-28' },
      }),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw apiError(this.auth, res, `GitHub tarball ${sha.slice(0, 12)} -> ${res.status}`, text);
    }
    const tooLarge = () => Object.assign(new Error(`Source is larger than ${Math.round(maxBytes / 1048576)} MB`), { code: 'TOO_LARGE' });
    if (Number(res.headers.get('content-length')) > maxBytes) throw tooLarge();
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > maxBytes) throw tooLarge();
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  // Files changed by exactly `sha` relative to where it branched from `base` (what the PR shows, pinned to this commit). `base` is a branch, named in full so that a
  // tag of the same name, which a PR's author can push, cannot stand in for it and shrink the diff.
  async compareFiles(base, sha) {
    const r = await this.#req('GET', `/repos/${this.repo}/compare/refs/heads/${encodeURIComponent(base)}...${sha}?per_page=100`);
    return { files: r.files ?? [], truncated: (r.files ?? []).length >= 300 };
  }

  async findReviewComment(pr) {
    return findMarkedComment({
      auth: this.auth,
      hasMarker: (body) => body.startsWith(REVIEW_MARKER),
      listPage: (page) => this.#req('GET', `/repos/${this.repo}/issues/${pr}/comments?per_page=100&page=${page}`),
    });
  }

  async createComment(pr, body) {
    return (await this.#req('POST', `/repos/${this.repo}/issues/${pr}/comments`, { body })).id;
  }

  async updateComment(commentId, body) {
    await this.#req('PATCH', `/repos/${this.repo}/issues/comments/${commentId}`, { body });
  }
}
