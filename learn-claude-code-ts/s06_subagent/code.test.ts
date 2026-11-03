import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { BASE_TOOLS, HOOKS, SUB_HANDLERS, SUB_TOOLS, TOOLS, agent_loop, execute_tool, run_subagent } from './code.js';
import { fixture, response, toolCall, workspace } from '../s04_hooks/test-helpers.js';

test('parent is the kernel plus task; child has no recursive delegation or todos', () => {
  const names = ['bash', 'read_file', 'write_file', 'edit_file', 'glob'];
  assert.deepEqual(BASE_TOOLS.map((tool) => tool.name), names);
  assert.deepEqual(SUB_TOOLS.map((tool) => tool.name), names);
  assert.deepEqual(TOOLS.map((tool) => tool.name), [...names, 'task']);
});
test('subagent starts fresh and returns only final text', async (context) => {
  const { options, requests } = fixture(context);
  assert.equal(await run_subagent('inspect', options.client, options.model), 'done');
  assert.deepEqual(requests[0].messages, [{ role: 'user', content: 'inspect' }]);
  assert.equal(requests[0].tools?.some((tool) => 'name' in tool && tool.name === 'task'), false);
});
test('child shares file tools and hooks; parent receives only the summary', async (context) => {
  const target = join(workspace(context), 'child.txt');
  const previous = HOOKS.PreToolUse;
  const previousPost = HOOKS.PostToolUse;
  context.after(() => { HOOKS.PreToolUse = previous; HOOKS.PostToolUse = previousPost; });
  let calls = 0;
  HOOKS.PreToolUse = [];
  HOOKS.PostToolUse = [() => { calls += 1; return null; }];
  const { options, requests } = fixture(context, [
    response([toolCall('task', { prompt: 'write' }, 'task-1')]),
    response([toolCall('write_file', { path: target, content: 'written' }, 'child-1')]),
    response(), response(),
  ]);
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: 'parent' }];
  await agent_loop(history, options.client, options.model);
  assert.equal(calls, 2);
  assert.equal(readFileSync(target, 'utf8'), 'written');
  assert.deepEqual(requests[1].messages, [{ role: 'user', content: 'write' }]);
  assert.deepEqual(history[2].content, [{ type: 'tool_result', tool_use_id: 'task-1', content: 'done' }]);
  assert.doesNotMatch(JSON.stringify(history), /child-1/);
});
test('permissions apply to child tools', async (context) => {
  const target = join(workspace(context), 'not-created.txt');
  assert.equal(await execute_tool(toolCall('write_file', { path: target, content: 'no' }), SUB_HANDLERS), 'Permission denied by user');
  assert.equal(existsSync(target), false);
  assert.equal(await execute_tool(toolCall('bash', { command: 'sudo whoami' }), SUB_HANDLERS), 'Permission denied by deny list');
});
test('Python accepts blank prompts; thirty turns include Stop continuations', async (context) => {
  const previous = HOOKS.Stop;
  context.after(() => { HOOKS.Stop = previous; });
  HOOKS.Stop = [() => 'continue'];
  const { options, requests } = fixture(context, Array.from({ length: 30 }, () => response()));
  assert.equal(await run_subagent(' ', options.client, options.model), 'Subagent stopped after 30 turns without a final answer.');
  assert.equal(requests.length, 30);
});
test('JavaScript falsy non-null hook results stop callbacks but allow execution', async (context) => {
  const previous = HOOKS.PreToolUse;
  context.after(() => { HOOKS.PreToolUse = previous; });
  for (const value of ['', false, 0]) {
    HOOKS.PreToolUse = [() => value, () => { throw new Error('must not be reached'); }];
    assert.equal(await execute_tool(toolCall('missing'), SUB_HANDLERS), 'Unknown: missing');
  }
});

test('tool schemas and child model traces match the Python original', async (context) => {
  const { pythonReference } = await import('../scripts/parity-helpers.js');
  const directory = workspace(context);
  const schemas = pythonReference('s06_subagent', directory, { names: ['BASE_TOOLS', 'SUB_TOOLS', 'TOOLS'] });
  assert.deepEqual({ BASE_TOOLS, SUB_TOOLS, TOOLS }, schemas.result);
  const replies = [response([toolCall('missing', {}, 'unknown-1')]), response()];
  const expected = pythonReference('s06_subagent', directory, { scenario: 'subagent', prompt: 'inspect', replies });
  const { options, requests } = fixture(context, structuredClone(replies));
  assert.equal(await run_subagent('inspect', options.client, options.model), expected.result);
  // WORKDIR is the only intentional difference between the two disposable runs.
  const normalize = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replaceAll(directory, '<WORKDIR>').replaceAll(process.cwd(), '<WORKDIR>'));
  assert.deepEqual(normalize(requests), normalize(expected.requests));
});
