/**
 * s13: Agent Teams - persistent teammates with shared tasks and mailboxes.
 *
 * Run:  npm run s13
 * Need: npm install; learn-claude-code-ts/.env with ANTHROPIC_API_KEY and MODEL_ID
 *
 *     +------+  spawn(task_id)  +----------+  result  +------+
 *     | Lead | ---------------> |   WORK   | -------> | IDLE |
 *     +--+---+                  +----+-----+          +--+---+
 *        ^                           |                   |
 *        | team events               | tools             | wait
 *        |                           v                   v
 *     +--+-----------+          +----------+        +----------+
 *     | MessageBus   |          | Task cwd | <----- | Mailbox  |
 *     +--------------+          +----------+  claim +----------+
 *
 *     .tasks/       shared task records and dependencies
 *     .mailboxes/   messages, results, and protocol responses
 *     .worktrees/   optional task-bound working directories
 */
import Anthropic from '@anthropic-ai/sdk';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse as path_parse, relative, resolve, sep } from 'node:path';
import { constants as os_constants } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { flockSync } from 'fs-ext';
import { config } from 'dotenv';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)), override: true, quiet: true });
if (process.env.ANTHROPIC_BASE_URL) delete process.env.ANTHROPIC_AUTH_TOKEN;
export const WORKDIR = realpathSync(process.cwd());
export const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '', baseURL: process.env.ANTHROPIC_BASE_URL || undefined });
export const MODEL = process.env.MODEL_ID ?? '';
type ModelClient = Pick<Anthropic, 'messages'>;
type ToolInput = Record<string, unknown>;
type ToolCall = Pick<Anthropic.ToolUseBlock, 'name' | 'input' | 'id'>;
type Handler = (input: ToolInput) => unknown | Promise<unknown>;
class ValueError extends Error { override name = 'ValueError'; }
function error_text(error: unknown): string { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
function is_file_not_found(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function read_utf8(path: string): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)).replace(/\r\n?/g, '\n'); }
function char_slice(value: string, start: number, end?: number): string { return Array.from(value).slice(start, end).join(''); }
function json_pretty(value: unknown): string { return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function json_dump(value: unknown, ensure_ascii = false): string {
  let result: string;
  if (Array.isArray(value)) result = `[${value.map((item) => json_dump(item)).join(', ')}]`;
  else if (value && typeof value === 'object') result = `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${json_dump(item)}`).join(', ')}}`;
  else result = JSON.stringify(value) ?? JSON.stringify(python_str(value));
  return ensure_ascii ? result.replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) : result;
}
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
// -- Task System --
export const TASKS_DIR = resolve(WORKDIR, '.tasks');
export const TASKS_ROOT = resolve_path(TASKS_DIR);
export const TASK_ID_PATTERN = /^task_[0-9a-f]{8}$/;
export const TASK_LOCK_PATH = resolve(TASKS_DIR, '.lock');
const _task_store_state = { depth: 0, handle: -1 };
export const teammate_assignments = new Map<string, { task_id: string; cwd: string }>();
export const assignment_versions = new Map<string, number>();

export function task_store_lock<T>(operation: () => T): T {
  if (_task_store_state.depth === 0) {
    mkdirSync(TASKS_DIR, { recursive: true });
    const handle = openSync(TASK_LOCK_PATH, 'a+');
    try { flockSync(handle, 'ex'); } catch (error) { closeSync(handle); throw error; }
    _task_store_state.handle = handle;
  }
  _task_store_state.depth += 1;
  try { return operation(); }
  finally {
    _task_store_state.depth -= 1;
    if (_task_store_state.depth === 0) {
      const handle = _task_store_state.handle;
      flockSync(handle, 'un'); closeSync(handle); _task_store_state.handle = -1;
    }
  }
}
export function advance_assignment_version(owner: string): void {
  assignment_versions.set(owner, (assignment_versions.get(owner) ?? 0) + 1);
  if (plan_gates.has(owner) && plan_gates.get(owner) !== 'not_required') plan_gates.set(owner, 'required');
  plan_request_ids.delete(owner);
}
export class Task {
  constructor(public id: string, public subject: string, public description: string, public status: string,
    public owner: string | null, public blockedBy: string[], public worktree: string | null = null) {}
}
export function _task_path(task_id: string): string {
  if (typeof task_id !== 'string' || task_id.length !== 13 || !TASK_ID_PATTERN.test(task_id)) throw new ValueError(`Invalid task ID: ${repr(task_id)}`);
  const path = resolve_path(resolve(TASKS_DIR, `${task_id}.json`));
  if (!is_relative_to(TASKS_ROOT, WORKDIR) || !is_relative_to(path, TASKS_ROOT)) throw new ValueError(`Invalid task ID: ${repr(task_id)}`);
  return path;
}
export function create_task(subject: string, description = ''): Task {
  subject = subject.trim();
  if (!subject) throw new ValueError('Task subject cannot be empty');
  return task_store_lock(() => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const task = new Task(`task_${randomBytes(4).toString('hex')}`, subject, description, 'pending', null, []);
      try { writeFileSync(_task_path(task.id), json_pretty(task), { encoding: 'utf8', flag: 'wx' }); return task; }
      catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue; throw error; }
    }
    throw new Error('Could not allocate a unique task ID');
  });
}
export function _task_depends_on(task_id: string, target_id: string): boolean {
  const pending = [task_id]; const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === target_id) return true;
    if (visited.has(current)) continue;
    visited.add(current); pending.push(...load_task(current).blockedBy);
  }
  return false;
}
export function update_task(task_id: string, addBlockedBy: string[]): Task {
  if (!Array.isArray(addBlockedBy)) throw new ValueError('addBlockedBy must be a list of task IDs');
  return task_store_lock(() => {
    const task = load_task(task_id);
    if (task.status !== 'pending' || task.owner !== null) throw new ValueError(`Task ${task_id} dependencies can only be updated while pending and unowned`);
    const dependencies = [...new Set(addBlockedBy)];
    for (const dependency of dependencies) {
      if (dependency === task_id) throw new ValueError('Task cannot depend on itself');
      if (!existsSync(_task_path(dependency)) || !statSync(_task_path(dependency)).isFile()) throw new ValueError(`Dependency not found: ${dependency}`);
      if (!task.blockedBy.includes(dependency) && _task_depends_on(dependency, task_id)) throw new ValueError(`Dependency cycle detected: ${task_id} -> ${dependency}`);
    }
    task.blockedBy.push(...dependencies.filter((dependency) => !task.blockedBy.includes(dependency)));
    save_task(task); return task;
  });
}
export function save_task(task: Task): void {
  task_store_lock(() => {
    const path = _task_path(task.id); const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.0.tmp`);
    try { writeFileSync(temporary, json_pretty(task), 'utf8'); renameSync(temporary, path); }
    finally { rmSync(temporary, { force: true }); }
  });
}
export function load_task(task_id: string): Task {
  const data = JSON.parse(read_utf8(_task_path(task_id)));
  const required = ['id', 'subject', 'description', 'status', 'owner', 'blockedBy'];
  if (!data || typeof data !== 'object' || required.some((key) => !Object.hasOwn(data, key)) || Object.keys(data).some((key) => ![...required, 'worktree'].includes(key))) throw new TypeError('Invalid task record fields');
  const task = new Task(data.id, data.subject, data.description, data.status, data.owner, data.blockedBy, data.worktree);
  if (task.id !== task_id) throw new ValueError(`Task file ID does not match ${task_id}`);
  if (!['pending', 'in_progress', 'completed'].includes(task.status)) throw new ValueError(`Invalid task status: ${task.status}`);
  return task;
}
export function list_tasks(): Task[] {
  if (!existsSync(TASKS_DIR)) return [];
  if (!is_relative_to(TASKS_ROOT, WORKDIR)) throw new ValueError('Tasks directory escapes workspace');
  return python_glob('task_*.json', TASKS_DIR, true).sort().map((path) => load_task(basename(path, '.json')));
}
export function get_task(task_id: string): string { return json_pretty(load_task(task_id)); }
export function can_start(task_id: string): boolean {
  const task = load_task(task_id);
  for (const dep_id of task.blockedBy) {
    let dep_path: string; try { dep_path = _task_path(dep_id); } catch (error) { if (error instanceof ValueError) return false; throw error; }
    if (!existsSync(dep_path) || load_task(dep_id).status !== 'completed') return false;
  }
  return true;
}
export function _owner_in_progress(owner: string): Task | null { return list_tasks().find((task) => task.status === 'in_progress' && task.owner === owner) ?? null; }
export function _incomplete_dependencies(task: Task): string[] {
  const incomplete: string[] = [];
  for (const dep_id of task.blockedBy) {
    let dep_path: string;
    try { dep_path = _task_path(dep_id); } catch (error) { if (!(error instanceof ValueError)) throw error; incomplete.push(dep_id); continue; }
    if (!existsSync(dep_path) || load_task(dep_id).status !== 'completed') incomplete.push(dep_id);
  }
  return incomplete;
}
export function claim_task(task_id: string, owner = 'agent'): string {
  return task_store_lock(() => {
    const task = load_task(task_id);
    if (task.status !== 'pending') return `Task ${task_id} is ${task.status}, cannot claim`;
    if (task.owner) return `Task ${task_id} is already owned by ${task.owner}`;
    const assignment = teammate_assignments.get(owner);
    if (assignment) return `Owner ${owner} must finish the current work turn for ${assignment.task_id} before claiming another task`;
    const current = _owner_in_progress(owner);
    if (current) return `Owner ${owner} must complete ${current.id} before claiming another task`;
    if (!can_start(task_id)) return `Blocked by: ${python_str(_incomplete_dependencies(task))}`;
    const [cwd, error] = task_worktree_cwd(task);
    if (error) return `Cannot claim ${task_id}: ${error}`;
    task.owner = owner; task.status = 'in_progress'; save_task(task);
    teammate_assignments.set(owner, { task_id: task.id, cwd }); advance_assignment_version(owner);
    console.log(`  [claim] ${task.subject} -> in_progress (owner: ${owner})`);
    return `Claimed ${task.id} (${task.subject})`;
  });
}
export function complete_task(task_id: string, owner = 'agent'): string {
  return task_store_lock(() => {
    const task = load_task(task_id);
    if (task.status !== 'in_progress') return `Task ${task_id} is ${task.status}, cannot complete`;
    if (task.owner !== owner) return `Task ${task_id} is owned by ${task.owner}, not ${owner}; cannot complete`;
    const gate = plan_gates.get(owner) ?? 'not_required';
    if (['required', 'pending', 'rejected'].includes(gate)) return `Task ${task_id} cannot complete while plan status is ${gate}`;
    const assignment = teammate_assignments.get(owner);
    if (!assignment || assignment.task_id !== task.id) {
      const [cwd, error] = task_worktree_cwd(task);
      if (error) return `Task ${task_id} cannot complete: ${error}`;
      teammate_assignments.set(owner, { task_id: task.id, cwd });
    }
    task.status = 'completed'; save_task(task);
    const unblocked = list_tasks().filter((task) => task.status === 'pending' && task.blockedBy.length && can_start(task.id)).map((task) => task.subject);
    console.log(`  [complete] ${task.subject}`);
    let msg = `Completed ${task.id} (${task.subject})`;
    if (unblocked.length) { msg += `\nUnblocked: ${unblocked.join(', ')}`; console.log(`  [unblocked] ${unblocked.join(', ')}`); }
    return msg;
  });
}
// -- Task-bound Worktrees --
export const WORKTREES_DIR = resolve(WORKDIR, '.worktrees');
export const WORKTREES_ROOT = resolve_path(WORKTREES_DIR);
export const VALID_WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function validate_worktree_name(name: string): string | null {
  if (typeof name !== 'string' || name.length > 64 || !VALID_WORKTREE_NAME.test(name) || name.endsWith('\n')) return 'worktree name must be 1-64 letters, digits, dots, underscores, or dashes, and start with a letter or digit';
  if (name === '.' || name === '..' || name.includes('..')) return "worktree name cannot contain '..'";
  return null;
}
export function _worktree_path(name: string): string {
  const path = resolve_path(resolve(WORKTREES_DIR, name));
  if (!is_relative_to(WORKTREES_ROOT, WORKDIR) || !is_relative_to(path, WORKTREES_ROOT) || path === WORKTREES_ROOT) throw new ValueError(`Worktree path escapes directory: ${repr(name)}`);
  return path;
}
export function _worktree_branch(name: string): string { return `wt/${name}`; }
export function _run_git(args: string[], cwd: string | null = null): [boolean, string] {
  try {
    const result = spawnSync('git', args, { cwd: cwd || WORKDIR, encoding: 'utf8', timeout: 30000, maxBuffer: Infinity });
    if (result.error) return [false, `${result.error.name}: ${result.error.message}`];
    const output = (result.stdout + result.stderr).replace(/\r\n?/g, '\n').trim();
    return [result.status === 0, output || '(no output)'];
  } catch (error) { return [false, error_text(error)]; }
}
export function run_git(args: string[], cwd: string | null = null): [boolean, string] {
  const [ok, output] = _run_git(args, cwd); return [ok, char_slice(output, 0, 5000)];
}
export function _registered_worktrees(): [Map<string, Record<string, string>>, string | null] {
  const [ok, output] = _run_git(['worktree', 'list', '--porcelain']);
  if (!ok) return [new Map(), `cannot read Git worktree registry: ${output}`];
  const entries = new Map<string, Record<string, string>>(); let current: Record<string, string> = {};
  for (const line of [...output.split(/\r\n|[\n\r]/), '']) {
    if (!line) { if (current.worktree) entries.set(resolve_path(current.worktree), current); current = {}; continue; }
    const separator = line.indexOf(' '); const key = separator < 0 ? line : line.slice(0, separator);
    current[key] = separator < 0 ? '' : line.slice(separator + 1);
  }
  return [entries, null];
}
export function _registered_worktree(name: string): [string | null, string | null] {
  let path: string; try { path = _worktree_path(name); } catch (error) { if (!(error instanceof ValueError)) throw error; return [null, error.message]; }
  const [entries, error] = _registered_worktrees(); if (error) return [null, error];
  if (!entries.has(path)) return [null, `worktree '${name}' is not registered with Git`];
  if (!existsSync(path) || !statSync(path).isDirectory()) return [null, `worktree '${name}' is missing at ${path}`];
  if (entries.get(path)!.branch !== `refs/heads/${_worktree_branch(name)}`) return [null, `worktree '${name}' is not registered on expected branch '${_worktree_branch(name)}'`];
  return [path, null];
}
export function task_worktree_cwd(task: Task): [string, string | null] {
  if (!task.worktree) return [WORKDIR, null];
  const [path, error] = _registered_worktree(task.worktree); return [path || WORKDIR, error];
}
export function assignment_cwd(owner: string): string {
  let assignment = teammate_assignments.get(owner); let task = _owner_in_progress(owner);
  if (task && (!assignment || assignment.task_id !== task.id)) {
    const [cwd, error] = task_worktree_cwd(task); if (error) throw new ValueError(error);
    assignment = { task_id: task.id, cwd }; teammate_assignments.set(owner, assignment);
  } else if (!assignment) return WORKDIR;
  task = load_task(assignment!.task_id);
  if (!['in_progress', 'completed'].includes(task.status) || task.owner !== owner) throw new ValueError(`Assignment for ${owner} is no longer active`);
  const [cwd, error] = task_worktree_cwd(task); if (error) throw new ValueError(error);
  if (resolve_path(cwd) !== resolve_path(assignment!.cwd)) throw new ValueError(`Assignment cwd changed for task ${task.id}`);
  return cwd;
}
export function release_completed_assignment(owner: string): boolean {
  const assignment = teammate_assignments.get(owner); if (!assignment) return false;
  const task = load_task(assignment.task_id); if (task.status !== 'completed' || task.owner !== owner) return false;
  teammate_assignments.delete(owner); advance_assignment_version(owner);
  if (plan_gates.has(owner)) plan_gates.set(owner, 'not_required');
  return true;
}
export function release_teammate_assignment(owner: string): void {
  try { const task = _owner_in_progress(owner); if (task) { task.status = 'pending'; task.owner = null; save_task(task); } }
  finally { teammate_assignments.delete(owner); advance_assignment_version(owner); if (plan_gates.has(owner)) plan_gates.set(owner, 'not_required'); }
}
export function create_worktree(name: string, task_id: string): string {
  const error = validate_worktree_name(name); if (error) return `Error: ${error}`;
  let path: string; let task_path: string;
  try { path = _worktree_path(name); task_path = _task_path(task_id); }
  catch (error) { if (!(error instanceof ValueError)) throw error; return `Error: ${error.message}`; }
  const branch = _worktree_branch(name);
  if (!existsSync(task_path)) return `Error: Task ${task_id} not found`;
  const task = load_task(task_id);
  if (task.status !== 'pending' || task.owner !== null) return `Error: Task ${task_id} must be pending and unowned`;
  if (task.worktree) return `Error: Task ${task_id} already uses worktree '${task.worktree}'`;
  if (list_tasks().some((other) => other.id !== task_id && other.worktree === name)) return `Error: Worktree '${name}' is already bound to another task`;
  if (existsSync(path)) return `Error: Worktree path already exists: ${path}`;
  const [root_ok, root] = run_git(['rev-parse', '--show-toplevel']);
  if (!root_ok || resolve_path(root) !== WORKDIR) return 'Error: Working directory must be the root of a Git repository';
  const [branch_ok, branch_check] = run_git(['check-ref-format', '--branch', branch]);
  if (!branch_ok) return `Error: Invalid worktree branch '${branch}': ${branch_check}`;
  const [exists] = run_git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (exists) return `Error: Branch '${branch}' already exists`;
  const [entries, registry_error] = _registered_worktrees(); if (registry_error) return `Error: ${registry_error}`;
  if (entries.has(path)) return `Error: Worktree path is already registered: ${path}`;
  mkdirSync(WORKTREES_DIR, { recursive: true });
  const [ok, result] = run_git(['worktree', 'add', '-b', branch, path, 'HEAD']);
  if (!ok) {
    const [entries, registry_error] = _registered_worktrees(); const [branch_exists] = run_git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    const artifacts: string[] = [];
    if (existsSync(path)) artifacts.push(`checkout path '${path}'`);
    if (!registry_error && entries.has(path)) artifacts.push('registered Git worktree');
    if (branch_exists) artifacts.push(`branch '${branch}'`);
    if (artifacts.length) return `Partial operation: git worktree add reported an error after leaving ${artifacts.join(', ')}. Task ${task_id} remains unbound and no Git data was deleted. Run \`git worktree list\`, inspect '${path}' and '${branch}', then keep or remove those artifacts manually after preserving any work. Git error: ${result}`;
    return `Git error: ${result}`;
  }
  try { task.worktree = name; save_task(task); }
  catch (error) { return `Partial success: Worktree '${name}' was created at ${path} on branch '${branch}', but task binding failed: ${error instanceof Error ? error.message : String(error)}. Git data was retained for manual recovery.`; }
  console.log(`  \x1b[33m[worktree] created: ${name} at ${path}\x1b[0m`);
  return `Worktree '${name}' created at ${path} for task ${task_id}`;
}
export function remove_worktree(name: string, discard_changes = false): string {
  const name_error = validate_worktree_name(name); if (name_error) return `Error: ${name_error}`;
  const [path, error] = _registered_worktree(name); if (error) return `Error: ${error}`;
  const bound = list_tasks().filter((task) => task.worktree === name);
  if (!bound.length) return `Error: Worktree '${name}' is not bound to a task`;
  const active = bound.filter((task) => task.status !== 'completed');
  if (active.length) return `Error: Worktree '${name}' is bound to active task ${active[0].id}; complete it before removal`;
  const leased = [...teammate_assignments].filter(([, assignment]) => resolve_path(assignment.cwd) === resolve_path(path!)).map(([owner]) => owner);
  if (leased.length) return `Error: Worktree '${name}' is still in use by ${leased.sort().join(', ')}; wait for the turn to end`;
  const [status_ok, status] = run_git(['status', '--porcelain', '--ignored'], path);
  if (!status_ok) return `Error: Cannot verify worktree '${name}' status: ${status}`;
  if (status !== '(no output)' && !discard_changes) {
    const changed = status.split(/\r\n|[\n\r]/).filter((line) => line.trim()).length;
    return `Error: Worktree '${name}' has ${changed} uncommitted change(s); preserve or discard them manually`;
  }
  const args = ['worktree', 'remove']; if (discard_changes) args.push('--force'); args.push(path!);
  const [ok, result] = run_git(args); if (!ok) return `Git error: ${result}`;
  try { for (const task of bound) { task.worktree = null; save_task(task); } }
  catch (error) { return `Partial success: Worktree '${name}' was removed and branch '${_worktree_branch(name)}' retained, but task unbinding failed: ${error instanceof Error ? error.message : String(error)}. Manual recovery is required.`; }
  console.log(`  [worktree] removed: ${name}; branch retained`);
  return `Worktree '${name}' removed; branch '${_worktree_branch(name)}' retained`;
}

