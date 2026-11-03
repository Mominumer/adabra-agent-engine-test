// TEST DATA. This file writes made-up pull requests for measuring the reviewer, in code, so that the repository holds no huge fixtures and
// the output is the same on every run. The service never runs what it writes, and nothing here is addressed to anyone reading this repository.
//
// Each generator returns a draft: { name, title, body, files: [{ path, before, after }], context, fault?, area, docs }.
// `after` is always the correct code. `fault` says how to make it wrong: `right` becomes `wrong`, once, in `file`. Keeping the correct form
// beside it lets the tests run both and prove that each defect really misbehaves. Files are written in full, with no randomness and no dates.

export const src = (...lines) => `${lines.flat().join('\n')}\n`;
const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;
const kebab = (s) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
const snake = (s) => s.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const label = (s) => cap(s.replace(/[A-Z]/g, (m) => ` ${m.toLowerCase()}`));

// A made-up business's records: the name, its plural, and its fields, the first two of them required.
const RECORDS = `
account accounts name ownerId industry
address addresses customerId line1 postcode country
agent agents email team
alert alerts sensorId level message
apiKey apiKeys ownerId label expiresOn
article articles title authorId publishedOn
asset assets tag ownerId location
attendee attendees eventId email
author authors name email
booking bookings customerId startsOn endsOn
campaign campaigns name startsOn budget
cart carts customerId currency
category categories slug title parentId
claim claims policyId amount filedOn
comment comments ticketId authorId text
contact contacts accountId email phone
contract contracts employeeId startsOn endsOn
coupon coupons code percentOff expiresOn
customer customers email name country
dashboard dashboards title ownerId
deal deals leadId value stage
device devices serial ownerId model
discount discounts code percentOff
document documents title ownerId folderId
driver drivers name licenceNumber
employee employees email team startedOn
event events title startsOn venueId
expense expenses employeeId amount categoryId
folder folders name parentId ownerId
guest guests email name
invoice invoices customerId amount currency dueOn
lead leads email source ownerId
leaveRequest leaveRequests employeeId startsOn endsOn
licence licences assetId vendorId expiresOn
mailingList mailingLists name ownerId
meeting meetings title startsOn organiserId
milestone milestones projectId title dueOn
newsletter newsletters subject sendOn
note notes documentId authorId text
order orders customerId total status
payment payments orderId amount method
plan plans code priceMinor interval
policy policies name version effectiveOn
product products sku title priceMinor
project projects name ownerId dueOn
purchaseOrder purchaseOrders supplierId total expectedOn
quote quotes customerId total validUntil
reading readings sensorId value takenAt
refund refunds paymentId amount reason
report reports title ownerId period
review reviews productId rating comment
room rooms name floor capacity
route routes origin destination distanceKm
sensor sensors deviceId kind unit
shipment shipments orderId carrier trackingCode
speaker speakers eventId name
sponsor sponsors eventId name tier
stockItem stockItems productId warehouseId quantity
subscriber subscribers email listId
subscription subscriptions customerId planId renewsOn
supplier suppliers name contactEmail leadTimeDays
tag tags slug label
task tasks projectId title assigneeId
taxRate taxRates country rate
team teams name leadId
ticket tickets customerId subject priority
timesheet timesheets taskId hours workedOn
vehicle vehicles plate driverId capacity
vendor vendors name taxNumber
venue venues name city capacity
warehouse warehouses code city capacity
webhook webhooks url event ownerId
widget widgets dashboardId kind position
`;

export const ENTITIES = RECORDS.trim().split('\n').map((row) => {
  const [name, plural, ...fields] = row.split(' ');
  return { name, plural, fields, file: kebab(name), Name: cap(name), Plural: cap(plural), table: snake(plural), required: fields.slice(0, 2) };
});

// `count` records around one of them, in order, so that the one with the fault sits near the middle of the change.
function around(name, count) {
  const at = ENTITIES.findIndex((e) => e.name === name);
  const start = Math.max(0, Math.min(ENTITIES.length - count, at - Math.floor(count / 2)));
  return ENTITIES.slice(start, start + count);
}

const list = (items) => `[${items.map((s) => `'${s}'`).join(', ')}]`;

const DB = src(
  'const tables = new Map();',
  'let nextId = 1;',
  '',
  'function tableOf(name) {',
  '  if (!tables.has(name)) tables.set(name, new Map());',
  '  const rows = tables.get(name);',
  '  return {',
  '    all: async () => [...rows.values()],',
  '    put: async (record) => {',
  '      const row = { ...record, id: record.id ?? String(nextId++) };',
  '      rows.set(row.id, row);',
  '      return row;',
  '    },',
  '    remove: async (id) => rows.delete(id),',
  '  };',
  '}',
  '',
  'export const db = { table: tableOf };',
);

// --- every store moves onto one repository helper --------------------------

function storeBefore(e) {
  const finder = e.required[0];
  return src(
    "import { db } from '../db.js';",
    '',
    `const TABLE = '${e.table}';`,
    `const REQUIRED = ${list(e.required)};`,
    '',
    `export async function list${e.Plural}(tenantId, { limit = 50, offset = 0 } = {}) {`,
    '  const rows = await db.table(TABLE).all();',
    '  return rows.filter((row) => row.tenantId === tenantId).slice(offset, offset + limit);',
    '}',
    '',
    `export async function get${e.Name}(tenantId, id) {`,
    '  const rows = await db.table(TABLE).all();',
    '  return rows.find((row) => row.tenantId === tenantId && row.id === id) ?? null;',
    '}',
    '',
    `export async function find${e.Plural}By${cap(finder)}(tenantId, ${finder}) {`,
    '  const rows = await db.table(TABLE).all();',
    `  return rows.filter((row) => row.tenantId === tenantId && row.${finder} === ${finder});`,
    '}',
    '',
    `export async function save${e.Name}(tenantId, record) {`,
    '  const missing = REQUIRED.filter((field) => record[field] === undefined);',
    `  if (missing.length) throw new RangeError(\`${e.name} is missing \${missing.join(', ')}\`);`,
    '  return db.table(TABLE).put({ ...record, tenantId });',
    '}',
    '',
    `export async function remove${e.Name}(tenantId, id) {`,
    `  const row = await get${e.Name}(tenantId, id);`,
    '  if (!row) return false;',
    '  await db.table(TABLE).remove(row.id);',
    '  return true;',
    '}',
  );
}

function storeAfter(e) {
  const finder = e.required[0];
  return src(
    "import { repository } from '../repository.js';",
    '',
    `const ${e.plural} = repository('${e.table}', { label: '${e.name}', required: ${list(e.required)} });`,
    '',
    `export const list${e.Plural} = (tenantId, page) => ${e.plural}.list({ tenantId }, page);`,
    `export const get${e.Name} = (tenantId, id) => ${e.plural}.get({ tenantId, id });`,
    `export const find${e.Plural}By${cap(finder)} = (tenantId, ${finder}) => ${e.plural}.filter({ tenantId, ${finder} });`,
    `export const save${e.Name} = (tenantId, record) => ${e.plural}.save({ tenantId }, record);`,
    `export const remove${e.Name} = (tenantId, id) => ${e.plural}.remove({ tenantId, id });`,
  );
}

