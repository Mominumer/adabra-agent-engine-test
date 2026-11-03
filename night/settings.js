import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { readSecretFile } from '../helper/platform.js';
import { GitHubSettingsError, appAuthFromEnv } from '../shared/github-auth.js';
import { MACHINE_DIR } from '../shared/stop.js';
import { approvalSettings } from './approval.js';
import { DEFAULT_IMAGE } from './containers.js';
import { WRITE_PERMISSIONS } from './publish.js';

// The overnight runner's settings. There is no default for anything that decides who may approve, what gets published or where the
// emergency stop is, so a machine that is not set up cannot run this by accident. Anything unset is a refusal that names the setting.
//
//   GITHUB_REPO, NIGHT_APPROVER_ID, NIGHT_AUTHOR_IDS, NIGHT_APPROVAL_LABEL_ID, NIGHT_DB    who may approve what: see approval.js
//   NIGHT_STOP_FILE      the machine-wide stop file, named here so that nothing is worked out at run time: see shared/stop.js.
//                        Must be /opt/adabra-control/stop.json. If it is missing the runner refuses to start
//   NIGHT_HOME           this runner's private folder: run records, saved diffs, raw session output
//   TEAM_AGENT_HOME      this runner's own helper folder, for device night-runner: config.json, token, claims.json, outbox.db
//   NIGHT_APP_ID, NIGHT_APP_INSTALLATION_ID, NIGHT_APP_KEY_FILE    the GitHub App that publishes. It has no statuses and no workflows
//   NIGHT_CREDENTIAL_FILE  the model credential for the session, mode 600. It is read when a session starts and goes to no other process
//   NIGHT_IMAGE_ID       the exact image a session may run in: docker image inspect <image> --format '{{.Id}}'
//   NIGHT_REQUIRED_REVIEW_ON  must be `yes` for `serve`: the operator's word that main requires their review. run-once does not need it
//
// With defaults, because none of them decides anything of that kind:
//   NIGHT_IMAGE (adabra-night:dev), NIGHT_DOCKER (docker), NIGHT_TUNNEL_NETWORK (bridge), NIGHT_API_URL (https://api.github.com),
//   NIGHT_GIT_URL (https://github.com/<repo>.git), NIGHT_REPORT_DIR (~/Library/Logs/adabra-night), NIGHT_RUNS_PER_NIGHT (1, at most 3)
export const DEVICE_ID = 'night-runner';
export const MACHINE_STOP_FILE = join(MACHINE_DIR, 'stop.json');
export const MAX_RUNS_PER_NIGHT = 3;
// What the runner's reads may use: never a write, and no token for the session to see in any case.
export const READ_PERMISSIONS = Object.freeze({ contents: 'read', issues: 'read', metadata: 'read' });

const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const absolute = (v) => {
  const s = String(v ?? '').trim();
  return s && isAbsolute(s) ? s : null;
};

export function nightSettings(env = process.env, { home = homedir() } = {}) {
  const problems = [];
  const need = (value, name) => {
    if (!value) problems.push(`${name} is not set, or is not valid`);
    return value;
  };
  const approval = approvalSettings(env);
  need(approval.repo, 'GITHUB_REPO');
  need(approval.approverId, 'NIGHT_APPROVER_ID');
  need(approval.authorIds.length, 'NIGHT_AUTHOR_IDS');
  need(approval.labelId, 'NIGHT_APPROVAL_LABEL_ID');
  need(approval.ledgerPath && isAbsolute(approval.ledgerPath), 'NIGHT_DB');
  const imageId = String(env.NIGHT_IMAGE_ID ?? '').trim();
  const runs = String(env.NIGHT_RUNS_PER_NIGHT ?? '1').trim();
  const runsPerNight = /^[1-9]$/.test(runs) && Number(runs) <= MAX_RUNS_PER_NIGHT ? Number(runs) : null;
  need(runsPerNight, 'NIGHT_RUNS_PER_NIGHT');
  let gitUrl = null;
  try {
    const url = new URL(String(env.NIGHT_GIT_URL ?? '').trim() || `https://github.com/${approval.repo}.git`);
    if (url.protocol === 'https:' || url.protocol === 'file:') gitUrl = url.href;
  } catch {
    // Reported below.
  }
  need(gitUrl, 'NIGHT_GIT_URL');
  return Object.freeze({
    problems,
    approval,
    repo: approval.repo,
    stopFile: need(absolute(env.NIGHT_STOP_FILE), 'NIGHT_STOP_FILE'),
    nightHome: need(absolute(env.NIGHT_HOME), 'NIGHT_HOME'),
    agentHome: need(absolute(env.TEAM_AGENT_HOME), 'TEAM_AGENT_HOME'),
    credentialFile: need(absolute(env.NIGHT_CREDENTIAL_FILE), 'NIGHT_CREDENTIAL_FILE'),
    imageId: need(IMAGE_ID_RE.test(imageId) ? imageId : null, 'NIGHT_IMAGE_ID'),
    image: String(env.NIGHT_IMAGE ?? '').trim() || DEFAULT_IMAGE,
    docker: String(env.NIGHT_DOCKER ?? '').trim() || 'docker',
    tunnelNetwork: String(env.NIGHT_TUNNEL_NETWORK ?? '').trim() || 'bridge',
    apiUrl: (String(env.NIGHT_API_URL ?? '').trim() || 'https://api.github.com').replace(/\/$/, ''),
    gitUrl,
    reportDir: absolute(env.NIGHT_REPORT_DIR) ?? join(home, 'Library', 'Logs', 'adabra-night'),
    runsPerNight,
    requiredReviewOn: String(env.NIGHT_REQUIRED_REVIEW_ON ?? '').trim() === 'yes',
    defaultAgentHome: join(home, '.team-agent'),
  });
}

