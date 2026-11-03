'use strict';
// The only way out of an overnight session. It listens on a Unix socket in a volume shared with the session, and runs in its own
// container on a bridge network. The session has no network, so this is the one thing it can talk to.
//
// It is a CONNECT tunnel: it answers one question, "may you reach this host and port?", and then copies bytes. It never terminates
// TLS, so it never sees a request, a credential, a path or a model, and cannot rule on any of them.
//
// What it does hold:
//   - The target must equal the one allowed host:port, byte for byte. Nothing is parsed out of it, so an IP address, another port,
//     a trailing dot, a user@ part or an absolute URL all fail the same comparison.
//   - The tunnel looks the name up itself, every address must be inside the allowed ranges, and it connects to that checked address.
//     So a name pointed somewhere else is refused, and nothing is looked up twice.
//   - At most maxConns connections at once. That protects this container, and nothing else: one kept-alive connection can carry any
//     number of requests, so this is not a request cap and says nothing about spend.
//   - It exits after maxSeconds, however long a connection has been open. So egress ends on time even if whatever started it has died.
//
// What it does not hold: anything inside the TLS stream. Whoever connects can name another host inside the encrypted stream
// (domain fronting), and can use any credential they like at the allowed host, including their own account's. Bytes can therefore
// leave through this tunnel to anything served at the allowed addresses.
//
// Its log has one line of JSON per decision, and never any bytes of a connection. A refused target came from the client, so it is
// cut to a short plain form and must still be read as untrusted text.
const dns = require('node:dns');
const fs = require('node:fs');
const net = require('node:net');

const DEFAULTS = Object.freeze({
  allow: 'api.anthropic.com:443',
  ranges: '160.79.104.0/23,2607:6bc0::/48', // the published inbound addresses of the API
  socket: '/sock/tunnel.sock',
  maxConns: 32,
  maxSeconds: 46 * 60, // past the runner's own 45 minutes, so it is the backstop and never the normal end
});
const MAX_HEAD_BYTES = 8192;
const HANDSHAKE_MS = 10_000;
const CONNECT_MS = 10_000;

const REASONS = { 200: 'Connection established', 400: 'Bad Request', 403: 'Forbidden', 405: 'Method Not Allowed', 408: 'Request Timeout', 431: 'Request Header Fields Too Large', 502: 'Bad Gateway', 503: 'Service Unavailable' };
const statusLine = (code) => `HTTP/1.1 ${code} ${REASONS[code]}\r\n${code === 200 ? '' : 'Connection: close\r\n'}\r\n`;

const shortTarget = (s) => (/^[A-Za-z0-9.:_[\]-]{1,80}$/.test(s) ? s : '(malformed)');

// The whole of the policy on a request. Only the first line is looked at: headers are not read, kept or logged.
function evaluateHead(head, allow) {
  const line = head.split('\r\n', 1)[0];
  const m = line.match(/^([A-Z]{1,16}) ([^ ]+) HTTP\/1\.[01]$/);
  if (!m) return { status: 400, why: 'malformed' };
  if (m[1] !== 'CONNECT') return { status: 405, why: 'not-connect' };
  if (m[2] !== allow) return { status: 403, why: 'not-allowed', target: shortTarget(m[2]) };
  return { status: 200, target: allow };
}

function splitTarget(target) {
  const at = target.lastIndexOf(':');
  return { host: target.slice(0, at), port: Number(target.slice(at + 1)) };
}

function makeRanges(text) {
  const list = new net.BlockList();
  for (const part of String(text).split(',').map((s) => s.trim()).filter(Boolean)) {
    const [addr, bits] = part.split('/');
    const type = net.isIPv6(addr) ? 'ipv6' : net.isIPv4(addr) ? 'ipv4' : null;
    if (!type || !/^\d+$/.test(bits ?? '')) throw new Error(`not an address range: ${part}`);
    list.addSubnet(addr, Number(bits), type);
  }
  return list;
}

