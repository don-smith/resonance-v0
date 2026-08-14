export const MANIFEST_VERSION = 1;
export type PackageInput = Record<string, unknown>;
export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';
export type TelemetryFields = Readonly<Record<string, unknown>>;
export type TelemetrySpan = {
  event(name: string, fields?: TelemetryFields): void;
  end(fields?: TelemetryFields): void;
  fail(error: unknown, fields?: TelemetryFields): void;
};
export type Telemetry = {
  child(fields?: TelemetryFields): Telemetry;
  session(id: string, fields?: TelemetryFields): Telemetry;
  debug(message: string, fields?: TelemetryFields): void;
  info(message: string, fields?: TelemetryFields): void;
  warn(message: string, fields?: TelemetryFields): void;
  error(message: string, fields?: TelemetryFields): void;
  span(name: string, fields?: TelemetryFields): TelemetrySpan;
};
export type TelemetryController = Telemetry & {
  flush(): Promise<void>;
  dispose(): Promise<void>;
};
export type PackageScope = 'team' | 'member';
export type PackageConfig = PackageInput & { module?: string; enabled?: boolean };
export type RepositoryConfigMetadata = { name?: string; tagline?: string };
export type RepositoryConfig = { version: typeof MANIFEST_VERSION; repository?: RepositoryConfigMetadata; packages: Record<string, PackageConfig> };
export type PackageMetadata = { id: string; version: string; hostVersion: string; label: string; order: number };
export type RequestHeaders = Readonly<Record<string, string | string[] | undefined>>;
export type HostRequest = {
  url: string;
  headers: RequestHeaders;
  readJson<T>(maxBytes?: number): Promise<T>;
  onAbort(listener: () => void): void;
};
export type SseStream = { write(event: unknown): boolean; close(): void };
export type HostResponse = {
  json(status: number, body: unknown): void;
  sse(): SseStream;
  onClose(listener: () => void): void;
  readonly closed: boolean;
};
export type PackageState = { read<T = unknown>(): Promise<T | null>; write(value: unknown): Promise<void> };
export type HostContext = {
  repositoryRoot: string;
  appRoot: string;
  telemetry: Telemetry;
  state?: PackageState;
  resolveRepositoryPath(relativePath: string): string | null;
};
export type RouteHandler = (request: HostRequest, response: HostResponse, context: HostContext) => Promise<void>;
export type HttpMethod = 'GET' | 'POST';
export type RouteContribution = { method: HttpMethod; path: string; handler: RouteHandler };
export type AssetContribution = { path: string; file: string; contentType: string; root?: string };
export type NavigationContribution = { id: string; label: string; order: number; scope?: PackageScope };
export type BrowserContribution = { id: string; entry: string; stylesheet: string };
export type TaskStatus = 'available' | 'in-progress' | 'complete' | 'dismissed' | 'blocked' | 'attention-needed' | 'unavailable';
export type TaskCategory = 'onboarding' | 'maintenance' | 'recommendation' | (string & {});
export type TaskEvaluation = {
  status: TaskStatus;
  summary?: string;
  reason?: string;
  evidence?: string[];
  required?: boolean;
};
export type TaskSkill = { id: string; name: string; content: string };
export type TaskOperation = { id: string; description: string };
export type TaskStart = { label: string; prompt: string };
export type TaskPreview = {
  id: string;
  title: string;
  summary?: string;
  content?: string;
  contentType?: 'text' | 'html';
  stylesheet?: string;
  affectedPaths: string[];
  configuration?: unknown;
  requiresConfirmation: boolean;
};
export type TaskValidation = { valid: boolean; status: TaskStatus; message: string; evidence?: string[] };
export type TaskResult = { message?: string; affectedPaths?: string[]; validation?: TaskValidation };
export type TaskUpdate =
  | { kind: 'assistant'; text: string }
  | { kind: 'preview'; preview: TaskPreview }
  | { kind: 'validation'; validation: TaskValidation }
  | { kind: 'status'; status: TaskStatus };
export type TaskAgent = {
  prompt(prompt: string, signal: AbortSignal): AsyncIterable<TaskUpdate>;
  reset?(): void | Promise<void>;
  dispose?(): void | Promise<void>;
};
export type TaskContribution = {
  id: string;
  category: TaskCategory;
  label: string;
  description: string;
  skills?: readonly TaskSkill[];
  operations?: readonly TaskOperation[];
  start?: TaskStart;
  completedUrl?: string;
  instructions?: string;
  evaluate(): Promise<TaskEvaluation>;
  createAgent?(scope: { signal: AbortSignal; emit(update: TaskUpdate): void; skills: readonly TaskSkill[]; operations: readonly TaskOperation[]; instructions?: string }): Promise<TaskAgent>;
  prepare?(request: { prompt: string; signal: AbortSignal }): Promise<TaskPreview>;
  apply?(preview: TaskPreview, request: { signal: AbortSignal }): Promise<TaskResult>;
  validate?(): Promise<TaskValidation>;
  dismiss?(): Promise<void>;
};
export type PackageRegistration = {
  metadata: PackageMetadata;
  routes: RouteContribution[];
  assets: AssetContribution[];
  navigation: NavigationContribution[];
  browser: BrowserContribution;
  tasks?: TaskContribution[];
  dispose?: () => void | Promise<void>;
};
export type PackageDefinition = {
  metadata: PackageMetadata;
  scope?: PackageScope;
  packageRoot?: string;
  register(context: HostContext, input: PackageInput): PackageRegistration;
};
