import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ClaimFile } from '../helper/claims.js';
import {
  notifyCommand, readSecretFile, replaceFile, retryWhileShared, showNotification, stopSignals, tokenSaveHint, watchParent,
} from '../helper/platform.js';
import { supervise } from '../helper/supervisor.js';

// What these tests cover: the helper's Windows code paths chosen by platform, the supervisor (for real, with real
// processes), and the launcher's logic. They run on macOS and Linux. Nothing here proves how Windows itself behaves.
const repo = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const posixOnly = { skip: process.platform === 'win32' ? 'relies on POSIX signals' : false };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-win-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function waitFor(check, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const readLog = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};
const agentPids = (log) => [...log.matchAll(/agent started, pid (\d+)/g)].map((m) => Number(m[1]));

// --- notifications ------------------------------------------------------------------------------------------------

test('notification on macOS is the same osascript call as before', () => {
  const c = notifyCommand('Lost TASK-1', 'gone', { platform: 'darwin' });
  assert.equal(c.file, 'osascript');
  assert.deepEqual(c.args, ['-e', 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run', 'Lost TASK-1', 'gone']);
  assert.deepEqual(c.options, {});
});

test('notification on Windows: built-in PowerShell, no window, and the text can never become script', () => {
  const nasty = `'; Remove-Item C:\\ -Recurse; "$(calc)" <b>&`;
  const c = notifyCommand('Lost TASK-1', nasty, { platform: 'win32', env: { SystemRoot: 'D:\\Win', KEEP: 'x' } });
  assert.equal(c.file, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(c.options.windowsHide, true);
  assert.equal(c.options.env.ADABRA_NOTIFY_TITLE, 'Lost TASK-1');
  assert.equal(c.options.env.ADABRA_NOTIFY_MESSAGE, nasty);
  assert.equal(c.options.env.KEEP, 'x');
  assert.ok(!c.args.join(' ').includes('Remove-Item'), 'the message must not be in the command line');
  assert.ok(!c.args.join(' ').includes('"'), 'double quotes would be altered by argument quoting');
  assert.match(c.args.at(-1), /CreateToastNotifier/);
});

test('notification on other platforms: nothing to run', () => {
  assert.equal(notifyCommand('t', 'm', { platform: 'linux' }), null);
  showNotification('t', 'm', { platform: 'linux', run: () => assert.fail('should not run anything') });
});

test('a failed notification is logged without its text and does not throw', () => {
  const lines = [];
  const run = (file, args, options, done) => done(Object.assign(new Error(`Command failed: ${file}`), { code: 'ENOENT' }));
  showNotification('secret title', 'secret body', { platform: 'win32', env: {}, run, log: (m) => lines.push(m) });
  assert.deepEqual(lines, ['notification not shown: ENOENT']);
});

// --- signals, files and the token ---------------------------------------------------------------------------------

test('stop signals: Windows adds the two it can really send; elsewhere unchanged', () => {
  assert.deepEqual(stopSignals('darwin'), ['SIGINT', 'SIGTERM']);
  assert.deepEqual(stopSignals('linux'), ['SIGINT', 'SIGTERM']);
  assert.deepEqual(stopSignals('win32'), ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
});

const failing = (codes, result = 'ok') => {
  let calls = 0;
  const fn = () => {
    calls++;
    if (codes.length) throw Object.assign(new Error('nope'), { code: codes.shift() });
    return result;
  };
  fn.calls = () => calls;
  return fn;
};

test('sharing errors are retried on Windows until the file is free', () => {
  const fn = failing(['EPERM', 'EBUSY', 'EACCES']);
  const slept = [];
  assert.equal(retryWhileShared(fn, { platform: 'win32', sleep: (ms) => slept.push(ms) }), 'ok');
  assert.equal(fn.calls(), 4);
  assert.deepEqual(slept, [50, 100, 150]);
});

test('sharing errors give up after the last attempt, and the real error comes out', () => {
  const fn = failing(Array(5).fill('EPERM'));
  assert.throws(() => retryWhileShared(fn, { platform: 'win32', attempts: 3, sleep: () => {} }), { code: 'EPERM' });
  assert.equal(fn.calls(), 3);
});

test('other errors are not retried, and macOS never retries', () => {
  const notShared = failing(['ENOENT']);
  assert.throws(() => retryWhileShared(notShared, { platform: 'win32', sleep: () => {} }), { code: 'ENOENT' });
  assert.equal(notShared.calls(), 1);
  const onMac = failing(['EPERM']);
  assert.throws(() => retryWhileShared(onMac, { platform: 'darwin', sleep: () => assert.fail('no sleeping') }), { code: 'EPERM' });
  assert.equal(onMac.calls(), 1);
});

test('replaceFile and ClaimFile replace the file whole and leave no temp file', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'a.tmp'), 'new');
  writeFileSync(join(dir, 'a'), 'old');
  replaceFile(join(dir, 'a.tmp'), join(dir, 'a'));
  assert.equal(readFileSync(join(dir, 'a'), 'utf8'), 'new');

  const claims = new ClaimFile(dir);
  claims.set('TASK-1', { run_id: 'RUN-1', generation: 1 });
  claims.set('TASK-2', { run_id: 'RUN-2', generation: 2 });
  claims.remove('TASK-1');
  assert.deepEqual(claims.all(), { 'TASK-2': { run_id: 'RUN-2', generation: 2 } });
  assert.deepEqual(readdirSync(dir).sort(), ['a', 'claims.json']);
});

test('a token saved by any common Windows route reads back the same', (t) => {
  const dir = tempDir(t);
  const path = join(dir, 'secret');
  const value = 'not-a-real-value-123';
  const forms = {
    plain: Buffer.from(value),
    'with newline, as echo leaves it': Buffer.from(`${value}\r\n`),
    'UTF-8 with BOM, as Set-Content -Encoding utf8 writes in PowerShell 5.1': Buffer.from(`\ufeff${value}\r\n`),
    'UTF-16 with BOM, as > writes in PowerShell 5.1': Buffer.from(`\ufeff${value}\r\n`, 'utf16le'),
  };
  for (const [name, bytes] of Object.entries(forms)) {
    writeFileSync(path, bytes);
    assert.equal(readSecretFile(path), value, name);
  }
});

test('the token hint fits the platform and uses a command that writes plain text on Windows', () => {
  assert.equal(tokenSaveHint('/h/token', 'darwin'), '  umask 077 && pbpaste > "/h/token"   # macOS: copy the token first');
  const hint = tokenSaveHint('C:\\Users\\A B\\.team-agent\\token', 'win32');
  assert.match(hint, /Set-Content -NoNewline -Encoding ascii -LiteralPath "C:\\Users\\A B\\\.team-agent\\token"/);
  assert.ok(!hint.includes('pbpaste') && !hint.includes(' > '));
});

// --- parent watch -------------------------------------------------------------------------------------------------

test('watchParent: POSIX re-parenting and a vanished pid both count as gone; a live parent does not', async () => {
  const run = (getPpid, isAlive) =>
    new Promise((resolve) => {
      const timer = watchParent(() => resolve('gone'), { intervalMs: 5, getPpid, isAlive });
      setTimeout(() => (clearInterval(timer), resolve('still here')), 100);
    });
  let ppid = 10;
  const reparented = run(() => ppid, () => true);
  ppid = 1;
  assert.equal(await reparented, 'gone');
  assert.equal(await run(() => 10, () => false), 'gone'); // Windows: ppid stays, the pid is gone
  assert.equal(await run(() => 10, () => true), 'still here');
});

// --- supervisor ---------------------------------------------------------------------------------------------------

test('supervisor: a crash is logged with its output and the agent comes back', async (t) => {
  const dir = tempDir(t);
  const logPath = join(dir, 'logs with space', 'agent.log');
  const script = join(dir, 'crash.js');
  writeFileSync(script, `console.log('to stdout'); console.error('to stderr'); process.exit(3);`);
  const ac = new AbortController();
  const done = supervise({ args: [script], logPath, restartMs: 10, signal: ac.signal });
  await waitFor(() => (readLog(logPath).match(/agent exit code 3/g) ?? []).length >= 3, 'three crashes');
  ac.abort();
  const { runs } = await done;
  assert.ok(runs >= 3);
  const log = readLog(logPath);
  assert.match(log, /to stdout/);
  assert.match(log, /to stderr/);
  assert.match(log, /supervisor: stopped\n$/);
});

test('supervisor: stopping it stops the agent, and a later run appends to the log', async (t) => {
  const dir = tempDir(t);
  const logPath = join(dir, 'agent.log');
  const script = join(dir, 'forever.js');
  writeFileSync(script, 'setInterval(() => {}, 1000);');
  const ac = new AbortController();
  const done = supervise({ args: [script], logPath, restartMs: 10, signal: ac.signal });
  const [pid] = await waitFor(() => { const p = agentPids(readLog(logPath)); return p.length && p; }, 'agent start');
  ac.abort();
  const { runs } = await done;
  assert.equal(runs, 1);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

  await supervise({ args: [script], logPath, signal: AbortSignal.abort() });
  assert.equal((readLog(logPath).match(/supervisor: started/g) ?? []).length, 2);
});

test('supervisor: a command that cannot start is logged and retried, not fatal', async (t) => {
  const dir = tempDir(t);
  const logPath = join(dir, 'agent.log');
  const ac = new AbortController();
  const done = supervise({ command: join(dir, 'no-such-program'), logPath, restartMs: 10, signal: ac.signal });
  await waitFor(() => (readLog(logPath).match(/could not start: ENOENT/g) ?? []).length >= 2, 'two failed starts');
  ac.abort();
  await done;
});

// The real thing: helper/supervisor.js running the real helper/agent.js against a temp home (not enrolled, so its
// passes fail harmlessly and nothing touches the network or the real ~/.team-agent).
function servicePaths(dir) {
  const home = join(dir, 'home with space');
  mkdirSync(home); // enroll normally creates it; the agent opens outbox.db there
  return { home, logPath: join(dir, 'logs', 'agent.log') };
}

test('service run: killed agent comes back with a new pid, its output is in the log, and stopping is clean', posixOnly, async (t) => {
  const dir = tempDir(t);
  const { home, logPath } = servicePaths(dir);
  const service = spawn(process.execPath, [repo('helper/supervisor.js'), 'run', '--home', home, '--log', logPath], {
    stdio: 'ignore',
    env: { ...process.env, TEAM_AGENT_RESTART_MS: '50', TEAM_AGENT_TICK_MS: '60000' },
  });
  t.after(() => service.kill('SIGKILL'));
  const [first] = await waitFor(() => { const p = agentPids(readLog(logPath)); return p.length && p; }, 'first agent');
  await waitFor(() => readLog(logPath).includes(`home ${home}`), 'the agent to report its home in the log');
  await waitFor(() => readLog(logPath).includes('pass failed'), 'the first pass');

  process.kill(first, 'SIGKILL');
  const pids = await waitFor(() => { const p = agentPids(readLog(logPath)); return p.length >= 2 && p; }, 'restart');
  assert.notEqual(pids[1], first);
  assert.match(readLog(logPath), /agent ended by SIGKILL/);
  await waitFor(() => (readLog(logPath).match(/pass failed/g) ?? []).length >= 2, 'the new agent to be up');

  service.kill('SIGTERM');
  await waitFor(() => readLog(logPath).includes('supervisor: stopped'), 'supervisor stop');
  assert.match(readLog(logPath), /agent stopped/);
});

test('service run: if the supervisor is killed outright, the agent notices and stops', posixOnly, async (t) => {
  const dir = tempDir(t);
  const { home, logPath } = servicePaths(dir);
  const service = spawn(process.execPath, [repo('helper/supervisor.js'), 'run', '--home', home, '--log', logPath], {
    stdio: 'ignore',
    env: { ...process.env, TEAM_AGENT_TICK_MS: '60000' },
  });
  await waitFor(() => readLog(logPath).includes('pass failed'), 'the first pass');
  service.kill('SIGKILL');
  await waitFor(() => readLog(logPath).includes('agent stopped'), 'the orphaned agent to stop');
});

test('service run: if whatever started the supervisor dies, the supervisor and agent stop', posixOnly, async (t) => {
  const dir = tempDir(t);
  const { home, logPath } = servicePaths(dir);
  // Stands in for wscript.exe, the parent on Windows.
  const starter = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ${JSON.stringify([repo('helper/supervisor.js'), 'run', '--home', home, '--log', logPath])}, { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `], { stdio: 'ignore', env: { ...process.env, TEAM_AGENT_TICK_MS: '60000' } });
  t.after(() => starter.kill('SIGKILL'));
  await waitFor(() => readLog(logPath).includes('pass failed'), 'the first pass');
  starter.kill('SIGKILL');
  await waitFor(() => readLog(logPath).includes('supervisor: stopped'), 'the supervisor to stop');
  await waitFor(() => readLog(logPath).includes('agent stopped'), 'the agent to stop');
});

// --- launcher (old JScript, run here in a stand-in for Windows Script Host) ---------------------------------------

function runLauncher({ args, files = [], runResult = 0 }) {
  const calls = { run: [], lines: [], closed: false };
  class Quit extends Error {
    constructor(code) { super('quit'); this.code = code; }
  }
  const WScript = {
    Arguments: { Item: (i) => args[i] },
    Quit: (code) => { throw new Quit(code); },
  };
  function ActiveXObject(name) {
    if (name === 'Scripting.FileSystemObject') {
      return {
        FileExists: (p) => files.includes(p),
        OpenTextFile: (path, mode, create) => {
          calls.opened = { path, mode, create };
          return { WriteLine: (l) => calls.lines.push(l), Close: () => { calls.closed = true; } };
        },
      };
    }
    assert.equal(name, 'WScript.Shell');
    return { Run: (cmd, style, wait) => { calls.run.push({ cmd, style, wait }); return runResult; } };
  }
  const source = readFileSync(repo('service/helper-launcher.js'), 'utf8');
  try {
    vm.runInNewContext(source, { WScript, ActiveXObject });
  } catch (err) {
    if (!(err instanceof Quit)) throw err;
    calls.exit = err.code;
  }
  return calls;
}

const launcherArgs = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\My Repo\\helper\\supervisor.js', 'C:\\Users\\A B\\.team-agent', 'C:\\Users\\A B\\AppData\\Local\\Adabra\\Logs\\adabra-helper.log'];

test('launcher: quotes paths with spaces, runs hidden, waits, and passes on the exit code', () => {
  const calls = runLauncher({ args: launcherArgs, files: launcherArgs.slice(0, 2), runResult: 7 });
  assert.deepEqual(calls.run, [{
    cmd: '"C:\\Program Files\\nodejs\\node.exe" "C:\\My Repo\\helper\\supervisor.js" run --home "C:\\Users\\A B\\.team-agent" --log "C:\\Users\\A B\\AppData\\Local\\Adabra\\Logs\\adabra-helper.log"',
    style: 0,
    wait: true,
  }]);
  assert.equal(calls.exit, 7);
});

test('launcher: if node has moved, it says so in the log and starts nothing', () => {
  const calls = runLauncher({ args: launcherArgs, files: [launcherArgs[1]] });
  assert.deepEqual(calls.run, []);
  assert.equal(calls.exit, 2);
  assert.deepEqual(calls.opened, { path: launcherArgs[3], mode: 8, create: true });
  assert.match(calls.lines[0], /install again/);
  assert.equal(calls.closed, true);
});

test('launcher: uses nothing newer than the JScript that Windows Script Host runs', () => {
  const source = readFileSync(repo('service/helper-launcher.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/ .*$/gm, '');
  assert.doesNotMatch(source, /\b(let|const|class|async|await)\b|=>|`/);
});

// --- static checks on the PowerShell script. No PowerShell here, so none of this executes it. ---------------------

const ps1 = readFileSync(repo('service/helper-service.ps1'), 'utf8');

// Walks the script the way PowerShell's tokenizer would for quotes, comments and here-strings, and checks that
// brackets and strings close. A lexical check, not a parser: it catches slips, not wrong commands.
function lexicalProblems(src) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') line++;
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '`') {
      i += 2;
      continue;
    }
    if (c === '@' && (src[i + 1] === '"' || src[i + 1] === "'") && src[i + 2] === '\n') {
      const close = `\n${src[i + 1]}@`;
      const end = src.indexOf(close, i);
      if (end < 0) return [`here-string at line ${line} never closes`];
      line += src.slice(i, end + close.length).split('\n').length - 1;
      i = end + close.length;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= src.length) return [`string at line ${line} never closes`];
        if (c === '"' && src[j] === '`') { j += 2; continue; }
        if (src[j] === c) {
          if (src[j + 1] === c) { j += 2; continue; }
          break;
        }
        if (src[j] === '\n') line++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if ('([{'.includes(c)) stack.push({ c, line });
    if (c in pairs) {
      const open = stack.pop();
      if (open?.c !== pairs[c]) return [`${c} at line ${line} does not match ${open ? `${open.c} at line ${open.line}` : 'anything'}`];
    }
    i++;
  }
  return stack.map((o) => `${o.c} at line ${o.line} never closes`);
}

