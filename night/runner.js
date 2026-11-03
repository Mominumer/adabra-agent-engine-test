import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { ClaimFile, claimTask, isStopResponse, newRunId, releaseClaim, renewClaim } from '../helper/claims.js';
import { Outbox } from '../helper/outbox.js';
import { flush } from '../helper/sender.js';
import { CONTEXTS } from '../reviewer/dispatcher.js';
import { ReviewGitHub } from '../reviewer/github.js';
import { validateEvent } from '../shared/event.js';
import { readStop } from '../shared/stop.js';
import { APPROVAL_LABEL, TASK_LABEL, beginAttempt, recheckApproval, selectApproval } from './approval.js';
import { CREDENTIAL_ENV, EXPORT_SCRIPT, LABEL, SESSION_USER, removeByLabel, runCommand, sessionArgs, taskInput, tunnelArgs } from './containers.js';
import { tokenReader } from './github-read.js';
import { Ledger } from './ledger.js';
import { PublishHold, publish } from './publish.js';
import { RunRecords } from './records.js';
import { nightContents, reportPath, reportText, writeReport } from './report.js';
import { SessionOutput } from './session-output.js';
import { deviceConfig, readCredential } from './settings.js';
import { MAX_DIFF_BYTES, validateDiff } from './validate.js';
import { finishBy, inStartWindow, nightLabel, nightStart } from './window.js';

// The overnight run, start to finish, and every way it can go wrong. This is the trusted side: it holds the App's key and the device's
// token, and starts a session that holds neither. It takes one text diff back, and treats that and everything else the session says as
// hostile: see validate.js and session-output.js.
//
// One attempt per approval. The ledger is written before the session starts, so a stop, a crash or a refusal all spend it, and nothing
// here ever tries again with the same approval. Before that write nothing has been spent.
//
// Nothing the session wrote reaches a checkpoint, the log or the report. A checkpoint is one of the fixed strings below, and says only
// that the run ended without a PR, never why. Errors are logged as fixed words too, because git's and Docker's messages can quote a path
// from the diff.
export const STEPS = Object.freeze([
  'select', 'claim', 'pin', 'ledger', 'checkpoint', 'containers', 'watch', 'export', 'kill', 'validate', 'final_gate', 'prepare', 'push', 'pull', 'opened', 'close', 'wait',
]);

export const TIMINGS = Object.freeze({
  stopPollMs: 2000,
  approvalEveryMs: 60_000,
  leaseEveryMs: 60_000,
  runMs: 45 * 60_000,
  exportMs: 2 * 60_000,
  tunnelReadyMs: 30_000,
  killRetryMs: 2000,
  holdRetryMs: 60_000,
  onceHoldMs: 30 * 60_000, // how long run-once holds a finished diff when GitHub is down. In the service, it is until the window ends
  checksWaitMs: 30 * 60_000,
  checksPollMs: 60_000,
  tickMs: 30_000,
});

// Public, on the issue. Nothing but these ever goes.
export const CHECKPOINTS = Object.freeze({
  started: Object.freeze({ status: 'Building', summary: 'Overnight run started' }),
  finished: Object.freeze({ status: 'In review', summary: 'Overnight run finished: PR opened' }),
  ended: Object.freeze({ status: 'Blocked', summary: 'Overnight run ended without a PR' }),
  interrupted: Object.freeze({ status: 'Interrupted', summary: 'Overnight run ended without a PR' }),
});

// An approval check saying these means it could not tell, not that the answer is no. The run goes on, and cannot publish until they clear.
const CANNOT_TELL = new Set([
  'github_unreachable', 'github_status', 'reply_not_json', 'reply_shape', 'graphql_errors', 'wrong_issue', 'events_incomplete', 'events_out_of_order',
  'events_too_many', 'timeline_incomplete', 'labels_incomplete', 'edits_incomplete', 'disagree_issue', 'disagree_text', 'disagree_author', 'disagree_labels',
  'disagree_events', 'disagree_actor', 'disagree_edits', 'server_date_missing', 'clock_skew', 'internal_error',
]);

const PARTIAL = new Set(['deadline', 'window_end']); // the time limits: what the session has done so far is kept, and is not published
const SHA_RE = /^[0-9a-f]{40}$/;
const DOCKER_MS = 30_000;
const KILL_MS = 10_000;
const SETTLE_WAIT_MS = 5000;
const CHECK_STATES = new Set(['success', 'failure', 'error', 'pending']);
const GONE_CLAIM_STATUS = new Set([400, 403, 409, 422]);

