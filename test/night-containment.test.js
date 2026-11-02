import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DUMMY_CREDENTIAL, CHECK_LABEL, nightCheck, nightCheckCommand } from '../night/check.js';
import { ALLOWED_SESSION_ENV, CLI_SHA256, CLI_VERSION, CREDENTIAL_ENV, IMAGE_ENV, LABEL, SESSION_LIMITS, TUNNEL_LIMITS, removeByLabel, sessionArgs, taskInput, tunnelArgs } from '../night/containers.js';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = join(ROOT, 'night', 'image');
const FAKE = join(ROOT, 'test', 'fixtures', 'fake-docker-night.js');
const TUNNEL_FILE = join(IMAGE, 'tunnel.cjs');
const { DEFAULTS, evaluateHead, loadConfig, startTunnel } = require(TUNNEL_FILE);
const { startShim } = require(join(IMAGE, 'shim.cjs'));
const imageFile = (name) => readFileSync(join(IMAGE, name), 'utf8');

const scratch = () => mkdtempSync(join(tmpdir(), 'adabra-night-'));
const connectLine = (target, headers = '') => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${headers}\r\n`;

// A local stand-in for the allowed host: it echoes, and remembers what it saw.
function upstream() {
  return new Promise((resolve) => {
    const seen = { connections: 0, bytes: [] };
    const sockets = new Set();
    const server = createServer((c) => {
      seen.connections++;
      sockets.add(c);
      c.on('close', () => sockets.delete(c));
      c.on('error', () => {});
      c.on('data', (d) => {
        seen.bytes.push(d);
        c.write(d);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      seen,
      received: () => Buffer.concat(seen.bytes),
      close: () => new Promise((done) => {
        for (const c of sockets) c.destroy();
        server.close(() => done());
      }),
    }));
  });
}

const localLookup = (address = '127.0.0.1', family = 4) => (_host, _options, cb) => cb(null, [{ address, family }]);

async function withTunnel(fn, { config = {}, options = {} } = {}) {
  const dir = scratch();
  const up = await upstream();
  const lines = [];
  const allow = `allowed.test:${up.port}`;
  const socket = join(dir, 't.sock');
  const tunnel = startTunnel(
    { allow, ranges: '127.0.0.0/8', socket, maxConns: 4, maxSeconds: 3600, ...config },
    { lookup: localLookup(), log: (l) => lines.push(JSON.parse(l)), handshakeMs: 300, connectMs: 500, ...options },
  );
  await tunnel.ready;
  try {
    await fn({ allow, socket, up, lines, tunnel, dir });
  } finally {
    await tunnel.close();
    await up.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Sends raw bytes to the tunnel. Resolves the status code, and the connection if it stayed open.
function ask(socket, raw) {
  return new Promise((resolve, reject) => {
    const c = connect(socket);
    let got = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('no answer from the tunnel')), 5000);
    const onData = (d) => {
      got = Buffer.concat([got, d]);
      const end = got.indexOf('\r\n\r\n');
      if (end === -1) return;
      clearTimeout(timer);
      c.removeListener('data', onData);
      const status = Number(got.subarray(0, end).toString('latin1').match(/^HTTP\/1\.1 (\d{3}) /)?.[1]);
      resolve({ status, connection: c, rest: got.subarray(end + 4) });
    };
    c.on('data', onData);
    c.on('error', () => {});
    c.once('connect', () => {
      if (raw !== null) c.write(raw);
    });
  });
}

const readBack = (c, size) => new Promise((resolve, reject) => {
  let got = Buffer.alloc(0);
  const timer = setTimeout(() => reject(new Error('echo did not come back')), 5000);
  c.on('data', (d) => {
    got = Buffer.concat([got, d]);
    if (got.length >= size) {
      clearTimeout(timer);
      resolve(got);
    }
  });
});

test('tunnel policy: only the exact target passes, and everything else fails the same comparison', () => {
  const allow = 'api.anthropic.com:443';
  assert.equal(evaluateHead(`CONNECT ${allow} HTTP/1.1`, allow).status, 200);
  assert.equal(evaluateHead(`CONNECT ${allow} HTTP/1.0`, allow).status, 200);
  for (const target of [
    'github.com:443', '160.79.104.10:443', '127.0.0.1:443', '[::1]:443', '2130706433:443', '0x7f.1:443',
    'api.anthropic.com:80', 'api.anthropic.com', 'api.anthropic.com.:443', 'API.ANTHROPIC.COM:443',
    'api.anthropic.com.example.com:443', 'example.api.anthropic.com:443', 'api.anthropic.com:443@example.com:443',
    'example.com:443@api.anthropic.com:443', 'http://api.anthropic.com:443/', 'api.anthropic.com:0443',
  ]) {
    const v = evaluateHead(`CONNECT ${target} HTTP/1.1`, allow);
    assert.equal(v.status, 403, target);
  }
  assert.equal(evaluateHead(`GET http://${allow}/ HTTP/1.1`, allow).status, 405);
  assert.equal(evaluateHead(`POST https://${allow}/v1/messages HTTP/1.1`, allow).status, 405);
  for (const bad of [`CONNECT ${allow}`, `CONNECT  ${allow} HTTP/1.1`, `connect ${allow} HTTP/1.1`, `CONNECT ${allow} HTTP/2`, '', '\x16\x03\x01', `CONNECT ${allow} HTTP/1.1 extra`]) {
    assert.equal(evaluateHead(bad, allow).status, 400, JSON.stringify(bad));
  }
  // Only the first line counts, so a second line cannot change the answer.
  assert.equal(evaluateHead(`CONNECT example.com:443 HTTP/1.1\r\nCONNECT ${allow} HTTP/1.1`, allow).status, 403);
  // What a refused target can put in the log is short and plain.
  assert.equal(evaluateHead('CONNECT a{b}:443 HTTP/1.1', allow).target, '(malformed)');
  assert.equal(evaluateHead(`CONNECT ${'a'.repeat(200)}:443 HTTP/1.1`, allow).target, '(malformed)');
});

