import assert from 'node:assert/strict';
import test, { after, afterEach, beforeEach } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { fixture, response, toolCall, workspace } from '../s04_hooks/test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';

const initial = process.cwd(); const root = realpathSync(mkdtempSync(join(tmpdir(), 'integrated-parity-')));
const previousFallback = process.env.FALLBACK_MODEL_ID; process.env.FALLBACK_MODEL_ID = 'offline-fallback';
process.chdir(root); const lesson = await import('./code.js'); process.chdir(initial);
if (previousFallback === undefined) delete process.env.FALLBACK_MODEL_ID; else process.env.FALLBACK_MODEL_ID = previousFallback;
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  for (const map of [lesson.teammate_assignments, lesson.assignment_versions, lesson.active_teammates, lesson.plan_gates, lesson.plan_request_ids, lesson.pending_requests, lesson.background_tasks, lesson.background_results, lesson.scheduled_jobs, lesson.mcp_clients]) map.clear();
  lesson.cron_queue.length = 0;
  for (const path of ['.tasks', '.mailboxes', '.memory', '.scheduled_tasks.json', '.scheduled_tasks.json.tmp']) rmSync(join(root, path), { recursive: true, force: true });
});
afterEach(async () => {
  lesson.stop_async_events(); lesson.stop_runtime_services();
  for (const name of lesson.active_teammates.keys()) lesson.run_request_shutdown(name);
  const deadline = Date.now() + 3000;
  while (lesson.active_teammates.size && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  await lesson._stop_all_shell_processes();
});
function model(context: Parameters<typeof fixture>[0], replies: Parameters<typeof fixture>[1]) {
  const mocked = fixture(context, replies); context.mock.method(lesson.client.messages, 'create', mocked.options.client.messages.create);
  return mocked;
}
function noMemory(context: Parameters<typeof fixture>[0]): void {
  context.mock.method(lesson.MEMORY_RUNTIME, 'read_memory_index', () => '');
  context.mock.method(lesson.MEMORY_RUNTIME, 'load_memories', async () => '');
  context.mock.method(lesson.MEMORY_RUNTIME, 'extract_memories', async () => 0);
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.ok(predicate(), 'condition did not become true');
}
test('integrated schemas contain exactly the 26 original builtins and five subagent tools', (context) => {
  assert.equal(lesson.BUILTIN_TOOLS.length, 26);
  assert.deepEqual({ BUILTIN_TOOLS: lesson.BUILTIN_TOOLS, SUB_TOOLS: lesson.SUB_TOOLS }, pythonReference('s15_integrated_harness', workspace(context), { names: ['BUILTIN_TOOLS', 'SUB_TOOLS'] }).result);
  assert.equal(lesson.BUILTIN_TOOLS.some((tool) => tool.name === 'remove_worktree'), false);
});
test('integrated Todo validation keeps its own rules rather than s05 normalization', () => {
  assert.equal(lesson.run_todo_write([{ content: '', status: 'pending' }, { content: null, status: 'in_progress' }, { content: 'more', status: 'in_progress' }]), 'Updated 3 todos');
  assert.match(lesson.run_todo_write([{ content: 'bad', status: 'PENDING' }]), /invalid status/);
  assert.match(lesson.run_todo_write([{ content: 'missing' }]), /missing 'content' or 'status'/);
  assert.equal(lesson.CURRENT_TODOS.length, 3);
});
test('file reads preserve zero limit, offset and first-only editing', () => {
  lesson.run_write('file.txt', 'first\nsecond\nthird\n');
  assert.equal(lesson.run_read('file.txt', 0), '... (3 more lines)');
  assert.equal(lesson.run_read('file.txt', 1, 1), 'second\n... (1 more lines)');
  lesson.run_write('edit.txt', 'same same'); assert.equal(lesson.run_edit('edit.txt', 'same', '$&'), 'Edited edit.txt');
  assert.equal(lesson.run_read('edit.txt'), '$& same');
});
test('every interactive shell command is approved through the console; paths outside are denied', async (context) => {
  context.mock.method(lesson.CONSOLE, 'ask', async () => 'n');
  assert.equal(await lesson.permission_hook(toolCall('bash', { command: 'printf safe' })), 'Permission denied by user');
  context.mock.method(lesson.CONSOLE, 'ask', async () => 'yes');
  assert.equal(await lesson.permission_hook(toolCall('bash', { command: 'printf safe' })), null);
  assert.match((await lesson.permission_hook(toolCall('bash', { command: 'sudo whoami' })))!, /on the deny list/);
  assert.equal(await lesson.permission_hook(toolCall('read_file', { path: '/outside-workspace' })), 'Permission denied: path is outside the workspace');
});
test('429 retries stop after exactly three calls; unrelated errors propagate', async () => {
  const state = new lesson.RecoveryState(); let attempts = 0; const sleeps: number[] = [];
  await assert.rejects(lesson.with_retry(() => { attempts += 1; throw new Error('429'); }, state, async (seconds) => { sleeps.push(seconds); }), /Max retries \(3\) exceeded/);
  assert.equal(attempts, 3); assert.equal(sleeps.length, 3);
  assert.ok(sleeps[0] >= 0.5 && sleeps[0] <= 0.625);
  await assert.rejects(lesson.with_retry(() => { throw new Error('bad request'); }, state, async () => {}), /bad request/);
});
test('two consecutive 529 responses switch the recovery model', async () => {
  const state = new lesson.RecoveryState(); let calls = 0;
  const result = await lesson.with_retry(() => { if (++calls < 3) throw new Error('529 overloaded'); return state.current_model; }, state, async () => {});
  assert.equal(result, 'offline-fallback'); assert.equal(state.consecutive_529, 0);
});
test('max_tokens first escalates without appending the truncated response', async (context) => {
  noMemory(context);
  const { requests } = model(context, [response([{ type: 'text', text: 'discarded partial', citations: null }], 'max_tokens'), response()]);
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: 'work' }]; await lesson.agent_loop(history, {}, 'work');
  assert.equal(requests[0].max_tokens, 8000); assert.equal(requests[1].max_tokens, 16000);
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /discarded partial/);
});
test('repeated max_tokens appends at most two continuation requests', async (context) => {
  noMemory(context);
  const { requests } = model(context, Array.from({ length: 4 }, () => response([], 'max_tokens')));
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: 'work' }]; await lesson.agent_loop(history, {}, 'work');
  assert.equal(requests.length, 4);
  assert.equal(history.filter((message) => message.content === lesson.CONTINUATION_PROMPT).length, 2);
});
test('prompt-too-long recovery attempts a summary once and restores cron on terminal error', async (context) => {
  noMemory(context);
  const job = lesson.schedule_job('* * * * *', 'wake', false, false);
  assert.notEqual(typeof job, 'string'); lesson._enqueue_due_job(job as InstanceType<typeof lesson.CronJob>);
  const { requests } = model(context, [new Error('prompt too long'), response(), new Error('prompt too long')]);
  const history: Anthropic.MessageParam[] = [{ role: 'user', content: 'work' }]; await lesson.agent_loop(history, {}, 'work');
  assert.equal(requests.length, 3); assert.match(JSON.stringify(history), /\[Error\].*prompt too long/);
  assert.equal(lesson.cron_queue.length, 1);
});
test('explicit compaction waits for the entire tool batch and records the authoritative request', async (context) => {
  noMemory(context);
  const { requests } = model(context, [response([toolCall('compact', {}, 'compact-1'), toolCall('missing', {}, 'unknown-1')]), response(), response()]);
  await lesson.agent_loop([{ role: 'user', content: 'current task' }], {}, 'current task');
  assert.match(JSON.stringify(requests[1].messages), /compact-1[\s\S]*unknown-1/);
  assert.match(JSON.stringify(requests[2].messages), /Authoritative request.*current task/);
});
test('integrated memory uses s09 recall and extraction with the shared client', async (context) => {
  const candidate = { name: 'Preference', type: 'user', scope: 'persistent', description: 'Prefer strict TypeScript', body: 'Use strict TypeScript in later projects.' };
  model(context, [response(), response([{ type: 'text', text: JSON.stringify([candidate]), citations: null }])]);
  await lesson.agent_loop([{ role: 'user', content: 'Remember my TypeScript preference' }], {}, 'Remember my TypeScript preference');
  assert.equal(lesson.MEMORY_RUNTIME.list_memory_files().length, 1);
  assert.match(lesson.MEMORY_RUNTIME.read_memory_index(), /Preference/);
});
test('background work runs in captured assignment cwd and notifies exactly once after PostToolUse', async (context) => {
  let post = 0; const previous = lesson.HOOKS.PostToolUse;
  context.after(() => { lesson.HOOKS.PostToolUse = previous; }); lesson.HOOKS.PostToolUse = [() => { post += 1; return null; }];
  const id = lesson.start_background_task(toolCall('bash', { command: 'printf finished' }), {});
  await until(() => lesson.background_tasks.get(id)?.status !== 'running');
  assert.equal(post, 1); assert.equal(lesson.has_pending_background(), true);
  const collected = await Promise.all([Promise.resolve().then(lesson.collect_background_results), Promise.resolve().then(lesson.collect_background_results)]);
  assert.equal(collected.flat().length, 1); assert.match(collected.flat()[0], /completed[\s\S]*finished/); assert.equal(lesson.has_pending_background(), false);
});
test('PostToolUse failures yield terminal failed background notifications', async (context) => {
  const previous = lesson.HOOKS.PostToolUse; context.after(() => { lesson.HOOKS.PostToolUse = previous; });
  lesson.HOOKS.PostToolUse = [() => { throw new Error('hook failed'); }];
  const id = lesson.start_background_task(toolCall('bash', { command: 'printf result' }), {});
  await until(() => lesson.background_tasks.get(id)?.status !== 'running');
  assert.match(lesson.collect_background_results()[0], /failed[\s\S]*PostToolUse hook failed/);
});
test('async event turns wake for background output and cannot request shell approval', async (context) => {
  noMemory(context);
  const { requests } = model(context, [response([toolCall('bash', { command: 'printf safe' })]), response()]);
  const history: Anthropic.MessageParam[] = [];
  lesson.background_tasks.set('bg_wake', { command: 'echo done', tool_use_id: 'original', status: 'completed', cwd: root }); lesson.background_results.set('bg_wake', 'done');
  const loop = lesson.async_event_loop(history, {}, { active_user_request: 'keep working' });
  await until(() => requests.length === 2); lesson.stop_async_events();
  assert.match(JSON.stringify(requests[1].messages), /interactive shell approval is unavailable during an asynchronous turn/);
  assert.equal(lesson.background_tasks.size, 0);
  await new Promise((done) => setTimeout(done, 1010)); await loop;
});
test('persistent teammate retains messages and reads shutdown between tool rounds', async (context) => {
  let calls = 0; const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  context.mock.method(lesson.client.messages, 'create', async (request: Anthropic.MessageCreateParamsNonStreaming) => {
    requests.push(structuredClone(request)); calls += 1;
    if (calls === 1) return response([toolCall('missing', {}, 'first')]);
    lesson.run_request_shutdown('worker'); return response([toolCall('missing', {}, 'second')]);
  });
  lesson.spawn_teammate_thread('worker', 'coder', 'work');
  await until(() => !lesson.active_teammates.has('worker'));
  assert.equal(calls, 2); assert.match(JSON.stringify(requests[1].messages), /tool_use_id.*first/);
  assert.equal(lesson.consume_lead_inbox().some((message) => message.type === 'shutdown_response'), true);
});
test('Cron one-shots are removed only after model acceptance', async (context) => {
  noMemory(context); const result = lesson.schedule_job('* * * * *', '', false, false);
  assert.notEqual(typeof result, 'string'); const job = result as InstanceType<typeof lesson.CronJob>; lesson._enqueue_due_job(job);
  model(context, [response()]); await lesson.agent_loop([], {}, 'scheduled');
  assert.equal(lesson.scheduled_jobs.has(job.id), false);
});
test('integrated context estimates and validation diagnostics match Python', (context) => {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: '😀中文' }];
  const calls = [{ name: 'estimate_size', args: [messages] }, { name: '_normalize_todos', args: [[{ content: '', status: 'pending' }]] }, { name: 'validate_cron', args: ['99 * * * *'] }];
  assert.deepEqual([lesson.estimate_size(messages), lesson._normalize_todos([{ content: '', status: 'pending' }]), lesson.validate_cron('99 * * * *')], pythonReference('s15_integrated_harness', workspace(context), { scenario: 'functions', calls }).result);
});