const sleep = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
const jsonLines = (text) => text.split('\n').flatMap((line) => {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? [v] : [];
  } catch {
    return [];
  }
});

// Ends the run here, with this outcome, whatever step it was on.
class Halt extends Error {
  constructor(outcome, detail = {}) {
    super(outcome);
    this.outcome = outcome;
    this.detail = detail;
  }
}

// Stops an attempt before the approval is spent. `why` is a key of the report's COULD_NOT_START, or `stopped`.
class CouldNotStart extends Error {
  constructor(why) {
    super(why);
    this.why = why;
  }
}

const closingCheckpoint = (outcome) => {
  if (outcome === 'published') return 'finished';
  if (outcome === 'claim_lost') return null; // it is not ours to write on any more
  return outcome === 'stopped' || outcome === 'crashed' || outcome === 'interrupted' ? 'interrupted' : 'ended';
};

export class NightRunner {
  constructor({ settings, env = process.env, readAuth, writeAuth, clock = Date.now, timings = {}, onStep = () => {}, notify = () => {}, log = () => {}, bootTime = () => Date.now() - uptime() * 1000, gitCommand = 'git' }) {
    this.s = settings;
    this.env = env;
    this.readAuth = readAuth;
    this.writeAuth = writeAuth;
    this.clock = clock;
    this.t = { ...TIMINGS, ...timings };
    this.onStep = onStep;
    this.notify = notify;
    this.log = log;
    this.bootTime = bootTime;
    this.gitCommand = gitCommand;
    this.ledger = new Ledger(settings.approval.ledgerPath);
    this.claims = new ClaimFile(settings.agentHome);
    this.outbox = new Outbox(join(settings.agentHome, 'outbox.db'));
    this.records = new RunRecords(settings.nightHome);
    this.github = tokenReader({ auth: readAuth, apiUrl: settings.apiUrl });
    this.source = new ReviewGitHub({ apiUrl: settings.apiUrl, repo: settings.repo, auth: readAuth });
    this.active = null;
    this.swept = false;
    this.lastNote = null;
  }

  close() {
    this.ledger.close();
    this.outbox.close();
  }

  // --- the stop ---

  // The named file, in its own folder, so that a missing file reads as stopped wherever it is.
  stopNow() {
    return readStop({ path: this.s.stopFile, machineDir: dirname(this.s.stopFile) });
  }

