import { execFile } from 'node:child_process';
import { sendAuthorized } from '../shared/github-auth.js';

// Two ways for the approval check to read GitHub. Each offers only `get` and a read-only `graphql`, so nothing built on this can
// change anything there. A reply is { status, headers: { date, link }, text }. Anything else is an exception whose message is
// never shown, because it may quote what GitHub or the network sent.
export const MAX_REPLY_BYTES = 8 * 1024 * 1024;

const API_VERSION = '2022-11-28';
const TIMEOUT_MS = 15_000;

function queryOnly(query) {
  if (!/^query\b/.test(query)) throw new Error('only a query may be sent');
}

async function cappedText(res) {
  const chunks = [];
  let size = 0;
  for await (const c of res.body ?? []) {
    size += c.length;
    if (size > MAX_REPLY_BYTES) throw new Error('reply too large');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// A token: `auth` is shared/github-auth.js's StaticToken or AppTokens. A redirect is an error, so the token follows no address
// that came from a reply, and a moved issue never reads as the one asked for.
export function tokenReader({ auth, apiUrl = 'https://api.github.com', timeoutMs = TIMEOUT_MS }) {
  const base = apiUrl.replace(/\/$/, '');
  const send = async (method, path, body) => {
    const res = await sendAuthorized(auth, (token) =>
      fetch(`${base}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': API_VERSION,
          'content-type': 'application/json',
          'user-agent': 'adabra-night',
        },
        body,
      }),
    );
    return { status: res.status, headers: { date: res.headers.get('date'), link: res.headers.get('link') }, text: await cappedText(res) };
  };
  return {
    get: (path) => send('GET', path),
    graphql: async (query, variables) => {
      queryOnly(query);
      return send('POST', '/graphql', JSON.stringify({ query, variables }));
    },
  };
}

// `gh api --include` prints the status line, the headers, a blank line and the body.
export function parseGhReply(out) {
  const gap = /\r?\n\r?\n/.exec(out);
  if (!gap) throw new Error('no headers');
  const [first, ...rest] = out.slice(0, gap.index).split(/\r?\n/);
  const status = /^HTTP\/[\d.]+ (\d{3})\b/.exec(first);
  if (!status) throw new Error('no status');
  const headers = { date: null, link: null };
  for (const line of rest) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).trim().toLowerCase();
    if (at > 0 && Object.hasOwn(headers, name)) headers[name] = line.slice(at + 1).trim();
  }
  return { status: Number(status[1]), headers, text: out.slice(gap.index + gap[0].length) };
}

const runGh = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_REPLY_BYTES,
      env: { ...process.env, GH_PAGER: 'cat', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

// The `gh` login already on this machine, for trying the check by hand. The real check will use a token.
export function ghReader({ run = runGh } = {}) {
  return {
    get: async (path) => parseGhReply(await run(['api', '--include', '--method', 'GET', path.replace(/^\//, '')])),
    graphql: async (query, variables) => {
      queryOnly(query);
      const fields = Object.entries(variables)
        .filter(([, v]) => v !== null)
        .flatMap(([k, v]) => [typeof v === 'number' ? '-F' : '-f', `${k}=${v}`]);
      return parseGhReply(await run(['api', '--include', 'graphql', '-f', `query=${query}`, ...fields]));
    },
  };
}