// -- System Prompt --
const ENVIRONMENT_PROMPT = process.platform === 'win32'
  ? 'Windows: the bash tool runs through cmd.exe; use cmd.exe syntax, not Unix Bash or PowerShell syntax, and prefer dedicated file tools for file operations'
  : 'Unix-like: the bash tool runs the system shell';
const PROMPT_SECTIONS = {
  "identity": `You are a coding agent. Act, don't explain. Environment: ${ENVIRONMENT_PROMPT}.`,
  "tools": "Available tools: bash, read_file, write_file, edit_file, glob, create_task, update_task, list_tasks, get_task, claim_task, complete_task, spawn_teammate, list_teammates, send_message, request_shutdown, request_plan, review_plan, create_worktree.",
  "tasks": "Create all task nodes first. Only after create_task returns runtime-generated IDs, use update_task with those exact IDs to add dependencies. Only the Lead changes task dependencies.",
  "teams": "When parallel work would help, first propose a small team with clear responsibilities and wait for the user's confirmation. Do not call spawn_teammate before the user confirms. After confirmation, delegate independent work by creating a Task for each parallel change. Pass task_id to spawn_teammate when assigning ready work, then create a task-bound worktree only when a separate working directory would prevent conflicting edits. A teammate must complete its current Task before claiming another. A worktree changes tool default cwd only; it is not a sandbox. Worktree removal stays with the host or user. After spawning a teammate, end the current turn instead of polling its status; the runtime will deliver team events and wake the Lead. React to those events, and shut teammates down when coordination is complete.",
  "workspace": `Working directory: ${WORKDIR}`
};
export const SYSTEM = Object.values(PROMPT_SECTIONS).join("\n\n");
// -- Base Tools --
export function safe_path(p: string, cwd: string | null = null): string {
  const base = resolve_path(cwd || WORKDIR);
  const path = resolve_path(isAbsolute(p) ? p : base + sep + p);
  if (!is_relative_to(path, base)) throw new ValueError(`Path escapes workspace: ${p}`);
  return path;
}
export async function run_bash(command: string, cwd: string | null = null): Promise<string> {
  try {
    const child = spawn(command, { shell: true, cwd: cwd || WORKDIR, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let timed_out = false;
    child.stdout!.on('data', (data: Buffer) => stdout.push(data)); child.stderr!.on('data', (data: Buffer) => stderr.push(data));
    return await new Promise<string>((done) => {
      const timer = setTimeout(() => { timed_out = true; child.kill(); }, 120000);
      child.once('error', (error) => { clearTimeout(timer); done(`Error: ${error_text(error)}`); });
      child.once('close', (code, signal) => {
        clearTimeout(timer); if (timed_out) { done('Error: Timeout (120s)'); return; }
        const output = (Buffer.concat(stdout).toString('utf8') + Buffer.concat(stderr).toString('utf8')).replace(/\r\n?/g, '\n').trim();
        const shown = output ? char_slice(output, 0, 50000) : '(no output)';
        const returncode = code ?? (signal ? -(os_constants.signals[signal] ?? 1) : 0);
        done(returncode ? `Error: command exited with status ${returncode}\n${shown}` : shown);
      });
    });
  } catch (error) { return `Error: ${error_text(error)}`; }
}
export function run_read(path: string, limit?: number | null, cwd: string | null = null): string {
  try {
    let lines = read_utf8(safe_path(path, cwd)).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    if (lines.at(-1) === '') lines.pop();
    if (limit) {
      if (typeof limit !== 'number' && typeof limit !== 'boolean') throw new TypeError("'<' not supported between instances of 'str' and 'int'");
      if (Number(limit) < lines.length) {
        if (!Number.isInteger(Number(limit))) throw new TypeError('slice indices must be integers or None or have an __index__ method');
        lines = [...lines.slice(0, Number(limit)), `... (${lines.length - Number(limit)} more lines)`];
      }
    }
    return lines.join('\n');
  } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
}
export function run_write(path: string, content: string, cwd: string | null = null): string {
  try { const fp = safe_path(path, cwd); mkdirSync(dirname(fp), { recursive: true }); writeFileSync(fp, content, 'utf8'); return `Wrote ${Array.from(content).length} bytes to ${path}`; }
  catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
}
export function run_edit(path: string, old_text: string, new_text: string, cwd: string | null = null): string {
  try {
    const target = safe_path(path, cwd); const content = read_utf8(target);
    if (typeof old_text !== 'string') throw new TypeError('old_text must be a string'); const count = old_text === '' ? Array.from(content).length + 1 : content.split(old_text).length - 1;
    if (count !== 1) return `Error: Expected 1 occurrence, found ${count}`;
    if (typeof new_text !== 'string') throw new TypeError('new_text must be a string'); writeFileSync(target, content.replace(old_text, () => new_text), 'utf8'); return `Edited ${path}`;
  } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
}
// pathlib.glob includes hidden entries and does not recursively follow directory symlinks.
export function run_glob(pattern: string, cwd: string | null = null): string {
  try {
    const base = resolve_path(cwd || WORKDIR);
    const matches = python_glob(pattern, base, true).filter((path) => is_relative_to(resolve_path(base + sep + path), base)).sort();
    const shown = matches.slice(0, 200); if (matches.length > 200) shown.push('... (more matches omitted; narrow the pattern)');
    return shown.join('\n') || 'No files found';
  } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
}
export function _agent_cwd(): [string | null, string | null] {
  try { return [assignment_cwd('agent'), null]; }
  catch (error) { if (!(error instanceof ValueError) && !is_file_not_found(error)) throw error; return [null, `Error: Invalid task assignment: ${error instanceof Error ? error.message : String(error)}`]; }
}
export async function run_agent_bash(command: string): Promise<string> { const [cwd, error] = _agent_cwd(); return error || await run_bash(command, cwd); }
export function run_agent_read(path: string, limit?: number | null): string { const [cwd, error] = _agent_cwd(); return error || run_read(path, limit, cwd); }
export function run_agent_write(path: string, content: string): string { const [cwd, error] = _agent_cwd(); return error || run_write(path, content, cwd); }
export function run_agent_edit(path: string, old_text: string, new_text: string): string { const [cwd, error] = _agent_cwd(); return error || run_edit(path, old_text, new_text, cwd); }
export function run_agent_glob(pattern: string): string { const [cwd, error] = _agent_cwd(); return error || run_glob(pattern, cwd); }

// -- Task Tools --
export function run_create_task(subject: string, description = ''): string {
  const task = create_task(subject, description); console.log(`  \x1b[34m[create] ${task.subject}\x1b[0m`); return `Created ${task.id}: ${task.subject}`;
}
export function run_update_task(task_id: string, addBlockedBy: string[]): string {
  let task: Task;
  try { task = update_task(task_id, addBlockedBy); }
  catch (error) { if (error instanceof ValueError) return `Error: ${error.message}`; if (is_file_not_found(error)) return `Error: Task ${task_id} not found`; throw error; }
  const dependencies = task.blockedBy.join(', ') || '(none)';
  console.log(`  \x1b[34m[update] ${task.subject} blockedBy: ${dependencies}\x1b[0m`); return `Updated ${task.id} blockedBy: ${dependencies}`;
}
export function run_list_tasks(): string {
  const tasks = list_tasks(); if (!tasks.length) return 'No tasks. Use create_task to add some.';
  return tasks.map((task) => {
    const icon = ({ pending: '[ ]', in_progress: '[~]', completed: '[x]' } as Record<string, string>)[task.status] ?? '[?]';
    const deps = task.blockedBy.length ? ` (blockedBy: ${task.blockedBy.join(', ')})` : '';
    const owner = task.owner ? ` [${task.owner}]` : ''; const worktree = task.worktree ? ` (worktree: ${task.worktree})` : '';
    return `  ${icon} ${task.id}: ${task.subject} [${task.status}]${owner}${deps}${worktree}`;
  }).join('\n');
}
export function run_get_task(task_id: string): string {
  try { return get_task(task_id); } catch (error) { if (error instanceof ValueError) return `Error: ${error.message}`; if (is_file_not_found(error)) return `Error: Task ${task_id} not found`; throw error; }
}
export function run_claim_task(task_id: string): string {
  try { return claim_task(task_id, 'agent'); } catch (error) { if (error instanceof ValueError) return `Error: ${error.message}`; if (is_file_not_found(error)) return `Error: Task ${task_id} not found`; throw error; }
}
export function run_complete_task(task_id: string): string {
  try { return complete_task(task_id, 'agent'); } catch (error) { if (error instanceof ValueError) return `Error: ${error.message}`; if (is_file_not_found(error)) return `Error: Task ${task_id} not found`; throw error; }
}
// -- MessageBus and Team Protocols --
export const MAILBOX_DIR = resolve(WORKDIR, '.mailboxes');
export const MAILBOX_ROOT = resolve_path(MAILBOX_DIR);
export const VALID_AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
export const RESERVED_TEAMMATE_NAMES = new Set(['lead', 'agent']);
export function is_valid_agent_name(name: string): boolean { return typeof name === 'string' && name.length <= 64 && !name.endsWith('\n') && VALID_AGENT_NAME.test(name); }
export interface Envelope { from: string; to: string; content: string; type: string; ts: number; metadata: Record<string, unknown> }
export class MessageBus {
  readonly _changed = new EventEmitter();
  _path(agent: string): string {
    if (!is_valid_agent_name(agent)) throw new ValueError(`Invalid mailbox recipient: ${repr(agent)}`);
    const path = resolve_path(resolve(MAILBOX_DIR, `${agent}.jsonl`));
    if (!is_relative_to(path, MAILBOX_ROOT)) throw new ValueError(`Mailbox path escapes directory: ${repr(agent)}`);
    return path;
  }
  _read_unlocked(agent: string): Envelope[] {
    const inbox = this._path(agent); if (!existsSync(inbox)) return [];
    const msgs = read_utf8(inbox).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Envelope);
    unlinkSync(inbox); return msgs;
  }
  send(from_agent: string, to_agent: string, content: string, msg_type = 'message', metadata: Record<string, unknown> | null = null): void {
    const msg: Envelope = { from: from_agent, to: to_agent, content, type: msg_type, ts: Date.now() / 1000, metadata: metadata || {} };
    mkdirSync(MAILBOX_DIR, { recursive: true });
    appendFileSync(this._path(to_agent), json_dump(msg, true) + '\n', 'utf8');
    this._changed.emit('changed');
    console.log(`  [bus] ${from_agent} -> ${to_agent}: (${msg_type}) ${char_slice(content, 0, 50)}`);
  }
  read_inbox(agent: string): Envelope[] { return this._read_unlocked(agent); }
  peek(agent: string): boolean { const inbox = this._path(agent); return existsSync(inbox) && statSync(inbox).size > 0; }
  async wait_for_messages(agent: string, timeout: number | null = null): Promise<Envelope[]> {
    const deadline = timeout === null ? null : performance.now() + timeout * 1000;
    while (!this.peek(agent)) {
      const remaining = deadline === null ? null : deadline - performance.now();
      if (remaining !== null && remaining <= 0) return [];
      await new Promise<void>((done) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const wake = () => { clearTimeout(timer); this._changed.removeListener('changed', wake); done(); };
        this._changed.once('changed', wake);
        if (remaining !== null) { timer = setTimeout(wake, remaining); timer.unref(); }
      });
    }
    return this._read_unlocked(agent);
  }
}
export const BUS = new MessageBus();
export const active_teammates = new Map<string, string>();
export const plan_gates = new Map<string, string>();
export const plan_request_ids = new Map<string, string>();
export class ProtocolState {
  constructor(public request_id: string, public type: string, public sender: string, public target: string,
    public status: string, public payload: string, public work_version: number | null = null, public task_id: string | null = null,
    public created_at = Date.now() / 1000) {}
}
export const pending_requests = new Map<string, ProtocolState>();
export function new_request_id(): string {
  while (true) { const request_id = `req_${String(Math.floor(Math.random() * 1000000)).padStart(6, '0')}`; if (!pending_requests.has(request_id)) return request_id; }
}
export function match_response(response_type: string, request_id: string, approve: boolean, from_agent: string, to_agent: string): boolean {
  const state = pending_requests.get(request_id);
  if (!state) { console.log(`  [protocol] unknown request_id: ${request_id}`); return false; }
  const expected = ({ shutdown: 'shutdown_response', plan_approval: 'plan_approval_response' } as Record<string, string>)[state.type];
  if (!expected) throw new Error(`Unknown protocol type: ${state.type}`);
  if (response_type !== expected) { console.log(`  [protocol] expected ${expected}, got ${response_type}`); return false; }
  if (from_agent !== state.target || to_agent !== state.sender) { console.log(`  [protocol] ${request_id} responder mismatch`); return false; }
  if (state.status !== 'pending') { console.log(`  [protocol] ${request_id} already ${state.status}`); return false; }
  state.status = approve ? 'approved' : 'rejected'; console.log(`  [protocol] ${request_id} -> ${state.status}`); return true;
}
export function consume_lead_inbox(): Envelope[] {
  const msgs = BUS.read_inbox('lead');
  for (const msg of msgs) {
    const metadata = msg.metadata ?? {}; const request_id = (metadata.request_id ?? '') as string;
    if (request_id && (msg.type ?? '').endsWith('_response')) match_response(msg.type, request_id, (metadata.approve ?? false) as boolean, msg.from ?? '', msg.to ?? '');
  }
  return msgs;
}
export function format_team_events(msgs: Envelope[]): string {
  const lines = msgs.map((msg) => { const request_id = msg.metadata?.request_id; const suffix = request_id ? ` request_id=${request_id}` : ''; return `[${msg.type}${suffix}] ${msg.from}: ${msg.content}`; });
  return '[Team events]\n' + lines.join('\n');
}
export function _last_assistant_text(content: unknown): string {
  if (!Array.isArray(content)) return '';
  for (const block of content) if (block?.type === 'text') return python_str(block.text ?? '').trim();
  return '';
}
export function current_work_identity(owner: string): [number, string | null] {
  const assignment = teammate_assignments.get(owner); return [assignment_versions.get(owner) ?? 0, assignment?.task_id ?? null];
}
export function _teammate_submit_plan(from_name: string, plan: string): string {
  const assignment = teammate_assignments.get(from_name); const task_id = assignment?.task_id ?? null;
  const work_version = assignment_versions.get(from_name) ?? 0;
  if (plan_gates.get(from_name) === 'pending') return 'A plan is already waiting for review.';
  const request_id = new_request_id();
  pending_requests.set(request_id, new ProtocolState(request_id, 'plan_approval', from_name, 'lead', 'pending', plan, work_version, task_id));
  plan_gates.set(from_name, 'pending'); plan_request_ids.set(from_name, request_id); active_teammates.set(from_name, 'waiting_approval');
  BUS.send(from_name, 'lead', plan, 'plan_approval_request', { request_id });
  return `Plan submitted (${request_id}). Wait for Lead's decision.`;
}
export async function _run_teammate_tool(name: string, block: ToolCall, handlers: Record<string, Handler>): Promise<string> {
  const gate = plan_gates.get(name) ?? 'not_required';
  if (['bash', 'write_file', 'edit_file'].includes(block.name)) {
    if (gate !== 'approved' && gate !== 'not_required') return `Blocked: plan status is ${gate}. Submit or revise the plan and wait for approval before changing the workspace.`;
    const blocked = await check_permission(block, false); if (blocked) return blocked;
  }
  const handler = Object.hasOwn(handlers, block.name) ? handlers[block.name] : undefined;
  if (!handler) return `Unknown tool: ${block.name}`;
  // Python skips only the permission callback, then ignores other PreToolUse results here.
  await trigger_hooks('PreToolUse', [block], true);
  let output: string;
  try { output = python_str(await handler(block.input as ToolInput)); } catch (error) { output = `Error: ${error_text(error)}`; }
  await trigger_hooks('PostToolUse', [block, output]); return output;
}
export function apply_plan_response(name: string, msg: Envelope): [boolean, string] {
  const metadata = msg.metadata ?? {}; const request_id = (metadata.request_id ?? '') as string;
  const [work_version, task_id] = current_work_identity(name); const state = pending_requests.get(request_id);
  const valid = msg.from === 'lead' && msg.to === name && request_id === plan_request_ids.get(name) && state
    && state.type === 'plan_approval' && state.sender === name && state.target === 'lead'
    && state.work_version === work_version && state.task_id === task_id && ['approved', 'rejected'].includes(state.status)
    && (metadata.approve ?? false) === (state.status === 'approved');
  if (!valid) return [false, '[Ignored plan response: request mismatch]'];
  plan_gates.set(name, state.status); active_teammates.set(name, 'working'); plan_request_ids.delete(name);
  return [true, `[Plan ${state.status}] ${msg.content}`];
}
export function apply_shutdown_request(name: string, msg: Envelope): [boolean, string] {
  const request_id = (msg.metadata?.request_id ?? '') as string; const state = pending_requests.get(request_id);
  const valid = msg.from === 'lead' && msg.to === name && state && state.type === 'shutdown'
    && state.sender === 'lead' && state.target === name && state.status === 'pending' && active_teammates.get(name) !== 'stopping';
  if (!valid) return [false, '[Ignored shutdown request: request mismatch]'];
  active_teammates.set(name, 'stopping'); return [true, request_id];
}
export function _teammate_send_message(from_name: string, to: string, content: string): string {
  if (to !== 'lead' && !active_teammates.has(to)) return `Agent '${to}' is not active`;
  BUS.send(from_name, to, content); return `Sent to ${to}`;
}

