import { spawn } from 'node:child_process';
import { rawTarEntry } from '../reviewer/tar.js';

// How the overnight runner's containers are started. Everything it makes carries LABEL and nothing else carries it, so it can always
// be swept, and the reviewer's own sweep (label adabra-review=1) and this one never touch each other's.
export const LABEL = 'adabra-night=1';
export const DEFAULT_IMAGE = 'adabra-night:dev';
export const CLI_VERSION = '2.1.316'; // with the checksums below, held to the Dockerfile by a test
export const CLI_SHA256 = Object.freeze({
  aarch64: '55cdb8e162d190432696ea54010e0fca2e18d06fa7a7127fd563b9ffd4f22624',
  x86_64: 'fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824',
});

// The session holds one secret: the model credential. It is passed by name, so the value is in no argument list. The session can read
// it, which is known and accepted: nothing here treats it as hidden.
export const CREDENTIAL_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';

export const SESSION_USER = '1000:1000';
export const TUNNEL_USER = '1001:1001';
export const SOCKET_DIR = '/sock';
export const SOCKET_PATH = `${SOCKET_DIR}/tunnel.sock`;
export const IMAGE_DIR = '/opt/adabra-night';
export const EXPORT_SCRIPT = `${IMAGE_DIR}/export.sh`;

export const SESSION_LIMITS = Object.freeze({ memory: '3g', cpus: '2', pids: 512, work: '2g', tmp: '512m' });
export const TUNNEL_LIMITS = Object.freeze({ memory: '256m', cpus: '0.5', pids: 64, tmp: '16m', logSize: '8m' });

// Every name a session's environment may hold: the credential, what the image's Dockerfile sets, what the base image sets, and what
// Docker adds. A test holds this to the Dockerfile.
export const IMAGE_ENV = Object.freeze([
  'PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'HTTPS_PROXY', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_TELEMETRY',
  'DISABLE_ERROR_REPORTING', 'DISABLE_AUTOUPDATER', 'DISABLE_UPDATES', 'ENABLE_CLAUDEAI_MCP_SERVERS', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS',
  'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_MAX_RETRIES', 'CI', 'NPM_CONFIG_UPDATE_NOTIFIER',
]);
export const ALLOWED_SESSION_ENV = Object.freeze([...IMAGE_ENV, CREDENTIAL_ENV, 'NODE_VERSION', 'YARN_VERSION', 'HOSTNAME']);

const labelArgs = (labels) => labels.flatMap((l) => ['--label', l]);

// A session: no network, no host files, not root, a read-only system and memory-only disks. `volume` holds the tunnel's socket, read-only.
// The run always takes the defaults. The containment check changes `network`, `readOnly` or `rm` only for its positive controls, and
// `extra` for what it adds on top.
export function sessionArgs({ name, image, volume = null, labels = [LABEL], network = 'none', readOnly = true, rm = true, extra = [] }) {
  const l = SESSION_LIMITS;
  return [
    'run', ...(rm ? ['--rm'] : []), '-i',
    '--name', name,
    ...labelArgs(labels),
    '--pull', 'never',
    '--network', network,
    ...(readOnly ? ['--read-only'] : []),
    '--tmpfs', `/work:rw,exec,nosuid,nodev,size=${l.work},uid=1000,gid=1000,mode=0755`,
    '--tmpfs', `/tmp:rw,exec,nosuid,nodev,size=${l.tmp},mode=1777`,
    '--user', SESSION_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(l.pids),
    '--memory', l.memory, '--memory-swap', l.memory,
    '--cpus', l.cpus,
    '--init',
    '--log-driver', 'none', // its output comes to the runner down the pipe, so a flood of it cannot fill the disk under Docker's log files
    ...(volume ? ['-v', `${volume}:${SOCKET_DIR}:ro`] : []),
    '-e', CREDENTIAL_ENV,
    '-w', '/work',
    ...extra,
    image,
  ];
}

// The tunnel: on a bridge network, with the socket's volume, and with nothing else from the host and no credential.
// Left unset, `allow` and `ranges` are the tunnel's own defaults: the real host.
export function tunnelArgs({ name, image, volume, network, labels = [LABEL], allow = null, ranges = null, maxSeconds = null, extra = [] }) {
  const l = TUNNEL_LIMITS;
  return [
    'run', '-d', '--rm',
    '--name', name,
    ...labelArgs(labels),
    '--pull', 'never',
    '--network', network,
    '--read-only',
    '--tmpfs', `/tmp:rw,nosuid,nodev,noexec,size=${l.tmp}`,
    '--user', TUNNEL_USER,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(l.pids),
    '--memory', l.memory, '--memory-swap', l.memory,
    '--cpus', l.cpus,
    '--init',
    '--log-driver', 'json-file', '--log-opt', `max-size=${l.logSize}`, '--log-opt', 'max-file=2', // refused requests are logged, so a flood of them must stay small
    '-v', `${volume}:${SOCKET_DIR}`,
    ...(allow ? ['-e', `NIGHT_TUNNEL_ALLOW=${allow}`] : []),
    ...(ranges ? ['-e', `NIGHT_TUNNEL_RANGES=${ranges}`] : []),
    ...(maxSeconds ? ['-e', `NIGHT_TUNNEL_MAX_SECONDS=${maxSeconds}`] : []),
    ...extra,
    image,
    'node', `${IMAGE_DIR}/tunnel.cjs`,
  ];
}

// The stdin of a session container: see the image's entry.sh.
export function taskInput({ taskText, sourceTarball }) {
  return Buffer.concat([
    rawTarEntry({ name: 'TASK.md', body: Buffer.from(taskText, 'utf8') }),
    rawTarEntry({ name: 'source.tar.gz', body: sourceTarball }),
    Buffer.alloc(1024),
  ]);
}

// One command. Never rejects: { code, stdout, stderr }, with code -1 if it could not start or ran out of time.
export function runCommand(file, args, { env = process.env, timeoutMs = 60_000, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      // A process it started (git's helper for https, say) can hold these open after it has gone, and then 'close' never comes.
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? -1 : (code ?? -1), stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    });
    child.stdin.end(input ?? undefined);
  });
}

const ids = (text) => text.split(/\s+/).filter(Boolean);

// Removes containers, then volumes and networks, carrying this label and no others. Resolves how many of each it found still there
// afterwards, so a caller can say whether the sweep worked. Only ever filters by the label it is given.
export async function removeByLabel({ docker, env, label }) {
  const list = {
    containers: () => runCommand(docker, ['ps', '-aq', '--filter', `label=${label}`], { env }),
    volumes: () => runCommand(docker, ['volume', 'ls', '-q', '--filter', `label=${label}`], { env }),
    networks: () => runCommand(docker, ['network', 'ls', '-q', '--filter', `label=${label}`], { env }),
  };
  const remove = {
    containers: (names) => runCommand(docker, ['rm', '-f', ...names], { env }),
    volumes: (names) => runCommand(docker, ['volume', 'rm', '-f', ...names], { env }),
    networks: (names) => runCommand(docker, ['network', 'rm', ...names], { env }),
  };
  const left = {};
  for (const kind of ['containers', 'volumes', 'networks']) {
    const found = ids((await list[kind]()).stdout);
    if (found.length) await remove[kind](found);
    left[kind] = ids((await list[kind]()).stdout).length;
  }
  return left;
}
