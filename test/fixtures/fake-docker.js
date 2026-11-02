#!/usr/bin/env node
// Stands in for the docker CLI in tests. FAKE_DOCKER_MODE picks the behaviour; FAKE_DOCKER_RECORD gets the
// arguments and the size of stdin of every `run`.
import { appendFileSync } from 'node:fs';

const [cmd] = process.argv.slice(2);
const mode = process.env.FAKE_DOCKER_MODE ?? 'pass';

if (cmd === 'info') {
  if (mode === 'daemon-down') {
    console.error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock');
    process.exit(1);
  }
  console.log('28.0.0');
  process.exit(0);
}
if (cmd !== 'run') process.exit(0); // kill, ps, rm

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  if (process.env.FAKE_DOCKER_RECORD) {
    appendFileSync(process.env.FAKE_DOCKER_RECORD, JSON.stringify({ args: process.argv.slice(2), stdin: input.toString('base64') }) + '\n');
  }
  switch (mode) {
    case 'pass': console.log('# pass 3'); process.exit(0);
    case 'fail': console.log('not ok 1 - payments'); process.exit(1);
    case 'oom': process.exit(137);
    case 'docker-error': console.error('docker: Error response from daemon: No such image'); process.exit(125);
    case 'biglog': process.stdout.write('x'.repeat(1_000_000) + '\nTHE-END\n', () => process.exit(1)); break;
    case 'hang': setInterval(() => {}, 1000); break; // until killed
  }
});
