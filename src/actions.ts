import { randomUUID } from 'node:crypto';
import type { HostContext, HostRequest, HostResponse, PackageMetadata, TaskContribution, TaskEvaluation, TaskPreview, TaskResult, TaskStatus, TaskUpdate, TaskValidation } from './package-contract.ts';

export type ActionTask = { id: string; packageId: string; packageLabel: string; task: TaskContribution; context: HostContext };
type ActionMessage = { id: string; role: 'user' | 'assistant'; content: string };
type ActionSnapshot = {
  taskId: string;
  status: TaskStatus;
  messages: ActionMessage[];
  preview: TaskPreview | null;
  pendingConfirmation: { id: string; preview: TaskPreview } | null;
  validation: TaskValidation | null;
  error: string | null;
};
type ActionEvent =
  | { type: 'snapshot'; snapshot: ActionSnapshot }
  | { type: 'message'; message: ActionMessage }
  | { type: 'status'; status: TaskStatus }
  | { type: 'preview'; preview: TaskPreview }
  | { type: 'validation'; validation: TaskValidation }
  | { type: 'confirmation-required'; confirmation: { id: string; preview: TaskPreview } }
  | { type: 'error'; message: string }
  | { type: 'stopped' }
  | { type: 'done' };
type ActionState = {
  messages: ActionMessage[];
  status: TaskStatus;
  preview: TaskPreview | null;
  pendingConfirmation: { id: string; preview: TaskPreview } | null;
  validation: TaskValidation | null;
  error: string | null;
  controller: AbortController | null;
  agent: Awaited<ReturnType<NonNullable<TaskContribution['createAgent']>>> | null;
  listeners: Set<(event: ActionEvent) => void>;
};