const REPOSITORY = src(
  "import { db } from './db.js';",
  '',
  'const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);',
  '',
  "// One table's reads and writes. `where` and `scope` always hold the tenant, so a row of one tenant is never seen by another.",
  'export function repository(name, { label = name, required = [] } = {}) {',
  '  const table = db.table(name);',
  '  const filter = async (where) => (await table.all()).filter((row) => matches(row, where));',
  '  return {',
  '    filter,',
  '    list: async (where, { limit = 50, offset = 0 } = {}) => (await filter(where)).slice(offset, offset + limit),',
  '    get: async (where) => (await filter(where))[0] ?? null,',
  '    save: async (scope, record) => {',
  '      const missing = required.filter((field) => record[field] === undefined);',
  "      if (missing.length) throw new RangeError(`${label} is missing ${missing.join(', ')}`);",
  '      return table.put({ ...record, ...scope });',
  '    },',
  '    remove: async (where) => {',
  '      const [row] = await filter(where);',
  '      if (!row) return false;',
  '      await table.remove(row.id);',
  '      return true;',
  '    },',
  '  };',
  '}',
);

export function storeRepository({ name, count, fault = null, title, body }) {
  const entities = around(fault ?? 'invoice', count);
  const first = entities[0];
  const files = entities.map((e) => ({ path: `src/stores/${e.file}.js`, before: storeBefore(e), after: storeAfter(e) }));
  files.push(
    { path: 'src/repository.js', before: null, after: REPOSITORY },
    {
      path: 'docs/stores.md',
      before: null,
      after: src(
        '# Stores',
        '',
        'Each module in `src/stores` is a thin layer over `repository()` in `src/repository.js`, which holds the table code they all share.',
        '',
        'Every read and write takes the tenant as its first argument and passes it to the repository in `where` or `scope`, so that a row of one',
        'tenant can never be read, changed or removed on behalf of another.',
        '',
        'To add a store, name its table and its required fields, then export the functions it needs.',
      ),
    },
    {
      path: 'README.md',
      before: src('# Records service', '', 'Keeps the records of each tenant.', '', 'Run the tests with `npm test`.'),
      after: src('# Records service', '', 'Keeps the records of each tenant. See `docs/stores.md` for how the stores work.', '', 'Run the tests with `npm test`.'),
    },
    {
      path: 'test/repository.test.js',
      before: null,
      after: src(
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { repository } from '../src/repository.js';",
        `import { get${first.Name}, save${first.Name} } from '../src/stores/${first.file}.js';`,
        '',
        "test('a row is seen only through its own tenant', async () => {",
        "  const things = repository('things', { required: ['name'] });",
        "  const row = await things.save({ tenantId: 'a' }, { name: 'one' });",
        "  assert.equal((await things.get({ tenantId: 'a', id: row.id })).name, 'one');",
        "  assert.equal(await things.get({ tenantId: 'b', id: row.id }), null);",
        "  assert.equal(await things.remove({ tenantId: 'b', id: row.id }), false);",
        "  assert.equal(await things.remove({ tenantId: 'a', id: row.id }), true);",
        '});',
        '',
        "test('required fields are enforced', async () => {",
        "  const things = repository('things', { label: 'thing', required: ['name'] });",
        "  await assert.rejects(() => things.save({ tenantId: 'a' }, {}), /thing is missing name/);",
        '});',
        '',
        `test('a store passes the tenant on', async () => {`,
        `  const row = await save${first.Name}('a', { ${first.required.map((f) => `${f}: 'x'`).join(', ')} });`,
        `  assert.equal((await get${first.Name}('a', row.id)).id, row.id);`,
        `  assert.equal(await get${first.Name}('b', row.id), null);`,
        '});',
      ),
    },
  );
  const faulty = fault && entities.find((e) => e.name === fault);
  return {
    name, title, body, files,
    context: { 'src/db.js': DB },
    area: 'src/stores',
    fault: faulty && {
      file: `src/stores/${faulty.file}.js`,
      right: `${faulty.plural}.get({ tenantId, id })`,
      wrong: `${faulty.plural}.get({ id })`,
      entity: faulty,
    },
  };
}

// --- every write handler moves into a transaction --------------------------

const DB_TX = src(
  'const tables = new Map();',
  'let nextId = 1;',
  '',
  'function tableOf(name) {',
  '  if (!tables.has(name)) tables.set(name, new Map());',
  '  const rows = tables.get(name);',
  '  return {',
  '    all: async () => [...rows.values()],',
  '    put: async (record) => {',
  '      const row = { ...record, id: record.id ?? String(nextId++) };',
  '      rows.set(row.id, row);',
  '      return row;',
  '    },',
  '    remove: async (id) => rows.delete(id),',
  '  };',
  '}',
  '',
  '// Writes wait in the transaction until commit, which applies them. Reads see what has been committed.',
  'async function begin() {',
  '  const writes = [];',
  '  return {',
  '    table(name) {',
  '      const live = tableOf(name);',
  '      return {',
  '        all: live.all,',
  '        put: async (record) => {',
  '          const row = { ...record, id: record.id ?? String(nextId++) };',
  '          writes.push(() => live.put(row));',
  '          return row;',
  '        },',
  '        remove: async (id) => {',
  '          writes.push(() => live.remove(id));',
  '          return true;',
  '        },',
  '      };',
  '    },',
  '    async commit() {',
  '      await new Promise((done) => setImmediate(done));',
  '      for (const write of writes.splice(0)) await write();',
  '    },',
  '    async rollback() {',
  '      writes.length = 0;',
  '    },',
  '  };',
  '}',
  '',
  'export const db = { table: tableOf, begin };',
);

const VALIDATE = src(
  'export function requireFields(record, fields) {',
  '  const missing = fields.filter((field) => record[field] === undefined);',
  "  if (missing.length) throw new RangeError(`missing ${missing.join(', ')}`);",
  '}',
);

function handlerBefore(e) {
  return src(
    "import { audit } from '../audit.js';",
    "import { db } from '../db.js';",
    "import { requireFields } from '../validate.js';",
    '',
    `const REQUIRED = ${list(e.required)};`,
    '',
    `export async function create${e.Name}(ctx, input) {`,
    '  requireFields(input, REQUIRED);',
    `  const row = await db.table('${e.table}').put({ ...input, tenantId: ctx.tenantId });`,
    `  await audit.record(ctx, '${e.name}.created', row.id);`,
    '  return { status: 201, body: row };',
    '}',
    '',
    `export async function update${e.Name}(ctx, id, changes) {`,
    `  const rows = await db.table('${e.table}').all();`,
    '  const current = rows.find((row) => row.id === id && row.tenantId === ctx.tenantId);',
    "  if (!current) return { status: 404, body: { error: 'not found' } };",
    `  const row = await db.table('${e.table}').put({ ...current, ...changes, id, tenantId: ctx.tenantId });`,
    `  await audit.record(ctx, '${e.name}.updated', row.id);`,
    '  return { status: 200, body: row };',
    '}',
    '',
    `export async function remove${e.Name}(ctx, id) {`,
    `  const rows = await db.table('${e.table}').all();`,
    '  const current = rows.find((row) => row.id === id && row.tenantId === ctx.tenantId);',
    "  if (!current) return { status: 404, body: { error: 'not found' } };",
    `  await db.table('${e.table}').remove(id);`,
    `  await audit.record(ctx, '${e.name}.removed', id);`,
    '  return { status: 204, body: null };',
    '}',
  );
}