// The publishing App, asking for these permissions. Throws GitHubSettingsError if it is not fully and correctly set up. Unset is an
// error too: there is no token file to fall back on.
export function appAuth({ env, settings, permissions, ...options }) {
  const auth = appAuthFromEnv({ prefix: 'NIGHT', repo: settings.repo ?? '', permissions, env, apiUrl: settings.apiUrl, ...options });
  if (!auth) throw new GitHubSettingsError('NIGHT_APP_ID, NIGHT_APP_INSTALLATION_ID and NIGHT_APP_KEY_FILE are not set');
  return auth;
}

// The device this runner acts as. Read each time, so a rotated token needs no restart.
export function deviceConfig(agentHome) {
  const config = JSON.parse(readFileSync(join(agentHome, 'config.json'), 'utf8'));
  return { url: config.coordinator_url, deviceId: config.device_id, token: readSecretFile(join(agentHome, 'token')) };
}

function deviceRefusals(settings) {
  if (!settings.agentHome) return [];
  if (resolve(settings.agentHome) === resolve(settings.defaultAgentHome)) return ['TEAM_AGENT_HOME must be this runner\'s own folder, and not the one a builder uses'];
  let device;
  try {
    device = deviceConfig(settings.agentHome);
  } catch {
    return ['TEAM_AGENT_HOME does not hold a readable config.json and token: enrol the device first'];
  }
  const out = [];
  if (device.deviceId !== DEVICE_ID) out.push(`TEAM_AGENT_HOME must hold device ${DEVICE_ID}`);
  if (!device.token) out.push('TEAM_AGENT_HOME holds an empty device token');
  try {
    const url = new URL(device.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) out.push('the coordinator URL must be https, or http to this machine');
  } catch {
    out.push('the coordinator URL in TEAM_AGENT_HOME is not valid');
  }
  return out;
}

// Reads the model credential, for a session and nothing else. Null if it is not there, not a plain file, or open to anyone else.
export function readCredential(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.mode & 0o077) return null;
    return readSecretFile(path) || null;
  } catch {
    return null;
  }
}

// Why this machine may not run this at all. Empty means it may. Checked before anything starts, by run-once and by serve. All local.
export function startupRefusals(settings, { env, machineStopFile = MACHINE_STOP_FILE } = {}) {
  const out = [...settings.problems];
  if (settings.stopFile) {
    if (settings.stopFile !== machineStopFile) out.push(`NIGHT_STOP_FILE must be ${machineStopFile}`);
    if (!existsSync(settings.stopFile)) out.push(`the stop file ${settings.stopFile} is missing`);
  }
  out.push(...deviceRefusals(settings));
  if (settings.approval.ledgerPath && !existsSync(settings.approval.ledgerPath)) out.push('there is no ledger at NIGHT_DB: node night/main.js check-approval <TASK-N> --gh --create-ledger makes one');
  if (settings.credentialFile && !readCredential(settings.credentialFile)) out.push('NIGHT_CREDENTIAL_FILE cannot be read, is empty, or can be reached by group or others');
  try {
    appAuth({ env, settings, permissions: WRITE_PERMISSIONS });
  } catch (err) {
    if (err instanceof GitHubSettingsError) out.push(err.message);
    else throw err;
  }
  return out;
}
