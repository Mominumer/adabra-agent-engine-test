import { readFileSync } from 'node:fs';
import { plain } from '../shared/sanitize.js';

// Reads what the review step printed and decides what it means. All of it is untrusted: the CLI has just read a PR, and the
// model's text is in there. So a pass comes only from a complete result that passes every check below; anything else is a
// failure with a class, and the class decides what happens next. The text of a failure goes to the local log only. The words
// that reach GitHub are the fixed ones in STATUS_TEXT, because a CLI's error text can name account details and the repo is public.

export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const SCHEMA = JSON.parse(readFileSync(new URL('./review-user/review-schema.json', import.meta.url), 'utf8'));

export const STATUS_TEXT = {
  limit: 'Review paused (reviewer limit); retries automatically',
  auth: 'Review paused; operator action needed',
  daily: 'Daily review limit reached',
  skipped: 'Skipped: tests failed',
  superseded: 'Skipped: no longer the head of an open PR',
  tooLarge: 'Too large to review (100 files or 256 KB of diff); split it',
  unreadable: 'Source archive could not be read',
  runLimit: 'Review stopped at its run limit; the operator can retry',
  invalid: 'Review gave no valid result; the operator can retry',
  transient: 'Review could not complete; the operator can retry',
};

// While this is thrown no paid run starts and the job waits without using an attempt. kind: limit | auth | daily.
export class ReviewPaused extends Error {
  constructor(kind, until = null) {
    super(`review paused: ${kind}`);
    this.kind = kind;
    this.until = until;
    this.statusText = STATUS_TEXT[kind];
  }
}

// The commit is no longer what the PR would merge, so a review of it would buy nothing.
export class ReviewSuperseded extends Error {
  constructor() {
    super('review skipped: the commit is no longer the head of an open PR');
    this.statusText = STATUS_TEXT.superseded;
  }
}

// --- the dispatcher's own schema check ------------------------------------
// The CLI validates too, but that is the part of the system reading hostile text. This reads the same schema file and knows only
// the keywords that file uses: a keyword it does not know is an error, so a later change to the schema cannot pass by being ignored.
const KEYWORDS = new Set(['type', 'enum', 'pattern', 'maxItems', 'maxLength', 'minimum', 'required', 'additionalProperties', 'properties', 'items']);
const IS_TYPE = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: Number.isSafeInteger,
  null: (v) => v === null,
};

// Returns where the value is wrong, never what it holds, so the answer is safe to log.
export function schemaErrors(value, schema = SCHEMA, at = '$') {
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) return [`${at}: schema keyword ${key} is not supported`];
  }
  if (schema.type !== undefined && ![schema.type].flat().some((t) => IS_TYPE[t]?.(value))) return [`${at}: wrong type`];
  if (schema.enum && !schema.enum.includes(value)) return [`${at}: not an allowed value`];
  const errors = [];
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: wrong form`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) errors.push(`${at}: too long`);
  }
  if (typeof value === 'number' && schema.minimum !== undefined && !(value >= schema.minimum)) errors.push(`${at}: too small`);
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return [`${at}: too many items`];
    if (schema.items) value.forEach((v, i) => errors.push(...schemaErrors(v, schema.items, `${at}[${i}]`)));
  }
  if (IS_TYPE.object(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${at}: missing ${key}`);
    }
    if (schema.additionalProperties === false) {
      if (Object.keys(value).some((key) => !Object.hasOwn(schema.properties ?? {}, key))) errors.push(`${at}: unexpected field`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) errors.push(...schemaErrors(value[key], sub, `${at}.${key}`));
    }
  }
  return errors;
}

// --- classifying a failure ------------------------------------------------
// These are only ever read from a result the CLI itself marks as an error, or from output that is not a result at all. A
// successful result's text is the model's, and a model must not be able to pause the reviewer by saying "session limit".
const LIMIT_TEXT = [/hit your .{0,40}limit/i, /session limit/i, /weekly limit/i, /usage limit/i, /spend(ing)? limit/i, /credit balance is too low/i, /rate.?limit/i];
const AUTH_TEXT = [/not logged in/i, /please run \/login/i, /invalid api key/i, /oauth token has expired/i, /token (has )?expired/i, /authentication[_ ](error|failed)/i, /failed to authenticate/i, /unauthori[sz]ed/i];
const TRANSIENT_TEXT = [/overloaded/i, /internal server error/i, /service unavailable/i, /bad gateway/i, /gateway time-?out/i, /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/, /socket hang up/i, /fetch failed/i, /network error/i, /connection error/i];

