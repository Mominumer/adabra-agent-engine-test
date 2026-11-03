import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnvironment, gitRunner, prepareCommit } from '../night/publish.js';
import { MAX_DIFF_BYTES, MAX_FILES, PROTECTED_WORDS, RULES, agreeWithBase, agreeWithGit, agreeWithTree, credentialShaped, pathRefusal, protectedWord, validateDiff } from '../night/validate.js';
import { makeRemote, needsGit } from './fixtures/night-stack.js';

const scratch = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'adabra-night-validate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Built in pieces, so this file does not itself hold anything shaped like a credential.
const SECRET = {
  modelKey: `${'sk-'}${'ant-'}${'x'.repeat(30)}`,
  modelToken: `${'sk-'}${'ant-oat01-'}${'y'.repeat(30)}`,
  apiKey: `${'sk-'}${'z'.repeat(40)}`,
  classicToken: `${'ghp'}_${'a'.repeat(36)}`,
  installationToken: `${'ghs'}_${'b'.repeat(36)}`,
  fineGrained: `${'github'}_pat_${'c'.repeat(40)}`,
  jwt: `${'eyJ'}${'d'.repeat(20)}.${'e'.repeat(20)}.${'f'.repeat(20)}`,
  bearer: `${'Bear'}er abcdefghij`,
  privateKey: `-----BEGIN ${'RSA PRIVATE'} KEY-----`,
  aws: `${'AKIA'}${'A'.repeat(16)}`,
  google: `${'AIza'}${'g'.repeat(35)}`,
  slack: `${'xoxb'}-${'1'.repeat(20)}`,
};

