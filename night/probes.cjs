'use strict';
// What night-check runs inside the real containers, with node -e, so the probes are not part of the image. Each line is name=value.
// Values are fixed words, counts or names: nothing here prints what a file holds, or the value of any environment variable.
const { spawn } = require('node:child_process');
const dns = require('node:dns');
const dgram = require('node:dgram');
const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');

const args = JSON.parse(process.argv[1] ?? '{}');
const say = (name, value) => console.log(`${name}=${value}`);
const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
const RELAY_BYTES = 256 * 1024;

const writeResult = (fn) => {
  try {
    fn();
    return 'writable';
  } catch (err) {
    if (err.code === 'EROFS') return 'read-only';
    if (err.code === 'EACCES' || err.code === 'EPERM') return 'denied';
    return String(err.code);
  }
};
const tryWrite = (path) => writeResult(() => {
  fs.writeFileSync(path, '');
  fs.rmSync(path);
});

function identity() {
  say('uid', process.getuid());
  say('gid', process.getgid());
  const status = fs.readFileSync('/proc/self/status', 'utf8');
  const field = (name) => status.match(new RegExp(`^${name}:\\s*(.*)$`, 'm'))?.[1] ?? 'missing';
  for (const [name, key] of [['cap_effective', 'CapEff'], ['cap_permitted', 'CapPrm'], ['cap_inheritable', 'CapInh'], ['cap_bounding', 'CapBnd'], ['cap_ambient', 'CapAmb'], ['no_new_privs', 'NoNewPrivs'], ['seccomp', 'Seccomp']]) {
    say(name, field(key));
  }
}

function filesystem() {
  for (const [name, path] of [['etc', '/etc/.adabra-probe'], ['usr', '/usr/.adabra-probe'], ['image_dir', '/opt/adabra-night/.adabra-probe'], ['home', '/home/node/.adabra-probe'], ['work', '/work/.adabra-probe'], ['tmp', '/tmp/.adabra-probe']]) {
    say(`write.${name}`, tryWrite(path));
  }
  const mounts = fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').map((l) => l.split(' '));
  const at = (dir) => mounts.filter((m) => m[1] === dir).at(-1);
  say('mount.root', at('/')?.[3]?.split(',').includes('ro') ? 'read-only' : 'WRITABLE');
  say('mount.work', at('/work')?.[2] ?? 'missing');
  say('mount.tmp', at('/tmp')?.[2] ?? 'missing');
  let special = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.lstatSync(p).mode & 0o6000) special++;
    }
  };
  for (const dir of ['/usr', '/opt', '/etc', '/var', '/home', '/sbin', '/bin', '/lib']) walk(dir);
  say('setuid_files', special);
}

function absent() {
  for (const { name, path } of args.absent) {
    let got = 'PRESENT';
    try {
      fs.lstatSync(path);
    } catch (err) {
      got = err.code === 'ENOENT' ? 'absent' : String(err.code);
    }
    say(`absent.${name}`, got);
  }
}

const tcp = (target, ms = 5000) => new Promise((resolve) => {
  const at = target.lastIndexOf(':');
  const c = net.connect({ host: target.slice(0, at), port: Number(target.slice(at + 1)) });
  const done = (got) => {
    clearTimeout(timer);
    c.destroy();
    resolve(got);
  };
  const timer = setTimeout(() => done('fail'), ms);
  c.once('connect', () => done('open'));
  c.once('error', () => done('fail'));
});

async function network() {
  // The kernel lists idle tunnel devices in every network namespace. They are down, and bringing one up needs a capability that is dropped.
  const isUp = (n) => {
    try {
      return (Number(fs.readFileSync(`/sys/class/net/${n}/flags`, 'utf8').trim()) & 1) === 1;
    } catch {
      return false;
    }
  };
  say('net.interfaces', fs.readdirSync('/sys/class/net').filter((n) => n !== 'lo' && isUp(n)).join(',') || 'loopback only');
  const routes = (file, device) => {
    try {
      return fs.readFileSync(file, 'utf8').trim().split('\n').map(device).filter((d) => d && d !== 'Iface' && d !== 'lo').length;
    } catch {
      return 0;
    }
  };
  say('net.routes', routes('/proc/net/route', (l) => l.split(/\s+/)[0]) + routes('/proc/net/ipv6_route', (l) => l.trim().split(/\s+/).at(-1)));
  const server = net.createServer((c) => c.destroy());
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  say('net.loopback', (await tcp(`127.0.0.1:${server.address().port}`)) === 'open' ? 'works' : 'broken');
  server.close();
  for (const [name, target] of Object.entries(args.tcp ?? {})) say(`tcp.${name}`, await tcp(target));
  for (const [name, host] of Object.entries(args.dns ?? {})) {
    const got = await Promise.race([dns.promises.lookup(host).then(() => 'resolved', () => 'fail'), sleep(6000).then(() => 'fail')]);
    say(`dns.${name}`, got);
  }
  if (args.udp) {
    const [host, port] = args.udp.split(':');
    const socket = dgram.createSocket('udp4');
    const got = await new Promise((resolve) => {
      socket.once('error', () => resolve('fail'));
      socket.send(Buffer.from([0]), Number(port), host, (err) => resolve(err ? 'fail' : 'sent'));
    });
    socket.close();
    say('udp.public', got);
  }
}