// -- Idle Task Discovery --
export const IDLE_SCAN_INTERVAL = 2.0;
export function scan_unclaimed_tasks(): Task[] {
  const ready: Task[] = [];
  for (const task of list_tasks()) {
    if (task.status !== 'pending' || task.owner !== null || !can_start(task.id)) continue;
    const [, error] = task_worktree_cwd(task); if (!error) ready.push(task);
  }
  return ready;
}
export function claim_next_task(name: string): Task | null {
  if (teammate_assignments.get(name) || _owner_in_progress(name)) return null;
  for (const task of scan_unclaimed_tasks()) { if (claim_task(task.id, name).startsWith('Claimed ')) return load_task(task.id); }
  return null;
}
// -- Teammate Runtime --
export class TeammateRuntime {
  system: string;
  messages: Anthropic.MessageParam[];
  handlers: Record<string, Handler>;
  constructor(public name: string, role: string, prompt: string, task_id: string | null, require_plan: boolean) {
    this.system = `You are '${name}', a ${role}. Use tools to complete the assigned `
      + 'Task, then call complete_task and report a concise result. '
      + 'If the first user message contains [Assigned task], that Task is already claimed; do not call claim_task for it again. '
      + 'When asked for a plan, call submit_plan and wait for approval before bash or file changes. File and shell tools use the Task\'s '
      + 'working directory; that directory is not a sandbox. The runtime delivers your final text to Lead. Use send_message only for '
      + "intermediate coordination, and address the coordinator as 'lead'.";
    this.messages = [{ role: 'user', content: prompt }];
    if (task_id) {
      const task = load_task(task_id); const cwd = assignment_cwd(name);
      this.messages[0].content += `\n\n[Assigned task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`;
    }
    if (require_plan) this.messages[0].content += '\n\n[Plan required] Submit a plan and wait for Lead approval before changing files or using bash.';
    this.handlers = {
      bash: (input: Record<string, unknown>) => (bind_kwargs(input, ["command"], ["command"], "bash"), this.bash(input.command as string)),
      read_file: (input: Record<string, unknown>) => (bind_kwargs(input, ["path","limit"], ["path"], "read"), this.read(input.path as string, input.limit as number | undefined)),
      write_file: (input: Record<string, unknown>) => (bind_kwargs(input, ["path","content"], ["path","content"], "write"), this.write(input.path as string, input.content as string)),
      edit_file: (input: Record<string, unknown>) => (bind_kwargs(input, ["path","old_text","new_text"], ["path","old_text","new_text"], "edit"), this.edit(input.path as string, input.old_text as string, input.new_text as string)),
      glob: (input: Record<string, unknown>) => (bind_kwargs(input, ["pattern"], ["pattern"], "glob"), this.glob(input.pattern as string)),
      send_message: (input: Record<string, unknown>) => (bind_kwargs(input, ["to","content"], ["to","content"], "<lambda>"), _teammate_send_message(name, input.to as string, input.content as string)),
      submit_plan: (input: Record<string, unknown>) => (bind_kwargs(input, ["plan"], ["plan"], "<lambda>"), _teammate_submit_plan(name, input.plan as string)),
      list_tasks: (input: Record<string, unknown>) => (bind_kwargs(input, [], [], "run_list_tasks"), run_list_tasks()), claim_task: (input: Record<string, unknown>) => (bind_kwargs(input, ["task_id"], ["task_id"], "claim"), this.claim(input.task_id as string)), complete_task: (input: Record<string, unknown>) => (bind_kwargs(input, ["task_id"], ["task_id"], "complete"), this.complete(input.task_id as string)),
    };
  }
  current_cwd(): [string | null, string | null] {
    if (!teammate_assignments.has(this.name)) return [null, 'Error: Claim a Task before using workspace tools.'];
    try { return [assignment_cwd(this.name), null]; }
    catch (error) { if (!(error instanceof ValueError) && !is_file_not_found(error)) throw error; return [null, `Error: Invalid task assignment: ${error instanceof Error ? error.message : String(error)}`]; }
  }
  async bash(command: string): Promise<string> { const [cwd, error] = this.current_cwd(); return error || await run_bash(command, cwd); }
  read(path: string, limit?: number | null): string { const [cwd, error] = this.current_cwd(); return error || run_read(path, limit, cwd); }
  write(path: string, content: string): string { const [cwd, error] = this.current_cwd(); return error || run_write(path, content, cwd); }
  edit(path: string, old_text: string, new_text: string): string { const [cwd, error] = this.current_cwd(); return error || run_edit(path, old_text, new_text, cwd); }
  glob(pattern: string): string { const [cwd, error] = this.current_cwd(); return error || run_glob(pattern, cwd); }
  claim(task_id: string): string {
    try { return claim_task(task_id, this.name); } catch (error) { if (error instanceof ValueError) return `Error: ${error.message}`; if (is_file_not_found(error)) return `Error: Task ${task_id} not found`; throw error; }
  }
  complete(task_id: string): string {
    try { return complete_task(task_id, this.name); } catch (error) { if (error instanceof ValueError) return `Error: ${error.message}`; if (is_file_not_found(error)) return `Error: Task ${task_id} not found`; throw error; }
  }
  handle_inbox(inbox: Envelope[]): boolean {
    const work_messages: string[] = [];
    for (const msg of inbox) {
      const msg_type = msg.type ?? 'message';
      if (msg_type === 'shutdown_request') {
        const [accepted, notice] = apply_shutdown_request(this.name, msg);
        if (!accepted) { work_messages.push(notice); continue; }
        BUS.send(this.name, 'lead', 'Shutdown acknowledged.', 'shutdown_response', { request_id: notice, approve: true }); return true;
      }
      if (msg_type === 'plan_approval_response') { const [, notice] = apply_plan_response(this.name, msg); work_messages.push(notice); continue; }
      if (msg_type === 'plan_request') { work_messages.push(`[Plan required] ${msg.content}`); continue; }
      work_messages.push(`[Message from ${msg.from}] ${msg.content}`);
    }
    if (work_messages.length) this.messages.push({ role: 'user', content: work_messages.join('\n') });
    return false;
  }
  async work(): Promise<'continue' | 'idle' | 'stop'> {
    if (this.handle_inbox(BUS.read_inbox(this.name))) return 'stop';
    active_teammates.set(this.name, 'working');
    let response: Anthropic.Message;
    try { response = await client.messages.create({ model: MODEL, system: this.system, messages: this.messages, tools: TEAMMATE_TOOLS, max_tokens: 8000 }); }
    catch (error) { BUS.send(this.name, 'lead', error_text(error), 'error'); return 'stop'; }
    this.messages.push({ role: 'assistant', content: response.content });
    const tool_calls = response.content.filter((block) => block.type === 'tool_use');
    if (tool_calls.length) {
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of tool_calls) results.push({ type: 'tool_result', tool_use_id: block.id, content: await _run_teammate_tool(this.name, block, this.handlers) });
      this.messages.push({ role: 'user', content: results }); return 'continue';
    }
    const summary = _last_assistant_text(response.content); const gate = plan_gates.get(this.name) ?? 'not_required';
    if (gate !== 'pending' && summary) BUS.send(this.name, 'lead', summary, 'result');
    if (gate === 'pending') active_teammates.set(this.name, 'waiting_approval');
    else { release_completed_assignment(this.name); active_teammates.set(this.name, 'idle'); BUS.send(this.name, 'lead', 'Waiting for more work.', 'idle_notification'); }
    return 'idle';
  }
  async wait_for_work(): Promise<boolean> {
    while (true) {
      const inbox = await BUS.wait_for_messages(this.name, IDLE_SCAN_INTERVAL);
      if (inbox.length) {
        const before = this.messages.length; if (this.handle_inbox(inbox)) return false;
        if (this.messages.length > before) return true;
        continue;
      }
      const task = claim_next_task(this.name); if (!task) continue;
      const cwd = assignment_cwd(this.name);
      this.messages.push({ role: 'user', content: `[Auto-claimed task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}` });
      console.log(`  [idle] ${this.name} claimed ${task.id}: ${task.subject}`); return true;
    }
  }
  async run(): Promise<void> {
    try {
      let state: 'continue' | 'idle' | 'stop' = 'continue';
      while (state !== 'stop') { if (state === 'idle' && !await this.wait_for_work()) break; state = await this.work(); }
    } catch (error) { try { BUS.send(this.name, 'lead', error_text(error), 'error'); } catch { /* match Python's cleanup boundary */ } }
    finally {
      try { release_teammate_assignment(this.name); }
      catch (error) { try { BUS.send(this.name, 'lead', `Assignment cleanup failed: ${error_text(error)}`, 'error'); } catch { /* no further recovery */ } }
      active_teammates.delete(this.name); plan_gates.delete(this.name); plan_request_ids.delete(this.name); teammate_threads.delete(this.name);
      console.log(`  [teammate] ${this.name} finished`);
    }
  }
}
export const teammate_threads = new Map<string, Promise<void>>();
export function spawn_teammate_thread(name: string, role: string, prompt: string, task_id: string | null = null, require_plan = false): string {
  if (!is_valid_agent_name(name)) return 'Invalid teammate name: use 1-64 letters, digits, underscores, or dashes';
  if (RESERVED_TEAMMATE_NAMES.has(name.toLowerCase())) return `Invalid teammate name: '${name}' is reserved by the runtime`;
  if ([...active_teammates.keys()].some((existing) => existing.toLowerCase() === name.toLowerCase())) return `Teammate '${name}' already exists`;
  active_teammates.set(name, 'working'); plan_gates.set(name, require_plan ? 'required' : 'not_required'); assignment_versions.set(name, 0);
  if (task_id) {
    let claimed: string;
    try { claimed = claim_task(task_id, name); }
    catch (error) { if (!(error instanceof ValueError) && !is_file_not_found(error)) throw error; claimed = `Error: ${error instanceof Error ? error.message : String(error)}`; }
    if (!claimed.startsWith('Claimed ')) { active_teammates.delete(name); plan_gates.delete(name); assignment_versions.delete(name); return `Cannot spawn teammate '${name}': ${claimed}`; }
  }
  const runtime = new TeammateRuntime(name, role, prompt, task_id, require_plan);
  const thread = Promise.resolve().then(() => runtime.run()); teammate_threads.set(name, thread);
  console.log(`  [teammate] ${name} spawned as ${role}`);
  const assigned = task_id ? ` for ${task_id}` : ' without an initial Task';
  return `Teammate '${name}' spawned as ${role}${assigned}. End this turn; the runtime will deliver its events.`;
}

