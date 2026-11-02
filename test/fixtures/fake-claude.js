#!/usr/bin/env node
// Stands in for the claude CLI in tests. It calls nothing and costs nothing: it prints what its control file says.
// FAKE_CLAUDE_CONTROL is a JSON file, read on every run, so a test can change the answer between runs:
//   stdout     printed exactly as given, instead of a result
//   result     fields laid over a valid passing result for the commit named in the prompt
//   output     replaces structured_output in that result
//   drop       fields to take out of that result
//   stderr     printed to stderr
//   exit       exit code (default 0)
//   sleepMs    wait this long first
//   flood      print this many bytes instead of a result
//   killSelf   die by SIGKILL
// FAKE_CLAUDE_RECORD is a file that gets one JSON line per run: its arguments, directory and environment.
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('0.0.0 (fake)');
  process.exit(0);
}
if (!args.includes('-p')) process.exit(0);

const control = process.env.FAKE_CLAUDE_CONTROL ? JSON.parse(readFileSync(process.env.FAKE_CLAUDE_CONTROL, 'utf8')) : {};
const sha = args.at(-1).match(/Review commit ([0-9a-f]{40})/)?.[1] ?? null;

if (process.env.FAKE_CLAUDE_RECORD) {
  appendFileSync(process.env.FAKE_CLAUDE_RECORD, `${JSON.stringify({
    args,
    cwd: process.cwd(),
    env: Object.keys(process.env).filter((k) => !k.startsWith('FAKE_CLAUDE_')).sort(),
    credential: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    home: process.env.HOME ?? null,
    sha,
  })}\n`);
}

function result() {
  const r = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'free text from the model',
    permission_denials: [],
    total_cost_usd: 0.25,
    num_turns: 4,
    duration_ms: 1234,
    modelUsage: { 'claude-sonnet-5-5': { inputTokens: 10, outputTokens: 5 } },
    structured_output: control.output ?? { verdict: 'pass', sha, findings: [] },
    ...control.result,
  };
  for (const key of control.drop ?? []) delete r[key];
  return JSON.stringify(r);
}

const finish = () => {
  if (control.killSelf) process.kill(process.pid, 'SIGKILL');
  if (control.stderr) process.stderr.write(control.stderr);
  const out = control.flood ? 'x'.repeat(control.flood) : (control.stdout ?? result());
  process.stdout.write(out, () => process.exit(control.exit ?? 0));
};

if (control.sleepMs) setTimeout(finish, control.sleepMs);
else finish();