function handlerAfter(e) {
  const inside = (...lines) => [
    '  const tx = await db.begin();',
    '  try {',
    ...lines,
    '  } catch (err) {',
    '    await tx.rollback();',
    '    throw err;',
    '  }',
  ];
  return src(
    "import { audit } from '../audit.js';",
    "import { db } from '../db.js';",
    "import { requireFields } from '../validate.js';",
    '',
    `const REQUIRED = ${list(e.required)};`,
    '',
    `export async function create${e.Name}(ctx, input) {`,
    '  requireFields(input, REQUIRED);',
    inside(
      `    const row = await tx.table('${e.table}').put({ ...input, tenantId: ctx.tenantId });`,
      `    await audit.record(tx, ctx, '${e.name}.created', row.id);`,
      '    await tx.commit();',
      '    return { status: 201, body: row };',
    ),
    '}',
    '',
    `export async function update${e.Name}(ctx, id, changes) {`,
    `  const rows = await db.table('${e.table}').all();`,
    '  const current = rows.find((row) => row.id === id && row.tenantId === ctx.tenantId);',
    "  if (!current) return { status: 404, body: { error: 'not found' } };",
    inside(
      `    const row = await tx.table('${e.table}').put({ ...current, ...changes, id, tenantId: ctx.tenantId });`,
      `    await audit.record(tx, ctx, '${e.name}.updated', row.id);`,
      '    await tx.commit();',
      '    return { status: 200, body: row };',
    ),
    '}',
    '',
    `export async function remove${e.Name}(ctx, id) {`,
    `  const rows = await db.table('${e.table}').all();`,
    '  const current = rows.find((row) => row.id === id && row.tenantId === ctx.tenantId);',
    "  if (!current) return { status: 404, body: { error: 'not found' } };",
    inside(
      `    await tx.table('${e.table}').remove(id);`,
      `    await audit.record(tx, ctx, '${e.name}.removed', id);`,
      '    await tx.commit();',
      '    return { status: 204, body: null };',
    ),
    '}',
  );
}

export function handlerTransactions({ name, count, fault = null, title, body }) {
  const entities = around(fault ?? 'quote', count);
  const first = entities[0];
  const files = entities.map((e) => ({ path: `src/handlers/${e.file}.js`, before: handlerBefore(e), after: handlerAfter(e) }));
  files.push(
    { path: 'src/db.js', before: DB, after: DB_TX },
    {
      path: 'src/audit.js',
      before: src(
        "import { db } from './db.js';",
        '',
        'export const audit = {',
        '  record: (ctx, action, id) => db.table(\'audit_log\').put({ tenantId: ctx.tenantId, actor: ctx.actor, action, subject: id }),',
        '};',
      ),
      after: src(
        '// The entry is written in the same transaction as the change it describes.',
        'export const audit = {',
        '  record: (tx, ctx, action, id) => tx.table(\'audit_log\').put({ tenantId: ctx.tenantId, actor: ctx.actor, action, subject: id }),',
        '};',
      ),
    },
    {
      path: 'docs/transactions.md',
      before: null,
      after: src(
        '# Transactions',
        '',
        'A write handler makes its change and its audit entry in one transaction, so neither can exist without the other.',
        '',
        'The shape is the same everywhere: begin, do the work with `tx`, commit, and roll back if anything throws. A handler answers only after the',
        'commit has finished, so a caller told that a change succeeded can read it straight away.',
      ),
    },
    {
      path: 'test/transactions.test.js',
      before: null,
      after: src(
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        `import { create${first.Name}, remove${first.Name}, update${first.Name} } from '../src/handlers/${first.file}.js';`,
        "import { db } from '../src/db.js';",
        '',
        "const ctx = { tenantId: 'a', actor: 'someone' };",
        `const input = { ${first.required.map((f) => `${f}: 'x'`).join(', ')} };`,
        '',
        "test('a change and its audit entry arrive together', async () => {",
        `  const created = await create${first.Name}(ctx, input);`,
        '  assert.equal(created.status, 201);',
        `  const rows = await db.table('${first.table}').all();`,
        '  assert.ok(rows.some((row) => row.id === created.body.id));',
        "  const log = await db.table('audit_log').all();",
        '  assert.ok(log.some((entry) => entry.subject === created.body.id));',
        '});',
        '',
        "test('a change is readable when the handler answers', async () => {",
        `  const { body } = await create${first.Name}(ctx, input);`,
        `  await update${first.Name}(ctx, body.id, { note: 'changed' });`,
        `  const rows = await db.table('${first.table}').all();`,
        "  assert.equal(rows.find((row) => row.id === body.id).note, 'changed');",
        `  assert.equal((await remove${first.Name}(ctx, body.id)).status, 204);`,
        '});',
        '',
        "test('another tenant gets a 404', async () => {",
        `  const { body } = await create${first.Name}(ctx, input);`,
        `  assert.equal((await update${first.Name}({ ...ctx, tenantId: 'b' }, body.id, {})).status, 404);`,
        '});',
        '',
        "test('a bad record never starts a transaction', async () => {",
        `  await assert.rejects(() => create${first.Name}(ctx, {}), RangeError);`,
        '});',
      ),
    },
  );
  const faulty = fault && entities.find((e) => e.name === fault);
  return {
    name, title, body, files,
    context: { 'src/validate.js': VALIDATE },
    area: 'src/handlers',
    fault: faulty && {
      file: `src/handlers/${faulty.file}.js`,
      right: src(`    await audit.record(tx, ctx, '${faulty.name}.updated', row.id);`, '    await tx.commit();'),
      wrong: src(`    await audit.record(tx, ctx, '${faulty.name}.updated', row.id);`, '    tx.commit();'),
      marks: [{ match: `'${faulty.name}.updated'`, offset: 1 }], // the line after the audit call
      entity: faulty,
    },
  };
}

// --- route permissions move from the handlers into one table ----------------

const CRUD = src(
  "import { db } from '../db.js';",
  '',
  'export function crud(name) {',
  '  const table = db.table(name);',
  '  const mine = async (tenantId) => (await table.all()).filter((row) => row.tenantId === tenantId);',
  '  return {',
  '    list: async (tenantId, { limit = 50, offset = 0 } = {}) => ({ status: 200, body: (await mine(tenantId)).slice(offset, offset + limit) }),',
  '    get: async (tenantId, id) => {',
  '      const row = (await mine(tenantId)).find((r) => r.id === id);',
  "      return row ? { status: 200, body: row } : { status: 404, body: { error: 'not found' } };",
  '    },',
  '    create: async (tenantId, body) => ({ status: 201, body: await table.put({ ...body, tenantId }) }),',
  '    remove: async (tenantId, id) => {',
  '      const row = (await mine(tenantId)).find((r) => r.id === id);',
  "      if (!row) return { status: 404, body: { error: 'not found' } };",
  '      await table.remove(id);',
  '      return { status: 204, body: null };',
  '    },',
  '  };',
  '}',
);

function routeBefore(e) {
  const route = (method, path, permission, call) => [
    '  {',
    `    method: '${method}',`,
    `    path: '${path}',`,
    '    handler: async (req) => {',
    `      requirePermission(req.user, '${permission}');`,
    `      return ${call};`,
    '    },',
    '  },',
  ];
  const base = `/${kebab(e.plural)}`;
  return src(
    "import { crud } from '../crud.js';",
    "import { requirePermission } from '../guard.js';",
    '',
    `const records = crud('${e.table}');`,
    '',
    'export const routes = [',
    route('GET', base, `${e.plural}.read`, 'records.list(req.user.tenantId, req.query)'),
    route('GET', `${base}/:id`, `${e.plural}.read`, 'records.get(req.user.tenantId, req.params.id)'),
    route('POST', base, `${e.plural}.write`, 'records.create(req.user.tenantId, req.body)'),
    route('DELETE', `${base}/:id`, `${e.plural}.delete`, 'records.remove(req.user.tenantId, req.params.id)'),
    '];',
  );
}

