/**
 * s01_agent_loop/code.ts - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while True:
 *         response = LLM(messages, tools)
 *         if response contains no tool_use:
 *             break
 *         execute tools
 *         append results
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * This is the core loop: feed tool results back to the model
 * until the model decides to stop. Later chapters add policy,
 * hooks, and lifecycle controls around it.
 *
 * Usage:
 *     npm install
 *     npm run s01
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const WORKDIR = realpathSync(process.cwd());
const ENVIRONMENT_PROMPT = process.platform === 'win32'
  ? 'Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations'
  : 'Unix-like: the bash tool runs the system shell';
const SYSTEM = `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. `
  + "Use bash to solve tasks. Act, don't explain.";
export function run_bash(command: string): string {
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
  if (dangerous.some((pattern) => command.includes(pattern))) return 'Error: Dangerous command blocked';
  if (!command) return '(no output)';
  try {
    const result = spawnSync(command, {
      shell: true,
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: Infinity,
    });
    if (result.error) {
      if ('code' in result.error && result.error.code === 'ETIMEDOUT') return 'Error: Timeout (120s)';
      throw result.error;
    }
    const output = (result.stdout + result.stderr).replace(/\r\n?/g, '\n').trim();
    return output ? Array.from(output).slice(0, 50000).join('') : '(no output)';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') return 'Error: Timeout (120s)';
    if (error instanceof Error && 'code' in error && !String(error.code).startsWith('ERR_')) return `Error: ${error.message}`;
    throw error;
  }
}

export const TOOLS: Anthropic.Tool[] = [
  {
    "name": "bash",
    "description": "Run a shell command.",
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
  }
];
type ToolInput = Record<string, unknown>;
let terminal: Interface | undefined;
let input_closed: AbortSignal | undefined;

export async function agent_loop(messages: Anthropic.MessageParam[], client: Pick<Anthropic, 'messages'>, MODEL: string): Promise<void> {
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    messages.push({ role: 'assistant', content: response.content });
    const tool_calls = response.content.filter((block) => block.type === 'tool_use');
    if (!tool_calls.length) return;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of tool_calls) {
      const input = block.input as ToolInput;
      if (!Object.hasOwn(input, 'command')) { const error = new Error("'command'"); error.name = 'KeyError'; throw error; }
      console.log(`\x1b[33m$ ${input.command}\x1b[0m`);
      const output = run_bash(input.command as string);
      console.log(Array.from(output).slice(0, 200).join(''));
      results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
    }
    messages.push({ role: 'user', content: results });
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: true, quiet: true });
  if (process.env.ANTHROPIC_BASE_URL) delete process.env.ANTHROPIC_AUTH_TOKEN;
  const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
  const MODEL = process.env.MODEL_ID;
  if (!MODEL) throw new Error('Missing MODEL_ID. Configure learn-claude-code-ts/.env first.');

  console.log('s01: Agent Loop');
  console.log('Enter a question, press Enter to send. Type q to quit.\n');

  terminal = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new AbortController();
  input_closed = closed.signal;
  terminal.once('close', () => closed.abort());
  terminal.on('SIGINT', () => terminal?.close());
  process.once('SIGINT', () => terminal?.close());
  const history: Anthropic.MessageParam[] = [];
  try {
    while (true) {
      let query: string;
      try {
        query = await terminal.question('\x1b[36ms01 >> \x1b[0m', { signal: input_closed });
      } catch {
        break;
      }
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) break;
      history.push({ role: 'user', content: query });
      await agent_loop(history, client, MODEL);
      const content = history.at(-1)?.content;
      if (Array.isArray(content)) {
        for (const block of content) if (block.type === 'text') console.log(block.text);
      }
      console.log();
    }
  } finally {
    terminal.close();
  }
}
