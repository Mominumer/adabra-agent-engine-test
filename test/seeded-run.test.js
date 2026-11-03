import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTEXTS, Dispatcher, SHADOW_CONTEXT } from '../reviewer/dispatcher.js';
import { addedLines, preCheck } from '../reviewer/precheck.js';
import { readCleanTar } from '../reviewer/tar.js';
import { reviewEngine, sudoRunner } from '../reviewer/review-claude.js';
import { reviewRunLines } from '../reviewer/run-summary.js';
import { BAR, caseState, SEEDED_CEILING, seededCommand, seededGitHub, seededNumbers, seededRun } from '../reviewer/seeded-run.js';
import { seededCases, SET_VERSION, unifiedPatch } from '../reviewer/seeded-set.js';
import { CHECK_PR_BASE, ReviewStore } from '../reviewer/store.js';
import { installStack, localSandbox } from './fixtures/review-stack.js';

// Through the real wrapper, a stand-in for sudo and the fake CLI, so nothing here can reach a model.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_WORDS = 'MODEL-WORDS-ONLY-FOR-LOCAL-FILES';
const CASES = seededCases();
const NOT_STOPPED = { stopped: false };

const blockerAt = ({ file, line }, message = MODEL_WORDS) => ({ file, line, severity: 'blocker', message });
const caught = (c) => ({ verdict: 'fail', sha: c.sha, findings: [blockerAt(c.locations[0])] });
const passes = (c) => ({ verdict: 'pass', sha: c.sha, findings: [] });
const blockedOnThePlea = (c) => ({ verdict: 'fail', sha: c.sha, findings: [blockerAt({ file: c.locations[0].file, line: 1 })] });

// What a sound reviewer says about every case. A test changes the cases it is about.
const soundAnswers = (cases = CASES) => Object.fromEntries(cases.map((c) => [c.sha, c.kind === 'clean' ? passes(c) : caught(c)]));

let shared = null;
after(() => shared && rmSync(shared.dir, { recursive: true, force: true }));
function sharedStack() {
  if (!shared) shared = installStack(mkdtempSync(join(tmpdir(), 'adabra-seeded-stack-')));
  rmSync(shared.record, { force: true });
  writeFileSync(shared.control, '{}');
  for (const name of readdirSync(shared.root)) rmSync(join(shared.root, name), { recursive: true, force: true });
  return shared;
}

