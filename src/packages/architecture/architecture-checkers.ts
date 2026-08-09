import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { HostContext } from '../../package-contract.ts';
import type { ArchitectureArtifacts, CheckStatus, LikeC4Snapshot } from './architecture-store.ts';

export type ArchitectureFinding = { ruleId: string; name: string; severity: 'error' | 'warning' | 'info'; status: CheckStatus; message: string; checker: string; version: string; evidence: string[] };
export type ArchitectureCoverage = {
  elements: { total: number; bound: number; unbound: number; symbols: number; declarationKinds: number };
  relationships: { total: number; verified: number; authoredOnly: number; required: number };
};
export type ArchitectureValidation = {
  revision: string;
  results: ArchitectureFinding[];
  summary: { total: number; pass: number; fail: number; unknown: number };
  coverage: ArchitectureCoverage;
};
type Rule = ArchitectureArtifacts['rules']['rules'][number];
type CanonicalElement = { id?: string; kind?: string; title?: string; links?: Array<{ relative?: string; url?: string }>; metadata?: Record<string, unknown> };
type CanonicalRelation = { metadata?: Record<string, unknown> };
type CanonicalModel = { elements?: Record<string, CanonicalElement>; relations?: Record<string, CanonicalRelation> };
type Checker = (context: HostContext, artifacts: ArchitectureArtifacts, rule: Rule, canonical: LikeC4Snapshot | null) => Promise<ArchitectureFinding>;

const boundedRead = async (filename: string, max = 256 * 1024) => { const source = await readFile(filename, 'utf8'); return source.length > max ? source.slice(0, max) : source; };
const configPath = (context: HostContext) => context.resolveRepositoryPath('.resonance/config.json');
const canonicalRule = { id: 'canonical-likec4-model', name: 'Canonical LikeC4 model', description: 'The rendered architecture source parses, resolves, and can be laid out.', appliesTo: ['architecture-model'], checker: 'likec4-model', severity: 'error' as const };

