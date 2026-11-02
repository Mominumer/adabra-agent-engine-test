import { classifyText } from '../reviewer/review-output.js';

// Reads what a session printed, as it prints it. All of this is controlled by the session: it has a shell, and the same stdout and stderr
// the CLI has. So every value here can be forged, and nothing here earns anything.
//
// A claim of failure can only take a pull request away. That is why it may be believed: forging one loses the session its own run. It
// gives no retry, since the approval is already spent, does not pause reviews, and does not touch tonight's limit. A claim of success is
// never enough, because the diff is judged on its own. The turn and cost numbers go in the local report, marked as the session's own, and
// no limit or decision reads them. The limits that hold come from outside: the deadline, docker kill and one run a night.
//
// Only numbers and fixed words leave this file. Text is looked at to choose a word, and is then dropped.
export const FAILURE_WORDS = Object.freeze(['turn_limit', 'budget_limit', 'account_limit', 'credential', 'cli_error', 'blocked', 'cli_exit', 'no_result', 'no_done']);

const MAX_LINE_BYTES = 1024 * 1024;
const MAX_NUMBER = 1_000_000_000;
const ENTRY_LINE = /^entry: cli exited (\d{1,3})$/;

const clamp = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_NUMBER) : 0);

// Splits a stream into lines without holding more than one line, and without holding a long one at all.
function lineSplitter(onLine, onLong) {
  let parts = [];
  let size = 0;
  let skipping = false;
  return (chunk) => {
    let at = 0;
    while (at < chunk.length) {
      const nl = chunk.indexOf(10, at);
      const piece = chunk.subarray(at, nl < 0 ? chunk.length : nl);
      if (!skipping) {
        size += piece.length;
        if (size > MAX_LINE_BYTES) {
          skipping = true;
          parts = [];
          onLong();
        } else {
          parts.push(piece);
        }
      }
      if (nl < 0) return;
      if (!skipping) onLine(Buffer.concat(parts).toString('utf8'));
      parts = [];
      size = 0;
      skipping = false;
      at = nl + 1;
    }
  };
}

export class SessionOutput {
  #failure = null;
  #saidDone = false;
  #results = 0;
  #unparsed = 0;
  #denials = 0;
  #turns = 0;
  #cost = 0;
  #cliExit = null;
  #now;
  stdout;
  stderr;

  constructor({ now = Date.now } = {}) {
    this.#now = now;
    this.stdout = lineSplitter((l) => this.#outLine(l), () => this.#unparsed++);
    this.stderr = lineSplitter((l) => this.#errLine(l), () => {});
  }

  #outLine(text) {
    if (!text.trim()) return;
    let line;
    try {
      line = JSON.parse(text);
    } catch {
      this.#unparsed++;
      return;
    }
    if (line?.type === 'result' && typeof line === 'object') this.#result(line);
  }

  #errLine(text) {
    const m = ENTRY_LINE.exec(text);
    if (m && this.#cliExit === null) this.#cliExit = Number(m[1]);
  }

  #result(line) {
    this.#results++;
    this.#denials = Math.max(this.#denials, Array.isArray(line.permission_denials) ? line.permission_denials.length : 0);
    this.#turns = clamp(line.num_turns);
    this.#cost = clamp(line.total_cost_usd);
    if (line.is_error === true || (typeof line.subtype === 'string' && line.subtype !== 'success')) {
      this.#failure ??= this.#errorWord(line);
      return;
    }
    // Forgiving about emphasis and a full stop: this only ever keeps a pull request back, and an honest session should not lose one to them.
    const last = (typeof line.result === 'string' ? line.result : '').trimEnd().split('\n').at(-1).replace(/[*_`.\s]/g, '').toLowerCase();
    if (last === 'blocked') this.#failure ??= 'blocked';
    if (last === 'done') this.#saidDone = true;
  }

  #errorWord(line) {
    if (line.subtype === 'error_max_turns') return 'turn_limit';
    if (line.subtype === 'error_max_budget_usd') return 'budget_limit';
    const status = Number.isInteger(line.api_error_status) ? line.api_error_status : null;
    const seen = classifyText(JSON.stringify(line).slice(0, 8192), status, this.#now())?.class;
    if (seen === 'limit') return 'account_limit';
    return seen === 'auth' ? 'credential' : 'cli_error';
  }

  // The exit code the entry script printed, or null. Also forgeable: printing it early only ends the session's own run sooner.
  get cliExit() {
    return this.#cliExit;
  }

  // Why the session's own output rules out a pull request, or null if it doesn't. Null is not a reason to publish: only the diff's checks
  // and the final gates are.
  failure() {
    if (this.#failure) return this.#failure;
    if (this.#cliExit !== 0) return 'cli_exit';
    if (!this.#results) return 'no_result';
    return this.#saidDone ? null : 'no_done';
  }

  // For the local report. Numbers only.
  snapshot() {
    return Object.freeze({ results: this.#results, unparsed: this.#unparsed, denials: this.#denials, turns: this.#turns, costUsd: this.#cost });
  }
}
