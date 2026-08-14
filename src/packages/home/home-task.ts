import { readFile, rename, writeFile, mkdir, unlink, lstat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { discoverMarkdownFiles } from '../../content.ts';
import { validateRepositoryConfig } from '../../config.ts';
import type { RepositoryConfig } from '../../package-contract.ts';
import type { HostContext, PackageInput, TaskContribution, TaskPreview } from '../../package-contract.ts';
import { homeInput } from './home-source.ts';

const TARGET_SOURCE = '.resonance/home.html';
const skillContent = readFileSync(new URL('./skills/create-home-page/SKILL.md', import.meta.url), 'utf8');
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
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function readableExcerpt(value: string, fallback: string): string {
  const text = value.replace(/```[\s\S]*?```/g, '').replace(/^#{1,6}\s*/gm, '').replace(/^[-*+]\s+/gm, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 420).trim();
}
function sourceFor(evidence: Array<{ path: string; excerpt: string }>, preferred: string[], fallbackIndex = 0): { path: string; excerpt: string } {
  return evidence.find((item) => preferred.includes(item.path.toLowerCase())) || evidence[fallbackIndex] || evidence[0] || { path: 'repository documentation', excerpt: 'The repository documentation is the source for this project overview.' };
}
function proposal(repositoryName: string, evidence: Array<{ path: string; excerpt: string }>): string {
  const readme = sourceFor(evidence, ['readme.md', 'readme.markdown']);
  const usage = sourceFor(evidence, ['docs/using-resonance.md', 'docs/usage.md', 'docs/getting-started.md', 'getting-started.md'], 1);
  const architecture = sourceFor(evidence, ['docs/architecture.md', 'architecture.md', 'docs/design.md'], 2);
  const project = escapeHtml(readableExcerpt(readme.excerpt, 'A project with a clear point of view, captured in its repository documentation.'));
  const use = escapeHtml(readableExcerpt(usage.excerpt, 'Start with the documented workflow, then make the project your own.'));
  const strengths = escapeHtml(readableExcerpt(architecture.excerpt, 'The project brings its important ideas into view so they can be understood and improved.'));
  const quote = escapeHtml(readableExcerpt(readme.excerpt, 'Good software becomes easier to care about when its purpose is visible.'));
  const source = (item: { path: string }) => `<span class="home-source">Source: ${escapeHtml(item.path)}</span>`;
  const html = `<section class="repository-home" aria-labelledby="repository-home-title">
  <header class="home-hero">
    <p class="home-kicker">PROJECT / ${escapeHtml(repositoryName)}</p>
    <h1 id="repository-home-title">${escapeHtml(repositoryName)}</h1>
    <p class="home-lead">${project}</p>
    <p class="home-meta"><span>Built with intention</span><span>Grounded in the repository</span></p>
  </header>
  <div class="home-rule" aria-hidden="true"></div>
  <section class="home-section" aria-labelledby="home-purpose-title">
    <div class="home-section-label">01 / The point</div>
    <div><h2 id="home-purpose-title">A project with something to say.</h2><p>${project}</p>${source(readme)}</div>
  </section>
  <section class="home-section" aria-labelledby="home-audience-title">
    <div class="home-section-label">02 / The people</div>
    <div><h2 id="home-audience-title">For the people close to the work.</h2><p>This is for the people who need to understand a project, make a good change, and remember why the change matters.</p><p>The repository keeps the useful context close: enough to orient a newcomer, and enough to help a team make its next decision with confidence.</p></div>
  </section>
  <section class="home-section" aria-labelledby="home-use-title">
    <div class="home-section-label">03 / The practice</div>
    <div><h2 id="home-use-title">Useful because it is made to be used.</h2><p>${use}</p><h3>Find the shortest path in.</h3><p>${escapeHtml(readableExcerpt(usage.excerpt, 'Read the getting-started guidance, try the core workflow, and let the project reveal its shape through use.'))}</p>${source(usage)}</div>
  </section>
  <section class="home-section" aria-labelledby="home-strength-title">
    <div class="home-section-label">04 / The character</div>
    <div><h2 id="home-strength-title">The details are part of the promise.</h2><p>${strengths}</p><blockquote><p>“${quote}”</p><cite>${source(readme).replace('Source:', 'From')}</cite></blockquote><h3>Make the important things visible.</h3><p>This page is a small reminder that the work is worth understanding, shaping, and sharing.</p>${source(architecture)}</div>
  </section>
  <section class="home-closing" aria-label="Closing statement"><p>Good work feels better when its purpose is close at hand.</p><span>${escapeHtml(repositoryName)} / keep building</span></section>
</section>`;
  return html.slice(0, MAX_PROPOSAL_BYTES);
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
    instructions: 'Read /skills/create-home-page/SKILL.md before preparing a Home page. The result must be engaging, intentional HTML rather than a documentation index or chat transcript.',
    skills: [{ id: 'create-home-page', name: 'Create Home page', content: skillContent }],
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