// -- Lead Team Tools --
export function run_spawn_teammate(name: string, role: string, prompt: string, task_id: string | null = null, require_plan = false): string { return spawn_teammate_thread(name, role, prompt, task_id, require_plan); }
export function run_list_teammates(): string { return active_teammates.size ? [...active_teammates].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, status]) => `${name}: ${status}`).join('\n') : 'No active teammates.'; }
export function run_send_message(to: string, content: string): string {
  if (!active_teammates.has(to)) return `Teammate '${to}' is not active`; BUS.send('lead', to, content); return `Sent to ${to}`;
}
export function run_request_shutdown(teammate: string): string {
  if (!active_teammates.has(teammate)) return `Teammate '${teammate}' is not active`;
  const request_id = new_request_id(); pending_requests.set(request_id, new ProtocolState(request_id, 'shutdown', 'lead', teammate, 'pending', ''));
  BUS.send('lead', teammate, 'Finish the current step and shut down.', 'shutdown_request', { request_id });
  return `Shutdown requested from ${teammate} (${request_id})`;
}
export function run_request_plan(teammate: string, task: string): string {
  if (!active_teammates.has(teammate)) return `Teammate '${teammate}' is not active`;
  plan_gates.set(teammate, 'required'); BUS.send('lead', teammate, task, 'plan_request'); return `Plan requested from ${teammate}`;
}
export function run_review_plan(request_id: string, approve: boolean, feedback = ''): string {
  const state = pending_requests.get(request_id); if (!state) return `Request ${request_id} not found`;
  const [work_version, task_id] = current_work_identity(state.sender);
  if (state.type !== 'plan_approval') return `Request ${request_id} is not a plan`;
  if (state.status !== 'pending') return `Request ${request_id} already ${state.status}`;
  if (state.work_version !== work_version || state.task_id !== task_id) return `Request ${request_id} belongs to an earlier assignment`;
  if (plan_request_ids.get(state.sender) !== request_id) return `Request ${request_id} is not the current plan`;
  state.status = approve ? 'approved' : 'rejected';
  const content = feedback || (approve ? 'Plan approved.' : 'Revise the plan and submit it again.');
  BUS.send('lead', state.sender, content, 'plan_approval_response', { request_id, approve }); return `Plan ${state.status} (${request_id})`;
}
export function run_create_worktree(name: string, task_id: string): string { return create_worktree(name, task_id); }

