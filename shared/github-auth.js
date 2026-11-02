import { createPrivateKey, sign } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// How a service proves who it is to GitHub: a token from a file (the default), or a GitHub App installation token that is
// minted, cached and renewed here. Settings choose: none of the app settings means the token file, any of them means the app,
// and an app that is not fully and correctly set up stops the service at start. There is no fallback from one to the other.
//
// The key and the tokens live in private fields, and every message that leaves this file has been through scrub().

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_VERSION = '2022-11-28';
const JWT_PAST_S = 60; // iat: GitHub's advice, to allow for clock drift
const JWT_AHEAD_S = 540; // exp: GitHub refuses more than 10 minutes ahead; 9 leaves room for a clock running a little fast
const REFRESH_MARGIN_MS = 5 * 60_000; // longer than any one request here may take (the tarball download's limit is 2 minutes)
const MIN_REUSE_MS = 60_000; // with a badly wrong clock every token looks nearly expired: do not mint one per request
const MAX_MINT_WAIT_MS = 60_000;
const MAX_KEY_BYTES = 64 * 1024;
const ID_RE = /^[1-9]\d{0,19}$/;
const APP_ID_RE = /^(?:[1-9]\d{0,19}|Iv[A-Za-z0-9._-]{1,60})$/; // the app ID, or its client ID: GitHub takes either as issuer
const REPO_RE = /^[^/\s]+\/([^/\s]+)$/;
const HEADER_SAFE_RE = /^[\x21-\x7e]+$/; // anything else makes fetch throw an error that quotes the header's value

// How long held work waits before it is tried again. Short, so a fixed credential is noticed quickly: nothing is counted
// meanwhile, and during an outage the attempt fails here without touching the network (see #refresh).
export const AUTH_HOLD_MS = 30_000;

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*){0,2}/g, // a JWT, whole or cut short
  /github_pat_[A-Za-z0-9_]+/g,
  /\bgh[a-z]_[A-Za-z0-9_.-]+/g,
  /\bBearer\s+\S+/gi,
];

// For anything GitHub or the network sends back, which ends up in logs and in the database.
export function scrub(text) {
  return SECRETS.reduce((s, re) => s.replace(re, '[hidden]'), String(text));
}

// A service must not start like this. Says which setting and why, never what the key file holds.
export class GitHubSettingsError extends Error {}

// Our own credentials are out, so GitHub cannot be told anything by anyone here. This says nothing about the work in hand.
// Holds no `status` on purpose: callers treat a 404 as "that comment is gone", and a 404 from here means something else.
class GitHubAuthError extends Error {
  authOutage = true;
}

// --- the default: a token from a file --------------------------------------
export class StaticToken {
  renewable = false;
  #value;
  constructor(value) {
    this.#value = value;
  }

  async token() {
    return this.#value;
  }

  describe() {
    return 'token file';
  }
}

// --- a GitHub App ----------------------------------------------------------
const MINT_HINTS = {
  401: "check the app ID, that this key belongs to that app, and this machine's clock",
  403: 'the app may be suspended, or GitHub is limiting requests',
  404: 'check the installation ID, and that the app is still installed',
  422: 'the app lacks a permission this service asks for, or the repository is not in the installation',
};
const list = (permissions) => Object.entries(permissions).map(([k, v]) => `${k}=${v}`).join(', ');

export class AppTokens {
  renewable = true;
  #appId;
  #installationId;
  #key;
  #body;
  #permissions;
  #apiUrl;
  #now;
  #timeoutMs;
  #marginMs;
  #held = null; // { value, refreshAt, expiresAt, expires_at, permissions }
  #refreshing = null;
  #failures = 0;
  #waitUntil = 0;
  #lastFailure = null;

  constructor({ appId, installationId, key, repoName, permissions, apiUrl = 'https://api.github.com', now = Date.now, timeoutMs = 10_000, marginMs = REFRESH_MARGIN_MS }) {
    this.#appId = String(appId);
    this.#installationId = String(installationId);
    this.#key = key;
    this.#permissions = permissions;
    // This one repository and these permissions only, whatever else the app or its installation could reach.
    this.#body = JSON.stringify({ repositories: [repoName], permissions });
    this.#apiUrl = apiUrl.replace(/\/$/, '');
    this.#now = now;
    this.#timeoutMs = timeoutMs;
    this.#marginMs = marginMs;
  }