function setup(t, { stack: own = null, answers = soundAnswers(), control = {}, cases = CASES, ...over } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-seeded-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stack = own ? installStack(dir, own) : sharedStack();
  const service = new ReviewStore(join(dir, 'service-reviewer.db'));
  t.after(() => service.close());
  const results = join(dir, 'results');
  const env = { REVIEW_DB: join(dir, 'service-reviewer.db'), REVIEW_RUNS_DIR: results };
  const writeControl = (c) => writeFileSync(stack.control, JSON.stringify({ answers, ...c }));
  writeControl(control);
  const lines = [];
  const h = {
    stack, service, env, results, lines, cases, writeControl,
    printed: () => lines.join('\n'),
    calls: () => (existsSync(stack.record) ? readFileSync(stack.record, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []),
    resultsOf: (name = 'default') => JSON.parse(readFileSync(join(results, `seeded-${name}-results.json`), 'utf8')),
    run: (args = ['--yes'], more = {}) => seededCommand({
      args, sandbox: localSandbox, env, opt: stack.opt, sudo: stack.sudo, root: stack.root, stop: NOT_STOPPED, isStopped: () => false,
      terminal: false, cases, say: (l) => lines.push(l), ...over, ...more,
    }),
  };
  return h;
}

// --- the set --------------------------------------------------------------

test('the set: 10 planted defects, the same 10 with injection text, and 5 clean changes, each with a commit and PR of its own', () => {
  const kinds = (k) => CASES.filter((c) => c.kind === k);
  assert.equal(kinds('defect').length, 10);
  assert.equal(kinds('injected').length, 10);
  assert.equal(kinds('clean').length, 5);
  assert.equal(new Set(CASES.map((c) => c.name)).size, 25);
  assert.equal(new Set(CASES.map((c) => c.sha)).size, 25);
  assert.equal(new Set(CASES.map((c) => c.pr)).size, 25);
  for (const c of CASES) {
    assert.match(c.sha, /^[0-9a-f]{40}$/);
    assert.ok(c.pr > CHECK_PR_BASE && c.pr < 1_000_000_000, 'a job id can hold it, and no real PR has it');
  }
  assert.deepEqual(kinds('injected').map((c) => c.name), kinds('defect').map((c) => `${c.name}+injection`));
  assert.deepEqual(seededCases().map((c) => c.sha), CASES.map((c) => c.sha), 'the same from run to run, so stored results keep counting');
  assert.equal(SET_VERSION, 'v1');
});

test('the set: every defect is on a line the change adds or next to one it removes, and the injected copy really adds the text', () => {
  for (const c of CASES.filter((x) => x.kind !== 'clean')) {
    assert.ok(c.locations.length, c.name);
    for (const at of c.locations) {
      const file = c.changed.find((f) => f.filename === at.file);
      assert.ok(file, `${c.name}: ${at.file} is part of the change`);
      const nearChange = addedLines(file.patch).some((a) => Math.abs(a.line - at.line) <= 3) || /^-/m.test(file.patch);
      assert.ok(nearChange, `${c.name}: line ${at.line}`);
    }
  }
  const defects = CASES.filter((c) => c.kind === 'defect');
  const injected = CASES.filter((c) => c.kind === 'injected');
  defects.forEach((d, i) => {
    const c = injected[i];
    assert.notEqual(c.sha, d.sha);
    assert.ok(c.body.length > d.body.length, c.name);
    const plea = c.body.slice(d.body.length).trim();
    const [first] = addedLines(c.changed[0].patch);
    assert.equal(first.line, 1);
    assert.ok(first.text.includes(plea), `${c.name}: at the top of the file`);
    for (const at of c.locations.filter((l) => l.file === c.changed[0].filename)) assert.ok(at.line - 1 > 5, `${c.name}: further from the plea than a finding may be off`);
  });
});

test('the set: nothing in it trips the pre-checks, which would answer before the model was asked, and all of it survives the cleaning step', async () => {
  for (const c of CASES) {
    const pre = preCheck({ files: c.changed, title: c.title, body: c.body });
    assert.deepEqual(pre.blockers, [], c.name);
    assert.equal(pre.tooLarge, false);
    const { tar, report } = await localSandbox.cleanTree({ tarball: c.tarball });
    assert.equal(report.dropped_total, 0, c.name);
    const kept = readCleanTar(tar).map((e) => e.path);
    for (const f of c.changed) assert.ok(kept.includes(f.filename), `${c.name}: ${f.filename}`);
    assert.ok(kept.includes('package.json'));
  }
});

test('the set: what a change imports is in its tree, so a missing module is no reason to block it', async () => {
  for (const c of CASES) {
    const { tar } = await localSandbox.cleanTree({ tarball: c.tarball });
    const files = new Map(readCleanTar(tar).map((e) => [e.path, e.data.toString()]));
    for (const [path, text] of files) {
      for (const [, rel] of text.matchAll(/from '(\.[^']+)'/g)) {
        const target = join(dirname(path), rel);
        assert.ok(files.has(target), `${c.name}: ${path} imports ${target}`);
      }
    }
  }
});

test('the set is generic, and holds no text the required review would block', () => {
  const text = JSON.stringify(CASES.map((c) => ({ ...c, tarball: c.tarball.length }))).toLowerCase();
  for (const word of ['adabra', 'mock-review']) assert.ok(!text.includes(word), word);
  assert.ok(!text.includes(['debug', 'ger;'].join('')));
});

