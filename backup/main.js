#!/usr/bin/env node
// Database backups (runs on the Mac mini, as the LaunchAgent in service/backup-service.sh).
//
//   node backup/main.js run [--notify]       back up both databases, verify, apply retention, write the status file
//   node backup/main.js status               the last run; exit 1 if it failed, is too old, or there has not been one
//   node backup/main.js drill [--file <f>]   restore the newest backups (or one file) into a temp folder and check them
//
// Exit codes for run: 0 all good, 1 something failed, 75 another run is in progress.
//
// Environment:
//   COORDINATOR_DB         default <repo>/coordinator.db
//   REVIEW_DB              default <repo>/reviewer.db
//   ADABRA_BACKUP_DIR      default ~/adabra-backups
//   ADABRA_BACKUP_STATUS   default ~/Library/Logs/adabra-backup-status.json
import { backupConfig, describeDatabase, errorText, readStatus, runBackups, statusProblems } from './backup.js';
import { runDrill } from './drill.js';
import { showNotification } from '../helper/platform.js';

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const [cmd, ...args] = process.argv.slice(2);
const cfg = backupConfig();

function usage() {
  console.error('usage: main.js run [--notify] | status | drill [--file <backup>]');
  process.exit(2);
}

if (cmd === 'run' && args.every((a) => a === '--notify')) {
  let problems;
  try {
    const status = await runBackups(cfg, { log });
    if (status.busy) process.exitCode = 75;
    else problems = statusProblems(status);
  } catch (err) {
    problems = [`the status file could not be written: ${errorText(err)}`];
    log(`FAILED: ${problems[0]}`);
  }
  if (problems?.length) {
    process.exitCode = 1;
    if (args.includes('--notify')) showNotification('Adabra backup FAILED', problems[0]);
  }
  // A copy that timed out is still running in the thread pool and would keep this process alive.
  setTimeout(() => process.exit(), 5000).unref();
} else if (cmd === 'status') {
  const status = readStatus(cfg.statusFile);
  if (status?.databases) {
    console.log(`last run: ${status.finished_at}, ${status.ok ? 'OK' : 'FAILED'}`);
    for (const [name, d] of Object.entries(status.databases)) console.log(describeDatabase(name, d));
  }
  const problems = statusProblems(status);
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  console.log(`status file: ${cfg.statusFile}`);
  process.exitCode = problems.length ? 1 : 0;
} else if (cmd === 'drill' && (args.length === 0 || (args.length === 2 && args[0] === '--file'))) {
  process.exitCode = runDrill(cfg, { file: args[1] ?? null }).ok ? 0 : 1;
} else {
  usage();
}
