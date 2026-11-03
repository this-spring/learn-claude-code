/** Agent Scaffold Script - npx tsx init_agent.ts <name> [--level 0-4] [--path <dir>]. */
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const TEMPLATES: Record<number, string> = {
  0: `import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const WORKDIR = process.cwd();
function read_utf8(path: string): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)).replace(/\\r\\n?/g, '\\n'); }
function error_text(error: unknown): string { return error instanceof Error ? error.message : String(error); }

import { config } from 'dotenv';
config();
const AGENT_NAME = __AGENT_NAME__;
export const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
export const MODEL = process.env.MODEL_NAME ?? 'claude-sonnet-4-20250514';

/** Level 0 Agent - Bash is All You Need. Self-recursion uses npx tsx. */
export const SYSTEM = \`You are a coding agent. Use bash for everything:
- Read: cat, grep, find, ls
- Write: echo 'content' > file
- Subagent: npx tsx \${AGENT_NAME}.ts "subtask"
\`;
export const TOOL: Anthropic.Tool[] = [{ name: 'bash', description: 'Execute shell command', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }];
const DEFAULT_HISTORY: Anthropic.MessageParam[] = [];
export async function run(prompt: string, history = DEFAULT_HISTORY): Promise<string> {
  history.push({ role: 'user', content: prompt });
  while (true) {
    const r = await client.messages.create({ model: MODEL, system: SYSTEM, messages: history, tools: TOOL, max_tokens: 8000 });
    history.push({ role: 'assistant', content: r.content });
    if (r.stop_reason !== 'tool_use') return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of r.content) if (b.type === 'tool_use') {
      const args = b.input as { command: string }; console.log(\`> \${args.command}\`); let output: string;
      try {
        const out = spawnSync(args.command, { shell: true, encoding: 'utf8', timeout: 60000, maxBuffer: Infinity });
        if (out.error) throw out.error;
        output = (out.stdout + out.stderr).replace(/\\r\\n?/g, '\\n').trim() || '(empty)';
      } catch (error) { output = \`Error: \${error_text(error)}\`; }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: Array.from(output).slice(0, 50000).join('') });
    }
    history.push({ role: 'user', content: results });
  }
}
export async function main(): Promise<void> {
  const { createInterface } = await import('node:readline/promises');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new AbortController(); terminal.once('close', () => closed.abort()); terminal.on('SIGINT', () => terminal.close());
  process.once('SIGINT', () => terminal.close());
  const h: Anthropic.MessageParam[] = []; console.log(\`\${AGENT_NAME} - Level 0 Agent\\nType 'q' to quit.\\n\`);
  try { while (!closed.signal.aborted) {
    let q: string; try { q = (await terminal.question('>> ', { signal: closed.signal })).trim(); } catch { break; }
    if (['q', 'quit', ''].includes(q)) break;
    console.log(await run(q, h), '\\n');
  } } finally { terminal.close(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error_text(error)); process.exitCode = 1; });
`,
  1: `import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const WORKDIR = process.cwd();
function read_utf8(path: string): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)).replace(/\\r\\n?/g, '\\n'); }
function error_text(error: unknown): string { return error instanceof Error ? error.message : String(error); }

import { config } from 'dotenv';
config();
const AGENT_NAME = __AGENT_NAME__;
export const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
export const MODEL = process.env.MODEL_NAME ?? 'claude-sonnet-4-20250514';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, sep, parse as path_parse } from 'node:path';
export const SYSTEM = \`You are a coding agent at \${WORKDIR}.

Rules:
- Prefer tools over prose. Act, don't just explain.
- Never invent file paths. Use ls/find first if unsure.
- Make minimal changes. Don't over-engineer.
- After finishing, summarize what changed.\`;
export const TOOLS: Anthropic.Tool[] = [
  {
    "name": "bash",
    "description": "Run shell command",
    "input_schema": {
      "type": "object",
      "properties": {
        "command": {
          "type": "string"
        }
      },
      "required": [
        "command"
      ]
    }
  },
  {
    "name": "read_file",
    "description": "Read file contents",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        }
      },
      "required": [
        "path"
      ]
    }
  },
  {
    "name": "write_file",
    "description": "Write content to file",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "content": {
          "type": "string"
        }
      },
      "required": [
        "path",
        "content"
      ]
    }
  },
  {
    "name": "edit_file",
    "description": "Replace exact text in file",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "old_text": {
          "type": "string"
        },
        "new_text": {
          "type": "string"
        }
      },
      "required": [
        "path",
        "old_text",
        "new_text"
      ]
    }
  }
];
function resolve_path(path: string): string {
  const raw = isAbsolute(path) ? path : WORKDIR + sep + path;
  const root = path_parse(raw).root;
  const resolving = new Set<string>();
  function walk(base: string, parts: string[]): string {
    for (const part of parts) {
      if (!part || part === '.') continue;
      if (part === '..') { base = dirname(base); continue; }
      const candidate = resolve(base, part);
      const stat = lstatSync(candidate, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) {
        if (resolving.has(candidate)) throw new Error(\`Symlink loop from '\${candidate}'\`);
        resolving.add(candidate);
        const target = readlinkSync(candidate);
        const target_root = isAbsolute(target) ? path_parse(target).root : '';
        base = walk(target_root || base, target.slice(target_root.length).split(sep));
        resolving.delete(candidate);
      } else base = candidate;
    }
    return base;
  }
  return walk(root, raw.slice(root.length).split(sep));
}

function is_relative_to(path: string, root: string): boolean {
  const distance = relative(root, path);
  return distance !== '..' && !distance.startsWith(\`..\${sep}\`) && !isAbsolute(distance);
}

export function safe_path(p: string): string {
  const path = resolve_path(p);
  if (!is_relative_to(path, WORKDIR)) throw new Error(\`Path escapes workspace: \${p}\`);
  return path;
}


export function execute(name: string, args: Record<string, any>): string {
  if (name === 'bash') {
    if (['rm -rf /', 'sudo', 'shutdown', '> /dev/'].some((pattern) => args.command.includes(pattern))) return 'Error: Dangerous command blocked';
    try {
      const r = spawnSync(args.command, { shell: true, cwd: WORKDIR, encoding: 'utf8', timeout: 60000, maxBuffer: Infinity });
      if (r.error) { if ('code' in r.error && r.error.code === 'ETIMEDOUT') return 'Error: Timeout (60s)'; throw r.error; }
      return Array.from((r.stdout + r.stderr).replace(/\\r\\n?/g, '\\n').trim()).slice(0, 50000).join('') || '(empty)';
    } catch (error) { return \`Error: \${error_text(error)}\`; }
  }
  if (name === 'read_file') { try { return Array.from(read_utf8(safe_path(args.path))).slice(0, 50000).join(''); } catch (error) { return \`Error: \${error_text(error)}\`; } }
  if (name === 'write_file') {
    try { const p = safe_path(args.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, args.content, 'utf8'); return \`Wrote \${Array.from(args.content as string).length} bytes to \${args.path}\`; }
    catch (error) { return \`Error: \${error_text(error)}\`; }
  }
  if (name === 'edit_file') {
    try { const p = safe_path(args.path), content = read_utf8(p); if (!content.includes(args.old_text)) return \`Error: Text not found in \${args.path}\`;
      writeFileSync(p, content.replace(args.old_text, () => args.new_text), 'utf8'); return \`Edited \${args.path}\`;
    } catch (error) { return \`Error: \${error_text(error)}\`; }
  }
  return \`Unknown tool: \${name}\`;
}
export async function agent(prompt: string, history: Anthropic.MessageParam[] | null = null): Promise<string> {
  history ??= []; history.push({ role: 'user', content: prompt });
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages: history, tools: TOOLS, max_tokens: 8000 });
    history.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') return response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) if (block.type === 'tool_use') {
      console.log(\`> \${block.name}: \${JSON.stringify(block.input).slice(0, 100)}\`);
      const output = execute(block.name, block.input as Record<string, unknown>); console.log(\`  \${Array.from(output).slice(0, 100).join('')}...\`);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
    }
    history.push({ role: 'user', content: results });
  }
}
export async function main(): Promise<void> {
  const { createInterface } = await import('node:readline/promises');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new AbortController(); terminal.once('close', () => closed.abort()); terminal.on('SIGINT', () => terminal.close());
  process.once('SIGINT', () => terminal.close());
  console.log(\`\${AGENT_NAME} - Level 1 Agent at \${WORKDIR}\`); console.log("Type 'q' to quit.\\n");
  const history: Anthropic.MessageParam[] = [];
  try { while (!closed.signal.aborted) {
    let query: string; try { query = (await terminal.question('>> ', { signal: closed.signal })).trim(); } catch { break; }
    if (['q', 'quit', 'exit', ''].includes(query)) break;
    console.log(await agent(query, history)); console.log();
  } } finally { terminal.close(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error_text(error)); process.exitCode = 1; });
`
};
export const ENV_TEMPLATE = `# API Configuration
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://api.anthropic.com
MODEL_NAME=claude-sonnet-4-20250514
`;
export function create_agent(name: string, level: number, output_dir: string): void {
  if (!Object.hasOwn(TEMPLATES, level) && ![2, 3, 4].includes(level)) {
    console.log(`Error: Level ${level} not yet implemented in scaffold.`);
    console.log('Available levels: 0 (minimal), 1 (4 tools)'); console.log('For levels 2-4, copy from mini-claude-code repository.'); process.exitCode = 1; return;
  }
  const agent_dir = resolve(output_dir, name); mkdirSync(agent_dir, { recursive: true });
  const agent_file = resolve(agent_dir, `${name}.ts`);
  writeFileSync(agent_file, (TEMPLATES[level] ?? TEMPLATES[1]).replaceAll('__AGENT_NAME__', JSON.stringify(name)), 'utf8'); console.log(`Created: ${agent_file}`);
  const env_file = resolve(agent_dir, '.env.example'); writeFileSync(env_file, ENV_TEMPLATE, 'utf8'); console.log(`Created: ${env_file}`);
  const gitignore = resolve(agent_dir, '.gitignore'); writeFileSync(gitignore, '.env\nnode_modules/\n', 'utf8'); console.log(`Created: ${gitignore}`);
  // Native Node module metadata replaces Python's installed-module environment.
  writeFileSync(resolve(agent_dir, 'package.json'), JSON.stringify({ name, private: true, type: 'module', scripts: { start: `tsx ${name}.ts` },
    dependencies: { '@anthropic-ai/sdk': '^0.132.0', dotenv: '^18.0.6' }, devDependencies: { tsx: '^4.23.15', typescript: '^5.9.3', '@types/node': '^22.0.0' } }, null, 2) + '\n', 'utf8');
  console.log(`\nAgent '${name}' created at ${agent_dir}`); console.log('\nNext steps:');
  console.log(`  1. cd ${agent_dir}`); console.log('  2. cp .env.example .env'); console.log('  3. Edit .env with your API key');
  console.log('  4. npm install'); console.log('  5. npm start');
}
export function main(argv = process.argv.slice(2)): void {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Scaffold a new AI coding agent project\nUsage: init_agent.ts <name> [--level 0-4] [--path <output-dir>]\nLevels: 0 Minimal, 1 Basic, 2 Todo, 3 Subagent, 4 Skills'); return;
  }
  let name: string | undefined, level = 1, path = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === '--level' || argument.startsWith('--level=')) {
      const value = argument.includes('=') ? argument.slice(8) : argv[++i];
      if (!value || !/^[+-]?\d+$/.test(value) || ![0, 1, 2, 3, 4].includes(Number(value))) throw new Error('--level must be one of 0, 1, 2, 3, 4');
      level = Number(value);
    } else if (argument === '--path' || argument.startsWith('--path=')) {
      const value = argument.includes('=') ? argument.slice(7) : argv[++i]; if (value === undefined) throw new Error('--path requires an argument'); path = resolve(value);
    } else if (argument.startsWith('-') || name !== undefined) throw new Error(`unrecognized argument: ${argument}`);
    else name = argument;
  }
  if (name === undefined) throw new Error('name is required'); create_agent(name, level, path);
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
}
