/**
 * s12_cron_scheduler/code.ts - Cron Scheduler
 *
 *     +--------------------------+   09:00   +-----------------------+
 *     | 0 9 * * *               | --------> | [Scheduled] run tests |
 *     | prompt: "run tests"      |           +-----------+-----------+
 *     +--------------------------+                       |
 *           scheduled_jobs                    scheduler.queue | agent idle
 *                                                         v
 *                                                 +-------------+
 *                                                 | Agent Loop  |
 *                                                 +-------------+
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, statSync, readlinkSync, mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse as path_parse, relative, resolve, sep } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
const WORKDIR = realpathSync(process.cwd());
const ENVIRONMENT_PROMPT = process.platform === 'win32'
  ? 'Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations'
  : 'Unix-like: the bash tool runs the system shell';
const SYSTEM = `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. `
  + 'Use tools to solve tasks. Use schedule_cron for work that should start at a future local time.';
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
    if (result.status !== 0) return `Error: command exited with status ${result.status}\n${output}`;
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

export async function request_permission(block: ToolCall, reason: string): Promise<string | null> {
  if (scheduled_turn.getStore()) return 'Permission denied: scheduled turns cannot request interactive approval';
  console.log(`\n\x1b[33m[permission] ${reason}\x1b[0m`);
  console.log(`   Tool: ${block.name}(${python_str(block.input)})`);
  const choice = (await terminal?.question('   Allow? [y/N] ', { signal: input_closed }))?.trim().toLowerCase();
  return choice && ['y', 'yes'].includes(choice) ? null : 'Permission denied by user';
}
export async function permission_hook(block: ToolCall): Promise<string | null> {
  const input = block.input as ToolInput;
  if (block.name === 'bash') {
    const command = ((Object.hasOwn(input, 'command') ? input.command : '')) as string;
    for (const pattern of DENY_LIST) if (command.includes(pattern)) {
      console.log(`\n\x1b[31m[blocked] '${pattern}'\x1b[0m`);
      return 'Permission denied by deny list';
    }
    if (contains_destructive_command(command) || DESTRUCTIVE.some((keyword) => command.includes(keyword))) return request_permission(block, 'Potentially destructive command');
  }
  if (['read_file', 'write_file', 'edit_file'].includes(block.name) && !is_relative_to(resolve_path(((Object.hasOwn(input, 'path') ? input.path : '')) as string), WORKDIR)) return request_permission(block, 'Access outside workspace');
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

// -- New in s12: cron jobs --
export class CronJob {
  constructor(public id: string, public cron: string, public prompt: string, public recurring: boolean,
    public durable: boolean, public pending_delivery = false, public last_fired: string | null = null) {}
}
export const DURABLE_PATH = resolve(WORKDIR, '.scheduled_tasks.json');
export const scheduled_jobs = new Map<string, CronJob>();
export const cron_queue: CronJob[] = [];

export function _cron_field_matches(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) return value % Number(field.slice(2)) === 0;
  if (field.includes(',')) return field.split(',').some((part) => _cron_field_matches(part.trim(), value));
  if (field.includes('-')) { const [start, end] = field.split('-', 2); return Number(start) <= value && value <= Number(end); }
  return value === Number(field);
}
export function cron_matches(cron_expr: string, moment: Date): boolean {
  const fields = cron_expr.trim() ? cron_expr.trim().split(/\s+/) : [];
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, weekday] = fields;
  const cron_weekday = moment.getDay();
  if (!(_cron_field_matches(minute, moment.getMinutes()) && _cron_field_matches(hour, moment.getHours()) && _cron_field_matches(month, moment.getMonth() + 1))) return false;
  const day_matches = _cron_field_matches(day, moment.getDate());
  const weekday_matches = _cron_field_matches(weekday, cron_weekday);
  if (day === '*' && weekday === '*') return true;
  if (day === '*') return weekday_matches;
  if (weekday === '*') return day_matches;
  return day_matches || weekday_matches;
}
export function _validate_cron_field(field: string, minimum: number, maximum: number): string | null {
  if (field === '*') return null;
  if (field.startsWith('*/')) { const step = field.slice(2); return !/^\d+$/.test(step) || Number(step) <= 0 ? `Invalid step: ${field}` : null; }
  if (field.includes(',')) {
    for (const part of field.split(',')) { const error = _validate_cron_field(part.trim(), minimum, maximum); if (error) return error; }
    return null;
  }
  if (field.includes('-')) {
    const index = field.indexOf('-'); const start = field.slice(0, index); const end = field.slice(index + 1);
    if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return `Invalid range: ${field}`;
    const start_value = Number(start); const end_value = Number(end);
    if (start_value > end_value) return `Range start is greater than end: ${field}`;
    if (start_value < minimum || end_value > maximum) return `Range ${field} is outside [${minimum}-${maximum}]`;
    return null;
  }
  if (!/^\d+$/.test(field)) return `Invalid field: ${field}`;
  const value = Number(field);
  if (value < minimum || value > maximum) return `Value ${value} is outside [${minimum}-${maximum}]`;
  return null;
}
export function validate_cron(cron_expr: string): string | null {
  const fields = cron_expr.trim() ? cron_expr.trim().split(/\s+/) : [];
  if (fields.length !== 5) return `Expected 5 fields, got ${fields.length}`;
  const field_rules: [string, number, number][] = [['minute', 0, 59], ['hour', 0, 23], ['day-of-month', 1, 31], ['month', 1, 12], ['day-of-week', 0, 6]];
  for (let index = 0; index < fields.length; index += 1) {
    const [name, minimum, maximum] = field_rules[index];
    const error = _validate_cron_field(fields[index], minimum, maximum);
    if (error) return `${name}: ${error}`;
  }
  return null;
}
export function save_durable_jobs(): void {
  const payload = [...scheduled_jobs.values()].filter((job) => job.durable);
  // Synchronous persistence is atomic with respect to all callbacks on this event loop.
  const temporary = `${DURABLE_PATH}.${process.pid}.0.tmp`;
  try { writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8'); renameSync(temporary, DURABLE_PATH); }
  finally { rmSync(temporary, { force: true }); }
}
export function load_durable_jobs(): void {
  if (!existsSync(DURABLE_PATH)) return;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(DURABLE_PATH)));
    if (!Array.isArray(payload)) throw new Error('expected a JSON list');
  } catch (error) { console.log(`  [cron] could not load ${basename(DURABLE_PATH)}: ${error instanceof Error ? error.message : String(error)}`); return; }
  let loaded = 0;
  for (const item of payload as Record<string, unknown>[]) {
    let job: CronJob;
    try {
      const allowed = ['id', 'cron', 'prompt', 'recurring', 'durable', 'pending_delivery', 'last_fired'];
      if (!item || typeof item !== 'object' || ['id', 'cron', 'prompt', 'recurring', 'durable'].some((key) => !Object.hasOwn(item, key)) || Object.keys(item).some((key) => !allowed.includes(key))) throw new Error('Invalid saved cron job fields');
      job = new CronJob(item.id as string, item.cron as string, item.prompt as string, item.recurring as boolean, item.durable as boolean, item.pending_delivery as boolean | undefined, item.last_fired as string | null | undefined);
      const error = validate_cron(job.cron); if (error) throw new Error(error);
      if (!job.id.startsWith('cron_')) throw new Error('invalid job ID');
      if (!job.prompt.trim()) throw new Error('prompt cannot be empty');
    } catch (error) { console.log(`  [cron] skipped invalid saved job: ${error instanceof Error ? error.message : String(error)}`); continue; }
    scheduled_jobs.set(job.id, job);
    if (job.pending_delivery) cron_queue.push(job);
    loaded += 1;
  }
  if (loaded) console.log(`  [cron] loaded ${loaded} durable job(s)`);
}
export function new_cron_id(): string {
  for (let attempt = 0; attempt < 100; attempt += 1) { const job_id = `cron_${randomBytes(4).toString('hex')}`; if (!scheduled_jobs.has(job_id)) return job_id; }
  throw new Error('Could not allocate a cron job ID');
}
export function schedule_job(cron: string, prompt: string, recurring = true, durable = true): CronJob | string {
  const error = validate_cron(cron); if (error) return error;
  if (!prompt.trim()) return 'Prompt cannot be empty';
  const job = new CronJob(new_cron_id(), cron, prompt, recurring, durable);
  scheduled_jobs.set(job.id, job);
  try { if (durable) save_durable_jobs(); } catch (error) { scheduled_jobs.delete(job.id); throw error; }
  console.log(`  [cron] scheduled ${job.id}: ${cron} -> ${Array.from(prompt).slice(0, 60).join('')}`);
  return job;
}
export function cancel_job(job_id: string): string {
  const job = scheduled_jobs.get(job_id);
  if (!job) return `Job ${job_id} not found`;
  const previous_queue = [...cron_queue];
  scheduled_jobs.delete(job_id);
  cron_queue.splice(0, cron_queue.length, ...cron_queue.filter((queued) => queued.id !== job_id));
  try { if (job.durable) save_durable_jobs(); }
  catch (error) { scheduled_jobs.set(job_id, job); cron_queue.splice(0, cron_queue.length, ...previous_queue); throw error; }
  console.log(`  [cron] cancelled ${job_id}`);
  return `Cancelled ${job_id}`;
}
export function _enqueue_due_job(job: CronJob, minute_marker?: string | null): void {
  const old_pending = job.pending_delivery; const old_last_fired = job.last_fired;
  job.pending_delivery = true;
  if (minute_marker != null) job.last_fired = minute_marker;
  try { if (job.durable) save_durable_jobs(); }
  catch (error) { job.pending_delivery = old_pending; job.last_fired = old_last_fired; throw error; }
  cron_queue.push(job);
}
export function poll_due_jobs(moment: Date): void {
  const pad = (value: number) => String(value).padStart(2, '0');
  const minute_marker = `${String(moment.getFullYear()).padStart(4, '0')}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${pad(moment.getHours())}:${pad(moment.getMinutes())}`;
  for (const job of [...scheduled_jobs.values()]) {
    try {
      if (job.pending_delivery || job.last_fired === minute_marker) continue;
      if (cron_matches(job.cron, moment)) { _enqueue_due_job(job, minute_marker); console.log(`  [cron] due ${job.id}: ${Array.from(job.prompt).slice(0, 60).join('')}`); }
    } catch (error) { console.log(`  [cron] could not enqueue ${job.id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
}
export function consume_cron_queue(): CronJob[] { const jobs = [...cron_queue]; cron_queue.length = 0; return jobs; }
export function acknowledge_cron_jobs(jobs: CronJob[]): void {
  const changed: [CronJob, boolean][] = []; const removed: CronJob[] = [];
  for (const delivered of jobs) {
    const current = scheduled_jobs.get(delivered.id); if (!current) continue;
    changed.push([current, current.pending_delivery]);
    if (current.recurring) current.pending_delivery = false;
    else { removed.push(current); scheduled_jobs.delete(current.id); }
  }
  try { if (changed.some(([job]) => job.durable)) save_durable_jobs(); }
  catch (error) {
    for (const job of removed) scheduled_jobs.set(job.id, job);
    for (const [job, pending] of changed) job.pending_delivery = pending;
    const queued_ids = new Set(cron_queue.map((job) => job.id));
    for (const [job] of changed) if (!queued_ids.has(job.id)) cron_queue.push(job);
    throw error;
  }
}
export function restore_cron_jobs(jobs: CronJob[]): void {
  const queued_ids = new Set(cron_queue.map((job) => job.id));
  for (const delivered of jobs) {
    const current = scheduled_jobs.get(delivered.id); if (!current) continue;
    current.pending_delivery = true;
    if (!queued_ids.has(current.id)) { cron_queue.push(current); queued_ids.add(current.id); }
  }
}
export function has_cron_queue(): boolean { return cron_queue.length > 0; }
export function run_schedule_cron(cron: string, prompt: string, recurring = true, durable = true): string {
  const result = schedule_job(cron, prompt, recurring, durable);
  if (typeof result === 'string') return `Error: ${result}`;
  return `Scheduled ${result.id}: ${cron} -> ${prompt}`;
}
export function run_list_crons(): string {
  const jobs = [...scheduled_jobs.values()]; if (!jobs.length) return 'No cron jobs.';
  return jobs.map((job) => `${job.id}: ${job.cron} -> ${Array.from(job.prompt).slice(0, 60).join('')} [${job.recurring ? 'recurring' : 'one-shot'}, ${job.durable ? 'durable' : 'session'}]`).join('\n');
}
export function run_cancel_cron(job_id: string): string { return cancel_job(job_id); }

TOOLS.push(...[
  {
    "name": "schedule_cron",
    "description": "Schedule a prompt with a 5-field cron expression.",
    "input_schema": {
      "type": "object",
      "properties": {
        "cron": {
          "type": "string"
        },
        "prompt": {
          "type": "string"
        },
        "recurring": {
          "type": "boolean"
        },
        "durable": {
          "type": "boolean"
        }
      },
      "required": [
        "cron",
        "prompt"
      ]
    }
  },
  {
    "name": "list_crons",
    "description": "List scheduled cron jobs.",
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "cancel_cron",
    "description": "Cancel a cron job by ID.",
    "input_schema": {
      "type": "object",
      "properties": {
        "job_id": {
          "type": "string"
        }
      },
      "required": [
        "job_id"
      ]
    }
  }
] as Anthropic.Tool[]);
Object.assign(TOOL_HANDLERS, {
  schedule_cron: (input: Record<string, unknown>) => (bind_kwargs(input, ["cron","prompt","recurring","durable"], ["cron","prompt"], "run_schedule_cron"), run_schedule_cron(input.cron as string, input.prompt as string, input.recurring as boolean | undefined, input.durable as boolean | undefined)),
  list_crons: (input: Record<string, unknown>) => (bind_kwargs(input, [], [], "run_list_crons"), run_list_crons()),
  cancel_cron: (input: Record<string, unknown>) => (bind_kwargs(input, ["job_id"], ["job_id"], "run_cancel_cron"), run_cancel_cron(input.job_id as string)),
});
export async function execute_tool(block: ToolCall, handlers = TOOL_HANDLERS): Promise<string> {
  const blocked = await trigger_hooks('PreToolUse', block);
  if (blocked !== null && blocked !== undefined) return python_str(blocked);
  const handler = Object.hasOwn(handlers, block.name) ? handlers[block.name] : undefined;
  let output: unknown;
  try { output = handler ? await handler(block.input as ToolInput) : `Unknown: ${block.name}`; }
  catch (error) { output = `Error: ${error instanceof Error ? error.message : String(error)}`; }
  await trigger_hooks('PostToolUse', block, output);
  return python_str(output);
}
// -- Scheduler and agent loop --
export const runtime_threads: ReturnType<typeof setInterval>[] = [];
export let runtime_started = false;
export const session_history: Anthropic.MessageParam[] = [];
const scheduled_turn = new AsyncLocalStorage<boolean>();
const agent_lock = { busy: false, waiters: [] as (() => void)[] };
function release_agent_lock(): void {
  const next = agent_lock.waiters.shift();
  if (next) next(); else agent_lock.busy = false;
}
async function acquire_agent_lock(): Promise<void> {
  if (!agent_lock.busy) { agent_lock.busy = true; return; }
  await new Promise<void>((done) => agent_lock.waiters.push(done));
}
let live_client: Pick<Anthropic, 'messages'>;
let live_model: string;

export function cron_scheduler_loop(): ReturnType<typeof setInterval> {
  return setInterval(() => poll_due_jobs(new Date()), 1000);
}
export async function agent_loop(messages: Anthropic.MessageParam[], context: Record<string, unknown> | null = null,
  client: Pick<Anthropic, 'messages'> = live_client, MODEL = live_model): Promise<Record<string, unknown> | null> {
  const fired = consume_cron_queue();
  const scheduled_start = messages.length;
  for (const job of fired) {
    messages.push({ role: 'user', content: `[Scheduled] ${job.prompt}` });
    console.log(`  [cron] delivered ${job.id}: ${Array.from(job.prompt).slice(0, 60).join('')}`);
  }
  let waiting_for_ack = [...fired];
  while (true) {
    let response: Anthropic.Message;
    try { response = await client.messages.create({ model: MODEL, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 }); }
    catch (error) {
      if (waiting_for_ack.length) { messages.splice(scheduled_start); restore_cron_jobs(waiting_for_ack); }
      console.log(`  [error] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      return context;
    }
    messages.push({ role: 'assistant', content: response.content });
    if (waiting_for_ack.length) {
      try { acknowledge_cron_jobs(waiting_for_ack); }
      catch (error) { console.log(`  [cron] acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`); }
      waiting_for_ack = [];
    }
    const tool_calls = response.content.filter((block) => block.type === 'tool_use');
    if (!tool_calls.length) {
      const force = await trigger_hooks('Stop', messages);
      if (force) { messages.push({ role: 'user', content: force as string }); continue; }
      return context;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of tool_calls) results.push({ type: 'tool_result', tool_use_id: block.id, content: await execute_tool(block) });
    messages.push({ role: 'user', content: results });
  }
}
export function print_latest_assistant_text(messages: Anthropic.MessageParam[]): void {
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant') continue;
    if (typeof message.content === 'string') console.log(message.content);
    else for (const block of message.content) if (block.type === 'text') console.log(block.text ?? '');
    return;
  }
}
export async function run_agent_turn_locked(user_query: string | null = null, client = live_client, MODEL = live_model): Promise<void> {
  if (user_query !== null) { await trigger_hooks('UserPromptSubmit', user_query); session_history.push({ role: 'user', content: user_query }); }
  await agent_loop(session_history, null, client, MODEL);
  print_latest_assistant_text(session_history);
  console.log();
}
export function queue_processor_loop(): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (!has_cron_queue() || agent_lock.busy) return;
    agent_lock.busy = true;
    void scheduled_turn.run(true, async () => {
      try { if (has_cron_queue()) await run_agent_turn_locked(); }
      finally { release_agent_lock(); }
    });
  }, 200);
}
export function start_runtime_threads(client = live_client, MODEL = live_model): void {
  if (runtime_started) return;
  live_client = client; live_model = MODEL;
  load_durable_jobs();
  runtime_threads.push(cron_scheduler_loop(), queue_processor_loop());
  runtime_started = true;
}
export function stop_runtime_threads(): void {
  if (!runtime_started) return;
  for (const timer of runtime_threads) clearInterval(timer);
  runtime_threads.length = 0;
  runtime_started = false;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: true, quiet: true });
  if (process.env.ANTHROPIC_BASE_URL) delete process.env.ANTHROPIC_AUTH_TOKEN;
  const client = new Anthropic({ baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
  const MODEL = process.env.MODEL_ID;
  if (!MODEL) throw new Error('Missing MODEL_ID. Configure learn-claude-code-ts/.env first.');
  console.log('s12: Cron Scheduler - run prompts on a local schedule');
  console.log('Enter a question, press Enter to send. Type q to quit.\n');
  terminal = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new AbortController(); input_closed = closed.signal;
  terminal.once('close', () => closed.abort());
  terminal.on('SIGINT', () => terminal?.close());
  process.once('SIGINT', () => terminal?.close());
  process.once('SIGTERM', () => { stop_runtime_threads(); terminal?.close(); process.exit(143); });
  start_runtime_threads(client, MODEL);
  try {
    while (true) {
      let query: string;
      try { query = await terminal.question('\x1b[36ms12 >> \x1b[0m', { signal: input_closed }); } catch { break; }
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) break;
      await acquire_agent_lock();
      try { await run_agent_turn_locked(query); } finally { release_agent_lock(); }
    }
  } finally { stop_runtime_threads(); terminal.close(); }
}
