import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { buildMarkdownTree, discoverMarkdownFiles, readMarkdown } from '../../content.ts';
import { createMarkdownRenderer } from '../../markdown.ts';
import type { HostContext, HostResponse, PackageDefinition, PackageInput, PackageRegistration, Telemetry } from '../../package-contract.ts';
import { createDocumentationAgentSession, type DocumentationAgentRuntimeFactory, type DocumentationOptions } from './documentation-agent.ts';
import { createDocumentationDeepAgentsRuntimeFactory } from './documentation-deepagents.ts';

const metadata = { id: 'documentation', version: '1.0.0', hostVersion: '1', label: 'Documentation', order: 20 } as const;
const runFile = promisify(execFile);
const CREDENTIAL_PATH = '.resonance/documentation-agent.env';
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isMissing = (error: unknown) => Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT');
const within = (root: string, candidate: string) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
class CredentialInputError extends Error { status = 400; }

function isStringArray(value: unknown, predicate: (item: string) => boolean): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string' && predicate(item));
}

export function documentationInput(input: PackageInput): DocumentationOptions {
  const extensions = input.extensions === undefined ? ['.md', '.markdown'] : input.extensions;
  const ignoredDirectories = input.ignoredDirectories === undefined ? ['.git', 'node_modules'] : input.ignoredDirectories;
  const provider = input.provider === undefined ? 'openrouter' : input.provider;
  const model = input.model === undefined ? 'deepseek/deepseek-v4-flash' : input.model;
  if (!isStringArray(extensions, (value) => value.startsWith('.'))) throw new Error('Documentation extensions must be an array of dotted strings.');
  if (!isStringArray(ignoredDirectories, (value) => value.length > 0)) throw new Error('Documentation ignoredDirectories must be an array of non-empty strings.');
  if (provider !== 'openai' && provider !== 'openrouter') throw new Error('Documentation provider must be openai or openrouter.');
  if (typeof model !== 'string' || !model.trim() || model.length > 256) throw new Error('Documentation model must be a non-empty string of at most 256 characters.');
  return { extensions: [...extensions], ignoredDirectories: [...ignoredDirectories], provider, model: model.trim() };
}

async function credentialLocations(root: string) {
  const physicalRoot = await realpath(path.resolve(root));
  const directory = path.join(physicalRoot, '.resonance');
  const filename = path.join(directory, 'documentation-agent.env');
  if (!within(physicalRoot, directory) || !within(physicalRoot, filename)) throw new Error('Credential path escapes the repository.');
  return { root: physicalRoot, directory, filename };
}
function credentialName(provider: DocumentationOptions['provider']): string { return provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'; }
async function regularCredential(filename: string): Promise<boolean> {
  let stats;
  try { stats = await lstat(filename); } catch (error) { if (isMissing(error)) return false; throw error; }
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o777) !== 0o600) throw new Error('Documentation credential file must be a regular 0600 file.');
  return true;
}
async function secureCredentialDirectory(directory: string): Promise<void> {
  let stats;
  try { stats = await lstat(directory); }
  catch (error) {
    if (!isMissing(error)) throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    stats = await lstat(directory);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory() || await realpath(directory) !== directory) throw new Error('Documentation credential directory must be a regular directory.');
}
async function isTracked(root: string): Promise<boolean> {
  try { await runFile('git', ['-C', root, 'ls-files', '--error-unmatch', '--', CREDENTIAL_PATH], { encoding: 'utf8' }); return true; }
  catch { return false; }
}
async function readCredential(root: string, provider: DocumentationOptions['provider']): Promise<string | null> {
  const locations = await credentialLocations(root);
  let directoryStats;
  try { directoryStats = await lstat(locations.directory); } catch (error) { if (isMissing(error)) return null; throw error; }
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) throw new Error('Documentation credential directory must be a regular directory.');
  await secureCredentialDirectory(locations.directory);
  if (!await regularCredential(locations.filename)) return null;
  const match = /^(OPENAI_API_KEY|OPENROUTER_API_KEY)=([^\r\n]+)\n?$/.exec(await readFile(locations.filename, 'utf8'));
  if (!match || match[1] !== credentialName(provider) || !match[2].trim() || match[2] !== match[2].trim()) throw new Error('Documentation credential file is invalid.');
  return match[2];
}
async function writeCredential(root: string, provider: DocumentationOptions['provider'], apiKey: string): Promise<void> {
  if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey) || apiKey !== apiKey.trim()) throw new CredentialInputError('Credential must be a single-line API key.');
  const locations = await credentialLocations(root);
  await secureCredentialDirectory(locations.directory);
  if (await isTracked(locations.root)) throw new Error('Credential file must not be tracked.');
  await regularCredential(locations.filename);
  const temporary = path.join(locations.directory, `.documentation-agent.${crypto.randomUUID()}.tmp`);
  try { await writeFile(temporary, `${credentialName(provider)}=${apiKey}\n`, { encoding: 'utf8', mode: 0o600 }); await rename(temporary, locations.filename); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}

function sendError(response: HostResponse, error: unknown, telemetry?: Telemetry): void {
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : 500;
  const message = error instanceof Error ? error.message : String(error);
  telemetry?.error('Documentation route failed', { error, status });
  response.json(status, { error: message });
}

