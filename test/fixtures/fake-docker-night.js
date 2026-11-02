#!/usr/bin/env node
// Stands in for the docker CLI in the night-check tests. FAKE_NIGHT_MODE picks the behaviour; FAKE_NIGHT_RECORD gets one JSON line per
// call, with the arguments and the credential this process was handed. Containers report nothing, so every probe counts as failed.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (!argv.length) process.exit(0); // `node --test test/` runs this file too

const mode = process.env.FAKE_NIGHT_MODE ?? 'quiet';
const recordFile = process.env.FAKE_NIGHT_RECORD;
const earlier = () => (recordFile && existsSync(recordFile) ? readFileSync(recordFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args) : []);
// Something is there until it is removed, and again once more is made after that. So a sweep at the start finds what an earlier crash left.
const present = (makes, removes) => {
  const calls = earlier();
  const lastIndex = (test) => calls.map(test).lastIndexOf(true);
  const removedAt = lastIndex(removes);
  return removedAt === -1 || lastIndex(makes) > removedAt;
};
if (recordFile) appendFileSync(recordFile, `${JSON.stringify({ args: argv, credential: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null })}\n`);

const say = (text) => process.stdout.write(`${text}\n`);
const filter = argv.includes('--filter') ? argv.filter((_, i) => argv[i - 1] === '--filter') : [];
const asksFor = (label) => filter.includes(`label=${label}`);

switch (argv[0]) {
  case 'info':
    if (mode === 'daemon-down') {
      console.error('Cannot connect to the Docker daemon');
      process.exit(1);
    }
    say('29.0.0');
    break;
  case 'image':
    if (mode === 'no-image') process.exit(1);
    say(`sha256:${'a'.repeat(64)}`);
    break;
  case 'logs':
    if (mode !== 'tunnel-never-starts') say('{"event":"listening"}');
    break;
  case 'ps':
    if (asksFor('adabra-review=1') && mode === 'review-running') say('review-container');
    if (asksFor('adabra-night-check=1') && present((a) => a[0] === 'run', (a) => a[0] === 'rm')) say('check-container');
    break;
  case 'volume':
    if (argv[1] === 'ls' && asksFor('adabra-night-check=1') && present((a) => a[0] === 'volume' && a[1] === 'create', (a) => a[0] === 'volume' && a[1] === 'rm')) say('check-volume');
    break;
  case 'network':
    if (argv[1] === 'ls' && asksFor('adabra-night-check=1') && present((a) => a[0] === 'network' && a[1] === 'create', (a) => a[0] === 'network' && a[1] === 'rm')) say('check-network');
    if (argv[1] === 'inspect') say('172.18.0.0/16');
    break;
  case 'run':
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    break;
  default: // rm, kill, exec, inspect
    break;
}
