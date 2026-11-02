import { LIMITS } from '../reviewer/precheck.js';
import { scrub } from '../shared/github-auth.js';

// The overnight session's diff is hostile text. Nothing here runs it, and nothing here reports what it says: a refusal is one word from
// RULES, the file's place in the diff, and for a protected path one word from PROTECTED_WORDS. A path the session chose is text it chose,
// so a refusal never repeats it.
//
// The classic attack on a check like this is a patch that means one thing to the checker and another to `git apply`. So there are three
// layers, and each one assumes the one before it was fooled:
//
//   1. validateDiff: a parser for exactly what `git diff --cached --no-ext-diff --no-textconv --no-renames --no-color` prints, and nothing
//      else. `git apply` skips text it does not understand and accepts old-style patches. This parser refuses them. So what it accepts is
//      a strict subset of what git reads, with no line either side can read as anything else.
//   2. agreeWithGit: git's own reading of the same bytes, before anything is applied. Every file, line count, creation and deletion must
//      match, in order.
//   3. agreeWithTree: what the patch actually did. The result is compared with the parser's list, its blobs with the hashes the diff
//      named, and git's own diff of the result goes through layer 1 again. That diff is what would be published, so the rules end up
//      judging the result and not the session's description of it.
//
// A diff that a person might consider fine can be refused here. That is the intended side of the mistake: tasks that need these paths or
// these file names are not for this runner in v1, and a refusal costs one approval, which only the operator can give again.
export const MAX_DIFF_BYTES = LIMITS.diffBytes;
export const MAX_FILES = LIMITS.files; // reaching it counts as over, as it does for the reviewer, so a night PR is never too large to review
const MAX_PATH = 200;
const MAX_SEGMENT = 100;

