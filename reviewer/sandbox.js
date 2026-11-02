import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// The untrusted half of the reviewer. PR code only ever runs inside this container:
// no network, no host files, no secrets in its environment, not root, read-only system, limited CPU, memory,
// processes and time, removed afterwards. The source arrives on stdin as GitHub's tarball and is unpacked
// INSIDE the container, so the host never extracts an archive the PR author controls.
export const DEFAULTS = {
  docker: 'docker',
  image: 'node:26-slim', // pin by digest on the mini: REVIEW_IMAGE=node@sha256:...
  cmd: 'npm test',
  timeoutMs: 15 * 60_000,
  memory: '4g',
  cpus: '2',
  pids: 512,
  maxLogBytes: 200_000,
};

export function dockerArgs({ name, image, memory, cpus, pids }) {
  return [
    'run', '--rm', '-i',
    '--name', name,
    '--label', 'adabra-review=1',
    '--pull', 'never', // the image is chosen and pulled by the operator, never by a job
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/work:rw,exec,nosuid,nodev,size=1g,mode=1777',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777',
    '--user', '1000:1000',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(pids),
    '--memory', memory, '--memory-swap', memory,
    '--cpus', String(cpus),
    '--init',
    '-e', 'HOME=/tmp', '-e', 'CI=true', '-e', 'NPM_CONFIG_UPDATE_NOTIFIER=false',
    '-w', '/work',
    image,
  ];
}

// Keeps only the last `max` bytes, so a PR that prints gigabytes cannot exhaust the dispatcher's memory.
class Tail {
  constructor(max) {
    this.max = max;
    this.chunks = [];
    this.size = 0;
    this.dropped = 0;
  }
  push(b) {
    this.chunks.push(b);
    this.size += b.length;
    while (this.size > this.max && this.chunks.length > 1) {
      const c = this.chunks.shift();
      this.size -= c.length;
      this.dropped += c.length;
    }
  }
  text() {
    let s = Buffer.concat(this.chunks).toString('utf8');
    if (s.length > this.max) s = s.slice(-this.max);
    return this.dropped ? `[${this.dropped} earlier bytes dropped]\n${s}` : s;
  }
}