// -- Tool Definitions --
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
export const TASK_TOOLS: Anthropic.Tool[] = [
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
    "description": "List shared tasks.",
    "input_schema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "get_task",
    "description": "Get one task by ID.",
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
    "description": "Claim a ready task.",
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
    "description": "Complete an owned task.",
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
export const TEAMMATE_TOOLS: Anthropic.Tool[] = [
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
  },
  {
    "name": "send_message",
    "description": "Send an intermediate message to 'lead' or an active teammate.",
    "input_schema": {
      "type": "object",
      "properties": {
        "to": {
          "type": "string"
        },
        "content": {
          "type": "string"
        }
      },
      "required": [
        "to",
        "content"
      ]
    }
  },
  {
    "name": "submit_plan",
    "description": "Submit a work plan for Lead approval.",
    "input_schema": {
      "type": "object",
      "properties": {
        "plan": {
          "type": "string"
        }
      },
      "required": [
        "plan"
      ]
    }
  },
  {
    "name": "list_tasks",
    "description": "List shared tasks.",
    "input_schema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "claim_task",
    "description": "Claim a ready task.",
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
    "description": "Complete an owned task.",
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
export const TEAM_TOOLS: Anthropic.Tool[] = [
  {
    "name": "spawn_teammate",
    "description": "Spawn a persistent teammate.",
    "input_schema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{1,64}$"
        },
        "role": {
          "type": "string"
        },
        "prompt": {
          "type": "string"
        },
        "task_id": {
          "type": "string",
          "pattern": "^task_[0-9a-f]{8}$"
        },
        "require_plan": {
          "type": "boolean"
        }
      },
      "required": [
        "name",
        "role",
        "prompt"
      ]
    }
  },
  {
    "name": "list_teammates",
    "description": "List active teammates.",
    "input_schema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "send_message",
    "description": "Message a teammate.",
    "input_schema": {
      "type": "object",
      "properties": {
        "to": {
          "type": "string"
        },
        "content": {
          "type": "string"
        }
      },
      "required": [
        "to",
        "content"
      ]
    }
  },
  {
    "name": "request_shutdown",
    "description": "Ask a teammate to shut down.",
    "input_schema": {
      "type": "object",
      "properties": {
        "teammate": {
          "type": "string"
        }
      },
      "required": [
        "teammate"
      ]
    }
  },
  {
    "name": "request_plan",
    "description": "Require a teammate plan before workspace changes.",
    "input_schema": {
      "type": "object",
      "properties": {
        "teammate": {
          "type": "string"
        },
        "task": {
          "type": "string"
        }
      },
      "required": [
        "teammate",
        "task"
      ]
    }
  },
  {
    "name": "review_plan",
    "description": "Approve or reject a plan.",
    "input_schema": {
      "type": "object",
      "properties": {
        "request_id": {
          "type": "string"
        },
        "approve": {
          "type": "boolean"
        },
        "feedback": {
          "type": "string"
        }
      },
      "required": [
        "request_id",
        "approve"
      ]
    }
  },
  {
    "name": "create_worktree",
    "description": "Create and bind a task worktree.",
    "input_schema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
          "maxLength": 64
        },
        "task_id": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "task_id"
      ],
      "additionalProperties": false
    }
  }
];
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
    "description": "List shared tasks.",
    "input_schema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "get_task",
    "description": "Get one task by ID.",
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
    "description": "Claim a ready task.",
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
    "description": "Complete an owned task.",
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
    "name": "spawn_teammate",
    "description": "Spawn a persistent teammate.",
    "input_schema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[A-Za-z0-9_-]{1,64}$"
        },
        "role": {
          "type": "string"
        },
        "prompt": {
          "type": "string"
        },
        "task_id": {
          "type": "string",
          "pattern": "^task_[0-9a-f]{8}$"
        },
        "require_plan": {
          "type": "boolean"
        }
      },
      "required": [
        "name",
        "role",
        "prompt"
      ]
    }
  },
  {
    "name": "list_teammates",
    "description": "List active teammates.",
    "input_schema": {
      "type": "object",
      "properties": {}
    }
  },
  {
    "name": "send_message",
    "description": "Message a teammate.",
    "input_schema": {
      "type": "object",
      "properties": {
        "to": {
          "type": "string"
        },
        "content": {
          "type": "string"
        }
      },
      "required": [
        "to",
        "content"
      ]
    }
  },
  {
    "name": "request_shutdown",
    "description": "Ask a teammate to shut down.",
    "input_schema": {
      "type": "object",
      "properties": {
        "teammate": {
          "type": "string"
        }
      },
      "required": [
        "teammate"
      ]
    }
  },
  {
    "name": "request_plan",
    "description": "Require a teammate plan before workspace changes.",
    "input_schema": {
      "type": "object",
      "properties": {
        "teammate": {
          "type": "string"
        },
        "task": {
          "type": "string"
        }
      },
      "required": [
        "teammate",
        "task"
      ]
    }
  },
  {
    "name": "review_plan",
    "description": "Approve or reject a plan.",
    "input_schema": {
      "type": "object",
      "properties": {
        "request_id": {
          "type": "string"
        },
        "approve": {
          "type": "boolean"
        },
        "feedback": {
          "type": "string"
        }
      },
      "required": [
        "request_id",
        "approve"
      ]
    }
  },
  {
    "name": "create_worktree",
    "description": "Create and bind a task worktree.",
    "input_schema": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^(?!.*\\.\\.)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
          "maxLength": 64
        },
        "task_id": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "task_id"
      ],
      "additionalProperties": false
    }
  }
];
export const TOOL_HANDLERS: Record<string, Handler> = {
  bash: (i: Record<string, unknown>) => (bind_kwargs(i, ["command"], ["command"], "run_agent_bash"), run_agent_bash(i.command as string)), read_file: (i: Record<string, unknown>) => (bind_kwargs(i, ["path","limit"], ["path"], "run_agent_read"), run_agent_read(i.path as string, i.limit as number | undefined)),
  write_file: (i: Record<string, unknown>) => (bind_kwargs(i, ["path","content"], ["path","content"], "run_agent_write"), run_agent_write(i.path as string, i.content as string)), edit_file: (i: Record<string, unknown>) => (bind_kwargs(i, ["path","old_text","new_text"], ["path","old_text","new_text"], "run_agent_edit"), run_agent_edit(i.path as string, i.old_text as string, i.new_text as string)),
  glob: (i: Record<string, unknown>) => (bind_kwargs(i, ["pattern"], ["pattern"], "run_agent_glob"), run_agent_glob(i.pattern as string)), create_task: (i: Record<string, unknown>) => (bind_kwargs(i, ["subject","description"], ["subject"], "run_create_task"), run_create_task(i.subject as string, i.description as string | undefined)),
  update_task: (i: Record<string, unknown>) => (bind_kwargs(i, ["task_id","addBlockedBy"], ["task_id","addBlockedBy"], "run_update_task"), run_update_task(i.task_id as string, i.addBlockedBy as string[])), list_tasks: (input: Record<string, unknown>) => (bind_kwargs(input, [], [], "run_list_tasks"), run_list_tasks()), get_task: (i: Record<string, unknown>) => (bind_kwargs(i, ["task_id"], ["task_id"], "run_get_task"), run_get_task(i.task_id as string)),
  claim_task: (i: Record<string, unknown>) => (bind_kwargs(i, ["task_id"], ["task_id"], "run_claim_task"), run_claim_task(i.task_id as string)), complete_task: (i: Record<string, unknown>) => (bind_kwargs(i, ["task_id"], ["task_id"], "run_complete_task"), run_complete_task(i.task_id as string)),
  spawn_teammate: (i: Record<string, unknown>) => (bind_kwargs(i, ["name","role","prompt","task_id","require_plan"], ["name","role","prompt"], "run_spawn_teammate"), run_spawn_teammate(i.name as string, i.role as string, i.prompt as string, i.task_id as string | undefined, i.require_plan as boolean | undefined)),
  list_teammates: (input: Record<string, unknown>) => (bind_kwargs(input, [], [], "run_list_teammates"), run_list_teammates()), send_message: (i: Record<string, unknown>) => (bind_kwargs(i, ["to","content"], ["to","content"], "run_send_message"), run_send_message(i.to as string, i.content as string)),
  request_shutdown: (i: Record<string, unknown>) => (bind_kwargs(i, ["teammate"], ["teammate"], "run_request_shutdown"), run_request_shutdown(i.teammate as string)), request_plan: (i: Record<string, unknown>) => (bind_kwargs(i, ["teammate","task"], ["teammate","task"], "run_request_plan"), run_request_plan(i.teammate as string, i.task as string)),
  review_plan: (i: Record<string, unknown>) => (bind_kwargs(i, ["request_id","approve","feedback"], ["request_id","approve"], "run_review_plan"), run_review_plan(i.request_id as string, i.approve as boolean, i.feedback as string | undefined)),
  create_worktree: (i: Record<string, unknown>) => (bind_kwargs(i, ["name","task_id"], ["name","task_id"], "run_create_worktree"), run_create_worktree(i.name as string, i.task_id as string)),
};
// -- Hooks and Permission Checks --
type HookEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop';
// Hooks have Python-style variadic callback signatures.
type Hook = (...args: any[]) => unknown | Promise<unknown>;
export const HOOKS: Record<HookEvent, Hook[]> = { UserPromptSubmit: [], PreToolUse: [], PostToolUse: [], Stop: [] };
export const DENY_LIST = ['rm -rf /', 'sudo', 'shutdown', 'reboot', 'mkfs', 'dd if='];
export const DESTRUCTIVE_COMMAND_WORD = /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;
export const DESTRUCTIVE = ['rm ', '> /etc/', 'chmod 777'];
export function contains_destructive_command(command: string): boolean { return DESTRUCTIVE_COMMAND_WORD.test(command); }
export function register_hook(event: HookEvent, callback: Hook): void { HOOKS[event].push(callback); }
export async function trigger_hooks(event: HookEvent, args: unknown[] = [], skip_permission = false): Promise<unknown> {
  for (const callback of HOOKS[event]) {
    if (skip_permission && callback === permission_hook) continue;
    const result = await callback(...args); if (result !== null && result !== undefined) return result;
  }
  return null;
}
export async function check_permission(block: ToolCall, prompt_user = true): Promise<string | null> {
  const input = block.input as ToolInput;
  if (block.name === 'bash') {
    const command = ((Object.hasOwn(input, 'command') ? input.command : '')) as string;
    for (const pattern of DENY_LIST) if (command.includes(pattern)) return `Permission denied by deny list: ${pattern}`;
    if (contains_destructive_command(command) || DESTRUCTIVE.some((keyword) => command.includes(keyword))) {
      if (!prompt_user) return 'Permission required: ask Lead to run this command.';
      console.log(`\n[permission] ${block.name}(${python_str(input)})`);
      if (!['y', 'yes'].includes((await input_line('Allow? [y/N] ')).trim().toLowerCase())) return 'Permission denied by user';
    }
  }
  if (['read_file', 'write_file', 'edit_file'].includes(block.name)) {
    if (!is_relative_to(resolve_path(((Object.hasOwn(input, 'path') ? input.path : '')) as string), WORKDIR)) {
      if (!prompt_user) return 'Permission required: path is outside the workspace.';
      console.log(`\n[permission] ${block.name}(${python_str(input)})`);
      if (!['y', 'yes'].includes((await input_line('Allow? [y/N] ')).trim().toLowerCase())) return 'Permission denied by user';
    }
  }
  return null;
}
export async function permission_hook(block: ToolCall): Promise<string | null> { return check_permission(block, true); }
export function log_hook(block: ToolCall): null { const preview = char_slice(python_str(Object.values(block.input as ToolInput).slice(0, 2)), 0, 60); console.log(`[hook] ${block.name}(${preview})`); return null; }
export function large_output_hook(block: ToolCall, output: unknown): null {
  const length = Array.from(python_str(output)).length;
  if (length > 100000) console.log(`[hook] Large output from ${block.name}: ${length} chars`); return null;
}
export function context_hook(_query: string): null { console.log(`[hook] UserPromptSubmit: working in ${WORKDIR}`); return null; }
export function summary_hook(messages: Anthropic.MessageParam[]): null {
  const tool_count = messages.reduce((sum, message) => sum + (Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_result').length : 0), 0);
  console.log(`[hook] Stop: session used ${tool_count} tool calls`); return null;
}
register_hook('UserPromptSubmit', context_hook); register_hook('PreToolUse', permission_hook); register_hook('PreToolUse', log_hook);
register_hook('PostToolUse', large_output_hook); register_hook('Stop', summary_hook);
export async function execute_tool(block: ToolCall): Promise<string> {
  const blocked = await trigger_hooks('PreToolUse', [block]); if (blocked) return python_str(blocked);
  const handler = Object.hasOwn(TOOL_HANDLERS, block.name) ? TOOL_HANDLERS[block.name] : undefined;
  if (!handler) return `Unknown tool: ${block.name}`;
  let output: string; try { output = python_str(await handler(block.input as ToolInput)); } catch (error) { output = `Error: ${error_text(error)}`; }
  await trigger_hooks('PostToolUse', [block, output]); return output;
}

// -- Agent Loop --
export async function agent_loop(messages: Anthropic.MessageParam[], llm_client: ModelClient = client, model = MODEL): Promise<void> {
  while (true) {
    let response: Anthropic.Message;
    try { response = await llm_client.messages.create({ model, system: SYSTEM, messages, tools: TOOLS, max_tokens: 8000 }); }
    catch (error) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `[Error] ${error_text(error)}` }] });
      release_completed_assignment('agent'); await trigger_hooks('Stop', [messages]); return;
    }
    messages.push({ role: 'assistant', content: response.content });
    const tool_calls = response.content.filter((block) => block.type === 'tool_use');
    if (!tool_calls.length) { release_completed_assignment('agent'); await trigger_hooks('Stop', [messages]); return; }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of tool_calls) {
      console.log(`> ${block.name}`); const output = await execute_tool(block); console.log(char_slice(output, 0, 300));
      results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
    }
    messages.push({ role: 'user', content: results });
  }
}
export function print_last_assistant_message(history: Anthropic.MessageParam[]): void {
  if (!history.length) return;
  const content = history.at(-1)!.content;
  if (Array.isArray(content)) for (const block of content) if (block.type === 'text') console.log(block.text ?? '');
}