test('tunnel settings: left alone, they are the real host and its published ranges', () => {
  const c = loadConfig({});
  assert.equal(c.allow, 'api.anthropic.com:443');
  assert.equal(c.ranges, '160.79.104.0/23,2607:6bc0::/48');
  assert.equal(c.socket, '/sock/tunnel.sock');
  assert.equal(c.maxConns, DEFAULTS.maxConns);
  assert.equal(c.maxSeconds, DEFAULTS.maxSeconds);
  assert.ok(c.maxSeconds > 45 * 60, 'a backstop, past the run limit');
  const over = loadConfig({ NIGHT_TUNNEL_ALLOW: 'stand-in.test:8443', NIGHT_TUNNEL_RANGES: '10.0.0.0/8', NIGHT_TUNNEL_MAX_CONNS: '2', NIGHT_TUNNEL_MAX_SECONDS: '9' });
  assert.deepEqual([over.allow, over.ranges, over.maxConns, over.maxSeconds], ['stand-in.test:8443', '10.0.0.0/8', 2, 9]);
  for (const env of [{ NIGHT_TUNNEL_ALLOW: 'no-port' }, { NIGHT_TUNNEL_ALLOW: 'x:99999' }, { NIGHT_TUNNEL_MAX_CONNS: '0' }, { NIGHT_TUNNEL_MAX_SECONDS: 'soon' }]) {
    assert.throws(() => loadConfig(env), /NIGHT_TUNNEL/);
  }
  assert.throws(() => startTunnel({ ...c, ranges: 'everything', socket: join(tmpdir(), 'never.sock') }, { log: () => {} }), /not an address range/);
});

test('tunnel: the allowed target gets a byte-for-byte pipe, and its request headers go no further', async () => {
  await withTunnel(async ({ allow, socket, up, lines }) => {
    const secret = 'request-header-marker';
    const body = Buffer.from(Array.from({ length: 100_000 }, (_, i) => i % 256));
    const { status, connection } = await ask(socket, connectLine(allow, `Proxy-Authorization: Bearer ${secret}\r\n`));
    assert.equal(status, 200);
    const back = readBack(connection, body.length);
    connection.write(body);
    assert.ok((await back).equals(body));
    connection.destroy();
    assert.equal(up.seen.connections, 1);
    assert.ok(up.received().equals(body), 'the stand-in saw exactly the stream');
    assert.ok(!up.received().includes(secret));
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const text = JSON.stringify(lines);
    assert.ok(!text.includes(secret), 'request headers are not logged');
    assert.ok(!text.includes('\\u0000'), 'stream bytes are not logged');
    assert.deepEqual(lines.map((l) => l.event), ['listening', 'allow', 'close']);
    const closed = lines.at(-1);
    assert.equal(closed.sent, body.length);
    assert.equal(closed.received, body.length);
    assert.deepEqual(Object.keys(closed).sort(), ['at', 'event', 'ms', 'received', 'sent', 'target']);
  });
});

test('tunnel: bytes sent straight after the request are not lost', async () => {
  await withTunnel(async ({ allow, socket, up }) => {
    const { status, connection, rest } = await ask(socket, `${connectLine(allow)}early bytes`);
    assert.equal(status, 200);
    const back = rest.length ? rest : await readBack(connection, 'early bytes'.length);
    assert.equal(back.toString(), 'early bytes');
    connection.destroy();
    assert.equal(up.received().toString(), 'early bytes');
  });
});

