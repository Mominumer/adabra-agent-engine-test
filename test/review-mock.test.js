import test from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, mockReview, REVIEWER } from '../reviewer/review-mock.js';
import { normalize, renderComment } from '../reviewer/dispatcher.js';

const job = (meta = {}) => ({ pr: 4, sha: 'b'.repeat(40), meta: { base: 'main', title: 'Add tax', body: '', ...meta } });
const gh = (files, truncated = false) => {
  const calls = [];
  return { calls, compareFiles: async (base, sha) => (calls.push([base, sha]), { files, truncated }) };
};

test('added line numbers follow the new file, skipping removed lines', () => {
  const patch = ['@@ -1,3 +1,4 @@', ' a', '-b', '+B', '+C', ' d', '@@ -10,2 +11,2 @@', ' x', '+y'].join('\n');
  assert.deepEqual(addedLines(patch), [{ line: 2, text: 'B' }, { line: 3, text: 'C' }, { line: 12, text: 'y' }]);
});

test('clean PR passes, and the diff is taken for exactly the reviewed commit', async () => {
  const g = gh([{ filename: 'a.js', patch: '@@ -1 +1,2 @@\n x\n+const y = 1;' }]);
  const r = await mockReview(g)(job());
  assert.equal(r.state, 'success');
  assert.equal(r.reviewer, REVIEWER);
  assert.deepEqual(g.calls, [['main', 'b'.repeat(40)]]);
});

test('an added debugger; statement is a blocker at its file and line', async () => {
  const r = await mockReview(gh([{ filename: 'src/pay.js', patch: '@@ -5,2 +5,3 @@\n a\n+  debugger;\n b' }]))(job());
  assert.equal(r.state, 'failure');
  assert.deepEqual(r.findings.map((f) => [f.file, f.line, f.severity]), [['src/pay.js', 6, 'blocker']]);
});

test('a debugger; that the PR removes is not a finding', async () => {
  const r = await mockReview(gh([{ filename: 'a.js', patch: '@@ -1,2 +1 @@\n-debugger;\n x' }]))(job());
  assert.equal(r.state, 'success');
});

test('MOCK-REVIEW: fail in the PR description blocks it', async () => {
  const r = await mockReview(gh([]))(job({ body: 'please\nMOCK-REVIEW: fail' }));
  assert.equal(r.state, 'failure');
});

test('files GitHub cannot show and huge PRs are noted, not silently passed over', async () => {
  const r = await mockReview(gh([{ filename: 'logo.png' }], true))(job());
  assert.equal(r.state, 'success');
  assert.match(r.summary, /1 not shown/);
  assert.ok(r.findings.some((f) => /300 files/.test(f.message)));
});

test('the PR comment names the reviewer and lists findings with file and line', () => {
  const review = normalize({ state: 'failure', summary: '1 blocking finding(s)', reviewer: REVIEWER, findings: [{ file: 'src/pay.js', line: 6, severity: 'blocker', message: 'Leftover `debugger;` statement.' }] }, 'review');
  const tests = normalize({ state: 'success', summary: 'passed' }, 'test');
  const body = renderComment(job(), tests, review);
  assert.match(body, /Review by mock-v1/);
  assert.match(body, /blocker: `src\/pay\.js:6` Leftover/);
});