// --- the shapes `git diff` prints ---
const OLD = '4cb29ea';
const NEW = 'a2c4a78';
const modified = (path = 'a.txt', { added = ['added'], mode = '100644' } = {}) => [
  `diff --git a/${path} b/${path}`,
  `index ${OLD}..${NEW} ${mode}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  `@@ -1,2 +1,${2 + added.length} @@`,
  ' one',
  ...added.map((l) => `+${l}`),
  ' two',
  '',
].join('\n');
const newFile = (path, lines = ['hello'], mode = '100644') => [
  `diff --git a/${path} b/${path}`,
  `new file mode ${mode}`,
  `index 0000000..${NEW}`,
  '--- /dev/null',
  `+++ b/${path}`,
  `@@ -0,0 +1${lines.length === 1 ? '' : `,${lines.length}`} @@`,
  ...lines.map((l) => `+${l}`),
  '',
].join('\n');
const deleted = (path = 'gone.txt') => [
  `diff --git a/${path} b/${path}`,
  'deleted file mode 100644',
  `index ${OLD}..0000000`,
  `--- a/${path}`,
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  '',
].join('\n');

const refusedAs = (diff) => {
  const r = validateDiff(diff);
  assert.equal(r.ok, false, 'expected a refusal');
  return r.rule;
};

test('the words a refusal can hold are a closed list, and none of them can carry what the diff says', () => {
  assert.ok(RULES.every((r) => /^[a-z0-9_]+$/.test(r)));
  for (const diff of [modified('a b'), newFile('.github/workflows/planted-name.yml'), `garbage planted-name\n`]) {
    const r = validateDiff(diff);
    assert.equal(r.ok, false);
    assert.ok(RULES.includes(r.rule));
    assert.ok(r.word === null || PROTECTED_WORDS.includes(r.word));
    assert.doesNotMatch(JSON.stringify(r), /planted-name/);
  }
});

test('accepts what git diff prints for ordinary changes', () => {
  const r = validateDiff(`${modified()}${newFile('src/new.js', ['a', 'b'])}${deleted()}`);
  assert.equal(r.ok, true);
  assert.deepEqual(r.totals, { files: 3, added: 1, modified: 1, deleted: 1, addedLines: 3, removedLines: 1 });
  assert.deepEqual(r.files.map((f) => [f.path, f.status, f.mode, f.added, f.removed]), [
    ['a.txt', 'modified', '100644', 1, 0],
    ['src/new.js', 'added', '100644', 2, 0],
    ['gone.txt', 'deleted', '100644', 0, 1],
  ]);
});

test('accepts empty files, a new executable, several hunks, and files with no last newline', () => {
  const emptyNew = 'diff --git a/e.txt b/e.txt\nnew file mode 100644\nindex 0000000..e69de29\n';
  const emptyGone = 'diff --git a/f.txt b/f.txt\ndeleted file mode 100644\nindex e69de29..0000000\n';
  assert.equal(validateDiff(`${emptyNew}${emptyGone}`).ok, true);
  assert.equal(validateDiff(newFile('tool.sh', ['#!/bin/sh'], '100755')).ok, true);
  const twoHunks = [
    'diff --git a/a.txt b/a.txt', `index ${OLD}..${NEW} 100644`, '--- a/a.txt', '+++ b/a.txt',
    '@@ -1,2 +1,3 @@ function first()', ' one', '+x', ' two',
    '@@ -10,2 +11,2 @@', ' ten', '-old', '+new', '',
  ].join('\n');
  assert.equal(validateDiff(twoHunks).ok, true);
  const noNewline = [
    'diff --git a/a.txt b/a.txt', `index ${OLD}..${NEW} 100644`, '--- a/a.txt', '+++ b/a.txt',
    '@@ -1 +1 @@', '-old', '\\ No newline at end of file', '+new', '\\ No newline at end of file', '',
  ].join('\n');
  assert.equal(validateDiff(noNewline).ok, true);
});

// Each row is the first thing the parser must not understand or accept. A row of real-looking text with one change in it.
const HUNKS = 'diff --git a/a.txt b/a.txt\nindex 4cb29ea..a2c4a78 100644\n--- a/a.txt\n+++ b/a.txt\n';
const STRUCTURE_ROWS = {
  'text before the first file': [`Subject: looks like a patch\n\n${modified()}`, 'unparsed'],
  'text after the last hunk': [`${modified()}trailing words\n`, 'unparsed'],
  'text between two files': [`${modified()}\n${newFile('b.txt')}`, 'unparsed'],
  'an old-style patch with no diff --git line': ['--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n', 'unparsed'],
  'an old-style patch hidden after a real one': [`${modified()}--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-x\n+y\n`, 'unparsed'],
  'an extra line beyond the counts': [`${modified()}+one more\n`, 'unparsed'],
  'fewer lines than the counts say': [HUNKS + '@@ -1,2 +1,3 @@\n one\n+x\n', 'unparsed'],
  'a blank line standing in for a context line': [HUNKS + '@@ -1,2 +1,3 @@\n one\n+x\n\n', 'unparsed'],
  'no last newline': [modified().slice(0, -1), 'unparsed'],
  'a marker line git would also accept': [HUNKS + '@@ -1 +1 @@\n-x\n+y\n\\ anything long enough at all\n', 'unparsed'],
  'a hunk of context only': [HUNKS + '@@ -1 +1 @@\n x\n', 'unparsed'],
  'a hunk header with leading zeros': [HUNKS + '@@ -01 +01 @@\n-x\n+y\n', 'unparsed'],
  'hunks that overlap': [HUNKS + '@@ -5,1 +5,1 @@\n-x\n+y\n@@ -1,1 +1,1 @@\n-a\n+b\n', 'unparsed'],
  'a file with no hunks': [HUNKS + '', 'unparsed'],
  'headers with no index line': ['diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n', 'unparsed'],
  'an index line with no mode': ['diff --git a/a.txt b/a.txt\nindex 4cb29ea..a2c4a78\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n', 'unparsed'],
  'a new file that claims an old name': ['diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..a2c4a78\n--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1 @@\n+x\n', 'unparsed'],
  'a new file whose +++ names another file': ['diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..a2c4a78\n--- /dev/null\n+++ b/.github/x\n@@ -0,0 +1 @@\n+x\n', 'unparsed'],
  'a change whose --- names another file': ['diff --git a/a.txt b/a.txt\nindex 4cb29ea..a2c4a78 100644\n--- a/.github/x\n+++ b/a.txt\n@@ -1 +1 @@\n-x\n+y\n', 'unparsed'],
  'a new file with an empty text that is not empty': ['diff --git a/a.txt b/a.txt\nnew file mode 100644\nindex 0000000..a2c4a78\n', 'unparsed'],
  'windows line endings in the headers': [modified().replaceAll('\n', '\r\n'), 'path_unsafe'],
  'a byte order mark first': [`\uFEFF${modified()}`, 'unparsed'],
  'text that is not UTF-8': [Buffer.concat([Buffer.from(`${modified()}`.slice(0, -1)), Buffer.from([0xff, 0xfe, 0x0a])]), 'not_utf8'],
  'no prefix on the names': ['diff --git a.txt a.txt\nindex 4cb29ea..a2c4a78 100644\n--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-x\n+y\n', 'path_unsafe'],
};

test('anything this parser does not fully understand is refused, not skipped', async (t) => {
  for (const [name, [diff, rule]] of Object.entries(STRUCTURE_ROWS)) {
    await t.test(name, () => assert.equal(refusedAs(diff), rule));
  }
});

// The rows of section 7's list.
const SHAPE_ROWS = {
  'a binary patch': [`diff --git a/x.bin b/x.bin\nindex ${OLD}..${NEW} 100644\nGIT binary patch\nliteral 3\nKcmZQzU|?VY0ssI2\n\n`, 'binary'],
  'a binary file git will not show': [`diff --git a/x.bin b/x.bin\nindex ${OLD}..${NEW} 100644\nBinary files a/x.bin and b/x.bin differ\n`, 'binary'],
  'a NUL anywhere': [`${modified().slice(0, 40)}\0${modified().slice(40)}`, 'binary'],
  'a new symlink': [newFile('link', ['/etc/passwd'], '120000'), 'symlink'],
  'a change to a symlink': [modified('link', { mode: '120000' }), 'symlink'],
  'a new submodule': [newFile('sub', ['Subproject commit 0000000000000000000000000000000000000000'], '160000'), 'submodule'],
  'a changed submodule': [modified('sub', { mode: '160000' }), 'submodule'],
  'a submodule summary line': ['Submodule sub 0000000..1111111:\n', 'submodule'],
  'an unknown mode': [newFile('x', ['a'], '100664'), 'mode_unknown'],
  'a mode change': ['diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n', 'mode_change'],
  'a mode change with a change': [`diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\nindex ${OLD}..${NEW}\n--- a/run.sh\n+++ b/run.sh\n@@ -1 +1 @@\n-x\n+y\n`, 'mode_change'],
  'a rename': ['diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n', 'rename_or_copy'],
  'a rename with the same name twice': ['diff --git a/x b/x\nsimilarity index 100%\nrename from x\nrename to y\n', 'rename_or_copy'],
  'a copy': ['diff --git a/x b/y\nsimilarity index 100%\ncopy from x\ncopy to y\n', 'rename_or_copy'],
  'a dissimilarity line': ['diff --git a/x b/x\ndissimilarity index 90%\n', 'rename_or_copy'],
};

test('binary, links, submodules, modes, renames and copies are refused', async (t) => {
  for (const [name, [diff, rule]] of Object.entries(SHAPE_ROWS)) {
    await t.test(name, () => assert.equal(refusedAs(diff), rule));
  }
});

const UNSAFE_PATHS = {
  absolute: '/etc/passwd',
  'with ..': '../outside.txt',
  '.. in the middle': 'a/../../outside.txt',
  '. in the middle': 'a/./b.txt',
  'a double slash': 'a//b.txt',
  'a tab': 'a\tb.txt',
  'a carriage return': 'a\rb.txt',
  'an escape': 'a\u001b[31mb.txt',
  'a delete': 'a\u007fb.txt',
  'a space': 'a b.txt',
  'a backslash': 'a\\b.txt',
  'a quote': 'a"b.txt',
  'a zero-width space': 'a\u200Bb.txt',
  'a bidi override': 'a\u202Eb.txt',
  'a tag character': 'a\u{E0041}b.txt',
  'a soft hyphen': 'a\u00ADb.txt',
  'a non-breaking space': 'a\u00A0b.txt',
  'any letter outside plain ASCII': 'caf\u00E9.txt',
  'a leading dash': '-rf',
  'a trailing dot': 'file.',
  'very long': `${'a'.repeat(250)}.txt`,
  'a very long segment': `${'a'.repeat(120)}/b.txt`,
};

test('paths: absolute, .., control and invisible characters are refused, by the alphabet and not by a list of bad ones', async (t) => {
  for (const [name, path] of Object.entries(UNSAFE_PATHS)) {
    await t.test(name, () => {
      assert.equal(pathRefusal(path)?.rule, 'path_unsafe');
      assert.equal(validateDiff(newFile(path)).ok, false);
    });
  }
  await t.test('a quoted path is refused, whatever it decodes to', () => {
    assert.equal(refusedAs(`diff --git "a/x\\303\\251" "b/x\\303\\251"\nnew file mode 100644\nindex 0000000..a2c4a78\n--- /dev/null\n+++ "b/x\\303\\251"\n@@ -0,0 +1 @@\n+x\n`), 'path_unsafe');
  });
  await t.test('ordinary names pass', () => {
    for (const path of ['a.txt', 'src/deep/er/file.test.js', '.eslintrc', 'lib/c++/x_y-z.h']) assert.equal(pathRefusal(path), null, path);
  });
});

const PROTECTED = {
  '.git*': ['.git/config', '.git/hooks/pre-push', 'sub/.git/config', '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', 'src/.gitattributes', '.GIT/config', '.GitIgnore', '.gItAtTrIbUtEs', 'git~1/config'],
  '.github/': ['.github/workflows/x.yml', '.GITHUB/workflows/x.yml', 'sub/.github/x', '.GitHub/CODEOWNERS'],
  '.claude/': ['.claude/settings.json', '.CLAUDE/settings.json', 'sub/.claude/agents/x.md', '.Claude/x'],
  CODEOWNERS: ['CODEOWNERS', 'docs/CODEOWNERS', 'codeowners', 'CodeOwners'],
  'CLAUDE.md': ['CLAUDE.md', 'src/CLAUDE.md', 'claude.md', 'Claude.MD'],
  'CLAUDE.local.md': ['CLAUDE.local.md', 'sub/claude.local.md'],
  'AGENTS.md': ['AGENTS.md', 'agents.md', 'sub/Agents.Md'],
  '.mcp.json': ['.mcp.json', '.MCP.JSON', 'sub/.mcp.json'],
  '.task/': ['.task/TASK.md'],
  'node_modules/': ['node_modules/.bin/node', 'src/node_modules/x.js', 'NODE_MODULES/x'],
  '.npmrc': ['.npmrc', 'sub/.NPMRC'],
  '.yarnrc': ['.yarnrc', '.yarnrc.yml'],
  '.pnpmfile.cjs': ['.pnpmfile.cjs'],
  '.envrc': ['.envrc', 'sub/.envrc'],
  '.husky/': ['.husky/pre-commit'],
  '.vscode/': ['.vscode/tasks.json', '.VSCode/settings.json'],
  '.devcontainer/': ['.devcontainer/devcontainer.json'],
};

test('protected names are refused at any depth, in any case', async (t) => {
  for (const [word, paths] of Object.entries(PROTECTED)) {
    for (const path of paths) {
      await t.test(path, () => {
        const r = validateDiff(newFile(path));
        assert.equal(r.ok, false);
        assert.equal(r.rule, 'protected_path');
        assert.equal(r.word, word);
        assert.equal(r.file, 1);
      });
    }
  }
  await t.test('names that only look similar pass', () => {
    for (const path of ['gitignore', 'src/git.js', 'agents.md.txt', 'claude.txt', 'my.claude/x', 'codeowners.txt']) assert.equal(pathRefusal(path), null, path);
  });
});

test('Unicode spellings of protected names fold to them, as clean-worker.cjs does, and git may print them raw or quoted', async (t) => {
  const variants = {
    'a long s': ['AGENT\u017F.md', 'AGENTS.md'],
    'fullwidth letters': ['\uFF23\uFF2C\uFF21\uFF35\uFF24\uFF25.md', 'CLAUDE.md'],
    'a look-alike in .git': ['.g\u0456t', null], // a Cyrillic i folds to nothing else: refused by the alphabet instead
    'a zero-width joiner in .git': ['.g\u200Cit/config', '.git*'],
    'a soft hyphen in .github': ['.git\u00ADhub/x', '.github/'],
    'a fullwidth dot': ['\uFF0Eclaude/settings.json', '.claude/'],
  };
  for (const [name, [path, word]] of Object.entries(variants)) {
    await t.test(name, () => {
      assert.equal(protectedWord(path), word);
      assert.equal(validateDiff(newFile(path)).ok, false, 'printed raw, as with core.quotePath off, which the session controls');
      const octal = [...Buffer.from(path)].map((b) => (b < 0x80 ? String.fromCharCode(b) : `\\${b.toString(8)}`)).join('');
      assert.equal(validateDiff(newFile(`"${octal}"`)).ok, false, 'printed quoted, as git does by default');
    });
  }
});

test('an added line holding what a reader cannot see is refused, naming only the file\'s place', async (t) => {
  const hidden = {
    'a CR inside the line': '// tidy later\rrun();',
    'U+2028': '// tidy later\u2028run();',
    'U+2029': '// tidy later\u2029run();',
    'next line, U+0085': '// tidy later\u0085run();',
    'an escape sequence': 'fine\u001b[2K',
    'a bidi control': 'a\u202Eb',
    'a zero-width space': 'a\u200Bb',
    'a byte order mark': '\uFEFFa',
    'a tag character': 'a\u{E0041}b',
    'a form feed': 'a\fb',
    'a CR at the end, and another before it': 'a\r\r',
  };
  for (const [name, line] of Object.entries(hidden)) {
    await t.test(name, () => {
      const r = validateDiff(`${newFile('fine.txt')}${newFile('x.js', [line])}`);
      assert.deepEqual({ ...r }, { ok: false, rule: 'hidden_character', file: 2, word: null });
    });
  }
  await t.test('a tab, a CRLF line and ordinary text all pass', () => {
    for (const line of ['\tindented', 'windows line\r', 'caf\u00E9 \u4F60\u597D \u{1F600}', 'a\tb\r']) assert.equal(validateDiff(newFile('x.js', [line])).ok, true, JSON.stringify(line));
  });
});

test('credential shapes: refused in added lines and in paths, and left alone in lines that were already there', async (t) => {
  for (const [name, secret] of Object.entries(SECRET)) {
    await t.test(name, () => {
      assert.equal(credentialShaped(secret), true);
      const r = validateDiff(`${newFile('safe.txt')}${modified('src/a.js', { added: [`const x = '${secret}';`] })}`);
      assert.equal(r.ok, false);
      assert.equal(r.rule, 'credential');
      assert.equal(r.file, 2);
      assert.doesNotMatch(JSON.stringify(r), new RegExp(secret.slice(0, 8).replace(/[-]/g, '\\-')));
    });
  }
  await t.test('in a path', () => {
    assert.equal(pathRefusal(`${SECRET.classicToken}.txt`)?.rule, 'credential');
    assert.equal(refusedAs(newFile(`src/${SECRET.classicToken}.txt`)), 'credential');
  });
  await t.test('in a new file', () => assert.equal(refusedAs(newFile('x.txt', ['fine', SECRET.modelToken])), 'credential'));
  await t.test('a private key across lines', () => assert.equal(refusedAs(newFile('k.pem', [SECRET.privateKey, 'abc'])), 'credential'));
  await t.test('a line already there is not the session\'s to answer for', () => {
    const context = `diff --git a/a.txt b/a.txt\nindex ${OLD}..${NEW} 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n ${SECRET.bearer}\n+x\n two\n`;
    assert.equal(validateDiff(context).ok, true);
    const removed = `diff --git a/a.txt b/a.txt\nindex ${OLD}..${NEW} 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-${SECRET.bearer}\n+x\n`;
    assert.equal(validateDiff(removed).ok, true);
  });
  await t.test('ordinary text passes', () => assert.equal(credentialShaped('const task = "sk-1"; // asks for a token'), false));
});

test('the size limits are the reviewer\'s own, and reaching the file limit counts as over', () => {
  assert.equal(refusedAs(''), 'no_changes');
  assert.equal(refusedAs(Buffer.alloc(0)), 'no_changes');
  const big = newFile('big.txt', ['x'.repeat(MAX_DIFF_BYTES)]);
  assert.equal(refusedAs(big), 'too_large');
  const justUnder = Array.from({ length: MAX_FILES - 1 }, (_, i) => newFile(`f${i}.txt`)).join('');
  assert.equal(validateDiff(justUnder).ok, true);
  const atLimit = Array.from({ length: MAX_FILES }, (_, i) => newFile(`f${i}.txt`)).join('');
  assert.equal(refusedAs(atLimit), 'too_many_files');
});

test('two names for one file are refused: the same path twice, case variants, and a file that is also a folder', () => {
  assert.equal(refusedAs(`${newFile('a.txt')}${newFile('a.txt')}`), 'path_collision');
  assert.equal(refusedAs(`${newFile('README.md')}${newFile('readme.md')}`), 'path_collision');
  assert.equal(refusedAs(`${newFile('a')}${newFile('a/b.txt')}`), 'path_collision');
  assert.equal(refusedAs(`${newFile('a/b.txt')}${newFile('a')}`), 'path_collision');
  assert.equal(refusedAs(`${newFile('Dir/one.txt')}${newFile('dir')}`), 'path_collision');
  assert.equal(validateDiff(`${newFile('a/b.txt')}${newFile('a/c.txt')}`).ok, true);
});

test('a path that a disk ignoring case reads as one already at the pinned commit is refused: the file, or any folder on the way', () => {
  const listed = 'service/ops.sh\0src/deep/a.js\0README.md\0Docs/a.md\0docs/b.md\0';
  const check = (diff) => agreeWithBase({ validated: validateDiff(diff), listed });
  for (const path of ['Service/ops.sh', 'SERVICE/new.sh', 'readme.md', 'src/DEEP/b.js', 'SRC/new.js', 'DOCS/c.md']) {
    assert.deepEqual({ ...check(newFile(path)) }, { ok: false, rule: 'path_collision', file: 1, word: null }, path);
  }
  assert.equal(check(`${newFile('src/fine.js')}${newFile('SERVICE/new.sh')}`).file, 2, 'it says which file, and not its name');
  for (const path of ['service/new.sh', 'src/deep/b.js', 'other/x.js', 'Docs/c.md', 'docs/c.md']) assert.equal(check(newFile(path)).ok, true, path);
  assert.equal(check(modified('README.md')).ok, true, 'spelt as it is there');
});

// --- against the real git ---
const hermetic = (dir) => ({ PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@invalid' });
const gitIn = (cwd, args, input) => spawnSync('git', args, { cwd, env: hermetic(cwd), ...(input === undefined ? {} : { input: Buffer.from(input) }), encoding: 'buffer' });

// A plain repository with a working tree, which is exactly what publish.js does not use: to see what a patch means to git, and what it
// would do to the disk with nothing in the way.
function plainRepo(t) {
  const dir = scratch(t);
  const repo = join(dir, 'parent', 'repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(dir, 'parent', 'canary.txt'), 'untouched\n');
  gitIn(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(repo, 'run.sh'), 'x\n');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-q', '-m', 'base']);
  return { dir, repo, parent: join(dir, 'parent') };
}

test('real git: what the export prints is accepted, and agrees with git\'s own reading', needsGit, async (t) => {
  const dir = scratch(t);
  const { work } = makeRemote(dir, { 'keep.txt': 'one\ntwo\nthree\n', 'nolf.txt': 'no newline', 'gone.txt': 'bye\n', 'empty-gone.txt': '', 'tool.sh': '#!/bin/sh\n' });
  chmodSync(join(work, 'tool.sh'), 0o755);
  gitIn(work, ['add', '-A']);
  gitIn(work, ['commit', '-q', '-m', 'exec bit']);
  writeFileSync(join(work, 'keep.txt'), 'one\nchanged\nthree\nfour\n');
  writeFileSync(join(work, 'nolf.txt'), 'still no newline');
  writeFileSync(join(work, 'tool.sh'), '#!/bin/sh\necho hi\n');
  rmSync(join(work, 'gone.txt'));
  rmSync(join(work, 'empty-gone.txt'));
  writeFileSync(join(work, 'added.txt'), 'new\nlines\n');
  writeFileSync(join(work, 'added-empty.txt'), '');
  mkdirSync(join(work, 'deep', 'er'), { recursive: true });
  writeFileSync(join(work, 'deep', 'er', 'file.js'), 'x\n');
  writeFileSync(join(work, 'exec.sh'), '#!/bin/sh\n');
  chmodSync(join(work, 'exec.sh'), 0o755);
  gitIn(work, ['add', '-A']);
  const diff = gitIn(work, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color']).stdout;
  const r = validateDiff(diff);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.totals, { files: 9, added: 4, modified: 3, deleted: 2, addedLines: 8, removedLines: 3 });
  const agreed = await agreeWithGit({ diff, validated: r, git: (args, { input }) => new Promise((resolve) => {
    const out = gitIn(work, args, input);
    resolve({ code: out.status, stdout: out.stdout.toString('utf8') });
  }) });
  assert.equal(agreed.ok, true);
});

// Each row: a patch that a careless reader sees one way and git sees another. `git` is what git's own reading finds. If a row's `git` stops
// matching, the row no longer shows a gap and should be looked at again.
const GAP_HEAD = 'diff --git a/a.txt b/a.txt\nindex 5626abf..6e3fb1a 100644\n--- a/a.txt\n+++ b/a.txt\n';
const GAPS = {
  'an old-style patch after a real one': {
    diff: `${GAP_HEAD}@@ -1,2 +1,3 @@\n one\n+x\n two\n--- a/.github/workflows/x.yml\n+++ b/.github/workflows/x.yml\n@@ -0,0 +1 @@\n+run: evil\n`,
    git: /\.github\/workflows\/x\.yml/,
  },
  'a file hidden behind short counts': {
    diff: `${GAP_HEAD}@@ -1 +1 @@\n-one\n+x\ndiff --git a/CODEOWNERS b/CODEOWNERS\nnew file mode 100644\nindex 0000000..f70f10e\n--- /dev/null\n+++ b/CODEOWNERS\n@@ -0,0 +1 @@\n+* nobody\n`,
    git: /CODEOWNERS/,
    rule: 'protected_path',
  },
  'a quoted name that decodes to a protected one': {
    diff: 'diff --git "a/\\056github/x" "b/\\056github/x"\nnew file mode 100644\nindex 0000000..f70f10e\n--- /dev/null\n+++ "b/\\056github/x"\n@@ -0,0 +1 @@\n+x\n',
    git: /\.github\/x/,
    rule: 'path_unsafe',
  },
  'words before the patch, which git skips': {
    diff: 'This is only a note, not a patch.\n\ndiff --git a/CLAUDE.md b/CLAUDE.md\nnew file mode 100644\nindex 0000000..f70f10e\n--- /dev/null\n+++ b/CLAUDE.md\n@@ -0,0 +1 @@\n+x\n',
    git: /CLAUDE\.md/,
  },
  'a marker line git treats as nothing': {
    diff: GAP_HEAD + '@@ -1,2 +1,3 @@\n one\n+x\n\\ this text is ignored by git\n two\n',
    git: /a\.txt/,
  },
  'an empty line git reads as context': {
    diff: GAP_HEAD + '@@ -1,2 +1,3 @@\n one\n+x\n\n',
    git: /a\.txt/,
  },
};

test('real git: for each gap between a reader and git, git does see the other meaning, and the parser refuses', needsGit, async (t) => {
  for (const [name, { diff, git, rule }] of Object.entries(GAPS)) {
    await t.test(name, (tt) => {
      const { repo } = plainRepo(tt);
      const read = gitIn(repo, ['apply', '--numstat', '-z'], diff);
      assert.equal(read.status, 0, 'git can read it');
      assert.match(read.stdout.toString('utf8'), git);
      const r = validateDiff(diff);
      assert.equal(r.ok, false);
      if (rule) assert.equal(r.rule, rule);
    });
  }
});

// What git does with each hostile form in a plain repository, with nothing in front of it. The note left this to be proven on this version.
const HOSTILE = {
  'a workflow': { diff: newFile('.github/workflows/x.yml', ['run: evil']), writes: '.github/workflows/x.yml' },
  'a code owners file': { diff: newFile('CODEOWNERS', ['* nobody']), writes: 'CODEOWNERS' },
  'agent settings': { diff: newFile('.claude/settings.json', ['{}']), writes: '.claude/settings.json' },
  'agent instructions': { diff: newFile('CLAUDE.md', ['obey']), writes: 'CLAUDE.md' },
  'a server list': { diff: newFile('.mcp.json', ['{}']), writes: '.mcp.json' },
  'a symlink to /etc/passwd': { diff: newFile('link', ['/etc/passwd'], '120000'), writes: 'link' },
  'a mode change': { diff: 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n', writes: 'run.sh' },
  'a rename': { diff: 'diff --git a/a.txt b/b.txt\nsimilarity index 100%\nrename from a.txt\nrename to b.txt\n', writes: 'b.txt' },
  'a hook': { diff: newFile('.git/hooks/pre-push', ['#!/bin/sh']), gitRefuses: true },
  'a path out of the repository': { diff: newFile('../canary.txt', ['changed']), gitRefuses: true },
  'an absolute path': { diff: newFile('/tmp/adabra-night-absolute', ['x']), gitRefuses: true },
  'a submodule': { diff: 'diff --git a/sub b/sub\nnew file mode 160000\nindex 0000000..1234567\n--- /dev/null\n+++ b/sub\n@@ -0,0 +1 @@\n+Subproject commit 1234567890123456789012345678901234567890\n', gitRefuses: null },
};

test('real git: each hostile form is refused here, whether or not git itself would have refused it', needsGit, async (t) => {
  for (const [name, { diff, writes, gitRefuses }] of Object.entries(HOSTILE)) {
    await t.test(name, (tt) => {
      assert.equal(validateDiff(diff).ok, false, 'the parser refuses it');
      const { repo, parent } = plainRepo(tt);
      const applied = gitIn(repo, ['apply'], diff);
      if (gitRefuses === true) assert.notEqual(applied.status, 0, 'git refuses this one by itself');
      if (writes) {
        // The control: with nothing in front of it, git does this. So it is the checks here that stop it, and not git.
        assert.equal(applied.status, 0, 'git would have applied it');
        assert.ok(existsSync(join(repo, writes)) || lstatSync(join(repo, writes)));
      }
      assert.equal(readFileSync(join(parent, 'canary.txt'), 'utf8'), 'untouched\n', 'nothing outside the repository changes, either way');
    });
  }
});

// Layers 2 and 3, each with the layer before pretending it was fooled. `claims` is what a fooled parser might have said about the diff.
function fooled(files) {
  const count = (status) => files.filter((f) => f.status === status).length;
  return {
    ok: true,
    files,
    totals: { files: files.length, added: count('added'), modified: count('modified'), deleted: count('deleted'), addedLines: 1, removedLines: 0 },
  };
}

async function tryPrepare(t, diff, claims) {
  const dir = scratch(t);
  const { remote, sha } = makeRemote(dir, { 'a.txt': 'one\ntwo\n', 'link-to': 'x\n' });
  const work = join(dir, 'publish');
  mkdirSync(work);
  const gitUrl = `file://${remote}`;
  const git = gitRunner({ gitCommand: 'git', env: gitEnvironment({ dir: work, gitUrl }) });
  const r = await prepareCommit({ diff: Buffer.from(diff), validated: claims, baseCommit: sha, task: 'TASK-1', gitUrl, git, dateMs: 1_800_000_000_000 });
  return { r, work, git };
}