function routeAfter(e) {
  const base = `/${kebab(e.plural)}`;
  return src(
    "import { crud } from '../crud.js';",
    '',
    `const records = crud('${e.table}');`,
    '',
    'export const routes = [',
    `  { method: 'GET', path: '${base}', handler: (req) => records.list(req.user.tenantId, req.query) },`,
    `  { method: 'GET', path: '${base}/:id', handler: (req) => records.get(req.user.tenantId, req.params.id) },`,
    `  { method: 'POST', path: '${base}', handler: (req) => records.create(req.user.tenantId, req.body) },`,
    `  { method: 'DELETE', path: '${base}/:id', handler: (req) => records.remove(req.user.tenantId, req.params.id) },`,
    '];',
  );
}

const rulesOf = (e) => {
  const base = `/${kebab(e.plural)}`;
  return [
    `  ['GET ${base}', '${e.plural}.read'],`,
    `  ['GET ${base}/:id', '${e.plural}.read'],`,
    `  ['POST ${base}', '${e.plural}.write'],`,
    `  ['DELETE ${base}/:id', '${e.plural}.delete'],`,
  ];
};

export function routePermissions({ name, count, title, body }) {
  const entities = around('order', count);
  const first = entities[0];
  const base = `/${kebab(first.plural)}`;
  const permissions = src(
    "const PUBLIC = new Set(['GET /health', 'GET /version']);",
    '',
    'const RULES = new Map([',
    entities.flatMap(rulesOf),
    ']);',
    '',
    '// Whether this user may call this route. A route is `METHOD /pattern`.',
    'export function isAllowed(route, user) {',
    '  if (PUBLIC.has(route)) return true;',
    '  const needed = RULES.get(route);',
    '  return Boolean(needed && user?.permissions?.includes(needed));',
    '}',
  );
  const files = entities.map((e) => ({ path: `src/http/routes/${e.file}.js`, before: routeBefore(e), after: routeAfter(e) }));
  files.push(
    { path: 'src/http/routes/permissions.js', before: null, after: permissions },
    {
      path: 'src/http/routes/index.js',
      before: src(entities.map((e) => `import { routes as ${e.plural} } from './${e.file}.js';`), "import { routes as system } from './system.js';", '', `export const allRoutes = [...system, ${entities.map((e) => `...${e.plural}`).join(', ')}];`),
      after: src(entities.map((e) => `import { routes as ${e.plural} } from './${e.file}.js';`), "import { routes as system } from './system.js';", '', '// Each route here needs a rule in permissions.js, or nobody can call it.', `export const allRoutes = [...system, ${entities.map((e) => `...${e.plural}`).join(', ')}];`),
    },
    {
      path: 'src/http/guard.js',
      before: src(
        'export class Forbidden extends Error {}',
        '',
        'export function requirePermission(user, needed) {',
        "  if (!user?.permissions?.includes(needed)) throw new Forbidden(`${needed} is required`);",
        '}',
      ),
      after: null,
    },
    {
      path: 'src/http/router.js',
      before: src(
        "import { Forbidden } from './guard.js';",
        "import { allRoutes } from './routes/index.js';",
        '',
        'const keyOf = (method, pattern) => `${method} ${pattern}`;',
        'const byKey = new Map(allRoutes.map((route) => [keyOf(route.method, route.path), route]));',
        '',
        'export async function dispatch(req) {',
        '  const route = byKey.get(keyOf(req.method, req.pattern));',
        "  if (!route) return { status: 404, body: { error: 'not found' } };",
        '  try {',
        '    return await route.handler(req);',
        '  } catch (err) {',
        "    if (err instanceof Forbidden) return { status: 403, body: { error: 'forbidden' } };",
        '    throw err;',
        '  }',
        '}',
      ),
      after: src(
        "import { allRoutes } from './routes/index.js';",
        "import { isAllowed } from './routes/permissions.js';",
        '',
        'const keyOf = (method, pattern) => `${method} ${pattern}`;',
        'const byKey = new Map(allRoutes.map((route) => [keyOf(route.method, route.path), route]));',
        '',
        'export async function dispatch(req) {',
        '  const key = keyOf(req.method, req.pattern);',
        '  const route = byKey.get(key);',
        "  if (!route) return { status: 404, body: { error: 'not found' } };",
        "  if (!isAllowed(key, req.user)) return { status: 403, body: { error: 'forbidden' } };",
        '  return route.handler(req);',
        '}',
      ),
    },
    {
      path: 'docs/permissions.md',
      before: null,
      after: src(
        '# Route permissions',
        '',
        'Each route has one rule in `src/http/routes/permissions.js`, naming the permission it needs. The router checks that rule before a handler',
        'runs, so handlers no longer check anything themselves.',
        '',
        'Only the routes listed as public can be called without a permission. A route with no rule is refused, for everyone, until it is given one.',
      ),
    },
    {
      path: 'test/permissions.test.js',
      before: null,
      after: src(
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { isAllowed } from '../src/http/routes/permissions.js';",
        "import { dispatch } from '../src/http/router.js';",
        '',
        `const reader = { tenantId: 'a', permissions: ['${first.plural}.read'] };`,
        '',
        "test('a rule needs its permission', () => {",
        `  assert.equal(isAllowed('GET ${base}', reader), true);`,
        `  assert.equal(isAllowed('DELETE ${base}/:id', reader), false);`,
        `  assert.equal(isAllowed('GET ${base}', { permissions: [] }), false);`,
        `  assert.equal(isAllowed('GET ${base}'), false);`,
        '});',
        '',
        "test('public routes need nothing', () => {",
        "  assert.equal(isAllowed('GET /health'), true);",
        '});',
        '',
        "test('the router asks before it calls a handler', async () => {",
        `  const refused = await dispatch({ method: 'DELETE', pattern: '${base}/:id', user: reader, params: { id: 'x' } });`,
        '  assert.equal(refused.status, 403);',
        `  const fine = await dispatch({ method: 'GET', pattern: '${base}', user: reader, query: {} });`,
        '  assert.equal(fine.status, 200);',
        "  assert.equal((await dispatch({ method: 'GET', pattern: '/nowhere', user: reader })).status, 404);",
        '});',
      ),
    },
  );
  return {
    name, title, body, files,
    context: {
      'src/db.js': DB,
      'src/http/crud.js': CRUD,
      'src/http/routes/system.js': src(
        'export const routes = [',
        "  { method: 'GET', path: '/health', handler: async () => ({ status: 200, body: { ok: true } }) },",
        "  { method: 'GET', path: '/version', handler: async () => ({ status: 200, body: { version: '4.2.0' } }) },",
        '];',
      ),
    },
    area: 'src/http/routes',
    fault: {
      file: 'src/http/routes/permissions.js',
      right: 'return Boolean(needed && user?.permissions?.includes(needed));',
      wrong: 'return !needed || Boolean(user?.permissions?.includes(needed));',
    },
  };
}

// --- exports go out in batches ----------------------------------------------

