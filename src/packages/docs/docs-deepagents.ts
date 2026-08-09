import { readFile } from 'node:fs/promises';
import { createDeepAgent } from 'deepagents';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from 'langchain';
import { z } from 'zod/v4';
import type { DocsAgentRuntime, DocsAgentRuntimeFactory, DocsAgentRuntimeFactoryOptions, DocsAgentTurn, DocsAgentUpdate } from './docs-agent.ts';
import { readDocsDocument, writeDocsDocument } from './docs-agent.ts';

const docsSystemPrompt = 'You are Resonance Docs Agent. Help the user improve repository Markdown. The active document and any highlighted passage are supplied with each request. Read the active document before editing it. Use the document tools to make requested changes, and explain what you changed. Do not claim a change was made unless a document tool reports success.';
const maxEditBytes = 512 * 1024;

function textOf(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return '';
  const content = (chunk as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => typeof part === 'string' ? [part] : part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('');
}

function documentTools(options: DocsAgentRuntimeFactoryOptions) {
  const documentPath = z.string().trim().min(1).max(512);
  const content = z.string().max(maxEditBytes);
  const mutation = (path: string) => { options.onMutation([path]); return JSON.stringify({ changed: true, affectedPaths: [path] }); };
  return [
    tool(async ({ path }) => JSON.stringify(await readDocsDocument(options.context, options.options, path)), {
      name: 'read_document', description: 'Read one repository Markdown document. Use the active document path supplied in the request unless the user asks about another document.', schema: z.object({ path: documentPath }),
    }),
    tool(async ({ path, content: nextContent }) => mutation(await writeDocsDocument(options.context, options.options, path, nextContent)), {
      name: 'replace_document', description: 'Replace the complete contents of one repository Markdown document after making the requested edit.', schema: z.object({ path: documentPath, content }),
    }),
    tool(async ({ path, oldText, newText, replaceAll }) => {
      const document = await readDocsDocument(options.context, options.options, path);
      if (!oldText || !document.content.includes(oldText)) return JSON.stringify({ changed: false, error: 'The old text was not found in the document.' });
      const occurrences = document.content.split(oldText).length - 1;
      if (!replaceAll && occurrences > 1) return JSON.stringify({ changed: false, error: `The old text occurs ${occurrences} times; provide a more specific passage or set replaceAll.` });
      const updated = replaceAll ? document.content.split(oldText).join(newText) : document.content.replace(oldText, newText);
      return mutation(await writeDocsDocument(options.context, options.options, path, updated));
    }, {
      name: 'edit_document', description: 'Replace an exact passage in one Markdown document. Use replaceAll only when every occurrence should change.', schema: z.object({ path: documentPath, oldText: z.string().min(1).max(maxEditBytes), newText: z.string().max(maxEditBytes), replaceAll: z.boolean().default(false) }),
    }),
  ];
}

function activeContext(turn: DocsAgentTurn): string {
  const selected = turn.selectedText ? `<highlighted-text>\n${turn.selectedText}\n</highlighted-text>` : '<highlighted-text />';
  return `<active-document path="${turn.document.path}">\n<document-content>\n${turn.document.content}\n</document-content>\n${selected}\n</active-document>`;
}

export class DocsDeepAgentsRuntime implements DocsAgentRuntime {
  constructor(private readonly agent: any, private readonly telemetry: DocsAgentRuntimeFactoryOptions['telemetry']) {}
  async *stream(turn: DocsAgentTurn, signal: AbortSignal): AsyncIterable<DocsAgentUpdate> {
    const messages = turn.messages.map((message, index) => ({ role: message.role, content: message.role === 'user' && index === turn.messages.length - 1 ? `${activeContext(turn)}\n\n<user-request>\n${message.content}\n</user-request>` : message.content }));
    const streamSpan = this.telemetry.span('docs.model.stream', { observationType: 'generation', input: [{ role: 'system', content: docsSystemPrompt }, ...messages] });
    const responses: string[] = [];
    let chunks = 0;
    try {
      const stream = await this.agent.stream({ messages }, { configurable: { thread_id: turn.threadId }, streamMode: 'messages', signal });
      for await (const value of stream) {
        const [chunk, metadata] = value as [unknown, { langgraph_node?: unknown }];
        if (metadata?.langgraph_node !== 'model' && metadata?.langgraph_node !== 'model_request') continue;
        const text = textOf(chunk);
        if (!text) continue;
        chunks += 1;
        if (responses.length) responses[responses.length - 1] += text; else responses.push(text);
        yield { kind: 'assistant', text };
      }
      streamSpan.end({ status: signal.aborted ? 'stopped' : 'ok', chunks, output: responses.map((content) => ({ role: 'assistant', content })) });
    } catch (error) {
      if (signal.aborted) streamSpan.end({ status: 'stopped', chunks });
      else streamSpan.fail(error, { chunks, output: responses.map((content) => ({ role: 'assistant', content })) });
      throw error;
    }
  }
  async dispose() {}
}

export function createDocsDeepAgentsRuntimeFactory({ provider, model }: { provider: 'openai' | 'openrouter'; model: string }): DocsAgentRuntimeFactory {
  return async (options) => {
    const skill = await readFile(new URL('./skills/edit-docs/SKILL.md', import.meta.url), 'utf8');
    const runtimeTelemetry = options.telemetry.child({ provider, model });
    const agent = createDeepAgent({
      model: new ChatOpenAI({ model, apiKey: options.apiKey, temperature: 0, configuration: provider === 'openrouter' ? { baseURL: 'https://openrouter.ai/api/v1' } : {} }),
      tools: documentTools(options),
      checkpointer: false,
      systemPrompt: `${docsSystemPrompt} Read and follow this guidance before acting:\n${skill}`,
    });
    return new DocsDeepAgentsRuntime(agent, runtimeTelemetry);
  };
}
