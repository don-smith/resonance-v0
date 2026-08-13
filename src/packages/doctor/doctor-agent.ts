import { createDeepAgent } from 'deepagents';
import { ChatOpenAI } from '@langchain/openai';
import type { Telemetry } from '../../package-contract.ts';
import { modelContextWindow } from '../../model-profiles.ts';
import { createTelemetry } from '../../telemetry.ts';
import type { DoctorResult } from './doctor-runner.ts';

export type DoctorAgentStatus = 'idle' | 'working' | 'error';
export type DoctorAgentMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: string };
export type DoctorAgentCheck = { id: string; label: string; description: string; result?: DoctorResult };
export type DoctorAgentContext = { inputTokens: number; maxInputTokens: number };
export type DoctorAgentSnapshot = { messages: DoctorAgentMessage[]; status: DoctorAgentStatus; hasSession: boolean; error: string | null; context: DoctorAgentContext | null };
export type DoctorAgentUpdate = { kind: 'assistant'; text: string } | { kind: 'context'; context: DoctorAgentContext };
export type DoctorAgentRuntime = { stream(turn: { messages: readonly DoctorAgentMessage[]; check: DoctorAgentCheck; threadId: string }, signal: AbortSignal): AsyncIterable<DoctorAgentUpdate>; dispose(): Promise<void> };
export type DoctorAgentRuntimeFactory = (options: { apiKey: string; provider: 'openai' | 'openrouter'; model: string; telemetry: Telemetry }) => Promise<DoctorAgentRuntime>;

const systemPrompt = 'You are Resonance Doctor Agent. Explain repository check results, identify likely causes, and suggest concrete next steps. You may not run tests, change configuration, or modify files. Treat the supplied Doctor result as evidence and be explicit when no check has run.';
const messageId = () => crypto.randomUUID();
const newThreadId = () => crypto.randomUUID();
function textOf(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') return '';
  const content = (chunk as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((part) => typeof part === 'string' ? [part] : part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []).join('');
}
function inputTokensOf(chunk: unknown): number | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const message = chunk as { usage_metadata?: { input_tokens?: unknown }; response_metadata?: { usage?: { prompt_tokens?: unknown } } };
  const inputTokens = message.usage_metadata?.input_tokens ?? message.response_metadata?.usage?.prompt_tokens;
  return typeof inputTokens === 'number' && Number.isFinite(inputTokens) ? inputTokens : null;
}

export function createDoctorDeepAgentsRuntimeFactory(): DoctorAgentRuntimeFactory {
  return async ({ apiKey, provider, model, telemetry }) => {
    const chatModel = new ChatOpenAI({ model, apiKey, temperature: 0, configuration: provider === 'openrouter' ? { baseURL: 'https://openrouter.ai/api/v1' } : {} });
    const agent: any = createDeepAgent({ model: chatModel, checkpointer: false, systemPrompt });
    return {
      async *stream(turn, signal) {
        const selected = JSON.stringify({ id: turn.check.id, label: turn.check.label, description: turn.check.description, result: turn.check.result || null });
        const messages = turn.messages.map((message, index) => ({ role: message.role, content: message.role === 'user' && index === turn.messages.length - 1 ? `<doctor-check>\n${selected}\n</doctor-check>\n\n<user-request>\n${message.content}\n</user-request>` : message.content }));
        const span = telemetry.span('doctor.model.stream', { observationType: 'generation', input: [{ role: 'system', content: systemPrompt }, ...messages] });
        const responses: string[] = [];
        try {
          const stream = await agent.stream({ messages }, { configurable: { thread_id: turn.threadId }, streamMode: 'messages', signal });
          for await (const value of stream) {
            const [chunk, metadata] = value as unknown as [unknown, { langgraph_node?: unknown }];
            if (metadata?.langgraph_node !== 'model' && metadata?.langgraph_node !== 'model_request') continue;
            const inputTokens = inputTokensOf(chunk);
            const maxInputTokens = chatModel.profile.maxInputTokens ?? modelContextWindow(model);
            if (inputTokens !== null && maxInputTokens !== undefined) yield { kind: 'context', context: { inputTokens, maxInputTokens } };
            const text = textOf(chunk);
            if (!text) continue;
            if (responses.length) responses[responses.length - 1] += text; else responses.push(text);
            yield { kind: 'assistant', text };
          }
          span.end({ status: signal.aborted ? 'stopped' : 'ok', output: responses.map((content) => ({ role: 'assistant', content })) });
        } catch (error) {
          if (signal.aborted) span.end({ status: 'stopped', output: responses.map((content) => ({ role: 'assistant', content })) }); else span.fail(error, { output: responses.map((content) => ({ role: 'assistant', content })) });
          throw error;
        }
      },
      async dispose() {},
    };
  };
}

