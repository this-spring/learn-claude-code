import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { BACKGROUND, BackgroundManager, HOOKS, TOOLS, _format_bash_result, _run_bash_process, _stop_all_shell_processes, execute_tool, inject_background_results, should_run_background } from './code.js';
import { toolCall, workspace } from '../s04_hooks/test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';

async function ready(manager: BackgroundManager): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!manager._ready.length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.ok(manager._ready.length, 'background command did not finish');
}
test('only explicit boolean Bash requests run in background', () => {
  assert.equal(should_run_background('bash', { run_in_background: true }), true);
  assert.equal(should_run_background('read_file', { run_in_background: true }), false);
  assert.equal(should_run_background('bash', { run_in_background: 'true' }), false);
});
test('shell preserves stdout, stderr and nonzero exit codes', async () => {
  assert.deepEqual(await _run_bash_process('printf out; printf err >&2; exit 3'), ['outerr', 3]);
  assert.equal(_format_bash_result('outerr', 3), 'Error: command exited with status 3\nouterr');
});
test('background completion is collected exactly once using Python task IDs and notification format', async () => {
  const manager = new BackgroundManager();
  assert.equal(manager.start(toolCall('bash', { command: 'printf finished' })), 'bg_0001');
  await ready(manager);
  assert.equal(manager.collect()[0], '<task_notification>\n  <task_id>bg_0001</task_id>\n  <status>completed</status>\n  <command>printf finished</command>\n  <summary>finished</summary>\n</task_notification>');
  assert.deepEqual(manager.collect(), []);
  assert.equal(manager.tasks.size, 0); assert.equal(manager.results.size, 0);
});
test('nonzero exit emits a failed notification', async () => {
  const manager = new BackgroundManager(); manager.start(toolCall('bash', { command: 'exit 7' }));
  await ready(manager);
  assert.match(manager.collect()[0], /failed[\s\S]*command exited with status 7/);
});
test('timeout terminates shell processes and their group', async () => {
  const result = await _run_bash_process('sleep 5', 30);
  assert.deepEqual(result, ['Error: Timeout (120s)', null]);
  await _stop_all_shell_processes();
});
test('notifications preserve tool-result IDs when added to a user message', () => {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', content: 'started' }] }];
  BACKGROUND.tasks.set('bg_test', { command: 'echo test', tool_use_id: 'one', status: 'completed' });
  BACKGROUND.results.set('bg_test', 'done'); BACKGROUND._ready.push('bg_test');
  assert.equal(inject_background_results(messages), 1);
  assert.equal(messages.length, 1);
  assert.equal((JSON.stringify(messages).match(/tool_result/g) ?? []).length, 1);
  assert.equal(inject_background_results(messages), 0);
});
test('any non-null hook return blocks s11, including false and empty strings', async (context) => {
  const previous = HOOKS.PreToolUse;
  context.after(() => { HOOKS.PreToolUse = previous; });
  for (const [value, output] of [['denied', 'denied'], [false, 'False'], ['', '']] as const) {
    HOOKS.PreToolUse = [() => value];
    assert.equal(await execute_tool(toolCall('bash', { command: 'printf bad', run_in_background: true })), output);
  }
  assert.equal(BACKGROUND.tasks.size, 0);
});
test('background start validates only Bash commands and nonempty strings', () => {
  const manager = new BackgroundManager();
  assert.throws(() => manager.start(toolCall('read_file', { command: 'x' })), /Only Bash/);
  assert.throws(() => manager.start(toolCall('bash', { command: ' ' })), /cannot be empty/);
});
test('tool schemas and Bash exit formatting match Python', (context) => {
  assert.deepEqual({ TOOLS }, pythonReference('s11_background_tasks', workspace(context), {}).result);
  const calls = [{ name: 'run_bash', args: ['printf out; printf err >&2; exit 3'] }, { name: 'run_bash', args: ['true'] }];
  assert.deepEqual(['Error: command exited with status 3\nouterr', '(no output)'], pythonReference('s11_background_tasks', workspace(context), { scenario: 'functions', calls }).result);
});
