/**
 * s16: Workflow Runtime - run a saved orchestration through one tool call.
 *
 * Run:
 *   npm run s16
 *   npm run s16 -- demo
 *   npm run s16 -- resume
 *
 *     +-------------+       +--------------------------------+
 *     | Agent loop  | ----> | Workflow(name, args, run_id)  |
 *     +-------------+       +---------------+----------------+
 *                                           |
 *                            +--------------+--------------+
 *                            | agent | parallel | pipeline  |
 *                            +--------------+--------------+
 *                                           |
 *                                    journal + result
 */
import type Anthropic from '@anthropic-ai/sdk';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { flockSync } from 'fs-ext';

export const WORKFLOW_AGENT_ENVIRONMENT = process.platform === 'win32'
  ? 'Host OS: Windows. This workflow agent only responds to its supplied step; it has no direct shell or file tools.'
  : 'Host OS: Unix-like. This workflow agent only responds to its supplied step; it has no direct shell or file tools.';
export const AGENT_CAP = 1000;
export const CONCURRENCY = 8;
export let STORE = fileURLToPath(new URL('.runtime', import.meta.url));
export const MISS = Symbol('journal cache miss');
export const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RUN_ID_RE = /^wf_[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9a-f]{16}$/;
export interface WorkflowMeta { name: string; description: string; phases?: string[] }
export interface Schema { type?: string; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema }
export type Args = Record<string, unknown>;
export type Workflow = (context: ExecutionState, args: Args) => Promise<unknown>;
export interface AgentRunner { run(prompt: string, schema?: Schema | null, label?: string | null): RunnerOutput | Promise<RunnerOutput> }
function char_length(value: string): number { return Array.from(value).length; }
function char_slice(value: string, start: number, end?: number): string { return Array.from(value).slice(start, end).join(''); }
function python_str(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (Array.isArray(value)) return `[${value.map((item) => typeof item === 'string' ? repr(item) : python_str(item)).join(', ')}]`;
  if (typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${repr(key)}: ${typeof item === 'string' ? repr(item) : python_str(item)}`).join(', ')}}`;
  return String(value);
}
function repr(value: string): string { const quote = value.includes("'") && !value.includes('"') ? '"' : "'"; return quote + value.replaceAll('\\', '\\\\').replaceAll(quote, '\\' + quote).replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t') + quote; }
function json_dump(value: unknown, sort_keys = false, ensure_ascii = true): string {
  let result: string;
  if (Array.isArray(value)) result = `[${value.map((item) => json_dump(item, sort_keys, false)).join(', ')}]`;
  else if (value && typeof value === 'object') {
    const keys = Object.keys(value); if (sort_keys) keys.sort();
    result = `{${keys.map((key) => `${JSON.stringify(key)}: ${json_dump((value as Args)[key], sort_keys, false)}`).join(', ')}}`;
  } else result = JSON.stringify(value ?? null);
  return ensure_ascii ? result.replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`) : result;
}
function json_pretty(value: unknown): string { return JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`); }
function python_equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (['number', 'boolean'].includes(typeof a) && ['number', 'boolean'].includes(typeof b)) return Number(a) === Number(b);
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => python_equal(item, b[index]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && python_equal((a as Args)[key], (b as Args)[key]));
  }
  return false;
}
function read_utf8(path: string): string { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(path)).replace(/\r\n?/g, '\n'); }
export function _stable_hash(s: string): bigint { return BigInt('0x' + createHash('sha256').update(s).digest('hex')); }
export function create_run_id(meta: WorkflowMeta): string { return `wf_${meta.name}_${randomBytes(8).toString('hex')}`; }
export function reserve_run_id(meta: WorkflowMeta): string {
  mkdirSync(STORE, { recursive: true });
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const run_id = validate_run_id(create_run_id(meta)); const snapshot_path = join(STORE, `${run_id}.json`);
    try { const fd = openSync(snapshot_path, 'wx', 0o600); closeSync(fd); return run_id; }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue; throw error; }
  }
  throw new WorkflowInputError('could not allocate a unique workflow runId');
}
export function create_task_id(run_id: string): string { return `local_workflow_${run_id}`; }
export function validate_run_id(run_id: unknown): string {
  if (typeof run_id !== 'string' || run_id.endsWith('\n') || !RUN_ID_RE.test(run_id)) throw new WorkflowInputError('invalid workflow runId'); return run_id;
}
export class WorkflowInputError extends Error { override name = 'WorkflowInputError'; }
const _run_locks = new Set<string>();
export async function workflow_run_lock<T>(run_id: string, operation: () => Promise<T>): Promise<T> {
  if (_run_locks.has(run_id)) throw new WorkflowInputError(`workflow run ${run_id} is already active`);
  _run_locks.add(run_id); let handle: number | undefined;
  try {
    mkdirSync(STORE, { recursive: true }); handle = openSync(join(STORE, `${run_id}.lock`), 'a+');
    try { flockSync(handle, 'exnb'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && ['EAGAIN', 'EWOULDBLOCK'].includes(String(error.code))) throw new WorkflowInputError(`workflow run ${run_id} is already active`);
      throw error;
    }
    return await operation();
  } finally { if (handle !== undefined) { try { flockSync(handle, 'un'); } finally { closeSync(handle); } } _run_locks.delete(run_id); }
}
export function validate_meta(meta: unknown): WorkflowMeta {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new WorkflowInputError('meta must be an object literal');
  const value = meta as Args;
  if (!value.name || !value.description) throw new WorkflowInputError('meta requires `name` and `description`');
  if (typeof value.name !== 'string' || value.name.length > 64 || value.name.endsWith('\n') || !WORKFLOW_NAME_RE.test(value.name)) throw new WorkflowInputError("meta.name must be a 1-64 character slug using letters, numbers, '.', '_', or '-'");
  if (typeof value.description !== 'string') throw new WorkflowInputError('meta.description must be a string');
  if (Object.hasOwn(value, 'phases') && (!Array.isArray(value.phases) || !value.phases.every((phase) => typeof phase === 'string' && phase))) throw new WorkflowInputError('meta.phases must be a list of non-empty strings');
  return meta as WorkflowMeta;
}
export function check_permission(meta: WorkflowMeta, settings: { deny?: string[] } | null = null): string {
  if (settings?.deny?.includes(meta.name)) throw new WorkflowInputError(`workflow '${meta.name}' denied by settings`); return 'allow';
}
export class SimpleJsonSchema {
  constructor(public schema: Schema) {}
  validate(value: unknown, schema: Schema | null = null): [boolean, string | null] {
    schema ??= this.schema;
    if (Object.hasOwn(schema, 'enum') && !schema.enum!.some((item) => python_equal(value, item))) return [false, `expected one of ${python_str(schema.enum)}`];
    const t = schema.type;
    if (t === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [false, 'expected object'];
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return [false, `missing required key '${key}'`];
      for (const [key, sub] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) { const [ok, err] = this.validate((value as Args)[key], sub); if (!ok) return [false, `${key}: ${err}`]; }
      return [true, null];
    }
    if (t === 'array') {
      if (!Array.isArray(value)) return [false, 'expected array'];
      if (schema.items) for (const [i, el] of value.entries()) { const [ok, err] = this.validate(el, schema.items); if (!ok) return [false, `[${i}]: ${err}`]; }
      return [true, null];
    }
    if (t === 'string') return [typeof value === 'string', typeof value === 'string' ? null : 'expected string'];
    if (t === 'boolean') return [typeof value === 'boolean', typeof value === 'boolean' ? null : 'expected boolean'];
    if (t === 'number' || t === 'integer') { const ok = typeof value === 'number'; return [ok, ok ? null : 'expected number']; }
    return [true, null];
  }
}
export function _fill_schema(schema: Schema, seed: string): unknown {
  const t = schema.type;
  if (t === 'object') { const keys = schema.required?.length ? schema.required : Object.keys(schema.properties ?? {}); return Object.fromEntries(keys.map((k) => [k, _fill_schema(schema.properties![k], `${seed}/${k}`)])); }
  if (t === 'array') return [_fill_schema(schema.items!, `${seed}/0`)];
  if (t === 'boolean') return _stable_hash(seed) % 4n !== 0n;
  if (t === 'number' || t === 'integer') return Number(_stable_hash(seed) % 5n);
  return seed.split('/').at(-1)!;
}
export class RunnerOutput { constructor(public readonly value: unknown, public readonly tokens: number) {} }
export class MockAgentRunner implements AgentRunner {
  run(prompt: string, schema: Schema | null = null, label: string | null = null): RunnerOutput {
    let value: unknown;
    if (schema === null) { value = `[mock] ${char_slice(label || prompt, 0, 60)}`; return new RunnerOutput(value, MockAgentRunner._tokens(prompt, value)); }
    const props = schema.properties ?? {};
    if (Object.hasOwn(props, 'findings')) {
      const n = 1 + Number(_stable_hash(prompt) % 2n); const sev = ['high', 'medium', 'low'];
      value = { findings: Array.from({ length: n }, (_, i) => ({ title: `${label || 'audit'} #${i + 1}`, severity: sev[Number(_stable_hash(prompt + String(i)) % 3n)] })) };
    } else if (Object.hasOwn(props, 'isReal')) { const real = _stable_hash(prompt) % 4n !== 0n; value = { isReal: real, reason: real ? 'reproduced' : 'could not reproduce' }; }
    else value = _fill_schema(schema, prompt);
    return new RunnerOutput(value, MockAgentRunner._tokens(prompt, value));
  }
  static _tokens(prompt: string, result: unknown): number { return Math.floor(char_length(prompt) / 4) + Math.floor(char_length(json_dump(result)) / 4); }
}
export function _response_text(response: { content?: unknown }): string {
  const content = Array.isArray(response.content) ? response.content : [];
  return content.filter((block) => block?.type === 'text').map((block) => python_str(block.text ?? '')).join('\n').trim();
}
export function _parse_runner_json(text: string): unknown {
  let stripped = text.trim();
  if (stripped.startsWith('```')) { let lines = stripped.split(/\r\n|[\n\r]/).slice(1); if (lines.at(-1)?.trim() === '```') lines = lines.slice(0, -1); stripped = lines.join('\n').trim(); }
  try { return JSON.parse(stripped); } catch { /* raw_decode scans only object openers */ }
  for (let position = 0; position < stripped.length; position += 1) {
    if (stripped[position] !== '{') continue;
    let depth = 0; let quoted = false; let escaped = false;
    for (let end = position; end < stripped.length; end += 1) {
      const c = stripped[end];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth += 1;
      else if (c === '}' || c === ']') { depth -= 1; if (depth === 0) { try { return JSON.parse(stripped.slice(position, end + 1)); } catch { break; } } }
    }
  }
  throw new WorkflowInputError('workflow agent returned invalid JSON');
}
export class AnthropicAgentRunner implements AgentRunner {
  constructor(public client: Pick<Anthropic, 'messages'>, public model: string) {}
  async run(prompt: string, schema: Schema | null = null, _label: string | null = null): Promise<RunnerOutput> {
    let request = prompt;
    if (schema !== null) request += '\n\nReturn only one JSON object matching this schema:\n' + json_dump(schema, true);
    const response = await this.client.messages.create({ model: this.model,
      system: 'You are a focused workflow agent. Complete only the supplied step. ' + WORKFLOW_AGENT_ENVIRONMENT + ' Do not claim access to files or results not included in the prompt.',
      messages: [{ role: 'user', content: request }], max_tokens: 2000 });
    const text = _response_text(response); let value: unknown = text;
    if (schema !== null) { try { value = _parse_runner_json(text); } catch (error) { if (!(error instanceof WorkflowInputError)) throw error; } }
    const tokens = Math.trunc(response.usage?.input_tokens || 0) + Math.trunc(response.usage?.output_tokens || 0);
    return new RunnerOutput(value, tokens);
  }
}
export let RUNNER_FACTORY: () => AgentRunner = () => new MockAgentRunner();
export function set_runner_factory(factory: () => AgentRunner): void { RUNNER_FACTORY = factory; }
export function set_runtime_store(store: string): void { STORE = store; }

