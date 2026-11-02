import { plain } from '../shared/sanitize.js';

// Checks that need no model, run on what GitHub says the PR changes. They can only block: no result here is ever a pass, and a
// model's verdict cannot undo them. The list for a human to read goes in the comment and blocks nothing.
export const LIMITS = { files: 100, diffBytes: 256 * 1024 };

// Extensions a changed file may have when GitHub will not show it: things that are not code. REVIEW_UNSHOWN_OK replaces the list.
export const UNSHOWN_OK = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'otf', 'eot'];

const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
// Bidi controls that reorder what a reader sees, and tag characters a reader cannot see at all.
const HIDDEN = /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{E0000}-\u{E007F}]/u;
// Legitimate in emoji and some scripts, so these are for a person to look at, not a reason to block.
const ZERO_WIDTH = /[\u{061C}\u{200B}-\u{200F}\u{2060}\u{FEFF}]/u;
const ATTENTION_MAX = 50;

const READ_YOURSELF = [
  /^reviewer\//, /^service\//, /^coordinator\//, /^\.github\//,
  /(^|\/)\.claude\//i, /(^|\/)claude(\.local)?\.md$/i, /(^|\/)agents\.md$/i, /(^|\/)\.mcp\.json$/i,
  /(^|\/)package\.json$/, /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
  /(^|\/)(tests?|__tests__)\//, /\.(test|spec)\.[^/]+$/,
];

// Line numbers (in the new file) of every line the patch adds.
export function addedLines(patch) {
  const out = [];
  let line = 0;
  for (const l of (patch ?? '').split('\n')) {
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (l.startsWith('+')) out.push({ line: line++, text: l.slice(1) });
    else if (l.startsWith(' ')) line++;
    // '-' lines and '\ No newline' do not exist in the new file
  }
  return out;
}

// One blocker for each added debugger statement. The mock review uses the same rule. Built from two parts, because this repository
// is itself reviewed by the rule, and the rule's own source must not look like what it blocks.
export const DEBUG_STATEMENT = ['debug', 'ger;'].join('');

export function debuggerFindings(file) {
  return addedLines(file.patch)
    .filter((a) => a.text.includes(DEBUG_STATEMENT))
    .map((a) => ({ file: file.filename, line: a.line, severity: 'blocker', message: `Leftover \`${DEBUG_STATEMENT}\` statement.` }));
}

const extensionOf = (name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

// A file GitHub will not show cannot be reviewed, so a PR could hide code in one. These are the cases with nothing to hide.
function unshownIsFine(f, allowed) {
  if (f.status === 'removed') return true;
  if (f.status === 'renamed' && f.changes === 0) return true;
  if (f.sha === EMPTY_BLOB) return true;
  return allowed.has(extensionOf(f.filename));
}

// { files, truncated } as compareFiles returns them, plus the PR's title and body, which also reach the model.
// Returns { tooLarge, blockers: findings, attention: lines for the comment }.
export function preCheck({ files, truncated = false, title = '', body = '', unshownOk = UNSHOWN_OK }) {
  const allowed = new Set(unshownOk);
  const blockers = [];
  const attention = [];
  const diffBytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.patch ?? ''), 0);
  // A listing can stop at exactly the limit, so reaching it counts as over: a short look must never pass as a full one.
  const tooLarge = truncated || files.length >= LIMITS.files || diffBytes > LIMITS.diffBytes;

  if (HIDDEN.test(`${title}\n${body}`)) {
    blockers.push({ file: null, line: null, severity: 'blocker', message: 'The PR title or description holds hidden Unicode (bidi controls or tag characters).' });
  }
  for (const f of files) {
    const names = [f.filename, f.previous_filename].filter(Boolean);
    if (names.some((n) => HIDDEN.test(n))) {
      blockers.push({ file: null, line: null, severity: 'blocker', message: 'A changed file\'s name holds hidden Unicode (bidi controls or tag characters).' });
    }
    if (names.some((n) => READ_YOURSELF.some((p) => p.test(n)))) attention.push(f.filename);
    if (f.patch === undefined) {
      attention.push(`${f.filename} (not shown by GitHub)`);
      if (!unshownIsFine(f, allowed)) {
        blockers.push({ file: f.filename, line: null, severity: 'blocker', message: 'GitHub will not show this changed file, so it cannot be reviewed.' });
      }
      continue;
    }
    blockers.push(...debuggerFindings(f));
    for (const a of addedLines(f.patch)) {
      if (HIDDEN.test(a.text)) {
        blockers.push({ file: f.filename, line: a.line, severity: 'blocker', message: 'Added line holds hidden Unicode (bidi controls or tag characters).' });
      } else if (ZERO_WIDTH.test(a.text)) {
        attention.push(`${f.filename}:${a.line} (zero-width character)`);
      }
    }
  }
  const shown = attention.slice(0, ATTENTION_MAX);
  if (attention.length > ATTENTION_MAX) shown.push(`and ${attention.length - ATTENTION_MAX} more`);
  return { tooLarge, blockers: blockers.slice(0, 50), attention: shown };
}

// The input the review step reads. Everything in it comes from the PR; the job directory keeps it apart from the instructions.
export function diffText(files) {
  return files
    .map((f) => `--- ${plain(f.previous_filename ?? f.filename)}\n+++ ${plain(f.filename)}\n${f.patch ?? '(GitHub did not show this file)'}\n`)
    .join('\n');
}