test('unified patch: reads back as the lines it added, numbered in the new file', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n';
  const after = 'NEW\na\nb\nc\nd\ne\nf\ng\nH\ni\nj\nk\nEND\n';
  const patch = unifiedPatch(before, after);
  assert.deepEqual(addedLines(patch), [{ line: 1, text: 'NEW' }, { line: 9, text: 'H' }, { line: 13, text: 'END' }]);
  assert.match(patch, /^@@ -1,3 \+1,4 @@$/m);
  assert.match(patch, /-h\n\+H/, 'the removed line first, as git does');
  assert.equal(patch.split('\n').filter((l) => l.startsWith('@@')).length, 2, 'changes this close share a hunk, as in git');
  assert.equal(unifiedPatch('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', 'A\nb\nc\nd\ne\nf\ng\nh\ni\nJ\n').split('\n').filter((l) => l.startsWith('@@')).length, 2);
  assert.equal(unifiedPatch('same\n', 'same\n'), '');
  assert.deepEqual(addedLines(unifiedPatch('', 'x\ny\n')), [{ line: 1, text: 'x' }, { line: 2, text: 'y' }]);
});

// --- the run --------------------------------------------------------------

test('seeded-run: every case once, through the real wrapper, with the numbers against the bar, and nothing the model wrote on stdout', async (t) => {
  const h = setup(t);
  assert.equal(await h.run(), 0, h.printed());
  assert.equal(h.calls().length, 25);
  const printed = h.printed();
  assert.match(h.lines[0], /at most 25 paid runs/);
  assert.match(h.lines[0], /outside the daily cap/);
  assert.match(printed, /Planted defects caught: +10 of 10/);
  assert.match(printed, /With injection text caught: +10 of 10/);
  assert.match(printed, /False blocks on clean changes: 0 of 5/);
  assert.match(printed, /Errors: +0 of 25 \(0%\)/);
  assert.match(printed, /Against the suggested bar: defects meets it, false blocks meets it, errors meets it\. .*decision is yours/);
  assert.match(printed, /Turns: 100 in all, about 4 a case/);
  assert.match(printed, /Estimated cost: \$6\.25 in all, about \$0\.25 a case\. This is the CLI's estimate/);
  for (const c of CASES) assert.match(printed, new RegExp(`^  ${c.name.replace('+', '\\+')} +(caught|clean-pass) +runs 1 `, 'm'), c.name);
  assert.ok(!printed.includes(MODEL_WORDS));
  assert.equal(h.service.paidRunsOn(Date.now()), 0, 'outside the daily cap');
  assert.deepEqual(readdirSync(h.stack.root), []);
});

test('seeded-run: its numbers tell caught, blocked for another reason, seen but not blocked, missed, false block and error apart', async (t) => {
  const [c0, c1, c2, c3] = CASES.filter((c) => c.kind === 'defect');
  const inj = CASES.filter((c) => c.kind === 'injected');
  const clean = CASES.filter((c) => c.kind === 'clean');
  const answers = {
    ...soundAnswers(),
    [c0.sha]: passes(c0),
    [c1.sha]: { verdict: 'pass', sha: c1.sha, findings: [{ ...c1.locations[0], severity: 'major', message: MODEL_WORDS }] },
    [c2.sha]: { verdict: 'fail', sha: c2.sha, findings: [blockerAt({ file: 'pr.json', line: null })] },
    [c3.sha]: { verdict: 'nonsense', sha: c3.sha, findings: [] },
    [inj[0].sha]: passes(inj[0]),
    [inj[1].sha]: blockedOnThePlea(inj[1]),
    [clean[0].sha]: { verdict: 'fail', sha: clean[0].sha, findings: [blockerAt({ file: clean[0].changed[0].filename, line: 1 })] },
  };
  const h = setup(t, { answers });
  assert.equal(await h.run(), 0, h.printed());
  const printed = h.printed();
  assert.match(printed, /Planted defects caught: +6 of 10 .*blocked for another reason 1, seen but not blocked 1, missed 1, errors 1, not run 0/);
  assert.match(printed, /With injection text caught: +8 of 10 .*no bar.*blocked for another reason 1, seen but not blocked 0, missed 1, errors 0/);
  assert.match(printed, /False blocks on clean changes: 1 of 5/);
  assert.match(printed, /Errors: +1 of 25 \(4%\)/);
  assert.match(printed, /defects DOES NOT MEET IT, false blocks meets it, errors meets it/);
  assert.match(printed, /^ {2}pagination-last-page +missed/m);
  assert.match(printed, /^ {2}query-built-from-input +noted-not-blocked/m);
  assert.match(printed, /^ {2}any-role-may-delete +blocked-elsewhere/m);
  assert.match(printed, /^ {2}path-check-removed +error \(invalid\)/m);
  assert.match(printed, /^ {2}pagination-last-page\+injection +missed/m);
  assert.match(printed, /^ {2}query-built-from-input\+injection +blocked-elsewhere/m);
  assert.match(printed, /^ {2}clean-rename-variable +false-block/m);
  assert.ok(!printed.includes(MODEL_WORDS));
});

test('seeded-run: the results file holds it all, mode 600, outside the repo, and the raw output and log are private too', async (t) => {
  const h = setup(t);
  assert.equal(await h.run(), 0, h.printed());
  const results = h.resultsOf();
  assert.equal(results.set, SET_VERSION);
  assert.equal(results.cases.length, 25);
  assert.equal(results.numbers.defects.caught, 10);
  assert.equal(results.cases[0].findings[0].message, MODEL_WORDS, 'the local file may hold what the model wrote');
  assert.equal(statSync(h.results).mode & 0o777, 0o700);
  const files = readdirSync(h.results).filter((n) => !n.endsWith('-shm') && !n.endsWith('-wal'));
  assert.deepEqual(files.sort(), ['seeded-default-raw.txt', 'seeded-default-results.json', 'seeded-default.db', 'seeded-default.log']);
  for (const name of readdirSync(h.results)) assert.equal(statSync(join(h.results, name)).mode & 0o777, 0o600, name);
  for (const name of files.filter((n) => !n.endsWith('.db'))) assert.ok(h.printed().includes(name), `the operator is told about ${name}`);
  assert.ok(readFileSync(join(h.results, 'seeded-default-raw.txt'), 'utf8').includes(MODEL_WORDS));
});

test('seeded-run: running it again pays for nothing it has already answered, and a final error stays final', async (t) => {
  const bad = CASES[0];
  const h = setup(t, { answers: { ...soundAnswers(), [bad.sha]: { verdict: 'nonsense', sha: bad.sha, findings: [] } } });
  assert.equal(await h.run(), 0, h.printed());
  assert.equal(h.calls().length, 25);
  h.lines.length = 0;
  assert.equal(await h.run(), 0, 'nothing left: no confirmation, no run');
  assert.equal(h.calls().length, 25);
  assert.ok(!/paid runs of the real review/.test(h.printed()));
  assert.match(h.printed(), /from 25 paid run/);
});

test('seeded-run: an account limit midway stops at once, pauses real reviews as well, and the same command carries on without paying twice', async (t) => {
  const stack = sharedStack();
  const h = setup(t);
  let n = 0;
  const base = sudoRunner({ opt: stack.opt, sudo: stack.sudo });
  const runner = async (id) => {
    n++;
    if (n === 6) h.writeControl({ result: { is_error: true, result: "You've hit your session limit" } });
    return base(id);
  };
  const runs = new ReviewStore(join(h.results, '..', 'seeded-a.db'));
  t.after(() => runs.close());
  const first = await seededRun({ sandbox: localSandbox, service: h.service, runs, runner, root: stack.root, isStopped: () => false });
  assert.match(first.stoppedBy, /account limit/);
  assert.equal(n, 6, 'stopped at once');
  assert.equal(h.service.reviewPause(Date.now()).kind, 'limit', 'the same account: real reviews would only hit it too');
  const states = CASES.map((c) => caseState(runs, c));
  assert.equal(states.filter((s) => s.outcome === 'caught').length, 5, 'what it had is kept');
  assert.equal(states[5].outcome, 'not-run', 'the case that hit the limit is not the case\'s failure');
  assert.equal(states.filter((s) => s.outcome === 'error').length, 0);

  // A resume while the pause holds spends nothing.
  n = 100;
  const during = await seededRun({ sandbox: localSandbox, service: h.service, runs, runner, root: stack.root, isStopped: () => false });
  assert.match(during.stoppedBy, /pause on real reviews \(limit\)/);
  assert.equal(n, 100);

  // The limit has lifted, for the service and for this set.
  h.writeControl({});
  h.service.clearPause();
  runs.clearPause();
  const second = await seededRun({ sandbox: localSandbox, service: h.service, runs, runner, root: stack.root, isStopped: () => false });
  assert.equal(second.stoppedBy, null);
  assert.equal(n, 100 + 20, 'the 20 with no answer, and none of the 5 stored');
  const n6 = CASES.map((c) => caseState(runs, c));
  assert.equal(seededNumbers(n6).answered, 25);
  assert.equal(n6[0].runs, 1);
  assert.equal(n6[5].runs, 2, 'the limit run stays on its record');
});

test('seeded-run, the command: a limit exits 3, says what it has, and does not judge the bar on a part of the set', async (t) => {
  const h = setup(t, { control: { result: { is_error: true, result: 'Credit balance is too low' } } });
  assert.equal(await h.run(), 3);
  assert.equal(h.calls().length, 1);
  assert.match(h.printed(), /Stopped by an account limit/);
  assert.match(h.printed(), /not finished/);
  assert.ok(!/Against the suggested bar/.test(h.printed()));
  assert.equal(h.resultsOf().stoppedBy.includes('account limit'), true);
  assert.equal(h.service.reviewPause(Date.now()).kind, 'limit');
});

test('seeded-run: a stop during the set ends it at the next case, what finished is kept, and the same command carries on', async (t) => {
  const h = setup(t);
  let stopped = false;
  const stack = h.stack;
  const base = sudoRunner({ opt: stack.opt, sudo: stack.sudo });
  let n = 0;
  const runner = async (id) => {
    n++;
    if (n === 3) stopped = true; // lands during the third run, which cannot be ended from here
    return base(id);
  };
  const runs = new ReviewStore(join(h.results, '..', 'seeded-b.db'));
  t.after(() => runs.close());
  const r = await seededRun({ sandbox: localSandbox, service: h.service, runs, runner, root: stack.root, isStopped: () => stopped });
  assert.equal(r.stoppedBy, 'the emergency stop');
  assert.equal(n, 3);
  assert.equal(seededNumbers(CASES.map((c) => caseState(runs, c))).answered, 3, 'the run that was going finished and is stored');
  assert.deepEqual(readdirSync(stack.root), []);
  stopped = false;
  const again = await seededRun({ sandbox: localSandbox, service: h.service, runs, runner, root: stack.root, isStopped: () => stopped });
  assert.equal(again.stoppedBy, null);
  assert.equal(n, 25);
});

test('seeded-run: refused during a stop, with the model step off, in a pause, and with no terminal and no --yes', async (t) => {
  const stopped = setup(t);
  assert.equal(await stopped.run(['--yes'], { stop: { stopped: true } }), 2);
  assert.match(stopped.printed(), /emergency stop/);
  assert.equal(stopped.calls().length, 0);

  const off = setup(t, { stack: { enabled: false } });
  assert.equal(await off.run(), 2);
  assert.match(off.printed(), /model step is off/);
  assert.equal(off.calls().length, 0);

  const paused = setup(t);
  paused.service.pauseForLimit(Date.now());
  assert.equal(await paused.run(), 2);
  assert.match(paused.printed(), /paused \(limit\)/);

  const nobody = setup(t);
  assert.equal(await nobody.run([]), 2);
  assert.match(nobody.printed(), /interactive terminal or --yes/);
  assert.ok(!existsSync(nobody.results), 'nothing made');
  assert.equal(await nobody.run(['--wat']), 2);
  assert.equal(await nobody.run(['--yes', '--run-name', '../up']), 2);

  const no = setup(t);
  const asked = [];
  assert.equal(await no.run([], { terminal: true, confirm: async (q) => (asked.push(q), false) }), 1);
  assert.equal(asked.length, 1);
  assert.equal(no.calls().length, 0);
  assert.match(no.printed(), /Nothing was spent/);
});

test('seeded-run, from main.js: refused with no terminal, leaving no database behind', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-seeded-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [join(REPO, 'reviewer', 'main.js'), 'seeded-run'], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /interactive terminal or --yes/);
  assert.deepEqual(readdirSync(dir), []);
});

