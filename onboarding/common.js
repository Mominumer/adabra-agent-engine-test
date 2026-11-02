// Rules and wording shared by the operator's command and the teammate's setup. Nothing here prints, or sees a token's value
// except to check its form. Imports nothing that needs a recent Node, so a too-old Node gets a clear message, not a stack.
import { win32 } from 'node:path';
import { DEVICE_ID_RE, TASK_ID_RE } from '../shared/event.js';

export const MIN_NODE = [22, 13];
export const TOKEN_RE = /^[0-9a-f]{64}$/; // what Store.addDevice makes; a test keeps the two in step

const THIS_MACHINE = new Set(['localhost', '127.0.0.1', '[::1]']);

export const isThisMachine = (url) => THIS_MACHINE.has(new URL(url).hostname);

export function nodeIsTooOld(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

// The coordinator's address is always an input: it changes when the tailnet moves. Returns { url } or { error }.
// Errors never repeat what was given, in case someone put the wrong thing in the wrong place.
export function checkCoordinatorAddress(input) {
  const shape = 'Use the address your operator gave you, in the form https://<coordinator-host>.';
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { error: `--coordinator is not a valid address. ${shape}` };
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && THIS_MACHINE.has(parsed.hostname))) {
    return { error: `--coordinator must start with https:// (http:// only for this machine), or the token would travel in clear. ${shape}` };
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    return { error: `--coordinator must be just the address, with nothing after the host name and port. ${shape}` };
  }
  return { url: parsed.origin };
}

export const DEVICE_ID_RULE = 'A device ID is lowercase letters, digits and hyphens, starts with a letter or digit, and is at most 63 characters.';
export const isDeviceId = (id) => typeof id === 'string' && DEVICE_ID_RE.test(id);
export const isTaskId = (id) => typeof id === 'string' && TASK_ID_RE.test(id);

// What to do about a failed connection. Only the error's code is shown: it holds no address or header.
export function connectionFailure(err, url) {
  // A timed-out request's own `code` is a number that means nothing to anyone, so its name comes first.
  const code = String(err?.cause?.code ?? (err?.name === 'TimeoutError' ? err.name : err?.code ?? err?.name ?? 'unknown error'));
  let what = 'The connection failed.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') what = 'That name does not resolve from this machine.';
  else if (code === 'ECONNREFUSED') what = 'Nothing is listening at that address.';
  else if (/TIMEOUT|TimeoutError|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(code)) what = 'Nothing answered in time.';
  else if (/CERT|TLS|SSL|SIGNATURE/.test(code)) what = 'The secure connection failed.';
  const why = isThisMachine(url)
    ? 'Most likely the coordinator is not running on this machine, or the port is wrong.'
    : 'Most likely this machine is not on the tailnet yet, or the address is wrong.';
  return `${what} ${why} (${code})`;
}

// Where the Tailscale command can be. On a Mac the app usually does not put it on PATH.
export function tailscaleCandidates(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  if (platform === 'win32') return ['tailscale', win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')];
  return ['tailscale'];
}

const INSTALL_TAILSCALE = 'Install it from https://tailscale.com/download, sign in with the account your operator invited, and run this again.';

// Reads only the connection state from `tailscale status --json`, whose other fields name the tailnet and its machines.
// `problem` is what is wrong and `fix` is what to do; neither is set when it is connected.
export function tailscaleProblem({ found, code, stdout = '' }) {
  if (!found) return { problem: 'Tailscale is not installed', fix: INSTALL_TAILSCALE };
  let state = null;
  if (code === 0) {
    try {
      state = JSON.parse(stdout).BackendState ?? null;
    } catch {
      state = null;
    }
  }
  switch (state) {
    case 'Running': return {};
    case 'Stopped': return { problem: 'Tailscale is switched off', fix: 'Open the Tailscale app, turn it on, and run this again.' };
    case 'NeedsLogin':
    case 'NoState': return { problem: 'Tailscale is not signed in', fix: 'Open the Tailscale app, sign in with the account your operator invited, and run this again.' };
    case 'NeedsMachineAuth': return { problem: 'Tailscale is waiting for this machine to be approved', fix: 'Ask your operator to approve it, then run this again.' };
    case 'Starting': return { problem: 'Tailscale is still starting', fix: 'Wait a moment and run this again.' };
    default: return { problem: 'Tailscale is installed, but it is not running', fix: 'Open the Tailscale app, make sure it is connected, and run this again.' };
  }
}

// The platform's background-helper script, or null where there is none. Both answer `status` with "service not loaded"
// when nothing is running. The token never reaches either: they check that the file exists and read no further.
export function serviceCommand(action, { repoDir, platform = process.platform, env = process.env }) {
  if (platform === 'darwin') return { file: `${repoDir}/service/helper-service.sh`, args: [action] };
  if (platform === 'win32') {
    return {
      // A full path, so a powershell.exe earlier on PATH is never the one that runs.
      file: win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', win32.join(repoDir, 'service', 'helper-service.ps1'), action],
    };
  }
  return null;
}

// The commands a teammate runs. They hold no secret, so they are safe to send and to show.
export function setupCommands({ coordinator, device, task }) {
  const flags = `--coordinator ${coordinator} --device ${device} --test-task ${task}`;
  return {
    mac: `onboarding/setup-mac.sh ${flags}`,
    windows: `powershell -NoProfile -ExecutionPolicy Bypass -File onboarding\\setup-windows.ps1 ${flags}`,
  };
}

// Commands for this platform, for the "what to do" lines.
export function shellHints(platform = process.platform) {
  return platform === 'win32'
    ? {
        remove: (path) => `Remove-Item -LiteralPath "${path}"`,
        moveAway: (path) => `Move-Item -LiteralPath "${path}" -Destination "${path}.old"`,
        withHome: (home, command) => `$env:TEAM_AGENT_HOME = "${home}"; ${command}`,
        service: (repoDir) => `powershell -NoProfile -ExecutionPolicy Bypass -File "${win32.join(repoDir, 'service', 'helper-service.ps1')}" install`,
        git: 'Install Git from https://git-scm.com/download/win, open a new terminal, and run this again.',
      }
    : {
        remove: (path) => `rm "${path}"`,
        moveAway: (path) => `mv "${path}" "${path}.old"`,
        withHome: (home, command) => `TEAM_AGENT_HOME="${home}" ${command}`,
        service: (repoDir) => `"${repoDir}/service/helper-service.sh" install`,
        git: 'Run xcode-select --install, wait for it to finish, and run this again.',
      };
}