test('tunnel: a refused request never reaches the upstream, and is logged with a reason', async () => {
  await withTunnel(async ({ allow, socket, up, lines }) => {
    const host = allow.split(':')[0];
    const port = allow.split(':')[1];
    const asks = [
      [connectLine('github.com:443'), 403],
      [connectLine(`127.0.0.1:${port}`), 403],
      [connectLine(`[::1]:${port}`), 403],
      [connectLine(`${host}:1`), 403],
      [connectLine(`${host}.:${port}`), 403],
      [`${connectLine('example.com:443')}${connectLine(allow)}`, 403],
      [`GET http://${allow}/ HTTP/1.1\r\n\r\n`, 405],
      [`POST http://${allow}/ HTTP/1.1\r\nAuthorization: Bearer secret-in-plain\r\n\r\n`, 405],
      ['\x16\x03\x01 not a request\r\n\r\n', 400],
    ];
    for (const [raw, want] of asks) {
      const r = await ask(socket, raw);
      assert.equal(r.status, want, raw);
      r.connection.destroy();
    }
    assert.equal(up.seen.connections, 0);
    const refusals = lines.filter((l) => l.event === 'refuse');
    assert.equal(refusals.length, asks.length);
    assert.ok(refusals.every((l) => typeof l.why === 'string'));
    assert.ok(!JSON.stringify(lines).includes('secret-in-plain'));
  });
});

test('tunnel: an allowed name that resolves outside the ranges is refused, and nothing connects', async () => {
  const allOutside = (_h, _o, cb) => cb(null, [{ address: '203.0.113.9', family: 4 }]);
  const oneOutside = (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '203.0.113.9', family: 4 }]);
  const outsideSix = (_h, _o, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }, { address: '2001:db8::1', family: 6 }]);
  for (const lookup of [allOutside, oneOutside, outsideSix]) {
    await withTunnel(async ({ allow, socket, up, lines }) => {
      const r = await ask(socket, connectLine(allow));
      assert.equal(r.status, 403);
      r.connection.destroy();
      assert.equal(up.seen.connections, 0);
      assert.equal(lines.find((l) => l.event === 'refuse').why, 'resolved-outside-ranges');
    }, { options: { lookup } });
  }
  // Inside the ranges it connects, and it looked the name up only once.
  let looked = 0;
  const counted = (_h, _o, cb) => {
    looked++;
    cb(null, [{ address: '127.0.0.1', family: 4 }]);
  };
  await withTunnel(async ({ allow, socket, up }) => {
    const r = await ask(socket, connectLine(allow));
    assert.equal(r.status, 200);
    r.connection.destroy();
    assert.equal(up.seen.connections, 1);
    assert.equal(looked, 1, 'looked up once');
  }, { options: { lookup: counted } });
});

test('tunnel: no address, or an upstream that does not answer, is a bad gateway and not a hang', async () => {
  const none = (_h, _o, cb) => cb(new Error('no such name'));
  await withTunnel(async ({ allow, socket }) => {
    const r = await ask(socket, connectLine(allow));
    assert.equal(r.status, 502);
    r.connection.destroy();
  }, { options: { lookup: none } });
  await withTunnel(async ({ socket }) => {
    const r = await ask(socket, connectLine('allowed.test:1'));
    assert.equal(r.status, 502);
    r.connection.destroy();
  }, { config: { allow: 'allowed.test:1' } });
});

test('tunnel: an oversized request and a silent client are both turned away', async () => {
  await withTunnel(async ({ allow, socket, up }) => {
    const big = await ask(socket, `CONNECT ${allow} HTTP/1.1\r\nX: ${'a'.repeat(9000)}`);
    assert.equal(big.status, 431);
    big.connection.destroy();
    const bigEnded = await ask(socket, `CONNECT ${allow} HTTP/1.1\r\nX: ${'a'.repeat(9000)}\r\n\r\n`);
    assert.equal(bigEnded.status, 431);
    bigEnded.connection.destroy();
    const silent = await ask(socket, null);
    assert.equal(silent.status, 408);
    silent.connection.destroy();
    assert.equal(up.seen.connections, 0);
  });
});

test('tunnel: the connection cap refuses the next one, and frees up as connections end', async () => {
  await withTunnel(async ({ allow, socket, up }) => {
    const held = [];
    for (let i = 0; i < 2; i++) {
      const r = await ask(socket, connectLine(allow));
      assert.equal(r.status, 200);
      held.push(r.connection);
    }
    const over = await ask(socket, connectLine(allow));
    assert.equal(over.status, 503);
    over.connection.destroy();
    assert.equal(up.seen.connections, 2);
    held.pop().destroy();
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const again = await ask(socket, connectLine(allow));
    assert.equal(again.status, 200);
    again.connection.destroy();
    held.pop().destroy();
  }, { config: { maxConns: 2 } });
});