  async token() {
    const held = this.#held;
    if (held && this.#now() < held.refreshAt) return held.value;
    try {
      return await this.#refresh();
    } catch (err) {
      // A refresh that failed early is not an outage yet: the old token is good until it really expires.
      if (held && this.#held === held && this.#now() < held.expiresAt) return held.value;
      throw err;
    }
  }

  // GitHub refused this token. Only the token that was refused is dropped: a caller arriving late must not throw away the
  // new one that another caller has just fetched.
  invalidate(value) {
    if (this.#held?.value === value) this.#held = null;
  }

  // Concurrent callers share one request. After a failure, callers share its error until the wait is over.
  #refresh() {
    if (this.#refreshing) return this.#refreshing;
    if (this.#now() < this.#waitUntil) return Promise.reject(this.#lastFailure);
    this.#refreshing = this.#mint().then(
      (value) => {
        this.#failures = 0;
        this.#waitUntil = 0;
        this.#lastFailure = null;
        return value;
      },
      (err) => {
        this.#failures++;
        this.#waitUntil = this.#now() + Math.min(MAX_MINT_WAIT_MS, 5000 * 2 ** (this.#failures - 1));
        this.#lastFailure = err;
        throw err;
      },
    ).finally(() => {
      this.#refreshing = null;
    });
    return this.#refreshing;
  }

  #jwt() {
    const nowS = Math.floor(this.#now() / 1000);
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: nowS - JWT_PAST_S, exp: nowS + JWT_AHEAD_S, iss: this.#appId })}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), this.#key).toString('base64url')}`;
  }

  async #mint() {
    const label = `GitHub App token for installation ${this.#installationId}`;
    const failed = (why) => new GitHubAuthError(scrub(`${label}: ${why}`));
    let res;
    let text;
    try {
      res = await fetch(`${this.#apiUrl}/app/installations/${this.#installationId}/access_tokens`, {
        method: 'POST',
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          authorization: `Bearer ${this.#jwt()}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          'content-type': 'application/json',
          'user-agent': 'adabra-agent-engine',
        },
        body: this.#body,
      });
      text = await res.text();
    } catch (err) {
      throw failed(`GitHub could not be reached (${err.cause?.code ?? err.name})`);
    }
    let reply = {};
    try {
      reply = JSON.parse(text);
    } catch {
      // judged below: a refusal says so by its status, and a success with no token is no success
    }
    if (!res.ok) {
      const hint = MINT_HINTS[res.status];
      throw failed(`refused with ${res.status} ${String(reply?.message ?? '').slice(0, 200)}${hint ? ` (${hint})` : ''}`);
    }
    const expiresAt = Date.parse(reply?.expires_at);
    if (typeof reply?.token !== 'string' || !HEADER_SAFE_RE.test(reply.token) || !Number.isFinite(expiresAt)) throw failed('GitHub sent back no usable token');
    const differs = Object.entries(this.#permissions).filter(([k, v]) => reply.permissions && reply.permissions[k] !== v).map(([k]) => k);
    if (differs.length) throw failed(`GitHub did not grant what this service asked for: ${differs.join(', ')}`);
    const now = this.#now();
    this.#held = {
      value: reply.token,
      expiresAt,
      refreshAt: Math.max(expiresAt - this.#marginMs, now + MIN_REUSE_MS),
      expires_at: reply.expires_at,
      permissions: reply.permissions ?? this.#permissions,
    };
    return reply.token;
  }

  // Did this app write that comment? Only the app's own comments are certain to be editable after a change of identity.
  wrote(comment) {
    const app = comment?.performed_via_github_app;
    return Boolean(app) && (String(app.id) === this.#appId || app.client_id === this.#appId);
  }

  describe() {
    return `GitHub App ${this.#appId}, installation ${this.#installationId}, asking for ${list(this.#permissions)}`;
  }

  // What the current token can do and when it expires. Never the token.
  granted() {
    return this.#held ? { expires_at: this.#held.expires_at, permissions: this.#held.permissions } : null;
  }
}

function loadKey(setting, path, repoDir) {
  const refuse = (why) => new GitHubSettingsError(`${setting} (${path}) ${why}`);
  if (!isAbsolute(path)) throw refuse('must be an absolute path');
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    throw refuse(`cannot be read: ${err.code}`);
  }
  if (!st.isFile()) throw refuse('must be a regular file, not a link or a folder');
  if (st.mode & 0o077) throw refuse(`can be reached by group or others (mode ${(st.mode & 0o777).toString(8)}); run chmod 600 on it`);
  if (process.getuid && st.uid !== process.getuid()) throw refuse('must belong to the user running this service');
  if (st.size > MAX_KEY_BYTES) throw refuse('is too large to be a private key');
  const inRepo = relative(realpathSync(repoDir), realpathSync(path));
  if (inRepo !== '..' && !inRepo.startsWith(`..${sep}`) && !isAbsolute(inRepo)) throw refuse('is inside the repository; keep it outside, for example in ~/.adabra');
  let key;
  try {
    key = createPrivateKey(readFileSync(path));
  } catch (err) {
    throw refuse(err.code === 'EACCES' ? 'cannot be read: EACCES' : 'does not hold a usable private key'); // OpenSSL's words stay out of it
  }
  if (key.asymmetricKeyType !== 'rsa') throw refuse('is not an RSA key, which is what GitHub issues');
  return key;
}

// `prefix` is the service's own: GITHUB_APP_* for the coordinator and REVIEW_APP_* for the reviewer. Neither reads the other's.
// Returns null when none of them is set, and then the service uses its token file. Throws GitHubSettingsError for anything
// else that is not complete and valid. All of this is local: whether GitHub accepts it shows on the first request, because a
// refusal then (a bad day at GitHub, a clock) must not take the service down. `github-check` asks before a switchover.
export function appAuthFromEnv({ prefix, repo, permissions, env = process.env, repoDir = REPO_DIR, ...options }) {
  const names = { appId: `${prefix}_APP_ID`, installationId: `${prefix}_APP_INSTALLATION_ID`, keyFile: `${prefix}_APP_KEY_FILE` };
  const value = (name) => (env[name] ?? '').trim();
  const missing = Object.values(names).filter((n) => !value(n));
  if (missing.length === Object.keys(names).length) return null;
  if (missing.length) throw new GitHubSettingsError(`GitHub App settings are incomplete: ${missing.join(', ')} not set. Set all three, or none to use the token file.`);
  if (!APP_ID_RE.test(value(names.appId))) throw new GitHubSettingsError(`${names.appId} is not an app ID`);
  if (!ID_RE.test(value(names.installationId))) throw new GitHubSettingsError(`${names.installationId} is not an installation ID`);
  const repoName = REPO_RE.exec(repo ?? '')?.[1];
  if (!repoName) throw new GitHubSettingsError('GITHUB_REPO must be owner/name to use a GitHub App');
  return new AppTokens({
    appId: value(names.appId),
    installationId: value(names.installationId),
    key: loadKey(names.keyFile, value(names.keyFile), repoDir),
    repoName,
    permissions,
    ...options,
  });
}

// --- what both GitHub clients share ----------------------------------------

// One request with the current token. On a 401 a token that can be renewed is renewed once and the request tried once more,
// and a second 401 goes back to the caller. `send` gets the token, and sets its own timeout as it may be called twice.
export async function sendAuthorized(auth, send) {
  const token = await auth.token();
  const res = await send(token);
  if (res.status !== 401 || !auth.renewable) return res;
  await res.body?.cancel().catch(() => {});
  auth.invalidate(token);
  return send(await auth.token());
}

// A 403 is three different things, and they call for three different responses:
//   rate limit      -> the ordinary retry. Above all not `refused`: a fresh comment on every limited edit would be spam.
//   `refused`       -> this identity may not do this. An edit moves to a new comment instead (see upsertComment).
//   `authOutage`    -> also the token lacks a permission: a human has to fix the app, and the work must wait for that.
// A token from a file is never an `authOutage`: its accounting stays as it always was.
export function apiError(auth, res, message, text = '') {
  const err = new Error(scrub(message));
  err.status = res.status;
  const limited = res.headers.get('retry-after') !== null || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(text);
  if (res.status === 403 && !limited) err.refused = true;
  if (auth.renewable && (res.status === 401 || (err.refused && /resource not accessible/i.test(text)))) err.authOutage = true;
  return err;
}

// The comment holding a marker. Nothing here looks at who wrote it, so comments from an earlier identity are still found.
// A token from a file takes the first, as it always has. An app prefers the newest of its own, which is the one it can
// certainly edit after moving off a comment it was refused, and otherwise takes the first, which may be from the old identity.
export async function findMarkedComment({ auth, hasMarker, listPage }) {
  let first = null;
  let own = null;
  for (let page = 1; page <= 10; page++) {
    const comments = await listPage(page);
    for (const c of comments) {
      if (typeof c.body !== 'string' || !hasMarker(c.body)) continue;
      if (auth.wrote?.(c)) own = c.id;
      else first ??= c.id;
    }
    if (first && !auth.wrote) break;
    if (comments.length < 100) break;
  }
  return own ?? first;
}

// Writes a service's one comment and returns its id: the remembered comment, else the one found by marker, else a new one.
// After a change of identity GitHub might refuse an edit of a comment the previous identity wrote. Retrying could never help,
// so that comment is left as it stands and the work moves to a new one, which this identity can edit from then on.
export async function upsertComment({ remembered, find, update, create, label, log = () => {} }) {
  const edited = async (id) => {
    try {
      await update(id);
      return true;
    } catch (err) {
      if (err.refused) log(`GitHub refused an edit of comment ${id} for ${label} (${err.status}); moving to a comment this identity can edit`);
      else if (err.status === 404 && id === remembered) log(`comment ${id} for ${label} not found; looking it up again`);
      else throw err;
      return false;
    }
  };
  if (remembered && (await edited(remembered))) return remembered;
  const found = await find();
  if (found && found !== remembered && (await edited(found))) return found;
  return create();
}

// The `github-check` command: asks GitHub whether these settings work, using reads only. Prints what it finds, never a secret.
export async function gitHubCheck({ auth, read, print = console.log }) {
  try {
    print(`GitHub auth: ${auth.describe()}`);
    await auth.token();
    const granted = auth.granted?.();
    if (granted) print(`token issued: expires ${granted.expires_at}, can do ${list(granted.permissions)}`);
    print(await read());
    print('github-check passed');
    return true;
  } catch (err) {
    print(`github-check FAILED: ${scrub(err.message)}`);
    return false;
  }
}
