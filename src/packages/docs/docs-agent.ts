import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HostContext, Telemetry } from '../../package-contract.ts';
import { createTelemetry } from '../../telemetry.ts';

export type DocsOptions = { extensions: string[]; ignoredDirectories: string[]; provider: 'openai' | 'openrouter'; model: string };
export type DocsAgentStatus = 'idle' | 'working' | 'error';
export type DocsAgentMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: string };
export type DocsAgentDocument = { path: string; content: string };
export type DocsAgentTurn = { messages: readonly DocsAgentMessage[]; document: DocsAgentDocument; selectedText?: string; threadId: string };
export type DocsAgentUpdate = { kind: 'assistant'; text: string };
export type DocsAgentRuntime = { stream(turn: DocsAgentTurn, signal: AbortSignal): AsyncIterable<DocsAgentUpdate>; dispose(): Promise<void> };
export type DocsAgentRuntimeFactoryOptions = { apiKey: string; context: HostContext; options: DocsOptions; telemetry: Telemetry; onMutation(paths: string[]): void };
export type DocsAgentRuntimeFactory = (options: DocsAgentRuntimeFactoryOptions) => Promise<DocsAgentRuntime>;
export type DocsAgentSnapshot = { messages: DocsAgentMessage[]; status: DocsAgentStatus; hasSession: boolean; error: string | null };
export type DocsAgentEvent =
  | { type: 'snapshot'; snapshot: DocsAgentSnapshot }
  | { type: 'message'; message: DocsAgentMessage }
  | { type: 'status'; status: DocsAgentStatus }
  | { type: 'error'; message: string }
  | { type: 'credential-required' }
  | { type: 'mutation-committed'; affectedPaths: string[] }
  | { type: 'stopped' }
  | { type: 'done' };

export class DocsAgentBusyError extends Error { status = 409; constructor() { super('A prompt is already running.'); this.name = 'DocsAgentBusyError'; } }
class CredentialRequiredError extends Error {}
const messageId = () => crypto.randomUUID();
const newThreadId = () => crypto.randomUUID();
const maxDocumentBytes = 512 * 1024;
class DocsDocumentError extends Error { status = 404; }

function isIgnored(relativePath: string, options: DocsOptions): boolean {
  return relativePath.split(path.sep).some((segment) => options.ignoredDirectories.includes(segment));
}
function isMarkdown(relativePath: string, options: DocsOptions): boolean {
  return options.extensions.some((extension) => relativePath.toLowerCase().endsWith(extension.toLowerCase()));
}
function contained(root: string, candidate: string): boolean { return candidate === root || candidate.startsWith(`${root}${path.sep}`); }

async function documentFilename(context: HostContext, options: DocsOptions, requestedPath: string): Promise<{ relativePath: string; filename: string }> {
  if (typeof requestedPath !== 'string' || !requestedPath.trim()) throw new DocsDocumentError('Document path must be a non-empty string.');
  const relativePath = context.resolveRepositoryPath(requestedPath);
  if (!relativePath || isIgnored(relativePath, options) || !isMarkdown(relativePath, options)) throw new DocsDocumentError('Markdown document not found.');
  const filename = path.resolve(context.repositoryRoot, relativePath);
  const physicalRoot = await realpath(context.repositoryRoot);
  let stats;
  try { stats = await lstat(filename); } catch (error) { if ((error as { code?: unknown })?.code === 'ENOENT') throw new DocsDocumentError('Markdown document not found.'); throw error; }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new DocsDocumentError('Markdown document must be a regular file.');
  const physicalFilename = await realpath(filename);
  if (!contained(physicalRoot, physicalFilename)) throw new DocsDocumentError('Document path escapes the repository.');
  return { relativePath, filename };
}

export async function readDocsDocument(context: HostContext, options: DocsOptions, requestedPath: string): Promise<DocsAgentDocument> {
  const resolved = await documentFilename(context, options, requestedPath);
  const content = await readFile(resolved.filename, 'utf8');
  return { path: resolved.relativePath.split(path.sep).join('/'), content };
}

