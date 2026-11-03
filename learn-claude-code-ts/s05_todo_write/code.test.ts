import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { HOOKS, TODO, TOOL_HANDLERS, TodoManager, agent_loop, run_edit, run_read, run_todo_write, run_write } from './code.js';
import { fixture, response, toolCall, workspace } from '../s04_hooks/test-helpers.js';

test('todo validates and renders all statuses', () => {
  const todo = new TodoManager();
  assert.match(todo.update([{ content: 'plan', status: 'COMPLETED' }, { content: 'work', status: 'in_progress' }]), /\[x\] plan[\s\S]*1\/2 completed/);
  assert.match(todo.update([{ content: null }, { content: true }, { content: [1, 'two'] }]), /None[\s\S]*True[\s\S]*\[1, 'two'\]/);
});
test('invalid replacement preserves existing state', () => {
  const todo = new TodoManager(); todo.update([{ content: 'keep' }]);
  for (const value of [[{ content: '' }], Array(21).fill({ content: 'x' }), [{ content: 'x', status: 'bad' }], [{ content: 'x', status: 'in_progress' }, { content: 'y', status: 'in_progress' }]]) assert.throws(() => todo.update(value));
  assert.equal(todo.items[0].content, 'keep');
});
test('JSON and Python-style literals are parsed without accepting YAML or executing code', () => {
  const todo = new TodoManager();
  assert.match(todo.update('[{"content":"json"}]'), /json/);
  assert.match(todo.update("[{'content': 'python', 'status': 'pending'},]"), /python/);
  assert.match(todo.update("[{'content': 'it\\'s ready'}, {'content': None}, {'content': True}]"), /it's ready[\s\S]*None[\s\S]*True/);
  assert.throws(() => todo.update('[{content: unquoted}]'), /list or JSON array string/);
  assert.throws(() => todo.update('process.exit()'));
});
test('reminder joins the third tool result batch', async (context) => {
  const { options, requests } = fixture(context, [
    response([toolCall('missing', {}, 'first')]),
    response([toolCall('missing', {}, 'second')]),
    response([toolCall('missing', {}, 'third')]),
    response(),
  ]);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'work' }];
  await agent_loop(messages, options.client, options.model);
  assert.doesNotMatch(JSON.stringify(requests[2].messages), /reminder/);
  assert.match(JSON.stringify(requests[3].messages.at(-1)), /tool_result[\s\S]*reminder/);
});
test('todo tool resets reminder count', async (context) => {
  const { options, requests } = fixture(context, [
    response([toolCall('missing', {}, 'first')]),
    response([toolCall('missing', {}, 'second')]),
    response([toolCall('todo_write', { todos: [] }, 'todo')]),
    response([toolCall('missing', {}, 'next')]),
    response(),
  ]);
  await agent_loop([{ role: 'user', content: 'work' }], options.client, options.model);
  assert.doesNotMatch(JSON.stringify(requests), /<reminder>/);
  assert.deepEqual(TODO.items, []);
  assert.match(run_todo_write([{ content: '' }]), /^Error: todos\[0\] requires content/);
});
test('denied todos do not reset the reminder counter and still return matching IDs', async (context) => {
  const previous = HOOKS.PreToolUse;
  context.after(() => { HOOKS.PreToolUse = previous; });
  HOOKS.PreToolUse = [() => 'blocked'];
  const { options, requests } = fixture(context, [
    response([toolCall('missing', {}, 'first')]),
    response([toolCall('missing', {}, 'second')]),
    response([toolCall('todo_write', { todos: [] }, 'todo')]),
    response(),
  ]);
  await agent_loop([{ role: 'user', content: 'work' }], options.client, options.model);
  assert.match(JSON.stringify(requests[3].messages.at(-1)), /"tool_use_id":"todo","content":"blocked"[\s\S]*reminder/);
});
test('a falsey hook return stops callbacks but does not deny the tool, matching Python', async (context) => {
  const previous = HOOKS.PreToolUse;
  const handler = TOOL_HANDLERS.todo_write;
  let executed = false;
  context.after(() => { HOOKS.PreToolUse = previous; TOOL_HANDLERS.todo_write = handler; });
  HOOKS.PreToolUse = [() => '', () => { throw new Error('must not run'); }];
  TOOL_HANDLERS.todo_write = () => { executed = true; return 'updated'; };
  const { options } = fixture(context, [response([toolCall('todo_write', { todos: [] })]), response()]);
  await agent_loop([{ role: 'user', content: 'work' }], options.client, options.model);
  assert.equal(executed, true);
});
test('standalone file tools retain Python first-replacement and character-count behavior', (context) => {
  const target = join(workspace(context), 'example.txt');
  assert.match(run_write(target, '你😀\nagain again\n'), /^Wrote 15 bytes/);
  assert.equal(run_read(target, 1), '你😀\n... (1 more lines)');
  assert.match(run_edit(target, 'again', '$&'), /^Edited/);
  assert.equal(run_read(target), '你😀\n$& again');
});
