import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from './code.js';
import { fixture, response, workspace } from '../s04_hooks/test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';

const initial = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'memory-parity-'));
process.chdir(root);
const lesson = await import('./code.js');
process.chdir(initial);
after(() => rmSync(root, { force: true, recursive: true }));
beforeEach(() => rmSync(lesson.MEMORY_DIR, { force: true, recursive: true }));
const record: MemoryRecord = { name: 'TypeScript preference', type: 'user', scope: 'persistent', description: 'Prefer TypeScript', body: 'Use strict TypeScript in new projects.' };
const textResponse = (text: string) => response([{ type: 'text', text, citations: null }]);
function write(record: MemoryRecord): void { lesson.write_memory_file(record.name, record.type, record.description, record.body); }

test('memory documents and index round trip with original function layout', () => {
  write(record);
  assert.equal(lesson.list_memory_files().length, 1);
  assert.match(lesson.read_memory_index(), /TypeScript preference/);
  assert.match(lesson.read_memory_file('typescript-preference.md')!, /strict TypeScript/);
});
test('temporary and duplicate memories are filtered', () => {
  assert.equal(lesson.should_store_memory(record, []), true);
  assert.equal(lesson.should_store_memory(record, [record]), false);
  assert.equal(lesson.should_store_memory({ ...record, scope: 'current_task' }, []), false);
  assert.equal(lesson.should_store_memory({ ...record, body: '本次任务使用 TS' }, []), false);
});
test('memory paths reject traversal and index records but allow internal symlinks', () => {
  assert.throws(() => lesson.memory_path('../secret.md'));
  assert.throws(() => lesson.memory_path('MEMORY.md'));
  write(record);
  symlinkSync('typescript-preference.md', join(lesson.MEMORY_DIR, 'alias.md'));
  assert.equal(lesson.read_memory_file('alias.md'), lesson.read_memory_file('typescript-preference.md'));
});
test('memory parser preserves its Python behavior independently of the skill parser', () => {
  const invalid = '---\nname: [\n---\nBody';
  assert.deepEqual(lesson.parse_frontmatter(invalid), [{}, invalid]);
  assert.deepEqual(lesson.parse_frontmatter('---\r\nname: x\r\n---\r\nBody'), [{}, '---\r\nname: x\r\n---\r\nBody']);
  assert.deepEqual(lesson.parse_frontmatter('---\nname: x\n---Body\n'), [{ name: 'x' }, 'Body\n']);
});
test('JSON extraction finds arrays after malformed openers and nested brackets in strings', () => {
  assert.deepEqual(lesson.extract_json_array('text [{"value":"[nested]"}] end'), [{ value: '[nested]' }]);
  assert.deepEqual(lesson.extract_json_array('bad [ !!! [{"x": 1}] tail'), [{ x: 1 }]);
  assert.deepEqual(lesson.extract_json_array('invalid'), []);
});
test('keyword fallback selects relevant entries in stable filename order', () => {
  assert.deepEqual(lesson.keyword_memory_selection([{ ...record, filename: 'preference.md' }], 'TypeScript', 5), ['preference.md']);
  assert.deepEqual(lesson.keyword_memory_selection([record], 'unrelated', 5), []);
});
test('extraction stores persistent records and skips task-scoped records', async (context) => {
  const { options } = fixture(context, [textResponse(JSON.stringify([record, { ...record, name: 'Temporary', scope: 'current_task' }]))]);
  assert.equal(await lesson.extract_memories([{ role: 'user', content: 'Remember my preference' }], options.client, options.model), 1);
  assert.equal(lesson.list_memory_files().length, 1);
});
test('selection falls back only on an exception, not an empty model result', async (context) => {
  write(record);
  const query = [{ role: 'user' as const, content: 'TypeScript' }];
  const none = fixture(context, [textResponse('[]')]);
  assert.deepEqual(await lesson.select_relevant_memories(query, 5, none.options.client, none.options.model), []);
  const failed = fixture(context, [new Error('offline')]);
  assert.deepEqual(await lesson.select_relevant_memories(query, 5, failed.options.client, failed.options.model), ['typescript-preference.md']);
});
test('invalid consolidation preserves all existing records', async (context) => {
  for (let index = 0; index < 10; index += 1) write({ ...record, name: `Preference ${index}` });
  const snapshot = lesson.list_memory_files();
  const { options } = fixture(context, [textResponse('[]')]);
  assert.equal(await lesson.consolidate_memories(options.client, options.model), 0);
  assert.deepEqual(lesson.list_memory_files(), snapshot);
});
test('consolidation rolls back writes if a generated path escapes the store', async (context) => {
  for (let index = 0; index < 10; index += 1) write({ ...record, name: `Preference ${index}` });
  const outside = workspace(context);
  writeFileSync(join(outside, 'escape.md'), 'outside');
  symlinkSync(join(outside, 'escape.md'), join(lesson.MEMORY_DIR, 'escape.md'));
  const snapshot = lesson.list_memory_files();
  const { options } = fixture(context, [textResponse(JSON.stringify([{ ...record, name: 'Escape' }]))]);
  assert.equal(await lesson.consolidate_memories(options.client, options.model), 0);
  assert.deepEqual(lesson.list_memory_files(), snapshot);
});
test('schemas, parser, coercion and durable filtering match unmodified Python', (context) => {
  assert.deepEqual({ TOOLS: lesson.TOOLS }, pythonReference('s09_memory', workspace(context), {}).result);
  const calls = [
    { name: 'parse_frontmatter', args: ['---\nname: [\n---\nBody'] },
    { name: 'parse_frontmatter', args: ['---\nname: x\n---Body\n'] },
    { name: 'validate_memory_record', args: [{ name: true, type: 'user', body: 5, description: null }] },
    { name: 'should_store_memory', args: [record, []] },
    { name: 'should_store_memory', args: [{ ...record, body: 'this session only' }, []] },
    { name: 'memory_slug', args: ['你好 😀 TypeScript_2'] },
  ];
  const actual = [lesson.parse_frontmatter(calls[0].args[0] as string), lesson.parse_frontmatter(calls[1].args[0] as string), lesson.validate_memory_record(calls[2].args[0]), lesson.should_store_memory(record, []), lesson.should_store_memory({ ...record, body: 'this session only' }, []), lesson.memory_slug('你好 😀 TypeScript_2')];
  assert.deepEqual(actual, pythonReference('s09_memory', workspace(context), { scenario: 'functions', calls }).result);
});


test('stored memory metadata uses PyYAML scalar resolution and duplicate-key behavior', () => {
  const texts = ['y', 'n', 'yes', '08', '1e2', '1.0e+2'].map((name) => `---\nname: ${name}\n---\nBody`);
  texts.push('---\nname: first\nname: last\n---\nBody');
  assert.deepEqual(texts.map(lesson.parse_frontmatter), pythonReference('s09_memory', root, { scenario: 'functions', calls: texts.map((text) => ({ name: 'parse_frontmatter', args: [text] })) }).result);
});