test('tunnel: anyone may connect to its socket, because the session is another user', async () => {
  await withTunnel(async ({ socket }) => {
    assert.equal(statSync(socket).mode & 0o777, 0o666);
  });
});

test('tunnel: at its deadline it ends live connections and exits, as a real process', async () => {
  const dir = scratch();
  const socket = join(dir, 't.sock');
  const up = await upstream();
  try {
    // The name resolves for real here: `localhost` needs nothing but /etc/hosts.
    const child = spawn(process.execPath, [TUNNEL_FILE], {
      env: { ...process.env, NIGHT_TUNNEL_ALLOW: `localhost:${up.port}`, NIGHT_TUNNEL_RANGES: '127.0.0.0/8,::1/128', NIGHT_TUNNEL_SOCKET: socket, NIGHT_TUNNEL_MAX_SECONDS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    const exited = new Promise((resolve) => {
      child.on('close', (code) => resolve(code));
    });
    for (let i = 0; i < 100 && !existsSync(socket); i++) {
      await new Promise((r) => {
        setTimeout(r, 20);
      });
    }
    const { status, connection } = await ask(socket, connectLine(`localhost:${up.port}`));
    assert.equal(status, 200);
    const ended = new Promise((resolve) => {
      connection.once('close', () => resolve(true));
    });
    connection.resume();
    assert.equal(await exited, 0);
    assert.equal(await ended, true);
    assert.match(out, /"event":"deadline"/);
  } finally {
    await up.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shim: joins each loopback connection to the socket, and is only a pipe', async () => {
  await withTunnel(async ({ socket, up }) => {
    const shim = await startShim({ port: 0, socket });
    try {
      const reply = await new Promise((resolve, reject) => {
        const c = connect(shim.address().port, '127.0.0.1');
        let got = '';
        c.on('error', reject);
        c.on('data', (d) => {
          got += d;
          if (got.includes('\r\n\r\n')) {
            resolve(got);
            c.destroy();
          }
        });
        c.once('connect', () => c.write(connectLine('github.com:443')));
      });
      assert.match(reply, /^HTTP\/1\.1 403 /, 'the tunnel decides, not the shim');
      assert.equal(up.seen.connections, 0);
    } finally {
      await new Promise((r) => {
        shim.close(r);
      });
    }
  });
});

test('session container: no network, no host files, not root, read-only, limited, and the credential by name only', () => {
  const a = sessionArgs({ name: 'n', image: 'img', volume: 'v' });
  const after_ = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(after_('--network'), 'none');
  assert.equal(after_('--user'), '1000:1000');
  assert.equal(after_('--cap-drop'), 'ALL');
  assert.equal(after_('--security-opt'), 'no-new-privileges');
  assert.equal(after_('--pull'), 'never');
  assert.equal(after_('--memory'), SESSION_LIMITS.memory);
  assert.equal(after_('--memory-swap'), SESSION_LIMITS.memory);
  assert.equal(after_('--pids-limit'), String(SESSION_LIMITS.pids));
  assert.equal(after_('--cpus'), SESSION_LIMITS.cpus);
  assert.equal(after_('--label'), LABEL);
  for (const flag of ['--read-only', '--rm', '--init', '-i']) assert.ok(a.includes(flag), flag);
  assert.equal(after_('--log-driver'), 'none', 'its output goes down the pipe, and not to a log file');
  for (const bad of ['--privileged', '--env-file', '--mount', '--pid', '--cap-add', '--device', '--volumes-from']) assert.ok(!a.includes(bad), bad);
  assert.equal(a.at(-1), 'img');
  const volumes = a.filter((_, i) => a[i - 1] === '-v');
  assert.deepEqual(volumes, ['v:/sock:ro'], 'one named volume, read-only, and no host path');
  const tmpfs = a.filter((_, i) => a[i - 1] === '--tmpfs');
  assert.ok(tmpfs[0].startsWith('/work:') && tmpfs[0].includes(`size=${SESSION_LIMITS.work}`) && tmpfs[0].includes('nosuid,nodev'));
  assert.ok(tmpfs[1].startsWith('/tmp:') && tmpfs[1].includes(`size=${SESSION_LIMITS.tmp}`) && tmpfs[1].includes('nosuid,nodev'));
  assert.deepEqual(a.filter((_, i) => a[i - 1] === '-e'), [CREDENTIAL_ENV], 'by name, so the value is in no argument list');
  assert.ok(!a.join(' ').includes('docker.sock'));
});

test('tunnel container: a bridge, the socket volume, no credential, and the real settings unless told otherwise', () => {
  const a = tunnelArgs({ name: 'n', image: 'img', volume: 'v', network: 'net' });
  const after_ = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(after_('--network'), 'net');
  assert.equal(after_('--user'), '1001:1001');
  assert.equal(after_('--cap-drop'), 'ALL');
  assert.equal(after_('--memory'), TUNNEL_LIMITS.memory);
  assert.equal(after_('--pids-limit'), String(TUNNEL_LIMITS.pids));
  assert.ok(a.includes('--read-only') && a.includes('--rm') && a.includes('--init'));
  assert.deepEqual(a.filter((_, i) => a[i - 1] === '--log-opt'), [`max-size=${TUNNEL_LIMITS.logSize}`, 'max-file=2'], 'a flood of refused requests stays small');
  assert.deepEqual(a.filter((_, i) => a[i - 1] === '-v'), ['v:/sock']);
  assert.deepEqual(a.filter((_, i) => a[i - 1] === '-e'), [], 'no environment at all by default');
  assert.deepEqual(a.slice(-2), ['node', '/opt/adabra-night/tunnel.cjs']);
  assert.ok(!a.join(' ').includes(CREDENTIAL_ENV));
  const stand = tunnelArgs({ name: 'n', image: 'img', volume: 'v', network: 'net', allow: 'a.test:1', ranges: '10.0.0.0/8', maxSeconds: 5 });
  assert.deepEqual(stand.filter((_, i) => stand[i - 1] === '-e'), ['NIGHT_TUNNEL_ALLOW=a.test:1', 'NIGHT_TUNNEL_RANGES=10.0.0.0/8', 'NIGHT_TUNNEL_MAX_SECONDS=5']);
});

test('task input: one plain tar with the task text and the source tarball', () => {
  const tar = taskInput({ taskText: 'Do it.\n', sourceTarball: Buffer.from([1, 2, 3, 0, 255]) });
  const name = (at) => tar.subarray(at, at + 100).toString('latin1').replace(/\0.*$/s, '');
  assert.equal(name(0), 'TASK.md');
  assert.equal(tar.subarray(512, 519).toString(), 'Do it.\n');
  assert.equal(name(1024), 'source.tar.gz');
  assert.deepEqual([...tar.subarray(1536, 1541)], [1, 2, 3, 0, 255]);
  assert.equal(tar.length % 512, 0);
});

test('image: the base is pinned by digest, and the CLI is one exact release checked against the signed manifest', () => {
  const d = imageFile('Dockerfile');
  const froms = [...d.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
  assert.equal(froms.length, 2);
  for (const from of froms) assert.match(from, /^node@sha256:[0-9a-f]{64}$/);
  assert.equal(froms[0], froms[1]);
  assert.match(d, new RegExp(`^ARG CLAUDE_VERSION=${CLI_VERSION.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(d, new RegExp(`^ARG CLAUDE_SHA256_LINUX_ARM64=${CLI_SHA256.aarch64}$`, 'm'));
  assert.match(d, new RegExp(`^ARG CLAUDE_SHA256_LINUX_X64=${CLI_SHA256.x86_64}$`, 'm'));
  assert.match(d, /^ARG CLAUDE_SIGNER_FINGERPRINT=31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE$/m);
  assert.match(d, /gpg --batch --status-fd 1 --verify manifest\.json\.sig manifest\.json/);
  assert.match(d, /VALIDSIG/);
  assert.match(d, /grep -qx "\$CLAUDE_SIGNER_FINGERPRINT"/);
  assert.match(d, /sha256sum -c/);
  assert.ok(!/latest|stable|curl[^\n]*\| *(sh|bash)|npm install/.test(d.replace(/^#.*$/gm, '')), 'no floating version, no piped installer');
  assert.match(d, /^USER 1000:1000$/m);
  assert.match(d, /chmod a-s/, 'setuid bits are stripped');
  assert.match(d, /chown -R 0:0 \/opt\/adabra-night \/etc\/claude-code/);
  assert.match(d, /install -d -o 1001 -g 1001 -m 755 \/sock/);
});

test('image environment: the Dockerfile sets exactly the names the check allows, and the credential is not one of them', () => {
  const d = imageFile('Dockerfile');
  const block = d.slice(d.indexOf('\nENV ') + 1, d.indexOf('\nUSER '));
  const names = [...block.matchAll(/(?:^ENV |^\s+)([A-Z_]+)=/gm)].map((m) => m[1]);
  assert.deepEqual([...names].sort(), [...IMAGE_ENV].sort());
  assert.ok(!names.includes(CREDENTIAL_ENV) && !d.includes(CREDENTIAL_ENV));
  assert.ok(ALLOWED_SESSION_ENV.includes(CREDENTIAL_ENV));
  assert.ok(!/ANTHROPIC_API_KEY|ANTHROPIC_BASE_URL|ANTHROPIC_AUTH/.test(block), 'nothing redirects or replaces the credential');
  assert.match(block, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:8080/);
});

test('entry: the real flags, with no way round the permission rules', () => {
  const e = imageFile('entry.sh');
  execFileSync('sh', ['-n', join(IMAGE, 'entry.sh')]);
  execFileSync('sh', ['-n', join(IMAGE, 'export.sh')]);
  for (const flag of ['--restricted', '--tools "Bash,Read,Edit,Write,Grep,Glob"', '--disallowedTools "mcp__*"', '--strict-mcp-config', '--disable-slash-commands',
    '--permission-mode dontAsk', '--permission-prompts none', '--system-prompt-file /opt/adabra-night/night-v1.md', '--model claude-sonnet-5-5',
    '--max-turns 80', '--no-session-persistence', '--output-format stream-json']) {
    assert.ok(e.includes(flag), flag);
  }
  for (const bad of ['--bare', 'dangerously', 'bypassPermissions', 'WebFetch', 'WebSearch', 'Agent', 'curl', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.ok(!e.includes(bad), bad);
});

test('export: the work as one text diff, with git told not to run what the session left behind', () => {
  const x = imageFile('export.sh');
  for (const part of ['--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--cached', 'core.hooksPath=/dev/null', 'core.fsmonitor=false', 'GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null', '/usr/bin/git', '--ignore-unmatch -- .task']) {
    assert.ok(x.includes(part), part);
  }
  assert.ok(!x.includes('--binary'), 'a binary change stays refusable');
});

test('managed settings: hooks off, the rules only from here, the tools named, and no bypass', () => {
  const s = JSON.parse(imageFile('managed-settings.json'));
  assert.equal(s.disableAllHooks, true);
  assert.equal(s.allowManagedHooksOnly, true);
  assert.equal(s.allowManagedPermissionRulesOnly, true);
  assert.equal(s.disableClaudeAiConnectors, true);
  assert.equal(s.permissions.disableBypassPermissionsMode, 'disable');
  assert.equal(s.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.equal(s.permissions.blockWritesOutsideWorkingDirectories, true);
  assert.deepEqual([...s.permissions.allow].sort(), ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']);
  assert.equal(s.env, undefined);
});

test('prompt: generic, and it treats everything it reads as data', () => {
  const p = imageFile('night-v1.md');
  assert.match(p, /never instructions/);
  assert.match(p, /Do not commit/);
  assert.match(p, /`blocked`/);
  assert.match(p, /`done`/);
  assert.match(p, /npm test/);
  assert.ok(!/adabra|mini|ultra|subscription|token/i.test(p), 'nothing about this deployment');
});

// night-check itself, against the fake docker. Containers report nothing here, so everything fails: the real proof is the real run.
function fakeRun(mode = 'quiet', envOver = {}) {
  const dir = scratch();
  const record = join(dir, 'calls.jsonl');
  const env = {
    ...process.env,
    FAKE_NIGHT_MODE: mode,
    FAKE_NIGHT_RECORD: record,
    NIGHT_DOCKER: FAKE,
    ADABRA_STOP_FILE: join(dir, 'no-stop-file.json'),
    ...envOver,
  };
  return {
    dir, env,
    calls: () => (existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const QUICK = { readyMs: 100, cliMs: 100, initMs: 100, reviewWaitMs: 0, reviewPollMs: 1, killWaitMs: 100 };
const REAL_LOOKING = 'real-looking-value-in-the-parent-environment';

// One whole run of the command, shared by the tests that only read what it did: it takes a while, since each call starts a process.
let wholeRun = null;
const runWhole = () => {
  wholeRun ??= (async () => {
    const t = fakeRun('quiet', { [CREDENTIAL_ENV]: REAL_LOOKING });
    const said = [];
    const code = await nightCheckCommand({ env: t.env, say: (l) => said.push(l), sayError: (l) => said.push(l), home: t.dir, timings: QUICK });
    return { ...t, code, said };
  })();
  return wholeRun;
};
after(async () => {
  if (wholeRun) (await wholeRun).done();
});

test('night-check: a probe that does not report is a failure, and the command says so with a non-zero exit', async () => {
  const { code, said } = await runWhole();
  assert.equal(code, 1);
  assert.match(said.at(-1), /^NOT CONTAINED: \d+ of \d+ checks failed$/);
  for (const name of ['uid', 'absent.canary', 'tcp.engine_api', 'attempt.other_host', 'relay.bytes', 'real.tls', 'cli.flags_accepted', 'managed.bypass_refused', 'file.settings', 'limit.memory', 'kill.latency']) {
    const line = said.find((l) => l.includes(` ${name} `) || l.startsWith(`FAIL  ${name}`));
    assert.ok(line?.startsWith('FAIL'), `${name}: ${line}`);
  }
  assert.ok(said.every((l) => /^(PASS|FAIL) {2}\S+ +want .* {2}got |^NOT CONTAINED/.test(l)), 'every line is in the one format');
});

test('night-check: the session only ever gets the dummy, whatever this process holds, and only ever by name', async () => {
  const t = await runWhole();
  assert.ok(t.calls().filter((c) => c.args[0] === 'run').length > 10);
  assert.ok(t.calls().every((c) => c.credential === DUMMY_CREDENTIAL), 'docker is only ever handed the dummy');
  for (const { args } of t.calls()) {
    assert.ok(!args.join(' ').includes(REAL_LOOKING));
    assert.ok(!args.includes(`${CREDENTIAL_ENV}=${DUMMY_CREDENTIAL}`), 'not in an argument list');
  }
});

test('night-check: its CLI only ever runs where there is no route to anything real', async () => {
  const t = await runWhole();
  {
    const calls = t.calls();
    const closed = calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create' && c.args.includes('--internal'));
    assert.ok(closed, 'a closed network exists');
    const closedName = closed.args.at(-1);
    const open = calls.find((c) => c.args[0] === 'network' && c.args[1] === 'create' && !c.args.includes('--internal')).args.at(-1);
    const tunnels = calls.filter((c) => c.args[0] === 'run' && c.args.at(-1) === '/opt/adabra-night/tunnel.cjs');
    const onOpen = tunnels.filter((c) => c.args.includes(open));
    assert.equal(onOpen.length, 1, 'one tunnel has the real settings on a real bridge');
    const cliTunnel = tunnels.find((c) => c.args.join(' ').includes('tunnel-cli'));
    assert.ok(cliTunnel.args.includes(closedName), "the CLI's tunnel is on the closed network");
    assert.ok(cliTunnel.args.some((a) => a.startsWith('NIGHT_TUNNEL_ALLOW=night-upstream.test')), 'and allows only the stand-in');
    const cliVolume = cliTunnel.args[cliTunnel.args.indexOf('-v') + 1].split(':')[0];
    for (const c of calls.filter((x) => x.args[0] === 'run')) {
      const text = c.args.join(' ');
      if (!/\bclaude -p\b/.test(text) && c.args.at(-1) !== `sha256:${'a'.repeat(64)}`) continue;
      // Either the image's own entry on that tunnel, or a bare CLI with no network and no tunnel at all.
      assert.equal(c.args[c.args.indexOf('--network') + 1], 'none', text.slice(0, 120));
      const volumes = c.args.filter((_, i) => c.args[i - 1] === '-v');
      assert.ok(volumes.length === 0 || volumes[0].startsWith(`${cliVolume}:`), text.slice(0, 120));
    }
    assert.ok(!calls.some((c) => c.args.join(' ').includes('--bare')));
  }
});

test('night-check: everything it makes is labelled, and it only ever sweeps its own label', async () => {
  const t = await runWhole();
  {
    const calls = t.calls().map((c) => c.args);
    for (const args of calls.filter((a) => (a[0] === 'run') || (a[1] === 'create'))) {
      assert.ok(args.join(' ').includes(`--label ${LABEL}`) && args.join(' ').includes(`--label ${CHECK_LABEL}`), args.slice(0, 6).join(' '));
    }
    const afterLastRun = calls.slice(calls.map((a) => a[0] === 'run').lastIndexOf(true));
    assert.ok(afterLastRun.some((a) => a[0] === 'rm' && a.includes('check-container')), 'its own containers go at the end');
    assert.ok(afterLastRun.some((a) => a[0] === 'volume' && a[1] === 'rm' && a.includes('check-volume')), 'its own volumes go at the end');
    assert.ok(afterLastRun.some((a) => a[0] === 'network' && a[1] === 'rm' && a.includes('check-network')), 'its own networks go at the end');
    for (const a of calls.filter((x) => x.includes('--filter') && (x[0] === 'volume' || x[0] === 'network' || x.includes('-aq')) && !x.join(' ').includes('name='))) {
      assert.ok(a.includes(`label=${CHECK_LABEL}`), a.join(' '));
    }
    const removals = calls.filter((a) => a[0] === 'rm');
    assert.ok(removals.every((a) => a.every((x) => x !== 'review-container')));
    assert.ok(!calls.some((a) => (a[0] === 'rm' || a[0] === 'kill') && a.join(' ').includes('adabra-review')));
    for (const line of ['cleanup.containers_left', 'cleanup.volumes_left', 'cleanup.networks_left', 'cleanup.canary_removed']) {
      assert.ok(t.said.find((l) => l.includes(` ${line} `))?.startsWith('PASS'), line);
    }
    assert.ok(!readdirSync(t.dir).some((f) => f.startsWith('.adabra-night-canary-')));
  }
});

test('night-check: while a review container runs, the limit tests wait, and then say they did not run', async () => {
  const t = fakeRun('review-running');
  try {
    const r = await nightCheck({ docker: FAKE, env: t.env, home: t.dir, timings: QUICK });
    const byName = Object.fromEntries(r.results.map((x) => [x.check, x]));
    for (const name of ['limit.processes', 'limit.memory', 'limit.work_disk', 'limit.tmp_disk']) {
      assert.equal(byName[name].ok, false, name);
      assert.match(byName[name].got, /not run: a review container is still running/);
    }
    assert.equal(r.ok, false);
    const payloads = t.calls().filter((c) => c.args[0] === 'run').map((c) => c.args.join(' '));
    assert.ok(!payloads.some((p) => /"memoryMb"|"processes":700|"limitMb"/.test(p)), 'none of them started');
    assert.ok(t.calls().some((c) => c.args.includes(`label=adabra-review=1`) && c.args.includes('status=running')), 'it asked');
  } finally {
    t.done();
  }
});

test('night-check: with the limit tests free to run, they do', async () => {
  const t = await runWhole();
  const payloads = t.calls().filter((c) => c.args[0] === 'run').map((c) => c.args.join(' '));
  assert.ok(payloads.some((p) => p.includes('"memoryMb":4096')));
  assert.ok(payloads.some((p) => p.includes('"processes":700')));
  assert.ok(payloads.some((p) => p.includes('"limitMb":3000')));
});

test('night-check: a stop in force starts nothing at all, and exits with the stopped code', async () => {
  const t = fakeRun();
  try {
    writeFileSync(t.env.ADABRA_STOP_FILE, JSON.stringify({ stopped: true, reason: 'test', since: new Date().toISOString() }));
    const errors = [];
    const code = await nightCheckCommand({ env: t.env, say: () => {}, sayError: (l) => errors.push(l), home: t.dir, timings: QUICK });
    assert.equal(code, 3);
    assert.match(errors.join('\n'), /STOPPED/);
    assert.deepEqual(t.calls(), [], 'not one docker call');
  } finally {
    t.done();
  }
});

test('night-check: no docker, or no image, is a plain message and a non-zero exit, with nothing left behind', async () => {
  for (const [mode, pattern] of [['daemon-down', /docker is not available/], ['no-image', /docker build -t adabra-night:dev night\/image/]]) {
    const t = fakeRun(mode);
    const errors = [];
    try {
      const code = await nightCheckCommand({ env: t.env, say: () => {}, sayError: (l) => errors.push(l), home: t.dir, timings: QUICK });
      assert.equal(code, 1, mode);
      assert.match(errors.join('\n'), pattern);
      assert.ok(!t.calls().some((c) => c.args[0] === 'run'), 'nothing started');
    } finally {
      t.done();
    }
  }
  const t = fakeRun();
  try {
    const missing = { ...t.env, NIGHT_DOCKER: '/nonexistent/docker' };
    const errors = [];
    assert.equal(await nightCheckCommand({ env: missing, say: () => {}, sayError: (l) => errors.push(l), home: t.dir, timings: QUICK }), 1);
    assert.match(errors.join('\n'), /docker is not available/);
  } finally {
    t.done();
  }
});

test('night-check: if the machinery cannot be set up it does not finish, and still sweeps', async () => {
  const t = fakeRun('tunnel-never-starts');
  const errors = [];
  try {
    const code = await nightCheckCommand({ env: t.env, say: () => {}, sayError: (l) => errors.push(l), home: t.dir, timings: QUICK });
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /could not finish: the tunnel did not start/);
    const calls = t.calls().map((c) => c.args);
    const afterLastRun = calls.slice(calls.map((a) => a[0] === 'run').lastIndexOf(true));
    assert.ok(afterLastRun.some((a) => a[0] === 'rm' && a.includes('check-container')));
  } finally {
    t.done();
  }
});

test('night-check takes no options, so nothing can talk it into calling a model', async () => {
  const t = fakeRun();
  try {
    const errors = [];
    assert.equal(await nightCheckCommand({ args: ['--live'], env: t.env, say: () => {}, sayError: (l) => errors.push(l), home: t.dir }), 2);
    assert.match(errors.join('\n'), /never calls a model/);
    assert.deepEqual(t.calls(), []);
  } finally {
    t.done();
  }
});

test('sweep: removes by the label it is given, and reports what is left', async () => {
  const t = fakeRun();
  try {
    const left = await removeByLabel({ docker: FAKE, env: t.env, label: CHECK_LABEL });
    assert.deepEqual(left, { containers: 0, volumes: 0, networks: 0 });
    const calls = t.calls().map((c) => c.args);
    assert.ok(calls.filter((a) => a.includes('--filter')).every((a) => a.includes(`label=${CHECK_LABEL}`)));
  } finally {
    t.done();
  }
});

test('the fake docker can run at all, so these tests prove what they say', () => {
  assert.equal(execFileSync(FAKE, ['info'], { encoding: 'utf8' }).trim(), '29.0.0');
});
