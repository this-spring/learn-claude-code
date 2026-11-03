import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pythonReference } from './parity-helpers.js';
const root = fileURLToPath(new URL('..', import.meta.url));

test('agent-builder reference schemas, tool outputs and child traces match Python resources', async () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'learn-skill-resources-')));
  const previous = process.cwd();
  try {
    process.chdir(fixture);
    const minimal = await import('../skills/agent-builder/references/minimal-agent.js');
    const templates = await import('../skills/agent-builder/references/tool-templates.js');
    const subagent = await import('../skills/agent-builder/references/subagent-pattern.js');
    const pyminimal = 'skills/agent-builder/references/minimal-agent.py';
    const pytemplates = 'skills/agent-builder/references/tool-templates.py';
    assert.deepEqual(minimal.TOOLS, (pythonReference(pyminimal, fixture, {}).result as { TOOLS: unknown }).TOOLS);
    const names = ['BASH_TOOL', 'READ_FILE_TOOL', 'WRITE_FILE_TOOL', 'EDIT_FILE_TOOL', 'TODO_WRITE_TOOL'];
    assert.deepEqual(Object.fromEntries(names.map((name) => [name, templates[name as keyof typeof templates]])), pythonReference(pytemplates, fixture, { names }).result);
    const calls = [{ name: 'run_write_file', args: ['sample.txt', '你好😀\r\nold\r\n'] }, { name: 'run_read_file', args: ['sample.txt', -1] },
      { name: 'run_edit_file', args: ['sample.txt', 'old', '$&'] }, { name: 'run_read_file', args: ['sample.txt'] }, { name: 'run_bash', args: ["printf hello"] }];
    const expected = pythonReference(pytemplates, fixture, { scenario: 'functions', calls }).result;
    assert.deepEqual(calls.map((call) => (templates as any)[call.name](...call.args)), expected);
    const replies = [{ content: [{ type: 'tool_use', name: 'read_file', id: 'read', input: { path: 'sample.txt' } }], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'summary' }] }];
    const reference = pythonReference('skills/agent-builder/references/subagent-pattern.py', fixture, { scenario: 'reference_subagent', prompt: 'inspect', tools: minimal.TOOLS, replies });
    const requests: unknown[] = [];
    const client = { messages: { create: async (request: unknown) => { requests.push(structuredClone(request)); return replies.shift(); } } };
    assert.equal(await subagent.run_task('inspect', 'inspect', 'explore', client as any, 'offline', fixture, minimal.TOOLS, () => 'tool output'), reference.result);
    assert.deepEqual(requests, reference.requests);
  } finally { process.chdir(previous); rmSync(fixture, { recursive: true, force: true }); }
});

test('scaffolder emits runnable independent TypeScript projects for every original level', async () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'learn-scaffold-')));
  try {
    const { create_agent } = await import('../skills/agent-builder/scripts/init_agent.js');
    for (let level = 0; level <= 4; level += 1) {
      const name = `agent${level}`; create_agent(name, level, fixture);
      const directory = join(fixture, name); symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir');
      const file = join(directory, name + '.ts');
      assert.doesNotMatch(readFileSync(file, 'utf8'), /__AGENT_NAME__|\.py\b/);
      const child = spawnSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), file], { cwd: directory,
        input: 'q\n', encoding: 'utf8', timeout: 10000, env: { ...process.env, ANTHROPIC_API_KEY: 'offline', MODEL_NAME: 'offline' } });
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.match(child.stdout, new RegExp(`Level ${level === 0 ? 0 : 1} Agent`));
      const module = await import(pathToFileURL(file).href); let turn = 0; const requests: any[] = [];
      module.client.messages.create = async (request: unknown) => { requests.push(structuredClone(request)); return turn++ === 0
        ? { content: [{ type: 'tool_use', name: 'bash', id: 'shell', input: { command: 'printf generated' } }], stop_reason: 'tool_use' }
        : { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' }; };
      assert.equal(await (level === 0 ? module.run : module.agent)('verify', []), 'done');
      assert.equal(requests.length, 2);
      assert.equal(requests[1].messages[2].content[0].content, 'generated');
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