export const RULES = Object.freeze([
  'no_changes', 'too_large', 'too_many_files', 'not_utf8', 'binary', 'unparsed', 'path_unsafe', 'path_collision', 'protected_path',
  'symlink', 'submodule', 'mode_change', 'mode_unknown', 'rename_or_copy', 'credential', 'git_disagrees', 'does_not_apply',
]);
export const PROTECTED_WORDS = Object.freeze(['.git*', '.github/', '.claude/', 'CODEOWNERS', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.mcp.json', '.task/']);

const refused = (rule, file = null, word = null) => Object.freeze({ ok: false, rule, file, word });

// Compared after folding, as clean-worker.cjs does: the disk here ignores case and Unicode form, so AGENTS.md, agents.md and AGENTſ.md (a
// long s) can all open as one file. Characters that some file systems ignore altogether go first.
const fold = (s) => s.replace(/\p{C}/gu, '').normalize('NFKC').toLowerCase().normalize('NFKC');
const EXACT = new Map([
  ['.github', '.github/'], ['.claude', '.claude/'], ['codeowners', 'CODEOWNERS'], ['claude.md', 'CLAUDE.md'], ['claude.local.md', 'CLAUDE.local.md'],
  ['agents.md', 'AGENTS.md'], ['.mcp.json', '.mcp.json'], ['.task', '.task/'],
]);

// The word for the protected name in this path, at any depth, or null. `git~1` is how .git can be spelt on a disk with short names.
export function protectedWord(path) {
  for (const segment of String(path).split('/')) {
    const f = fold(segment);
    if (EXACT.has(f)) return EXACT.get(f);
    if (f.startsWith('.git') || f === 'git~1') return '.git*';
  }
  return null;
}

// What this file finds in a credential's shape, beyond shared/github-auth.js's scrub(): the model account's keys and tokens, and API keys
// in general. It catches these shapes and no others: a token split in two or encoded passes. It is here to stop an accident or a lazy
// attempt to publish a secret, and is not what keeps one secret.
const CREDENTIAL_SHAPES = [
  /sk-ant-/,
  /\bsk-[A-Za-z0-9_-]{20,}/,
  /\b[rs]k_live_[A-Za-z0-9]{10,}/,
  /\bA(?:KIA|SIA)[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
];
export const credentialShaped = (text) => scrub(text) !== text || CREDENTIAL_SHAPES.some((re) => re.test(text));

// A narrow alphabet on purpose. It holds nothing git would quote, so there is one way to spell each path. It has no space, so `a/x b/x`
// splits one way. And it holds nothing a file system folds or ignores, so a name cannot reach a protected file by another spelling.
const PATH_RE = /^[A-Za-z0-9_.+-]+(?:\/[A-Za-z0-9_.+-]+)*$/;

export function pathRefusal(path) {
  const word = protectedWord(path);
  if (word) return { rule: 'protected_path', word };
  if (path.length > MAX_PATH || !PATH_RE.test(path)) return { rule: 'path_unsafe' };
  for (const s of path.split('/')) {
    if (s === '.' || s === '..' || s.startsWith('-') || s.endsWith('.') || s.length > MAX_SEGMENT) return { rule: 'path_unsafe' };
  }
  if (credentialShaped(path)) return { rule: 'credential' };
  return null;
}

const NO_NEWLINE = '\\ No newline at end of file';
const HEADER_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const ADDED_RE = /^new file mode (\d{6})$/;
const DELETED_RE = /^deleted file mode (\d{6})$/;
const INDEX_RE = /^index ([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})(?: (\d{6}))?$/;
const COUNT = '0|[1-9]\\d{0,8}';
const HUNK_RE = new RegExp(`^@@ -(${COUNT})(?:,(${COUNT}))? \\+(${COUNT})(?:,(${COUNT}))? @@(?: [^\\n]*)?$`);
const ZERO_RE = /^0+$/;
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';
const REGULAR_MODES = new Set(['100644', '100755']);

function modeRule(mode) {
  if (mode === '120000') return 'symlink';
  if (mode === '160000') return 'submodule';
  return REGULAR_MODES.has(mode) ? null : 'mode_unknown';
}

// A line where a known header should be, or no header at all. Some of these are the rules being looked for. The rest is text this parser
// does not understand, and git would quietly skip it: that gap is what an attack lives in.
function strayRule(line) {
  if (line === undefined) return 'unparsed';
  if (line === 'GIT binary patch' || line.startsWith('Binary files ')) return 'binary';
  if (line.startsWith('old mode ') || line.startsWith('new mode ')) return 'mode_change';
  if (/^(?:similarity index|dissimilarity index|rename from|rename to|rename old|rename new|copy from|copy to) /.test(line)) return 'rename_or_copy';
  if (line.startsWith('Submodule ')) return 'submodule';
  return 'unparsed';
}

// The hunks of one file. `at` is the line after its +++ line. Returns { at, added, removed, text } or { rule }.
function parseHunks(lines, start, status) {
  let at = start;
  let added = 0;
  let removed = 0;
  let hunks = 0;
  let nextOld = 0;
  const text = [];
  while (lines[at]?.startsWith('@@')) {
    const m = HUNK_RE.exec(lines[at]);
    if (!m) return { rule: 'unparsed' };
    const oldStart = Number(m[1]);
    const newStart = Number(m[3]);
    let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
    let newLeft = m[4] === undefined ? 1 : Number(m[4]);
    const oldCount = oldLeft;
    const newCount = newLeft;
    if (status === 'added' && (hunks > 0 || oldStart !== 0 || oldCount !== 0 || newStart !== 1 || newCount === 0)) return { rule: 'unparsed' };
    if (status === 'deleted' && (hunks > 0 || newStart !== 0 || newCount !== 0 || oldStart !== 1 || oldCount === 0)) return { rule: 'unparsed' };
    if (oldStart < nextOld) return { rule: 'unparsed' };
    nextOld = oldStart + oldCount;
    at++;
    let changed = false;
    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[at];
      const kind = line?.[0];
      if (kind === ' ' && oldLeft > 0 && newLeft > 0) {
        oldLeft--;
        newLeft--;
      } else if (kind === '-' && oldLeft > 0) {
        oldLeft--;
        removed++;
        changed = true;
      } else if (kind === '+' && newLeft > 0) {
        newLeft--;
        added++;
        changed = true;
        text.push(line.slice(1));
      } else {
        return { rule: 'unparsed' };
      }
      at++;
      if (lines[at] === NO_NEWLINE) at++;
    }
    if (!changed) return { rule: 'unparsed' };
    hunks++;
  }
  if (!hunks) return { rule: strayRule(lines[at]) };
  return { at, added, removed, text };
}

function parseFile(lines, start) {
  let at = start;
  const header = lines[at];
  if (!header?.startsWith('diff --git ')) return { rule: strayRule(header) };
  const names = HEADER_RE.exec(header);
  if (!names) return { rule: 'path_unsafe' }; // quoted, spaced, or with an empty side
  if (names[1] !== names[2]) return { rule: 'rename_or_copy' };
  const path = names[1];
  const bad = pathRefusal(path);
  if (bad) return bad;
  at++;

  let status = 'modified';
  let mode = null;
  const added = ADDED_RE.exec(lines[at] ?? '');
  const deleted = DELETED_RE.exec(lines[at] ?? '');
  if (added || deleted) {
    status = added ? 'added' : 'deleted';
    [, mode] = added ?? deleted;
    const rule = modeRule(mode);
    if (rule) return { rule };
    at++;
  }

  const index = INDEX_RE.exec(lines[at] ?? '');
  if (!index) return { rule: strayRule(lines[at]) };
  const [, oldBlob, newBlob, indexMode] = index;
  if (status === 'modified') {
    if (indexMode === undefined) return { rule: 'unparsed' };
    mode = indexMode;
    const rule = modeRule(mode);
    if (rule) return { rule };
    if (ZERO_RE.test(oldBlob) || ZERO_RE.test(newBlob)) return { rule: 'unparsed' };
  } else if (indexMode !== undefined || ZERO_RE.test(status === 'added' ? oldBlob : newBlob) === false || ZERO_RE.test(status === 'added' ? newBlob : oldBlob)) {
    return { rule: 'unparsed' };
  }
  at++;

  const file = { path, status, mode, oldBlob, newBlob };
  // A new or deleted empty file has no text at all, so there is nothing below the index line.
  if (status !== 'modified' && (lines[at] === undefined || lines[at].startsWith('diff --git '))) {
    if (!EMPTY_BLOB.startsWith(status === 'added' ? newBlob : oldBlob)) return { rule: 'unparsed' };
    return { at, file: { ...file, added: 0, removed: 0 }, text: [] };
  }
  const wantOld = status === 'added' ? '--- /dev/null' : `--- a/${path}`;
  const wantNew = status === 'deleted' ? '+++ /dev/null' : `+++ b/${path}`;
  if (lines[at] !== wantOld) return { rule: strayRule(lines[at]) };
  if (lines[at + 1] !== wantNew) return { rule: 'unparsed' };
  const hunks = parseHunks(lines, at + 2, status);
  if (hunks.rule) return hunks;
  return { at: hunks.at, file: { ...file, added: hunks.added, removed: hunks.removed }, text: hunks.text };
}

// Two paths that are one on a disk that ignores case, or a file that is also a folder.
function collides(path, fileKeys, dirKeys) {
  const segments = path.split('/');
  const keys = segments.map((_, i) => fold(segments.slice(0, i + 1).join('/')));
  const own = keys.at(-1);
  if (keys.slice(0, -1).some((k) => fileKeys.has(k)) || fileKeys.has(own) || dirKeys.has(own)) return true;
  fileKeys.add(own);
  for (const k of keys.slice(0, -1)) dirKeys.add(k);
  return false;
}

// Layer 1. Takes the diff as bytes. Returns { ok: true, files, totals } or { ok: false, rule, file, word }. The files hold paths, which the
// session chose: they are for comparing with git, and only publish.js's readYourself decides whether one may be shown to anybody.
export function validateDiff(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!bytes.length) return refused('no_changes');
  if (bytes.length > MAX_DIFF_BYTES) return refused('too_large');
  if (bytes.includes(0)) return refused('binary');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refused('not_utf8');
  }
  if (!text.endsWith('\n')) return refused('unparsed'); // a last line with no newline is one that git apply calls corrupt
  const lines = text.slice(0, -1).split('\n');

  const files = [];
  const fileKeys = new Set();
  const dirKeys = new Set();
  let at = 0;
  while (at < lines.length) {
    const number = files.length + 1;
    if (number >= MAX_FILES) return refused('too_many_files');
    const parsed = parseFile(lines, at);
    if (parsed.rule) return refused(parsed.rule, number, parsed.word ?? null);
    if (collides(parsed.file.path, fileKeys, dirKeys)) return refused('path_collision', number);
    if (credentialShaped(parsed.text.join('\n'))) return refused('credential', number);
    files.push(Object.freeze(parsed.file));
    ({ at } = parsed);
  }
  const count = (status) => files.filter((f) => f.status === status).length;
  return Object.freeze({
    ok: true,
    files: Object.freeze(files),
    totals: Object.freeze({
      files: files.length, added: count('added'), modified: count('modified'), deleted: count('deleted'),
      addedLines: files.reduce((n, f) => n + f.added, 0), removedLines: files.reduce((n, f) => n + f.removed, 0),
    }),
  });
}

