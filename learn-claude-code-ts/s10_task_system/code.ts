/**
 * s10_task_system/code.ts - Task System
 *
 *     .tasks/
 *       task_a1b2c3d4.json  {status: completed, blockedBy: []}
 *       task_e5f6a7b8.json  {status: pending, blockedBy: [task_a1b2c3d4]}
 *       task_11223344.json  {status: pending, blockedBy: [task_e5f6a7b8]}
 *
 *     Dependency graph:
 *
 *     +-----------+      +-----------+      +-----------+
 *     | schema    | ---> | API       | ---> | tests     |
 *     | completed |      | pending   |      | pending   |
 *     +-----------+      +-----------+      +-----------+
 *
 *     canStart(API) is true because schema is completed.
 *
 *     Task lifecycle:
 *
 *     pending --claim_task--> in_progress --complete_task--> completed
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, readdirSync, statSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse as path_parse, relative, resolve, sep } from 'node:path';
import { createInterface, type Interface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

import { randomBytes } from 'node:crypto';
const WORKDIR = realpathSync(process.cwd());
const ENVIRONMENT_PROMPT = process.platform === 'win32'
  ? 'Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations'
  : 'Unix-like: the bash tool runs the system shell';
const SYSTEM = `You are a coding agent at ${WORKDIR}. Environment: ${ENVIRONMENT_PROMPT}. `
  + 'Use task tools to track dependencies and progress. Create all task nodes '
  + 'first. After create_task returns runtime-generated IDs, use update_task '
  + 'with those exact IDs to add dependencies.';
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

// -- New in s10: persistent task records --
export const TASKS_DIR = resolve(WORKDIR, '.tasks');
export const TASK_ID_PATTERN = /^task_[0-9a-f]{8}$/;

export class Task {
  constructor(public id: string, public subject: string, public description: string, public status: string,
    public owner: string | null, public blockedBy: string[]) {}
}

export class TaskStore {
  constructor(public directory: string) {}

  _root(create = false): string {
    if (create) mkdirSync(this.directory, { recursive: true });
    const root = resolve_path(this.directory);
    if (!is_relative_to(root, WORKDIR)) throw new Error('Task store escapes the workspace');
    return root;
  }
  _path(task_id: string, create_root = false): string {
    if (typeof task_id !== 'string' || !TASK_ID_PATTERN.test(task_id) || task_id.length !== 13) throw new Error(`Invalid task ID: ${repr(task_id)}`);
    const root = this._root(create_root);
    const path = resolve_path(resolve(root, `${task_id}.json`));
    if (!is_relative_to(path, root)) throw new Error(`Invalid task ID: ${repr(task_id)}`);
    return path;
  }
  exists(task_id: string): boolean {
    const path = this._path(task_id);
    return existsSync(path) && statSync(path).isFile();
  }
  create(subject: string, description = ''): Task {
    subject = subject.trim();
    if (!subject) throw new Error('Task subject cannot be empty');
    this._root(true);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const task = new Task(`task_${randomBytes(4).toString('hex')}`, subject, description, 'pending', null, []);
      try {
        writeFileSync(this._path(task.id, true), JSON.stringify(task, null, 2), { flag: 'wx', encoding: 'utf8' });
        return task;
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new Error('Could not allocate a unique task ID');
  }
  _depends_on(task_id: string, target_id: string): boolean {
    const pending = [task_id];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === target_id) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...this.load(current).blockedBy);
    }
    return false;
  }
  update_dependencies(task_id: string, add_blocked_by: string[]): Task {
    if (!Array.isArray(add_blocked_by)) throw new Error('addBlockedBy must be a list of task IDs');
    const task = this.load(task_id);
    if (task.status !== 'pending' || task.owner !== null) throw new Error(`Task ${task_id} dependencies can only be updated while pending and unowned`);
    const dependencies = [...new Set(add_blocked_by)];
    for (const dependency of dependencies) {
      if (dependency === task_id) throw new Error('Task cannot depend on itself');
      if (!this.exists(dependency)) throw new Error(`Dependency not found: ${dependency}`);
      if (!task.blockedBy.includes(dependency) && this._depends_on(dependency, task_id)) throw new Error(`Dependency cycle detected: ${task_id} -> ${dependency}`);
    }
    task.blockedBy.push(...dependencies.filter((dependency) => !task.blockedBy.includes(dependency)));
    this.save(task);
    return task;
  }
  save(task: Task): void { writeFileSync(this._path(task.id, true), JSON.stringify(task, null, 2), 'utf8'); }
  load(task_id: string): Task {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(this._path(task_id))));
    const keys = ['id', 'subject', 'description', 'status', 'owner', 'blockedBy'];
    if (!data || typeof data !== 'object' || keys.some((key) => !Object.hasOwn(data, key)) || Object.keys(data).some((key) => !keys.includes(key))) throw new Error('Invalid task record fields');
    const task = new Task(data.id, data.subject, data.description, data.status, data.owner, data.blockedBy);
    if (task.id !== task_id) throw new Error(`Task file ID does not match ${task_id}`);
    if (!['pending', 'in_progress', 'completed'].includes(task.status)) throw new Error(`Invalid task status: ${task.status}`);
    return task;
  }
  list(): Task[] {
    if (!existsSync(this.directory)) return [];
    const root = this._root();
    return python_glob('task_*.json', root, true).sort().map((path) => this.load(basename(path, '.json')));
  }
}

export const TASKS = new TaskStore(TASKS_DIR);
export function create_task(subject: string, description = ''): Task { return TASKS.create(subject, description); }
export function update_task(task_id: string, addBlockedBy: string[]): Task { return TASKS.update_dependencies(task_id, addBlockedBy); }
export function load_task(task_id: string): Task { return TASKS.load(task_id); }
export function list_tasks(): Task[] { return TASKS.list(); }
export function get_task(task_id: string): string { return JSON.stringify(load_task(task_id), null, 2); }
export function incomplete_dependencies(task: Task): string[] {
  const incomplete: string[] = [];
  for (const dependency of task.blockedBy) {
    try { if (load_task(dependency).status !== 'completed') incomplete.push(dependency); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') throw error;
      incomplete.push(dependency);
    }
  }
  return incomplete;
}
export function can_start(task_id: string): boolean { return !incomplete_dependencies(load_task(task_id)).length; }
export function claim_task(task_id: string, owner = 'agent'): string {
  const task = load_task(task_id);
  if (task.status !== 'pending') return `Task ${task_id} is ${task.status}, cannot claim`;
  const dependencies = incomplete_dependencies(task);
  if (dependencies.length) return `Blocked by: ${python_str(dependencies)}`;
  task.owner = owner;
  task.status = 'in_progress';
  TASKS.save(task);
  console.log(`  [claim] ${task.subject} -> in_progress (owner: ${owner})`);
  return `Claimed ${task.id} (${task.subject})`;
}
export function complete_task(task_id: string, owner = 'agent'): string {
  const task = load_task(task_id);
  if (task.status !== 'in_progress') return `Task ${task_id} is ${task.status}, cannot complete`;
  if (task.owner !== owner) return `Task ${task_id} is owned by ${task.owner}, not ${owner}`;
  const ready_before = new Set(list_tasks().filter((candidate) => candidate.status === 'pending' && candidate.blockedBy.length && can_start(candidate.id)).map((candidate) => candidate.id));
  task.status = 'completed';
  TASKS.save(task);
  const unblocked = list_tasks().filter((candidate) => candidate.status === 'pending' && candidate.blockedBy.length && !ready_before.has(candidate.id) && can_start(candidate.id)).map((candidate) => candidate.subject);
  console.log(`  [complete] ${task.subject}`);
  let message = `Completed ${task.id} (${task.subject})`;
  if (unblocked.length) { message += `\nUnblocked: ${unblocked.join(', ')}`; console.log(`  [unblocked] ${unblocked.join(', ')}`); }
  return message;
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

export function run_create_task(subject: string, description = ''): string {
  const task = create_task(subject, description);
  console.log(`  [create] ${task.subject}`);
  return `Created ${task.id}: ${task.subject}`;
}
export function run_update_task(task_id: string, addBlockedBy: string[]): string {
  const task = update_task(task_id, addBlockedBy);
  const dependencies = task.blockedBy.join(', ') || '(none)';
  console.log(`  [update] ${task.subject} blockedBy: ${dependencies}`);
  return `Updated ${task.id} blockedBy: ${dependencies}`;
}
export function run_list_tasks(): string {
  const tasks = list_tasks();
  if (!tasks.length) return 'No tasks. Use create_task to add some.';
  const lines: string[] = [];
  for (const task of tasks) {
    const marker = ({ pending: '[ ]', in_progress: '[>]', completed: '[x]' } as Record<string, string>)[task.status] ?? '[?]';
    const dependencies = task.blockedBy.length ? ` (blockedBy: ${task.blockedBy.join(', ')})` : '';
    const owner = task.owner ? ` [${task.owner}]` : '';
    lines.push(`${marker} ${task.id}: ${task.subject} [${task.status}]${owner}${dependencies}`);
  }
  return lines.join('\n');
}
export function run_get_task(task_id: string): string { return get_task(task_id); }
export function run_claim_task(task_id: string): string { return claim_task(task_id, 'agent'); }
export function run_complete_task(task_id: string): string { return complete_task(task_id, 'agent'); }
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
  },
  {
    "name": "create_task",
    "description": "Create a task and return its runtime-generated ID.",
    "input_schema": {
      "type": "object",
      "properties": {
        "subject": {
          "type": "string"
        },
        "description": {
          "type": "string"
        }
      },
      "required": [
        "subject"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "update_task",
    "description": "Add dependencies using IDs returned by create_task.",
    "input_schema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string",
          "pattern": "^task_[0-9a-f]{8}$"
        },
        "addBlockedBy": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^task_[0-9a-f]{8}$"
          },
          "minItems": 1
        }
      },
      "required": [
        "task_id",
        "addBlockedBy"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "list_tasks",
    "description": "List tasks with status, owner, and dependencies.",
    "input_schema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "get_task",
    "description": "Get a task by ID.",
    "input_schema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "claim_task",
    "description": "Claim a pending task whose dependencies are complete.",
    "input_schema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string"
        }
      },
      "required": [
        "task_id"
      ]
    }
  },
  {
    "name": "complete_task",
    "description": "Complete the task claimed by this agent.",
    "input_schema": {
      "type": "object",
      "properties": {
        "task_id": {
          "type": "string"
        }
      },
      "required": [
        "task_id"
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
  create_task: (input: Record<string, unknown>) => (bind_kwargs(input, ["subject","description"], ["subject"], "run_create_task"), run_create_task(input.subject as string, input.description as string | undefined)),
  update_task: (input: Record<string, unknown>) => (bind_kwargs(input, ["task_id","addBlockedBy"], ["task_id","addBlockedBy"], "run_update_task"), run_update_task(input.task_id as string, input.addBlockedBy as string[])),
  list_tasks: (input: Record<string, unknown>) => (bind_kwargs(input, [], [], "run_list_tasks"), run_list_tasks()),
  get_task: (input: Record<string, unknown>) => (bind_kwargs(input, ["task_id"], ["task_id"], "run_get_task"), run_get_task(input.task_id as string)),
  claim_task: (input: Record<string, unknown>) => (bind_kwargs(input, ["task_id"], ["task_id"], "run_claim_task"), run_claim_task(input.task_id as string)),
  complete_task: (input: Record<string, unknown>) => (bind_kwargs(input, ["task_id"], ["task_id"], "run_complete_task"), run_complete_task(input.task_id as string)),
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

export function context_hook(_query: string): null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

export function summary_hook(messages: Anthropic.MessageParam[]): null {
  const tool_count = messages.reduce((total, message) => total + (Array.isArray(message.content)
    ? message.content.filter((block) => block.type === 'tool_result').length : 0), 0);
  console.log(`\x1b[90m[HOOK] Stop: session used ${tool_count} tool calls\x1b[0m`);
  return null;
}

register_hook('UserPromptSubmit', (query) => context_hook(query as string));
register_hook('PreToolUse', (block) => permission_hook(block as ToolCall));
register_hook('PreToolUse', (block) => log_hook(block as ToolCall));
register_hook('PostToolUse', (block, output) => large_output_hook(block as ToolCall, output));
register_hook('Stop', (messages) => summary_hook(messages as Anthropic.MessageParam[]));

export async function execute_tool(block: ToolCall, handlers = TOOL_HANDLERS): Promise<string> {
  const blocked = await trigger_hooks('PreToolUse', block);
  if (blocked) return python_str(blocked);
  const handler = Object.hasOwn(handlers, block.name) ? handlers[block.name] : undefined;
  let output: unknown;
  try { output = handler ? await handler(block.input as ToolInput) : `Unknown: ${block.name}`; }
  catch (error) { output = `Error: ${error instanceof Error ? error.message : String(error)}`; }
  await trigger_hooks('PostToolUse', block, output);
  return python_str(output);
}
export async function agent_loop(messages: Anthropic.MessageParam[], client: Pick<Anthropic, 'messages'>, MODEL: string): Promise<void> {
  while (true) {
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

  console.log('s10: Task System - dependencies and task state');
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
        query = await terminal.question('\x1b[36ms10 >> \x1b[0m', { signal: input_closed });
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