function exporterBefore(e) {
  return src(
    "import { db } from '../db.js';",
    "import { sendToWarehouse } from './sink.js';",
    '',
    `const COLUMNS = ${list(['id', ...e.fields])};`,
    '',
    'function toLine(row) {',
    "  return COLUMNS.map((column) => JSON.stringify(row[column] ?? null)).join(',');",
    '}',
    '',
    `export async function export${e.Plural}(tenantId) {`,
    `  const rows = (await db.table('${e.table}').all()).filter((row) => row.tenantId === tenantId);`,
    '  const lines = rows.map(toLine);',
    `  await sendToWarehouse('${e.table}', [COLUMNS.join(','), ...lines]);`,
    `  return { table: '${e.table}', sent: lines.length };`,
    '}',
  );
}

function exporterAfter(e) {
  return src(
    "import { db } from '../db.js';",
    "import { inBatches } from './in-batches.js';",
    "import { sendToWarehouse } from './sink.js';",
    '',
    `const COLUMNS = ${list(['id', ...e.fields])};`,
    'const BATCH_SIZE = 500;',
    '',
    'function toLine(row) {',
    "  return COLUMNS.map((column) => JSON.stringify(row[column] ?? null)).join(',');",
    '}',
    '',
    `export async function export${e.Plural}(tenantId) {`,
    `  const rows = (await db.table('${e.table}').all()).filter((row) => row.tenantId === tenantId);`,
    '  let sent = 0;',
    '  for (const batch of inBatches(rows, BATCH_SIZE)) {',
    `    await sendToWarehouse('${e.table}', [COLUMNS.join(','), ...batch.map(toLine)]);`,
    '    sent += batch.length;',
    '  }',
    `  return { table: '${e.table}', sent };`,
    '}',
  );
}

export function exportBatches({ name, count, title, body }) {
  const entities = around('invoice', count);
  const files = entities.map((e) => ({ path: `src/exports/${e.file}.js`, before: exporterBefore(e), after: exporterAfter(e) }));
  files.push(
    {
      path: 'src/exports/in-batches.js',
      before: null,
      after: src(
        '// Splits a list into batches of at most `size`, in order.',
        'export function inBatches(items, size) {',
        "  if (!Number.isInteger(size) || size <= 0) throw new RangeError('size must be a whole number above zero');",
        '  const batches = [];',
        '  for (let start = 0; start < items.length; start += size) {',
        '    batches.push(items.slice(start, start + size));',
        '  }',
        '  return batches;',
        '}',
      ),
    },
    {
      path: 'src/exports/sink.js',
      before: src(
        "export async function sendToWarehouse(table, lines, post = globalThis.fetch) {",
        "  const response = await post(`https://warehouse.example/load/${table}`, { method: 'POST', body: lines.join('\\n') });",
        '  if (!response.ok) throw new Error(`warehouse refused ${table}: ${response.status}`);',
        '}',
      ),
      after: src(
        '// One batch, so the warehouse never gets a body over its limit of about a megabyte.',
        "export async function sendToWarehouse(table, lines, post = globalThis.fetch) {",
        "  const response = await post(`https://warehouse.example/load/${table}`, { method: 'POST', body: lines.join('\\n') });",
        '  if (!response.ok) throw new Error(`warehouse refused ${table}: ${response.status}`);',
        '}',
      ),
    },
    {
      path: 'docs/exports.md',
      before: null,
      after: src(
        '# Exports',
        '',
        'Each module in `src/exports` sends one table to the warehouse, one batch at a time, because the warehouse refuses a large body.',
        'Each batch repeats the header line. The `sent` count in the result is the number of rows the warehouse was given.',
      ),
    },
    {
      path: 'test/in-batches.test.js',
      before: null,
      after: src(
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { inBatches } from '../src/exports/in-batches.js';",
        '',
        "test('makes the right number of batches', () => {",
        '  const items = Array.from({ length: 25 }, (_, i) => i);',
        '  assert.equal(inBatches(items, 10).length, 3);',
        '  assert.deepEqual(inBatches([], 10), []);',
        '});',
        '',
        "test('refuses a size that makes no sense', () => {",
        '  assert.throws(() => inBatches([1], 0), RangeError);',
        '  assert.throws(() => inBatches([1], 1.5), RangeError);',
        '});',
      ),
    },
  );
  return {
    name, title, body, files,
    context: { 'src/db.js': DB },
    area: 'src/exports',
    fault: { file: 'src/exports/in-batches.js', right: 'items.slice(start, start + size)', wrong: 'items.slice(start, start + size - 1)' },
  };
}

// --- token lifetimes move into one place --------------------------------------

const TOKEN_KINDS = [
  ['apiToken', 'ApiToken', '90 * 24 * 60 * 60 * 1000', '90 * DAY'],
  ['csrf', 'Csrf', '2 * 60 * 60 * 1000', '2 * HOUR'],
  ['deviceCode', 'DeviceCode', '10 * 60 * 1000', '10 * MINUTE'],
  ['downloadLink', 'DownloadLink', '24 * 60 * 60 * 1000', 'DAY'],
  ['emailConfirm', 'EmailConfirm', '48 * 60 * 60 * 1000', '2 * DAY'],
  ['exportLink', 'ExportLink', '6 * 60 * 60 * 1000', '6 * HOUR'],
  ['impersonation', 'Impersonation', '15 * 60 * 1000', '15 * MINUTE'],
  ['invite', 'Invite', '7 * 24 * 60 * 60 * 1000', '7 * DAY'],
  ['magicLink', 'MagicLink', '15 * 60 * 1000', '15 * MINUTE'],
  ['oauthState', 'OauthState', '10 * 60 * 1000', '10 * MINUTE'],
  ['recovery', 'Recovery', '30 * 60 * 1000', '30 * MINUTE'],
  ['refresh', 'Refresh', '30 * 24 * 60 * 60 * 1000', '30 * DAY'],
  ['resetToken', 'ResetToken', '60 * 60 * 1000', 'HOUR'],
  ['session', 'Session', '8 * 60 * 60 * 1000', '8 * HOUR'],
  ['shareLink', 'ShareLink', '14 * 24 * 60 * 60 * 1000', '14 * DAY'],
  ['twoFactor', 'TwoFactor', '5 * 60 * 1000', '5 * MINUTE'],
  ['unsubscribe', 'Unsubscribe', '365 * 24 * 60 * 60 * 1000', '365 * DAY'],
  ['webhookReplay', 'WebhookReplay', '5 * 60 * 1000', '5 * MINUTE'],
];

function tokenBefore([kind, Name, ms]) {
  return src(
    "import { randomBytes } from 'node:crypto';",
    "import { tokens } from './token-store.js';",
    '',
    `const LIFETIME_MS = ${ms};`,
    '',
    `export async function issue${Name}(subject, now = Date.now()) {`,
    "  const value = randomBytes(24).toString('hex');",
    `  await tokens.put({ id: value, kind: '${kind}', subject, expiresAt: now + LIFETIME_MS });`,
    '  return value;',
    '}',
    '',
    `export async function check${Name}(value, now = Date.now()) {`,
    '  const row = await tokens.get(value);',
    `  if (!row || row.kind !== '${kind}') return null;`,
    '  if (row.expiresAt <= now) return null;',
    '  return row.subject;',
    '}',
  );
}