// -- Journal --
export class WorkflowJournal {
  path: string;
  cache = new Map<string, unknown>();
  private _f: number | null;
  constructor(run_id: string, public resume: boolean, store: string | null = null) {
    store ??= STORE; mkdirSync(store, { recursive: true }); this.path = join(store, `${run_id}.journal.jsonl`);
    if (resume) {
      if (!existsSync(this.path)) throw new WorkflowInputError(`resume journal not found for ${run_id}`);
      const lines = read_utf8(this.path).split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/); if (lines.at(-1) === '') lines.pop();
      for (const [index, line] of lines.entries()) {
        try { const rec = JSON.parse(line); if (!rec || typeof rec !== 'object' || Array.isArray(rec) || typeof rec.key !== 'string' || !Object.hasOwn(rec, 'value')) throw new Error('expected key/value record'); this.cache.set(rec.key, rec.value); }
        catch { throw new WorkflowInputError(`invalid resume journal record at line ${index + 1}`); }
      }
      this._f = openSync(this.path, 'a');
    } else this._f = openSync(this.path, 'w');
  }
  key(kind: string, label: string | null, prompt: string, schema: Schema | null = null): string {
    const basis = `${kind}|${python_str(label)}|${prompt}|${json_dump(schema, true)}`;
    return `${kind}-${String(_stable_hash(basis) % 10000000000n).padStart(10, '0')}`;
  }
  cached(key: string): unknown { return this.cache.has(key) ? this.cache.get(key) : MISS; }
  record(key: string, value: unknown): void {
    if (this._f === null) throw new Error('I/O operation on closed file.');
    appendFileSync(this._f, json_dump({ key, value: value ?? null }) + '\n', 'utf8'); this.cache.set(key, value ?? null);
  }
  close(): void { if (this._f !== null) { closeSync(this._f); this._f = null; } }
}
export class Budget {
  _spent = 0;
  constructor(public total: number | boolean | null = null) {}
  add(n: number): void {
    if (this.total !== null) {
      if (!['number', 'boolean'].includes(typeof this.total)) throw new TypeError('token budget must support numeric comparison');
      if (this._spent + n > Number(this.total)) throw new WorkflowInputError(`token budget exceeded (${this._spent + n} > ${python_str(this.total)})`);
    }
    this._spent += n;
  }
  spent(): number { return this._spent; }
  remaining(): number {
    if (this.total === null) return Infinity;
    if (!['number', 'boolean'].includes(typeof this.total)) throw new TypeError('token budget must support numeric subtraction');
    return Math.max(0, Number(this.total) - this._spent);
  }
}
export class LocalWorkflowTask {
  status = 'running';
  usage = { agents: 0, tokens: 0 };
  progress: Args[] = [];
  constructor(public task_id: string, public run_id: string, public meta: WorkflowMeta) {}
  event(name: string, data: Args = {}): void {
    const line = Object.entries(data).map(([k, v]) => `${k}=${python_str(v)}`).join(' ');
    console.log(`  event      ${name.padEnd(18)} ${line}`);
  }
  progress_event(ptype: string, data: Args = {}): void {
    this.progress.push({ type: ptype, ...data });
    const line = Object.entries(data).map(([k, v]) => `${k}=${python_str(v)}`).join(' ');
    console.log(`  progress   ${ptype.padEnd(16)} ${line}`);
  }
}
// asyncio.Semaphore's acquire/release behavior on the Node event loop.
class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(public _value: number) {}
  async acquire(): Promise<void> { if (this._value > 0) this._value -= 1; else await new Promise<void>((done) => this.waiters.push(done)); }
  release(): void { const next = this.waiters.shift(); if (next) next(); else this._value += 1; }
}
export class ExecutionLimits {
  agents = 0;
  semaphore = new Semaphore(CONCURRENCY);
  claim_agent(): void { this.agents += 1; if (this.agents > AGENT_CAP) throw new WorkflowInputError(`agent() cap reached (${AGENT_CAP})`); }
}
export class ExecutionState {
  _phase: string | null = null;
  _phases_seen = new Set<string>();
  _limits: ExecutionLimits;
  constructor(public task: LocalWorkflowTask, public journal: WorkflowJournal, public runner: AgentRunner, public budget: Budget,
    public args: Args, public _depth = 0, limits: ExecutionLimits | null = null) { this._limits = limits || new ExecutionLimits(); }
  phase(title: string): void {
    this._phase = title;
    if (!this._phases_seen.has(title)) { this._phases_seen.add(title); this.task.progress_event('workflow_phase', { title }); }
  }
  log(message: string): void { this.task.progress_event('workflow_log', { message }); }
  async agent(prompt: string, schema: Schema | null = null, label: string | null = null, phase: string | null = null): Promise<unknown> {
    label = label || (char_slice(prompt, 0, 24) + '...'); this._limits.claim_agent();
    if (this.budget.remaining() <= 0) throw new WorkflowInputError('token budget exceeded');
    const key = this.journal.key('agent', label, prompt, schema); const cached = this.journal.cached(key);
    if (cached !== MISS) {
      if (schema !== null) { const [ok, err] = new SimpleJsonSchema(schema).validate(cached); if (!ok) throw new WorkflowInputError(`cached agent output failed schema validation: ${err}`); }
      this.task.progress_event('workflow_agent', { label, phase: phase || this._phase, status: 'cached' }); return cached;
    }
    let run: RunnerOutput;
    await this._limits.semaphore.acquire();
    try { run = await this.runner.run(prompt, schema, label); } finally { this._limits.semaphore.release(); }
    let result = run.value; let tokens = run.tokens;
    if (schema !== null) {
      let [ok, err] = new SimpleJsonSchema(schema).validate(result);
      if (!ok) {
        const retry = await this.runner.run(prompt + '\n\nReturn valid JSON.', schema, label);
        result = retry.value; tokens += retry.tokens; [ok, err] = new SimpleJsonSchema(schema).validate(result);
        if (!ok) throw new WorkflowInputError(`agent({schema}) invalid output: ${err}`);
      }
    }
    this.budget.add(tokens); this.task.usage.agents += 1; this.task.usage.tokens += tokens;
    this.journal.record(key, result); this.task.progress_event('workflow_agent', { label, phase: phase || this._phase, status: 'done' }); return result;
  }
  async parallel<T>(thunks: (() => Promise<T>)[]): Promise<T[]> { return Promise.all(thunks.map((thunk) => thunk())); }
  async pipeline<Item>(items: Item[], ...stages: ((value: any, item: Item, index: number) => Promise<any>)[]): Promise<unknown[]> {
    const run_item = async (item: Item, idx: number) => { let value: unknown = item; for (const stage of stages) value = await stage(value, item, idx); return value; };
    return Promise.all(items.map((item, idx) => run_item(item, idx)));
  }
  async workflow(name: string, args: Args | null = null): Promise<unknown> {
    if (this._depth >= 1) throw new WorkflowInputError('workflow() nesting is one level only');
    const saved = WORKFLOWS.get(name); if (!saved) throw new WorkflowInputError(`unknown workflow '${name}'`);
    const [meta, fn] = saved;
    const child = new ExecutionState(this.task, this.journal, this.runner, this.budget, args || {}, this._depth + 1, this._limits);
    return fn(child, args || {});
  }
}