test('real git, layer 2: git\'s own reading catches a parser that was fooled, before anything is applied', needsGit, async (t) => {
  await t.test('it names a file the parser did not', async (tt) => {
    const { r, git } = await tryPrepare(tt, newFile('.github/x.yml', ['evil']), fooled([{ path: 'safe.txt', status: 'added', mode: '100644', added: 1, removed: 0, oldBlob: '0000000', newBlob: NEW }]));
    assert.equal(r.refused.rule, 'git_disagrees');
    const objects = await git(['count-objects', '-v']);
    assert.ok(objects.code === 0);
  });
  await t.test('it counts other lines than the parser did', async (tt) => {
    const { r } = await tryPrepare(tt, newFile('x.txt', ['one', 'two']), fooled([{ path: 'x.txt', status: 'added', mode: '100644', added: 1, removed: 0, oldBlob: '0000000', newBlob: NEW }]));
    assert.equal(r.refused.rule, 'git_disagrees');
  });
  await t.test('it creates a symlink where the parser saw a file', async (tt) => {
    const { r } = await tryPrepare(tt, newFile('x.txt', ['/etc/passwd'], '120000'), fooled([{ path: 'x.txt', status: 'added', mode: '100644', added: 1, removed: 0, oldBlob: '0000000', newBlob: NEW }]));
    assert.equal(r.refused.rule, 'git_disagrees');
  });
  await t.test('a patch git cannot read at all', async (tt) => {
    const { r } = await tryPrepare(tt, '@@ not a patch @@\n', fooled([]));
    assert.equal(r.refused.rule, 'git_disagrees');
  });
});