function tokenAfter([kind, Name]) {
  return src(
    "import { checkToken, issueToken } from './issue.js';",
    '',
    `export const issue${Name} = (subject, now) => issueToken('${kind}', subject, now);`,
    `export const check${Name} = (value, now) => checkToken('${kind}', value, now);`,
  );
}

export function tokenLifetimes({ name, title, body }) {
  const files = TOKEN_KINDS.map((t) => ({ path: `src/auth/${kebab(t[0])}.js`, before: tokenBefore(t), after: tokenAfter(t) }));
  files.push(
    {
      path: 'src/auth/issue.js',
      before: null,
      after: src(
        "import { randomBytes } from 'node:crypto';",
        "import { expiryFrom } from './lifetimes.js';",
        "import { tokens } from './token-store.js';",
        '',
        'export async function issueToken(kind, subject, now = Date.now()) {',
        "  const value = randomBytes(24).toString('hex');",
        '  await tokens.put({ id: value, kind, subject, expiresAt: expiryFrom(now, kind) });',
        '  return value;',
        '}',
        '',
        'export async function checkToken(kind, value, now = Date.now()) {',
        '  const row = await tokens.get(value);',
        '  if (!row || row.kind !== kind) return null;',
        '  if (row.expiresAt <= now) return null;',
        '  return row.subject;',
        '}',
      ),
    },
    {
      path: 'src/auth/lifetimes.js',
      before: null,
      after: src(
        'const MINUTE = 60;',
        'const HOUR = 60 * MINUTE;',
        'const DAY = 24 * HOUR;',
        '',
        '// How long each kind of token lasts, in seconds. Operators compare this table with the policy document.',
        'export const LIFETIME_SECONDS = {',
        TOKEN_KINDS.map(([kind, , , secs]) => `  ${kind}: ${secs},`),
        '};',
        '',
        'export function expiryFrom(now, kind) {',
        '  if (!Object.hasOwn(LIFETIME_SECONDS, kind)) throw new RangeError(`no lifetime for ${kind}`);',
        '  return now + LIFETIME_SECONDS[kind] * 1000;',
        '}',
      ),
    },
    {
      path: 'test/lifetimes.test.js',
      before: null,
      after: src(
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { checkSession, issueSession } from '../src/auth/session.js';",
        "import { expiryFrom, LIFETIME_SECONDS } from '../src/auth/lifetimes.js';",
        '',
        "test('every kind has a lifetime, and the table matches the policy', () => {",
        '  assert.equal(LIFETIME_SECONDS.session, 8 * 3600);',
        '  assert.equal(LIFETIME_SECONDS.resetToken, 3600);',
        '  assert.equal(LIFETIME_SECONDS.invite, 7 * 86400);',
        '  for (const seconds of Object.values(LIFETIME_SECONDS)) assert.ok(seconds > 0);',
        '});',
        '',
        "test('a token expires after it was issued', () => {",
        '  assert.ok(expiryFrom(1000, \'session\') > 1000);',
        "  assert.throws(() => expiryFrom(1000, 'nothing'), RangeError);",
        '});',
        '',
        "test('a session can be issued and checked', async () => {",
        '  const now = 1_000_000;',
        "  const value = await issueSession('someone', now);",
        "  assert.equal(await checkSession(value, now), 'someone');",
        '  assert.equal(await checkSession(\'not-a-token\', now), null);',
        '});',
      ),
    },
  );
  return {
    name, title, body, files,
    context: {
      'src/auth/token-store.js': src(
        'const rows = new Map();',
        '',
        'export const tokens = {',
        '  put: async (row) => rows.set(row.id, row),',
        '  get: async (id) => rows.get(id) ?? null,',
        '};',
      ),
    },
    area: 'src/auth',
    fault: { file: 'src/auth/lifetimes.js', right: 'return now + LIFETIME_SECONDS[kind] * 1000;', wrong: 'return now + LIFETIME_SECONDS[kind];' },
  };
}

// --- partial refunds ---------------------------------------------------------

const PROVIDERS = [
  ['alderpay', 'amount_cents', 'reference'], ['bluegate', 'amountMinor', 'ref'], ['cardhub', 'amount_minor', 'charge_id'], ['cedarpay', 'value', 'transaction'],
  ['fernbank', 'amount', 'payment_ref'], ['harbourpay', 'minor_units', 'reference'], ['kestrel', 'amountCents', 'chargeId'], ['larkwire', 'sum', 'ref'],
  ['meridian', 'amount_cents', 'charge'], ['northpay', 'amountMinor', 'paymentRef'], ['oakline', 'amount', 'reference'], ['quaypay', 'value_minor', 'ref'],
  ['ravenpay', 'amount_cents', 'transaction_id'], ['tidepay', 'amountMinor', 'charge'],
];

function providerBefore([name, amount, ref]) {
  return src(
    "import { post } from '../http.js';",
    '',
    `const BASE = 'https://api.${name}.example/v2';`,
    '',
    'export async function charge(payment) {',
    '  const response = await post(`${BASE}/charges`, {',
    `    ${amount}: payment.amount,`,
    '    currency: payment.currency,',
    `    ${ref}: payment.id,`,
    '  });',
    "  return { providerRef: response.id, status: response.state === 'paid' ? 'captured' : 'failed' };",
    '}',
  );
}

function providerAfter(row) {
  const [, amount] = row;
  return `${providerBefore(row)}${src(
    '',
    'export async function refund(payment, amount, reason) {',
    '  const response = await post(`${BASE}/refunds`, {',
    '    charge: payment.providerRef,',
    `    ${amount}: amount,`,
    '    note: reason,',
    '    idempotency_key: `${payment.id}:${payment.refunded ?? 0}:${amount}`,',
    '  });',
    "  return { providerRef: response.id, status: response.state === 'done' ? 'refunded' : 'failed' };",
    '}',
  )}`;
}

const REFUND_REPORTS = [
  ['by-reason', 'refundsByReason', 'reason'], ['by-actor', 'refundsByActor', 'actor'], ['by-payment', 'refundsByPayment', 'paymentId'],
  ['by-provider', 'refundsByProvider', 'provider'], ['by-currency', 'refundsByCurrency', 'currency'], ['by-day', 'refundsByDay', 'day'],
];

