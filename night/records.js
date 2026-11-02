import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// What the runner keeps about each run, local only, in a private folder. The ledger says whether an approval is spent, and this says the
// rest. A run's record holds fixed words, IDs, hashes and counts, never model text. Beside it, the session's raw output and any saved
// diff are hostile text, of mode 600, and are never read back by anything here. Together a run keeps at most KEPT_OUTPUT_BYTES of raw
// output, and everything older than KEEP_MS goes.
export const KEPT_OUTPUT_BYTES = 50 * 1024 * 1024;
export const KEEP_MS = 14 * 24 * 60 * 60_000;
const RUN_RE = /^[A-Za-z0-9_-]{1,64}$/;

const checkRun = (runId) => {
  if (!RUN_RE.test(String(runId))) throw new Error('that is not a run ID');
  return runId;
};

export class RunRecords {
  constructor(home) {
    this.dir = join(home, 'runs');
    this.notesFile = join(home, 'notes.jsonl');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(home, 0o700);
    chmodSync(this.dir, 0o700);
  }

  recordPath = (runId) => join(this.dir, `${checkRun(runId)}.json`);
  diffPath = (runId) => join(this.dir, `${checkRun(runId)}.diff`);
  outputPath = (runId) => join(this.dir, `${checkRun(runId)}.output`);

  // Whole or not at all.
  write(record) {
    const path = this.recordPath(record.runId);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  }

  read(runId) {
    try {
      return JSON.parse(readFileSync(this.recordPath(runId), 'utf8'));
    } catch {
      return null;
    }
  }

  all() {
    const runs = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        runs.push(JSON.parse(readFileSync(join(this.dir, name), 'utf8')));
      } catch {
        // A record that cannot be read is left alone. The ledger still has the attempt.
      }
    }
    return runs.sort((a, b) => a.startedAt - b.startedAt);
  }

  saveDiff(runId, bytes) {
    const path = this.diffPath(runId);
    rmSync(path, { force: true });
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    return path;
  }

  // Appends the session's raw output until it reaches the limit, then drops the rest.
  outputSink(runId, limit = KEPT_OUTPUT_BYTES) {
    const fd = openSync(this.outputPath(runId), 'a', 0o600);
    let kept = 0;
    return {
      write: (chunk) => {
        if (kept >= limit) return;
        const piece = chunk.subarray(0, limit - kept);
        writeSync(fd, piece);
        kept += piece.length;
      },
      close: () => closeSync(fd),
    };
  }

  // A fact with no run of its own: why nothing could start. Fixed words only.
  note(entry) {
    appendFileSync(this.notesFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  notes() {
    if (!existsSync(this.notesFile)) return [];
    return readFileSync(this.notesFile, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  }

  prune(now, keepMs = KEEP_MS) {
    for (const name of readdirSync(this.dir)) {
      const path = join(this.dir, name);
      try {
        if (now - statSync(path).mtimeMs > keepMs) rmSync(path, { force: true });
      } catch {
        // Gone already.
      }
    }
    const recent = this.notes().filter((n) => now - n.at <= keepMs);
    if (existsSync(this.notesFile)) writeFileSync(this.notesFile, recent.map((n) => `${JSON.stringify(n)}\n`).join(''), { mode: 0o600 });
  }
}
