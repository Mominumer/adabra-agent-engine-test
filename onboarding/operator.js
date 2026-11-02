#!/usr/bin/env node
// Operator's side of onboarding. Run it on the coordinator's machine, from the repo folder.
//
//   node onboarding/operator.js add <device-id> --coordinator <address> --test-task <TASK-N> [--out <file>]
//   node onboarding/operator.js rotate <device-id> [--restore] [--out <file>]
//   node onboarding/operator.js revoke <device-id>
//
// Environment: COORDINATOR_DB, as for coordinator/main.js (default ./coordinator.db).
//
// The token goes into a file only this user can read, and never to the screen, a log or an argument: this command is meant
// to be safe on a shared screen, where `device-add` is not. A file rather than the clipboard because it works the same over
// SSH and remote desktop, cannot be picked up by a clipboard manager or synced to another device, and is one known thing
// that can be seen to be gone once it is deleted.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Store } from '../coordinator/store.js';
import { checkCoordinatorAddress, DEVICE_ID_RULE, isDeviceId, isTaskId, setupCommands } from './common.js';

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `usage:
  node onboarding/operator.js add <device-id> --coordinator <address> --test-task <TASK-N> [--out <file>]
  node onboarding/operator.js rotate <device-id> [--restore] [--out <file>]
  node onboarding/operator.js revoke <device-id>

add        enrols a new builder device and saves its token in a file, without showing it
rotate     gives an existing device a new token the same way; the old token stops working
revoke     stops a device's token working, for good unless rotate --restore brings it back
--restore  lets rotate bring back a device that was revoked
--out      where to save the token (default: a private folder, ~/adabra-handover)

A device ID appears on public issues, so use a neutral one like builder-3, not a person's name.`;

class Refused extends Error {}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        coordinator: { type: 'string' },
        'test-task': { type: 'string' },
        out: { type: 'string' },
        restore: { type: 'boolean', default: false },
      },
    });
  } catch {
    return null; // parseArgs's own message repeats what was typed
  }
}

function openDatabase() {
  const path = process.env.COORDINATOR_DB ?? './coordinator.db';
  // Store would create an empty database, and the device would then exist nowhere that matters.
  if (!existsSync(path)) {
    throw new Refused(`There is no coordinator database at ${path}. Run this from the coordinator's repo folder, or set COORDINATOR_DB to the database the coordinator uses.`);
  }
  return new Store(path);
}

const deviceRow = (store, id) => store.db.prepare('SELECT revoked, role FROM devices WHERE device_id = ?').get(id);

// Before anything is created, so a mistake here leaves no device behind.
function checkTestTask(store, task) {
  const row = store.getTask(task);
  const pick = 'Pick another with: node coordinator/main.js tasks';
  if (!row) throw new Refused(`There is no task ${task}. ${pick}. Or add one: node coordinator/main.js task-add ${task} <issue-number>`);
  if (row.closed) throw new Refused(`${task} is closed, so the test claim would be refused. ${pick}`);
  if (row.assignee) throw new Refused(`${task} is reserved for ${row.assignee}, so the test claim would be refused. ${pick}`);
  if (row.returned_to) throw new Refused(`A failed review returned ${task} to ${row.returned_to}, so the test claim would be refused. ${pick}`);
  const claim = store.currentClaim(task);
  if (claim?.state === 'held' && claim.expires_at > Date.now()) {
    throw new Refused(`${task} is being worked on by ${claim.device_id}, so the test claim would be refused. ${pick}`);
  }
}

const defaultHandover = (device) => join(homedir(), 'adabra-handover', `${device}.token`);

function handoverPath(out, device) {
  if (!out) {
    const path = defaultHandover(device);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    return path;
  }
  const path = resolve(out);
  const inside = relative(repoDir, path);
  if (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) {
    throw new Refused('--out is inside the repository. Keep the token out of it: choose a folder elsewhere.');
  }
  return path;
}

// Opens the file before the token exists: if it cannot be written, or is already there, no device has been touched.
function openHandover(path) {
  try {
    return openSync(path, 'wx', 0o600); // refuses an existing file, and a link in its place
  } catch (err) {
    if (err.code === 'EEXIST') throw new Refused(`${path} already exists and was not changed. If it is left over, delete it first, or use --out to choose another file.`);
    throw new Refused(`Could not create ${path} (${err.code}). Use --out to choose another file.`);
  }
}

function issueToken(path, makeToken) {
  const fd = openHandover(path);
  try {
    writeSync(fd, `${makeToken()}\n`);
    closeSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw new Refused(`Could not save the token (${err.code ?? err.message}). If the device was created, give it a token with rotate, once this is sorted out.`);
  }
}

