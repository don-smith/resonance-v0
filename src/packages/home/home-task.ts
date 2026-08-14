import { readFile, rename, writeFile, mkdir, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { discoverMarkdownFiles } from '../../content.ts';
import { validateRepositoryConfig } from '../../config.ts';
import type { RepositoryConfig } from '../../package-contract.ts';
import type { HostContext, PackageInput, TaskContribution, TaskPreview } from '../../package-contract.ts';
import { homeInput } from './home-source.ts';

const TARGET_SOURCE = '.resonance/home.md';
const MAX_DOCUMENTS = 40;
const MAX_DOCUMENT_BYTES = 8 * 1024;
const MAX_PROPOSAL_BYTES = 48 * 1024;
const IGNORED_DIRECTORIES = ['.git', 'node_modules', '.resonance', 'vendor', 'dist', 'build', 'coverage'];
const credentialPattern = /(^|\/)(?:\.env(?:\.[^/]*)?|.*(?:secret|credential|token|key).*\.(?:json|ya?ml|toml|ini|txt))$/i;

type HomeTaskState = { dismissedSignature?: string };

function normalized(value: string): string { return value.split(path.sep).join('/'); }
function signature(source: string, valid: boolean, evidence: string): string { return `${source}:${valid ? 'valid' : 'missing'}:${evidence}`; }
function isSafeDocument(relativePath: string): boolean { return !credentialPattern.test(relativePath) && !relativePath.split('/').some((part) => part.startsWith('.env')); }
async function readConfig(root: string): Promise<RepositoryConfig> {
  const value = JSON.parse(await readFile(path.join(root, '.resonance/config.json'), 'utf8'));
  return validateRepositoryConfig(value, '.resonance/config.json');
}
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
async function documentationEvidence(context: HostContext): Promise<Array<{ path: string; excerpt: string }>> {
  const evidence: Array<{ path: string; excerpt: string }> = [];
  for (const relative of await documentationPaths(context)) {
    const contained = context.resolveRepositoryPath(relative);
    if (!contained) continue;
    try {
      const content = (await readFile(path.join(context.repositoryRoot, contained), 'utf8')).slice(0, MAX_DOCUMENT_BYTES).trim();
      if (content) evidence.push({ path: relative, excerpt: content.split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ').slice(0, 300) });
    } catch { /* A changing or unreadable document is not evidence. */ }
    if (evidence.length >= MAX_DOCUMENTS) break;
  }
  return evidence;
}
function proposal(repositoryName: string, evidence: Array<{ path: string; excerpt: string }>): string {
  const lines = [`# ${repositoryName}`, '', 'This landing page was prepared from repository documentation. Claims are linked to their source documents.', ''];
  if (!evidence.length) lines.push('No readable Markdown documentation was found yet.', '');
  else {
    lines.push('## Documentation', '');
    for (const item of evidence) lines.push(`### [${item.path}](${item.path})`, '', item.excerpt, '');
  }
  return `${lines.join('\n').slice(0, MAX_PROPOSAL_BYTES)}\n`;
}
async function atomicWrite(filename: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, filename);
}

export function createHomeTask(context: HostContext, input: PackageInput, { onSourceChanged = () => {} }: { onSourceChanged?: (source: string) => void } = {}): TaskContribution {
  const fallback = homeInput(input).source;
  let activeSource = fallback;
  const readState = async (): Promise<HomeTaskState> => (await context.state?.read<HomeTaskState>()) || {};
  const current = () => homeSource(context, activeSource);
  const createPreview = async (): Promise<TaskPreview> => {
    const home = await current();
    const evidence = await documentationEvidence(context);
    const repositoryName = path.basename(context.repositoryRoot);
    const content = proposal(repositoryName, evidence);
    return { id: crypto.randomUUID(), title: home.valid ? 'Create a curated Home page' : 'Repair the Home page source', summary: `Prepared a landing page from ${evidence.length} bounded documentation source${evidence.length === 1 ? '' : 's'}. Review the preview before applying it.`, content, affectedPaths: [TARGET_SOURCE, '.resonance/config.json'], configuration: { package: 'home', source: TARGET_SOURCE, replaces: home.source === 'README.md' ? null : home.source }, requiresConfirmation: true };
  };
  return {
    id: 'create-home-page', category: 'onboarding', label: 'Create Home page', description: 'Read bounded repository documentation and prepare a curated landing page.',
    skills: [{ id: 'home-page', name: 'Home page curation', content: 'Use only bounded repository documentation as evidence. Distinguish facts from recommendations and identify source documents.' }],
    operations: [{ id: 'inspect-documentation', description: 'Read contained Markdown documentation while excluding dependencies, generated content, credentials, and repository internals.' }, { id: 'apply-home-page', description: 'Atomically write the repository-owned Home source and update Home configuration after confirmation.' }],
    async evaluate() {
      const home = await current(); const state = await readState(); const evidenceKey = (await documentationPaths(context)).join('|'); const dismissed = state.dismissedSignature === signature(home.source, home.valid, evidenceKey);
      if (home.source !== 'README.md' && home.valid) return { status: 'complete', reason: 'A valid non-default Home source is configured.', evidence: [home.source] };
      if (dismissed) return { status: 'dismissed', reason: 'Dismissed until the Home source evidence changes.' };
      return { status: 'available', required: !home.valid, summary: home.valid ? 'The default README source can be curated into a dedicated Home page.' : 'The configured Home source is missing or invalid.' };
    },
    prepare: async () => createPreview(),
    async apply(preview) {
      if (!preview.content) throw new Error('Home preview has no content.');
      if (!context.resolveRepositoryPath('.resonance')) throw new Error('The repository state directory is not contained.');
      const target = path.join(context.repositoryRoot, TARGET_SOURCE);
      try { await lstat(target); if (!context.resolveRepositoryPath(TARGET_SOURCE)) throw new Error('The existing Home target is not contained.'); } catch (error) { if (error instanceof Error && /not contained/.test(error.message)) throw error; }
      const configFilename = path.join(context.repositoryRoot, '.resonance/config.json');
      const previousTarget = await readFile(target, 'utf8').catch(() => null);
      const previousConfig = await readFile(configFilename, 'utf8');
      const config = validateRepositoryConfig(JSON.parse(previousConfig), '.resonance/config.json');
      if (!config.packages.home) throw new Error('Home is no longer configured.');
      const next: RepositoryConfig = { ...config, packages: { ...config.packages, home: { ...config.packages.home, source: TARGET_SOURCE } } };
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
      return { valid: home.source === TARGET_SOURCE && home.valid, status: home.source === TARGET_SOURCE && home.valid ? 'complete' : 'attention-needed', message: home.source === TARGET_SOURCE && home.valid ? 'The configured Home source is valid.' : 'The resulting Home source is not valid.', evidence: home.valid ? [home.source] : [] };
    },
    async dismiss() {
      const home = await current();
      const evidenceKey = (await documentationPaths(context)).join('|');
      await context.state?.write({ dismissedSignature: signature(home.source, home.valid, evidenceKey) });
    },
  };
}
