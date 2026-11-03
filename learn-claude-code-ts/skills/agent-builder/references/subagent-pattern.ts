import type Anthropic from '@anthropic-ai/sdk';
/** Subagent Pattern - child context and allowed tools are isolated from the parent. */
interface AgentType { description: string; tools: '*' | string[]; prompt: string }
export const AGENT_TYPES: Record<string, AgentType> = {
  "explore": {
    "description": "Read-only agent for exploring code, finding files, searching",
    "tools": [
      "bash",
      "read_file"
    ],
    "prompt": "You are an exploration agent. Search and analyze, but NEVER modify files. Return a concise summary of what you found."
  },
  "code": {
    "description": "Full agent for implementing features and fixing bugs",
    "tools": "*",
    "prompt": "You are a coding agent. Implement the requested changes efficiently. Return a summary of what you changed."
  },
  "plan": {
    "description": "Planning agent for designing implementation strategies",
    "tools": [
      "bash",
      "read_file"
    ],
    "prompt": "You are a planning agent. Analyze the codebase and output a numbered implementation plan. Do NOT make any changes."
  }
};
export function get_agent_descriptions(): string { return Object.entries(AGENT_TYPES).map(([name, cfg]) => `- ${name}: ${cfg.description}`).join('\n'); }
export function get_tools_for_agent(agent_type: string, base_tools: Anthropic.Tool[]): Anthropic.Tool[] {
  const allowed = AGENT_TYPES[agent_type]?.tools ?? '*'; return allowed === '*' ? base_tools : base_tools.filter((tool) => allowed.includes(tool.name));
}
export const TASK_TOOL: Anthropic.Tool = {
  name: 'Task', description: `Spawn a subagent for a focused subtask.

Subagents run in ISOLATED context - they don't see parent's history.
Use this to keep the main conversation clean.

Agent types:
${get_agent_descriptions()}

Example uses:
- Task(explore): "Find all files using the auth module"
- Task(plan): "Design a migration strategy for the database"
- Task(code): "Implement the user registration form"
`, input_schema: { type: 'object', properties: {
  description: { type: 'string', description: 'Short task name (3-5 words) for progress display' },
  prompt: { type: 'string', description: 'Detailed instructions for the subagent' },
  agent_type: { type: 'string', enum: Object.keys(AGENT_TYPES), description: 'Type of agent to spawn' },
}, required: ['description', 'prompt', 'agent_type'] },
};
export async function run_task(description: string, prompt: string, agent_type: string, client: Pick<Anthropic, 'messages'>,
  model: string, workdir: string, base_tools: Anthropic.Tool[], execute_tool: (name: string, args: Record<string, any>) => string | Promise<string>): Promise<string> {
  if (!Object.hasOwn(AGENT_TYPES, agent_type)) return `Error: Unknown agent type '${agent_type}'`;
  const config = AGENT_TYPES[agent_type];
  const sub_system = `You are a ${agent_type} subagent at ${workdir}.

${config.prompt}

Complete the task and return a clear, concise summary.`;
  const sub_tools = get_tools_for_agent(agent_type, base_tools);
  const sub_messages: Anthropic.MessageParam[] = [{ role: 'user', content: prompt }];
  console.log(`  [${agent_type}] ${description}`); const start = Date.now(); let tool_count = 0;
  let response: Anthropic.Message;
  while (true) {
    response = await client.messages.create({ model, system: sub_system, messages: sub_messages, tools: sub_tools, max_tokens: 8000 });
    if (response.stop_reason !== 'tool_use') break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tc of response.content) if (tc.type === 'tool_use') {
      tool_count += 1; const output = await execute_tool(tc.name, tc.input as Record<string, unknown>);
      results.push({ type: 'tool_result', tool_use_id: tc.id, content: output });
      process.stdout.write(`\r  [${agent_type}] ${description} ... ${tool_count} tools, ${((Date.now() - start) / 1000).toFixed(1)}s`);
    }
    sub_messages.push({ role: 'assistant', content: response.content }); sub_messages.push({ role: 'user', content: results });
  }
  process.stdout.write(`\r  [${agent_type}] ${description} - done (${tool_count} tools, ${((Date.now() - start) / 1000).toFixed(1)}s)\n`);
  for (const block of response.content) if (block.type === 'text') return block.text;
  return '(subagent returned no text)';
}
// Parent dispatch: run_task(args.description, args.prompt, args.agent_type, client, MODEL, WORKDIR, BASE_TOOLS, execute_tool).
// The parent exposes [...BASE_TOOLS, TASK_TOOL]; the child receives only BASE_TOOLS.