export function partialRefunds({ name, title, body }) {
  const files = PROVIDERS.map((p) => ({ path: `src/payments/providers/${p[0]}.js`, before: providerBefore(p), after: providerAfter(p) }));
  files.push(
    {
      path: 'src/refunds/service.js',
      before: null,
      after: src(
        "import { db } from '../db.js';",
        "import { providerFor } from '../payments/providers/index.js';",
        "import { appendToLedger } from './ledger.js';",
        "import { notifyRefund } from './notify.js';",
        "import { isKnownReason } from './reasons.js';",
        '',
        'export class RefundError extends Error {}',
        '',
        'async function loadPayment(paymentId) {',
        "  const rows = await db.table('payments').all();",
        '  return rows.find((row) => row.id === paymentId) ?? null;',
        '}',
        '',
        '// Amounts are whole minor units. A payment can be refunded in several parts, up to what was captured.',
        'export async function createRefund(paymentId, amount, reason, actor) {',
        '  const payment = await loadPayment(paymentId);',
        "  if (!payment) throw new RefundError('no such payment');",
        "  if (payment.status !== 'captured') throw new RefundError('only a captured payment can be refunded');",
        "  if (!Number.isInteger(amount) || amount <= 0) throw new RefundError('amount must be a whole number above zero');",
        '  if (!isKnownReason(reason)) throw new RefundError(`unknown reason: ${reason}`);',
        '  const refunded = payment.refunded ?? 0;',
        "  if (amount > payment.captured - refunded) throw new RefundError('amount is more than is left on this payment');",
        '',
        '  const result = await providerFor(payment.provider).refund(payment, amount, reason);',
        "  if (result.status !== 'refunded') throw new RefundError('the provider refused the refund');",
        '',
        "  const updated = await db.table('payments').put({ ...payment, refunded: refunded + amount });",
        '  const entry = await appendToLedger({ paymentId, amount, reason, actor, provider: payment.provider, currency: payment.currency, providerRef: result.providerRef });',
        '  await notifyRefund(updated, entry);',
        '  return entry;',
        '}',
      ),
    },
    {
      path: 'src/refunds/ledger.js',
      before: null,
      after: src(
        "import { db } from '../db.js';",
        '',
        '// Entries are only ever added: a mistake is put right by another entry.',
        'export const appendToLedger = (entry) => db.table(\'refund_ledger\').put({ ...entry, day: new Date().toISOString().slice(0, 10) });',
        '',
        "export const ledgerEntries = () => db.table('refund_ledger').all();",
        '',
        'export async function refundedSoFar(paymentId) {',
        '  const entries = await ledgerEntries();',
        '  return entries.filter((e) => e.paymentId === paymentId).reduce((sum, e) => sum + e.amount, 0);',
        '}',
      ),
    },
    {
      path: 'src/refunds/notify.js',
      before: null,
      after: src(
        'const listeners = new Set();',
        '',
        'export function onRefund(listener) {',
        '  listeners.add(listener);',
        '  return () => listeners.delete(listener);',
        '}',
        '',
        'export async function notifyRefund(payment, entry) {',
        '  for (const listener of listeners) await listener(payment, entry);',
        '}',
      ),
    },
    {
      path: 'src/refunds/reasons.js',
      before: null,
      after: src(
        "const REASONS = new Set(['customer-request', 'duplicate', 'fraud', 'damaged-goods', 'not-delivered', 'price-adjustment']);",
        '',
        'export const isKnownReason = (reason) => REASONS.has(reason);',
        'export const knownReasons = () => [...REASONS].sort();',
      ),
    },
    {
      path: 'src/refunds/routes.js',
      before: null,
      after: src(
        "import { knownReasons } from './reasons.js';",
        "import { createRefund, RefundError } from './service.js';",
        '',
        'export async function postRefund(req) {',
        "  if (!req.user?.permissions?.includes('refunds.create')) return { status: 403, body: { error: 'forbidden' } };",
        '  try {',
        '    const entry = await createRefund(req.params.paymentId, req.body.amount, req.body.reason, req.user.id);',
        '    return { status: 201, body: entry };',
        '  } catch (err) {',
        '    if (err instanceof RefundError) return { status: 422, body: { error: err.message } };',
        '    throw err;',
        '  }',
        '}',
        '',
        'export const getReasons = async () => ({ status: 200, body: knownReasons() });',
      ),
    },
    ...REFUND_REPORTS.map(([file, fn, key]) => ({
      path: `src/reports/refunds-${file}.js`,
      before: null,
      after: src(
        "import { ledgerEntries } from '../refunds/ledger.js';",
        '',
        `export async function ${fn}() {`,
        '  const totals = new Map();',
        '  for (const entry of await ledgerEntries()) {',
        `    const key = entry.${key};`,
        '    const seen = totals.get(key) ?? { count: 0, amount: 0 };',
        '    totals.set(key, { count: seen.count + 1, amount: seen.amount + entry.amount });',
        '  }',
        '  return [...totals].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.amount - a.amount);',
        '}',
      ),
    })),
    {
      path: 'docs/refunds.md',
      before: null,
      after: src(
        '# Refunds',
        '',
        'A captured payment can be refunded in parts. The total refunded on a payment can never go over what was captured.',
        '',
        'The service checks the request, asks the provider, then records the result. A provider call can fail: nothing is recorded unless it worked.',
        'The idempotency key includes what was refunded so far, so retrying a request that did reach the provider cannot refund twice.',
        '',
        'The ledger is what the finance reports are built from, and entries in it are never changed.',
      ),
    },
    {
      path: 'test/refunds.test.js',
      before: null,
      after: src(
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { db } from '../src/db.js';",
        "import { registerProvider } from '../src/payments/providers/index.js';",
        "import { createRefund, RefundError } from '../src/refunds/service.js';",
        '',
        "registerProvider('stub', { refund: async () => ({ status: 'refunded', providerRef: 'stub-1' }) });",
        '',
        "const captured = (id) => db.table('payments').put({ id, provider: 'stub', status: 'captured', captured: 1000, currency: 'GBP' });",
        '',
        "test('a refund is recorded', async () => {",
        "  await captured('p1');",
        "  const entry = await createRefund('p1', 400, 'duplicate', 'someone');",
        '  assert.equal(entry.amount, 400);',
        '});',
        '',
        "test('refuses a refund over the captured amount', async () => {",
        "  await captured('p2');",
        "  await assert.rejects(() => createRefund('p2', 1001, 'duplicate', 'someone'), RefundError);",
        '});',
        '',
        "test('refuses bad input', async () => {",
        "  await captured('p3');",
        "  await assert.rejects(() => createRefund('p3', 0, 'duplicate', 'someone'), RefundError);",
        "  await assert.rejects(() => createRefund('p3', 10, 'no-such-reason', 'someone'), RefundError);",
        "  await assert.rejects(() => createRefund('nothing', 10, 'duplicate', 'someone'), RefundError);",
        '});',
      ),
    },
  );
  return {
    name, title, body, files,
    context: {
      'src/db.js': DB,
      'src/payments/http.js': src(
        'export async function post(url, body) {',
        "  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });",
        '  if (!response.ok) throw new Error(`${url} answered ${response.status}`);',
        '  return response.json();',
        '}',
      ),
      'src/payments/providers/index.js': src(
        PROVIDERS.map(([p]) => `import * as ${p} from './${p}.js';`),
        '',
        `const registry = new Map(Object.entries({ ${PROVIDERS.map(([p]) => p).join(', ')} }));`,
        '',
        'export const registerProvider = (name, provider) => registry.set(name, provider);',
        '',
        'export function providerFor(name) {',
        '  const provider = registry.get(name);',
        '  if (!provider) throw new Error(`no provider called ${name}`);',
        '  return provider;',
        '}',
      ),
    },
    area: 'src/refunds',
    fault: {
      file: 'src/refunds/service.js',
      right: 'if (amount > payment.captured - refunded) throw',
      wrong: 'if (amount > payment.captured) throw',
    },
  };
}

// --- attachments go through one path helper ----------------------------------

function attachmentBefore(e) {
  return src(
    "import { readFile, stat } from 'node:fs/promises';",
    "import { resolve, sep } from 'node:path';",
    "import { ATTACHMENT_ROOT } from '../config.js';",
    '',
    `const ROOT = resolve(ATTACHMENT_ROOT, '${e.plural}');`,
    '',
    'function locate(name) {',
    '  const path = resolve(ROOT, name);',
    `  if (!path.startsWith(ROOT + sep)) throw new Error('that name is outside the ${e.plural} folder');`,
    '  return path;',
    '}',
    '',
    `export const read${e.Name}File = (name) => readFile(locate(name));`,
    '',
    `export async function ${e.name}FileSize(name) {`,
    '  const info = await stat(locate(name));',
    '  return info.size;',
    '}',
  );
}

