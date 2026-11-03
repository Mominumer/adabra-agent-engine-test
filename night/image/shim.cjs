'use strict';
// Gives the CLI something it can name in HTTPS_PROXY: its proxy setting takes an http:// URL, and the session has only a Unix socket.
// Each connection on the loopback port is joined to the tunnel's socket, and that is all. This is not a boundary: it runs as the
// session user, who could kill it or speak to the socket directly. The tunnel decides what is allowed.
const net = require('node:net');
const fs = require('node:fs');

const PORT = 8080;
const SOCKET = '/sock/tunnel.sock';
const READY_FILE = '/tmp/.adabra-shim-ready';

function startShim({ port = PORT, socket = SOCKET } = {}) {
  const server = net.createServer((client) => {
    const up = net.connect(socket);
    client.on('error', () => up.destroy());
    up.on('error', () => client.destroy());
    client.pipe(up);
    up.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startShim };

if (require.main === module) {
  startShim().then(
    () => fs.writeFileSync(READY_FILE, ''),
    (err) => {
      console.error(`shim: could not listen: ${err.code ?? err.message}`);
      process.exit(2);
    },
  );
}
