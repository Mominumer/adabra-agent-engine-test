// Review result schema shared by the reviewer (sender) and the coordinator (receiver).
// Strict on purpose, like shared/event.js: unknown fields are rejected, strings are bounded. The limits keep the largest
// possible result under the coordinator's 16 KB body limit (a test proves it), so a result is never refused for its size.
export const LIMITS = { summary: 300, findings: 10, message: 240 };

// Severity, file and line are shown as they are, in public comments and to builder agents, so they must not be able to
// carry a sentence: severity is one of a closed list, and a path has no spaces. All other text from a review is untrusted.
export const SEVERITIES = ['blocker', 'major', 'minor', 'note', 'other'];
export const isSafePath = (v) => typeof v === 'string' && /^[A-Za-z0-9._@+/-]{1,120}$/.test(v);

const STATES = ['success', 'failure', 'error'];
const MAX_TS = 8.64e15; // the largest time a Date can hold
const ts = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_TS;

const FINDING = {
  severity: (v) => SEVERITIES.includes(v),
  file: (v) => v === null || isSafePath(v),
  line: (v) => v === null || (Number.isSafeInteger(v) && v >= 1),
  message: (v) => typeof v === 'string' && v.length <= LIMITS.message,
};

const validFinding = (f) =>
  f !== null && typeof f === 'object' && !Array.isArray(f) &&
  Object.keys(f).every((k) => k in FINDING) &&
  Object.entries(FINDING).every(([k, ok]) => k in f && ok(f[k]));

const FIELDS = {
  result_id: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v),
  task_id: (v) => typeof v === 'string' && /^[A-Z][A-Z0-9]*-\d{1,9}$/.test(v),
  pr: (v) => Number.isInteger(v) && v >= 1,
  sha: (v) => typeof v === 'string' && /^[0-9a-f]{40,64}$/.test(v),
  tests: (v) => STATES.includes(v),
  review: (v) => STATES.includes(v),
  tests_summary: (v) => typeof v === 'string' && v.length <= LIMITS.summary,
  review_summary: (v) => typeof v === 'string' && v.length <= LIMITS.summary,
  findings: (v) => Array.isArray(v) && v.length <= LIMITS.findings && v.every(validFinding),
  findings_total: (v) => Number.isSafeInteger(v) && v >= 0,
  reviewer: (v) => v === null || (typeof v === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(v)),
  commit_seen_at: ts, // when the reviewer first saw this commit as a PR's head: a later value is a newer commit
  reviewed_at: ts, // when this review finished: a later value is a newer review of the same commit
};

export function validateReviewResult(r) {
  const errors = [];
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return ['result must be an object'];
  for (const key of Object.keys(r)) {
    if (!(key in FIELDS)) errors.push(`unknown field: ${key}`);
  }
  for (const [key, ok] of Object.entries(FIELDS)) {
    if (!(key in r)) errors.push(`missing field: ${key}`);
    else if (!ok(r[key])) errors.push(`invalid field: ${key}`);
  }
  if (!errors.length && r.findings_total < r.findings.length) errors.push('invalid field: findings_total');
  return errors;
}

// A failure on either check needs the owner's attention. 'error' means our machinery gave no opinion: that is neither a
// pass nor a reason to send work back, and never counts as a pass by default.
export function verdictOf({ tests, review }) {
  if (tests === 'failure' || review === 'failure') return 'changes_requested';
  return tests === 'success' && review === 'success' ? 'passed' : 'error';
}

export const VERDICT_TEXT = {
  passed: 'review passed',
  changes_requested: 'changes requested',
  error: 'review could not complete',
};

export const findingLocation = (f) => (f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : null);
