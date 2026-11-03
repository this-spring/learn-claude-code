/**
 * s11_background_tasks/code.ts - Background Tasks
 *
 *     Main asynchronous task                              Background asynchronous task
 *     +------------------------------+         +----------------------+
 *     | bash(run_in_background=True) | ------> | run command          |
 *     | return bg_id                 |         | queue result         |
 *     | continue agent loop          | <------ +----------------------+
 *     | next turn: collect           |
 *     +------------------------------+
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, readdirSync, statSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse as path_parse, relative, resolve, sep } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

import { constants as os_constants } from 'node:os';
const WORKDIR = realpathSync(process.cwd());
const ENVIRONMENT_PROMPT = process.platform === 'win32'
  ? 'Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations'
  : 'Unix-like: the bash tool runs the system shell';
const SYSTEM = `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. `
  + 'Use tools to solve tasks. Set run_in_background to true only for independent Bash commands.';
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

const _shell_processes = new Set<ChildProcess>();

export async function _stop_process_group(process: ChildProcess): Promise<void> {
  if (globalThis.process.platform === 'win32') {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      if (process.exitCode !== null || process.signalCode !== null) return;
      try { process.kill(signal); } catch { return; }
      await new Promise((done) => setTimeout(done, 50));
    }
    return;
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try { globalThis.process.kill(-process.pid!, signal); } catch { return; }
    await new Promise((done) => setTimeout(done, 50));
  }
}
export async function _stop_all_shell_processes(): Promise<void> {
  for (const process of [..._shell_processes]) await _stop_process_group(process);
}
export async function _handle_termination_signal(signum: number): Promise<void> {
  await _stop_all_shell_processes();
  process.exit(128 + signum);
}
export async function _run_bash_process(command: string, timeout_ms = 120000): Promise<[string, number | null]> {
  let child: ChildProcess | undefined;
  try {
    child = spawn(command, { shell: true, cwd: WORKDIR, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    _shell_processes.add(child);
    const stdout: Buffer[] = []; const stderr: Buffer[] = [];
    child.stdout!.on('data', (data: Buffer) => stdout.push(data));
    child.stderr!.on('data', (data: Buffer) => stderr.push(data));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await new Promise<[string, number | null]>((done) => {
      timer = setTimeout(() => done(['Error: Timeout (120s)', null]), timeout_ms);
      child!.once('error', (error) => done([`Error: ${'code' in error && error.code === 'ENOENT' ? 'FileNotFoundError' : 'OSError'}: ${error.message}`, null]));
      child!.once('close', (code, signal) => {
        const output = (Buffer.concat(stdout).toString('utf8') + Buffer.concat(stderr).toString('utf8')).replace(/\r\n?/g, '\n').trim();
        done([output ? Array.from(output).slice(0, 50000).join('') : '(no output)', code ?? (signal ? -(os_constants.signals[signal] ?? 1) : null)]);
      });
    });
    clearTimeout(timer);
    return result;
  } finally {
    if (child) { await _stop_process_group(child); _shell_processes.delete(child); }
  }
}
export function _format_bash_result(output: string, exit_code: number | null): string {
  if (exit_code === 0 || exit_code === null) return output;
  return `Error: command exited with status ${exit_code}\n${output}`;
}
export async function run_bash(command: string, _run_in_background = false): Promise<string> {
  return _format_bash_result(...await _run_bash_process(command));
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
        },
        "run_in_background": {
          "type": "boolean"
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
  bash: (input: Record<string, unknown>) => (bind_kwargs(input, ["command","run_in_background"], ["command"], "run_bash"), run_bash(input.command as string, input.run_in_background as boolean | undefined)),
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
  if (block.name === 'bash') {
    const command = ((Object.hasOwn(input, 'command') ? input.command : '')) as string;
    for (const pattern of DENY_LIST) {
      if (command.includes(pattern)) {
        console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
        return 'Permission denied by deny list';
      }
    }
    if (contains_destructive_command(command) || DESTRUCTIVE.some((keyword) => command.includes(keyword))) {
      console.log('\n\x1b[33m[permission] Potentially destructive command\x1b[0m');
      console.log(`   Tool: ${block.name}(${python_str(input)})`);
      const choice = (await terminal?.question('   Allow? [y/N] ', { signal: input_closed }))?.trim().toLowerCase();
      if (!choice || !['y', 'yes'].includes(choice)) return 'Permission denied by user';
    }
  }
  if (['read_file', 'write_file', 'edit_file'].includes(block.name)) {
    const path = ((Object.hasOwn(input, 'path') ? input.path : '')) as string;
    if (!is_relative_to(resolve_path(path), WORKDIR)) {
      console.log('\n\x1b[33m[permission] Access outside workspace\x1b[0m');
      console.log(`   Tool: ${block.name}(${python_str(input)})`);
      const choice = (await terminal?.question('   Allow? [y/N] ', { signal: input_closed }))?.trim().toLowerCase();
      if (!choice || !['y', 'yes'].includes(choice)) return 'Permission denied by user';
    }
  }
  return null;
}

export function log_hook(block: ToolCall): null {
  const args_preview = python_str(Object.values(block.input as ToolInput).slice(0, 2)).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${block.name}(${args_preview})\x1b[0m`);
  return null;
}

export function large_output_hook(block: ToolCall, output: unknown): null {
  const length = Array.from(python_str(output)).length;
  if (length > 100000) console.log(`\x1b[33m[HOOK] Large output from ${block.name}: ${length} chars\x1b[0m`);
  return null;
}

export function context_inject_hook(_query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

export function summary_hook(messages: Anthropic.MessageParam[]): null {
  const tool_count = messages.reduce((total, message) => total + (Array.isArray(message.content)
    ? message.content.filter((block) => block.type === 'tool_result').length : 0), 0);
  console.log(`\x1b[90m[HOOK] Stop: session used ${tool_count} tool calls\x1b[0m`);
  return null;
}

register_hook('UserPromptSubmit', (query) => context_inject_hook(query as string));
register_hook('PreToolUse', (block) => permission_hook(block as ToolCall));
register_hook('PreToolUse', (block) => log_hook(block as ToolCall));
register_hook('PostToolUse', (block, output) => large_output_hook(block as ToolCall, output));
register_hook('Stop', (messages) => summary_hook(messages as Anthropic.MessageParam[]));

export async function call_tool(block: ToolCall): Promise<string> {
  const handler = Object.hasOwn(TOOL_HANDLERS, block.name) ? TOOL_HANDLERS[block.name] : undefined;
  let output: unknown;
  try { output = handler ? await handler(block.input as ToolInput) : `Unknown: ${block.name}`; }
  catch (error) { output = `Error: ${error instanceof Error ? error.message : String(error)}`; }
  return python_str(output);
}

// -- New in s11: background execution --
export class BackgroundManager {
  tasks = new Map<string, { tool_use_id: string; command: string; status: string }>();
  results = new Map<string, string>();
  _ready: string[] = [];
  _counter = 0;

  start(block: ToolCall): string {
    if (block.name !== 'bash') throw new Error('Only Bash commands can run in the background');
    const command = (block.input as ToolInput).command;
    if (typeof command !== 'string' || !command.trim()) throw new Error('Bash command cannot be empty');
    this._counter += 1;
    const task_id = `bg_${String(this._counter).padStart(4, '0')}`;
    this.tasks.set(task_id, { tool_use_id: block.id, command, status: 'running' });
    // Promises and child-process I/O provide the concurrency of Python's daemon thread.
    try { void this._run(task_id, command); } catch (error) { this.tasks.delete(task_id); throw error; }
    console.log(`  [background] started ${task_id}: ${Array.from(command).slice(0, 60).join('')}`);
    return task_id;
  }
  async _run(task_id: string, command: string): Promise<void> {
    let result: string; let status: string;
    try {
      const [output, exit_code] = await _run_bash_process(command);
      result = _format_bash_result(output, exit_code);
      status = exit_code === 0 ? 'completed' : 'failed';
    } catch (error) { result = `Error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`; status = 'failed'; }
    const task = this.tasks.get(task_id);
    if (!task) return;
    task.status = status;
    this.results.set(task_id, result);
    this._ready.push(task_id);
  }
  collect(): string[] {
    const ready: [string, { command: string; status: string }, string][] = [];
    for (const task_id of this._ready) {
      const task = this.tasks.get(task_id); this.tasks.delete(task_id);
      const result = this.results.get(task_id) ?? ''; this.results.delete(task_id);
      if (task) ready.push([task_id, task, result]);
    }
    this._ready.length = 0;
    const notifications: string[] = [];
    for (const [task_id, task, result] of ready) {
      notifications.push(`<task_notification>\n  <task_id>${task_id}</task_id>\n  <status>${task.status}</status>\n  <command>${task.command}</command>\n  <summary>${Array.from(result).slice(0, 500).join('')}</summary>\n</task_notification>`);
      console.log(`  [background] collected ${task_id}: ${task.status}`);
    }
    return notifications;
  }
}
export const BACKGROUND = new BackgroundManager();
export const background_tasks = BACKGROUND.tasks;
export const background_results = BACKGROUND.results;
export function should_run_background(tool_name: string, tool_input: ToolInput): boolean {
  return tool_name === 'bash' && tool_input.run_in_background === true;
}
export function start_background_task(block: ToolCall): string { return BACKGROUND.start(block); }
export function collect_background_results(): string[] { return BACKGROUND.collect(); }
export function inject_background_results(messages: Anthropic.MessageParam[]): number {
  const notifications = collect_background_results();
  if (!notifications.length) return 0;
  const blocks: Anthropic.TextBlockParam[] = notifications.map((text) => ({ type: 'text', text }));
  const last = messages.at(-1);
  if (last?.role === 'user') {
    const content = last.content ?? '';
    if (Array.isArray(content)) content.push(...blocks);
    else last.content = [{ type: 'text', text: python_str(content) }, ...blocks];
  } else messages.push({ role: 'user', content: blocks });
  return notifications.length;
}
export async function execute_tool(block: ToolCall): Promise<string> {
  const blocked = await trigger_hooks('PreToolUse', block);
  if (blocked !== null && blocked !== undefined) return python_str(blocked);
  let output: string;
  if (should_run_background(block.name, block.input as ToolInput)) {
    try {
      const task_id = start_background_task(block);
      output = `[Background task ${task_id} started] The result will be collected on a later turn.`;
    } catch (error) { output = `Error: ${error instanceof Error ? error.message : String(error)}`; }
  } else output = await call_tool(block);
  await trigger_hooks('PostToolUse', block, output);
  return output;
}
export async function agent_loop(messages: Anthropic.MessageParam[], client: Pick<Anthropic, 'messages'>, MODEL: string): Promise<void> {
  while (true) {
    inject_background_results(messages);
    const response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 });
    messages.push({ role: 'assistant', content: response.content });
    const tool_calls = response.content.filter((block) => block.type === 'tool_use');
    if (!tool_calls.length) {
      const force = await trigger_hooks('Stop', messages);
      if (force) { messages.push({ role: 'user', content: force as string }); continue; }
      return;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of tool_calls) {
      const output = await execute_tool(block);
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

  process.once('SIGTERM', () => { void _handle_termination_signal(15); });
  console.log('s11: Background Tasks - explicit background Bash execution');
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
        query = await terminal.question('\x1b[36ms11 >> \x1b[0m', { signal: input_closed });
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
    await _stop_all_shell_processes();
  }
}