  #guardStop() {
    if (this.stopNow().stopped) throw new Halt('stopped');
  }

  async #step(name) {
    await this.onStep(name);
    this.#guardStop();
  }

  // A wait the stop can cut short.
  async #pause(ms) {
    const end = Date.now() + ms;
    for (;;) {
      this.#guardStop();
      const left = end - Date.now();
      if (left <= 0) return;
      await sleep(Math.min(left, this.t.stopPollMs));
    }
  }

  #docker(args, options = {}) {
    return runCommand(this.s.docker, args, { env: this.env, timeoutMs: DOCKER_MS, ...options });
  }

  // --- the claim and its checkpoints, with the helper's own code ---

  #device() {
    return deviceConfig(this.s.agentHome);
  }

  async #flush() {
    try {
      return await flush({ outbox: this.outbox, ...this.#device(), now: this.clock(), log: this.log });
    } catch {
      return {};
    }
  }

  // Written to the outbox first, so it survives anything. The ID comes from the run, so settling twice cannot post twice.
  #queue({ runId, task, generation }, key) {
    const { status, summary } = CHECKPOINTS[key];
    const event = {
      event_id: `${runId}-${key}`,
      task_id: task,
      run_id: runId,
      device_id: this.#device().deviceId,
      claim_generation: generation,
      type: 'checkpoint',
      source_commit: null,
      unpushed_commits: null,
      summary,
      verification: '',
      status,
      next_action: '',
      ts: new Date(this.clock()).toISOString(),
    };
    const errors = validateEvent(event);
    if (errors.length) throw new Error('a checkpoint failed its own check');
    try {
      this.outbox.add(event);
    } catch (err) {
      if (!/UNIQUE/i.test(String(err.message))) throw err;
    }
  }

  // Sends what is queued, and gives back every claim no longer in use. Never while stopped: the coordinator is keeping those leases alive,
  // and a claim is only released once its checkpoints are out. Anything it cannot finish stays for the next pass. A claim it can never
  // release lapses by itself within minutes, because nothing else renews it.
  async settle() {
    if (this.stopNow().stopped) return;
    const sent = await this.#flush();
    if (sent.stopped || this.outbox.counts().pending) return;
    for (const [task, claim] of Object.entries(this.claims.all())) {
      if (this.active?.task === task) continue;
      try {
        const r = await releaseClaim(this.#device(), task, claim.run_id, claim.generation);
        if (r.ok || GONE_CLAIM_STATUS.has(r.status)) this.claims.remove(task);
      } catch {
        // The coordinator did not answer. The lease will lapse if this never succeeds.
      }
    }
  }

  // Renews the lease at the generation this run holds. 'ok', or 'cannot_tell' for as long as the lease could still be good. Anything that
  // means the run must end throws. The coordinator does not fence a push, so what this says at the final gate is the only check there is.
  async #renew(run) {
    let r;
    try {
      r = await renewClaim(this.#device(), run.task, run.runId, run.generation);
    } catch {
      if (this.clock() >= run.leaseUntil) throw new Halt('coordinator_unreachable');
      return 'cannot_tell';
    }
    if (r.ok) {
      if (r.data.generation !== run.generation) throw new Halt('claim_lost');
      if (Number.isFinite(r.data.expires_at)) run.leaseUntil = r.data.expires_at;
      return 'ok';
    }
    if (isStopResponse(r)) throw new Halt('stopped');
    if (GONE_CLAIM_STATUS.has(r.status)) throw new Halt('claim_lost');
    if (this.clock() >= run.leaseUntil) throw new Halt('coordinator_unreachable');
    return 'cannot_tell';
  }

  // --- before a run ---

  async #sweepContainers() {
    const info = await this.#docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
    if (info.code !== 0) return false;
    await removeByLabel({ docker: this.s.docker, env: this.env, label: LABEL });
    this.swept = true;
    return true;
  }

  // On every start: nothing from an earlier process may still be running, and any attempt it left open is closed here. The approval stays
  // spent. Whether the machine restarted since says which it was, because a restart takes the session's memory-only disks with it.
  async sweep() {
    await this.#sweepContainers();
    for (const row of this.ledger.unfinished()) {
      const outcome = row.started_at < this.bootTime() ? 'interrupted' : 'crashed';
      const record = this.records.read(row.run_id) ?? {
        runId: row.run_id, task: row.task, issue: row.issue, eventId: row.event_id, actorId: row.actor_id, labeledAt: row.labeled_at, textSha256: row.text_sha256, startedAt: row.started_at,
      };
      Object.assign(record, { outcome, finishedAt: this.clock() });
      this.records.write(record);
      const claim = this.claims.get(row.task);
      if (claim?.run_id === row.run_id) {
        this.#queue({ runId: row.run_id, task: row.task, generation: claim.generation }, record.pull > 0 ? 'finished' : closingCheckpoint(outcome));
      }
      this.ledger.finish(row.event_id, outcome, this.clock());
    }
    rmSync(join(this.s.nightHome, 'tmp'), { recursive: true, force: true });
    this.records.prune(this.clock());
    await this.settle();
  }

  // Null if a run may start now, or the word for why not. Nothing here spends anything.
  async ready() {
    if (this.stopNow().stopped) return 'stopped';
    if (!this.swept && !(await this.#sweepContainers())) return 'docker_down';
    const info = await this.#docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20_000 });
    if (info.code !== 0) return 'docker_down';
    const image = await this.#docker(['image', 'inspect', this.s.image, '--format', '{{.Id}}']);
    if (image.code !== 0 || image.stdout.trim() !== this.s.imageId) return 'image_wrong';
    const reviews = await this.#docker(['ps', '-q', '--filter', 'label=adabra-review=1', '--filter', 'status=running']);
    if (reviews.code !== 0 || reviews.stdout.trim() !== '') return 'review_running';
    try {
      const res = await fetch(`${this.#device().url.replace(/\/$/, '')}/healthz`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return 'coordinator_down';
      if ((await res.json().catch(() => ({}))).stopped) return 'stopped';
    } catch {
      return 'coordinator_down';
    }
    if (!readCredential(this.s.credentialFile)) return 'credential_missing';
    if (this.ledger.unfinished().length) return 'unsettled';
    return null;
  }

  // Issue numbers that might be approved, lowest first. Only the numbers are read: selection does the checking.
  async candidates() {
    const reply = await this.github.get(`/repos/${this.s.repo}/issues?state=open&labels=${TASK_LABEL},${APPROVAL_LABEL}&per_page=100&sort=created&direction=asc`);
    if (reply.status !== 200) throw new Error('could not list issues');
    const issues = JSON.parse(reply.text);
    if (!Array.isArray(issues)) throw new Error('could not list issues');
    const numbers = issues.filter((i) => i?.pull_request === undefined && Number.isSafeInteger(i?.number) && i.number > 0).map((i) => i.number);
    return [...new Set(numbers)].sort((a, b) => a - b);
  }

  async #mainCommit() {
    const reply = await this.github.get(`/repos/${this.s.repo}/commits/main`);
    if (reply.status !== 200) throw new CouldNotStart('github_down');
    let sha;
    try {
      ({ sha } = JSON.parse(reply.text));
    } catch {
      throw new CouldNotStart('github_down');
    }
    if (!SHA_RE.test(String(sha))) throw new CouldNotStart('github_down');
    return sha;
  }

  // How many more runs tonight allows. Every attempt counts, however it ended.
  runsLeftTonight() {
    return this.s.runsPerNight - this.ledger.startedSince(nightStart(this.clock())).length;
  }

  // --- one attempt ---

  // Resolves { started: false, why, reasons? } when nothing was spent, or { started: true, outcome, record }.
  async attempt(number, { once = false } = {}) {
    const runId = newRunId();
    let run;
    let held = false;
    try {
      await this.#step('select');
      const { report, pin } = await selectApproval({ github: this.github, settings: this.s.approval, number, ledger: this.ledger, clock: this.clock });
      if (!pin) return { started: false, why: 'not_approved', reasons: report.reasons };

      await this.#step('claim');
      let claimed;
      try {
        claimed = await claimTask(this.#device(), pin.task, runId);
      } catch {
        throw new CouldNotStart('coordinator_down');
      }
      if (isStopResponse(claimed)) throw new Halt('stopped');
      if (!claimed.ok) return { started: false, why: 'claim_refused' };
      const { generation, expires_at: leaseUntil } = claimed.data;
      this.claims.set(pin.task, { run_id: runId, generation, expires_at: leaseUntil });
      held = true;

      await this.#step('pin');
      const baseCommit = await this.#mainCommit();
      let tarball;
      try {
        tarball = await this.source.downloadTarball(baseCommit);
      } catch {
        throw new CouldNotStart('github_down');
      }

      await this.#step('ledger');
      const attempt = beginAttempt({ ledger: this.ledger, pin, runId, clock: this.clock });
      const startedAt = this.clock();
      run = {
        runId, pin, attempt, baseCommit, tarball, once, startedAt, generation, leaseUntil,
        task: pin.task,
        names: { session: `adabra-night-${runId}`, tunnel: `adabra-night-tunnel-${runId}`, volume: `adabra-night-sock-${runId}` },
        runLabel: `adabra-night-run=${runId}`,
        containers: false,
        record: {
          runId, task: pin.task, issue: pin.issue, eventId: pin.eventId, actorId: pin.actorId, labeledAt: pin.labeledAt, textSha256: pin.textSha256,
          baseCommit, generation, once, startedAt, finishedAt: null, outcome: null,
        },
      };
    } catch (err) {
      const why = err instanceof Halt ? 'stopped' : err instanceof CouldNotStart ? err.why : 'internal_error';
      this.#noteCouldNotStart(why);
      if (held) await this.settle();
      return { started: false, why };
    }

    this.active = run;
    this.records.write(run.record);
    let end;
    try {
      end = await this.#execute(run);
    } catch (err) {
      if (err instanceof Halt) {
        end = { outcome: err.outcome, ...err.detail };
      } else {
        this.log('a run hit an error of the runner\'s own');
        end = { outcome: 'internal_error' };
      }
    }
    return this.#conclude(run, end);
  }

  async #execute(run) {
    await this.#step('checkpoint');
    this.#queue(run, 'started');
    await this.#flush();

    await this.#step('containers');
    await this.#startContainers(run);
    run.watcher = this.#watch(run);

    await this.#step('watch');
    const first = await Promise.race([run.session.ended, run.watcher.halted]);
    if (run.watcher.outcome) await this.#haltedSession(run);
    if (first.closed) throw new Halt('session_failed');

    await this.#step('export');
    const exported = await this.#exportDiff(run);
    if (run.watcher.outcome) await this.#haltedSession(run, exported);

    await this.#step('kill');
    await this.#endContainers(run);
    run.watcher.stop();

    if (exported.overflow) throw new Halt('diff_refused', { rule: 'too_large' });
    if (exported.code !== 0) throw new Halt('session_failed');
    const said = run.output.failure();
    if (said) throw new Halt('session_reported_failure', { failureWord: said, savedDiff: this.#keep(run, exported.stdout) });

    await this.#step('validate');
    const validated = validateDiff(exported.stdout);
    if (!validated.ok) {
      if (validated.rule === 'no_changes') throw new Halt('no_changes');
      throw new Halt('diff_refused', { rule: validated.rule, ruleFile: validated.file, ruleWord: validated.word, savedDiff: this.#keep(run, exported.stdout) });
    }

    await this.#step('final_gate');
    return this.#publishWhileHeld(run, exported.stdout, validated);
  }

  // The session is being ended from outside. The time limits keep what it did so far. Nothing else waits for anything.
  async #haltedSession(run, alreadyExported = null) {
    const { outcome } = run.watcher;
    if (!PARTIAL.has(outcome)) throw new Halt(outcome);
    const exported = alreadyExported ?? await this.#exportDiff(run);
    if (!PARTIAL.has(run.watcher.outcome)) throw new Halt(run.watcher.outcome);
    throw new Halt(outcome, { savedDiff: exported.code === 0 && !exported.overflow && this.#keep(run, exported.stdout) });
  }

  #keep(run, bytes) {
    if (!bytes.length) return false;
    this.records.saveDiff(run.runId, bytes);
    return true;
  }

  async #startContainers(run) {
    const { session, tunnel, volume } = run.names;
    const labels = [LABEL, run.runLabel];
    run.containers = true;
    const made = await this.#docker(['volume', 'create', ...labels.flatMap((l) => ['--label', l]), volume]);
    if (made.code !== 0) throw new Halt('session_failed');
    const up = await this.#docker(tunnelArgs({ name: tunnel, image: this.s.imageId, volume, network: this.s.tunnelNetwork, labels }));
    if (up.code !== 0) throw new Halt('session_failed');
    const deadline = Date.now() + this.t.tunnelReadyMs;
    while (!(await this.#docker(['logs', tunnel])).stdout.includes('"listening"')) {
      if (Date.now() > deadline) throw new Halt('session_failed');
      this.#guardStop();
      await sleep(Math.min(100, this.t.stopPollMs));
    }
    const credential = readCredential(this.s.credentialFile);
    if (!credential) throw new Halt('session_failed');

    // The credential goes by name to this one process. It is in no argument, and no other docker call has it in its environment.
    const child = spawn(this.s.docker, sessionArgs({ name: session, image: this.s.imageId, volume, labels }), { env: { ...this.env, [CREDENTIAL_ENV]: credential }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = new SessionOutput({ now: this.clock });
    const sink = this.records.outputSink(run.runId);
    let finish;
    const ended = new Promise((resolve) => {
      finish = resolve;
    });
    const closed = new Promise((resolve) => {
      child.on('close', () => {
        sink.close();
        finish({ closed: true });
        resolve();
      });
      child.on('error', () => {
        finish({ closed: true });
        resolve();
      });
    });
    child.stdout.on('data', (d) => {
      output.stdout(d);
      sink.write(d);
    });
    child.stderr.on('data', (d) => {
      output.stderr(d);
      sink.write(d);
      if (output.cliExit !== null) finish({ closed: false });
    });
    child.stdin.on('error', () => {});
    const text = run.pin.text;
    child.stdin.end(taskInput({ taskText: `# ${text.title}\n\n${text.body}\n`, sourceTarball: run.tarball }));
    run.output = output;
    run.session = { ended, closed };
    run.tarball = null;
  }

  // Three things watch a running session, none of which can hold up the others: the stop and the clock, the approval, and the lease.
  #watch(run) {
    let resolveHalt;
    const timers = new Set();
    const w = {
      outcome: null,
      stopped: false,
      halted: new Promise((resolve) => {
        resolveHalt = resolve;
      }),
      stop: () => {
        w.stopped = true;
        for (const t of timers) clearTimeout(t);
      },
    };
    const kill = () => void this.#docker(['kill', run.names.session], { timeoutMs: KILL_MS });
    const halt = (outcome) => {
      if (w.outcome === null) {
        w.outcome = outcome;
        if (!PARTIAL.has(outcome)) kill();
        resolveHalt({ halt: outcome });
      } else if (outcome === 'stopped' && PARTIAL.has(w.outcome)) {
        w.outcome = outcome; // a stop waits for nothing, not even an export that has already begun
        kill();
      }
    };
    const repeat = (ms, fn) => {
      let timer;
      const pass = async () => {
        timers.delete(timer);
        try {
          await fn();
        } catch {
          // The next pass tries again. Only a stated answer ends a run.
        }
        if (w.stopped) return;
        timer = setTimeout(pass, ms);
        timers.add(timer);
      };
      timer = setTimeout(pass, ms);
      timers.add(timer);
    };

    const runEnd = run.startedAt + this.t.runMs;
    const windowEnd = run.once ? Infinity : finishBy(run.startedAt);
    repeat(this.t.stopPollMs, () => {
      if (this.stopNow().stopped) halt('stopped');
      else if (this.clock() >= windowEnd) halt('window_end');
      else if (this.clock() >= runEnd) halt('deadline');
    });
    repeat(this.t.approvalEveryMs, async () => {
      const report = await recheckApproval({ github: this.github, settings: this.s.approval, number: run.pin.issue, ledger: this.ledger, attempt: run.attempt, clock: this.clock });
      if (!report.approved && !report.reasons.every((r) => CANNOT_TELL.has(r))) halt('approval_withdrawn');
    });
    repeat(this.t.leaseEveryMs, async () => {
      try {
        await this.#renew(run);
      } catch (err) {
        if (err instanceof Halt) halt(err.outcome);
      }
    });
    return w;
  }

  // Its stdout is the diff and is capped as it comes in, so a session cannot fill this process's memory with it.
  #exportDiff(run) {
    return new Promise((resolve) => {
      const child = spawn(this.s.docker, ['exec', '--user', SESSION_USER, run.names.session, EXPORT_SCRIPT], { env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
      const parts = [];
      let size = 0;
      let overflow = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), this.t.exportMs);
      child.stdout.on('data', (d) => {
        if (overflow) return;
        size += d.length;
        if (size > MAX_DIFF_BYTES) {
          overflow = true;
          parts.length = 0;
          child.kill('SIGKILL');
        } else {
          parts.push(d);
        }
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({ code: -1, overflow, stdout: Buffer.alloc(0) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, overflow, stdout: Buffer.concat(parts) });
      });
    });
  }

  // Ends both containers and does not give up. If Docker does not confirm, this says so loudly and keeps trying every two seconds. The
  // tunnel's own count of what it refused is read first: the session had no way to touch that.
  async #endContainers(run) {
    if (!run.containers) return;
    const { session, tunnel } = run.names;
    await this.#docker(['kill', session], { timeoutMs: KILL_MS });
    const logged = await this.#docker(['logs', tunnel], { timeoutMs: KILL_MS });
    const lines = jsonLines(logged.stdout);
    run.record.tunnel = { refused: lines.filter((l) => l.event === 'refuse').length, allowed: lines.filter((l) => l.event === 'allow').length };
    for (let tries = 0; ; tries++) {
      await this.#docker(['kill', session, tunnel], { timeoutMs: KILL_MS });
      const left = await this.#docker(['ps', '-q', '--filter', `label=${run.runLabel}`, '--filter', 'status=running'], { timeoutMs: KILL_MS });
      if (left.code === 0 && left.stdout.trim() === '') break;
      if (tries === 0) {
        run.record.stopNotConfirmed = true;
        this.records.write(run.record);
        this.log('STOP NOT CONFIRMED: Docker has not confirmed the session is dead. Trying again every 2 seconds. The last resort is quitting Docker Desktop');
        this.notify('Adabra overnight runner', 'STOP NOT CONFIRMED: check docker ps');
      }
      await sleep(this.t.killRetryMs);
    }
    await removeByLabel({ docker: this.s.docker, env: this.env, label: run.runLabel });
    run.containers = false;
    if (run.session) await Promise.race([run.session.closed, sleep(SETTLE_WAIT_MS)]);
  }

  // --- publishing ---

  // Not stopped, the lease renews at this generation, the approval is unchanged, the issue is open. 'go', or 'hold' if something cannot be
  // read right now. Anything that says no ends the run.
  async #finalGate(run) {
    this.#guardStop();
    const lease = await this.#renew(run);
    run.leaseUnknown = lease !== 'ok';
    const report = await recheckApproval({ github: this.github, settings: this.s.approval, number: run.pin.issue, ledger: this.ledger, attempt: run.attempt, clock: this.clock });
    if (!report.approved && !report.reasons.every((r) => CANNOT_TELL.has(r))) throw new Halt('approval_withdrawn');
    return report.approved && lease === 'ok' ? 'go' : 'hold';
  }

  // While GitHub or the coordinator is down the finished diff waits, with the claim held, until the window ends or the lease lapses.
  async #publishWhileHeld(run, diff, validated) {
    const holdUntil = run.once ? this.clock() + this.t.onceHoldMs : finishBy(run.startedAt);
    let saved = false;
    for (;;) {
      if (await this.#finalGate(run) === 'go') {
        const p = await publish({
          diff, validated, baseCommit: run.baseCommit, task: run.task, runId: run.runId, textSha256: run.pin.textSha256, repo: this.s.repo, gitUrl: this.s.gitUrl, apiUrl: this.s.apiUrl,
          auth: this.writeAuth, dateMs: run.startedAt, tempRoot: join(this.s.nightHome, 'tmp'), gitCommand: this.gitCommand, path: this.env.PATH,
          gate: (stage) => this.#publishGate(run, stage),
          onPushed: ({ branch, commit }) => {
            Object.assign(run.record, { pushed: true, branch, commit });
            this.records.write(run.record);
          },
        });
        if (p.state === 'published') {
          const { branch, commit, pull, url, reviewDecision, flagged } = p;
          Object.assign(run.record, { branch, commit, pull, url, reviewDecision, flagged, totals: validated.totals });
          this.records.write(run.record);
          await this.onStep('opened');
          return { outcome: 'published' };
        }
        if (p.state === 'refused') throw new Halt('diff_refused', { rule: p.rule, ruleFile: p.file, ruleWord: p.word, savedDiff: saved || this.#keep(run, diff) });
        if (p.state === 'pushed_no_pr') throw new Halt('pushed_no_pr', { branch: p.branch, commit: p.commit, flagged: p.flagged, savedDiff: saved || this.#keep(run, diff) });
      }
      saved = saved || this.#keep(run, diff);
      run.record.savedDiff = true;
      this.records.write(run.record);
      if (this.clock() >= holdUntil) throw new Halt(run.leaseUnknown ? 'coordinator_unreachable' : 'github_unreachable', { savedDiff: true });
      await this.#pause(this.t.holdRetryMs);
    }
  }

  async #publishGate(run, stage) {
    await this.#step(stage);
    if (stage === 'push' && await this.#renew(run) !== 'ok') throw new PublishHold();
  }

  // --- the end of a run ---

  // Containers first, so nothing is left running whatever happens below. Then the record, the checkpoint and the ledger, in that order,
  // so a crash anywhere in here is settled by the next start with the facts on disk.
  async #conclude(run, end) {
    run.watcher?.stop();
    await this.#endContainers(run);
    if (run.output) run.record.session = run.output.snapshot();
    Object.assign(run.record, end, { finishedAt: this.clock() });
    this.records.write(run.record);
    const closing = closingCheckpoint(end.outcome);
    if (closing) this.#queue(run, closing);
    else this.claims.remove(run.task);
    this.ledger.finish(run.attempt.eventId, end.outcome, this.clock());
    this.active = null;
    await this.onStep('close');
    await this.settle();
    if (end.outcome === 'published') await this.#waitForChecks(run);
    return { started: true, outcome: end.outcome, record: run.record };
  }

  async #checkStates(commit) {
    const states = { tests: 'unknown', review: 'unknown' };
    try {
      const reply = await this.github.get(`/repos/${this.s.repo}/commits/${commit}/status`);
      if (reply.status !== 200) return states;
      const statuses = JSON.parse(reply.text)?.statuses;
      if (!Array.isArray(statuses)) return states;
      for (const [key, context] of Object.entries(CONTEXTS)) {
        const found = statuses.find((s) => s?.context === context);
        states[key] = found ? (CHECK_STATES.has(found.state) ? found.state : 'unknown') : 'none';
      }
    } catch {
      // Unknown is an answer the report can give. The publishing App has no statuses permission: on a private repository this is what it sees.
    }
    return states;
  }

  // Only to tell the report. The claim has gone by now and nothing else rests on this.
  async #waitForChecks(run) {
    await this.onStep('wait');
    const until = this.clock() + this.t.checksWaitMs;
    for (;;) {
      run.record.checks = await this.#checkStates(run.record.commit);
      this.records.write(run.record);
      const open = Object.values(run.record.checks).some((s) => s === 'pending' || s === 'none');
      if (!open || this.clock() >= until || this.stopNow().stopped) return;
      await sleep(this.t.checksPollMs);
    }
  }

  // --- the service ---

  #noteCouldNotStart(why) {
    this.records.note({ at: this.clock(), why });
    this.lastNote = why;
  }

  // Once for each change of reason, so a night with Docker down leaves one line and not hundreds.
  #noteOnce(why) {
    if (why !== this.lastNote) this.#noteCouldNotStart(why);
  }

  writeReport(now = this.clock()) {
    const label = nightLabel(now);
    const { records, notes } = nightContents({ records: this.records.all(), notes: this.records.notes(), now });
    const text = reportText({ label, records, notes });
    return { path: writeReport({ dir: this.s.reportDir, label, text }), text, records, notes };
  }

  // Unattended only: the operator's word that main requires their review is not enough once there is evidence. If GitHub did not say a
  // review was required on the last PR this runner opened, nothing more is published with nobody watching. A later supervised run that
  // shows it clears this.
  lastReviewDecisionBad() {
    const last = this.records.all().filter((r) => r.pull > 0).at(-1);
    return Boolean(last) && last.reviewDecision !== 'REVIEW_REQUIRED';
  }

  // One pass of the service. Starts at most one run, and only ever inside the window.
  async tick() {
    await this.settle();
    const now = this.clock();
    this.#reportIfDue(now);
    if (this.stopNow().stopped || !inStartWindow(now)) return null;
    if (this.runsLeftTonight() <= 0) return null;
    const tonight = nightContents({ records: this.records.all(), notes: [], now }).records;
    if (tonight.some((r) => r.outcome !== 'published' || r.checks?.tests !== 'success' || r.checks?.review !== 'success')) return null; // anything but two greens ends the night
    if (this.lastReviewDecisionBad()) {
      this.#noteOnce('review_not_required');
      return null;
    }
    const why = await this.ready();
    if (why) {
      this.#noteOnce(why);
      return null;
    }
    let numbers;
    try {
      numbers = await this.candidates();
    } catch {
      this.#noteOnce('github_down');
      return null;
    }
    for (const number of numbers) {
      const result = await this.attempt(number);
      if (result.started) return result;
      if (result.why === 'stopped' || result.why === 'coordinator_down' || result.why === 'github_down' || result.why === 'internal_error') return result;
    }
    return null;
  }

  // After the window ends, if the night holds anything to say. A night with nothing to report stays quiet.
  #reportIfDue(now) {
    if (now <= finishBy(nightStart(now))) return;
    const label = nightLabel(now);
    if (existsSync(reportPath(this.s.reportDir, label))) return;
    const { records, notes } = nightContents({ records: this.records.all(), notes: this.records.notes(), now });
    if (!records.length && !notes.length) return;
    this.writeReport(now);
    this.notify('Adabra overnight runner', 'The morning report is ready: node night/main.js report');
  }

  // Runs until told to stop. A stop in force only makes the passes do nothing.
  async serve({ signal }) {
    await this.sweep();
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch {
        this.log('a pass of the service failed, and will be tried again');
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.t.tickMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }

  // The service was told to stop, in the middle of a run. Whatever is running goes now. The next start settles the rest.
  async abort() {
    if (this.active?.containers) await this.#docker(['kill', this.active.names.session, this.active.names.tunnel], { timeoutMs: KILL_MS });
  }
}