const terminalStatuses = new Set<TaskStatus>(['complete', 'dismissed', 'unavailable']);
const activeStatuses = new Set<TaskStatus>(['available', 'attention-needed', 'blocked', 'in-progress']);
const messageId = () => randomUUID();

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function query(request: HostRequest, key: string): string | null { return new URL(request.url, 'http://127.0.0.1').searchParams.get(key); }
function objectBody(value: unknown): Record<string, unknown> | null { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function sendError(response: HostResponse, error: unknown, fallback = 500): void {
  const status = typeof error === 'object' && error && 'status' in error && typeof error.status === 'number' ? error.status : fallback;
  response.json(status, { error: errorMessage(error) });
}
class ActionError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

export class ActionManager {
  private readonly tasks: ReadonlyMap<string, ActionTask>;
  private readonly states = new Map<string, ActionState>();
  private disposed = false;

  constructor(tasks: Map<string, ActionTask>) { this.tasks = tasks; }

  private state(taskId: string): ActionState {
    let state = this.states.get(taskId);
    if (!state) {
      state = { messages: [], status: 'available', preview: null, pendingConfirmation: null, validation: null, error: null, controller: null, agent: null, listeners: new Set() };
      this.states.set(taskId, state);
    }
    return state;
  }
  private task(taskId: string): ActionTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new ActionError(404, 'Task not found.');
    return task;
  }
  private emit(taskId: string, event: ActionEvent): void { const state = this.state(taskId); state.listeners.forEach((listener) => listener(event)); }
  private async evaluate(entry: ActionTask): Promise<TaskEvaluation> {
    try {
      const evaluation = await entry.task.evaluate();
      const state = this.states.get(entry.id);
      if (state?.status === 'in-progress' && evaluation.status === 'available') return { ...evaluation, status: 'in-progress' };
      return evaluation;
    } catch (error) {
      return { status: 'unavailable', reason: errorMessage(error) };
    }
  }
  private async publicTask(entry: ActionTask) {
    const evaluation = await this.evaluate(entry);
    return { id: entry.id, packageId: entry.packageId, packageLabel: entry.packageLabel, category: entry.task.category, label: entry.task.label, description: entry.task.description, ...evaluation };
  }
  async list(): Promise<unknown[]> {
    const result = [];
    for (const entry of this.tasks.values()) {
      const item = await this.publicTask(entry);
      if (activeStatuses.has(item.status)) result.push(item);
    }
    return result;
  }
  async detail(taskId: string): Promise<unknown> {
    const entry = this.task(taskId);
    const evaluation = await this.publicTask(entry);
    return { ...evaluation, skills: (entry.task.skills || []).map(({ id, name }) => ({ id, name })), operations: entry.task.operations || [] };
  }
  snapshot(taskId: string): ActionSnapshot {
    const state = this.state(taskId);
    return { taskId, status: state.status, messages: state.messages.map((message) => ({ ...message })), preview: state.preview ? { ...state.preview, affectedPaths: [...state.preview.affectedPaths] } : null, pendingConfirmation: state.pendingConfirmation ? { id: state.pendingConfirmation.id, preview: { ...state.pendingConfirmation.preview, affectedPaths: [...state.pendingConfirmation.preview.affectedPaths] } } : null, validation: state.validation ? { ...state.validation, evidence: state.validation.evidence ? [...state.validation.evidence] : undefined } : null, error: state.error };
  }
  subscribe(taskId: string, listener: (event: ActionEvent) => void): () => void { const listeners = this.state(taskId).listeners; listeners.add(listener); return () => listeners.delete(listener); }
  async prompt(taskId: string, prompt: string): Promise<void> {
    const entry = this.task(taskId); const state = this.state(taskId);
    if (state.controller) throw new ActionError(409, 'A Task session is already running.');
    const controller = new AbortController(); state.controller = controller; state.error = null; state.status = 'in-progress';
    const user = { id: messageId(), role: 'user' as const, content: prompt }; state.messages.push(user); this.emit(taskId, { type: 'message', message: user }); this.emit(taskId, { type: 'status', status: state.status });
    try {
      if (entry.task.prepare) {
        const preview = await entry.task.prepare({ prompt, signal: controller.signal });
        if (controller.signal.aborted) { state.status = 'available'; this.emit(taskId, { type: 'stopped' }); this.emit(taskId, { type: 'status', status: state.status }); return; }
        state.preview = preview; state.pendingConfirmation = { id: randomUUID(), preview }; const assistant = { id: messageId(), role: 'assistant' as const, content: preview.summary || 'A proposal is ready for your review.' }; state.messages.push(assistant);
        this.emit(taskId, { type: 'message', message: assistant }); this.emit(taskId, { type: 'preview', preview }); this.emit(taskId, { type: 'confirmation-required', confirmation: state.pendingConfirmation });
      } else if (entry.task.createAgent) {
        state.agent = await entry.task.createAgent({ signal: controller.signal, emit: (update) => this.applyUpdate(taskId, update), skills: entry.task.skills || [], operations: entry.task.operations || [], instructions: entry.task.instructions });
        for await (const update of state.agent.prompt(prompt, controller.signal)) { if (controller.signal.aborted) break; this.applyUpdate(taskId, update); }
      } else {
        throw new ActionError(503, 'This Task has no agent operation.');
      }
      if (!controller.signal.aborted) { state.status = 'available'; this.emit(taskId, { type: 'status', status: state.status }); this.emit(taskId, { type: 'done' }); }
    } catch (error) {
      if (controller.signal.aborted) { state.status = 'available'; this.emit(taskId, { type: 'stopped' }); this.emit(taskId, { type: 'status', status: state.status }); }
      else { state.error = errorMessage(error); state.status = 'attention-needed'; this.emit(taskId, { type: 'error', message: state.error }); this.emit(taskId, { type: 'status', status: state.status }); }
    } finally { state.controller = null; if (state.agent?.dispose) await Promise.resolve(state.agent.dispose()).catch(() => {}); state.agent = null; }
  }
  private applyUpdate(taskId: string, update: TaskUpdate): void {
    const state = this.state(taskId);
    if (update.kind === 'preview') { state.preview = update.preview; state.pendingConfirmation = { id: randomUUID(), preview: update.preview }; this.emit(taskId, { type: 'preview', preview: update.preview }); this.emit(taskId, { type: 'confirmation-required', confirmation: state.pendingConfirmation }); return; }
    if (update.kind === 'validation') { state.validation = update.validation; this.emit(taskId, { type: 'validation', validation: update.validation }); return; }
    if (update.kind === 'status') { state.status = update.status; this.emit(taskId, { type: 'status', status: update.status }); return; }
    if (!update.text) return;
    const prior = state.messages[state.messages.length - 1];
    if (prior?.role === 'assistant') prior.content += update.text;
    else { const message = { id: messageId(), role: 'assistant' as const, content: update.text }; state.messages.push(message); }
    this.emit(taskId, { type: 'message', message: { ...state.messages[state.messages.length - 1] } });
  }
  async preview(taskId: string): Promise<TaskPreview> {
    const entry = this.task(taskId);
    if (!entry.task.prepare) throw new ActionError(409, 'This Task does not provide a preview.');
    const preview = await entry.task.prepare({ prompt: 'Prepare the proposed Task changes.', signal: new AbortController().signal });
    const state = this.state(taskId); state.preview = preview; state.pendingConfirmation = { id: randomUUID(), preview };
    this.emit(taskId, { type: 'preview', preview }); this.emit(taskId, { type: 'confirmation-required', confirmation: state.pendingConfirmation });
    return preview;
  }
  async confirm(taskId: string, confirmationId: string): Promise<TaskResult> {
    const entry = this.task(taskId); const state = this.state(taskId); const pending = state.pendingConfirmation;
    if (!pending || pending.id !== confirmationId) throw new ActionError(409, 'Confirmation is missing or expired.');
    if (!entry.task.apply) throw new ActionError(409, 'This Task cannot apply changes.');
    try {
      const result = await entry.task.apply(pending.preview, { signal: new AbortController().signal });
      if (entry.task.validate) { state.validation = await entry.task.validate(); this.emit(taskId, { type: 'validation', validation: state.validation }); if (!state.validation.valid) throw new ActionError(422, state.validation.message); }
      state.pendingConfirmation = null; state.status = 'complete'; state.preview = null; state.error = null; this.emit(taskId, { type: 'status', status: state.status }); this.emit(taskId, { type: 'done' });
      return result;
    } catch (error) { state.error = errorMessage(error); state.status = 'attention-needed'; this.emit(taskId, { type: 'error', message: state.error }); this.emit(taskId, { type: 'status', status: state.status }); throw error; }
  }
  async dismiss(taskId: string): Promise<void> { const entry = this.task(taskId); if (!entry.task.dismiss) throw new ActionError(409, 'This Task cannot be dismissed.'); await entry.task.dismiss(); const state = this.state(taskId); state.status = 'dismissed'; this.emit(taskId, { type: 'status', status: state.status }); }
  async stop(taskId: string): Promise<void> { const state = this.state(taskId); state.controller?.abort(); if (state.agent?.dispose) await Promise.resolve(state.agent.dispose()).catch(() => {}); state.status = 'available'; this.emit(taskId, { type: 'stopped' }); this.emit(taskId, { type: 'status', status: state.status }); }
  async reset(taskId: string): Promise<void> { const state = this.state(taskId); if (state.controller) throw new ActionError(409, 'Stop the active Task before resetting it.'); if (state.agent?.reset) await state.agent.reset(); state.messages = []; state.preview = null; state.pendingConfirmation = null; state.validation = null; state.error = null; state.status = 'available'; this.emit(taskId, { type: 'snapshot', snapshot: this.snapshot(taskId) }); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; for (const [taskId] of this.states) await this.stop(taskId); }

  routes() {
    const route = (method: 'GET' | 'POST', path: string, handler: (request: HostRequest, response: HostResponse) => Promise<void>) => ({ method, path, handler: async (request: HostRequest, response: HostResponse) => { try { await handler(request, response); } catch (error) { if (!response.closed) sendError(response, error); } } });
    return [
      route('GET', '/api/actions/tasks', async (_request, response) => response.json(200, { tasks: await this.list() })),
      route('GET', '/api/actions/task', async (request, response) => response.json(200, await this.detail(query(request, 'task') || ''))),
      route('GET', '/api/actions/state', async (request, response) => { const taskId = query(request, 'task') || ''; this.task(taskId); response.json(200, this.snapshot(taskId)); }),
      route('GET', '/api/actions/events', async (request, response) => { const taskId = query(request, 'task') || ''; this.task(taskId); const stream = response.sse(); stream.write({ type: 'snapshot', snapshot: this.snapshot(taskId) }); const unsubscribe = this.subscribe(taskId, (event) => stream.write(event)); response.onClose(() => { unsubscribe(); stream.close(); }); }),
      route('POST', '/api/actions/prompt', async (request, response) => { const body = objectBody(await request.readJson(64 * 1024)); if (!body || typeof body.taskId !== 'string' || !body.taskId || typeof body.prompt !== 'string' || !body.prompt.trim()) throw new ActionError(400, 'taskId and prompt must be non-empty strings.'); const taskId = body.taskId as string; const prompt = body.prompt as string; this.task(taskId); request.onAbort(() => { void this.stop(taskId).catch(() => {}); }); void this.prompt(taskId, prompt).catch(() => {}); response.json(202, { accepted: true }); }),
      route('POST', '/api/actions/preview', async (request, response) => { const body = objectBody(await request.readJson(8 * 1024)); if (!body || typeof body.taskId !== 'string') throw new ActionError(400, 'taskId must be a string.'); response.json(200, await this.preview(body.taskId)); }),
      route('POST', '/api/actions/confirm', async (request, response) => { const body = objectBody(await request.readJson(8 * 1024)); if (!body || typeof body.taskId !== 'string' || typeof body.confirmationId !== 'string') throw new ActionError(400, 'taskId and confirmationId are required.'); response.json(200, await this.confirm(body.taskId, body.confirmationId)); }),
      route('POST', '/api/actions/dismiss', async (request, response) => { const body = objectBody(await request.readJson(8 * 1024)); if (!body || typeof body.taskId !== 'string') throw new ActionError(400, 'taskId must be a string.'); await this.dismiss(body.taskId); response.json(200, { ok: true }); }),
      route('POST', '/api/actions/stop', async (request, response) => { const body = objectBody(await request.readJson(8 * 1024)); if (!body || typeof body.taskId !== 'string') throw new ActionError(400, 'taskId must be a string.'); await this.stop(body.taskId); response.json(200, { ok: true }); }),
      route('POST', '/api/actions/reset', async (request, response) => { const body = objectBody(await request.readJson(8 * 1024)); if (!body || typeof body.taskId !== 'string') throw new ActionError(400, 'taskId must be a string.'); await this.reset(body.taskId); response.json(200, { ok: true }); }),
    ];
  }
}