// Layer 2. `git` runs one git command with these arguments and resolves { code, stdout }. Nothing is applied by this.
export async function agreeWithGit({ diff, validated, git }) {
  const numstat = await git(['apply', '--numstat', '-z'], { input: diff });
  if (numstat.code !== 0) return refused('git_disagrees');
  const wantNumstat = validated.files.map((f) => `${f.added}\t${f.removed}\t${f.path}\0`).join('');
  if (numstat.stdout !== wantNumstat) return refused('git_disagrees');

  const summary = await git(['apply', '--summary'], { input: diff });
  if (summary.code !== 0) return refused('git_disagrees');
  const wantSummary = validated.files.filter((f) => f.status !== 'modified')
    .map((f) => ` ${f.status === 'added' ? 'create' : 'delete'} mode ${f.mode} ${f.path}\n`).join('');
  if (summary.stdout !== wantSummary) return refused('git_disagrees');
  return Object.freeze({ ok: true });
}

// Layer 3. `raw` is `git diff-tree -r -z --raw --abbrev=40 --no-renames` between the pinned commit and the result, and `regenerated` is git's
// own patch between the same two, made with the flags the session's export uses.
export function agreeWithTree({ validated, raw, regenerated }) {
  const parts = raw.split('\0');
  if (parts.pop() !== '' || parts.length % 2) return refused('git_disagrees');
  const seen = new Map();
  for (let i = 0; i < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([AMD])$/.exec(parts[i]);
    if (!m || seen.has(parts[i + 1])) return refused('git_disagrees'); // any other status is a type change: a file turned into a link
    seen.set(parts[i + 1], { oldMode: m[1], newMode: m[2], oldBlob: m[3], newBlob: m[4], status: m[5] });
  }
  if (seen.size !== validated.files.length) return refused('git_disagrees');
  const statusOf = { added: 'A', modified: 'M', deleted: 'D' };
  for (const f of validated.files) {
    const t = seen.get(f.path);
    if (!t || t.status !== statusOf[f.status]) return refused('git_disagrees');
    if (f.status !== 'added' && (t.oldMode !== f.mode || !t.oldBlob.startsWith(f.oldBlob))) return refused('git_disagrees');
    if (f.status !== 'deleted' && (t.newMode !== f.mode || !t.newBlob.startsWith(f.newBlob))) return refused('git_disagrees');
  }

  const again = validateDiff(regenerated);
  if (!again.ok) return again;
  const paths = (v) => v.files.map((f) => f.path).sort().join('\n');
  if (paths(again) !== paths(validated)) return refused('git_disagrees');
  return Object.freeze({ ok: true });
}
