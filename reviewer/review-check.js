import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildJobDir, removeJobDir, walk } from './job-dir.js';
import { HOSTILE_KEPT, hostileTarball } from './tar.js';

// Proves the review user's boundaries on this machine, from that user's side, with no model call. Same style as
// sandbox-check: one line per check, and any failure means the real review must not be built on top of this.
// Nothing here reads or prints a protected file: the wrapper's probes open and close without reading, and a result is one of
// a few fixed words. The one file read back is the canary this check itself wrote.
// Nothing here can spend, even with the model step enabled: the wrapper starts the model only for a job holding the paid mark, and
// the jobs built here never hold it. So a wrapper call with a real job, or with any other id, ends before the credential is loaded.
export const OPT = '/opt/adabra-review';
const REVIEW_SHA = 'c'.repeat(40);
const ROOT_OWNED = [
  '', 'bin', 'bin/claude', 'bin/run-review', 'etc', 'etc/paths.sh', 'etc/settings.json', 'etc/review-schema.json', 'skill', 'skill/review-v1.md',
];
// What a shell started with a clean environment sets for itself, and what the wrapper sets. Anything else came from outside.
const ALLOWED_ENV = new Set(['HOME', 'PATH', 'PWD', 'OLDPWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING']);

function defaultRun(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000, maxBuffer: 1024 * 1024, ...options }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function readPaths(opt = OPT) {
  const file = join(opt, 'etc', 'paths.sh');
  if (!existsSync(file)) throw new Error(`${file} is missing: run sudo service/review-user.sh install first`);
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export function parseProbes(text) {
  const seen = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z_.]+)=(.*)$/);
    if (m && !(m[1] in seen)) seen[m[1]] = m[2];
  }
  return seen;
}

// The answer each probe must give. A probe that did not report counts as failed.
export function expectedProbes({ reviewUser, withJob = true }) {
  const denied = ['canary', 'home', 'review_token', 'github_token', 'device_token', 'helper_token', 'gh_login', 'claude_login', 'keychains', 'launch_agents', 'coordinator_db', 'reviewer_db'];
  const notWritable = ['wrapper', 'cli', 'paths', 'settings', 'schema', 'skill', 'bin_dir', 'etc_dir', 'skill_dir', 'job_root'];
  return {
    user: reviewUser,
    primary_group: reviewUser,
    admin: 'no',
    sudo: 'none',
    credential: 'present',
    credential_mode: '400',
    ...Object.fromEntries(denied.map((k) => [`read.${k}`, 'denied'])),
    'tool.nc': 'present',
    'socket.docker_home': 'refused',
    'socket.docker_var': 'refused',
    ...Object.fromEntries(notWritable.map((k) => [`writable.${k}`, 'no'])),
    ...(withJob ? {
      'job.tree': 'open',
      'job.diff': 'open',
      'job.pr': 'open',
      'job.file': 'open',
      'job.write_file': 'no',
      'job.create': 'denied',
      'job.create_tree': 'denied',
    } : {}),
  };
}

// Results for one wrapper run. Values only ever come from the root-owned wrapper's fixed words.
export function judgeProbes(seen, { reviewUser, canaryName, withJob = true }) {
  const results = Object.entries(expectedProbes({ reviewUser, withJob })).map(([check, want]) => ({
    check, want, got: seen[check] ?? 'not reported', ok: seen[check] === want,
  }));
  const names = (seen.env ?? '').split(',').filter(Boolean);
  const extra = names.filter((n) => !ALLOWED_ENV.has(n));
  results.push({ check: 'env.only_allowed', want: 'no others', got: !names.length ? 'not reported' : extra.join(',') || 'no others', ok: names.length > 0 && !extra.length });
  results.push({ check: 'env.canary', want: 'absent', got: names.includes(canaryName) ? 'PRESENT' : 'absent', ok: names.length > 0 && !names.includes(canaryName) });
  return results;
}

const pass = (check, want, got, ok = got === want) => ({ check, want, got, ok });