export function taskId(packageId: string, id: string): string { return `${packageId}:${id}`; }
export function createActionTask(metadata: PackageMetadata, task: TaskContribution, context: HostContext): ActionTask { return { id: taskId(metadata.id, task.id), packageId: metadata.id, packageLabel: metadata.label, task, context }; }
export function isValidTask(value: unknown): value is TaskContribution {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<TaskContribution>;
  if (typeof task.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(task.id) || typeof task.category !== 'string' || !task.category || typeof task.label !== 'string' || !task.label.trim() || typeof task.description !== 'string' || !task.description.trim() || typeof task.evaluate !== 'function') return false;
  if (task.skills !== undefined && (!Array.isArray(task.skills) || task.skills.some((skill) => !skill || typeof skill.id !== 'string' || !skill.id || typeof skill.name !== 'string' || !skill.name || typeof skill.content !== 'string') || new Set(task.skills.map((skill) => skill.id)).size !== task.skills.length)) return false;
  if (task.operations !== undefined && (!Array.isArray(task.operations) || task.operations.some((operation) => !operation || typeof operation.id !== 'string' || !operation.id || typeof operation.description !== 'string' || !operation.description) || new Set(task.operations.map((operation) => operation.id)).size !== task.operations.length)) return false;
  return (task.createAgent === undefined || typeof task.createAgent === 'function') && (task.prepare === undefined || typeof task.prepare === 'function') && (task.apply === undefined || typeof task.apply === 'function') && (task.validate === undefined || typeof task.validate === 'function') && (task.dismiss === undefined || typeof task.dismiss === 'function');
}
export function isTaskTerminal(status: TaskStatus): boolean { return terminalStatuses.has(status); }
