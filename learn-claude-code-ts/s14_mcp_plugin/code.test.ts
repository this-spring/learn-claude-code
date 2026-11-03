import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { BASE_TOOLS, CONNECT_TOOL, HOOKS, MCPClient, mcp_clients, assemble_tool_pool, agent_loop, connect_mcp, execute_tool, normalize_mcp_name, run_edit, run_write } from './code.js';
import { fixture, response, toolCall, workspace } from '../s04_hooks/test-helpers.js';
import { pythonReference } from '../scripts/parity-helpers.js';
import { join } from 'node:path';

beforeEach(() => mcp_clients.clear());
test('connected tools appear on the next model request', async (context) => {
  const { options, requests } = fixture(context, [response([toolCall('connect_mcp', { name: 'docs' })]), response()]);
  await agent_loop([{ role: 'user', content: 'connect docs' }], options.client, options.model);
  assert.doesNotMatch(JSON.stringify(requests[0].tools), /mcp__docs__/);
  assert.match(JSON.stringify(requests[1].tools), /mcp__docs__search/);
});
test('host policy allows known reads and asks for deployment', async () => {
  connect_mcp('docs'); connect_mcp('deploy');
  const [, handlers] = assemble_tool_pool();
  assert.equal(await execute_tool(toolCall('mcp__docs__search', { query: 'hooks' }), handlers), "[docs] Found 3 results for 'hooks'");
  assert.equal(await execute_tool(toolCall('mcp__deploy__trigger', { service: 'demo' }), handlers), 'Permission denied by user');
});
test('readOnlyHint on unknown servers never grants permission', async () => {
  const server = new MCPClient('untrusted');
  server.register([{ name: 'read', description: 'safe', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }], { read: () => 'secret' });
  mcp_clients.set(server.name, server);
  const [, handlers] = assemble_tool_pool();
  assert.equal(await execute_tool(toolCall('mcp__untrusted__read'), handlers), 'Permission denied by user');
});
test('normalized collisions and long names fail before model dispatch', () => {
  for (const name of ['server.one', 'server_one']) {
    const server = new MCPClient(name); server.register([{ name: 'tool', inputSchema: { type: 'object' } }], { tool: () => '' }); mcp_clients.set(name, server);
  }
  assert.equal(normalize_mcp_name('server.😀'), 'server__');
  assert.throws(() => assemble_tool_pool(), /collision/);
  mcp_clients.clear();
  const long = new MCPClient('x'.repeat(64)); long.register([{ name: 'tool' }], { tool: () => '' }); mcp_clients.set(long.name, long);
  assert.throws(() => assemble_tool_pool(), /longer than 64/);
});
test('mock tool errors stay tool results; registration rejects duplicates and missing handlers', async () => {
  const client = new MCPClient('test');
  assert.throws(() => client.register([{ name: 'missing' }], {}), /Missing MCP handlers/);
  assert.throws(() => client.register([{ name: 'same' }, { name: 'same' }], { same: () => '' }), /Duplicate/);
  client.register([{ name: 'fail', inputSchema: { type: 'object', properties: {} } }], { fail: () => { throw new Error('failure'); } });
  assert.match(await client.call_tool('fail', {}), /MCP error/);
  assert.match(await client.call_tool('unknown', {}), /unknown tool/);
});
test('s14 Stop hooks do not force another model turn and errors become assistant text', async (context) => {
  const previous = HOOKS.Stop;
  context.after(() => { HOOKS.Stop = previous; });
  HOOKS.Stop = [() => 'continue'];
  const first = fixture(context); await agent_loop([], first.options.client, first.options.model);
  assert.equal(first.requests.length, 1);
  const failure = fixture(context, [new Error('network failure')]);
  const messages: Anthropic.MessageParam[] = [];
  await agent_loop(messages, failure.options.client, failure.options.model);
  assert.match(JSON.stringify(messages), /\[Error\].*network failure/);
});
test('s14 editing requires one occurrence, including empty search text', (context) => {
  const path = join(workspace(context), 'file.txt');
  run_write(path, 'same same');
  assert.equal(run_edit(path, 'same', 'new'), 'Error: Expected 1 occurrence, found 2');
  assert.equal(run_edit(path, '', 'new'), 'Error: Expected 1 occurrence, found 10');
});
test('base and connection schemas match the Python original', (context) => {
  assert.deepEqual({ BASE_TOOLS, CONNECT_TOOL }, pythonReference('s14_mcp_plugin', workspace(context), { names: ['BASE_TOOLS', 'CONNECT_TOOL'] }).result);
});