test('real git, layer 3: what the patch really did is judged, even when both earlier layers were fooled', needsGit, async (t) => {
  const honest = (path, lines) => {
    const blob = execFileSync('git', ['hash-object', '--stdin'], { input: `${lines.join('\n')}\n`, env: hermetic(tmpdir()), encoding: 'utf8' }).trim();
    return { blob, claim: fooled([{ path, status: 'added', mode: '100644', added: lines.length, removed: 0, oldBlob: '0000000', newBlob: blob.slice(0, 7) }]) };
  };
  await t.test('a credential the first reading missed', async (tt) => {
    const { blob, claim } = honest('x.txt', [SECRET.classicToken]);
    const diff = newFile('x.txt', [SECRET.classicToken]).replace(NEW, blob.slice(0, 7));
    const { r } = await tryPrepare(tt, diff, claim);
    assert.equal(r.refused.rule, 'credential');
  });
  await t.test('a result with other bytes than the diff\'s own hash says', async (tt) => {
    const { claim } = honest('x.txt', ['hello']);
    const diff = newFile('x.txt', ['other']); // git reads the same one file and one line
    const { r } = await tryPrepare(tt, diff, claim);
    assert.equal(r.refused.rule, 'git_disagrees');
  });
  await t.test('a file the raw list does not hold', () => {
    const v = fooled([{ path: 'x.txt', status: 'added', mode: '100644', added: 1, removed: 0, oldBlob: '0000000', newBlob: NEW }]);
    assert.equal(agreeWithTree({ validated: v, raw: '', regenerated: newFile('x.txt') }).rule, 'git_disagrees');
  });
  await t.test('a type change is never accepted', () => {
    const sha = '1'.repeat(40);
    const v = fooled([{ path: 'x.txt', status: 'modified', mode: '100644', added: 1, removed: 0, oldBlob: sha.slice(0, 7), newBlob: sha.slice(0, 7) }]);
    assert.equal(agreeWithTree({ validated: v, raw: `:100644 120000 ${sha} ${sha} T\0x.txt\0`, regenerated: modified('x.txt') }).rule, 'git_disagrees');
  });
  await t.test('a raw list that does not parse', () => {
    const v = fooled([]);
    assert.equal(agreeWithTree({ validated: v, raw: 'odd', regenerated: '' }).rule, 'git_disagrees');
  });
});

