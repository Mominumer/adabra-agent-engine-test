import { execFile } from 'node:child_process';
import { readFileSync, renameSync } from 'node:fs';
import { win32 } from 'node:path';

// Everything in the helper that differs by operating system. Behaviour on macOS stays as it was.

const OSASCRIPT = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';

// Windows PowerShell 5.1 toast. It has to be powershell.exe: PowerShell 7 dropped these Windows Runtime type names.
// Single quotes only, so Node's argument quoting leaves the script alone. Title and message arrive through the
// environment and never become script text, so nothing in them can run. The app id is PowerShell's own.
const WINDOWS_TOAST = [
  "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "$null = [Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
  "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$raw = [xml]$template.GetXml()",
  "$text = $raw.GetElementsByTagName('text')",
  "$null = $text[0].AppendChild($raw.CreateTextNode($env:ADABRA_NOTIFY_TITLE))",
  "$null = $text[1].AppendChild($raw.CreateTextNode($env:ADABRA_NOTIFY_MESSAGE))",
  "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$doc.LoadXml($raw.OuterXml)",
  "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($doc))",
].join('; ');

// The command that shows a desktop notification on this platform, or null where there is none.
export function notifyCommand(title, message, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') return { file: 'osascript', args: ['-e', OSASCRIPT, title, message], options: {} };
  if (platform === 'win32') {
    return {
      // A full path, so a powershell.exe earlier on PATH is never the one that runs.
      file: win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_TOAST],
      options: {
        windowsHide: true, // no console window for the moment PowerShell runs
        timeout: 30_000,
        env: { ...env, ADABRA_NOTIFY_TITLE: title, ADABRA_NOTIFY_MESSAGE: message },
      },
    };
  }
  return null;
}

// Best effort: the agent has already logged the notice, and a failure here must never disturb it.
export function showNotification(title, message, { platform, env, run = execFile, log = () => {} } = {}) {
  const command = notifyCommand(title, message, { platform, env });
  if (!command) return;
  run(command.file, command.args, command.options, (err) => {
    if (err) log(`notification not shown: ${err.code ?? 'failed'}`);
  });
}

// What can ask a process to stop. Windows has no SIGTERM from outside: it does send SIGBREAK (Ctrl+Break) and
// SIGHUP (console window closed). Task Scheduler and Stop-Process end a process outright, with no signal at all,
// which is safe here: the outbox is SQLite and claims.json is only ever replaced whole.
export const stopSignals = (platform = process.platform) =>
  platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM'];

const SHARING_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// On Windows, antivirus, the search indexer or another process can hold a file open for a moment, and a rename or
// read then fails with one of these errors. POSIX has no such window, so elsewhere the first error is final.
export function retryWhileShared(fn, { platform = process.platform, attempts = 10, delayMs = 50, sleep = sleepSync } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (err) {
      if (platform !== 'win32' || !SHARING_ERRORS.has(err.code) || attempt >= attempts) throw err;
      sleep(delayMs * attempt);
    }
  }
}

// Replaces a file with a finished temp file, so a reader never sees a half-written one.
export const replaceFile = (tmp, target, options) => retryWhileShared(() => renameSync(tmp, target), options);

// Reads a one-line secret. Windows PowerShell 5.1 writes UTF-16 for `>` and a BOM for `Set-Content -Encoding utf8`.
// trim() also removes a BOM, which counts as whitespace in JavaScript.
export function decodeSecret(raw) {
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
  return text.trim();
}

export const readSecretFile = (path) => decodeSecret(readFileSync(path));

// How to save the device token. Windows has no umask or pbpaste, and its `>` would write UTF-16.
export function tokenSaveHint(tokenPath, platform = process.platform) {
  return platform === 'win32'
    ? `  Get-Clipboard | Set-Content -NoNewline -Encoding ascii -LiteralPath "${tokenPath}"   # PowerShell: copy the token first`
    : `  umask 077 && pbpaste > "${tokenPath}"   # macOS: copy the token first`;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // it exists but belongs to someone else
  }
}

// Calls onGone once when the process that started this one has died. Windows does not end child processes with
// their parent, and ending a scheduled task may stop only the process it launched, so without this the rest of the
// chain would live on and the next start of the task would run a second agent beside it.
// POSIX hands an orphan to a new parent, so ppid changes; on Windows it stays the same and the old pid disappears.
export function watchParent(onGone, { intervalMs = 5000, getPpid = () => process.ppid, isAlive = processExists } = {}) {
  const parent = getPpid();
  const timer = setInterval(() => {
    if (getPpid() !== parent || !isAlive(parent)) {
      clearInterval(timer);
      onGone();
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
