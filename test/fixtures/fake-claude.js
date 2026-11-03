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
//   answers    { <commit>: structured_output }, for a test answering many commits from one file
// A sha of FROM-PROMPT in an answer becomes the commit named in the prompt, for a test that cannot know it in advance.
// With --output-format stream-json it prints lines, as the real one does: the init line, what the model said, then the result.
//   init       fields laid over the init line
//   noInit     leave the init line out
//   text       what the model says
//   lines      more lines (objects) to print before the result
//   reads      which parts of diff.patch the review reads, as [[first line, how many]], where the real one's Read would report them. Default: all of it
//   loaded    a file in the job, whose text the model repeats with no tool having given it: as if the CLI had loaded it as configuration
//   readAsData the same, but after a tool result gave it to the model
//   copyPlanted answers with the review.json the PR planted in its tree
//   obey       plays a review whose limits have all failed. It does what the job's pr.json asks, as far as this user's permissions go: reads
//              the paths listed there into a finding, fetches the URLs there, runs the hooks and server in ./.claude/settings.json and ./.mcp.json
// FAKE_CLAUDE_RECORD is a file that gets one JSON line per run: its arguments, directory and environment.
import { execSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    files: readdirSync('.', { recursive: true }).sort(),
  })}\n`);
}

const streaming = args[args.indexOf('--output-format') + 1] === 'stream-json';
let obeyed = null;

// Everything here is against the test's own temp files and listener: there is still nothing to call.
async function obey() {
  const pr = JSON.parse(readFileSync('pr.json', 'utf8'));
  const stolen = [];
  for (const [, path] of pr.body.matchAll(/^- (\S+)$/gm)) {
    try {
      stolen.push(readFileSync(path, 'utf8').trim());
    } catch {
      stolen.push(`could not read ${path}`);
    }
  }
  if (existsSync('.claude/settings.json')) {
    const { hooks } = JSON.parse(readFileSync('.claude/settings.json', 'utf8'));
    execSync(hooks.SessionStart[0].hooks[0].command);
  }
  if (existsSync('.mcp.json')) {
    const server = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers['adabra-live-command'];
    spawnSync(server.command, server.args);
  }
  for (const [url] of pr.body.matchAll(/http:\/\/127\.0\.0\.1:\d+\/(?=\s)/g)) await fetch(url).catch(() => {});
  obeyed = {
    verdict: 'pass',
    sha,
    findings: [{ file: null, line: null, severity: 'minor', message: stolen.join(' ').slice(0, 500) }],
  };
}

const withSha = (answer) => (answer?.sha === 'FROM-PROMPT' ? { ...answer, sha } : answer);

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
    structured_output: obeyed ?? withSha(control.answers?.[sha] ?? control.output) ?? { verdict: 'pass', sha, findings: [] },
    ...control.result,
  };
  for (const key of control.drop ?? []) delete r[key];
  return JSON.stringify(r);
}

function streamed() {
  const init = {
    type: 'system', subtype: 'init', cwd: process.cwd(), session_id: 'fake', model: 'claude-sonnet-5-5', permissionMode: 'dontAsk',
    tools: ['Read', 'Grep', 'Glob', 'StructuredOutput'], mcp_servers: [], ...control.init,
  };
  const inJob = (name) => (name && existsSync(name) ? readFileSync(name, 'utf8') : '');
  const said = { type: 'assistant', message: { content: [{ type: 'text', text: `${control.text ?? 'free text from the model'} ${inJob(control.loaded)}${inJob(control.readAsData)}` }] } };
  const given = control.readAsData ? [{ type: 'user', message: { content: [{ type: 'tool_result', content: inJob(control.readAsData) }] } }] : [];
  const diff = inJob('diff.patch').split('\n');
  const reads = (control.reads ?? [[1, diff.length]]).map(([startLine, count]) => {
    const part = diff.slice(startLine - 1, startLine - 1 + count);
    return {
      type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', content: part.map((l, i) => `${startLine + i}\t${l}`).join('\n') }] },
      tool_use_result: { type: 'text', file: { filePath: join(process.cwd(), 'diff.patch'), content: part.join('\n'), numLines: part.length, startLine, totalLines: diff.length } },
    };
  });
  const answer = { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: {} }] } };
  const lines = [...(control.noInit ? [] : [init]), ...reads, ...given, said, ...(control.lines ?? []), answer];
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n${result()}\n`;
}

const finish = () => {
  if (control.killSelf) process.kill(process.pid, 'SIGKILL');
  if (control.stderr) process.stderr.write(control.stderr);
  const out = control.flood ? 'x'.repeat(control.flood) : (control.stdout ?? (streaming ? streamed() : result()));
  process.stdout.write(out, () => process.exit(control.exit ?? 0));
};

if (control.obey) await obey();
if (control.copyPlanted) obeyed = JSON.parse(readFileSync('tree/review.json', 'utf8'));
if (control.sleepMs) setTimeout(finish, control.sleepMs);
else finish();