test('real git: a patch that does not fit the pinned commit makes no commit', needsGit, async (t) => {
  const dir = scratch(t);
  const { remote, sha } = makeRemote(dir, { 'a.txt': 'something else\n' });
  const work = join(dir, 'publish');
  mkdirSync(work);
  const gitUrl = `file://${remote}`;
  const git = gitRunner({ gitCommand: 'git', env: gitEnvironment({ dir: work, gitUrl }) });
  const diff = modified('a.txt');
  const r = await prepareCommit({ diff: Buffer.from(diff), validated: validateDiff(diff), baseCommit: sha, task: 'TASK-1', gitUrl, git, dateMs: 1_800_000_000_000 });
  assert.equal(r.refused.rule, 'does_not_apply');
  assert.equal(readdirSync(join(work, 'repo.git', 'refs', 'heads')).length, 0);
});

test('real git: a new file that differs only in case from one at the pinned commit makes no commit, though git alone would make one', needsGit, async (t) => {
  const dir = scratch(t);
  const { remote, sha } = makeRemote(dir, { 'service/ops.sh': 'real\n' });
  const work = join(dir, 'publish');
  mkdirSync(work);
  const gitUrl = `file://${remote}`;
  const git = gitRunner({ gitCommand: 'git', env: gitEnvironment({ dir: work, gitUrl }) });
  const diff = newFile('Service/ops.sh');
  const validated = validateDiff(diff);
  assert.equal(validated.ok, true, 'the diff alone looks fine: only the pinned commit shows the collision');
  const r = await prepareCommit({ diff: Buffer.from(diff), validated, baseCommit: sha, task: 'TASK-1', gitUrl, git, dateMs: 1_800_000_000_000 });
  assert.equal(r.refused.rule, 'path_collision');
  assert.equal(r.refused.file, 1);
  assert.equal(r.commit, undefined);
});