function createRouteHandler(options: DocumentationOptions, kind: 'tree' | 'document') {
  const renderer = createMarkdownRenderer();
  return async (request, response, hostContext: HostContext) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (kind === 'tree') {
      const documents = await discoverMarkdownFiles(hostContext.repositoryRoot, options);
      response.json(200, { rootName: path.basename(path.resolve(hostContext.repositoryRoot)), documents, tree: buildMarkdownTree(documents) });
      return;
    }
    const relativePath = hostContext.resolveRepositoryPath(requestUrl.searchParams.get('path') || '');
    const ignored = relativePath?.split(path.sep).some((segment) => options.ignoredDirectories.includes(segment));
    if (!relativePath || ignored || !options.extensions.some((extension) => relativePath.toLowerCase().endsWith(extension.toLowerCase()))) { response.json(404, { error: 'Markdown document not found' }); return; }
    try {
      const content = await readMarkdown(hostContext.repositoryRoot, relativePath);
      response.json(200, { path: relativePath.split(path.sep).join('/'), content, html: renderer.render(content) });
    } catch { response.json(404, { error: 'Markdown document not found' }); }
  };
}

export function createDocumentationPackage({ runtimeFactory }: { runtimeFactory?: DocumentationAgentRuntimeFactory } = {}): PackageDefinition {
  return {
    metadata,
    register(context: HostContext, input: PackageInput): PackageRegistration {
      const options = documentationInput(input);
      const telemetry = context.telemetry.child({ package: metadata.id });
      const agent = createDocumentationAgentSession({ context, options, telemetry, credentialProvider: () => readCredential(context.repositoryRoot, options.provider), runtimeFactory: runtimeFactory || createDocumentationDeepAgentsRuntimeFactory({ provider: options.provider, model: options.model }) });
      const activeStreams = new Set<() => void>();
      return {
        metadata,
        routes: [
          { method: 'GET', path: '/api/documentation/tree', handler: createRouteHandler(options, 'tree') },
          { method: 'GET', path: '/api/documentation/document', handler: createRouteHandler(options, 'document') },
          { method: 'GET', path: '/api/documentation/agent/state', handler: async (_request, response) => response.json(200, agent.snapshot()) },
          { method: 'GET', path: '/api/documentation/agent/events', handler: async (request, response) => {
            const stream = response.sse(); let closed = false; let unsubscribe: (() => void) | null = null; let cleanupBeforeSubscribe = false; let resolveClosed = () => { };
            const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
            const close = () => { if (closed) return; closed = true; if (unsubscribe) unsubscribe(); else cleanupBeforeSubscribe = true; activeStreams.delete(close); stream.close(); resolveClosed(); };
            activeStreams.add(close); request.onAbort(close); response.onClose(close); unsubscribe = agent.subscribe((event) => { stream.write(event); if (response.closed) close(); }); if (cleanupBeforeSubscribe) unsubscribe(); await closedPromise;
          } },
          { method: 'POST', path: '/api/documentation/agent/prompt', handler: async (request, response) => {
            try {
              const body = await request.readJson<{ prompt?: unknown; selectedPath?: unknown; selectedText?: unknown }>(64 * 1024);
              if (!isRecord(body) || typeof body.prompt !== 'string' || !body.prompt.trim() || typeof body.selectedPath !== 'string' || !body.selectedPath.trim() || (body.selectedText !== undefined && typeof body.selectedText !== 'string') || (typeof body.selectedText === 'string' && body.selectedText.length > 32 * 1024)) { response.json(400, { error: 'prompt and selectedPath must be non-empty strings; selectedText must be at most 32 KB.' }); return; }
              response.json(202, await agent.submitPrompt({ prompt: body.prompt, selectedPath: body.selectedPath, selectedText: body.selectedText as string | undefined }));
            } catch (error) { sendError(response, error, telemetry); }
          } },
          { method: 'POST', path: '/api/documentation/agent/credential', handler: async (request, response) => {
            try { const body = await request.readJson<{ apiKey?: unknown }>(8 * 1024); if (!isRecord(body) || typeof body.apiKey !== 'string') { response.json(400, { error: 'apiKey must be a string.' }); return; } await writeCredential(context.repositoryRoot, options.provider, body.apiKey); response.json(200, { ok: true }); }
            catch (error) { sendError(response, error, telemetry); }
          } },
          { method: 'POST', path: '/api/documentation/agent/stop', handler: async (_request, response) => { try { response.json(200, await agent.stop()); } catch (error) { sendError(response, error, telemetry); } } },
          { method: 'POST', path: '/api/documentation/agent/reset', handler: async (_request, response) => { try { response.json(200, { state: await agent.reset() }); } catch (error) { sendError(response, error, telemetry); } } },
        ],
        assets: [
          { path: '/assets/documentation/documentation.js', file: 'src/packages/documentation/documentation.js', contentType: 'text/javascript; charset=utf-8' },
          { path: '/assets/documentation/documentation.css', file: 'src/packages/documentation/documentation.css', contentType: 'text/css; charset=utf-8' },
        ],
        navigation: [{ id: metadata.id, label: metadata.label, order: metadata.order }],
        browser: { id: metadata.id, entry: '/assets/documentation/documentation.js', stylesheet: '/assets/documentation/documentation.css' },
        dispose: async () => { [...activeStreams].forEach((close) => close()); await agent.dispose(); },
      };
    },
  };
}

export const documentationPackage = createDocumentationPackage();
export default documentationPackage;