function repositoryAddress() {
  try {
    const url = execFileSync('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!/^https?:/.test(url)) return url;
    const parsed = new URL(url); // an address can carry a credential: never pass one on
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return '<this repository\'s address>';
  }
}

function privacySteps(path) {
  return [
    `  Give it to the teammate privately, through a password manager's share or an encrypted direct message:`,
    '  not email, a group chat, a ticket or a shared screen. Do not open it while your screen is shared.',
    `  To paste it somewhere without showing it (Mac): pbcopy < "${path}"`,
    `  Then delete your copy: rm "${path}"`,
  ];
}

function add(id, values) {
  const address = checkCoordinatorAddress(values.coordinator);
  if (address.error) throw new Refused(address.error);
  const task = values['test-task'];
  if (!isTaskId(task)) throw new Refused('--test-task is required: a task for the first test, like TASK-7. Its public issue will show one generic line.');

  const store = openDatabase();
  try {
    const existing = deviceRow(store, id);
    if (existing?.revoked) {
      throw new Refused(`${id} was revoked earlier, and IDs are not reused. Choose a new ID, or bring it back with: node onboarding/operator.js rotate ${id} --restore`);
    }
    if (existing) {
      throw new Refused(`${id} already exists and was not changed. Choose a new ID. If its token was lost: node onboarding/operator.js rotate ${id}`);
    }
    checkTestTask(store, task);
    const path = handoverPath(values.out, id);
    issueToken(path, () => store.addDevice(id, 'builder'));

    const commands = setupCommands({ coordinator: address.url, device: id, task });
    console.log([
      `Device ${id} is enrolled as a builder. Its token was not shown. It is in this file, which only you can read:`,
      `  ${path}`,
      '',
      'Next steps',
      '1. The token:',
      ...privacySteps(path),
      '2. Send the teammate these details, which hold no secret:',
      `  Repository: ${repositoryAddress()}`,
      '  Guide:      onboarding/GUIDE.md',
      `  On a Mac:   ${commands.mac}`,
      `  On Windows: ${commands.windows}`,
      `  The first test writes one generic line on ${task}'s public issue, with the device ID and nothing else about them.`,
      `3. Check it worked: they should see a line starting SUCCESS, and node coordinator/main.js claims should show ${task} released.`,
      '',
      'Later',
      `  Token lost:     node onboarding/operator.js rotate ${id}`,
      `  Device leaves, or this was a throwaway test: node onboarding/operator.js revoke ${id}`,
      '  Set COORDINATOR_DB for those too, if you set it for this one. A revoked ID cannot be added again.',
    ].join('\n'));
  } finally {
    store.close();
  }
}

function rotate(id, values) {
  const store = openDatabase();
  try {
    const existing = deviceRow(store, id);
    if (!existing) throw new Refused(`There is no device ${id}. To enrol a new one: node onboarding/operator.js add ${id} ...`);
    if (existing.role !== 'builder') throw new Refused(`${id} is a ${existing.role} device. This kit only handles builders: use node coordinator/main.js device-rotate on its own machine.`);
    if (existing.revoked && !values.restore) {
      throw new Refused(`${id} was revoked, and a new token would bring it back. If that is what you want, add --restore.`);
    }
    const path = handoverPath(values.out, id);
    issueToken(path, () => store.rotateDevice(id));
    console.log([
      `Device ${id} has a new token, and the old one no longer works. It was not shown. It is in this file, which only you can read:`,
      `  ${path}`,
      '',
      'Next steps',
      '1. The token:',
      ...privacySteps(path),
      '2. The teammate deletes their old token, as the setup script tells them when it is refused, and runs the setup command again.',
    ].join('\n'));
  } finally {
    store.close();
  }
}

// Says what really happened: `device-revoke` reports success for a device that does not exist, as it would in the wrong database.
function revoke(id) {
  const store = openDatabase();
  try {
    const existing = deviceRow(store, id);
    if (!existing) throw new Refused(`There is no device ${id} in this database. Nothing was revoked. Check COORDINATOR_DB and the ID.`);
    store.revokeDevice(id);
    console.log(existing.revoked ? `${id} was already revoked.` : `${id} is revoked: its token no longer works.`);
    if (existsSync(defaultHandover(id))) console.log(`Its token file is still there. Delete it: rm "${defaultHandover(id)}"`);
  } finally {
    store.close();
  }
}

const COMMANDS = { add, rotate, revoke };

function main() {
  const parsed = parse();
  const [command, id, ...extra] = parsed?.positionals ?? [];
  if (!parsed || !Object.hasOwn(COMMANDS, command) || !id || extra.length) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  try {
    if (!isDeviceId(id)) throw new Refused(`That is not a valid device ID. ${DEVICE_ID_RULE}`);
    COMMANDS[command](id, parsed.values);
  } catch (err) {
    if (!(err instanceof Refused)) throw err;
    console.error(`REFUSED: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
