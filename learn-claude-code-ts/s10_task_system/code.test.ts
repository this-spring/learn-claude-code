import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pythonReference } from '../scripts/parity-helpers.js';
import { workspace } from '../s04_hooks/test-helpers.js';

const initial = process.cwd();
const root = mkdtempSync(join(tmpdir(), 'tasks-parity-'));
process.chdir(root);
const lesson = await import('./code.js');
process.chdir(initial);
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => rmSync(lesson.TASKS_DIR, { recursive: true, force: true }));

test('task records persist under runtime-generated IDs', () => {
  const task = lesson.create_task('  first  ');
  assert.match(task.id, lesson.TASK_ID_PATTERN);
  assert.equal(new lesson.TaskStore(lesson.TASKS_DIR).load(task.id).subject, 'first');
  assert.deepEqual(Object.keys(task), ['id', 'subject', 'description', 'status', 'owner', 'blockedBy']);
});
test('DAG rejects missing, self and cyclic dependencies before saving any changes', () => {
  const first = lesson.create_task('first'); const second = lesson.create_task('second');
  lesson.update_task(second.id, [first.id, first.id]);
  assert.deepEqual(lesson.load_task(second.id).blockedBy, [first.id]);
  assert.throws(() => lesson.update_task(first.id, [second.id]), /cycle/);
  assert.throws(() => lesson.update_task(first.id, [first.id]), /itself/);
  assert.throws(() => lesson.update_task(first.id, ['task_deadbeef']));
  assert.deepEqual(lesson.load_task(first.id).blockedBy, []);
});
test('ownership and dependencies control claim and completion', () => {
  const first = lesson.create_task('first'); const second = lesson.create_task('second');
  lesson.update_task(second.id, [first.id]);
  assert.match(lesson.claim_task(second.id), /Blocked/);
  assert.match(lesson.claim_task(first.id, 'alice'), /Claimed/);
  assert.match(lesson.complete_task(first.id, 'bob'), /owned/);
  assert.match(lesson.complete_task(first.id, 'alice'), /Unblocked: second/);
  assert.match(lesson.claim_task(second.id), /Claimed/);
  assert.throws(() => lesson.update_task(second.id, [first.id]), /pending and unowned/);
});
test('s10 has no lock and can_start only checks dependencies, matching Python', () => {
  lesson.TASKS._root(true);
  writeFileSync(join(lesson.TASKS_DIR, '.lock'), '');
  const task = lesson.create_task('unlocked');
  lesson.claim_task(task.id); lesson.complete_task(task.id);
  assert.equal(lesson.can_start(task.id), true);
});
test('task paths and malformed records fail; escaping symlinks are rejected', (context) => {
  assert.throws(() => lesson.TASKS.load('../escape'));
  const task = lesson.create_task('x');
  writeFileSync(lesson.TASKS._path(task.id), '{}');
  assert.throws(() => lesson.load_task(task.id), /Invalid task record/);
  const outside = workspace(context);
  symlinkSync(outside, join(root, 'outside-store'));
  assert.throws(() => new lesson.TaskStore(join(root, 'outside-store')).create('escape'), /escapes/);
});
test('task tool schemas match Python exactly', (context) => {
  assert.deepEqual({ TOOLS: lesson.TOOLS }, pythonReference('s10_task_system', workspace(context), {}).result);
});
