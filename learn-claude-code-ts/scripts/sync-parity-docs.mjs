// Refresh migrated examples from the actual standalone chapter source.
import ts from 'typescript';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const reference = fileURLToPath(new URL('../..', import.meta.url));
const chapters = {
  s01_agent_loop: [{ source: "const messages: Anthropic.MessageParam[] = [{ role: 'user', content: query }];" }, { symbol: 'agent_loop', from: 'const response =', to: '\n    messages.push' }, { symbol: 'agent_loop', from: "messages.push({ role: 'assistant'", to: '\n    const results:' }, { symbol: 'agent_loop', from: 'const results:', to: "    messages.push({ role: 'user', content: results });" }, { source: "messages.push({ role: 'user', content: results });" }, 'agent_loop'],
  s02_tool_use: [{ source: "// s01 exposed only bash.\nconst tools = TOOLS.filter((tool) => tool.name === 'bash');" }, 'TOOLS', ['run_read', 'run_write', 'run_edit', 'run_glob'], ['TOOL_HANDLERS', 'agent_loop']],
  s03_permission: [['DENY_LIST', 'check_deny_list'], ['DESTRUCTIVE_COMMAND_WORD', 'contains_destructive_command', 'PERMISSION_RULES', 'check_rules'], 'ask_user', 'check_permission'],
  s05_todo_write: ['TodoManager', ['TOOLS', 'TOOL_HANDLERS'], { symbol: 'agent_loop', from: 'rounds_since_todo = used_todo', to: "    messages.push({ role: 'user', content: results });" }],
  s15_integrated_harness: ['agent_loop'],
  s16_workflow_runtime: [['SAMPLE_META', 'sample_workflow'], 'WORKFLOW_TOOL', 'validate_meta', 'ExecutionState.pipeline', 'ExecutionState.agent', 'LocalWorkflowTask.progress_event', 'WorkflowJournal.record', ['WorkflowJournal.key', 'WorkflowJournal.cached'], 'sample_workflow'],
  s17_goal_loop: ['AgentSession._run_query', { symbol: 'AgentSession._run_query', from: 'const decision =', to: "      await this.trigger_hooks('Stop', this.messages);" }],
  s04_hooks: ['agent_loop', ['HOOKS', 'register_hook', 'trigger_hooks'], 'context_inject_hook', { source: "await trigger_hooks('UserPromptSubmit', query);\n      history.push({ role: 'user', content: query });\n      await agent_loop(history, client, MODEL);" }, ['permission_hook', 'log_hook', 'large_output_hook'], 'summary_hook', { symbol: 'agent_loop', from: "const blocked =", to: "    messages.push({ role: 'user', content: results });" }, { symbol: 'agent_loop', from: 'const tool_calls =', to: '    const results:' }],
  s06_subagent: [['SUB_TOOLS', 'SUB_HANDLERS', 'run_subagent'], ['TASK_TOOL', 'TOOLS', 'TOOL_HANDLERS']],
  s07_skill_loading: [{ source: "// Example of eagerly loading every document:\nconst SYSTEM = 'You are a coding agent. '\n  + readFileSync('docs/react-style.md', 'utf8')\n  + readFileSync('docs/sql-style.md', 'utf8')\n  + readFileSync('docs/api-design.md', 'utf8');" }, 'SkillLoader.scan', ['ENVIRONMENT_PROMPT', 'build_system_prompt'], 'SkillLoader.load'],
  s08_context_compact: ['ContextCompactor.tool_result_budget', 'ContextCompactor.snip_compact', 'ContextCompactor.micro_compact', 'ContextCompactor.estimate_chars', 'ContextCompactor.compact_history', 'ContextCompactor.prepare', 'ContextCompactor.reactive_compact', { symbol: 'agent_loop', from: 'let reactive_retries', to: "    messages.push({ role: 'assistant'" }, { symbol: 'agent_loop', from: 'messages.splice(0, messages.length, ...await COMPACTOR.prepare', to: '    let response:' }, { symbol: 'agent_loop', from: 'const results:', to: '\n  }\n}' }],
  s09_memory: ['write_memory_file', { symbol: 'select_relevant_memories', from: 'const prompt =', to: '\n  try {' }, { symbol: 'agent_loop', from: 'const relevant_memories', to: '\n  while' }, { symbol: 'agent_loop', from: 'const tool_calls', to: '    const results:' }, { symbol: 'consolidate_memories', from: 'const snapshot', to: '\n    console.log' }],
  s10_task_system: ['Task', 'create_task', 'update_task', 'can_start', 'claim_task', 'complete_task', 'get_task', ['TOOLS', 'TOOL_HANDLERS']],
  s11_background_tasks: ['should_run_background', 'BackgroundManager', 'collect_background_results', 'execute_tool'],
  s12_cron_scheduler: ['CronJob', 'poll_due_jobs', 'queue_processor_loop', { symbol: 'agent_loop', from: 'for (const job of fired)', to: '\n  let waiting_for_ack' }],
  s13_agent_teams: [{ symbol: 'PROMPT_SECTIONS', from: '"teams"', to: ',\n  "workspace"' }, ['MessageBus.send', 'MessageBus.wait_for_messages'], 'consume_lead_inbox', 'TeammateRuntime.wait_for_work', 'scan_unclaimed_tasks', 'claim_task', 'Task', { source: "create_worktree('auth-refactor', 'task_1a2b3c4d'); // Example task ID: replace with create_task's returned ID." }, 'assignment_cwd', 'ProtocolState', '_run_teammate_tool'],
  s14_mcp_plugin: [{ symbol: 'agent_loop', from: 'while (true)', to: '\n    messages.push({ role:' }, 'MCPClient', 'connect_mcp', { symbol: 'assemble_tool_pool', from: 'const prefixed', to: '\n      const schema' }, { symbol: 'assemble_tool_pool', from: 'tools.push', to: '\n      policies.set' }, 'MCP_HOST_POLICY'],
};
for (const [chapter, mapping] of Object.entries(chapters)) {
  const source = readFileSync(join(root, chapter, 'code.ts'), 'utf8');
  const tree = ts.createSourceFile('code.ts', source, ts.ScriptTarget.Latest, true);
  const symbols = new Map();
  for (const statement of tree.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name) symbols.set(statement.name.text, statement.getText(tree));
    if (ts.isClassDeclaration(statement) && statement.name) for (const member of statement.members) if (member.name) symbols.set(`${statement.name.text}.${member.name.getText(tree)}`, member.getText(tree));
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) symbols.set(declaration.name.getText(tree), statement.getText(tree));
  }
  const snippet = (item) => {
    if (Array.isArray(item)) return item.map(snippet).join('\n\n');
    if (typeof item === 'object' && item.source) return item.source;
    let text = symbols.get(typeof item === 'object' ? item.symbol : item);
    if (!text) throw new Error(`Missing snippet: ${chapter}/${JSON.stringify(item)}`);
    if (typeof item === 'object') {
      const start = text.indexOf(item.from); if (start < 0) throw new Error(`Missing start: ${chapter}/${item.from}`);
      const end = text.indexOf(item.to, start); if (end < 0) throw new Error(`Missing end: ${chapter}/${item.to}`);
      text = text.slice(start, end);
    }
    return text.trim();
  };
  for (const name of ['README.md', 'README.zh.md', 'README.ja.md']) {
    let document = readFileSync(join(reference, chapter, name), 'utf8');
    let index = 0;
    document = document.replace(/```python[^\n]*\n[\s\S]*?\n```/g, () => {
      if (!mapping[index]) throw new Error(`Unmapped block ${chapter}/${name}/${index}`);
      return `\x60\x60\x60typescript\n${snippet(mapping[index++])}\n\x60\x60\x60`;
    });
    if (index !== mapping.length) throw new Error(`Block count differs ${chapter}/${name}: ${index}`);
    document = document.replace(/\bpython(?:3)?\s+(?:s\d+_[\w]+\/)?code\.py/g, `npm run ${chapter.slice(0, 3)}`)
      .replace(/cd learn-claude-code\b(?!\/learn-claude-code-ts)/g, 'cd learn-claude-code/learn-claude-code-ts')
      .replaceAll('`code.py`', '`code.ts`');
    document = document.replaceAll('pip install -r requirements.txt', 'npm ci')
      .replaceAll('cp .env.example .env', 'cp -n .env.example .env')
      .replaceAll('requirements.txt', 'package.json')
      .replaceAll('code.py', 'code.ts')
      .replaceAll('XXX.py', 'XXX.ts')
      .replaceAll('file.py', 'file.ts')
      .replaceAll('a.py', 'a.ts').replaceAll('b.py', 'b.ts')
      .replaceAll('hello.py', 'hello.ts').replaceAll('test.py', 'test.ts')
      .replaceAll('Refactor s05_todo_write/example/hello.ts: add type hints, docstrings, and a main guard', 'Refactor s05_todo_write/example/hello.ts: add explicit types, JSDoc, and a main guard')
      .replaceAll('Create a Python package under s05_todo_write/example/demo_pkg with __init__.py, utils.py, and tests/test_utils.py', 'Create a TypeScript module under s05_todo_write/example/demo_pkg with index.ts, utils.ts, and tests/utils.test.ts')
      .replaceAll('Delegate: read all .py files in agents/ and summarize what each one does', 'Delegate: read s01_agent_loop/code.ts and s02_tool_use/code.ts and summarize what each one does')
      .replaceAll('s06_subagent/example/string_tools.py with a slugify(text: str)', 's06_subagent/example/string_tools.ts with a slugify(text: string)')
      .replaceAll('Run pip list in the background and find all Python files in this directory', 'Run npm list --depth=0 in the background and find all TypeScript files in this directory')
      .replaceAll('Python files', 'TypeScript files').replaceAll('Python 文件', 'TypeScript 文件').replaceAll('Python ファイル', 'TypeScript ファイル').replaceAll('Pythonファイル', 'TypeScriptファイル')
      .replaceAll('all .py files', 'all .ts files').replaceAll('全 .py ファイル', '全 .ts ファイル').replaceAll('所有 .py 文件', '所有 .ts 文件');
    // Prose describes the native Node runtime; implementation snippets stay untouched.
    document = document.split(/(^```[^\n]*\n[\s\S]*?^```\s*$)/gm).map((part, index) => index % 2 ? part : part
      .replaceAll('Python process', 'Node.js process').replaceAll('Python 进程', 'Node.js 进程').replaceAll('Python プロセス', 'Node.js プロセス')
      .replace(/daemon thread/gi, 'background async task').replace(/main thread/gi, 'foreground turn')
      .replace(/scheduler thread/gi, 'scheduler timer').replace(/queue processor thread/gi, 'queue processor task')
      .replace(/\bthreads\b/gi, 'async tasks').replace(/\bthread\b/gi, 'async task')
      .replaceAll('主线程', '前台回合').replaceAll('daemon 线程', '后台异步任务').replaceAll('线程', '异步任务')
      .replaceAll('メインスレッド', 'フォアグラウンドターン').replaceAll('daemon スレッド', 'バックグラウンド非同期タスク').replaceAll('スレッド', '非同期タスク')
      .replaceAll('task_id=task.id, require_plan=True', 'task.id, true')).join('');
    document = document
      .replace('but bash is unrestricted — `rm -rf /` still runs.', 'bash has a small deny list, while s03 adds a unified permission gate.')
      .replace('但 bash 不受限制，`rm -rf /` 还是能跑。', 'bash 有简短的拒绝列表；s03 将增加统一的权限入口。')
      .replace('bash は制限なし — `rm -rf /` はまだ実行できる。', 'bash には短い拒否リストがあり、s03 で統一した権限確認を追加する。')
      .replace('but bash is unrestricted. Ask it to "clean up the project," and it might run `rm -rf /`.', 'bash has only a small deny list and no unified approval gate for destructive operations.')
      .replace('但 bash 不受限制。让它"清理一下项目"，可能执行 `rm -rf /`。', 'bash 只有简短的拒绝列表，尚无统一的破坏性操作审批入口。')
      .replace('bash は制限なし。「プロジェクトを掃除して」と頼むと、`rm -rf /` を実行しかねない。', 'bash には短い拒否リストだけがあり、破壊的な操作を統一して確認する仕組みがない。');
    const reuse = chapter.startsWith('s15_') ? 's09 memory' : chapter.startsWith('s16_') ? 's15 host' : '';
    const note = name === 'README.zh.md'
      ? '> **TS 对照版**：实现范围和跨章引用以 Python 原版为准；标识符沿用 Python。代码块摘自本章实现，可能省略 import、外层类或分支。'
      : name === 'README.ja.md'
      ? '> **TypeScript 対照版**：実装範囲と章間の参照は Python 原版に従い、識別子を保持します。コード例は実装の抜粋です。'
      : '> **TypeScript reference edition**: implementation boundaries and chapter imports follow Python. Identifiers are preserved. Code blocks are implementation excerpts and may omit enclosing declarations.';
    document = document.replace(/^(# [^\n]+\n)/, `$1\n${note}${reuse ? ` (${reuse})` : ''}\n`);
    const footer = name === 'README.zh.md' ? `\n\n## TypeScript 对齐与验证\n\n[code.ts](code.ts) 是独立运行入口；[Python 原版](../../${chapter}/code.py) 是行为依据。Promise/子进程 I/O 对应 Python 的同步调用与线程；文件和锁的适配以原版各章节为准。原图保持原文件名和字节。\n\n在 TS 工程目录执行 \x60npm run test:${chapter.slice(0, 3)}\x60。差分测试通过假模型运行未修改的 Python 原版，因此还需要 Python 3 与 PyYAML。它们验证离线行为；真实 API、全部入口和全项目最终检查的状态统一记录在[对齐记录](../docs/parity-audit.md)。\n`
      : name === 'README.ja.md' ? `\n\n## TypeScript の検証\n\n実行入口は [code.ts](code.ts)、参照実装は [Python 原版](../../${chapter}/code.py) です。章のテストは \x60npm run test:${chapter.slice(0, 3)}\x60。差分テストには Python 3 と PyYAML が必要です。全体の検証状況は[対照記録](../docs/parity-audit.md)を参照してください。\n`
      : `\n\n## TypeScript verification\n\nRun [code.ts](code.ts) with \x60npm run ${chapter.slice(0, 3)}\x60 and tests with \x60npm run test:${chapter.slice(0, 3)}\x60. Differential tests execute the unmodified [Python reference](../../${chapter}/code.py) with fake model responses and require Python 3 and PyYAML. See the [alignment audit](../docs/parity-audit.md) for full-project and live-API verification status.\n`;
    writeFileSync(join(root, chapter, name), document.trimEnd() + footer);
  }
}
console.log(`Updated reference examples in ${Object.keys(chapters).length} chapters.`);