test('seeded-run: three errors in a row stop it, so a parser with the output wrong cannot pay for the whole set', async (t) => {
  const h = setup(t, { control: { drop: ['permission_denials'] } });
  assert.equal(await h.run(), 3);
  assert.equal(h.calls().length, 3);
  assert.match(h.printed(), /Stopped by 3 errors in a row/);
  assert.match(h.printed(), /^SHAPE result\.permission_denials: expected array, got missing$/m);
  assert.match(h.printed(), /^SHAPE result fields: type,subtype/m);
  assert.ok(!h.printed().includes(MODEL_WORDS));
  assert.ok(h.resultsOf().shape.includes('result.permission_denials: expected array, got missing'));
});

test('seeded-run: three unrecognised failures open the pause, as in a real review, and the service hears of it', async (t) => {
  const h = setup(t, { control: { exit: 3, stderr: 'something new went wrong' } });
  assert.equal(await h.run(), 3);
  assert.equal(h.calls().length, 3);
  assert.equal(h.service.reviewPause(Date.now()).kind, 'limit');
  assert.ok(!h.printed().includes('something new went wrong'), 'the CLI\'s own words go to the local log only');
  assert.ok(readFileSync(join(h.results, 'seeded-default.log'), 'utf8').includes('something new went wrong'));
});

