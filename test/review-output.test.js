import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyText, judgeRun, localDetail, parseReset, reviewSummary, schemaErrors, SCHEMA, STATUS_TEXT } from '../reviewer/review-output.js';
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
  assert.equal(judge(`${JSON.stringify(result())}${' '.repeat(2 * 1024 * 1024)}`).ok, false, 'over the size limit, however valid');
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
  for (const fine of [unshown('logo.PNG'), unshown('font.woff2'), unshown('gone.bin', { status: 'removed' }), unshown('moved.js', { status: 'renamed', previous_filename: 'old.js' }), unshown('__init__.py', { status: 'added', sha: 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' })]) {
    const r = pre([fine]);
    assert.deepEqual(r.blockers, [], fine.filename);
    assert.ok(r.attention.some((a) => a.includes('not shown by GitHub')), `${fine.filename} is still listed`);
  }
  assert.deepEqual(blockerAt(pre([unshown('logo.png')], { unshownOk: ['woff'] })), ['logo.png:null'], 'the operator\'s list replaces the default');
  assert.deepEqual(pre([unshown('tool.bin')], { unshownOk: ['bin'] }).blockers, []);
});

test('pre-checks: the sensitive paths go on the list to read', () => {
  const sensitive = ['reviewer/main.js', 'service/x.sh', 'coordinator/a.js', '.github/workflows/ci.yml', '.claude/settings.json', 'sub/.claude/x', 'CLAUDE.md', 'sub/claude.local.md', 'AGENTS.md', '.mcp.json', 'package.json', 'web/package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'test/a.js', 'src/tests/a.js', 'src/__tests__/a.js', 'src/a.test.js', 'src/a.spec.ts'];
  for (const name of sensitive) assert.deepEqual(pre([changed(name)]).attention, [name], name);
  for (const name of ['src/a.js', 'docs/reviewer/notes.md', 'contest/a.js', 'README.md']) assert.deepEqual(pre([changed(name)]).attention, [], name);
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

test('defer gives the attempt back and clearing a pause brings the waiting jobs forward', (t) => {
  const store = new ReviewStore(tempDb(t));
  t.after(() => store.close());
  store.enqueue(1, SHA, {}, 5);
  store.markRunning(1, SHA);
  assert.equal(store.getJob(1, SHA).attempts, 1);
  store.defer(1, SHA, NOW + 1000, 'why');
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
  store.defer(2, SHA, NOW + 5000, 'why');
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