// -- Workflow Tool --
export interface WorkflowResult { launched: Args; result: unknown; task: LocalWorkflowTask }
export class WorkflowTool {
  async call(meta: WorkflowMeta, script_fn: Workflow, args: Args | null = null, resume_from_run_id: string | null = null): Promise<WorkflowResult> {
    validate_meta(meta); check_permission(meta);
    const resuming = resume_from_run_id !== null;
    const run_id = resuming ? validate_run_id(resume_from_run_id) : reserve_run_id(meta);
    return workflow_run_lock(run_id, () => this._call_locked(meta, script_fn, args, run_id, resuming));
  }
  async _call_locked(meta: WorkflowMeta, script_fn: Workflow, args: Args | null, run_id: string, resuming: boolean): Promise<WorkflowResult> {
    let journal: WorkflowJournal;
    if (resuming) {
      const snapshot = _read_snapshot(run_id);
      if (snapshot.workflowName !== meta.name) throw new WorkflowInputError('resume runId does not match workflow meta');
      const saved_args = (snapshot.args ?? {}) as Args;
      if (args === null) args = saved_args; else if (!python_equal(args, saved_args)) throw new WorkflowInputError('resume args do not match the original run');
      journal = new WorkflowJournal(run_id, true);
    } else { args ??= {}; journal = new WorkflowJournal(run_id, false); }
    const task_id = create_task_id(run_id); const task = new LocalWorkflowTask(task_id, run_id, meta);
    const launched = { status: 'async_launched', taskId: task_id, taskType: 'local_workflow', runId: run_id, workflowName: meta.name };
    task.event('async_launched', { runId: run_id, taskId: task_id });
    task.event('task_started', { workflow: meta.name, phases: meta.phases?.join(',') || '-', resume: resuming });
    _write_json(join(STORE, `${run_id}.json`), { runId: run_id, workflowName: meta.name, args, task: serialize_task(task) });
    let result: unknown;
    try {
      const ctx = new ExecutionState(task, journal, RUNNER_FACTORY(), new Budget(args!.budget as number | null | undefined), args!);
      result = await script_fn(ctx, args!); task.status = 'completed';
    } catch (error) { task.status = 'failed'; result = { error: error instanceof Error ? error.message : String(error) }; }
    finally { journal.close(); }
    _write_json(join(STORE, `${run_id}.output.json`), result);
    _write_json(join(STORE, `${run_id}.json`), { runId: run_id, workflowName: meta.name, args, task: serialize_task(task) });
    _save_last_run(run_id);
    task.event('task_notification', { status: task.status, agents: task.usage.agents, tokens: task.usage.tokens, outputFile: `.runtime/${run_id}.output.json` });
    return { launched, result, task };
  }
}
export function _write_json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true }); const temporary = path + '.tmp';
  writeFileSync(temporary, json_pretty(value ?? null), 'utf8'); renameSync(temporary, path);
}
export function _read_snapshot(run_id: string): Args {
  const path = join(STORE, `${run_id}.json`); if (!existsSync(path)) throw new WorkflowInputError(`resume snapshot not found for ${run_id}`);
  let snapshot: unknown;
  try { snapshot = JSON.parse(read_utf8(path)); } catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new WorkflowInputError(`invalid resume snapshot for ${run_id}`); }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new WorkflowInputError(`invalid resume snapshot for ${run_id}`); return snapshot as Args;
}
export function _save_last_run(run_id: string): void { writeFileSync(join(STORE, 'last_run.txt'), run_id, 'utf8'); }
export function _read_last_run(): string | null { const p = join(STORE, 'last_run.txt'); return existsSync(p) ? read_utf8(p).trim() : null; }