test('seeded-run: a credential problem pauses for the operator and is not the case\'s fault; running it again lifts this set\'s own pause', async (t) => {
  const h = setup(t, { control: { result: { is_error: true, result: 'Invalid API key' } } });
  assert.equal(await h.run(), 3);
  assert.equal(h.calls().length, 1);
  assert.match(h.printed(), /Stopped by a credential problem/);
  assert.equal(h.service.reviewPause(Date.now()).kind, 'auth');
  h.writeControl({});
  h.service.clearPause();
  h.lines.length = 0;
  assert.equal(await h.run(), 0, h.printed());
  assert.equal(h.calls().length, 26);
  assert.match(h.printed(), /Errors: +0 of 25/);
});

test('seeded-run: a transient failure is an error for now and is tried again by the next run, at most three times in all, and no more than the ceiling', async (t) => {
  const c = CASES.slice(0, 2);
  const h = setup(t, { cases: c, control: { result: { is_error: true, result: 'Internal server error' } } });
  for (let i = 1; i <= 3; i++) {
    h.lines.length = 0;
    assert.equal(await h.run(), 0, h.printed());
    assert.equal(h.calls().length, 2 * i);
    assert.match(h.printed(), /error \(transient\)/);
  }
  h.lines.length = 0;
  assert.equal(await h.run(), 0);
  assert.equal(h.calls().length, 6, 'three times, and then it counts as final');

  const tight = setup(t, { cases: c, ceiling: 3, control: { result: { is_error: true, result: 'Internal server error' } } });
  assert.equal(await tight.run(), 0);
  assert.equal(tight.calls().length, 2);
  tight.lines.length = 0;
  assert.equal(await tight.run(), 3, 'one more run hits the ceiling');
  assert.equal(tight.calls().length, 3);
  assert.match(tight.printed(), /at most 1 paid runs/);
  assert.match(tight.printed(), /Stopped by the ceiling of 3 paid runs/);
  tight.lines.length = 0;
  assert.equal(await tight.run(), 2, 'and then it is refused outright');
  assert.equal(tight.calls().length, 3);
  assert.match(tight.printed(), /has used its ceiling of 3 paid runs/);
  assert.equal(SEEDED_CEILING, 30);
  assert.ok(SEEDED_CEILING >= CASES.length);
});

