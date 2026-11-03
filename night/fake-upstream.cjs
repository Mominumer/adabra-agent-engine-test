'use strict';
// Stands in for the allowed host during night-check. Run with node -e in a container on the same network as a tunnel. It echoes what
// it receives, so a client can compare bytes, and prints one line of JSON per connection: when it opens, and when it closes the size,
// the first byte and which of the given marker strings it saw. It never prints the bytes themselves.
const net = require('node:net');

const { ports, markers } = JSON.parse(process.argv[1]);
const KEEP_BYTES = 1024 * 1024;
const say = (fields) => console.log(JSON.stringify(fields));

for (const port of ports) {
  net.createServer((c) => {
    say({ event: 'open', port });
    let kept = Buffer.alloc(0);
    let bytes = 0;
    let first = null;
    c.on('data', (d) => {
      if (first === null) first = d[0];
      bytes += d.length;
      if (kept.length < KEEP_BYTES) kept = Buffer.concat([kept, d]);
      c.write(d);
    });
    c.on('error', () => {});
    c.on('close', () => {
      const seen = Object.fromEntries(Object.entries(markers).map(([name, text]) => [name, kept.includes(text)]));
      say({ event: 'close', port, bytes, first, seen });
    });
  }).listen(port);
}