// -- Sample Workflow --
export const FINDINGS_SCHEMA: Schema = {
  "type": "object",
  "required": [
    "findings"
  ],
  "properties": {
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": [
          "title",
          "severity"
        ],
        "properties": {
          "title": {
            "type": "string"
          },
          "severity": {
            "type": "string",
            "enum": [
              "high",
              "medium",
              "low"
            ]
          }
        }
      }
    }
  }
};
export const VERDICT_SCHEMA: Schema = {
  "type": "object",
  "required": [
    "isReal",
    "reason"
  ],
  "properties": {
    "isReal": {
      "type": "boolean"
    },
    "reason": {
      "type": "string"
    }
  }
};
export const SAMPLE_META: WorkflowMeta = {
  "name": "review-changes",
  "description": "Review changed files across dimensions, verify each finding",
  "phases": [
    "Review",
    "Verify"
  ]
};
export const DIMENSIONS: string[] = [
  "correctness",
  "security",
  "performance",
  "style"
];
export const DEMO_CHANGES: string = "def load_user(user_id):\n    query = f\"SELECT * FROM users WHERE id = {user_id}\"\n    return db.execute(query).fetchone()\n";
export const WORKFLOW_TOOL: Anthropic.Tool = {
  "name": "Workflow",
  "description": "Run a saved workflow by name. Pass input in args.",
  "input_schema": {
    "type": "object",
    "properties": {
      "name": {
        "type": "string"
      },
      "args": {
        "type": "object"
      },
      "resume_from_run_id": {
        "type": "string"
      }
    },
    "required": [
      "name"
    ],
    "additionalProperties": false
  }
};
interface Finding { title: string; severity: string }
export async function sample_workflow(ctx: ExecutionState, args: Args): Promise<{ confirmed: (Finding & { dimension: string })[] }> {
  ctx.phase('Review'); const changes = Object.hasOwn(args, 'changes') ? args.changes : '';
  if (typeof changes !== 'string') throw new WorkflowInputError('args.changes must be a string');
  const review_input = changes.trim() || 'No change context was supplied.';
  async function audit(_value: unknown, dimension: string, _idx: number): Promise<{ dimension: string; findings: Finding[] }> {
    const out = await ctx.agent(`Review this change context for ${dimension} issues. Report only issues supported by the supplied text.\n\n${review_input}`, FINDINGS_SCHEMA, `audit:${dimension}`, 'Review') as { findings: Finding[] };
    return { dimension, findings: out.findings };
  }
  async function verify(audited: { findings: Finding[] }, dimension: string, _idx: number): Promise<{ dimension: string; confirmed: Finding[] }> {
    ctx.phase('Verify');
    const verdicts = await ctx.parallel(audited.findings.map((f) => () => ctx.agent(
      `Adversarially verify this ${dimension} finding against the supplied change context.\n\nChange context:\n${review_input}\n\nFinding:\n${json_dump(f)}`, VERDICT_SCHEMA, `verify:${dimension}:${f.title}`, 'Verify')));
    const confirmed = audited.findings.filter((_f, index) => verdicts[index] && (verdicts[index] as { isReal?: unknown }).isReal);
    return { dimension, confirmed };
  }
  const results = await ctx.pipeline(DIMENSIONS, audit, verify) as { dimension: string; confirmed: Finding[] }[];
  const confirmed = results.filter(Boolean).flatMap((r) => r.confirmed.map((f) => ({ dimension: r.dimension, ...f })));
  const rank = (severity: string) => ({ high: 0, medium: 1, low: 2 } as Record<string, number>)[severity] ?? 3;
  confirmed.sort((a, b) => rank(a.severity) - rank(b.severity));
  ctx.log(`confirmed ${confirmed.length} real finding(s)`); return { confirmed };
}
export const WORKFLOWS = new Map<string, [WorkflowMeta, Workflow]>([[SAMPLE_META.name, [SAMPLE_META, sample_workflow]]]);
export function serialize_task(task: LocalWorkflowTask): Args {
  return { taskId: task.task_id, taskType: 'local_workflow', runId: task.run_id, workflowName: task.meta.name, status: task.status, usage: { ...task.usage }, progress: [...task.progress] };
}
export async function run_workflow(name: unknown, args: Args | null = null, resume_from_run_id: string | null = null): Promise<{ launched: Args; result: unknown; task: Args }> {
  if (typeof name !== 'string') throw new WorkflowInputError('workflow name must be a string');
  const saved = WORKFLOWS.get(name); if (!saved) throw new WorkflowInputError(`unknown workflow '${name}'`);
  if (args !== null && (!args || typeof args !== 'object' || Array.isArray(args))) throw new WorkflowInputError('workflow args must be an object');
  const [meta, script_fn] = saved; const out = await new WorkflowTool().call(meta, script_fn, args, resume_from_run_id);
  return { launched: out.launched, result: out.result, task: serialize_task(out.task) };
}
export const WORKFLOW_HANDLERS = { Workflow: run_workflow };
export const INHERITS_TOOLS_FROM = 's15';
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

