// Mock review skill (v1). Same contract as the future Claude review: given a job, return
// { state: success|failure|error, summary, findings: [{ file, line, severity, message }], reviewer }.
// It only reads text from GitHub; it never runs PR code. Deterministic rules, so the blocking path can be tested:
//   - the PR title or description contains "MOCK-REVIEW: fail"  -> blocker
//   - a line ADDED by the PR contains "debugger;"                -> blocker at that file and line
export const REVIEWER = 'mock-v1';
const FAIL_MARK = 'MOCK-REVIEW: fail';

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

export function mockReview(github) {
  return async (job) => {
    const findings = [];
    const meta = job.meta ?? {};
    if (`${meta.title ?? ''}\n${meta.body ?? ''}`.includes(FAIL_MARK)) {
      findings.push({ file: null, line: null, severity: 'blocker', message: `The PR description asks the mock review to fail (${FAIL_MARK}).` });
    }
    const { files, truncated } = await github.compareFiles(meta.base ?? 'main', job.sha); // network error -> retried
    let skipped = 0;
    for (const f of files) {
      if (f.patch === undefined) {
        skipped++; // binary or too large for GitHub to show
        continue;
      }
      for (const a of addedLines(f.patch)) {
        if (a.text.includes('debugger;')) {
          findings.push({ file: f.filename, line: a.line, severity: 'blocker', message: 'Leftover `debugger;` statement.' });
        }
      }
    }
    if (truncated) findings.push({ file: null, line: null, severity: 'minor', message: 'More than 300 files changed; only the first 300 were reviewed.' });
    const blockers = findings.filter((f) => f.severity === 'blocker').length;
    const note = skipped ? `, ${skipped} not shown by GitHub` : '';
    return {
      state: blockers ? 'failure' : 'success',
      summary: blockers ? `${blockers} blocking finding(s)` : `No blocking findings (${files.length} file(s) checked${note})`,
      findings,
      reviewer: REVIEWER,
    };
  };
}
