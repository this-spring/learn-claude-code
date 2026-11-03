import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { fixture, response, toolCall, workspace } from '../s04_hooks/test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';

const initial = process.cwd(); const root = realpathSync(mkdtempSync(join(tmpdir(), 's02-parity-'))); const outside = workspace({ after: (callback: () => void) => after(callback) } as Parameters<typeof workspace>[0]);
process.chdir(root); const lesson = await import('./code.js'); process.chdir(initial);
after(() => rmSync(root, { force: true, recursive: true }));
test('writes count Python Unicode characters and editing replaces literal text only once', () => {
  assert.equal(lesson.run_write('nested/note.txt', '你好😀\nsame same\n'), 'Wrote 14 bytes to nested/note.txt');
  assert.equal(lesson.run_edit('nested/note.txt', 'same', '$&'), 'Edited nested/note.txt');
  assert.equal(lesson.run_read('nested/note.txt'), '你好😀\n$& same');
});
test('read preserves zero/negative line limits and Python splitlines semantics', () => {
  lesson.run_write('lines.txt', 'a\r\nb\rc\nd\n');
  assert.equal(lesson.run_read('lines.txt', 0), 'a\nb\nc\nd');
  assert.equal(lesson.run_read('lines.txt', -1), 'a\nb\nc\n... (5 more lines)');
  assert.equal(lesson.run_read('lines.txt', 2), 'a\nb\n... (2 more lines)');
  writeFileSync(join(root, 'invalid.bin'), Buffer.from([255])); assert.match(lesson.run_read('invalid.bin'), /^Error:/);
});
test('file tools stay within the workspace while symlinks resolve before parent components', () => {
  assert.match(lesson.run_write(join(outside, 'forbidden'), 'no'), /^Error: Path escapes workspace/);
  mkdirSync(join(root, 'real/deep'), { recursive: true }); symlinkSync('real/deep', join(root, 'link'));
  assert.equal(lesson.safe_path('link/../target.txt'), join(root, 'real/target.txt'));
  symlinkSync(join(root, 'not-yet-created'), join(root, 'dangling'));
  assert.equal(lesson.run_write('dangling', 'created'), 'Wrote 7 bytes to dangling');
  assert.equal(readFileSync(join(root, 'not-yet-created'), 'utf8'), 'created');
});
test('glob sorts results, filters outside targets and truncates after 200 matches', () => {
  for (let i = 0; i < 205; i += 1) lesson.run_write(`many/${String(i).padStart(3, '0')}.txt`, '');
  const lines = lesson.run_glob('many/*.txt').split('\n'); assert.equal(lines.length, 201); assert.match(lines[200], /more matches omitted/);
  assert.equal(lesson.run_glob(join(outside, '*')), '(no matches)');
});
test('kernel still blocks its hardcoded Bash patterns and bounds Unicode output by code points', () => {
  assert.equal(lesson.run_bash('printf sudo'), 'Error: Dangerous command blocked');
  assert.equal(lesson.run_bash(`"${process.execPath}" -e "process.stdout.write('😀'.repeat(60000))"`), '😀'.repeat(50000));
});
test('loop dispatches all tools and retains matching results across rounds', async (context) => {
  const { options, requests } = fixture(context, [response([toolCall('write_file', { path: 'loop.txt', content: 'old' }, 'write'), toolCall('edit_file', { path: 'loop.txt', old_text: 'old', new_text: 'new' }, 'edit'), toolCall('read_file', { path: 'loop.txt' }, 'read'), toolCall('constructor', {}, 'unknown')]), response()]);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'work' }];
  await lesson.agent_loop(messages, options.client, options.model);
  assert.deepEqual(messages[2].content, [{ type: 'tool_result', tool_use_id: 'write', content: 'Wrote 3 bytes to loop.txt' }, { type: 'tool_result', tool_use_id: 'edit', content: 'Edited loop.txt' }, { type: 'tool_result', tool_use_id: 'read', content: 'new' }, { type: 'tool_result', tool_use_id: 'unknown', content: 'Unknown: constructor' }]);
  assert.equal(requests.length, 2);
});
test('s02 propagates unhandled dispatch failures', async (context) => {
  const previous = lesson.TOOL_HANDLERS.bash; context.after(() => { lesson.TOOL_HANDLERS.bash = previous; });
  lesson.TOOL_HANDLERS.bash = () => { throw new Error('handler failure'); };
  const { options } = fixture(context, [response([toolCall('bash', { command: 'ignored' })])]);
  await assert.rejects(lesson.agent_loop([], options.client, options.model), /handler failure/);
});
test('tool schemas and file operations match Python', (context) => {
  assert.deepEqual({ TOOLS: lesson.TOOLS }, pythonReference('s02_tool_use', workspace(context), {}).result);
  const calls = [{ name: 'run_write', args: ['oracle.txt', '你好😀\r\nsame same\r\n'] }, { name: 'run_read', args: ['oracle.txt', -1] }, { name: 'run_edit', args: ['oracle.txt', 'same', '$&'] }, { name: 'run_read', args: ['oracle.txt'] }];
  assert.deepEqual([lesson.run_write('oracle.txt', calls[0].args[1] as string), lesson.run_read('oracle.txt', -1), lesson.run_edit('oracle.txt', 'same', '$&'), lesson.run_read('oracle.txt')], pythonReference('s02_tool_use', workspace(context), { scenario: 'functions', calls }).result);
});