function environment() {
  say('env.names', Object.keys(process.env).sort().join(','));
  const value = process.env[args.credentialName];
  say('env.credential', value === undefined ? 'missing' : value === args.dummy ? 'the dummy' : 'SOMETHING ELSE');
  // Not a boundary, and not meant to pass as one: this shows the credential can be read by the session user, as was accepted.
  let first = 'not readable';
  try {
    if (fs.readFileSync('/proc/1/environ').includes(`${args.credentialName}=${args.dummy}`)) first = 'readable';
  } catch {
    first = 'not readable';
  }
  say('env.credential_in_first_process', first);
}

function socketMount() {
  const stat = fs.statSync('/sock');
  say('sock.dir_owner', stat.uid);
  say('sock.create', tryWrite('/sock/.adabra-probe'));
  say('sock.unlink', writeResult(() => fs.unlinkSync(args.socket)));
  say('sock.chmod', writeResult(() => fs.chmodSync('/sock', 0o777)));
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      say('sock.bind', err.code === 'EROFS' ? 'read-only' : String(err.code));
      resolve();
    });
    server.listen('/sock/.adabra-probe.sock', () => {
      say('sock.bind', 'BOUND');
      server.close(() => resolve());
    });
  });
}

// One request at the tunnel. Resolves the status code and, when the tunnel said yes, the open connection.
function ask(socketPath, raw, ms = 15_000) {
  return new Promise((resolve) => {
    const c = net.connect(socketPath);
    let got = Buffer.alloc(0);
    const done = (status, open = false) => {
      clearTimeout(timer);
      c.removeListener('data', onData);
      if (!open) c.destroy();
      resolve({ status, connection: open ? c : null });
    };
    function onData(d) {
      got = Buffer.concat([got, d]);
      const end = got.indexOf('\r\n\r\n');
      if (end === -1) return;
      const m = got.subarray(0, end).toString('latin1').match(/^HTTP\/1\.1 (\d{3}) /);
      const status = m ? m[1] : 'bad reply';
      done(status, status === '200');
    }
    const timer = setTimeout(() => done('timeout'), ms);
    c.on('data', onData);
    c.once('connect', () => c.write(raw));
    c.once('error', () => done('no connection'));
    c.once('close', () => done('closed'));
  });
}

const connectLine = (target) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

async function attempts() {
  for (const [name, raw] of Object.entries(args.attempts ?? {})) say(`attempt.${name}`, (await ask(args.socket, raw)).status);
}

// The allowed target, carrying a marker in its request headers and another in the stream. The bytes must come back as they went.
async function relay() {
  const { allow, headerMarker, streamMarker } = args.relay;
  const { status, connection: c } = await ask(args.socket, `CONNECT ${allow} HTTP/1.1\r\nHost: ${allow}\r\nProxy-Authorization: Bearer ${headerMarker}\r\n\r\n`);
  say('relay.status', status);
  if (!c) return;
  const body = Buffer.concat([Buffer.from(streamMarker), Buffer.alloc(RELAY_BYTES - streamMarker.length, 7)]);
  const back = await new Promise((resolve) => {
    let got = Buffer.alloc(0);
    const timer = setTimeout(() => resolve(got), 15_000);
    c.on('data', (d) => {
      got = Buffer.concat([got, d]);
      if (got.length >= body.length) {
        clearTimeout(timer);
        resolve(got);
      }
    });
    c.write(body);
  });
  say('relay.bytes', back.equals(body) ? 'unchanged' : 'CHANGED');
  c.destroy();
}

// Holds as many allowed connections as the tunnel will take, then one more.
async function capacity() {
  const { allow, max } = args.capacity;
  const open = [];
  let lastStatus = 'none';
  for (let i = 0; i < max + 1; i++) {
    const r = await ask(args.socket, connectLine(allow));
    lastStatus = r.status;
    if (r.connection) open.push(r.connection);
    else break;
  }
  say('cap.held', open.length);
  say('cap.next', lastStatus);
  for (const c of open) c.destroy();
}

// Holds one allowed connection until the tunnel ends it.
async function hold() {
  const { allow, maxMs } = args.hold;
  const { status, connection: c } = await ask(args.socket, connectLine(allow));
  say('hold.status', status);
  if (!c) return;
  const started = Date.now();
  const ended = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), maxMs);
    c.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
    c.on('error', () => {});
    c.resume();
  });
  say('hold.ended', ended ? 'yes' : 'NO');
  say('hold.ms', Date.now() - started);
  c.destroy();
}