const anyOf = (patterns, text) => patterns.some((p) => p.test(text));

const MAX_RESET_MS = 8 * 24 * 3_600_000; // the longest window a limit can state; anything further is not believed
const RESET_GRACE_MS = 60_000;

function nextUtcClock(hourText, minuteText, ampm, now) {
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (/pm/i.test(ampm) ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const d = new Date(now);
  const today = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
  return today > now ? today : today + 24 * 3_600_000;
}

// When a limit message says the limit lifts, if it says so in a form that cannot be misread. A time without a zone is not used,
// and neither is one in the past or too far ahead: the caller then falls back to its own back-off.
export function parseReset(text, now) {
  const t = String(text);
  let at = null;
  let m;
  if ((m = t.match(/\|(\d{10})\b/))) at = Number(m[1]) * 1000;
  else if ((m = t.match(/resets?\s+(?:at\s+|on\s+)?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))/i))) at = Date.parse(m[1]);
  else if ((m = t.match(/resets?\s+in\s+(?:(\d+)\s*h\w*)?\s*(?:(\d+)\s*m\w*)?/i)) && (m[1] || m[2])) at = now + (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
  else if ((m = t.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?(?:UTC|GMT)\)?/i))) at = nextUtcClock(m[1], m[2], m[3], now);
  if (!Number.isFinite(at) || at <= now || at > now + MAX_RESET_MS) return null;
  return at + RESET_GRACE_MS;
}

// Text and an HTTP status from one failure -> limit | auth | transient, or null when neither is recognised.
export function classifyText(text, status, now) {
  if (anyOf(LIMIT_TEXT, text)) return { class: 'limit', resetAt: parseReset(text, now) };
  if (anyOf(AUTH_TEXT, text)) return { class: 'auth' };
  if (status === 401 || status === 403) return { class: 'auth' };
  if (status === 402 || status === 429) return { class: 'limit', resetAt: parseReset(text, now) };
  if (Number.isInteger(status) && status >= 500 && status <= 599) return { class: 'transient' };
  if (anyOf(TRANSIENT_TEXT, text)) return { class: 'transient' };
  return null;
}

// --- judging one run ------------------------------------------------------
const usageOf = (p) => ({
  cost: Number.isFinite(p?.total_cost_usd) ? p.total_cost_usd : null,
  turns: Number.isSafeInteger(p?.num_turns) ? p.num_turns : null,
  durationMs: Number.isFinite(p?.duration_ms) ? p.duration_ms : null,
  modelUsage: IS_TYPE.object(p?.modelUsage) ? JSON.stringify(p.modelUsage).slice(0, 2000) : null,
});

// What may go in the local log: one line, bounded, and never a credential even if a tool prints one.
export function localDetail(text) {
  return plain(text).replace(/sk-ant-[\w-]+/g, '[redacted]').slice(0, 2000);
}

const parseOne = (text) => {
  try {
    const v = JSON.parse(text);
    return IS_TYPE.object(v) ? v : null;
  } catch {
    return null;
  }
};

const problem = (cls, why, raw = '', parsed = null, extra = {}) => ({ ok: false, class: cls, why, raw, paid: true, usage: usageOf(parsed), ...extra });

// Wrapper exits that mean the model was never started. 78: model step off. 77: no credential. Both need the operator.
// 64: the job was refused. 79: the job was not marked for a paid run. 126, 127: the CLI could not be started.
const NOT_STARTED = { 78: 'auth', 77: 'auth', 64: 'unknown', 79: 'unknown', 126: 'unknown', 127: 'unknown' };

function judgeNotAResult({ code, stdout, stderr }, now) {
  if (Object.hasOwn(NOT_STARTED, code ?? '')) return problem(NOT_STARTED[code], `the wrapper exited ${code} before the model`, stderr, null, { paid: false });
  if (/^sudo: /m.test(stderr)) return problem('auth', 'sudo refused to start the wrapper', stderr, null, { paid: false });
  const raw = `${stdout}\n${stderr}`;
  const c = classifyText(raw, null, now);
  return c ? problem(c.class, 'output was not a result', raw, null, c) : problem('unknown', 'output was not a result', raw);
}

const CLI_ERROR_TEXT = (p) => [p.result, ...(Array.isArray(p.errors) ? p.errors.map((e) => (typeof e === 'string' ? e : e?.message)) : [])]
  .filter((s) => typeof s === 'string')
  .join('\n');