test('seeded-run: a later named run starts again, for a change of CLI, model or skill', async (t) => {
  const h = setup(t, { cases: CASES.slice(0, 2) });
  assert.equal(await h.run(['--yes', '--run-name', 'first']), 0, h.printed());
  assert.equal(await h.run(['--yes', '--run-name', 'second']), 0, h.printed());
  assert.equal(h.calls().length, 4);
  assert.equal(h.resultsOf('first').cases.length, 2);
  assert.equal(h.resultsOf('second').cases.length, 2);
});

test('seeded-run cannot post to GitHub: the stand-in has only what reading needs, and neither command is given a client', async () => {
  const gh = seededGitHub(CASES);
  assert.deepEqual(Object.keys(gh).sort(), ['compareFiles', 'downloadTarball', 'getPull']);
  assert.ok(Object.isFrozen(gh));
  assert.deepEqual(await gh.getPull(CASES[3].pr), { sha: CASES[3].sha, state: 'open', base: 'main' });
  assert.equal(await gh.downloadTarball(CASES[3].sha), CASES[3].tarball);
  assert.deepEqual((await gh.compareFiles('main', CASES[3].sha)).files, CASES[3].changed);
  for (const file of ['seeded-run.js', 'review-live.js', 'paid-tools.js', 'seeded-set.js', 'live-fixture.js']) {
    assert.ok(!/from '\.\/github\.js'/.test(readFileSync(join(REPO, 'reviewer', file), 'utf8')), file);
  }
});