export class Sandbox {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  }

  // Docker itself must be up; otherwise this is our problem, not the PR's.
  async ensureDocker() {
    try {
      await run(this.o.docker, ['info', '--format', '{{.ServerVersion}}'], { env: this.o.env ?? process.env, timeout: 20_000 });
    } catch (err) {
      throw new Error(`docker is not available: ${(err.stderr || err.message).toString().trim().slice(0, 200)}`);
    }
  }

  // Runs `script` with `sh -c` inside a fresh container. Resolves { code, timedOut, log }.
  // Rejects only when the container could not be started at all.
  exec({ name, script, args = [], input = null, timeoutMs = this.o.timeoutMs }) {
    const argv = [...dockerArgs({ ...this.o, name }), 'sh', '-c', script, 'sandbox', ...args];
    return new Promise((resolve, reject) => {
      const child = spawn(this.o.docker, argv, { env: this.o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
      const tail = new Tail(this.o.maxLogBytes);
      let timedOut = false;
      child.stdout.on('data', (b) => tail.push(b));
      child.stderr.on('data', (b) => tail.push(b));
      child.stdin.on('error', () => {}); // the container may exit before reading all input
      const timer = setTimeout(() => {
        timedOut = true;
        execFile(this.o.docker, ['kill', name], { env: this.o.env ?? process.env }, () => {});
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`could not start docker: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code: code ?? (signal ? 128 : -1), timedOut, log: tail.text() });
      });
      if (input) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  // Removes containers left behind by a crash of the dispatcher.
  async cleanup() {
    try {
      const { stdout } = await run(this.o.docker, ['ps', '-aq', '--filter', 'label=adabra-review=1'], { env: this.o.env ?? process.env });
      const ids = stdout.split(/\s+/).filter(Boolean);
      if (ids.length) await run(this.o.docker, ['rm', '-f', ...ids], { env: this.o.env ?? process.env });
      return ids.length;
    } catch {
      return 0;
    }
  }

  // The dispatcher's runTests: fetch exactly job.sha and run the test command on it.
  testRunner(github) {
    return async (job) => {
      await this.ensureDocker(); // throws -> infrastructure error, retried
      let tarball;
      try {
        tarball = await github.downloadTarball(job.sha);
      } catch (err) {
        if (err.code === 'TOO_LARGE') return { state: 'failure', summary: err.message };
        throw err;
      }
      const name = `adabra-review-${job.pr}-${job.sha.slice(0, 12)}-${Date.now()}`;
      const r = await this.exec({
        name,
        script: 'tar -xzf - --strip-components=1 -C /work && exec sh -c "$1"',
        args: [this.o.cmd],
        input: tarball,
      });
      return classify(r, this.o);
    };
  }
}

export function classify(r, o) {
  const mins = Math.round(o.timeoutMs / 60_000);
  if (r.timedOut) return { state: 'failure', summary: `Timed out after ${mins || '<1'} min (\`${o.cmd}\`)`, log: r.log };
  if (r.code === 0) return { state: 'success', summary: `\`${o.cmd}\` passed`, log: r.log };
  if (r.code === 125) throw new Error(`docker could not run the container: ${r.log.slice(-300)}`); // our setup, not the PR
  if (r.code === 137) return { state: 'failure', summary: 'Killed: memory or process limit reached', log: r.log };
  return { state: 'failure', summary: `\`${o.cmd}\` failed (exit ${r.code})`, log: r.log };
}

// Probes run inside the real sandbox. Each line is name=value; the expected value is listed in SELF_CHECK.
const PROBE = `
echo "uid=$(id -u)"
if touch /etc/adabra-probe 2>/dev/null; then echo "rootfs=WRITABLE"; else echo "rootfs=read-only"; fi
if [ -S /var/run/docker.sock ]; then echo "docker_socket=PRESENT"; else echo "docker_socket=absent"; fi
if [ -d /Users ]; then echo "host_files=VISIBLE"; else echo "host_files=absent"; fi
if env | grep -qiE 'token|secret|password|api_key|github|anthropic'; then echo "secrets_in_env=FOUND"; else echo "secrets_in_env=none"; fi
node -e "fetch('https://api.github.com',{signal:AbortSignal.timeout(5000)}).then(()=>console.log('network=OPEN')).catch(()=>console.log('network=blocked'))"
node -e "
const {spawn}=require('child_process');let bad=0;const kids=[];
for(let i=0;i<700;i++){const c=spawn('sleep',['30']);c.on('error',()=>bad++);kids.push(c)}
setTimeout(()=>{console.log('process_limit='+(bad>0?'enforced':'NOT-ENFORCED'));kids.forEach(k=>{try{k.kill('SIGKILL')}catch{}});process.exit(0)},3000)"
`;

export const SELF_CHECK = {
  uid: '1000',
  rootfs: 'read-only',
  docker_socket: 'absent',
  host_files: 'absent',
  secrets_in_env: 'none',
  network: 'blocked',
  process_limit: 'enforced',
};

export async function selfCheck(sandbox) {
  await sandbox.ensureDocker();
  const r = await sandbox.exec({ name: `adabra-review-selfcheck-${Date.now()}`, script: PROBE, timeoutMs: 120_000 });
  const seen = Object.fromEntries(
    r.log.split('\n').map((l) => l.trim().match(/^([a-z_]+)=(\S+)$/)).filter(Boolean).map((m) => [m[1], m[2]]),
  );
  const results = Object.entries(SELF_CHECK).map(([k, want]) => ({ check: k, want, got: seen[k] ?? 'missing', ok: seen[k] === want }));
  const t0 = Date.now();
  const slow = await sandbox.exec({ name: `adabra-review-selfcheck-timeout-${Date.now()}`, script: 'sleep 120', timeoutMs: 3000 });
  results.push({ check: 'time_limit', want: 'killed', got: slow.timedOut ? `killed after ${Math.round((Date.now() - t0) / 1000)}s` : 'ran on', ok: slow.timedOut });
  return { ok: results.every((x) => x.ok), results, log: r.log };
}
