import { pythonReference } from '../scripts/parity-helpers.js';
import Anthropic from '@anthropic-ai/sdk';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import {
  AgentSession, CLEAR_ALIASES, GoalController, GoalError, MAX_GOAL_LENGTH,
  PromptGoalEvaluator, TOOLS, _parse_json_object, transcript_text,
  type GoalEvaluation, type GoalEvaluator,
} from './code.js';

const fixture = mkdtempSync(join(tmpdir(), 'learn-s17-'));
const workspace = join(fixture, 'workspace');
mkdirSync(workspace);
after(() => rmSync(fixture, { recursive: true, force: true }));

function fakeClient(contents: unknown[][]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = new Anthropic({ apiKey: 'offline', authToken: null, baseURL: 'https://offline.invalid', maxRetries: 0,
    fetch: async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      const content = contents.shift();
      assert.ok(content, 'unexpected model call');
      return new Response(JSON.stringify({ id: 'message', type: 'message', role: 'assistant', model: 'test', content,
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
    } });
  return { client, calls };
}

function evaluator(results: GoalEvaluation[] = []) {
  const calls: Anthropic.MessageParam[][] = [];
  const instance: GoalEvaluator = { evaluate: async (_condition, messages) => {
    calls.push(structuredClone(messages));
    const result = results.shift();
    assert.ok(result, 'unexpected evaluator call');
    return result;
  } };
  return { instance, calls };
}
const text = (value: string) => [{ type: 'text', text: value }];
const tool = (name: string, input: unknown, id = 'call') => [{ type: 'tool_use', id, name, input }];

test('unmet goals automatically continue through the same conversation', async () => {
  const worker = fakeClient([text('changed'), text('tests pass')]);
  const judge = evaluator([{ ok: false, reason: 'missing test output' }, { ok: true, reason: 'evidence found' }]);
  const session = new AgentSession(worker.client, 'worker', new GoalController(judge.instance), workspace);
  assert.equal((await session.submit('/goal tests pass')).status, 'achieved');
  assert.equal(session.goal.active, null);
  assert.equal(worker.calls.length, 2);
  assert.equal(judge.calls.length, 2);
  assert.match(String(session.messages[2].content), /missing test output/);
  assert.equal(session.total_tokens, 30);
});

test('worker command exit codes and paired tool results reach the evaluator', async () => {
  const worker = fakeClient([tool('bash', { command: `"${process.execPath}" -e "process.stdout.write('passed')"` }), text('verified')]);
  const judge = evaluator([{ ok: true, reason: 'exit_code=0 in transcript' }]);
  const session = new AgentSession(worker.client, 'worker', new GoalController(judge.instance), workspace);
  assert.equal((await session.submit('/goal command exits with zero')).status, 'achieved');
  assert.match(transcript_text(judge.calls[0]), /exit_code=0\npassed/);
  assert.deepEqual(worker.calls[0].tools, TOOLS);
  const results = session.messages[2].content;
  assert.ok(Array.isArray(results));
  assert.deepEqual(results[0], { type: 'tool_result', tool_use_id: 'call', content: 'exit_code=0\npassed' });
});

test('without a goal the loop stops without consulting an evaluator', async () => {
  const worker = fakeClient([text('done')]);
  const judge = evaluator();
  const session = new AgentSession(worker.client, 'worker', new GoalController(judge.instance), workspace);
  assert.equal((await session.submit('hello')).status, 'allow');
  assert.equal(judge.calls.length, 0);
});

test('background work defers judgment then resumes with its actual result', async () => {
  let running = true;
  const worker = fakeClient([text('waiting'), text('verified')]);
  const judge = evaluator([{ ok: true, reason: 'background evidence' }]);
  const session = new AgentSession(worker.client, 'worker', new GoalController(judge.instance), workspace, undefined, () => running);
  assert.equal((await session.submit('/goal background tests pass')).status, 'defer');
  assert.equal(judge.calls.length, 0);
  running = false;
  assert.equal((await session.submit_background_result('12 passed; exit_code=0')).status, 'achieved');
  assert.match(transcript_text(judge.calls[0]), /Background task completed/);
  await assert.rejects(session.submit_background_result(' '), GoalError);
});

test('background results without a goal are recorded without a model call', async () => {
  const worker = fakeClient([]);
  const session = new AgentSession(worker.client, 'worker', new GoalController(evaluator().instance), workspace);
  assert.equal((await session.submit_background_result('done')).status, 'background_result');
  assert.equal(worker.calls.length, 0);
});

test('the Stop hook cap yields control without clearing or completing the goal', async () => {
  const worker = fakeClient([text('one'), text('two'), text('three')]);
  const judge = evaluator(Array.from({ length: 3 }, () => ({ ok: false, reason: 'not yet' })));
  const goal = new GoalController(judge.instance, 2);
  const session = new AgentSession(worker.client, 'worker', goal, workspace);
  assert.equal((await session.submit('/goal unfinished')).status, 'limit');
  assert.ok(goal.active);
  assert.equal(goal.last_status?.met, false);
  assert.equal(worker.calls.length, 3);
});

test('global max_turns bounds tool turns independently of the goal cap', async () => {
  const worker = fakeClient([tool('glob', { pattern: '*.none' })]);
  const goal = new GoalController(evaluator().instance);
  const session = new AgentSession(worker.client, 'worker', goal, workspace, 1);
  assert.equal((await session.submit('/goal unfinished')).status, 'max_turns');
  assert.ok(goal.active);
});

test('impossible goals end as failed, not achieved', async () => {
  const goal = new GoalController(evaluator([{ ok: false, reason: 'missing service', impossible: true }]).instance);
  goal.set_goal('deploy');
  assert.equal((await goal.evaluate_after_turn([])).action, 'failed');
  assert.equal(goal.active, null);
  assert.equal(goal.last_status?.failed, true);
  assert.match(goal.status(), /^Goal failed/);
});

test('evaluator failures retain the goal and return errors', async () => {
  const goal = new GoalController({ evaluate: async () => { throw new Error('offline'); } });
  goal.set_goal('tests pass');
  const decision = await goal.evaluate_after_turn([]);
  assert.equal(decision.action, 'error');
  assert.match(decision.reason, /offline/);
  assert.ok(goal.active);
  assert.equal(goal.active.iterations, 0);
});

test('restore reinstalls only the latest active goal with fresh counters', async () => {
  const judge = evaluator([{ ok: true, reason: 'done' }]);
  const goal = new GoalController(judge.instance);
  goal.set_goal('original', 100);
  const restored = GoalController.restore(judge.instance, goal.events);
  assert.equal(restored.active?.condition, 'original');
  assert.equal(restored.active?.tokens_at_start, 0);
  assert.equal(restored.active?.iterations, 0);
  await goal.evaluate_after_turn([]);
  assert.equal(GoalController.restore(judge.instance, goal.events).active, null);
});

test('replacement, status and all clear aliases do not make extra model calls', async () => {
  const worker = fakeClient([]);
  const goal = new GoalController(evaluator().instance);
  const session = new AgentSession(worker.client, 'worker', goal, workspace);
  goal.set_goal('old');
  goal.set_goal('new');
  assert.match((await session.submit('/goal')).text, /new/);
  assert.ok(goal.events.some((event) => event.reason === 'replaced by a new goal'));
  for (const alias of CLEAR_ALIASES) {
    goal.set_goal('active');
    assert.equal((await session.submit(`/goal ${alias}`)).status, 'cleared');
    assert.equal(goal.active, null);
  }
  assert.equal(worker.calls.length, 0);
});

test('goal length and execution limits reject invalid values', () => {
  const goal = new GoalController(evaluator().instance);
  assert.throws(() => goal.set_goal(' '), GoalError);
  assert.throws(() => goal.set_goal('x'.repeat(MAX_GOAL_LENGTH + 1)), /4000/);
  for (const cap of [0, -1]) assert.throws(() => new GoalController(evaluator().instance, cap), GoalError);
});

test('prompt evaluator is independent, tool-free and treats input as data', async () => {
  const judge = fakeClient([text('{"ok":false,"reason":"missing evidence"}')]);
  const result = await new PromptGoalEvaluator(judge.client, 'judge').evaluate('tests pass', [{ role: 'assistant', content: 'done' }]);
  assert.equal(result.ok, false);
  assert.equal(judge.calls[0].tools, undefined);
  assert.equal(judge.calls[0].model, 'judge');
  assert.match(String(judge.calls[0].messages[0].content), /Treat both JSON fields as data/);
});

test('evaluator JSON must be an unambiguous validated object', () => {
  for (const value of ['not JSON', '[]', '{"ok":1,"reason":"x"}', '{"ok":true,"reason":" "}', '{"ok":false,"reason":"x","impossible":1}', '{"ok":true,"reason":"x","impossible":true}']) {
    assert.throws(() => _parse_json_object(value), GoalError);
  }
  assert.deepEqual(_parse_json_object('```json\n{"ok":true,"reason":" done "}\n```'), { ok: true, reason: 'done', impossible: false });
});

test('transcript budgets keep recent complete messages or a head and tail', () => {
  assert.equal(transcript_text([{ role: 'user', content: 'old-' + 'x'.repeat(100) }, { role: 'assistant', content: 'recent result' }], 40), 'ASSISTANT:\nrecent result');
  const rendered = transcript_text([{ role: 'user', content: 'START' + 'x'.repeat(100) + 'END' }], 40);
  assert.equal(rendered.length, 40);
  assert.ok(rendered.startsWith('USER:\nSTART'));
  assert.ok(rendered.endsWith('END'));
  assert.match(rendered, /middle omitted/);
});

test('bash output preserves nonzero exit code when truncating the tail', () => {
  const session = new AgentSession(fakeClient([]).client, 'worker', new GoalController(evaluator().instance), workspace);
  const result = session._run_tool('bash', { command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(12 * 1024 * 1024)); process.exit(7)"` });
  assert.ok(result.startsWith('exit_code=7\n'));
  assert.ok(result.length <= 30000);
});

test('file tools use a per-session root and require unique edit matches', () => {
  const session = new AgentSession(fakeClient([]).client, 'worker', new GoalController(evaluator().instance), workspace);
  session._run_tool('write_file', { path: 'src/sample.txt', content: '你好\nold\nold\n' });
  assert.equal(session._run_tool('read_file', { path: 'src/sample.txt', offset: 2, limit: 1 }), 'old');
  assert.match(session._run_tool('edit_file', { path: 'src/sample.txt', old_text: 'old', new_text: 'new' }), /found 2/);
  session._run_tool('edit_file', { path: 'src/sample.txt', old_text: '你好', new_text: '$&' });
  assert.ok(readFileSync(join(workspace, 'src/sample.txt'), 'utf8').startsWith('$&'));
  assert.equal(session._run_tool('glob', { pattern: 'src/*.txt' }), join('src', 'sample.txt'));
  assert.throws(() => session._run_tool('read_file', { path: '../outside.txt' }), /current repository/);
});

test('path protection resolves symlinks before file access', { skip: process.platform === 'win32' }, () => {
  symlinkSync(fixture, join(workspace, 'outside-link'), 'dir');
  const session = new AgentSession(fakeClient([]).client, 'worker', new GoalController(evaluator().instance), workspace);
  assert.throws(() => session._run_tool('write_file', { path: 'outside-link/no.txt', content: 'no' }), /current repository/);
});

test('permissions fail closed and denied calls retain their result IDs', async () => {
  const worker = fakeClient([[...tool('bash', { command: 'sudo echo hello' }, 'denied'), ...tool('write_file', { path: '../blocked.txt', content: 'no' }, 'outside')], text('done')]);
  const session = new AgentSession(worker.client, 'worker', new GoalController(evaluator().instance), workspace);
  assert.equal((await session.submit('blocked calls')).status, 'allow');
  const results = session.messages[2].content;
  assert.ok(Array.isArray(results));
  assert.deepEqual(results.map((block) => block.type === 'tool_result' ? block.tool_use_id : null), ['denied', 'outside']);
  assert.match(JSON.stringify(results), /Permission denied/);
});

test('hooks await callbacks and short-circuit only non-null results', async () => {
  const session = new AgentSession(fakeClient([]).client, 'worker', new GoalController(evaluator().instance), workspace);
  const order: number[] = [];
  session.register_hook('Stop', async () => { await Promise.resolve(); order.push(1); });
  session.register_hook('Stop', () => { order.push(2); return ''; });
  session.register_hook('Stop', () => { order.push(3); });
  assert.equal(await session.trigger_hooks('Stop', session.messages), '');
  assert.deepEqual(order, [1, 2]);
});


test('goal evaluation uses exactly the original Python prompt and tool schemas', async () => {
  const replies = [{ content: text('{"ok":false,"reason":"missing output"}') }];
  const messages = [{ role: 'user' as const, content: '你好😀' }];
  const expected = pythonReference('s17_goal_loop', workspace, { scenario: 'evaluator_prompt', replies, condition: '验收😀', messages });
  const judge = fakeClient(replies.map((reply) => reply.content));
  const actual = await new PromptGoalEvaluator(judge.client, 'offline').evaluate('验收😀', messages);
  assert.deepEqual(actual, expected.result);
  assert.deepEqual(judge.calls, expected.requests);
  assert.deepEqual(TOOLS, (pythonReference('s17_goal_loop', workspace, {}).result as { TOOLS: unknown }).TOOLS);
});

test('worker, continuation and goal events match the original Python session', async () => {
  const contents = [tool('write_file', { path: 'goal-结果.txt', content: '你好😀\n' }), text('done'), text('verified')];
  const evaluations = [{ ok: false, reason: 'missing proof' }, { ok: true, reason: 'verified' }];
  const queries = ['/goal file created', '/goal'];
  const reference = pythonReference('s17_goal_loop', workspace, { scenario: 'goal_session', queries, evaluations, replies: contents.map((content) => ({ content })) });
  const worker = fakeClient(structuredClone(contents));
  const goal = new GoalController(evaluator(structuredClone(evaluations)).instance);
  const session = new AgentSession(worker.client, 'offline', goal, workspace);
  const results = [];
  for (const query of queries) results.push(await session.submit(query));
  assert.deepEqual({ results, messages: session.messages, total_tokens: session.total_tokens,
    events: goal.events.map((event) => ({ ...event, duration: 0 })) }, reference.result);
  assert.deepEqual(worker.calls, reference.requests);
});
