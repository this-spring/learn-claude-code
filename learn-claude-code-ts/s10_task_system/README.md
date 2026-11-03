# s10: Task System — From an Execution Checklist to Coordinated Task State

> **TypeScript reference edition**: implementation boundaries and chapter imports follow Python. Identifiers are preserved. Code blocks are implementation excerpts and may omit enclosing declarations.

[English](README.md) · [中文](README.zh.md) · [日本語](README.ja.md)

s01 → ... → s08 → s09 → `s10` → [s11](../s11_background_tasks/) → s12 → ... → s16 → s17

> *"Break big goals into small tasks, order them, persist"* — File-persisted task graph, the foundation for multi-agent collaboration.
>
> **Harness Layer**: Tasks — Persisted goals, recoverable progress.

---

## The Problem

s05's TodoWrite lets an agent record the steps of its current task. Each checklist item has content and a status, helping the agent keep track of what remains.

When a project is split into three tasks—creating database tables, writing an API, and adding tests—the Harness also needs to know how they relate: the API must wait for the database tables, and the tests must wait for a stable API. It also needs to record who is responsible for each task.

TodoWrite does not record these dependencies or assignments. It can show that "write the API" is unfinished, but the Harness cannot use that information to decide whether the task is ready to start.

This chapter adds a Task System. Each task has its own ID and status; `blockedBy` records prerequisites, and `owner` records the agent responsible for the task.

---

## The Solution

![Task System Overview](images/task-system-overview.en.svg)

The code keeps S04's five base tools, Permission, Hooks, and shared `execute_tool`, then adds 6 task tools, persistence in the `.tasks/` directory, and `blockedBy` dependency checks.

TodoWrite vs Task System:

| | TodoWrite (s05) | Task System (s10) |
|---|---|---|
| Role | Execution checklist for the current task | Recoverable task system |
| Storage | In-process / session state | `.tasks/{id}.json` |
| Dependencies | None | `blockedBy` dependency graph |
| Lifecycle | Current session / current task | Cross-session |
| Coordination | No task claiming | `owner` / claim |
| Status | pending / in_progress / completed | pending / in_progress / completed |
| Granularity | The agent's own steps | Tasks that can be claimed, tracked, and unblocked |
| Update contract | Replace the whole checklist | Create/get/update/list individual records |

---

## How It Works

![Task DAG](images/task-dag.en.svg)

### Task: Data Structure

Each task is a JSON file, stored in the `.tasks/` directory:

```typescript
export class Task {
  constructor(public id: string, public subject: string, public description: string, public status: string,
    public owner: string | null, public blockedBy: string[]) {}
}
```

IDs use the `task_` prefix followed by 8 random hexadecimal characters. Files are created exclusively; an existing ID is discarded and regenerated.

`TaskStore` validates task IDs and reads and writes the JSON files. `TASKS = TaskStore(TASKS_DIR)` is the store used by this chapter.

### create_task: Create Tasks

```typescript
export function create_task(subject: string, description = ''): Task { return TASKS.create(subject, description); }
```

`TaskStore.create` checks the subject, allocates a random ID, and writes `.tasks/{id}.json`. A new task always starts with an empty `blockedBy` list. The tool result returns the runtime-generated ID to the model.

### update_task: Add Dependencies with Returned IDs

```typescript
export function update_task(task_id: string, addBlockedBy: string[]): Task { return TASKS.update_dependencies(task_id, addBlockedBy); }
```

Task graph construction uses two phases: create every node first, then call `update_task` with the IDs returned by `create_task` to add edges. This matters when the model emits several tool calls in one response: sibling calls are formed before any tool result exists, so one `create_task` call cannot consume another call's newly generated ID.

`update_task` validates the entire change before saving it. The target and dependencies must exist, the target must still be pending and unowned, and the new edges must not introduce self-dependencies or cycles. Repeating an existing edge is safe and does not duplicate it.

### can_start: Dependency Check

A task can only start after all its `blockedBy` dependencies are **completed**:

```typescript
export function can_start(task_id: string): boolean { return !incomplete_dependencies(load_task(task_id)).length; }
```

`incomplete_dependencies` loads each prerequisite. A task cannot be claimed if any prerequisite is not completed or its file no longer exists.

### claim_task: Claim a Task

When the agent starts working on a task, it calls `claim_task`: sets `owner`, changes status from `pending` → `in_progress`. The `owner` field records who claimed the task:

```typescript
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
```

The claim is rejected if the task is not pending or its dependencies are incomplete. S10 only updates task state sequentially.

### complete_task: Complete and Unblock

When a task is done, set it to `completed`. Simultaneously scan all other tasks to find downstream tasks that were **just unblocked**:

```typescript
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
```

After completing "schema", `can_start` returns True for "endpoints" and "docs"; they can begin.

### get_task: View Full Details

`list_tasks` only shows a one-line summary. `get_task` returns the full task JSON, including description and dependency details. When recovering across sessions, the agent needs to read the full description to continue work:

```typescript
export function get_task(task_id: string): string { return JSON.stringify(load_task(task_id), null, 2); }
```

### State Machine: Two Actions, Three States

```
pending ──claim──→ in_progress ──complete──→ completed
```

Here `claim` / `complete` are actions, while `pending` / `in_progress` / `completed` are states:

- **claim_task**: `pending` → `in_progress`. Sets owner, begins work.
- **complete_task**: `in_progress` → `completed`. Marks the task done and unblocks downstream.

### Putting It Together

```typescript
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
```

Each `create_task` writes a JSON file; `update_task`, `claim_task`, and `complete_task` update it. Across sessions, the `.tasks/` directory persists — the agent reads the files to recover progress.

---

## Try It

```sh
cd learn-claude-code/learn-claude-code-ts
npm run s10
```

Try these prompts:

1. `Create tasks: setup database schema, create API endpoints (depends on schema), write tests (depends on endpoints), write docs (depends on schema)`
2. `List all tasks and their statuses`
3. `Claim the first unblocked task and complete it`
4. `List tasks again — which ones are now unblocked?`

What to observe: Are JSON files generated in the `.tasks/` directory? After completing a task, are the blocked tasks unblocked?

---

## What's Next

The task graph is in place, but full test suites, dependency installation, and deployment commands can take a long time. When these commands run synchronously, the Agent Loop remains blocked in the current tool call and cannot continue until the command finishes.

s11 Background Tasks → Slow operations run in the background. The Agent Loop can continue processing other tasks and receives a notification when the background work finishes.


<!-- translation-sync: zh@v5, en@v5, ja@v5 -->

## TypeScript verification

Run [code.ts](code.ts) with `npm run s10` and tests with `npm run test:s10`. Differential tests execute the unmodified [Python reference](../../s10_task_system/code.py) with fake model responses and require Python 3 and PyYAML. See the [alignment audit](../docs/parity-audit.md) for full-project and live-API verification status.
