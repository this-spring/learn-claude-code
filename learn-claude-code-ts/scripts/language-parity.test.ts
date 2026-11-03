import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { pythonReference } from './parity-helpers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
test('all file-tool glob adapters match Python on dotfiles, symlinks and literal syntax', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'learn-language-parity-'));
  const previous = process.cwd();
  try {
    process.chdir(fixture);
    for (const name of ['a.txt', 'dir/b.txt', '.hidden.txt', 'dir/.hidden.txt', '{a,b}.txt', 'x[1].txt', 'dir/sub/c.md']) {
      mkdirSync(dirname(join(fixture, name)), { recursive: true }); writeFileSync(join(fixture, name), '你好😀\r\nold\r\n');
    }
    symlinkSync('dir', join(fixture, 'alias')); symlinkSync('missing', join(fixture, 'broken'));
    const patterns = ['*', '**', '**/', '**/*.txt', './*.txt', '{a,b}.txt', 'x[[]1].txt', 'dir/../*.txt', 'alias/*.txt', '**/**', 'dir/**', '[!.]*'];
    for (const chapter of readdirSync(root).filter((name) => /^s(?:0[2-9]|1[0-5]|17)_/.test(name)).sort()) {
      const lesson = await import(pathToFileURL(join(root, chapter, 'code.ts')).href);
      if (chapter.startsWith('s17')) continue;
      const expected = pythonReference(chapter, fixture, { scenario: 'functions', calls: patterns.map((pattern) => ({ name: 'run_glob', args: [pattern] })) }).result;
      assert.deepEqual(patterns.map((pattern) => lesson.run_glob(pattern)), expected, chapter);
    }
  } finally { process.chdir(previous); rmSync(fixture, { recursive: true, force: true }); }
});

test('Todo string inputs follow Python literal parsing and chapter-specific validation', async () => {
  const { TodoManager } = await import('../s05_todo_write/code.js');
  const integrated = await import('../s15_integrated_harness/code.js');
  const values = [
    "[{'content': r'c:\\temp' ' done', 'status': 'pending'}]",
    "[{'content': (1, 'two'), 'status': 'pending'}]",
    "[{'content': b'hello\\x21', 'status': 'pending'}]",
    "[{'content': 1_000, 'status': 'pending'}]",
    "[{'content': 1.0, 'status': 'pending'}]",
    "[{'content': 1+2j, 'status': 'pending'}]",
    "[{'content': '\\N{GRINNING FACE}', 'status': 'pending'}]",
    "[{'content': 123456789012345678901, 'status': 'pending'}]",
    "({'content': 'x', 'status': 'pending'},)",
    "[('not', 'a dictionary')]",
    "set()", "[] + []", "__import__('os')", "[{'content': 'unterminated}]",
  ];
  const expected = pythonReference('s05_todo_write', process.cwd(), { scenario: 'todos', values }).result;
  assert.deepEqual(values.map((value) => { try { return new TodoManager().update(value); } catch (error) { return `Error: ${(error as Error).message}`; } }), expected);
  const integrated_expected = pythonReference('s15_integrated_harness', process.cwd(), { scenario: 'todos', values }).result;
  assert.deepEqual(values.map((value) => { const [, error] = integrated._normalize_todos(value); return error ?? 'ok'; }), integrated_expected);
});

test('registered handlers bind missing and unexpected keywords like Python before execution', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'learn-keywords-'));
  try {
    for (const chapter of readdirSync(root).filter((name) => /^s(?:0[2-9]|1[0-5])_/.test(name)).sort()) {
      const lesson = await import(pathToFileURL(join(root, chapter, 'code.ts')).href);
      const table = chapter.startsWith('s14') || chapter.startsWith('s15') ? 'BUILTIN_HANDLERS' : 'TOOL_HANDLERS';
      const calls = [{ name: 'bash', input: {} }, { name: 'bash', input: { command: 'echo never', unexpected: true } }];
      const expected = pythonReference(chapter, fixture, { scenario: 'handler_binding', table, calls }).result;
      const actual = [];
      for (const call of calls) { try { actual.push(await lesson[table][call.name](call.input)); } catch (error) { actual.push(`${(error as Error).name}: ${(error as Error).message}`); } }
      assert.deepEqual(actual, expected, chapter);
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