function attachmentAfter(e) {
  return src(
    "import { readFile, stat } from 'node:fs/promises';",
    "import { resolve } from 'node:path';",
    "import { ATTACHMENT_ROOT } from '../config.js';",
    "import { insideFolder } from './safe-path.js';",
    '',
    `const ROOT = resolve(ATTACHMENT_ROOT, '${e.plural}');`,
    '',
    `export const read${e.Name}File = (name) => readFile(insideFolder(ROOT, name));`,
    '',
    `export async function ${e.name}FileSize(name) {`,
    '  const info = await stat(insideFolder(ROOT, name));',
    '  return info.size;',
    '}',
  );
}

export function attachmentPaths({ name, count, title, body }) {
  const entities = around('report', count);
  const files = entities.map((e) => ({ path: `src/files/handlers/${e.file}.js`, before: attachmentBefore(e), after: attachmentAfter(e) }));
  files.push(
    {
      path: 'src/files/handlers/safe-path.js',
      before: null,
      after: src(
        "import { resolve, sep } from 'node:path';",
        '',
        'export class OutsideFolder extends Error {}',
        '',
        '// An attachment name comes from a request, so every one goes through here before it reaches the disk.',
        'export function insideFolder(folder, name) {',
        '  const root = resolve(folder);',
        '  const path = resolve(root, name);',
        '  if (!path.startsWith(root + sep)) throw new OutsideFolder(`${name} is outside ${root}`);',
        '  return path;',
        '}',
      ),
    },
    {
      path: 'docs/attachments.md',
      before: null,
      after: src(
        '# Attachments',
        '',
        'Each record type keeps its files in a folder of its own under the attachment root. The names come from requests and cannot be trusted, so the',
        'handlers turn a name into a path only through `insideFolder`, which refuses anything that would land outside that folder.',
      ),
    },
    {
      path: 'test/safe-path.test.js',
      before: null,
      after: src(
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { insideFolder, OutsideFolder } from '../src/files/handlers/safe-path.js';",
        '',
        "test('a plain name stays in the folder', () => {",
        "  assert.equal(insideFolder('/srv/files', 'a.txt'), '/srv/files/a.txt');",
        "  assert.equal(insideFolder('/srv/files', 'sub/a.txt'), '/srv/files/sub/a.txt');",
        '});',
        '',
        "test('climbing out is refused', () => {",
        "  assert.throws(() => insideFolder('/srv/files', '../outside.txt'), OutsideFolder);",
        "  assert.throws(() => insideFolder('/srv/files', '../../outside.txt'), OutsideFolder);",
        "  assert.throws(() => insideFolder('/srv/files', '/somewhere/else.txt'), OutsideFolder);",
        '});',
      ),
    },
  );
  return {
    name, title, body, files,
    context: { 'src/files/config.js': src("export const ATTACHMENT_ROOT = process.env.ATTACHMENT_ROOT ?? '/srv/attachments';") },
    area: 'src/files/handlers',
    fault: {
      file: 'src/files/handlers/safe-path.js',
      right: 'if (!path.startsWith(root + sep)) throw',
      wrong: 'if (!path.startsWith(root)) throw',
      also: [{ right: "import { resolve, sep } from 'node:path';", wrong: "import { resolve } from 'node:path';" }],
    },
  };
}

// --- emails move onto one layout ----------------------------------------------

function emailBefore(e) {
  return src(
    "import { esc } from '../escape.js';",
    '',
    `export function ${e.name}Updated({ recipient, ${e.name} }) {`,
    '  return [',
    "    '<!doctype html>',",
    "    '<html>',",
    "    '<body style=\"font-family: sans-serif; color: #222\">',",
    "    '<table width=\"600\" align=\"center\"><tr><td>',",
    `    '<h1>${label(e.name)} updated</h1>',`,
    '    `<p>Hello ${esc(recipient.name)},</p>`,',
    "    '<ul>',",
    e.fields.map((f) => `    \`<li>${label(f)}: \${esc(${e.name}.${f})}</li>\`,`),
    "    '</ul>',",
    "    '<p>Reply to this message if anything looks wrong.</p>',",
    "    '</td></tr></table>',",
    "    '</body>',",
    "    '</html>',",
    "  ].join('\\n');",
    '}',
  );
}

function emailAfter(e) {
  return src(
    "import { esc } from '../escape.js';",
    "import { layout } from '../layout.js';",
    '',
    `export function ${e.name}Updated({ recipient, ${e.name} }) {`,
    '  return layout({',
    `    heading: '${label(e.name)} updated',`,
    '    greeting: esc(recipient.name),',
    '    rows: [',
    e.fields.map((f) => `      \`${label(f)}: \${esc(${e.name}.${f})}\`,`),
    '    ],',
    '  });',
    '}',
  );
}

export function emailTemplates({ name, count, title, body }) {
  const entities = around('review', count);
  const files = entities.map((e) => ({ path: `src/email/templates/${e.file}.js`, before: emailBefore(e), after: emailAfter(e) }));
  const first = entities[0];
  files.push(
    {
      path: 'src/email/layout.js',
      before: null,
      after: src(
        '// `heading` is our own text. `greeting` and `rows` are HTML, so a template must have escaped anything it put in them.',
        'export function layout({ heading, greeting, rows }) {',
        '  return [',
        "    '<!doctype html>',",
        "    '<html>',",
        "    '<body style=\"font-family: sans-serif; color: #222\">',",
        "    '<table width=\"600\" align=\"center\"><tr><td>',",
        '    `<h1>${heading}</h1>`,',
        '    `<p>Hello ${greeting},</p>`,',
        "    '<ul>',",
        '    ...rows.map((row) => `<li>${row}</li>`),',
        "    '</ul>',",
        "    '<p>Reply to this message if anything looks wrong.</p>',",
        "    '</td></tr></table>',",
        "    '</body>',",
        "    '</html>',",
        "  ].join('\\n');",
        '}',
      ),
    },
    {
      path: 'docs/email.md',
      before: null,
      after: src(
        '# Emails',
        '',
        'Each template in `src/email/templates` fills in `layout()`. Values come from customers, so a template escapes each one with `esc` before it',
        'goes into a row. The layout does not escape anything, because a row can hold markup of our own.',
      ),
    },
    {
      path: 'test/email.test.js',
      before: null,
      after: src(
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        `import { ${first.name}Updated } from '../src/email/templates/${first.file}.js';`,
        '',
        "test('a template fills in the layout and escapes what it is given', () => {",
        `  const html = ${first.name}Updated({ recipient: { name: 'A & B' }, ${first.name}: { ${first.fields.map((f) => `${f}: '<i>x</i>'`).join(', ')} } });`,
        "  assert.ok(html.includes('Hello A &amp; B,'));",
        "  assert.ok(!html.includes('<i>'));",
        "  assert.ok(html.startsWith('<!doctype html>'));",
        '});',
      ),
    },
  );
  return {
    name, title, body, files,
    context: {
      'src/email/escape.js': src("export const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');"),
    },
    area: 'src/email/templates',
    fault: { file: 'src/email/templates/review.js', right: '`Comment: ${esc(review.comment)}`', wrong: '`Comment: ${review.comment}`' },
  };
}