// Runs every check. `sudo`, `run`, `rootUid` and `opt` are for tests; on the mini they stay at their defaults.
export async function reviewCheck({ sandbox, opt = OPT, sudo = '/usr/bin/sudo', run = defaultRun, home = homedir(), rootUid = 0, now = Date.now }) {
  const results = [];
  const paths = readPaths(opt);
  const reviewUser = paths.REVIEW_USER;
  const wrapper = join(opt, 'bin', 'run-review');
  const jobRoot = join(opt, 'in');
  const modelEnabled = existsSync(join(opt, 'etc', 'model-enabled'));
  const canaryName = `ADABRA_CANARY_${randomBytes(4).toString('hex')}`;
  const env = { ...process.env, [canaryName]: 'must not reach the review user' };
  // The dispatcher's folders are closed to the review user, so sudo must not start from one of them.
  const asReview = (args, extraArgs = []) => run(sudo, ['-n', ...extraArgs, '-u', reviewUser, wrapper, ...args], { env, cwd: opt });

  // What only root may change.
  for (const rel of [...ROOT_OWNED, ...(modelEnabled ? ['etc/model-enabled'] : [])]) {
    const path = join(opt, rel);
    let got = 'missing';
    if (existsSync(path)) {
      const s = lstatSync(path);
      if (s.isSymbolicLink()) got = 'a symbolic link';
      else if (s.uid !== rootUid) got = 'not root-owned';
      else if (s.mode & 0o022) got = 'writable by others';
      else got = 'root only';
    }
    results.push(pass(`owner.${rel || 'opt'}`, 'root only', got));
  }

  const root = existsSync(jobRoot) ? lstatSync(jobRoot) : null;
  results.push(pass('job_root.owner', 'this user', root?.uid === process.getuid() ? 'this user' : 'other'));
  results.push(pass('job_root.mode', '750', root ? (root.mode & 0o777).toString(8) : 'missing'));

  // Sudo must allow the wrapper and nothing else, and no environment may be passed through it.
  const refused = async (check, args) => {
    const r = await run(sudo, args, { env, cwd: opt });
    results.push(pass(check, 'refused', r.code === 0 ? 'ALLOWED' : 'refused'));
  };
  await refused('sudo.root', ['-n', '/usr/bin/true']);
  await refused('sudo.other_command', ['-n', '-u', reviewUser, '/usr/bin/id']);
  await refused('sudo.shell', ['-n', '-u', reviewUser, '/bin/sh', '-c', 'true']);
  await refused('sudo.set_variable', ['-n', '-u', reviewUser, 'ADABRA_WRAPPER_CLEAN=1', wrapper, 'check']);
  await refused('sudo.keep_environment', ['-n', '-E', '-u', reviewUser, wrapper, 'check']);

  const direct = await run(wrapper, ['check'], { env, cwd: opt });
  results.push(pass('wrapper.as_this_user', 'refused', direct.code === 0 ? 'RAN' : 'refused'));

  // A canary only this user's home protects: it proves "denied" means denied, and not just that the file is missing.
  const canary = join(home, '.adabra-review-canary');
  const canaryText = randomBytes(16).toString('hex');
  const leftovers = [];
  try {
    writeFileSync(canary, canaryText);
    chmodSync(canary, 0o644);
    results.push(pass('control.canary_readable_here', 'yes', readFileSync(canary, 'utf8') === canaryText ? 'yes' : 'no'));
    // The same for the socket probe: from this user the same command connects, so "refused" from the review user means something.
    const live = await run('/bin/sh', ['-c', '/usr/bin/nc -U "$1" </dev/null >/dev/null 2>&1', 'sh', join(home, '.docker', 'run', 'docker.sock')], { env, cwd: opt, timeout: 5000 });
    results.push(pass('control.socket_connects_here', 'yes', live.code === 0 ? 'yes' : 'no'));

    // The hostile archive, through the real cleaning step and into a real job directory.
    const { tar, report } = await sandbox.cleanTree({ name: `adabra-review-check-${now()}`, tarball: hostileTarball() });
    const job = buildJobDir({ root: jobRoot, pr: 1, sha: REVIEW_SHA, tar, report, diff: 'diff --git a/x b/x\n', title: 'review-check', now: now() });
    leftovers.push(job.id);
    const tree = walk(join(job.dir, 'tree'));
    const kept = tree.filter((e) => e.stat.isFile()).map((e) => e.path).sort();
    results.push(pass('clean.kept_only', HOSTILE_KEPT.join(','), kept.join(',')));
    const special = tree.filter((e) => !e.stat.isFile() && !e.stat.isDirectory());
    results.push(pass('clean.no_special_files', '0', String(special.length)));
    results.push(pass('clean.nothing_escaped', 'none', existsSync(join(jobRoot, 'escape.txt')) || existsSync(join(job.dir, 'escape.txt')) ? 'ESCAPED' : 'none'));

    const all = walk(job.dir);
    const badMode = all.filter((e) => (e.stat.mode & 0o777) !== (e.stat.isDirectory() ? 0o750 : 0o640));
    results.push(pass('job.modes', 'dirs 750, files 640', badMode.length ? `${badMode.length} wrong` : 'dirs 750, files 640'));
    const otherGroup = all.filter((e) => e.stat.gid !== root?.gid);
    results.push(pass('job.group', 'inherited', otherGroup.length ? `${otherGroup.length} wrong` : 'inherited'));

    const r = await asReview(['check', job.id]);
    results.push(pass('wrapper.runs', 'exit 0', `exit ${r.code}`));
    const seen = parseProbes(r.stdout);
    results.push(...judgeProbes(seen, { reviewUser, canaryName }));
    results.push(pass('job.group_is_review_user', seen.gid ?? 'not reported', String(root?.gid ?? 'missing')));
    // A wrapper from before the model step does not report this, and has no model step to be on.
    results.push(pass('wrapper.model_step', modelEnabled ? 'on' : 'off', seen.model_step ?? 'off'));
    results.push(pass('output.no_canary_text', 'clean', `${r.stdout}${r.stderr}`.includes(canaryText) ? 'LEAKED' : 'clean'));

    // The wrapper's front door.
    for (const [check, id] of [
      ['id.traversal', '../../etc'],
      ['id.empty', ''],
      ['id.command', '$(id)'],
      ['id.short', `1-${'a'.repeat(39)}-1234567890`],
      ['id.newline', `${job.id}\nevil`],
      ['id.unknown', `2-${REVIEW_SHA}-1234567890`],
    ]) {
      const bad = await asReview([id]);
      results.push(pass(`wrapper.${check}`, 'exit 64', `exit ${bad.code}`));
    }
    const twoArgs = await asReview([job.id, 'extra']);
    results.push(pass('wrapper.extra_argument', 'exit 64', `exit ${twoArgs.code}`));

    // Off: refused because the step is off. On: refused because this job has no paid mark. Both end before the credential is
    // loaded, and if someone enables the step while this runs, the answer only fails to match. It still cannot reach the model.
    const off = await asReview([job.id]);
    if (modelEnabled) results.push(pass('wrapper.unmarked_job_refused', 'exit 79', `exit ${off.code}`));
    else results.push(pass('wrapper.no_model_step', 'exit 78', `exit ${off.code}`));
    results.push(pass('wrapper.no_model_output', 'none', off.stdout === '' ? 'none' : 'SOME'));

    // Links are how a job could point the review user at its own files.
    const linkedId = `3-${REVIEW_SHA}-${now()}`;
    leftovers.push(linkedId);
    symlinkSync(paths.REVIEW_HOME, join(jobRoot, linkedId));
    const asLink = await asReview([linkedId]);
    results.push(pass('wrapper.job_is_link', 'exit 64', `exit ${asLink.code}`));
    const holdingId = `4-${REVIEW_SHA}-${now()}`;
    leftovers.push(holdingId);
    mkdirSync(join(jobRoot, holdingId), { mode: 0o750 });
    chmodSync(join(jobRoot, holdingId), 0o750);
    symlinkSync(join(paths.REVIEW_HOME, '.review-credential'), join(jobRoot, holdingId, 'credential'));
    const inside = await asReview([holdingId]);
    results.push(pass('wrapper.job_holds_link', 'exit 64', `exit ${inside.code}`));
  } finally {
    rmSync(canary, { force: true });
    for (const id of leftovers) removeJobDir(jobRoot, id);
  }
  return { ok: results.every((x) => x.ok), results };
}