async function repositoryConfig(context: HostContext): Promise<{ value: Record<string, unknown>; evidence: string } | null> {
  const relative = configPath(context);
  if (!relative) return null;
  try { return { value: JSON.parse(await boundedRead(path.resolve(context.repositoryRoot, relative), 128 * 1024)) as Record<string, unknown>, evidence: relative }; }
  catch { return null; }
}
function finding(rule: Rule | typeof canonicalRule, status: CheckStatus, message: string, evidence: string[] = []): ArchitectureFinding { return { ruleId: rule.id, name: rule.name, severity: rule.severity, status, message, checker: rule.checker, version: '1', evidence }; }
function canonicalModel(snapshot: LikeC4Snapshot | null): CanonicalModel | null { return snapshot?.dump && typeof snapshot.dump === 'object' ? snapshot.dump as CanonicalModel : null; }
function metadataValue(metadata: Record<string, unknown> | undefined, name: string): string | undefined { const value = metadata?.[name]; return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function linkPath(link: { relative?: string; url?: string }): string | undefined {
  if (typeof link.relative === 'string' && link.relative) return link.relative;
  if (typeof link.url === 'string' && link.url.startsWith('./')) return link.url.slice(2);
  return undefined;
}
function canonicalElements(snapshot: LikeC4Snapshot | null): CanonicalElement[] { return Object.values(canonicalModel(snapshot)?.elements || {}); }
function canonicalPackageElements(snapshot: LikeC4Snapshot | null): CanonicalElement[] {
  return canonicalElements(snapshot).filter((element) => element.kind === 'container' && typeof element.id === 'string' && element.id.split('.').length === 2 && element.id.startsWith('resonancePackages.'));
}
function canonicalEvidencePaths(snapshot: LikeC4Snapshot | null): string[] {
  const paths = new Set<string>();
  for (const element of canonicalElements(snapshot)) {
    for (const link of element.links || []) { const value = linkPath(link); if (value) paths.add(value); }
    const source = metadataValue(element.metadata, 'source');
    if (source) paths.add(source);
  }
  return [...paths].sort();
}
function coverage(snapshot: LikeC4Snapshot | null): ArchitectureCoverage {
  const model = canonicalModel(snapshot);
  const elements = canonicalElements(snapshot);
  const relations = Object.values(model?.relations || {});
  const bound = elements.filter((element) => metadataValue(element.metadata, 'source')).length;
  const symbols = elements.filter((element) => metadataValue(element.metadata, 'symbol')).length;
  const declarationKinds = elements.filter((element) => metadataValue(element.metadata, 'declaration_kind')).length;
  const verified = relations.filter((relation) => metadataValue(relation.metadata, 'verification')).length;
  const required = relations.filter((relation) => ['true', 'yes'].includes(String(relation.metadata?.required).toLowerCase())).length;
  return { elements: { total: elements.length, bound, unbound: elements.length - bound, symbols, declarationKinds }, relationships: { total: relations.length, verified, authoredOnly: relations.length - verified, required } };
}

async function checkCanonicalModel(context: HostContext, artifacts: ArchitectureArtifacts, rule: typeof canonicalRule, canonical: LikeC4Snapshot | null, error: unknown): Promise<ArchitectureFinding> {
  const evidence = artifacts.likec4Sources.map((source) => `${artifacts.artifactRoot}/${source}`);
  if (!canonical) return finding(rule, 'fail', `The canonical LikeC4 model could not be parsed or laid out: ${error instanceof Error ? error.message : String(error || 'no LikeC4 validation was run')}`, evidence.length ? evidence : [artifacts.artifactRoot]);
  if (canonical.revision !== artifacts.likec4Revision) return finding(rule, 'unknown', 'LikeC4 sources changed while validation was running; rerun validation for a stable snapshot.', evidence);
  const invalidBindings = canonicalElements(canonical).map((element) => metadataValue(element.metadata, 'source')).filter((source): source is string => Boolean(source && !context.resolveRepositoryPath(source)));
  if (invalidBindings.length) return finding(rule, 'fail', `Canonical source bindings escape the repository: ${invalidBindings.join(', ')}`, invalidBindings);
  return finding(rule, 'pass', `The canonical LikeC4 model parsed, resolved, and laid out from ${artifacts.likec4Sources.length} source file${artifacts.likec4Sources.length === 1 ? '' : 's'}.`, evidence);
}

async function checkAuthoritativeConfig(context: HostContext, _artifacts: ArchitectureArtifacts, rule: Rule, _canonical: LikeC4Snapshot | null): Promise<ArchitectureFinding> {
  const loaded = await repositoryConfig(context);
  if (!loaded) return finding(rule, 'unknown', 'The repository manifest could not be read.', ['.resonance/config.json']);
  const packages = loaded.value.packages;
  if (loaded.value.version !== 1 || !packages || typeof packages !== 'object' || Array.isArray(packages)) return finding(rule, 'fail', 'The repository manifest is not an authoritative version 1 package configuration.', [loaded.evidence]);
  return finding(rule, 'pass', 'The repository uses an explicit version 1 package allowlist.', [loaded.evidence]);
}
async function checkShell(context: HostContext, _artifacts: ArchitectureArtifacts, rule: Rule, _canonical: LikeC4Snapshot | null): Promise<ArchitectureFinding> {
  const loaded = await repositoryConfig(context);
  if (!loaded) return finding(rule, 'unknown', 'The repository manifest could not be read.', ['.resonance/config.json']);
  const packages = loaded.value.packages;
  const shell = packages && typeof packages === 'object' && !Array.isArray(packages) ? (packages as Record<string, unknown>).shell : undefined;
  if (!shell || typeof shell !== 'object' || Array.isArray(shell)) return finding(rule, 'fail', 'Shell is not configured.', [loaded.evidence]);
  if ((shell as Record<string, unknown>).enabled === false) return finding(rule, 'fail', 'Shell is configured but disabled.', [loaded.evidence]);
  return finding(rule, 'pass', 'Shell is explicitly configured and enabled.', [loaded.evidence]);
}
async function checkOwnership(context: HostContext, _artifacts: ArchitectureArtifacts, rule: Rule, canonical: LikeC4Snapshot | null): Promise<ArchitectureFinding> {
  const loaded = await repositoryConfig(context);
  if (!loaded) return finding(rule, 'unknown', 'The repository manifest could not be read.', ['.resonance/config.json']);
  const packages = loaded.value.packages;
  if (!packages || typeof packages !== 'object' || Array.isArray(packages)) return finding(rule, 'unknown', 'The repository package allowlist is unavailable.', ['.resonance/config.json']);
  const modeledPackages = canonicalPackageElements(canonical);
  if (!modeledPackages.length) return finding(rule, 'unknown', 'The canonical LikeC4 model contains no package containers to compare with the manifest.', ['architecture/model.c4']);
  const problems: string[] = [];
  const packageList = packages as Record<string, unknown>;
  const modeledIds = new Set<string>();
  for (const entity of modeledPackages) {
    const packageId = entity.id!.split('.').at(-1)!;
    modeledIds.add(packageId);
    const selection = packageList[packageId];
    const module = typeof selection === 'object' && selection && !Array.isArray(selection) ? (selection as Record<string, unknown>).module : undefined;
    const expected = metadataValue(entity.metadata, 'source') || (entity.links || []).map(linkPath).find((value): value is string => Boolean(value && /\/index\.(?:ts|js)$/.test(value)));
    if (!selection || typeof module !== 'string') problems.push(`${entity.title || packageId} is not represented by ${packageId} in the manifest`);
    else if (expected && module !== expected) problems.push(`${entity.title || packageId} points at ${expected}, but the manifest points at ${module}`);
  }
  for (const [packageId, selection] of Object.entries(packageList)) {
    if (selection && typeof selection === 'object' && !Array.isArray(selection) && (selection as Record<string, unknown>).enabled === false) continue;
    if (!modeledIds.has(packageId)) problems.push(`${packageId} is configured in the manifest but is not represented by a canonical LikeC4 package container`);
  }
  if (problems.length) return finding(rule, 'fail', problems.join('; '), ['.resonance/config.json', 'architecture/model.c4']);
  return finding(rule, 'pass', `All ${modeledPackages.length} package containers in the canonical LikeC4 model have explicit manifest ownership.`, ['.resonance/config.json', 'architecture/model.c4']);
}
async function checkRoutes(context: HostContext, _artifacts: ArchitectureArtifacts, rule: Rule, _canonical: LikeC4Snapshot | null): Promise<ArchitectureFinding> {
  const loaded = await repositoryConfig(context);
  if (!loaded || !loaded.value.packages || typeof loaded.value.packages !== 'object' || Array.isArray(loaded.value.packages)) return finding(rule, 'unknown', 'The repository package modules could not be inspected.', ['.resonance/config.json']);
  const problems: string[] = [];
  const evidence: string[] = ['src/host.ts'];
  let positiveEvidence = false;
  for (const [id, selection] of Object.entries(loaded.value.packages as Record<string, unknown>)) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection) || (selection as Record<string, unknown>).enabled === false) continue;
    const module = (selection as Record<string, unknown>).module;
    if (typeof module !== 'string' || module.includes('..') || module.includes('\\') || module.startsWith('/')) { problems.push(`${id} has no safe module path`); continue; }
    const filename = path.resolve(context.appRoot, module);
    try {
      const source = await boundedRead(filename);
      evidence.push(module);
      const hasRoutesDeclaration = /\broutes\s*:/s.test(source);
      const hasAssetsDeclaration = /\bassets\s*:/s.test(source);
      const routePaths = [...source.matchAll(/path\s*:\s*['"](\/api\/[^'"]*)['"]/g)].map((match) => match[1]);
      const assetPaths = [...source.matchAll(/path\s*:\s*['"](\/assets\/[^'"]*)['"]/g)].map((match) => match[1]);
      if (!hasRoutesDeclaration && !hasAssetsDeclaration) problems.push(`${id} registration does not expose inspectable routes or assets`);
      if (hasRoutesDeclaration || hasAssetsDeclaration) positiveEvidence = positiveEvidence || routePaths.length > 0 || assetPaths.length > 0;
      for (const route of routePaths) if (!(route === `/api/${id}` || route.startsWith(`/api/${id}/`))) problems.push(`${id} route is not namespaced: ${route}`);
      for (const asset of assetPaths) if (!(id === 'shell' && (asset === '/assets/app.js' || asset === '/assets/styles.css')) && !(asset === `/assets/${id}` || asset.startsWith(`/assets/${id}/`))) problems.push(`${id} asset is not namespaced: ${asset}`);
    } catch { problems.push(`${id} module could not be read`); }
  }
  try {
    const hostSource = await boundedRead(path.resolve(context.appRoot, 'src/host.ts'));
    if (!/addRegistration|PackageRegistration/.test(hostSource)) return finding(rule, 'unknown', 'The host registration path could not be positively inspected.', evidence);
  } catch { return finding(rule, 'unknown', 'The host registration path could not be read.', evidence); }
  if (problems.length && (!positiveEvidence && problems.every((problem) => problem.includes('does not expose inspectable routes or assets') || problem.includes('module could not be read')))) return finding(rule, 'unknown', 'No concrete route or asset contribution was found in the configured package registrations; absence of literals is not evidence of conformance.', evidence);
  if (problems.length) return finding(rule, 'fail', problems.join('; '), evidence);
  if (!positiveEvidence) return finding(rule, 'unknown', 'No concrete route or asset contribution was found in the configured package registrations; absence of literals is not evidence of conformance.', evidence);
  return finding(rule, 'pass', 'Configured package routes and assets use package namespaces, with package and host registration evidence inspected.', evidence);
}
async function checkContainment(context: HostContext, _artifacts: ArchitectureArtifacts, rule: Rule, canonical: LikeC4Snapshot | null): Promise<ArchitectureFinding> {
  const paths = canonicalEvidencePaths(canonical);
  if (!canonical) return finding(rule, 'unknown', 'The canonical LikeC4 model is unavailable, so its linked evidence cannot be checked.', ['architecture/model.c4']);
  const missing: string[] = [];
  for (const relative of paths) if (!context.resolveRepositoryPath(relative)) missing.push(relative);
  if (missing.length) return finding(rule, 'unknown', `Canonical evidence files are unavailable: ${missing.join(', ')}`, missing);
  return finding(rule, 'pass', 'All evidence links and source bindings in the canonical LikeC4 model remain within the viewed repository.', paths);
}
async function checkGit(context: HostContext, _artifacts: ArchitectureArtifacts, rule: Rule, _canonical: LikeC4Snapshot | null): Promise<ArchitectureFinding> {
  const head = context.resolveRepositoryPath('.git/HEAD');
  if (!head) return finding(rule, 'unknown', 'The viewed repository does not expose a Git HEAD.', ['.git/HEAD']);
  try { const value = (await boundedRead(path.resolve(context.repositoryRoot, head), 4096)).trim(); return value ? finding(rule, 'pass', 'A Git revision source is available for architecture reports.', ['.git/HEAD']) : finding(rule, 'unknown', 'Git HEAD is empty.', ['.git/HEAD']); }
  catch { return finding(rule, 'unknown', 'Git HEAD could not be read.', ['.git/HEAD']); }
}