export function createDoctorAgentSession({ provider, model, credentialProvider, runtimeFactory, telemetry: providedTelemetry }: { provider: 'openai' | 'openrouter'; model: string; credentialProvider: () => Promise<string | null>; runtimeFactory: DoctorAgentRuntimeFactory; telemetry?: Telemetry }) {
  const telemetry = providedTelemetry || createTelemetry({ config: { mode: 'off' } });
  let threadId = newThreadId();
  let runtime: DoctorAgentRuntime | null = null;
  let status: DoctorAgentStatus = 'idle';
  let error: string | null = null;
  let context: DoctorAgentContext | null = null;
  let messages: DoctorAgentMessage[] = [];
  let assistantId: string | null = null;
  let active: { controller: AbortController; completion: Promise<void> } | null = null;
  let starting = false;
  const listeners = new Set<(event: { type: string; [key: string]: unknown }) => void>();
  const snapshot = (): DoctorAgentSnapshot => ({ messages: messages.map((message) => ({ ...message })), status, hasSession: Boolean(runtime), error, context: context ? { ...context } : null });
  const emit = (event: { type: string; [key: string]: unknown }) => listeners.forEach((listener) => listener(event));
  const setStatus = (next: DoctorAgentStatus) => { status = next; emit({ type: 'status', status }); };
  const run = async (current: DoctorAgentRuntime, check: DoctorAgentCheck, controller: AbortController) => {
    try {
      for await (const update of current.stream({ messages: messages.map((message) => ({ ...message })), check, threadId }, controller.signal)) {
        if (update.kind === 'context') { context = { inputTokens: Math.max(context?.inputTokens || 0, update.context.inputTokens), maxInputTokens: update.context.maxInputTokens }; emit({ type: 'context', context: { ...context } }); continue; }
        if (!update.text) continue;
        const assistant = assistantId ? messages.find((message) => message.id === assistantId) : undefined;
        if (assistant) assistant.content += update.text;
        else {
          const message = { id: messageId(), role: 'assistant' as const, content: update.text, createdAt: new Date().toISOString() };
          assistantId = message.id;
          messages.push(message);
        }
        const message = messages.find((item) => item.id === assistantId);
        if (message) emit({ type: 'message', message: { ...message } });
      }
      assistantId = null;
      if (controller.signal.aborted) { setStatus('idle'); emit({ type: 'stopped' }); } else { setStatus('idle'); emit({ type: 'done' }); }
    } catch (cause) {
      if (controller.signal.aborted) { assistantId = null; setStatus('idle'); emit({ type: 'stopped' }); }
      else { error = 'Doctor agent request failed.'; setStatus('error'); emit({ type: 'error', message: error }); }
    } finally { if (active?.controller === controller) active = null; }
  };
  return {
    snapshot,
    subscribe(listener: (event: any) => void) { listeners.add(listener); listener({ type: 'snapshot', snapshot: snapshot() }); return () => listeners.delete(listener); },
    async submitPrompt({ prompt, check }: { prompt: string; check: DoctorAgentCheck }) {
      if (status === 'working' || starting) throw Object.assign(new Error('A prompt is already running.'), { status: 409 });
      const apiKey = await credentialProvider();
      if (!apiKey?.trim()) { emit({ type: 'credential-required' }); return { accepted: false as const, credentialRequired: true as const }; }
      if (!runtime) runtime = await runtimeFactory({ apiKey, provider, model, telemetry });
      const user = { id: messageId(), role: 'user' as const, content: prompt.trim(), createdAt: new Date().toISOString() };
      messages.push(user); assistantId = null; error = null; emit({ type: 'message', message: { ...user } }); setStatus('working');
      const controller = new AbortController(); const completion = run(runtime, check, controller); active = { controller, completion }; void completion;
      return { accepted: true as const };
    },
    async stop() { if (!active || status !== 'working') return { stopped: false as const, state: snapshot() }; active.controller.abort(); await active.completion; return { stopped: true as const, state: snapshot() }; },
    async reset() { if (active) { active.controller.abort(); await active.completion; } if (runtime) await runtime.dispose(); runtime = null; assistantId = null; messages = []; error = null; context = null; threadId = newThreadId(); setStatus('idle'); emit({ type: 'snapshot', snapshot: snapshot() }); return snapshot(); },
    async dispose() { await this.reset(); listeners.clear(); },
  };
}