// Where a finding's path can be seen. A model working in the job directory may name a file from there, so those spellings are
// brought back to the path in the manifest before it is checked.
function manifestPath(file, { files, jobDir }) {
  let p = file;
  if (jobDir && p.startsWith(`${jobDir}/`)) p = p.slice(jobDir.length + 1);
  if (p.startsWith('./')) p = p.slice(2);
  if (files.has(p)) return p;
  if (p.startsWith('tree/') && files.has(p.slice(5))) return p.slice(5);
  return null;
}

// run: what the wrapper did, { code, signal, timedOut, overflow, stdout, stderr }.
// ctx: { sha, files: Set of every path a finding may name, jobDir, now }.
// Returns { ok: true, state, findings, usage } only for a fully valid result, otherwise { ok: false, class, why, raw, paid, usage, resetAt }.
//   limit, auth         pause: nothing more is spent until it lifts
//   transient, unknown  retried a few times; unknown also counts towards opening the pause
//   run-limit, invalid  final: running it again would cost the same
export function judgeRun(run, ctx) {
  const now = ctx.now ?? Date.now();
  const stderr = String(run.stderr ?? '');
  const stdout = String(run.stdout ?? '');
  const { code } = run;
  if (run.timedOut || run.signal || [124, 137, 143].includes(code)) return problem('run-limit', 'time limit hit or killed', stderr);
  if (run.overflow || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) return problem('invalid', 'output over the size limit', stderr);

  const parsed = parseOne(stdout);
  if (!parsed) return judgeNotAResult({ code, stdout, stderr }, now);

  // Only the CLI's own error markers open the door to reading text: `result` on a success is the model's words.
  const markedAsError = parsed.type === 'result' && (parsed.is_error === true || (typeof parsed.subtype === 'string' && parsed.subtype !== 'success'));
  if (markedAsError) {
    if (['error_max_turns', 'error_max_budget_usd'].includes(parsed.subtype)) return problem('run-limit', `the CLI stopped: ${parsed.subtype}`, stderr, parsed);
    if (parsed.subtype === 'error_max_structured_output_retries') return problem('invalid', 'the CLI gave up on the schema', stderr, parsed);
    const raw = `${CLI_ERROR_TEXT(parsed)}\n${stderr}`;
    const status = Number.isInteger(parsed.api_error_status) ? parsed.api_error_status : null;
    const c = classifyText(raw, status, now);
    return c ? problem(c.class, 'the CLI reported an error', raw, parsed, c) : problem('unknown', 'the CLI reported an error', raw, parsed);
  }
  if (code !== 0) return problem('unknown', `the wrapper exited ${code ?? 'without a code'}`, stderr, parsed);
  if (parsed.type !== 'result' || parsed.subtype !== 'success' || parsed.is_error !== false) return problem('invalid', 'not a successful result', '', parsed);
  // Missing as well as non-empty: with no list there is no way to tell that nothing was denied.
  if (!Array.isArray(parsed.permission_denials)) return problem('invalid', 'no list of permission denials', '', parsed);
  if (parsed.permission_denials.length) return problem('invalid', 'a tool call was denied', '', parsed);

  const out = parsed.structured_output;
  if (out === undefined || out === null) return problem('invalid', 'no structured output', '', parsed);
  const errors = schemaErrors(out);
  if (errors.length) return problem('invalid', `schema: ${errors.slice(0, 5).join('; ')}`, '', parsed);
  if (out.sha !== ctx.sha) return problem('invalid', 'the result names another commit', '', parsed);

  const findings = [];
  for (const f of out.findings) {
    const file = f.file === null ? null : manifestPath(f.file, ctx);
    if (f.file !== null && file === null) return problem('invalid', 'a finding names a file that is not in the job', '', parsed);
    findings.push({ file, line: f.line, severity: f.severity, message: f.message });
  }
  const blockers = findings.filter((f) => f.severity === 'blocker').length;
  if ((out.verdict === 'pass') !== (blockers === 0)) return problem('invalid', 'the verdict and the findings disagree', '', parsed);
  return { ok: true, state: out.verdict === 'pass' ? 'success' : 'failure', findings, usage: usageOf(parsed) };
}

// The status text for a result: counted by the dispatcher, so it never holds the model's words.
export function reviewSummary({ state, findings }) {
  const blockers = findings.filter((f) => f.severity === 'blocker').length;
  if (state === 'failure') return `${blockers} blocking finding(s)`;
  return `No blocking findings (${findings.length} other finding(s))`;
}
