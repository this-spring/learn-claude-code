import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Budget, ExecutionLimits, ExecutionState, LocalWorkflowTask, MockAgentRunner, SAMPLE_META, SimpleJsonSchema, WorkflowJournal, WorkflowTool, WORKFLOWS, WORKFLOW_TOOL, DEMO_CHANGES, MISS, _parse_runner_json, check_permission, install_workflow_tool, load_integrated_host, run_workflow, set_runner_factory, set_runtime_store, validate_meta, validate_run_id, workflow_run_lock, type AgentRunner, type Workflow, type Schema } from './code.js';
import { fixture, workspace } from '../s04_hooks/test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';
import { STORE } from './code.js';

beforeEach((context) => { set_runtime_store(workspace(context as Parameters<typeof workspace>[0])); set_runner_factory(() => new MockAgentRunner()); });
function state(context: Parameters<typeof workspace>[0], runner: AgentRunner = new MockAgentRunner(), budget = new Budget()) {
  const journal = new WorkflowJournal('wf_test_0123456789abcdef', false, workspace(context)); context.after(() => journal.close());
  const task = new LocalWorkflowTask('local', 'wf_test_0123456789abcdef', SAMPLE_META);
  return new ExecutionState(task, journal, runner, budget, {});
}
test('metadata and run IDs follow the Python validation, including whitespace-only descriptions', () => {
  assert.throws(() => validate_meta({ name: '../escape', description: 'x' }));
  assert.throws(() => validate_run_id('../../escape')); assert.throws(() => validate_meta({ name: 'valid', description: 'x', phases: [''] }));
  assert.equal(validate_meta({ name: 'valid', description: ' ', phases: [' '] }).name, 'valid');
});
test('schema validation retains Python numeric and enum equality semantics', () => {
  assert.deepEqual(new SimpleJsonSchema({ type: 'integer' }).validate(1.5), [true, null]);
  assert.deepEqual(new SimpleJsonSchema({ enum: [1] }).validate(true), [true, null]);
  assert.deepEqual(new SimpleJsonSchema({ type: 'array', items: { type: 'boolean' } }).validate([true, 0]), [false, '[1]: expected boolean']);
});
test('runner JSON accepts fenced values but scans only object prefixes after a parse failure', () => {
  assert.deepEqual(_parse_runner_json('```json\n{"ok":true}\n```'), { ok: true });
  assert.deepEqual(_parse_runner_json('prefix {"value":"}"} suffix'), { value: '}' });
  assert.throws(() => _parse_runner_json('prefix [1,2] suffix'), /invalid JSON/);
});
test('journal records false/null and a fresh journal truncates its file', (context) => {
  const root = workspace(context); const journal = new WorkflowJournal('test', false, root);
  journal.record('false', false); journal.record('null', null); journal.close();
  const resumed = new WorkflowJournal('test', true, root); assert.equal(resumed.cached('false'), false); assert.equal(resumed.cached('null'), null); assert.equal(resumed.cached('missing'), MISS); resumed.close();
  const fresh = new WorkflowJournal('test', false, root); fresh.close(); assert.equal(readFileSync(join(root, 'test.journal.jsonl'), 'utf8'), '');
});
test('demo output, token usage, semantic keys and mock schemas match Python', async (context) => {
  const expected = pythonReference('s16_workflow_runtime', workspace(context), { scenario: 'workflow' });
  const actual = await run_workflow(SAMPLE_META.name, { budget: null, changes: DEMO_CHANGES });
  assert.deepEqual(actual.result, (expected.result as { result: unknown }).result);
  assert.deepEqual(actual.task.usage, (expected.result as { task: { usage: unknown } }).task.usage);
  const journal = new WorkflowJournal('keys', false, workspace(context)); context.after(() => journal.close());
  const calls = [
    { kind: 'schema', schema: { type: 'integer' }, value: 1.5 },
    { kind: 'runner', prompt: '😀prompt', schema: { type: 'object', properties: { findings: { type: 'array' } } }, label: 'audit' },
    { kind: 'key', prompt: '😀prompt', schema: { properties: { z: {}, a: {} }, type: 'object' }, label: 'audit' },
  ];
  const result = [new SimpleJsonSchema({ type: 'integer' }).validate(1.5), new MockAgentRunner().run('😀prompt', calls[1].schema as Schema, 'audit'), journal.key('agent', 'audit', '😀prompt', calls[2].schema as Schema)];
  assert.deepEqual(JSON.parse(JSON.stringify(result)), pythonReference('s16_workflow_runtime', workspace(context), { scenario: 'workflow_primitives', calls }).result);
});
test('resume uses cached values with zero new token or agent usage', async () => {
  const first = await run_workflow(SAMPLE_META.name, { changes: 'const answer = 42;' });
  const resumed = await run_workflow(SAMPLE_META.name, null, String(first.task.runId));
  assert.equal(first.task.status, 'completed'); assert.deepEqual(resumed.result, first.result); assert.deepEqual(resumed.task.usage, { agents: 0, tokens: 0 });
});
test('mismatched resume arguments and corrupt journals preserve the prior output', async () => {
  const first = await run_workflow(SAMPLE_META.name, { changes: 'first' }); const id = String(first.task.runId);
  const path = join(STORE, `${id}.output.json`); const before = readFileSync(path, 'utf8');
  await assert.rejects(run_workflow(SAMPLE_META.name, { changes: 'different' }, id), /args do not match/); assert.equal(readFileSync(path, 'utf8'), before);
  writeFileSync(join(STORE, `${id}.journal.jsonl`), '{broken\n');
  await assert.rejects(run_workflow(SAMPLE_META.name, null, id), /invalid resume journal record at line 1/); assert.equal(readFileSync(path, 'utf8'), before);
});
test('structured output retries once, validates before charging and releases semaphore before retry', async (context) => {
  let calls = 0; const available: number[] = []; let ctx: ExecutionState;
  const runner: AgentRunner = { run: () => { calls += 1; available.push(ctx._limits.semaphore._value); return { value: calls === 1 ? 'invalid' : { ok: true }, tokens: 3 }; } };
  ctx = state(context, runner);
  assert.deepEqual(await ctx.agent('task', { type: 'object', required: ['ok'] }), { ok: true });
  assert.deepEqual(ctx.task.usage, { agents: 1, tokens: 6 }); assert.deepEqual(available, [7, 8]);
});
test('invalid structured retries do not charge usage or record journal output', async (context) => {
  const ctx = state(context, { run: () => ({ value: 'invalid', tokens: 3 }) });
  await assert.rejects(ctx.agent('task', { type: 'object' }), /invalid output/);
  assert.deepEqual(ctx.task.usage, { agents: 0, tokens: 0 }); assert.equal(ctx.budget.spent(), 0); assert.equal(ctx.journal.cache.size, 0);
});
test('run-wide semaphore caps first attempts at eight', async (context) => {
  let active = 0; let peak = 0;
  const runner: AgentRunner = { run: async () => { active += 1; peak = Math.max(peak, active); await new Promise((done) => setTimeout(done, 5)); active -= 1; return { value: 'done', tokens: 1 }; } };
  const ctx = state(context, runner); await ctx.parallel(Array.from({ length: 18 }, (_, i) => () => ctx.agent(`step ${i}`)));
  assert.equal(peak, 8);
});
test('pipeline advances each item without a cross-item barrier and parallel fails without waiting for every branch', async (context) => {
  const ctx = state(context); const order: string[] = [];
  await ctx.pipeline(['fast', 'slow'], async (_value, item) => { if (item === 'slow') await new Promise((done) => setTimeout(done, 10)); order.push(`${item}:audit`); return item; }, async (value, item) => { order.push(`${item}:verify`); return value; });
  assert.ok(order.indexOf('fast:verify') < order.indexOf('slow:audit'));
  let finished = false;
  const slow = new Promise<void>((done) => setTimeout(() => { finished = true; done(); }, 20));
  await assert.rejects(ctx.parallel([async () => { throw new Error('fail'); }, async () => { await slow; }]), /fail/);
  assert.equal(finished, false); await slow;
});
test('budgets reject overspend before mutation and zero budgets also block cached calls', async (context) => {
  assert.throws(() => check_permission({ name: 'denied', description: 'x' }, { deny: ['denied'] }), /denied/);
  const budget = new Budget(3); assert.throws(() => budget.add(4), /exceeded/); assert.equal(budget.spent(), 0);
  const ctx = state(context, new MockAgentRunner(), new Budget(0)); ctx.journal.record(ctx.journal.key('agent', 'label', 'task'), 'cached');
  await assert.rejects(ctx.agent('task', null, 'label'), /token budget exceeded/);
});
test('agent cap applies before cache lookup and nested workflows share limits', async (context) => {
  const ctx = state(context); ctx._limits.agents = 1000;
  await assert.rejects(ctx.agent('task'), /cap reached/);
  const name = 'nested-test'; const nested: Workflow = async (child) => child.workflow(name);
  WORKFLOWS.set(name, [{ name, description: 'nested' }, nested]); context.after(() => WORKFLOWS.delete(name));
  await assert.rejects(state(context).workflow(name), /nesting is one level only/);
});
test('OS run locks reject active ownership but allow pre-existing unlocked lock files', async () => {
  const id = 'wf_test_0123456789abcdef'; let release!: () => void;
  const pending = workflow_run_lock(id, async () => new Promise<void>((done) => { release = done; }));
  await assert.rejects(workflow_run_lock(id, async () => 'no'), /already active/); release(); await pending;
  assert.equal(existsSync(join(STORE, `${id}.lock`)), true); assert.equal(await workflow_run_lock(id, async () => 'yes'), 'yes');
});
test('workflow failures write terminal snapshots with lifecycle events separate from progress', async () => {
  const out = await new WorkflowTool().call({ name: 'failure', description: 'fail' }, async () => { throw new Error('failed work'); });
  assert.equal(out.task.status, 'failed'); assert.deepEqual(out.result, { error: 'failed work' });
  assert.deepEqual(out.task.progress, []); assert.match(readFileSync(join(STORE, `${out.task.run_id}.output.json`), 'utf8'), /failed work/);
});
test('model adapter extends s15 without extra inheritance and runs through the shared client', async (context) => {
  const host = await load_integrated_host(); const mocked = fixture(context); context.mock.method(host.client.messages, 'create', mocked.options.client.messages.create);
  install_workflow_tool(host); install_workflow_tool(host); const [tools, handlers] = host.assemble_tool_pool();
  assert.equal(tools.length, 27); assert.equal(tools.filter((tool) => tool.name === 'Workflow').length, 1);
  const name = 'one-step'; WORKFLOWS.set(name, [{ name, description: 'one step' }, (ctx) => ctx.agent('focus')]); context.after(() => WORKFLOWS.delete(name));
  const out = JSON.parse(String(await handlers.Workflow({ name })));
  assert.equal(out.result, 'done'); assert.equal(mocked.requests.length, 1);
  assert.deepEqual({ WORKFLOW_TOOL }, pythonReference('s16_workflow_runtime', workspace(context), { names: ['WORKFLOW_TOOL'] }).result);
});
