/**
 * s03_permission/code.ts - Permission System
 *
 * Three gates inserted before tool execution:
 *
 *     Gate 1: Hard deny list (rm -rf /, sudo, ...)
 *     Gate 2: Rule matching (write outside workspace? destructive cmd?)
 *     Gate 3: User approval (pause and wait for confirmation)
 *
 *     +----------+      +-------+      +--------------+      +---------------+
 *     |   User   | ---> |  LLM  | ---> | Permission   | ---> | Tool Dispatch |
 *     |  prompt  |      |       |      | 1. deny list |      | execute       |
 *     +----------+      +---+---+      | 2. rules     |      +-------+-------+
 *                           ^          | 3. approval  |              |
 *                           |          +------+-------+              |
 *                           |                 | deny                 |
 *                           |                 v                      v
 *                           |          +-------------------------------+
 *                           +----------+ tool_result: denied or output |
 *                                      +-------------------------------+
 *
 * Only one line added to the agent loop:
 *
 *     if not check_permission(block):
 *         continue
 *
 * Builds on s02 (multi-tool). Usage:
 *
 *     npm run s03
 *     Needs: npm install + ANTHROPIC_API_KEY in .env
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, statSync, readlinkSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse as path_parse, relative, resolve, sep } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const WORKDIR = realpathSync(process.cwd());
const ENVIRONMENT_PROMPT = process.platform === 'win32'
  ? 'Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations'
  : 'Unix-like: the bash tool runs the system shell';
const SYSTEM = `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. `
  + 'All destructive operations require user approval.';
// Standard-library adapter: Python glob uses literal braces and follows directory symlinks.
// pathlib includes dotfiles, and its recursive ** visits directories without following symlinks.
function python_glob(pattern: string, root: string, pathlib = false): string[] {
  if (typeof pattern !== 'string') throw new TypeError('pattern must be a string');
  if (pathlib && isAbsolute(pattern)) throw new Error('Non-relative patterns are unsupported');
  if (!pattern) { if (pathlib) throw new Error('Unacceptable pattern: empty pattern'); return []; }
  const absolute_root = isAbsolute(pattern) ? path_parse(pattern).root : '';
  const pieces = pattern.slice(absolute_root.length).split(sep);
  const directory_only = pieces.at(-1) === '';
  if (directory_only) pieces.pop();
  if (pathlib && pieces.some((piece) => piece.includes('**') && piece !== '**')) throw new Error("Invalid pattern: '**' can only be an entire path component");
  const results: string[] = [];
  const append = (prefix: string, name: string) => prefix ? prefix + (prefix.endsWith(sep) ? '' : sep) + name : name;
  const disk = (prefix: string) => isAbsolute(prefix) ? prefix : root + sep + prefix;
  const is_directory = (prefix: string) => { try { return statSync(disk(prefix)).isDirectory(); } catch { return false; } };
  const exists = (prefix: string) => { try { return Boolean(lstatSync(disk(prefix), { throwIfNoEntry: false })); } catch { return false; } };
  const entries = (prefix: string): string[] => { try { return readdirSync(disk(prefix)); } catch { return []; } };
  function matches(name: string, component: string): boolean {
    if (!pathlib && name.startsWith('.') && !component.startsWith('.')) return false;
    let source = '';
    const escape = (character: string) => character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    for (let i = 0; i < component.length; i += 1) {
      const character = component[i];
      if (character === '*') source += '.*';
      else if (character === '?') source += '.';
      else if (character === '[') {
        let end = i + 1;
        if (component[end] === '!') end += 1;
        if (component[end] === ']') end += 1;
        while (end < component.length && component[end] !== ']') end += 1;
        if (end === component.length) source += '\\[';
        else {
          let body = component.slice(i + 1, end);
          const negated = body.startsWith('!');
          if (negated) body = body.slice(1);
          body = body.replaceAll('\\', '\\\\').replaceAll(']', '\\]');
          if (body.startsWith('^')) body = '\\' + body;
          source += '[' + (negated ? '^' : '') + body + ']';
          i = end;
        }
      } else source += escape(character);
    }
    try { return new RegExp('^' + source + '$', process.platform === 'win32' ? 'isu' : 'su').test(name); } catch { return false; }
  }
  function walk(prefix: string, index: number, recursive = false): void {
    if (index === pieces.length) {
      if (directory_only ? is_directory(prefix) : exists(prefix)) results.push(pathlib ? prefix.replace(/^\.\//, '') || '.' : prefix + (directory_only && prefix && !prefix.endsWith(sep) ? sep : ''));
      return;
    }
    const component = pieces[index];
    if (component === '**') {
      if (!is_directory(prefix)) return;
      if (pathlib || index < pieces.length - 1) walk(prefix, index + 1);
      else if (prefix && !recursive) results.push(prefix.endsWith(sep) ? prefix : prefix + sep);
      for (const name of entries(prefix)) {
        if (!pathlib && name.startsWith('.')) continue;
        const child = append(prefix, name);
        const directory = is_directory(child);
        if (!pathlib && index === pieces.length - 1 && (!directory_only || directory)) results.push(child + (directory_only ? sep : ''));
        let symlink = false; try { symlink = lstatSync(disk(child)).isSymbolicLink(); } catch { continue; }
        if (directory && (!pathlib || !symlink)) walk(child, index, true);
      }
    } else if (component === '.' && pathlib) walk(prefix, index + 1);
    else if (!/[?*[]/.test(component)) {
      const child = append(prefix, component);
      if (exists(child) && (index === pieces.length - 1 || is_directory(child))) walk(child, index + 1);
    } else {
      for (const name of entries(prefix)) if (matches(name, component)) {
        const child = append(prefix, name);
        if (index === pieces.length - 1 || is_directory(child)) walk(child, index + 1);
      }
    }
  }
  walk(absolute_root, 0);
  return [...new Set(results)];
}

// Python handler(**input) binds keywords before the handler body executes.
function bind_kwargs(input: unknown, allowed: string[], required: string[], name: string): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${name}() argument after ** must be a mapping`);
  const keywords = input as Record<string, unknown>;
  for (const key of Object.keys(keywords)) if (!allowed.includes(key)) throw new TypeError(`${name}() got an unexpected keyword argument '${key}'`);
  const missing = required.filter((key) => !Object.hasOwn(keywords, key));
  if (missing.length) {
    const names = missing.map((key) => `'${key}'`);
    const joined = names.length < 2 ? names[0] : names.length === 2 ? names.join(' and ') : names.slice(0, -1).join(', ') + ', and ' + names.at(-1);
    throw new TypeError(`${name}() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${joined}`);
  }
}

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
        if (resolving.has(candidate)) throw new Error(`Symlink loop from '${candidate}'`);
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
  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance);
}

export function run_bash(command: string): string {
  try {
    const result = spawnSync(command, {
      shell: true,
      cwd: WORKDIR,
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
    throw error;
  }
}

export function run_read(path: string, limit?: number | null): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(resolve_path(path)));
    let lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    if (lines.at(-1) === '') lines.pop();
    if (limit) {
      if (typeof limit !== 'number' && typeof limit !== 'boolean') throw new TypeError("'<' not supported between instances of 'str' and 'int'");
      if (Number(limit) < lines.length) {
        if (!Number.isInteger(Number(limit))) throw new TypeError('slice indices must be integers or None or have an __index__ method');
        lines = [...lines.slice(0, Number(limit)), `... (${lines.length - Number(limit)} more lines)`];
      }
    }
    return lines.join('\n');
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function run_write(path: string, content: string): string {
  try {
    const file_path = resolve_path(path);
    mkdirSync(dirname(file_path), { recursive: true });
    writeFileSync(file_path, content, 'utf8');
    return `Wrote ${Array.from(content).length} bytes to ${path}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function run_edit(path: string, old_text: string, new_text: string): string {
  try {
    const file_path = resolve_path(path);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file_path)).replace(/\r\n?/g, '\n');
    if (typeof old_text !== 'string') throw new TypeError('old_text must be a string'); if (!text.includes(old_text)) return `Error: text not found in ${path}`;
    if (typeof new_text !== 'string') throw new TypeError('new_text must be a string'); writeFileSync(file_path, text.replace(old_text, () => new_text), 'utf8');
    return `Edited ${path}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function run_glob(pattern: string): string {
  try {
    const matches = [...new Set(python_glob(pattern, WORKDIR))]
      .filter((match) => is_relative_to(resolve_path(match), WORKDIR))
      .sort();
    const shown = matches.slice(0, 200);
    if (matches.length > 200) shown.push('... (more matches omitted; narrow the pattern)');
    return shown.length ? shown.join('\n') : '(no matches)';
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
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
  },
  {
    "name": "read_file",
    "description": "Read file contents.",
    "input_schema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string"
        },
        "limit": {
          "type": "integer"
        }
      },
      "required": [
        "path"
      ]
    }
  },
  {
    "name": "write_file",
    "description": "Write content to a file.",
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
    "description": "Replace exact text in a file once.",
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
  },
  {
    "name": "glob",
    "description": "Find files matching a glob pattern; ** matches recursively.",
    "input_schema": {
      "type": "object",
      "properties": {
        "pattern": {
          "type": "string"
        }
      },
      "required": [
        "pattern"
      ]
    }
  }
];
type ToolInput = Record<string, unknown>;
type ToolCall = Pick<Anthropic.ToolUseBlock, 'name' | 'input' | 'id'>;
type Hook = (...args: unknown[]) => unknown | Promise<unknown>;
let terminal: Interface | undefined;
let input_closed: AbortSignal | undefined;

export const TOOL_HANDLERS: Record<string, (input: ToolInput) => string | Promise<string>> = {
  bash: (input: Record<string, unknown>) => (bind_kwargs(input, ["command"], ["command"], "run_bash"), run_bash(input.command as string)),
  read_file: (input: Record<string, unknown>) => (bind_kwargs(input, ["path","limit"], ["path"], "run_read"), run_read(input.path as string, input.limit as number | undefined)),
  write_file: (input: Record<string, unknown>) => (bind_kwargs(input, ["path","content"], ["path","content"], "run_write"), run_write(input.path as string, input.content as string)),
  edit_file: (input: Record<string, unknown>) => (bind_kwargs(input, ["path","old_text","new_text"], ["path","old_text","new_text"], "run_edit"), run_edit(input.path as string, input.old_text as string, input.new_text as string)),
  glob: (input: Record<string, unknown>) => (bind_kwargs(input, ["pattern"], ["pattern"], "run_glob"), run_glob(input.pattern as string)),
};
function python_str(value: unknown): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value)) return `[${value.map((item) => typeof item === 'string' ? repr(item) : python_str(item)).join(', ')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${repr(key)}: ${typeof item === 'string' ? repr(item) : python_str(item)}`).join(', ')}}`;
  return String(value);
}

function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  return quote + value.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`).replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t') + quote;
}
export const DENY_LIST = ['rm -rf /', 'sudo', 'shutdown', 'reboot', 'mkfs', 'dd if=', '> /dev/sda'];
export function check_deny_list(command: string): string | null {
  for (const pattern of DENY_LIST) if (command.includes(pattern)) return `Blocked: '${pattern}' is on the deny list`;
  return null;
}
export const DESTRUCTIVE_COMMAND_WORD = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;
export function contains_destructive_command(command: string): boolean { return DESTRUCTIVE_COMMAND_WORD.test(command); }
export const PERMISSION_RULES = [
  { tools: ['read_file', 'write_file', 'edit_file'],
    check: (args: ToolInput) => !is_relative_to(resolve_path((Object.hasOwn(args, 'path') ? args.path : '') as string), WORKDIR), message: 'Writing outside workspace' },
  { tools: ['bash'], check: (args: ToolInput) => {
    const command = (Object.hasOwn(args, 'command') ? args.command : '') as string;
    return contains_destructive_command(command) || ['rm ', '> /etc/', 'chmod 777'].some((kw) => command.includes(kw));
  }, message: 'Potentially destructive command' },
];
export function check_rules(tool_name: string, args: ToolInput): string | null {
  for (const rule of PERMISSION_RULES) if (rule.tools.includes(tool_name) && rule.check(args)) return rule.message;
  return null;
}
export type Approval = (tool_name: string, args: ToolInput, reason: string) => Promise<string>;
export async function ask_user(tool_name: string, args: ToolInput, reason: string,
  question: (prompt: string) => Promise<string> = async (prompt) => await terminal?.question(prompt, { signal: input_closed }) ?? 'n'): Promise<string> {
  console.log(`\n\x1b[33m[permission] ${reason}\x1b[0m`); console.log(`   Tool: ${tool_name}(${python_str(args)})`);
  const choice = (await question('   Allow? [y/N] ')).trim().toLowerCase();
  return ['y', 'yes'].includes(choice) ? 'allow' : 'deny';
}
export async function check_permission(block: ToolCall, approve: Approval = ask_user): Promise<boolean> {
  if (block.name === 'bash') {
    const input = block.input as ToolInput;
    const reason = check_deny_list((Object.hasOwn(input, 'command') ? input.command : '') as string);
    if (reason) { console.log(`\n\x1b[31m[blocked] ${reason}\x1b[0m`); return false; }
  }
  const reason = check_rules(block.name, block.input as ToolInput);
  if (reason && await approve(block.name, block.input as ToolInput, reason) === 'deny') return false;
  return true;
}
export async function agent_loop(messages: Anthropic.MessageParam[], client: Pick<Anthropic, 'messages'>, MODEL: string, approve: Approval = ask_user): Promise<void> {
  while (true) {
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    messages.push({ role: 'assistant', content: response.content });
    const tool_calls = response.content.filter((block) => block.type === 'tool_use');
    if (!tool_calls.length) return;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of tool_calls) {
      console.log(`\x1b[36m> ${block.name}\x1b[0m`);
      if (!await check_permission(block, approve)) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Permission denied.' }); continue;
      }
      const handler = Object.hasOwn(TOOL_HANDLERS, block.name) ? TOOL_HANDLERS[block.name] : undefined;
      const output = handler ? await handler(block.input as ToolInput) : `Unknown: ${block.name}`;
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

  console.log('s03: Permission');
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
        query = await terminal.question('\x1b[36ms03 >> \x1b[0m', { signal: input_closed });
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