async function writeDocsDocument(context: HostContext, options: DocsOptions, requestedPath: string, content: string): Promise<string> {
  if (Buffer.byteLength(content, 'utf8') > maxDocumentBytes) throw new Error('Document content exceeds the 512 KB limit.');
  const resolved = await documentFilename(context, options, requestedPath);
  const directory = path.dirname(resolved.filename);
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory() || await realpath(directory) !== path.dirname(await realpath(resolved.filename))) throw new Error('Document directory must be a regular directory.');
  const mode = (await lstat(resolved.filename)).mode & 0o777;
  const temporary = path.join(directory, `.${path.basename(resolved.filename)}.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode });
    await rename(temporary, resolved.filename);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return resolved.relativePath.split(path.sep).join('/');
}

export function createDocsAgentSession({ context, options, credentialProvider, runtimeFactory, telemetry: providedTelemetry }: { context: HostContext; options: DocsOptions; credentialProvider(): Promise<string | null>; runtimeFactory: DocsAgentRuntimeFactory; telemetry?: Telemetry }) {
  const telemetry = providedTelemetry || createTelemetry({ config: { mode: 'off' } });
  let threadId = newThreadId();
  let agentTelemetry = telemetry.child({ package: 'docs', component: 'agent' }).session(threadId);
  let runtime: DocsAgentRuntime | null = null;
  let status: DocsAgentStatus = 'idle';
  let error: string | null = null;
  let messages: DocsAgentMessage[] = [];
  let generation = 0;
  let starting = false;
  let closing: Promise<void> | null = null;
  let assistantId: string | null = null;
  let activeTurn: { controller: AbortController; completion: Promise<void> } | null = null;
  const listeners = new Set<(event: DocsAgentEvent) => void>();
  const snapshot = (): DocsAgentSnapshot => ({ messages: messages.map((message) => ({ ...message })), status, hasSession: Boolean(runtime), error });
  const emit = (event: DocsAgentEvent) => listeners.forEach((listener) => listener(event));
  const setStatus = (next: DocsAgentStatus) => { status = next; emit({ type: 'status', status }); };
  const close = async (current: DocsAgentRuntime, reportFailure = false) => {
    const pending = current.dispose();
    closing = pending;
    try { await pending; }
    catch (cause) {
      agentTelemetry.error('Docs agent runtime disposal failed', { error: cause });
      if (reportFailure) { error = 'Docs agent cleanup failed.'; setStatus('error'); emit({ type: 'error', message: error }); }
    } finally { if (closing === pending) closing = null; }
  };
  const onUpdate = (turn: number, update: DocsAgentUpdate) => {
    if (turn !== generation || !update.text) return;
    const prior = assistantId ? messages.find((message) => message.id === assistantId) : undefined;
    if (prior) prior.content += update.text;
    else {
      const message = { id: messageId(), role: 'assistant' as const, content: update.text, createdAt: new Date().toISOString() };
      assistantId = message.id;
      messages.push(message);
    }
    const message = messages.find((item) => item.id === assistantId);
    if (message) emit({ type: 'message', message: { ...message } });
  };
  const ensure = async (turn: number): Promise<DocsAgentRuntime> => {
    if (runtime) return runtime;
    const apiKey = await credentialProvider();
    if (!apiKey?.trim()) { emit({ type: 'credential-required' }); throw new CredentialRequiredError(); }
    const next = await runtimeFactory({ apiKey, context, options, telemetry: agentTelemetry, onMutation: (paths) => { if (turn === generation) emit({ type: 'mutation-committed', affectedPaths: [...paths] }); } });
    if (turn !== generation) { await next.dispose(); throw new Error('Docs agent session was reset.'); }
    runtime = next;
    return runtime;
  };
  const run = async (turn: number, current: DocsAgentRuntime, document: DocsAgentDocument, selectedText: string | undefined, controller: AbortController, turnSpan: ReturnType<Telemetry['span']>) => {
    try {
      for await (const update of current.stream({ messages: messages.map((message) => ({ ...message })), document, selectedText, threadId }, controller.signal)) onUpdate(turn, update);
      if (controller.signal.aborted) { if (turn === generation) { assistantId = null; setStatus('idle'); emit({ type: 'stopped' }); } return; }
      if (turn === generation && status === 'working') { assistantId = null; setStatus('idle'); turnSpan.end({ status: 'ok' }); emit({ type: 'done' }); }
    } catch (cause) {
      if (controller.signal.aborted) { if (turn === generation) { assistantId = null; setStatus('idle'); emit({ type: 'stopped' }); } return; }
      if (turn !== generation) return;
      turnSpan.fail(cause, { status: 500 });
      if (runtime === current) { runtime = null; void close(current); }
      error = 'Docs agent request failed.';
      setStatus('error');
      emit({ type: 'error', message: error });
    } finally { if (activeTurn?.controller === controller) activeTurn = null; }
  };
  return {
    snapshot,
    subscribe(listener: (event: DocsAgentEvent) => void) { listeners.add(listener); listener({ type: 'snapshot', snapshot: snapshot() }); return () => listeners.delete(listener); },
    async submitPrompt({ prompt, selectedPath, selectedText }: { prompt: string; selectedPath: string; selectedText?: string }) {
      if (closing) await closing;
      const content = prompt.trim();
      if (!content) throw new Error('Prompt must not be empty.');
      if (status === 'working' || starting) throw new DocsAgentBusyError();
      const turn = generation;
      const turnSpan = agentTelemetry.span('docs.agent.turn', { selectedPath, input: [{ role: 'user', content }] });
      starting = true; error = null;
      try {
        const document = await readDocsDocument(context, options, selectedPath);
        const current = await ensure(turn);
        if (turn !== generation) throw new Error('Docs agent session was reset.');
        const user = { id: messageId(), role: 'user' as const, content, createdAt: new Date().toISOString() };
        messages.push(user); assistantId = null; emit({ type: 'message', message: { ...user } }); setStatus('working');
        const controller = new AbortController();
        const running = { controller, completion: Promise.resolve() };
        activeTurn = running;
        running.completion = run(turn, current, document, selectedText?.trim() || undefined, controller, turnSpan);
        void running.completion;
        return { accepted: true as const };
      } catch (cause) {
        if (turn === generation && cause instanceof CredentialRequiredError) { turnSpan.end({ status: 'credential-required' }); setStatus('idle'); return { accepted: false as const, credentialRequired: true as const }; }
        if (turn === generation) { turnSpan.fail(cause, { status: 500 }); error = cause instanceof Error ? cause.message : String(cause); setStatus('error'); emit({ type: 'error', message: error }); }
        throw cause;
      } finally { if (turn === generation) starting = false; }
    },
    async stop() {
      const current = activeTurn;
      if (status !== 'working' || !current) return { stopped: false as const, state: snapshot() };
      current.controller.abort();
      await current.completion;
      return { stopped: true as const, state: snapshot() };
    },
    async reset() {
      if (closing) await closing;
      generation += 1; starting = false;
      const running = activeTurn; if (running) running.controller.abort();
      const current = runtime; runtime = null; assistantId = null; messages = []; error = null; setStatus('idle');
      if (running) await running.completion;
      if (current) await close(current, true);
      threadId = newThreadId(); agentTelemetry = telemetry.child({ package: 'docs', component: 'agent' }).session(threadId);
      emit({ type: 'snapshot', snapshot: snapshot() });
      return snapshot();
    },
    async dispose() { await this.reset(); listeners.clear(); },
  };
}

export { documentFilename, writeDocsDocument };
