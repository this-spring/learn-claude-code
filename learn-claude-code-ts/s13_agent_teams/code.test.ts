import assert from 'node:assert/strict';
import test, { after, beforeEach, afterEach } from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { fixture, response, toolCall, workspace } from '../s04_hooks/test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';

const initial = process.cwd(); const root = realpathSync(mkdtempSync(join(tmpdir(), 'team-parity-')));
process.chdir(root); const lesson = await import('./code.js'); process.chdir(initial);
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  for (const map of [lesson.teammate_assignments, lesson.assignment_versions, lesson.active_teammates, lesson.plan_gates, lesson.plan_request_ids, lesson.pending_requests]) map.clear();
  for (const path of [lesson.TASKS_DIR, lesson.MAILBOX_DIR]) rmSync(path, { force: true, recursive: true });
});
afterEach(async () => {
  for (const name of lesson.active_teammates.keys()) lesson.run_request_shutdown(name);
  const deadline = Date.now() + 3000;
  while (lesson.teammate_threads.size && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.equal(lesson.teammate_threads.size, 0, 'teammate did not stop');
});
function worker(name = 'worker', require_plan = false) {
  lesson.active_teammates.set(name, 'working'); lesson.plan_gates.set(name, require_plan ? 'required' : 'not_required');
  return new lesson.TeammateRuntime(name, 'coder', 'work', null, require_plan);
}
function envelope(overrides: Partial<import('./code.js').Envelope> = {}): import('./code.js').Envelope {
  return { from: 'lead', to: 'worker', content: 'hello', type: 'message', ts: 0, metadata: {}, ...overrides };
}
test('mailboxes validate recipients and consume persisted messages once', () => {
  const bus = new lesson.MessageBus();
  assert.throws(() => bus._path('../escape'));
  bus.send('lead', 'worker', 'hello'); assert.equal(bus.peek('worker'), true);
  assert.equal(bus.read_inbox('worker')[0].content, 'hello'); assert.deepEqual(bus.read_inbox('worker'), []);
});
test('mailbox waiting wakes on a matching message', async () => {
  const bus = new lesson.MessageBus(); const waiting = bus.wait_for_messages('worker', 1);
  setTimeout(() => bus.send('lead', 'worker', 'wake'), 10);
  assert.equal((await waiting)[0].content, 'wake');
});
test('assignment lease survives completion until a model turn boundary', () => {
  const first = lesson.create_task('first'); const second = lesson.create_task('second');
  assert.match(lesson.claim_task(first.id, 'worker'), /^Claimed/); lesson.complete_task(first.id, 'worker');
  assert.match(lesson.claim_task(second.id, 'worker'), /finish the current work turn/);
  assert.equal(lesson.assignment_cwd('worker'), root);
  assert.equal(lesson.release_completed_assignment('worker'), true);
  assert.match(lesson.claim_task(second.id, 'worker'), /^Claimed/);
});
test('exiting workers release unfinished tasks; ownership cannot be bypassed', () => {
  const task = lesson.create_task('first'); lesson.claim_task(task.id, 'worker');
  assert.match(lesson.complete_task(task.id, 'other'), /owned by worker/);
  lesson.release_teammate_assignment('worker');
  assert.equal(lesson.load_task(task.id).status, 'pending'); assert.equal(lesson.load_task(task.id).owner, null);
});
test('unassigned workspace tools fail and required plans block mutations', async () => {
  const runtime = worker();
  assert.match(runtime.write('x', 'x'), /Claim a Task/);
  const task = lesson.create_task('first'); lesson.claim_task(task.id, 'worker'); lesson.plan_gates.set('worker', 'required');
  assert.match(await lesson._run_teammate_tool('worker', toolCall('write_file', { path: 'x', content: 'x' }), runtime.handlers), /plan status is required/);
  assert.equal(existsSync(join(root, 'x')), false);
  assert.match(lesson.complete_task(task.id, 'worker'), /plan status is required/);
});
test('plan response is tied to sender, request, and assignment version', () => {
  worker(); const task = lesson.create_task('first'); lesson.claim_task(task.id, 'worker');
  lesson._teammate_submit_plan('worker', 'edit one file');
  const id = lesson.plan_request_ids.get('worker')!; assert.match(lesson.run_review_plan(id, true), /Plan approved/);
  const message = lesson.BUS.read_inbox('worker')[0];
  assert.equal(lesson.apply_plan_response('worker', { ...message, from: 'attacker' })[0], false);
  assert.equal(lesson.plan_gates.get('worker'), 'pending');
  assert.equal(lesson.apply_plan_response('worker', message)[0], true); assert.equal(lesson.plan_gates.get('worker'), 'approved');
  assert.match(lesson.run_review_plan(id, true), /already approved/);
});
test('new assignments invalidate approvals and plain messages cannot approve work', () => {
  const runtime = worker(); lesson._teammate_submit_plan('worker', 'plan'); const id = lesson.plan_request_ids.get('worker')!;
  lesson.claim_task(lesson.create_task('task').id, 'worker');
  assert.match(lesson.run_review_plan(id, true), /earlier assignment/);
  runtime.handle_inbox([envelope({ content: 'approved!', metadata: { request_id: id, approve: true } })]);
  assert.equal(lesson.plan_gates.get('worker'), 'required');
});
test('shutdown requires a pending Lead request and matching response identity', () => {
  worker(); lesson.run_request_shutdown('worker'); const message = lesson.BUS.read_inbox('worker')[0];
  assert.equal(lesson.apply_shutdown_request('worker', { ...message, from: 'attacker' })[0], false);
  const [accepted, id] = lesson.apply_shutdown_request('worker', message); assert.equal(accepted, true);
  assert.equal(lesson.match_response('shutdown_response', id, true, 'attacker', 'lead'), false);
  assert.equal(lesson.match_response('shutdown_response', id, true, 'worker', 'lead'), true);
  assert.equal(lesson.match_response('shutdown_response', id, true, 'worker', 'lead'), false);
});
test('reserved names and task dependency updates preserve original boundaries', () => {
  assert.match(lesson.spawn_teammate_thread('Lead', 'coder', 'task'), /reserved/);
  const first = lesson.create_task('first'); const second = lesson.create_task('second');
  lesson.update_task(second.id, [first.id]); assert.throws(() => lesson.update_task(first.id, [second.id]), /cycle/);
  assert.equal(lesson.TEAMMATE_TOOLS.some((tool) => ['update_task', 'create_worktree', 'remove_worktree'].includes(tool.name)), false);
  assert.equal(lesson.TOOLS.some((tool) => tool.name === 'remove_worktree'), false);
});
test('teammates keep complete tool history, report results, idle and shut down', async (context) => {
  const { options, requests } = fixture(context, [response([toolCall('missing', {}, 'one')]), response()]);
  context.mock.method(lesson.client.messages, 'create', options.client.messages.create);
  assert.match(lesson.spawn_teammate_thread('persistent', 'coder', 'work'), /without an initial Task/);
  const deadline = Date.now() + 3000;
  while (lesson.active_teammates.get('persistent') !== 'idle' && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.equal(requests.length, 2); assert.match(JSON.stringify(requests[1].messages), /tool_use_id.*one/);
  assert.deepEqual(lesson.consume_lead_inbox().map((message) => message.type), ['result', 'idle_notification']);
  lesson.run_request_shutdown('persistent'); await lesson.teammate_threads.get('persistent');
  assert.deepEqual(lesson.consume_lead_inbox().map((message) => message.type), ['shutdown_response']);
});
test('teammate model exceptions release task ownership', async (context) => {
  const { options } = fixture(context, [new Error('model failure')]); context.mock.method(lesson.client.messages, 'create', options.client.messages.create);
  const task = lesson.create_task('first'); lesson.spawn_teammate_thread('failing', 'coder', 'work', task.id, true);
  assert.equal(lesson.plan_gates.get('failing'), 'required');
  await lesson.teammate_threads.get('failing');
  assert.equal(lesson.load_task(task.id).owner, null); assert.equal(lesson.load_task(task.id).status, 'pending');
});
test('lead releases completed leases on both normal and failed model exits', async (context) => {
  for (const failure of [false, true]) {
    const task = lesson.create_task('lead work'); lesson.claim_task(task.id); lesson.complete_task(task.id);
    const { options } = fixture(context, [failure ? new Error('offline') : response()]);
    await lesson.agent_loop([], options.client, options.model);
    assert.equal(lesson.teammate_assignments.has('agent'), false);
  }
});
test('worktree lifecycle respects leases, rejects dirty removal and retains branches', () => {
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.name', 'Offline Test'], ['config', 'user.email', 'offline@example.invalid']]) assert.equal(lesson.run_git(args)[0], true);
  writeFileSync(join(root, 'seed.txt'), 'seed'); writeFileSync(join(root, '.gitignore'), '.tasks/\n.mailboxes/\n.worktrees/\n');
  assert.equal(lesson.run_git(['add', 'seed.txt', '.gitignore'])[0], true); assert.equal(lesson.run_git(['commit', '-m', 'fixture'])[0], true);
  const task = lesson.create_task('isolated'); assert.match(lesson.create_worktree('isolated', task.id), /created at/);
  assert.match(lesson.claim_task(task.id, 'worker'), /^Claimed/);
  const cwd = lesson.assignment_cwd('worker'); assert.equal(cwd, join(root, '.worktrees/isolated'));
  assert.match(lesson.run_read('../seed.txt', undefined, cwd), /escapes workspace/);
  lesson.run_write('changed.txt', 'dirty', cwd); lesson.complete_task(task.id, 'worker');
  assert.match(lesson.remove_worktree('isolated'), /still in use/); lesson.release_completed_assignment('worker');
  assert.match(lesson.remove_worktree('isolated'), /uncommitted change/);
  assert.match(lesson.remove_worktree('isolated', true), /branch 'wt\/isolated' retained/);
  assert.match(lesson.run_git(['branch', '--list', 'wt/isolated'])[1], /wt\/isolated/);
  assert.equal(lesson.load_task(task.id).worktree, null);
});
test('pathlib glob includes dotfiles and only directories for a trailing globstar', () => {
  const directory = join(root, 'glob-test'); mkdirSync(join(directory, 'nested'), { recursive: true });
  writeFileSync(join(directory, '.hidden'), ''); writeFileSync(join(directory, 'nested/file'), '');
  assert.match(lesson.run_glob('*', directory), /\.hidden/);
  assert.equal(lesson.run_glob('**', directory), '.\nnested');
  rmSync(directory, { recursive: true });
});
test('OS task lock serializes competing claims across two host processes', async () => {
  const task = lesson.create_task('contested');
  const modulePath = fileURLToPath(new URL('./code.ts', import.meta.url));
  const run = (owner: string) => new Promise<string>((done, reject) => {
    const script = `const m = await import(${JSON.stringify(modulePath)}); console.log('RESULT:' + m.claim_task(${JSON.stringify(task.id)}, ${JSON.stringify(owner)}));`;
    const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url)), '--input-type=module', '-e', script], { cwd: root });
    let output = ''; let errors = ''; child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { errors += data; });
    child.once('error', reject); child.once('close', (code) => code === 0 ? done(output) : reject(new Error(errors)));
  });
  const outputs = await Promise.all([run('alice'), run('bob')]);
  assert.equal(outputs.filter((text) => text.includes('RESULT:Claimed')).length, 1);
  assert.equal(lesson.load_task(task.id).status, 'in_progress');
});
test('all Lead and teammate tool schemas match Python exactly', (context) => {
  const names = ['BASE_TOOLS', 'TASK_TOOLS', 'TEAM_TOOLS', 'TEAMMATE_TOOLS', 'TOOLS'] as const;
  const actual = Object.fromEntries(names.map((name) => [name, lesson[name]]));
  assert.deepEqual(actual, pythonReference('s13_agent_teams', workspace(context), { names }).result);
});