function loadConfig(env = process.env) {
  const number = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${name} must be a whole number above 0`);
    return Number(raw);
  };
  const allow = env.NIGHT_TUNNEL_ALLOW || DEFAULTS.allow;
  const { host, port } = splitTarget(allow);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('NIGHT_TUNNEL_ALLOW must be host:port');
  return {
    allow,
    ranges: env.NIGHT_TUNNEL_RANGES || DEFAULTS.ranges,
    socket: env.NIGHT_TUNNEL_SOCKET || DEFAULTS.socket,
    maxConns: number('NIGHT_TUNNEL_MAX_CONNS', DEFAULTS.maxConns),
    maxSeconds: number('NIGHT_TUNNEL_MAX_SECONDS', DEFAULTS.maxSeconds),
  };
}

// Resolves to the checked addresses, IPv4 first. Any address outside the ranges refuses the whole name: a name that answers with a
// stranger among its addresses is not a name to trust.
function checkedAddresses(host, ranges, lookup) {
  return new Promise((resolve) => {
    lookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err || !addresses?.length) return resolve({ ok: false, why: 'no-address' });
      const outside = addresses.some((a) => !ranges.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4'));
      if (outside) return resolve({ ok: false, why: 'resolved-outside-ranges' });
      return resolve({ ok: true, addresses: [...addresses].sort((a, b) => a.family - b.family).map((a) => a.address) });
    });
  });
}

function connectFirst(addresses, port, connectMs) {
  return new Promise((resolve) => {
    const next = (i) => {
      if (i >= addresses.length) return resolve(null);
      const up = net.connect({ host: addresses[i], port });
      const timer = setTimeout(() => up.destroy(new Error('connect timeout')), connectMs);
      up.once('connect', () => {
        clearTimeout(timer);
        up.removeAllListeners('error');
        resolve(up);
      });
      up.once('error', () => {
        clearTimeout(timer);
        next(i + 1);
      });
      return undefined;
    };
    next(0);
  });
}

function startTunnel(config, { lookup = dns.lookup, log = (line) => process.stdout.write(`${line}\n`), handshakeMs = HANDSHAKE_MS, connectMs = CONNECT_MS, exit = () => process.exit(0) } = {}) {
  const ranges = makeRanges(config.ranges);
  const { host, port } = splitTarget(config.allow);
  const say = (fields) => log(JSON.stringify({ at: new Date().toISOString(), ...fields }));
  const clients = new Set();
  const counts = { allowed: 0, refused: 0 };

  const refuse = (client, status, why, target) => {
    counts.refused++;
    say({ event: 'refuse', status, why, ...(target ? { target } : {}) });
    client.end(statusLine(status));
    client.once('finish', () => client.destroy());
  };

  const open = async (client, early) => {
    const started = Date.now();
    const found = await checkedAddresses(host, ranges, lookup);
    if (client.destroyed) return;
    if (!found.ok) return refuse(client, found.why === 'no-address' ? 502 : 403, found.why, config.allow);
    const up = await connectFirst(found.addresses, port, connectMs);
    if (!up) return refuse(client, 502, 'upstream-unreachable', config.allow);
    if (client.destroyed) {
      up.destroy();
      return undefined;
    }
    counts.allowed++;
    say({ event: 'allow', target: config.allow });
    up.on('error', () => client.destroy());
    client.on('error', () => up.destroy());
    client.on('close', () => up.destroy());
    up.on('close', () => {
      client.destroy();
      say({ event: 'close', target: config.allow, sent: up.bytesWritten, received: up.bytesRead, ms: Date.now() - started });
    });
    client.write(statusLine(200));
    if (early.length) up.write(early);
    client.pipe(up);
    up.pipe(client);
    return undefined;
  };

  const server = net.createServer((client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => client.destroy());
    if (clients.size > config.maxConns) return refuse(client, 503, 'too-many-connections');
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      client.removeListener('data', onData);
      refuse(client, 408, 'no-request-in-time');
    }, handshakeMs);
    function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffered.length <= MAX_HEAD_BYTES) return;
        clearTimeout(timer);
        client.removeListener('data', onData);
        refuse(client, 431, 'request-too-large');
        return;
      }
      clearTimeout(timer);
      client.removeListener('data', onData);
      client.pause();
      if (end > MAX_HEAD_BYTES) {
        refuse(client, 431, 'request-too-large');
        return;
      }
      const verdict = evaluateHead(buffered.subarray(0, end).toString('latin1'), config.allow);
      if (verdict.status !== 200) {
        refuse(client, verdict.status, verdict.why, verdict.target);
        return;
      }
      void open(client, buffered.subarray(end + 4)).catch(() => client.destroy());
    }
    client.on('data', onData);
    client.on('close', () => clearTimeout(timer));
    return undefined;
  });

  fs.rmSync(config.socket, { force: true });
  const closing = new Promise((resolve) => {
    server.once('close', resolve);
  });
  const ready = new Promise((resolve, reject) => {
    // Before it is listening an error ends it. After, one failed accept must not.
    server.on('error', (err) => {
      if (server.listening) say({ event: 'error', why: String(err.code) });
      else reject(err);
    });
    server.listen(config.socket, () => {
      fs.chmodSync(config.socket, 0o666); // the session runs as another user, and its mount of this folder is read-only
      say({ event: 'listening', allow: config.allow });
      resolve();
    });
  });
  const deadline = setTimeout(() => {
    say({ event: 'deadline', ...counts });
    for (const c of clients) c.destroy();
    server.close();
    exit();
  }, config.maxSeconds * 1000);
  deadline.unref?.();

  const close = async () => {
    clearTimeout(deadline);
    for (const c of clients) c.destroy();
    server.close();
    await closing;
  };
  return { ready, close, counts };
}

module.exports = { DEFAULTS, evaluateHead, loadConfig, makeRanges, startTunnel, statusLine };

if (require.main === module) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`tunnel: ${err.message}`);
    process.exit(2);
  }
  // The deadline's timer is unref'd for tests. Here the server keeps the process alive until it fires.
  const tunnel = startTunnel(config);
  tunnel.ready.catch((err) => {
    console.error(`tunnel: could not listen: ${err.code ?? err.message}`);
    process.exit(2);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
}
