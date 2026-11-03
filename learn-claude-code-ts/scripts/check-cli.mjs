// Run real CLI processes and the real Anthropic SDK against a deterministic local HTTP service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'learn-cli-parity-'));
const project = join(fixture, 'project');
cpSync(root, project, { recursive: true, filter: (path) => !/(?:^|\/)(?:node_modules|\.env|\.runtime|\.memory|\.tasks|\.teams|\.mailboxes|\.worktrees|\.transcripts|\.task_outputs|__pycache__)(?:\/|$)/.test(path.slice(root.length)) });
symlinkSync(join(root, 'node_modules'), join(project, 'node_modules'), 'dir');
const chapters = readdirSync(project).filter((name) => /^s\d\d_/.test(name)).sort();
const logs = new Map(); const rounds = new Map(); const requests = new Map();
const text = (text) => ({ type: 'text', text });
const tool = (name, input) => ({ type: 'tool_use', id: 'tool_' + Math.random().toString(16).slice(2), name, input });
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const data = JSON.parse(Buffer.concat(chunks).toString());
  const tag = request.url.split('/')[1]; const all = requests.get(tag) ?? []; all.push(data); requests.set(tag, all);
  let content;
  if (String(data.system).includes('independent completion evaluator')) content = [text('{"ok":true,"reason":"file evidence present","impossible":false}')];
  else if (String(data.system).includes('focused workflow agent')) content = [text('{"findings":[]}')];
  else if (!data.tools?.length) content = [text('[]')];
  else if (String(data.system).includes('coding subagent') || String(data.system).includes('focused subtask')) content = [text('CHILD_PASS')];
  else {
    const round = rounds.get(tag) ?? 0; rounds.set(tag, round + 1);
    if (tag === 's01' || tag.startsWith('generated0')) content = round === 0 ? [tool('bash', { command: "printf 'new😀\\n' > smoke.txt; cat smoke.txt" })] : [text('SDK_SMOKE_PASS')];
    else if (round === 0) {
      content = [tool('write_file', { path: 'smoke.txt', content: 'old😀\n' })];
      if (tag === 's05') content.push(tool('todo_write', { todos: [{ content: 'SDK smoke', status: 'in_progress' }] }));
      if (tag === 's06') content.push(tool('task', { prompt: 'Return CHILD_PASS' }));
      if (tag === 's07') content.push(tool('load_skill', { name: 'code-review' }));
      if (tag === 's10' || tag === 's13' || tag === 's15') content.push(tool('create_task', { subject: 'SDK smoke', description: 'integration' }));
      if (tag === 's12') content.push(tool('schedule_cron', { cron: '0 0 1 1 *', prompt: 'SDK future', recurring: false, durable: false }));
      if (tag === 's14') content.push(tool('connect_mcp', { name: 'docs' }));
      if (tag === 's16') content.push(tool('Workflow', { name: 'review-changes', args: { changes: 'const a=1;' } }));
    } else if (round === 1) {
      content = [tool('read_file', { path: 'smoke.txt' })];
      if (!tag.startsWith('minimal')) content.push(tool('glob', { pattern: '*.txt' }));
      if (tag === 's14') content.push(tool('mcp__docs__search', { query: 'test' }));
    } else if (round === 2 && !tag.startsWith('minimal')) content = [tool('edit_file', { path: 'smoke.txt', old_text: 'old', new_text: 'new' })];
    else content = [text('SDK_SMOKE_PASS')];
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'msg_test', type: 'message', role: 'assistant', model: data.model, content,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 } }));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
function environment(tag) {
  return { ...process.env, ANTHROPIC_API_KEY: 'offline-smoke', ANTHROPIC_AUTH_TOKEN: '', MODEL_ID: 'offline', MODEL_NAME: 'offline', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/${tag}`, GOAL_EVALUATOR_MODEL_ID: 'offline' };
}
function configure(tag) {
  writeFileSync(join(project, '.env'), `ANTHROPIC_API_KEY=offline-smoke\nANTHROPIC_AUTH_TOKEN=\nMODEL_ID=offline\nMODEL_NAME=offline\nANTHROPIC_BASE_URL=http://127.0.0.1:${port}/${tag}\nGOAL_EVALUATOR_MODEL_ID=offline\n`);
}
async function cli(tag, file, mode = 'sdk', argv = []) {
  configure(tag);
  const cwd = join(fixture, tag + '-' + mode); mkdirSync(cwd, { recursive: true });
  if (mode === 'sdk' && ['s07', 's15', 's16'].includes(tag)) cpSync(join(project, 'skills'), join(cwd, 'skills'), { recursive: true });
  const child = spawn(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), file, ...argv], { cwd, env: environment(tag), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '', sent = false, quitting = false;
  const timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  child.stderr.on('data', (chunk) => { errors += chunk; });
  child.stdout.on('data', (chunk) => {
    output += chunk;
    if (!sent && output.includes('>>')) {
      sent = true;
      if (mode === 'sdk') child.stdin.write('Run the SDK smoke exercise.\n');
      else if (mode === 'eof') child.stdin.end();
      else if (mode === 'sigint') child.kill('SIGINT');
      else child.stdin.write(mode === 'blank' ? '\n' : mode + '\n');
    }
    if (mode === 'sdk' && !quitting && output.includes('SDK_SMOKE_PASS')) {
      quitting = true; setTimeout(() => { if (!child.stdin.destroyed) child.stdin.write('q\n'); }, 25);
    }
  });
  const exit = await new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
  clearTimeout(timer); logs.set(tag + '-' + mode, { ...exit, output, errors });
  assert.equal(exit.code, 0, `${tag}/${mode}: ${JSON.stringify(exit)}\n${output}\n${errors}`);
  if (mode === 'sdk') {
    assert.match(output, /SDK_SMOKE_PASS/, tag);
    assert.ok(requests.get(tag)?.length, tag + ' did not reach SDK transport');
    assert.ok(existsSync(join(cwd, 'smoke.txt')), tag + ' did not run the write tool');
    assert.equal(readFileSync(join(cwd, 'smoke.txt'), 'utf8'), tag.startsWith('minimal') ? 'old😀\n' : 'new😀\n', tag);
    const serialized = JSON.stringify(requests.get(tag));
    assert.match(serialized, /tool_result/, tag + ' did not return tool results');
    const results = requests.get(tag).flatMap((request) => request.messages).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool_result');
    for (const result of results) assert.ok(!/^(?:Error:|Unknown:|Unknown tool|MCP error|Permission denied)/.test(String(result.content)), `${tag}: ${String(result.content).slice(0, 160)}`);
    if (tag === 's06') assert.match(serialized, /CHILD_PASS/);
  }
  return { tag, mode, requests: requests.get(tag)?.length ?? 0 };
}
try {
  const report = [];
  for (const chapter of chapters) {
    const tag = chapter.slice(0, 3), file = join(project, chapter, 'code.ts');
    report.push(await cli(tag, file, 'sdk', tag === 's17' ? ['/goal file contains new😀'] : []));
    for (const mode of ['q', 'exit', 'eof', 'sigint']) report.push(await cli(tag, file, mode));
    if (tag !== 's17') report.push(await cli(tag, file, 'blank'));
    console.log(`${tag}: SDK tools and CLI exits passed`);
  }
  const demo = await cli('workflow-demo', join(project, 's16_workflow_runtime/code.ts'), 'demo', ['demo']);
  const resume = await cli('workflow-resume', join(project, 's16_workflow_runtime/code.ts'), 'resume', ['resume']);
  assert.match(logs.get('workflow-demo-demo').output, /status=completed/);
  assert.match(logs.get('workflow-resume-resume').output, /status=completed\s+agents=0\s+tokens=0/);
  report.push(demo, resume);
  report.push(await cli('minimal', join(project, 'skills/agent-builder/references/minimal-agent.ts')));
  writeFileSync(join(root, 'docs/cli-verification.json'), JSON.stringify({ date: new Date().toISOString(), node: process.version, report }, null, 2) + '\n');
  console.log(`Verified ${report.length} CLI runs. Temporary project and working directories removed.`);
} finally { await new Promise((done) => server.close(done)); rmSync(fixture, { recursive: true, force: true }); }
