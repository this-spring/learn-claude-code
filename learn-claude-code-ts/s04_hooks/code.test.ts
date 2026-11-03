import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { HOOKS, TOOL_HANDLERS, TOOLS, agent_loop, contains_destructive_command, trigger_hooks, permission_hook } from './code.js';
import { fixture, response, toolCall, workspace } from './test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';

test('hooks run in order and stop on the first non-null result', async (context) => {
  const previous = HOOKS.PreToolUse; context.after(() => { HOOKS.PreToolUse = previous; });
  const order: number[] = [];
  HOOKS.PreToolUse = [() => { order.push(1); }, () => { order.push(2); return ''; }, () => order.push(3)];
  assert.equal(await trigger_hooks('PreToolUse'), ''); assert.deepEqual(order, [1, 2]);
});
test('denied calls stay paired and never execute', async (context) => {
  const { options, requests } = fixture(context, [response([toolCall('write_file', { path: 'x', content: 'x' })]), response()]);
  const previous = HOOKS.PreToolUse; const handler = TOOL_HANDLERS.write_file;
  context.after(() => { HOOKS.PreToolUse = previous; TOOL_HANDLERS.write_file = handler; });
  let executed = false;
  HOOKS.PreToolUse = [() => 'blocked']; TOOL_HANDLERS.write_file = () => { executed = true; return ''; };
  const history: Anthropic.MessageParam[] = [];
  await agent_loop(history, options.client, options.model);
  assert.equal(executed, false); assert.match(JSON.stringify(requests[1].messages), /tool_result.*blocked/);
});
test('Stop hook can request exactly one additional model turn', async (context) => {
  const { options, requests } = fixture(context, [response(), response()]);
  const previous = HOOKS.Stop; context.after(() => { HOOKS.Stop = previous; });
  let stops = 0; HOOKS.Stop = [() => ++stops === 1 ? 'Check again' : null];
  await agent_loop([], options.client, options.model); assert.equal(requests.length, 2);
});
test('s04 propagates handler exceptions and falsey hook results still execute tools', async (context) => {
  const previous = HOOKS.PreToolUse; const handler = TOOL_HANDLERS.bash;
  context.after(() => { HOOKS.PreToolUse = previous; TOOL_HANDLERS.bash = handler; });
  HOOKS.PreToolUse = [() => false]; TOOL_HANDLERS.bash = () => { throw new Error('handler failure'); };
  const { options } = fixture(context, [response([toolCall('bash')])]);
  await assert.rejects(agent_loop([], options.client, options.model), /handler failure/);
});
test('approval defaults to deny and deny-list commands are blocked', async () => {
  assert.equal(await permission_hook(toolCall('bash', { command: 'rm example.txt' })), 'Permission denied by user');
  assert.equal(await permission_hook(toolCall('bash', { command: 'sudo echo x' })), 'Permission denied by deny list');
});
test('destructive command detection handles separators and newlines', () => {
  assert.equal(contains_destructive_command('echo done;RM x'), true);
  assert.equal(contains_destructive_command('echo done\ndel x'), true);
  assert.equal(contains_destructive_command('printf normal'), false);
});
test('tool schemas match Python', (context) => {
  assert.deepEqual({ TOOLS }, pythonReference('s04_hooks', workspace(context), {}).result);
});
