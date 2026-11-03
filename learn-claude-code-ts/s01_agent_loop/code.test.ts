import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import test from "node:test";
import { agent_loop, run_bash } from "./code.js";

function nodeCommand(source: string): string {
  return `"${process.execPath}" -e "${source}"`;
}

function createFakeClient(contents: unknown[][]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = new Anthropic({
    apiKey: "offline-test-key",
    authToken: null,
    baseURL: "https://offline.invalid",
    maxRetries: 0,
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const content = contents.shift();
      assert.ok(content, "Unexpected extra model call");
      return new Response(JSON.stringify({
        id: `message-${requests.length}`,
        type: "message",
        role: "assistant",
        model: "offline-test-model",
        content,
        stop_reason: content.some((block) => (block as { type: string }).type === "tool_use")
          ? "end_turn"
          : "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      }), { headers: { "content-type": "application/json" } });
    },
  });
  return { client, requests };
}

test("bash captures stdout and stderr even when the command exits nonzero", () => {
  assert.equal(run_bash(nodeCommand("process.stdout.write('out'); process.stderr.write('err'); process.exit(2)")), "outerr");
});

test("bash handles empty output and replaces invalid UTF-8", () => {
  assert.equal(run_bash(""), "(no output)");
  assert.equal(run_bash(nodeCommand("process.exit(0)")), "(no output)");
  assert.equal(run_bash(nodeCommand("process.stdout.write(Buffer.from([255]))")), "\ufffd");
});

test("bash truncates results to 50,000 characters", () => {
  assert.equal(run_bash(nodeCommand("process.stdout.write('x'.repeat(60000))")), "x".repeat(50_000));
});

test("bash blocks the teaching example's dangerous patterns before execution", () => {
  for (const pattern of ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]) {
    assert.equal(run_bash(`echo "${pattern}"`), "Error: Dangerous command blocked");
  }
});

test("text-only and empty responses stop without an empty tool result", async () => {
  for (const content of [[], [{ type: "text", text: "done" }]]) {
    const { client, requests } = createFakeClient([content]);
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "hello" }];

    await agent_loop(messages, client, "offline-test-model");

    assert.equal(requests.length, 1);
    assert.deepEqual(messages, [
      { role: "user", content: "hello" },
      { role: "assistant", content },
    ]);
  }
});

test("tool calls are executed and paired with results over multiple rounds", async () => {
  const firstTurn = [
    { type: "text", text: "Checking" },
    { type: "tool_use", id: "tool-1", name: "bash", input: { command: nodeCommand("process.stdout.write('first')") } },
    { type: "tool_use", id: "tool-2", name: "bash", input: { command: nodeCommand("process.stdout.write('second')") } },
  ];
  const secondTurn = [
    { type: "tool_use", id: "tool-3", name: "bash", input: { command: nodeCommand("process.stdout.write('third')") } },
  ];
  const { client, requests } = createFakeClient([firstTurn, secondTurn, [{ type: "text", text: "done" }]]);
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "run commands" }];

  await agent_loop(messages, client, "offline-test-model");

  assert.equal(requests.length, 3);
  assert.equal(requests[0].model, "offline-test-model");
  assert.equal(requests[0].max_tokens, 8000);
  assert.ok(requests[0].tools?.some((tool) => "name" in tool && tool.name === "bash"));
  assert.equal(messages.length, 6);
  assert.deepEqual(messages[1], { role: "assistant", content: firstTurn });
  assert.deepEqual(messages[2], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tool-1", content: "first" },
      { type: "tool_result", tool_use_id: "tool-2", content: "second" },
    ],
  });
  assert.deepEqual(messages[4], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "tool-3", content: "third" }],
  });
  assert.deepEqual(requests[1].messages, messages.slice(0, 3));
  assert.deepEqual(requests[2].messages, messages.slice(0, 5));
});

test("s01 uses the command field directly regardless of tool name, matching Python", async () => {
  const { client } = createFakeClient([[{ type: 'tool_use', id: 'unknown', name: 'missing', input: { command: 'printf ran' } }], [{ type: 'text', text: 'done' }]]);
  const messages: Anthropic.MessageParam[] = [];
  await agent_loop(messages, client, 'offline');
  assert.deepEqual(messages[1].content, [{ type: 'tool_result', tool_use_id: 'unknown', content: 'ran' }]);
});
test("missing command arguments propagate instead of inventing error tool results", async () => {
  const { client } = createFakeClient([[{ type: 'tool_use', id: 'bad', name: 'bash', input: {} }]]);
  await assert.rejects(agent_loop([], client, 'offline'), /command/);
});
test('tool schema and shell outputs match unmodified Python', async (context) => {
  const { TOOLS } = await import('./code.js');
  const { pythonReference } = await import('../scripts/parity-helpers.js');
  const { workspace } = await import('../s04_hooks/test-helpers.js');
  assert.deepEqual({ TOOLS }, pythonReference('s01_agent_loop', workspace(context), {}).result);
  const calls = [{ name: 'run_bash', args: ['printf out; printf err >&2; exit 7'] }, { name: 'run_bash', args: ['printf nothing sudo'] }];
  assert.deepEqual(calls.map((call) => run_bash(call.args[0])), pythonReference('s01_agent_loop', workspace(context), { scenario: 'functions', calls }).result);
});
