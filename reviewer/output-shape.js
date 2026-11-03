// The output handling was written from the CLI's documentation, so the first real runs are also a test of that. When a real result does
// not look as expected, this says which part differed, in words safe to print and to paste into an issue: field names and types, and
// never a value. The fields inside structured_output are the model's to invent, so an unexpected one there is counted and not named.
const INIT_FIELDS = { tools: 'array', mcp_servers: 'array', model: 'string', permissionMode: 'string' };
const RESULT_FIELDS = {
  type: 'string', subtype: 'string', is_error: 'boolean', permission_denials: 'array', structured_output: 'object',
  total_cost_usd: 'number', num_turns: 'number', duration_ms: 'number', modelUsage: 'object',
};
const OUTPUT_FIELDS = { verdict: 'string', sha: 'string', findings: 'array' };
const FINDING_FIELDS = { file: 'string|null', line: 'number|null', severity: 'string', message: 'string' };

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
export const isObject = (v) => kindOf(v) === 'object';
export const safeName = (s) => (/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(s) ? s : '(odd name)');

// One JSON value on each line, as stream-json prints them. A value that is an array is taken as a list of messages, in case the CLI ever
// groups them. Returns { lines, unparsed, notJson, init, result }.
export function parseStream(stdout) {
  const lines = [];
  const notJson = [];
  for (const raw of String(stdout ?? '').split('\n')) {
    if (!raw.trim()) continue;
    try {
      lines.push(...[JSON.parse(raw)].flat());
    } catch {
      notJson.push(raw);
    }
  }
  const objects = lines.filter(isObject);
  return {
    lines: objects,
    unparsed: notJson.length + lines.length - objects.length,
    notJson,
    init: objects.find((l) => l.type === 'system' && l.subtype === 'init') ?? null,
    result: objects.findLast((l) => l.type === 'result') ?? null,
  };
}

const fieldsDiffer = (where, value, fields) => Object.entries(fields).flatMap(([name, want]) => {
  const got = Object.hasOwn(value, name) ? kindOf(value[name]) : 'missing';
  return want.split('|').includes(got) ? [] : [`${where}.${name}: expected ${want}, got ${got}`];
});

// What differs from the expected shape, one string per difference. Empty when all is as expected.
export function shapeDifferences({ init, result, unparsed = 0 }, { stream = true } = {}) {
  const out = [];
  if (unparsed) out.push(`${unparsed} line(s) of output are not JSON objects`);
  if (stream) out.push(...(init ? fieldsDiffer('init', init, INIT_FIELDS) : ['no system/init line']));
  if (!result) return [...out, 'no result line'];
  out.push(...fieldsDiffer('result', result, RESULT_FIELDS));
  const answer = result.structured_output;
  if (!isObject(answer)) return out;
  out.push(...fieldsDiffer('structured_output', answer, OUTPUT_FIELDS));
  const extra = Object.keys(answer).filter((k) => !Object.hasOwn(OUTPUT_FIELDS, k)).length;
  if (extra) out.push(`structured_output has ${extra} unexpected field(s)`);
  const first = Array.isArray(answer.findings) ? answer.findings.findIndex((f) => !isObject(f) || fieldsDiffer('', f, FINDING_FIELDS).length) : -1;
  if (first >= 0) {
    const f = answer.findings[first];
    out.push(...(isObject(f) ? fieldsDiffer(`structured_output.findings[${first}]`, f, FINDING_FIELDS) : [`structured_output.findings[${first}]: expected object, got ${kindOf(f)}`]));
  }
  return out;
}

// What the CLI did print, for working out the parser's next correction. All of these names are the CLI's own, not the model's.
export function shapeFacts({ lines, init, result }) {
  const kinds = {};
  for (const l of lines) {
    const kind = [l.type, l.subtype].filter((s) => typeof s === 'string').map(safeName).join('/') || '(no type)';
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  const facts = [`lines: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`];
  if (init) facts.push(`init fields: ${Object.keys(init).map(safeName).join(',')}`);
  if (result) facts.push(`result fields: ${Object.keys(result).map(safeName).join(',')}`);
  return facts;
}
