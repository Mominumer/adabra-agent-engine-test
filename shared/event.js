// Event schema shared by the helper (sender) and the coordinator (receiver).
// Strict on purpose: unknown fields are rejected, strings are bounded.

export const STATUSES = ['Building', 'In review', 'Blocked', 'Interrupted'];
export const EVENT_TYPES = ['checkpoint'];
export const DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const TASK_ID_RE = /^[A-Z][A-Z0-9]*-\d{1,9}$/;

const FIELDS = {
  event_id: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v),
  task_id: (v) => typeof v === 'string' && TASK_ID_RE.test(v),
  run_id: (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v),
  device_id: (v) => typeof v === 'string' && DEVICE_ID_RE.test(v),
  claim_generation: (v) => Number.isInteger(v) && v >= 0,
  type: (v) => EVENT_TYPES.includes(v),
  source_commit: (v) => v === null || (typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v)),
  unpushed_commits: (v) => v === null || (Number.isInteger(v) && v >= 0),
  summary: (v) => typeof v === 'string' && v.length >= 1 && v.length <= 500,
  verification: (v) => typeof v === 'string' && v.length <= 500,
  status: (v) => STATUSES.includes(v),
  next_action: (v) => typeof v === 'string' && v.length <= 300,
  ts: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
};

export function validateEvent(e) {
  const errors = [];
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return ['event must be an object'];
  for (const key of Object.keys(e)) {
    if (!(key in FIELDS)) errors.push(`unknown field: ${key}`);
  }
  for (const [key, ok] of Object.entries(FIELDS)) {
    if (!(key in e)) errors.push(`missing field: ${key}`);
    else if (!ok(e[key])) errors.push(`invalid field: ${key}`);
  }
  return errors;
}
