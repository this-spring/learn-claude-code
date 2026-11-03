import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const WORKDIR = process.cwd();
function read_utf8(path: string): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)).replace(/\r\n?/g, '\n'); }
function error_text(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Minimal Agent Template - 3 tools plus the model loop. Run with npx tsx minimal-agent.ts. */
export const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
export const MODEL = process.env.MODEL_NAME ?? 'claude-sonnet-4-20250514';
export const SYSTEM = `You are a coding agent at ${WORKDIR}.

Rules:
- Use tools to complete tasks
- Prefer action over explanation
- Summarize what you did when done`;
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
  }
];
export function execute_tool(name: string, args: Record<string, any>): string {
  if (name === 'bash') {
    const result = spawnSync(args.command, { shell: true, cwd: WORKDIR, encoding: 'utf8', timeout: 60000, maxBuffer: Infinity });
    if (result.error) { if ('code' in result.error && result.error.code === 'ETIMEDOUT') return 'Error: Timeout'; throw result.error; }
    return (result.stdout + result.stderr).replace(/\r\n?/g, '\n').trim() || '(empty)';
  }
  if (name === 'read_file') { try { return Array.from(read_utf8(resolve(WORKDIR, args.path))).slice(0, 50000).join(''); } catch (error) { return `Error: ${error_text(error)}`; } }
  if (name === 'write_file') {
    try { const p = resolve(WORKDIR, args.path); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, args.content, 'utf8'); return `Wrote ${Array.from(args.content as string).length} bytes to ${args.path}`; }
    catch (error) { return `Error: ${error_text(error)}`; }
  }
  return `Unknown tool: ${name}`;
}
export async function agent(prompt: string, history: Anthropic.MessageParam[] | null = null): Promise<string> {
  history ??= []; history.push({ role: 'user', content: prompt });
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages: history, tools: TOOLS, max_tokens: 8000 });
    history.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') return response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) if (block.type === 'tool_use') {
      console.log(`> ${block.name}: ${JSON.stringify(block.input)}`);
      const output = execute_tool(block.name, block.input as Record<string, unknown>); console.log(`  ${Array.from(output).slice(0, 100).join('')}...`);
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
  console.log(`Minimal Agent - ${WORKDIR}`); console.log("Type 'q' to quit.\n");
  const history: Anthropic.MessageParam[] = [];
  try { while (!closed.signal.aborted) {
    let query: string; try { query = (await terminal.question('>> ', { signal: closed.signal })).trim(); } catch { break; }
    if (['q', 'quit', 'exit', ''].includes(query)) break;
    console.log(await agent(query, history)); console.log();
  } } finally { terminal.close(); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error_text(error)); process.exitCode = 1; });