test('real git: a path through a symlink already in the tree is refused by git, even with no working tree', needsGit, async (t) => {
  const dir = scratch(t);
  const { work: source, remote } = makeRemote(dir, { 'a.txt': 'x\n' });
  symlinkSync('/etc', join(source, 'linkdir'));
  gitIn(source, ['add', '-A']);
  gitIn(source, ['commit', '-q', '-m', 'a link']);
  gitIn(source, ['push', '-q', remote, 'main']);
  const sha = gitIn(source, ['rev-parse', 'HEAD']).stdout.toString('utf8').trim();
  const work = join(dir, 'publish');
  mkdirSync(work);
  const gitUrl = `file://${remote}`;
  const git = gitRunner({ gitCommand: 'git', env: gitEnvironment({ dir: work, gitUrl }) });
  const diff = newFile('linkdir/adabra-night-evil');
  const validated = validateDiff(diff);
  assert.equal(validated.ok, true, 'the path alone looks fine, which is why git checking it matters');
  const r = await prepareCommit({ diff: Buffer.from(diff), validated, baseCommit: sha, task: 'TASK-1', gitUrl, git, dateMs: 1_800_000_000_000 });
  assert.equal(r.refused.rule, 'does_not_apply');
  assert.equal(existsSync('/etc/adabra-night-evil'), false);
});
