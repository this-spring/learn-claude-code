import assert from 'node:assert/strict';
import test, { after, beforeEach, afterEach } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { fixture, response, toolCall, workspace } from '../s04_hooks/test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';

const initial = process.cwd(); const root = mkdtempSync(join(tmpdir(), 'cron-parity-'));
process.chdir(root); const lesson = await import('./code.js'); process.chdir(initial);
after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  lesson.scheduled_jobs.clear(); lesson.cron_queue.length = 0; lesson.session_history.length = 0;
  rmSync(lesson.DURABLE_PATH, { recursive: true, force: true });
});
afterEach(() => lesson.stop_runtime_threads());
function job(recurring = true, durable = true) {
  const result = lesson.schedule_job('* * * * *', 'wake', recurring, durable);
  if (typeof result === 'string') throw new Error(result);
  return result;
}
test('cron validates five bounded fields and uses OR for day/weekday', () => {
  for (const expression of ['* * * * *', '*/5 0-23 1,15 * 1-5', '*/100 * * * *']) assert.equal(lesson.validate_cron(expression), null);
  for (const expression of ['', '* * *', '60 * * * *', '*/0 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 7']) assert.ok(lesson.validate_cron(expression));
  const monday = new Date(2026, 9, 12, 10, 0);
  assert.equal(lesson.cron_matches('0 10 1 * 1', monday), true);
  assert.equal(lesson.cron_matches('1 10 1 * 1', monday), false);
});
test('durable one-shot stays pending until acknowledgement and resumes after restart', () => {
  const current = job(false);
  const now = new Date(2026, 0, 1);
  lesson.poll_due_jobs(now); lesson.poll_due_jobs(now);
  assert.equal(lesson.cron_queue.length, 1);
  assert.equal(current.last_fired, '2026-01-01 00:00');
  lesson.consume_cron_queue(); lesson.scheduled_jobs.clear();
  lesson.load_durable_jobs();
  assert.equal(lesson.cron_queue.length, 1);
  lesson.acknowledge_cron_jobs(lesson.consume_cron_queue());
  assert.equal(lesson.scheduled_jobs.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(lesson.DURABLE_PATH, 'utf8')), []);
});
test('same-minute recurring delivery does not fire again after acknowledgement', () => {
  job(); const now = new Date(2026, 0, 1);
  lesson.poll_due_jobs(now); lesson.acknowledge_cron_jobs(lesson.consume_cron_queue());
  lesson.poll_due_jobs(now); assert.equal(lesson.cron_queue.length, 0);
  lesson.poll_due_jobs(new Date(2026, 0, 1, 0, 1)); assert.equal(lesson.cron_queue.length, 1);
});
test('failed persistence rolls scheduling back', () => {
  mkdirSync(lesson.DURABLE_PATH);
  assert.throws(() => job()); assert.equal(lesson.scheduled_jobs.size, 0);
});
test('cancel removes pending delivery and restore cannot resurrect cancellation', () => {
  const current = job(); lesson.poll_due_jobs(new Date());
  const pending = lesson.consume_cron_queue(); lesson.cancel_job(current.id); lesson.restore_cron_jobs(pending);
  assert.equal(lesson.cron_queue.length, 0);
});
test('acknowledgement write failure restores both pending jobs and their queue', () => {
  const current = job(false, false); lesson.poll_due_jobs(new Date());
  current.durable = true;
  const pending = lesson.consume_cron_queue(); mkdirSync(lesson.DURABLE_PATH);
  assert.throws(() => lesson.acknowledge_cron_jobs(pending));
  assert.equal(lesson.scheduled_jobs.has(current.id), true);
  assert.equal(current.pending_delivery, true); assert.equal(lesson.cron_queue.length, 1);
});
test('model errors restore unacknowledged jobs, truncate scheduled messages and return context', async (context) => {
  job(); lesson.poll_due_jobs(new Date());
  const { options } = fixture(context, [new Error('offline failure')]);
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'original' }];
  const state = { existing: true };
  assert.equal(await lesson.agent_loop(messages, state, options.client, options.model), state);
  assert.deepEqual(messages, [{ role: 'user', content: 'original' }]);
  assert.equal(lesson.cron_queue.length, 1);
});
test('successful response acknowledges delivery before executing its tool batch', async (context) => {
  const current = job(false); lesson.poll_due_jobs(new Date());
  const { options, requests } = fixture(context, [response([toolCall('list_crons')]), response()]);
  await lesson.agent_loop([], null, options.client, options.model);
  assert.equal(lesson.scheduled_jobs.has(current.id), false);
  assert.match(JSON.stringify(requests[1].messages), /No cron jobs/);
});
test('runtime timers serialize scheduled work and refuse interactive approvals', async (context) => {
  job(false, false); lesson.poll_due_jobs(new Date());
  const { options, requests } = fixture(context, [response([toolCall('bash', { command: 'rm unsafe.txt' })]), response()]);
  lesson.start_runtime_threads(options.client, options.model);
  lesson.start_runtime_threads(options.client, options.model);
  assert.equal(lesson.runtime_threads.length, 2);
  const deadline = Date.now() + 3000;
  while (requests.length < 2 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1].messages), /scheduled turns cannot request interactive approval/);
  lesson.stop_runtime_threads(); assert.equal(lesson.runtime_threads.length, 0);
});
test('schemas and invalid cron diagnostics match the unmodified Python source', (context) => {
  const expressions = ['', '60 * * * *', '*/0 * * * *', '*/5,10 * * * *', '8-2 * * * *', '* * * * 7', '0, * * * *', '*/100 * * * *', 'x * * * *'];
  const calls = expressions.map((expression) => ({ name: 'validate_cron', args: [expression] }));
  assert.deepEqual(expressions.map(lesson.validate_cron), pythonReference('s12_cron_scheduler', workspace(context), { scenario: 'functions', calls }).result);
  assert.deepEqual({ TOOLS: lesson.TOOLS }, pythonReference('s12_cron_scheduler', workspace(context), {}).result);
});