export async function run_workflow_sync(tool_input: { name: unknown; args?: Args | null; resume_from_run_id?: string | null }): Promise<string> {
  try {
    bind_kwargs(tool_input, ['name', 'args', 'resume_from_run_id'], ['name'], 'run_workflow');
    return json_dump(await run_workflow(tool_input.name, tool_input.args ?? null, tool_input.resume_from_run_id ?? null)); }
  catch (error) { if (error instanceof WorkflowInputError) return `Error: ${error.message}`; throw error; }
}
type IntegratedHost = typeof import('../s15_integrated_harness/code.js');
const _workflow_tool_installed = new WeakSet<object>();
export function install_workflow_tool(host: IntegratedHost): void {
  RUNNER_FACTORY = () => new AnthropicAgentRunner(host.client, host.MODEL);
  if (_workflow_tool_installed.has(host)) return;
  const base_assemble = host.assemble_tool_pool;
  function assemble_with_workflow(): ReturnType<IntegratedHost['assemble_tool_pool']> {
    const [tools, handlers] = base_assemble();
    if (!tools.some((tool) => tool.name === 'Workflow')) tools.push(WORKFLOW_TOOL);
    handlers.Workflow = (input) => run_workflow_sync(input as { name: unknown; args?: Args | null; resume_from_run_id?: string | null });
    return [tools, handlers];
  }
  host.set_tool_pool_assembler(assemble_with_workflow); _workflow_tool_installed.add(host);
}
export async function load_integrated_host(): Promise<IntegratedHost> {
  const path = new URL(`../s15_integrated_harness/code.ts?integrated_host=${randomUUID()}`, import.meta.url);
  return await import(path.href) as IntegratedHost;
}

