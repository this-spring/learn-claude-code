import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { fixture, response, toolCall, workspace } from '../s04_hooks/test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';

const initial = process.cwd(); const root = realpathSync(mkdtempSync(join(tmpdir(), 's03-parity-')));
process.chdir(root); const lesson = await import('./code.js'); process.chdir(initial);
after(() => rmSync(root, { recursive: true, force: true }));
test('hard deny has priority over approval and exposes original diagnostics', async () => {
  let approvals = 0;
  for (const command of lesson.DENY_LIST) assert.equal(await lesson.check_permission(toolCall('bash', { command }), async () => { approvals += 1; return 'allow'; }), false);
  assert.equal(approvals, 0); assert.equal(lesson.check_deny_list('sudo whoami'), "Blocked: 'sudo' is on the deny list");
});
test('rules check reads/writes/edits outside the workspace with the original reason', (context) => {
  const outside = workspace(context);
  for (const tool of ['read_file', 'write_file', 'edit_file']) assert.equal(lesson.check_rules(tool, { path: join(outside, 'note') }), 'Writing outside workspace');
  assert.equal(lesson.check_rules('glob', { pattern: '../*' }), null);
  assert.equal(lesson.check_rules('bash', { command: 'echo hello;RM file' }), 'Potentially destructive command');
});
test('approved dangling symlinks are resolved and written as Python allows', async (context) => {
  const outside = workspace(context); const target = join(outside, 'created'); symlinkSync(target, join(root, 'dangling'));
  let approvals = 0;
  assert.equal(await lesson.check_permission(toolCall('write_file', { path: 'dangling', content: 'yes' }), async () => { approvals += 1; return 'allow'; }), true);
  assert.equal(approvals, 1); assert.equal(lesson.run_write('dangling', 'yes'), 'Wrote 3 bytes to dangling'); assert.equal(readFileSync(target, 'utf8'), 'yes');
});
test('approval waits for the exact rule decision and unexpected decisions are not treated as deny', async (context) => {
  const block = toolCall('read_file', { path: join(workspace(context), 'external') });
  for (const decision of ['allow', 'deny', 'other']) assert.equal(await lesson.check_permission(block, async () => decision), decision !== 'deny');
  await assert.rejects(lesson.check_permission(block, async () => { throw new Error('EOF'); }), /EOF/);
});
test('ask_user accepts only y/yes after normalization', async () => {
  for (const answer of ['y', ' YES ', '', 'allow', 'yes please']) assert.equal(await lesson.ask_user('bash', { command: 'rm file' }, 'reason', async () => answer), ['y', 'yes'].includes(answer.trim().toLowerCase()) ? 'allow' : 'deny');
});
test('ordinary tools pass without approval and direct Bash execution no longer has a deny list', async () => {
  let asked = false;
  assert.equal(await lesson.check_permission(toolCall('bash', { command: 'printf hello' }), async () => { asked = true; return 'deny'; }), true);
  assert.equal(asked, false); assert.equal(lesson.run_bash('printf sudo'), 'sudo');
});
test('mixed allowed and denied calls stay paired with exact tool IDs', async (context) => {
  const { options, requests } = fixture(context, [response([toolCall('write_file', { path: 'allowed.txt', content: 'yes' }, 'write'), toolCall('bash', { command: 'sudo whoami' }, 'denied'), toolCall('read_file', { path: 'allowed.txt' }, 'read')]), response()]);
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: 'work' }]; await lesson.agent_loop(history, options.client, options.model);
  assert.deepEqual(history[2].content, [{ type: 'tool_result', tool_use_id: 'write', content: 'Wrote 3 bytes to allowed.txt' }, { type: 'tool_result', tool_use_id: 'denied', content: 'Permission denied.' }, { type: 'tool_result', tool_use_id: 'read', content: 'yes' }]);
  assert.equal(requests.length, 2);
});
test('separate approved outside writes and reads execute after each decision', async (context) => {
  const target = join(workspace(context), 'external'); const approvals: string[] = [];
  const { options } = fixture(context, [response([toolCall('write_file', { path: target, content: 'yes' }), toolCall('read_file', { path: target })]), response()]);
  await lesson.agent_loop([], options.client, options.model, async (name) => { approvals.push(name); return 'allow'; });
  assert.deepEqual(approvals, ['write_file', 'read_file']); assert.equal(readFileSync(target, 'utf8'), 'yes');
});
test('schemas and permission rules match Python', (context) => {
  assert.deepEqual({ TOOLS: lesson.TOOLS }, pythonReference('s03_permission', workspace(context), {}).result);
  const calls = [{ name: 'check_deny_list', args: ['sudo whoami'] }, { name: 'check_rules', args: ['bash', { command: 'echo done;del x' }] }, { name: 'check_rules', args: ['read_file', { path: '../outside.txt' }] }];
  assert.deepEqual([lesson.check_deny_list('sudo whoami'), lesson.check_rules('bash', { command: 'echo done;del x' }), lesson.check_rules('read_file', { path: '../outside.txt' })], pythonReference('s03_permission', workspace(context), { scenario: 'functions', calls }).result);
});