// readline events preserve typed lines while mailbox events wake the Lead.
let terminal: ReturnType<typeof createInterface> | undefined;
const lines: string[] = []; let input_closed = false;
const input_changed = new EventEmitter();
async function input_line(prompt: string): Promise<string> {
  if (!terminal) return 'n';
  process.stdout.write(prompt);
  while (!lines.length) {
    if (input_closed) throw new Error('EOF when reading a line');
    await new Promise<void>((done) => input_changed.once('changed', done));
  }
  return lines.shift()!;
}
export async function wait_for_cli_event(): Promise<['wake' | 'quit' | 'user', string | null]> {
  let prompt_visible = false;
  while (true) {
    if (BUS.peek('lead')) { if (prompt_visible) console.log(); return ['wake', null]; }
    if (!prompt_visible) { process.stdout.write('s13 >> '); prompt_visible = true; }
    if (lines.length) return ['user', lines.shift()!];
    if (input_closed) return ['quit', null];
    await new Promise<void>((done) => {
      const wake = () => { clearTimeout(timer); input_changed.removeListener('changed', wake); BUS._changed.removeListener('changed', wake); done(); };
      const timer = setTimeout(wake, 250);
      input_changed.once('changed', wake); BUS._changed.once('changed', wake);
    });
  }
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!MODEL) throw new Error('Missing MODEL_ID. Configure learn-claude-code-ts/.env first.');
  console.log('s13: agent teams'); console.log('Enter a question, press Enter to send. Type q to quit.\n');
  terminal = createInterface({ input: process.stdin, output: process.stdout });
  terminal.on('line', (line) => { lines.push(line); input_changed.emit('changed'); });
  terminal.on('close', () => { input_closed = true; input_changed.emit('changed'); });
  terminal.on('SIGINT', () => terminal?.close());
  process.once('SIGINT', () => terminal?.close());
  const history: Anthropic.MessageParam[] = []; let had_teammates = false;
  try {
    while (true) {
      const [kind, payload] = await wait_for_cli_event();
      if (kind === 'quit') break;
      if (kind === 'user') {
        if (payload === null || ['q', 'exit', ''].includes(payload.trim().toLowerCase())) break;
        await trigger_hooks('UserPromptSubmit', [payload]); history.push({ role: 'user', content: payload });
      } else {
        const inbox = consume_lead_inbox(); if (!inbox.length) continue;
        history.push({ role: 'user', content: format_team_events(inbox) }); console.log(`[wake: ${inbox.length} team event(s) -> new turn]`);
      }
      await agent_loop(history); print_last_assistant_message(history);
      if (active_teammates.size) had_teammates = true;
      else if (had_teammates && !BUS.peek('lead')) { console.log('[all teammates shut down]'); had_teammates = false; }
      console.log();
    }
  } finally { terminal.close(); }
  // Python daemon threads stop when the CLI's main thread exits.
  if (teammate_threads.size) process.exit(0);
}