// -- CLI --
export async function run_demo(argv: string[]): Promise<void> {
  let resume_id: string | null = null;
  if (argv.length && argv[0] === 'resume') {
    resume_id = _read_last_run(); if (!resume_id) { console.log('nothing to resume; run `npm run s16 -- demo` first.'); return; }
    console.log(`resuming ${resume_id}; unchanged agent() calls use the journal cache\n`);
  } else console.log('launching workflow `review-changes`\n');
  const out = await WORKFLOW_HANDLERS.Workflow('review-changes', { budget: null, changes: DEMO_CHANGES }, resume_id);
  console.log('\nresult:');
  for (const f of (out.result as { confirmed?: (Finding & { dimension: string })[] }).confirmed ?? []) console.log(`  [${f.severity.padEnd(6)}] ${f.dimension}: ${f.title}`);
  const task = out.task; const usage = task.usage as { agents: number; tokens: number };
  console.log(`\nstatus=${task.status}  agents=${usage.agents}  tokens=${usage.tokens}  journal=.runtime/${task.runId}.journal.jsonl`);
}
export const PROMPT = '\x1b[36ms16 >> \x1b[0m';
export const READLINE_PROMPT = PROMPT;
export async function run_cli(): Promise<void> {
  const host = await load_integrated_host(); install_workflow_tool(host);
  if (!host.MODEL) throw new Error('Missing MODEL_ID. Configure learn-claude-code-ts/.env first.');
  host.CONSOLE.set_prompt(PROMPT, READLINE_PROMPT); host.activate_cli(); host.start_runtime_services();
  console.log('s16: workflow runtime'); console.log('Enter a question, press Enter to send. Type q to quit.\n');
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const closed = new AbortController(); terminal.once('close', () => closed.abort()); terminal.on('SIGINT', () => terminal.close());
  process.once('SIGINT', () => terminal.close());
  host.CONSOLE.reader = (prompt) => terminal.question(prompt, { signal: closed.signal });
  process.once('SIGTERM', () => { void host._handle_termination_signal(15); });
  const history: Anthropic.MessageParam[] = []; let context = await host.update_context({}, history);
  const session_state = { active_user_request: '(no active user request)' };
  void host.asynchronous_turn.run(true, () => host.async_event_loop(history, context, session_state));
  try {
    while (true) {
      let query: string; try { query = await host.CONSOLE.ask(); } catch { break; }
      if (['q', 'exit', ''].includes(query.trim().toLowerCase())) break;
      const release = await host.acquire_agent_lock();
      try {
        await host.trigger_hooks('UserPromptSubmit', query); const turn_start = history.length;
        session_state.active_user_request = query; history.push({ role: 'user', content: query });
        await host.agent_loop(history, context, query); context = await host.update_context(context, history); host.print_turn_assistants(history, turn_start);
      } finally { release(); }
      console.log();
    }
  } finally { host.stop_async_events(); host.stop_runtime_services(); terminal.close(); await host._stop_all_shell_processes(); }
  if (host.active_teammates.size) process.exit(0);
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] && ['demo', 'resume'].includes(process.argv[2])) await run_demo(process.argv.slice(2));
  else await run_cli();
}
