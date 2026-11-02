import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// For the tests of the commands that spend: the real wrapper, as a temp copy, a stand-in for sudo, and a CLI that can only be the fake. So
// nothing that uses this can reach a model. The real install's paths are never named here.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USER_DIR = join(REPO, 'reviewer', 'review-user');
const FAKE_CLAUDE = join(REPO, 'test', 'fixtures', 'fake-claude.js');
const WORKER = join(REPO, 'reviewer', 'clean-worker.cjs');
export const CREDENTIAL = 'FAKE-CREDENTIAL-VALUE';
export const INSTALLED_CANARY = 'adabra-live-canary-installed-by-this-test';

// The cleaning step as the container runs it, without Docker.
export const localSandbox = {
  ensureDocker: async () => {},
  cleanTree: async ({ tarball }) => {
    const r = spawnSync(process.execPath, [WORKER], { input: tarball, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`cleaning failed: ${r.stderr}`);
    return { tar: r.stdout, report: JSON.parse(r.stderr.toString().trim().split('\n').at(-1)) };
  },
};

export function installStack(dir, { enabled = true, credential = true, canary = true } = {}) {
  const opt = join(dir, 'opt');
  const home = join(dir, 'review-home');
  const service = join(dir, 'service');
  for (const d of ['bin', 'etc', 'skill', 'in']) mkdirSync(join(opt, d), { recursive: true });
  mkdirSync(home);
  mkdirSync(service);
  chmodSync(join(opt, 'in'), 0o750);
  const record = join(dir, 'claude-calls.jsonl');
  const control = join(dir, 'claude-control.json');
  writeFileSync(control, '{}');
  const wrapper = readFileSync(join(USER_DIR, 'run-review'), 'utf8').replaceAll('/opt/adabra-review', opt).replace('-k 30 600', '-k 2 8');
  writeFileSync(join(opt, 'bin', 'run-review'), wrapper);
  chmodSync(join(opt, 'bin', 'run-review'), 0o755);
  writeFileSync(join(opt, 'bin', 'claude'), `#!/bin/sh\nFAKE_CLAUDE_CONTROL=${JSON.stringify(control)} FAKE_CLAUDE_RECORD=${JSON.stringify(record)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLAUDE)} "$@"\n`);
  chmodSync(join(opt, 'bin', 'claude'), 0o755);
  writeFileSync(join(opt, 'etc', 'paths.sh'), `REVIEW_USER=${userInfo().username}\nREVIEW_HOME=${home}\nDISPATCHER_HOME=${join(dir, 'none')}\nSERVICE_DIR=${service}\n`);
  for (const f of ['settings.json', 'review-schema.json']) writeFileSync(join(opt, 'etc', f), readFileSync(join(USER_DIR, f)));
  writeFileSync(join(opt, 'skill', 'review-v1.md'), readFileSync(join(USER_DIR, 'review-v1.md')));
  if (enabled) writeFileSync(join(opt, 'etc', 'model-enabled'), '');
  if (credential) writeFileSync(join(home, '.review-credential'), `${CREDENTIAL}\n`);
  if (canary) {
    writeFileSync(join(opt, 'etc', 'live-canary'), `${INSTALLED_CANARY}\n`);
    writeFileSync(join(home, '.review-canary'), `${INSTALLED_CANARY}\n`);
  }
  const sudo = join(dir, 'fake-sudo');
  writeFileSync(sudo, `#!/bin/sh
[ "$1" = -n ] || exit 1
shift
[ "$1" = -u ] || exit 1
shift 2
[ "$1" = ${JSON.stringify(join(opt, 'bin', 'run-review'))} ] || { echo 'sudo: a password is required' >&2; exit 1; }
exec /usr/bin/env -i PATH=/usr/bin:/bin "$@"
`);
  chmodSync(sudo, 0o755);
  return { dir, opt, home, service, record, control, sudo, root: join(opt, 'in'), markerDir: join(dir, 'markers'), runsDir: join(dir, 'runs') };
}
