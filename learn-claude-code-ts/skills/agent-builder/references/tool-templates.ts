import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, statSync, readlinkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep, parse as path_parse } from 'node:path';
const WORKDIR = process.cwd();
/** Tool Templates - copy and customize schemas and implementations. */
export const BASH_TOOL: Anthropic.Tool = {
  "name": "bash",
  "description": "Run a shell command. Use for: ls, find, grep, git, npm, python, etc.",
  "input_schema": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "The shell command to execute"
      }
    },
    "required": [
      "command"
    ]
  }
};
export const READ_FILE_TOOL: Anthropic.Tool = {
  "name": "read_file",
  "description": "Read file contents. Returns UTF-8 text.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Relative path to the file"
      },
      "limit": {
        "type": "integer",
        "description": "Max lines to read (default: all)"
      }
    },
    "required": [
      "path"
    ]
  }
};
export const WRITE_FILE_TOOL: Anthropic.Tool = {
  "name": "write_file",
  "description": "Write content to a file. Creates parent directories if needed.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Relative path for the file"
      },
      "content": {
        "type": "string",
        "description": "Content to write"
      }
    },
    "required": [
      "path",
      "content"
    ]
  }
};
export const EDIT_FILE_TOOL: Anthropic.Tool = {
  "name": "edit_file",
  "description": "Replace exact text in a file. Use for surgical edits.",
  "input_schema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "Relative path to the file"
      },
      "old_text": {
        "type": "string",
        "description": "Exact text to find (must match precisely)"
      },
      "new_text": {
        "type": "string",
        "description": "Replacement text"
      }
    },
    "required": [
      "path",
      "old_text",
      "new_text"
    ]
  }
};
export const TODO_WRITE_TOOL: Anthropic.Tool = {
  "name": "TodoWrite",
  "description": "Update the task list. Use to plan and track progress.",
  "input_schema": {
    "type": "object",
    "properties": {
      "items": {
        "type": "array",
        "description": "Complete list of tasks",
        "items": {
          "type": "object",
          "properties": {
            "content": {
              "type": "string",
              "description": "Task description"
            },
            "status": {
              "type": "string",
              "enum": [
                "pending",
                "in_progress",
                "completed"
              ]
            },
            "activeForm": {
              "type": "string",
              "description": "Present tense, e.g. 'Reading files'"
            }
          },
          "required": [
            "content",
            "status",
            "activeForm"
          ]
        }
      }
    },
    "required": [
      "items"
    ]
  }
};
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
  const dangerous = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/'];
  if (dangerous.some((pattern) => command.includes(pattern))) return 'Error: Dangerous command blocked';
  if (!command) return '(no output)';
  try {
    const result = spawnSync(command, {
      shell: true,
      cwd: WORKDIR,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: Infinity,
    });
    if (result.error) {
      if ('code' in result.error && result.error.code === 'ETIMEDOUT') return 'Error: Command timed out (60s)';
      throw result.error;
    }
    const output = (result.stdout + result.stderr).replace(/\r\n?/g, '\n').trim();
    return output ? Array.from(output).slice(0, 50000).join('') : '(no output)';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ETIMEDOUT') return 'Error: Command timed out (60s)';
    if (error instanceof Error && 'code' in error && !String(error.code).startsWith('ERR_')) return `Error: ${error.message}`;
    throw error;
  }
}

export function safe_path(p: string): string {
  const path = resolve_path(p);
  if (!is_relative_to(path, WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

export function run_read_file(path: string, limit?: number | null): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(safe_path(path)));
    let lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    if (lines.at(-1) === '') lines.pop();
    if (limit) {
      if (typeof limit !== 'number' && typeof limit !== 'boolean') throw new TypeError("'<' not supported between instances of 'str' and 'int'");
      if (Number(limit) < lines.length) {
        if (!Number.isInteger(Number(limit))) throw new TypeError('slice indices must be integers or None or have an __index__ method');
        lines = [...lines.slice(0, Number(limit)), `... (${lines.length - Number(limit)} more lines)`];
      }
    }
    return Array.from(lines.join('\n')).slice(0, 50000).join('');
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function run_write_file(path: string, content: string): string {
  try {
    const file_path = safe_path(path);
    mkdirSync(dirname(file_path), { recursive: true });
    writeFileSync(file_path, content, 'utf8');
    return `Wrote ${Array.from(content).length} bytes to ${path}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function run_edit_file(path: string, old_text: string, new_text: string): string {
  try {
    const file_path = safe_path(path);
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(file_path)).replace(/\r\n?/g, '\n');
    if (!text.includes(old_text)) return `Error: Text not found in ${path}`;
    writeFileSync(file_path, text.replace(old_text, () => new_text), 'utf8');
    return `Edited ${path}`;
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}


export const TASK_TOOL_TEMPLATE = `// Generate dynamically with agent types.
const TASK_TOOL = {
  name: 'Task', description: 'Spawn a subagent for a focused subtask.\\n\\nAgent types:\\n' + get_agent_descriptions(),
  input_schema: { type: 'object', properties: {
    description: { type: 'string', description: 'Short task name (3-5 words)' },
    prompt: { type: 'string', description: 'Detailed instructions' },
    agent_type: { type: 'string', enum: Object.keys(AGENT_TYPES) },
  }, required: ['description', 'prompt', 'agent_type'] },
};`;
export function execute_tool(name: string, args: Record<string, any>): string {
  if (name === 'bash') return run_bash(args.command);
  if (name === 'read_file') return run_read_file(args.path, args.limit);
  if (name === 'write_file') return run_write_file(args.path, args.content);
  if (name === 'edit_file') return run_edit_file(args.path, args.old_text, args.new_text);
  return `Unknown tool: ${name}`;
}