const codeLines = (src) => src.split('\n').filter((l) => !l.trimStart().startsWith('#'));

test('script: brackets and strings balance', () => {
  assert.deepEqual(lexicalProblems(ps1), []);
  assert.notDeepEqual(lexicalProblems('if ($a) { "x'), [], 'the check itself must catch an open string');
  assert.notDeepEqual(lexicalProblems('if ($a) { $b'), [], 'the check itself must catch an open brace');
});

test('script: plain ASCII, since Windows PowerShell 5.1 misreads a UTF-8 script that has no BOM', () => {
  assert.doesNotMatch(ps1, /[^\x00-\x7f]/);
});

test('script: avoids the PowerShell slips that are errors only at run time', () => {
  const automatic = 'home|host|input|args|pid|error|event|sender|matches|profile|this|true|false'; // $null = x is fine: it discards x
  assert.doesNotMatch(codeLines(ps1).join('\n'), new RegExp(`\\$(${automatic})\\s*=[^=]`, 'i'), 'assigns to an automatic variable');
  // "$name:" in a string means a variable in a scope or drive called name: it needs ${name}.
  const scoped = [...codeLines(ps1).join('\n').matchAll(/\$([A-Za-z_]\w*):(?!\w)/g)].map((m) => m[0]);
  assert.deepEqual(scoped, []);
  assert.match(ps1, /^param\(/m, 'param must be the first statement');
  assert.ok(ps1.indexOf('param(') < ps1.indexOf('$ErrorActionPreference'));
});

test('script: has every command the shell script has, and the same messages', () => {
  const sh = readFileSync(repo('service/helper-service.sh'), 'utf8');
  for (const command of ['install', 'status', 'logs', 'uninstall']) {
    assert.ok(sh.includes(`${command})`), `shell has ${command}`);
    assert.match(ps1, new RegExp(`^    '${command}' \\{`, 'm'), `script handles ${command}`);
  }
  for (const message of ['service not loaded', 'no agent-status.json yet', 'not enrolled: run', 'log: ', 'node not found on PATH', 'usage: ']) {
    assert.ok(sh.includes(message), `shell says: ${message}`);
    assert.ok(ps1.includes(message), `script says: ${message}`);
  }
});

test('script: never opens the token', () => {
  const uses = codeLines(ps1).filter((l) => /token/i.test(l));
  assert.ok(uses.length > 0);
  for (const line of uses) {
    assert.match(line, /TokenFile = Join-Path|Test-Path -LiteralPath \$TokenFile|\$AgentHome, \$TokenFile|save the token to|<LogonType>InteractiveToken</, `unexpected use of the token: ${line.trim()}`);
  }
  // The one place a path from that list is opened is Get-Acl, which reads permissions.
  const fileReaders = /Get-Content|\[(System\.)?IO\.|ReadAll|OpenRead|\bcat\b|\btype\b|Select-String/i;
  for (const line of codeLines(ps1).filter((l) => fileReaders.test(l))) {
    assert.match(line, /\$statusFile|\$LogFile/, `reads something other than the status file or log: ${line.trim()}`);
  }
});

test('script: never takes or stores a password, and never asks for elevation', () => {
  assert.doesNotMatch(ps1, /-Password|-Credential|Get-Credential|-Verb RunAs|HighestAvailable|<LogonType>(Password|S4U)/);
  assert.doesNotMatch(ps1, /Set-ExecutionPolicy/);
});

test('script: the task definition is well-formed and has the settings that matter', () => {
  const xml = ps1.match(/@"\n([\s\S]*?)\n"@/)[1];
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));

  const stack = [];
  for (const [tag] of xml.replace(/^<\?xml.*?\?>/, '').matchAll(/<[^>]+>/g)) {
    if (tag.startsWith('</')) assert.equal(tag.slice(2, -1), stack.pop(), `closing ${tag}`);
    else stack.push(tag.slice(1, -1).split(' ')[0]);
  }
  assert.deepEqual(stack, []);

  const has = (element) => assert.ok(xml.includes(element), `task needs ${element}`);
  has('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  has('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  has('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
  has('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  has('<LogonType>InteractiveToken</LogonType>');
  has('<RunLevel>LeastPrivilege</RunLevel>');
  has('<Hidden>false</Hidden>');
  has('<Interval>PT1M</Interval>');
  has('<WorkingDirectory>$workingDir</WorkingDirectory>');
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>\$userName<\/UserId>[\s\S]*<\/LogonTrigger>/, 'a non-admin may only use a logon trigger for themselves');
  assert.match(xml, /<TimeTrigger>[\s\S]*<Repetition>[\s\S]*<\/Repetition>[\s\S]*<\/TimeTrigger>/, 'the watchdog');
  assert.doesNotMatch(xml, /<Duration>/, 'no duration means it repeats indefinitely');
  assert.match(xml, /<Command>\$wscript<\/Command>/, 'starts through the no-window launcher, never node or PowerShell directly');
});

test('script: paths go through the command line quoted and through XML escaped', () => {
  assert.match(ps1, /'\/\/B \/\/NoLogo \/\/E:JScript "\{0\}" "\{1\}" "\{2\}" "\{3\}" "\{4\}"' -f \$Launcher, \$nodeExe, \$Supervisor, \$AgentHome, \$LogFile/);
  assert.match(ps1, /\$arguments = \[Security\.SecurityElement\]::Escape\(\$arguments\)/);
  assert.match(ps1, /\$workingDir = \[Security\.SecurityElement\]::Escape\(\$RepoDir\)/);
  assert.match(ps1, /\$userName = \[Security\.SecurityElement\]::Escape\(\$identity\.Name\)/);
  assert.match(ps1, /TrimEnd\('\\'\)/, 'a trailing backslash would swallow the closing quote');
  // Anything that may contain a wildcard character in a path must not be treated as a pattern.
  assert.doesNotMatch(ps1, /Test-Path (?!-LiteralPath)/);
  assert.doesNotMatch(ps1, /Get-Content (?!-LiteralPath)/);
});

test('script: a re-install takes the old task and its processes down first, and waits for them to go', () => {
  const install = ps1.slice(ps1.indexOf('function Install-AgentTask'), ps1.indexOf('function Show-Status'));
  const order = ['Find-Node', 'not enrolled', 'Protect-AgentHome', 'Remove-AgentTask', 'Stop-AgentProcesses', 'Register-ScheduledTask @Task -Xml $xml -Force', 'Start-ScheduledTask', 'Show-Status'];
  let at = -1;
  for (const step of order) {
    const next = install.indexOf(step, at + 1);
    assert.ok(next > at, `install must do ${step} after the steps before it`);
    at = next;
  }
  const stop = ps1.slice(ps1.indexOf('function Stop-AgentProcesses'), ps1.indexOf('function Remove-AgentTask'));
  assert.match(stop, /'supervisor', 'agent'/, 'supervisors first, or one would restart the agent');
  assert.match(stop, /Start-Sleep/, 'waits until they are gone');
});
