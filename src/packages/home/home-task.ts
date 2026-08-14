import { readFileSync } from 'node:fs';
import { readFile, rename, writeFile, mkdir, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { discoverMarkdownFiles } from '../../content.ts';
import { validateRepositoryConfig } from '../../config.ts';
import type { RepositoryConfig } from '../../package-contract.ts';
import type { HostContext, PackageInput, TaskContribution, TaskPreview } from '../../package-contract.ts';
import { homeAgentInput, homeInput } from './home-source.ts';
import { createHomeAgentRuntimeFactory, readHomeCredential, type HomeDocument as HomeAgentDocument, type HomeAgentFactoryOptions, type HomeAgentRuntimeFactory } from './home-agent.ts';

const TARGET_SOURCE = '.resonance/home.html';
const skillContent = readFileSync(new URL('./skills/create-home-page/SKILL.md', import.meta.url), 'utf8');
const MAX_DOCUMENTS = 40;
const MAX_DOCUMENT_BYTES = 8 * 1024;
const MAX_PROPOSAL_BYTES = 48 * 1024;
const IGNORED_DIRECTORIES = ['.git', 'node_modules', '.resonance', 'vendor', 'dist', 'build', 'coverage'];
const credentialPattern = /(^|\/)(?:\.env(?:\.[^/]*)?|.*(?:secret|credential|token|key).*\.(?:json|ya?ml|toml|ini|txt))$/i;

type HomeTaskState = { dismissedSignature?: string };
type HomeEvidence = HomeAgentDocument;
export type HomeTaskOptions = {
  onSourceChanged?: (source: string) => void;
  runtimeFactory?: HomeAgentRuntimeFactory;
  credentialProvider?: (provider: 'openai' | 'openrouter') => Promise<string | null>;
};

function normalized(value: string): string { return value.split(path.sep).join('/'); }
function signature(source: string, valid: boolean, evidence: string): string { return `${source}:${valid ? 'valid' : 'missing'}:${evidence}`; }
function isSafeDocument(relativePath: string): boolean { return !credentialPattern.test(relativePath) && !relativePath.split('/').some((part) => part.startsWith('.env')); }
async function homeSource(context: HostContext, source: string): Promise<{ source: string; valid: boolean }> {
  const relative = context.resolveRepositoryPath(source);
  if (!relative) return { source, valid: false };
  try { await readFile(path.join(context.repositoryRoot, relative)); return { source: normalized(relative), valid: true }; }
  catch { return { source, valid: false }; }
}
async function documentationPaths(context: HostContext): Promise<string[]> {
  try {
    const candidates = await discoverMarkdownFiles(context.repositoryRoot, { ignoredDirectories: IGNORED_DIRECTORIES });
    return candidates.map(normalized).filter(isSafeDocument).filter((relativePath) => Boolean(context.resolveRepositoryPath(relativePath))).slice(0, MAX_DOCUMENTS);
  } catch { return []; }
}
async function documentationEvidence(context: HostContext): Promise<HomeEvidence[]> {
  const evidence: HomeEvidence[] = [];
  for (const relative of await documentationPaths(context)) {
    const contained = context.resolveRepositoryPath(relative);
    if (!contained) continue;
    try {
      const content = (await readFile(path.join(context.repositoryRoot, contained), 'utf8')).slice(0, MAX_DOCUMENT_BYTES).trim();
      if (content) evidence.push({ path: relative, content });
    } catch { /* A changing or unreadable document is not evidence. */ }
    if (evidence.length >= MAX_DOCUMENTS) break;
  }
  return evidence;
}
export function validateHomeHtml(content: string): void {
  if (!content.trim() || Buffer.byteLength(content, 'utf8') > MAX_PROPOSAL_BYTES) throw new Error('Home preview must be non-empty and smaller than 48 KB.');
  if (!/class=["'][^"']*\brepository-home\b/i.test(content)) throw new Error('Home preview must use the repository-home scope.');
  if ((content.match(/<h1\b[^>]*>/gi) || []).length !== 1) throw new Error('Home preview must contain exactly one h1.');
  if (/<style\b|<link\b|\bstyle\s*=|<script\b|<iframe\b|javascript:|\son\w+\s*=/i.test(content)) throw new Error('Home preview must use Home CSS and contain no inline styles or executable content.');
}
async function atomicWrite(filename: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filename);
}

export function createHomeTask(context: HostContext, input: PackageInput, { onSourceChanged = () => {}, runtimeFactory = createHomeAgentRuntimeFactory(), credentialProvider = (provider) => readHomeCredential(context.appRoot, provider) }: HomeTaskOptions = {}): TaskContribution {
  const config = homeAgentInput(input);
  const fallback = homeInput(input).source;
  let activeSource = fallback;
  const readState = async (): Promise<HomeTaskState> => (await context.state?.read<HomeTaskState>()) || {};
  const current = () => homeSource(context, activeSource);
  const createPreview = async (content: string): Promise<TaskPreview> => {
    validateHomeHtml(content);
    const home = await current();
    return {
      id: crypto.randomUUID(),
      title: home.valid ? 'Create a curated Home page' : 'Repair the Home page source',
      summary: 'A purpose-built landing page is ready for review. Apply it only when the copy and design feel right.',
      content,
      contentType: 'html',
      stylesheet: '/assets/home/home.css',
      affectedPaths: [TARGET_SOURCE, '.resonance/config.json'],
      configuration: { package: 'home', source: TARGET_SOURCE, replaces: home.source === 'README.md' ? null : home.source },
      requiresConfirmation: true,
    };
  };
  return {
    id: 'create-home-page',
    category: 'onboarding',
    label: 'Create Home page',
    description: 'Use the Home curation agent to create a polished landing page from bounded repository documentation.',
    start: { label: 'Create Home page', prompt: 'Create the Home page now. Read and follow the create-home-page skill, inspect the bounded repository documentation, and stage the complete HTML preview for review.' },
    completedUrl: '/',
    instructions: 'Use the create-home-page skill before inspecting documentation. The agent must propose an engaging HTML landing page, not a documentation index or chat transcript.',
    skills: [{ id: 'create-home-page', name: 'Create Home page', content: skillContent }],
    operations: [
      { id: 'inspect-documentation', description: 'Read contained Markdown documentation while excluding dependencies, generated content, credentials, and repository internals.' },
      { id: 'apply-home-page', description: 'Atomically write the repository-owned Home source and update Home configuration after confirmation.' },
    ],
    async evaluate() {
      const home = await current();
      const state = await readState();
      const evidenceKey = (await documentationPaths(context)).join('|');
      const dismissed = state.dismissedSignature === signature(home.source, home.valid, evidenceKey);
      if (home.source !== 'README.md' && home.valid) return { status: 'complete', reason: 'A valid non-default Home source is configured.', evidence: [home.source] };
      if (dismissed) return { status: 'dismissed', reason: 'Dismissed until the Home source evidence changes.' };
      return { status: 'available', required: !home.valid, summary: home.valid ? 'The default README source can be turned into a dedicated Home page.' : 'The configured Home source is missing or invalid.' };
    },
    async createAgent(scope) {
      const apiKey = await credentialProvider(config.provider);
      if (!apiKey) {
        const credentialPath = path.join(context.repositoryRoot, '.resonance', 'home-agent.env');
        throw new Error(`No ${config.provider} API key is configured. Set ${config.provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'OPENAI_API_KEY'} or add ${credentialPath} with mode 0600.`);
      }
      const documents = await documentationEvidence(context);
      const repositoryName = path.basename(context.repositoryRoot);
      const options: HomeAgentFactoryOptions = {
        apiKey,
        provider: config.provider,
        model: config.model,
        repositoryName,
        skill: scope.skills.find((skill) => skill.id === 'create-home-page')?.content || skillContent,
        documents,
        preview: createPreview,
        telemetry: context.telemetry.child({ package: 'home', task: 'create-home-page' }),
      };
      return runtimeFactory(options);
    },
    async apply(preview) {
      if (!preview.content) throw new Error('Home preview has no content.');
      validateHomeHtml(preview.content);
      if (!context.resolveRepositoryPath('.resonance')) throw new Error('The repository state directory is not contained.');
      const target = path.join(context.repositoryRoot, TARGET_SOURCE);
      try { await lstat(target); if (!context.resolveRepositoryPath(TARGET_SOURCE)) throw new Error('The existing Home target is not contained.'); }
      catch (error) { if (error instanceof Error && /not contained/.test(error.message)) throw error; }
      const configFilename = path.join(context.repositoryRoot, '.resonance/config.json');
      const previousTarget = await readFile(target, 'utf8').catch(() => null);
      const previousConfig = await readFile(configFilename, 'utf8');
      const repositoryConfig = validateRepositoryConfig(JSON.parse(previousConfig), '.resonance/config.json');
      if (!repositoryConfig.packages.home) throw new Error('Home is no longer configured.');
      const next: RepositoryConfig = { ...repositoryConfig, packages: { ...repositoryConfig.packages, home: { ...repositoryConfig.packages.home, source: TARGET_SOURCE } } };
      validateRepositoryConfig(next, '.resonance/config.json');
      try {
        await atomicWrite(target, preview.content);
        await atomicWrite(configFilename, `${JSON.stringify(next, null, 2)}\n`);
      } catch (error) {
        if (previousTarget === null) await unlink(target).catch(() => {}); else await atomicWrite(target, previousTarget).catch(() => {});
        await atomicWrite(configFilename, previousConfig).catch(() => {});
        throw error;
      }
      activeSource = TARGET_SOURCE;
      onSourceChanged(TARGET_SOURCE);
      return { message: 'Home source applied.', affectedPaths: [TARGET_SOURCE, '.resonance/config.json'] };
    },
    async validate() {
      const home = await current();
      const valid = home.source === TARGET_SOURCE && home.valid;
      return { valid, status: valid ? 'complete' : 'attention-needed', message: valid ? 'The configured Home source is valid.' : 'The resulting Home source is not valid.', evidence: home.valid ? [home.source] : [] };
    },
    async dismiss() {
      const home = await current();
      const evidenceKey = (await documentationPaths(context)).join('|');
      await context.state?.write({ dismissedSignature: signature(home.source, home.valid, evidenceKey) });
    },
  };
}
