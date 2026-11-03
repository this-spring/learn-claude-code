import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
export interface RuntimeOptions {
  client: Pick<Anthropic, 'messages'>;
  model: string;
  workdir?: string;
  question?: (prompt: string) => Promise<string>;
  signal?: AbortSignal;
}

export function workspace(context: TestContext): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'learn-ts-')));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
export function response(content: Anthropic.ContentBlock[] = [{ type: 'text', text: 'done', citations: null }], stop: Anthropic.StopReason = 'end_turn'): Anthropic.Message {
  return { id: 'message', type: 'message', role: 'assistant', model: 'offline', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } as Anthropic.Message;
}
export function toolCall(name: string, input: Record<string, unknown> = {}, id = 'call'): Anthropic.ToolUseBlock {
  return { type: 'tool_use', name, input, id } as Anthropic.ToolUseBlock;
}
export function fixture(context: TestContext, replies: (Anthropic.Message | Error)[] = [response()]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client = { messages: { create: async (request: Anthropic.MessageCreateParamsNonStreaming) => {
    requests.push(structuredClone(request));
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected offline model request');
    if (reply instanceof Error) throw reply;
    return reply;
  } } } as unknown as RuntimeOptions['client'];
  const options: RuntimeOptions = { client, model: 'offline', workdir: workspace(context), question: async () => 'n' };
  return { options, requests };
}