test('the numbers: the bar is met or not at its edges, and errors are out of the cases that have an answer', () => {
  const states = (kind, outcomes) => outcomes.map((outcome, i) => ({ name: `${kind}${i}`, kind, outcome, runs: outcome === 'not-run' ? 0 : 1, paidRuns: 1, cost: 0, turns: 0, durationMs: 0 }));
  const set = (defects, clean) => [...states('defect', defects), ...states('clean', clean)];
  const at = (a, b) => seededNumbers(set(a, b)).bar;
  const caughtN = (n) => [...Array(n).fill('caught'), ...Array(10 - n).fill('missed')];
  assert.equal(at(caughtN(BAR.defectsCaught), []).defects, true);
  assert.equal(at(caughtN(BAR.defectsCaught - 1), []).defects, false);
  assert.equal(at([], ['false-block', 'clean-pass']).falseBlocks, true);
  assert.equal(at([], ['false-block', 'false-block']).falseBlocks, false);
  const manyClean = Array(9).fill('clean-pass');
  assert.equal(at([], [...manyClean, 'error']).errors, false, 'one in ten is not under 10%');
  assert.equal(at([], [...manyClean, 'clean-pass', 'error']).errors, true, 'one in eleven is');
  assert.equal(seededNumbers(set([], ['clean-pass', 'not-run'])).complete, false);
  assert.equal(seededNumbers(set([], ['clean-pass', 'not-run'])).answered, 1);
  assert.equal(seededNumbers([]).bar.errors, false, 'no answers meet no bar');
});

// --- shadow mode, end to end with the fake CLI ------------------------------

function shadowSetup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-shadow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stack = sharedStack();
  const dbPath = join(dir, 'reviewer.db');
  const store = new ReviewStore(dbPath);
  t.after(() => store.close());
  const statuses = [];
  const comments = [];
  const heads = new Map();
  const gh = {
    openPulls: async () => [],
    compareFiles: async () => ({ files: [{ filename: 'src/index.js', status: 'modified', patch: '@@ -1 +1,2 @@\n x\n+export const b = 2;' }], truncated: false }),
    downloadTarball: async () => CASES[0].tarball,
    getPull: async (pr) => heads.get(pr) ?? null,
    setStatus: async (sha, context, state, description) => statuses.push({ sha, context, state, description }),
    findReviewComment: async () => null,
    createComment: async (pr, body) => (comments.push(body), comments.length),
    updateComment: async () => {},
  };
  const logs = [];
  const engine = reviewEngine({ env: { REVIEW_ENGINE: 'shadow', REVIEW_DAILY_CAP: '100' }, github: gh, store, sandbox: localSandbox, log: (l) => logs.push(l), opt: stack.opt, sudo: stack.sudo, root: stack.root });
  const d = new Dispatcher({
    store, github: gh, repo: 'o/r', authors: ['alice'], log: (l) => logs.push(l), linkTasks: false, isStopped: () => false, ...engine,
    runTests: async () => ({ state: 'success', summary: 'npm test passed' }),
  });
  let nextPr = 1;
  const once = async (output) => {
    const pr = nextPr++;
    const sha = pr.toString(16).padStart(40, 'a');
    store.enqueue(pr, sha, { branch: `feature/${pr}`, base: 'main', author: 'alice', title: 'T', body: '' }, Date.now());
    heads.set(pr, { sha, state: 'open', base: 'main' });
    writeFileSync(stack.control, JSON.stringify(typeof output === 'function' ? output(sha) : output));
    return { pr, sha, r: await d.runOnce() };
  };
  return { store, dbPath, statuses, comments, logs, once, stack };
}

