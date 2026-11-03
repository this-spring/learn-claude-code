/**
 * s14: MCP Tools - discover external tools and add them to the agent loop.
 *
 * Run:  npm run s14
 * Need: npm install; learn-claude-code-ts/.env with ANTHROPIC_API_KEY and MODEL_ID
 *
 *     connect_mcp("docs")
 *               |
 *               v
 *     +------------------+     tools/list     +------------------+
 *     | Agent Harness    | <----------------- | MCP server       |
 *     |                  |                    | docs             |
 *     | built-in tools   |     tools/call     |                  |
 *     | + MCP tools      | -----------------> | search           |
 *     +--------+---------+                    | get_version      |
 *              |                              +------------------+
 *              v
 *     +-----------------------------------------------+
 *     | bash | read | write | edit | glob | connect  |
 *     | mcp__docs__search | mcp__docs__get_version   |
 *     +-----------------------------------------------+
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, readdirSync, statSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse as path_parse, relative, resolve, sep } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const WORKDIR = realpathSync(process.cwd());
const ENVIRONMENT_PROMPT = process.platform === 'win32'
  ? 'Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations'
  : 'Unix-like: the bash tool runs the system shell';
const BASE_SYSTEM = `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. `
  + 'Use built-in and connected MCP tools to solve tasks. Call connect_mcp before using a server.';
// Path.resolve(strict=False): follow symlinks before processing '..', including dangling links.
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
    const shown = output ? Array.from(output).slice(0, 50000).join('') : '(no output)';
    return result.status ? `Error: command exited with status ${result.status}\n${shown}` : shown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') return 'Error: Timeout (120s)';
    return `Error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
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
    if (typeof old_text !== 'string') throw new TypeError('old_text must be a string'); const count = old_text === '' ? Array.from(text).length + 1 : text.split(old_text).length - 1;
    if (count !== 1) return `Error: Expected 1 occurrence, found ${count}`;
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

export const BASE_TOOLS: Anthropic.Tool[] = [
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
    "description": "Replace exact text once.",
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
    "description": "Find files by glob pattern; ** matches recursively.",
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

export const BASE_HANDLERS: Record<string, (input: ToolInput) => string | Promise<string>> = {
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
// -- New in s14: MCP discovery and dispatch --
export interface MCPTool { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> }
type Handler = (input: Record<string, unknown>) => unknown | Promise<unknown>;
class ValueError extends Error { override name = 'ValueError'; }
export class MCPClient {
  tools: MCPTool[] = [];
  _handlers: Record<string, Handler> = {};
  constructor(public name: string) {}
  register(tool_defs: MCPTool[], handlers: Record<string, Handler>): void {
    const names = tool_defs.map((tool) => tool.name);
    if (names.some((name) => typeof name !== 'string' || !name)) throw new ValueError('Every MCP tool needs a non-empty name');
    if (new Set(names).size !== names.length) throw new ValueError(`Duplicate MCP tool name on server ${repr(this.name)}`);
    const missing = names.filter((name) => !Object.hasOwn(handlers, name));
    if (missing.length) throw new ValueError(`Missing MCP handlers: ${missing.join(', ')}`);
    this.tools = [...tool_defs];
    this._handlers = { ...handlers };
  }
  async call_tool(tool_name: string, args: Record<string, unknown>): Promise<string> {
    const handler = Object.hasOwn(this._handlers, tool_name) ? this._handlers[tool_name] : undefined;
    if (!handler) return `MCP error: unknown tool '${tool_name}'`;
    try { return python_str(await handler(args)); }
    catch (error) { return `MCP error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`; }
  }
}
export const mcp_clients = new Map<string, MCPClient>();
export let mcp_tool_policies = new Map<string, string>();
export const MCP_HOST_POLICY = new Map([
  ['docs/search', 'allow'], ['docs/get_version', 'allow'], ['deploy/status', 'allow'], ['deploy/trigger', 'confirm'],
]);
export function normalize_mcp_name(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/gu, '_');
  if (!normalized) throw new ValueError('MCP names cannot normalize to an empty string');
  return normalized;
}
export function _mock_server_docs(): MCPClient {
  const server = new MCPClient('docs');
  server.register([
    { name: 'search', description: 'Search the documentation.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, annotations: { readOnlyHint: true } },
    { name: 'get_version', description: 'Get the documentation API version.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  ], { search: (input: Record<string, unknown>) => (bind_kwargs(input, ["query"], ["query"], "<lambda>"), `[docs] Found 3 results for '${python_str(input.query)}'`), get_version: (input: Record<string, unknown>) => (bind_kwargs(input, [], [], "<lambda>"), '[docs] API v2.1.0') });
  return server;
}
export function _mock_server_deploy(): MCPClient {
  const server = new MCPClient('deploy');
  server.register([
    { name: 'trigger', description: 'Trigger a deployment.', inputSchema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] }, annotations: { destructiveHint: true } },
    { name: 'status', description: 'Check deployment status.', inputSchema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] }, annotations: { readOnlyHint: true } },
  ], { trigger: (input: Record<string, unknown>) => (bind_kwargs(input, ["service"], ["service"], "<lambda>"), `[deploy] Triggered: ${python_str(input.service)}`), status: (input: Record<string, unknown>) => (bind_kwargs(input, ["service"], ["service"], "<lambda>"), `[deploy] ${python_str(input.service)}: running (v1.4.2)`) });
  return server;
}
export const MOCK_SERVERS: Record<string, () => MCPClient> = { docs: _mock_server_docs, deploy: _mock_server_deploy };
export function connect_mcp(name: string): string {
  if (mcp_clients.has(name)) return `MCP server '${name}' already connected`;
  const factory = Object.hasOwn(MOCK_SERVERS, name) ? MOCK_SERVERS[name] : undefined;
  if (!factory) return `Unknown server '${name}'. Available: ${Object.keys(MOCK_SERVERS).join(', ')}`;
  const server = factory();
  mcp_clients.set(name, server);
  const names = server.tools.map((tool) => tool.name).join(', ');
  console.log(`  [mcp] connected: ${name} -> ${names}`);
  return `Connected to MCP server '${name}'. Discovered ${server.tools.length} tools: ${names}`;
}
export function run_connect_mcp(name: string): string { return connect_mcp(name); }
export const CONNECT_TOOL: Anthropic.Tool = {
  "name": "connect_mcp",
  "description": "Connect to an MCP server and discover its tools.",
  "input_schema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string",
        "enum": [
          "docs",
          "deploy"
        ]
      }
    },
    "required": [
      "name"
    ]
  }
};
export const BUILTIN_TOOLS = [...BASE_TOOLS, CONNECT_TOOL];
export const BUILTIN_HANDLERS = { ...BASE_HANDLERS, connect_mcp: (input: Record<string, unknown>) => (bind_kwargs(input, ["name"], ["name"], "run_connect_mcp"), run_connect_mcp(input.name as string)) };

export function assemble_tool_pool(): [Anthropic.Tool[], Record<string, Handler>] {
  const tools = [...BUILTIN_TOOLS];
  const handlers: Record<string, Handler> = { ...BUILTIN_HANDLERS };
  const policies = new Map<string, string>();
  const origins = new Map(tools.map((tool) => [tool.name, `built-in tool ${repr(tool.name)}`]));
  for (const [server_name, server] of mcp_clients) {
    const safe_server = normalize_mcp_name(server_name);
    for (const tool_def of server.tools) {
      const raw_name = tool_def.name;
      const safe_tool = normalize_mcp_name(raw_name);
      const prefixed = `mcp__${safe_server}__${safe_tool}`;
      if (prefixed.length > 64) throw new ValueError(`MCP tool name is longer than 64 characters: ${prefixed}`);
      const origin = `MCP tool ${repr(server_name)}/${repr(raw_name)}`;
      if (origins.has(prefixed)) throw new ValueError(`MCP tool name collision after normalization: ${repr(prefixed)} maps both ${origins.get(prefixed)} and ${origin}`);
      const schema = tool_def.inputSchema ?? {};
      if (!schema || typeof schema !== 'object' || Array.isArray(schema) || (schema.type ?? 'object') !== 'object') throw new ValueError(`Invalid input schema for ${origin}`);
      origins.set(prefixed, origin);
      tools.push({ name: prefixed, description: tool_def.description ?? '', input_schema: schema as Anthropic.Tool.InputSchema });
      handlers[prefixed] = (input) => server.call_tool(raw_name, input);
      policies.set(prefixed, MCP_HOST_POLICY.get(`${server_name}/${raw_name}`) ?? 'confirm');
    }
  }
  mcp_tool_policies = policies;
  return [tools, handlers];
}
export function assemble_system_prompt(): string {
  if (!mcp_clients.size) return BASE_SYSTEM;
  return BASE_SYSTEM + '\n\nConnected MCP servers: ' + [...mcp_clients.keys()].join(', ');
}
export async function execute_tool(block: ToolCall, handlers: Record<string, Handler>): Promise<string> {
  const blocked = await trigger_hooks('PreToolUse', block);
  if (blocked) return python_str(blocked);
  const handler = Object.hasOwn(handlers, block.name) ? handlers[block.name] : undefined;
  if (!handler) return `Unknown tool: ${block.name}`;
  let output: string;
  try { output = python_str(await handler(block.input as ToolInput)); }
  catch (error) { output = `Error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`; }
  await trigger_hooks('PostToolUse', block, output);
  return output;
}
export async function agent_loop(messages: Anthropic.MessageParam[], client: Pick<Anthropic, 'messages'>, MODEL: string): Promise<void> {
  while (true) {
    let response: Anthropic.Message; let handlers: Record<string, Handler>;
    try {
      const [tools, pool_handlers] = assemble_tool_pool();
      handlers = pool_handlers;
      response = await client.messages.create({ model: MODEL, system: assemble_system_prompt(), messages, tools, max_tokens: 8000 });
    } catch (error) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `[Error] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` }] });
      await trigger_hooks('Stop', messages);
      return;
    }
    messages.push({ role: 'assistant', content: response.content });
    const tool_calls = response.content.filter((block) => block.type === 'tool_use');
    if (!tool_calls.length) { await trigger_hooks('Stop', messages); return; }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of tool_calls) {
      console.log(`> ${block.name}`);
      const output = await execute_tool(block, handlers);
      console.log(Array.from(output).slice(0, 300).join(''));
      results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
    }
    messages.push({ role: 'user', content: results });
  }
}
export const HOOKS: Record<'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop', Hook[]> = {
  UserPromptSubmit: [], PreToolUse: [], PostToolUse: [], Stop: [],
};

export function register_hook(event: keyof typeof HOOKS, callback: Hook): void {
  HOOKS[event].push(callback);
}

export async function trigger_hooks(event: keyof typeof HOOKS, ...args: unknown[]): Promise<unknown> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result !== null && result !== undefined) return result;
  }
  return null;
}

export const DENY_LIST = ['rm -rf /', 'sudo', 'shutdown', 'reboot', 'mkfs', 'dd if='];
const DESTRUCTIVE_COMMAND_WORD = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;
const DESTRUCTIVE = ['rm ', '> /etc/', 'chmod 777'];

export function contains_destructive_command(command: string): boolean {
  return DESTRUCTIVE_COMMAND_WORD.test(command);
}

export async function permission_hook(block: ToolCall): Promise<string | null> {
  const input = block.input as ToolInput;
  let needs_confirmation = false;
  if (block.name === 'bash') {
    const command = ((Object.hasOwn(input, 'command') ? input.command : '')) as string;
    for (const pattern of DENY_LIST) if (command.includes(pattern)) return `Permission denied by deny list: ${pattern}`;
    if (contains_destructive_command(command) || DESTRUCTIVE.some((keyword) => command.includes(keyword))) needs_confirmation = true;
  }
  if (['read_file', 'write_file', 'edit_file'].includes(block.name) && !is_relative_to(resolve_path(((Object.hasOwn(input, 'path') ? input.path : '')) as string), WORKDIR)) needs_confirmation = true;
  if (needs_confirmation) {
    console.log(`\n[permission] ${block.name}(${python_str(input)})`);
    const choice = (await terminal?.question('Allow? [y/N] ', { signal: input_closed }))?.trim().toLowerCase();
    if (!choice || !['y', 'yes'].includes(choice)) return 'Permission denied by user';
  }
  if (block.name.startsWith('mcp__') && mcp_tool_policies.get(block.name) !== 'allow') {
    console.log(`\n[permission] External tool ${block.name}(${python_str(input)})`);
    const choice = (await terminal?.question('Allow? [y/N] ', { signal: input_closed }))?.trim().toLowerCase();
    if (!choice || !['y', 'yes'].includes(choice)) return 'Permission denied by user';
  }
  return null;
}
export function log_hook(block: ToolCall): null {
  const args_preview = python_str(Object.values(block.input as ToolInput).slice(0, 2)).slice(0, 60);
  console.log(`[hook] ${block.name}(${args_preview})`);
  return null;
}

export function large_output_hook(block: ToolCall, output: unknown): null {
  const length = Array.from(python_str(output)).length;
  if (length > 100000) console.log(`[hook] Large output from ${block.name}: ${length} chars`);
  return null;
}

export function context_hook(_query: string): null {
  console.log(`[hook] UserPromptSubmit: working in ${WORKDIR}`);
  return null;
}

export function summary_hook(messages: Anthropic.MessageParam[]): null {
  const tool_count = messages.reduce((total, message) => total + (Array.isArray(message.content)
    ? message.content.filter((block) => block.type === 'tool_result').length : 0), 0);
  console.log(`[hook] Stop: session used ${tool_count} tool calls`);
  return null;
}

register_hook('UserPromptSubmit', (query) => context_hook(query as string));
register_hook('PreToolUse', (block) => permission_hook(block as ToolCall));
register_hook('PreToolUse', (block) => log_hook(block as ToolCall));
register_hook('PostToolUse', (block, output) => large_output_hook(block as ToolCall, output));
register_hook('Stop', (messages) => summary_hook(messages as Anthropic.MessageParam[]));

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: true, quiet: true });
  if (process.env.ANTHROPIC_BASE_URL) delete process.env.ANTHROPIC_AUTH_TOKEN;
  const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
  const MODEL = process.env.MODEL_ID;
  if (!MODEL) throw new Error('Missing MODEL_ID. Configure learn-claude-code-ts/.env first.');

  console.log('s14: MCP tools');
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
        query = await terminal.question('s14 >> ', { signal: input_closed });
      } catch {
        break;
      }
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) break;
      await trigger_hooks('UserPromptSubmit', query);
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