export const architectureCheckerRegistry: Readonly<Record<string, Checker>> = Object.freeze({
  'authoritative-config': checkAuthoritativeConfig,
  'shell-required': checkShell,
  'package-ownership': checkOwnership,
  'route-asset-namespacing': checkRoutes,
  'repository-containment': checkContainment,
  'git-revision': checkGit,
});

export type ArchitectureValidationOptions = { likec4?: () => Promise<LikeC4Snapshot> };

export async function validateArchitecture(context: HostContext, artifacts: ArchitectureArtifacts, options: ArchitectureValidationOptions = {}): Promise<ArchitectureValidation> {
  let canonical: LikeC4Snapshot | null = null;
  let canonicalError: unknown = options.likec4 ? undefined : new Error('No canonical LikeC4 loader was supplied.');
  if (options.likec4) {
    try { canonical = await options.likec4(); }
    catch (error) { canonicalError = error; }
  }
  const results: ArchitectureFinding[] = [await checkCanonicalModel(context, artifacts, canonicalRule, canonical, canonicalError)];
  for (const rule of artifacts.rules.rules) {
    const checker = architectureCheckerRegistry[rule.checker];
    results.push(checker ? await checker(context, artifacts, rule, canonical) : finding(rule, 'fail', `No checker is registered for '${rule.checker}'.`, ['architecture/rules.json']));
  }
  const summary = { total: results.length, pass: results.filter((result) => result.status === 'pass').length, fail: results.filter((result) => result.status === 'fail').length, unknown: results.filter((result) => result.status === 'unknown').length };
  return { revision: artifacts.revision, results, summary, coverage: coverage(canonical) };
}