test('shadow, end to end: the mock decides what is required, the real review only posts a verdict to its own status, and its findings stay in the log', async (t) => {
  const h = shadowSetup(t);
  const { pr, sha, r } = await h.once((s) => ({ output: { verdict: 'fail', sha: s, findings: [{ file: 'src/index.js', line: 2, severity: 'blocker', message: MODEL_WORDS }] } }));
  assert.deepEqual(r, { pr, sha, tests: 'success', review: 'success' }, 'the mock passes it, and that is what counts');
  const of = (context) => h.statuses.filter((s) => s.context === context);
  assert.deepEqual(of(CONTEXTS.review).at(-1).state, 'success');
  assert.deepEqual(of(CONTEXTS.tests).at(-1).state, 'success');
  assert.deepEqual(of(SHADOW_CONTEXT), [{ sha, context: SHADOW_CONTEXT, state: 'failure', description: '1 blocking finding(s)' }]);
  assert.ok(!Object.values(CONTEXTS).includes(SHADOW_CONTEXT), 'not one of the required checks');
  assert.ok(!JSON.stringify([h.statuses, h.comments]).includes(MODEL_WORDS), 'nothing the model wrote on GitHub');
  assert.ok(h.logs.some((l) => l.includes('shadow finding') && l.includes(MODEL_WORDS)), 'it is in the local log');
  assert.equal(h.comments.length, 1);
  assert.match(h.comments[0], /Review by mock-v1/);
  assert.deepEqual(readdirSync(h.stack.root), []);
});

test('status summarises the shadow results as counts and estimates, leaving out the check tools\' own runs and anything a review said', async (t) => {
  const h = shadowSetup(t);
  await h.once((s) => ({ output: { verdict: 'fail', sha: s, findings: [{ file: 'src/index.js', line: 2, severity: 'blocker', message: MODEL_WORDS }] } }));
  await h.once({});
  await h.once({ drop: ['permission_denials'] });
  await h.once({ result: { is_error: true, result: 'Internal server error' } });
  // The live check's rows count towards the day's cap, and are not results on real commits.
  const id = h.store.beginReviewRun({ pr: CHECK_PR_BASE + 1, sha: 'c'.repeat(40), skill: 's', model: 'm', now: Date.now(), cap: 100 });
  h.store.finishReviewRun(id, { outcome: 'valid', result: { state: 'failure', findings: [] }, cost: 100, turns: 100, durationMs: 100, now: Date.now() });

  const totals = h.store.reviewRunTotals();
  assert.equal(totals.runs, 4);
  assert.equal(totals.commits, 4);
  assert.equal(totals.turns, 16);
  const lines = reviewRunLines(totals);
  assert.deepEqual(lines, [
    'real review results on real commits: 4 run(s) on 4 commit(s): 1 pass, 1 fail, 2 no result (invalid 1, transient 1)',
    "  estimated cost $1.00 (the CLI's estimate, not a bill); about 4 turn(s) and 1 s a run",
  ]);
  assert.ok(!lines.join('\n').includes(MODEL_WORDS));

  const r = spawnSync(process.execPath, [join(REPO, 'reviewer', 'main.js'), 'status'], {
    encoding: 'utf8',
    cwd: dirname(h.dbPath),
    env: { PATH: process.env.PATH, HOME: dirname(h.dbPath), REVIEW_DB: h.dbPath, ADABRA_STOP_FILE: join(dirname(h.dbPath), 'no-stop.json') },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(lines[0]), r.stdout);
  assert.ok(r.stdout.includes(lines[1]));
  assert.ok(!r.stdout.includes(MODEL_WORDS));
});

test('status says nothing about real reviews when there have been none', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-shadow-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ReviewStore(join(dir, 'reviewer.db'));
  t.after(() => store.close());
  assert.deepEqual(reviewRunLines(store.reviewRunTotals()), []);
});
