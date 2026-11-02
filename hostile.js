// Deliberately hostile "test" for the review sandbox. Every attempt below must be refused.
// Expected overall result: adabra/tests = failure ("Killed: memory or process limit reached").
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const report = (k, v) => console.log(`HOSTILE ${k}: ${v}`);
const attempt = (k, fn) => {
  try {
    report(k, `SUCCEEDED ${String(fn()).slice(0, 80)}`);
  } catch (e) {
    report(k, `blocked (${String(e.code ?? e.message).slice(0, 60)})`);
  }
};

attempt('read the mini reviewer token', () => `${readFileSync('/Users/jbr/.adabra/review-token', 'utf8').length} bytes`);
attempt('read the mini coordinator token', () => `${readFileSync('/Users/jbr/.adabra/github-token', 'utf8').length} bytes`);
attempt('list the mini home folders', () => readdirSync('/Users').join(','));
attempt('read the mini SSH keys', () => readdirSync('/Users/jbr/.ssh').join(','));
const secretish = Object.keys(process.env).filter((k) => /token|secret|key|pass|github|anthropic/i.test(k));
report('secret-looking environment variables', secretish.length ? `FOUND ${secretish.join(',')}` : 'none present');
attempt('write a system file', () => (writeFileSync('/etc/hostile', 'x'), 'written'));
attempt('write outside the work folder', () => (writeFileSync('/hostile', 'x'), 'written'));
attempt('open the Docker socket', () => (readFileSync('/var/run/docker.sock'), 'opened'));

try {
  await fetch('https://example.com', { signal: AbortSignal.timeout(5000) });
  report('reach the internet', 'SUCCEEDED');
} catch (e) {
  report('reach the internet', `blocked (${e.cause?.code ?? e.name})`);
}

let refused = 0;
const kids = [];
for (let i = 0; i < 1000; i++) {
  const c = spawn('sleep', ['60']);
  c.on('error', () => refused++);
  kids.push(c);
}
await new Promise((r) => setTimeout(r, 3000));
report('start 1000 processes', refused ? `blocked at the limit (${refused} refused)` : 'ALL STARTED');
for (const k of kids) {
  try { k.kill('SIGKILL'); } catch {}
}

report('use unlimited memory', 'allocating until the sandbox stops it...');
const hog = [];
for (;;) {
  hog.push(Buffer.alloc(256 * 1024 * 1024, 1));
  report('use unlimited memory', `${hog.length * 256} MB held`);
}