// Through the tunnel to the real host, as far as a verified TLS handshake and no further: not one byte of a request is sent.
async function realHandshake() {
  const { host, port } = args.real;
  const { status, connection } = await ask(args.socket, connectLine(`${host}:${port}`));
  say('real.status', status);
  if (!connection) return;
  const got = await new Promise((resolve) => {
    const secure = tls.connect({ socket: connection, servername: host, rejectUnauthorized: true }, () => {
      resolve(secure.authorized ? 'verified' : 'unverified');
      secure.destroy();
    });
    secure.once('error', (err) => resolve(String(err.code ?? 'tls error')));
    setTimeout(() => resolve('timeout'), 15_000).unref();
  });
  say('real.tls', got);
  connection.destroy();
}

function cgroups() {
  const read = (file) => {
    try {
      return fs.readFileSync(`/sys/fs/cgroup/${file}`, 'utf8').trim();
    } catch {
      return 'missing';
    }
  };
  say('cgroup.memory', read('memory.max'));
  say('cgroup.swap', read('memory.swap.max'));
  say('cgroup.pids', read('pids.max'));
  say('cgroup.cpu', read('cpu.max').replace(' ', '/'));
}

function processes() {
  const kids = [];
  let started = 0;
  let refused = 0;
  for (let i = 0; i < args.processes; i++) {
    try {
      const c = spawn('sleep', ['30'], { stdio: 'ignore' });
      c.once('spawn', () => started++);
      c.once('error', () => refused++);
      kids.push(c);
    } catch {
      refused++;
    }
  }
  return sleep(4000).then(() => {
    say('process.started', started);
    say('process.refused', refused);
    for (const k of kids) {
      try {
        k.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  });
}

// Allocates until the kernel kills this. Only reaches its last line if the limit did not hold, and stops there.
function memory() {
  const keep = [];
  for (let mb = 64; mb <= args.memoryMb; mb += 64) keep.push(Buffer.alloc(64 * 1024 * 1024, 1));
  say('memory.survived', keep.length * 64);
}

function fill(dir, limitMb) {
  const path = `${dir}/.adabra-fill`;
  const chunk = Buffer.alloc(1024 * 1024, 1);
  const fd = fs.openSync(path, 'w');
  let mb = 0;
  let got = 'no limit met';
  try {
    while (mb < limitMb) {
      fs.writeSync(fd, chunk);
      mb++;
    }
  } catch (err) {
    got = err.code === 'ENOSPC' ? 'enospc' : String(err.code);
  }
  fs.closeSync(fd);
  fs.rmSync(path);
  return { mb, got };
}

function disk() {
  for (const { name, dir, limitMb } of args.disk) {
    const { mb, got } = fill(dir, limitMb);
    say(`disk.${name}`, got);
    say(`disk.${name}_mb`, mb);
  }
}

function imageFiles() {
  for (const { name, path } of args.imageFiles) {
    let got = 'root only';
    try {
      const s = fs.lstatSync(path);
      if (s.isSymbolicLink()) got = 'a symbolic link';
      else if (s.uid !== 0) got = 'not root-owned';
      else if (s.mode & 0o022) got = 'others may write';
    } catch {
      got = 'missing';
    }
    say(`file.${name}`, got);
  }
}

// In a container whose root is not read-only, so that a refusal comes from the file's owner and mode.
function imageWrites() {
  for (const { name, path } of args.imageFiles) {
    say(`write.${name}`, writeResult(() => {
      const isDir = fs.statSync(path).isDirectory();
      if (isDir) fs.mkdirSync(`${path}/.adabra-probe`);
      else fs.closeSync(fs.openSync(path, 'r+'));
    }));
  }
  say('write.control_rootfs', tryWrite('/home/node/.adabra-probe'));
}

// Run with the host's process list: counts the marked sleepers in the whole Docker VM, ten times a second, until killed.
async function watch() {
  const count = () => {
    let n = 0;
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const parts = fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\0');
        if (parts[0] === 'sleep' && parts[1] === args.mark) n++;
      } catch {
        // it went away while we looked
      }
    }
    return n;
  };
  for (;;) {
    say('count', count());
    await sleep(100);
  }
}

const GROUPS = { identity, filesystem, absent, network, environment, socketMount, attempts, relay, capacity, hold, realHandshake, cgroups, processes, memory, disk, imageFiles, imageWrites, watch };

(async () => {
  for (const name of args.groups) await GROUPS[name]();
  process.exit(0);
})().catch((err) => {
  console.error(`probe failed: ${err.code ?? err.name}`);
  process.exit(1);
});
