import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { HostContext, HostResponse, PackageDefinition, PackageInput, PackageRegistration } from '../../package-contract.ts';
import { runBunUnitTests, type DoctorResult } from './doctor-runner.ts';

const metadata = { id: 'doctor', version: '1.0.0', hostVersion: '1', label: 'Doctor', order: 40 } as const;
const runFile = promisify(execFile);
const checkIds = ['unit-tests', 'static-analysis', 'integration-tests', 'dependency-security'] as const;
type CheckId = typeof checkIds[number];
type DoctorCheckConfig = { runner: 'bun'; executable: string; args: string[]; timeoutMs: number };
type DoctorState = { version: 1; checks: Partial<Record<CheckId, DoctorCheckConfig>>; results: Partial<Record<CheckId, DoctorResult>> };
const checkSchema = z.object({ runner: z.literal('bun').default('bun'), executable: z.string().trim().min(1).max(128).default('bun'), args: z.array(z.string().max(256)).max(32).default(['test']), timeoutMs: z.number().int().min(1000).max(15 * 60 * 1000).default(120_000) }).strict();
const inputSchema = z.object({ checks: z.record(checkSchema).optional() }).strict();
const checkDetails: Record<CheckId, { label: string; buttonLabel: string; description: string }> = {
  'unit-tests': { label: 'Unit tests', buttonLabel: 'Run unit tests', description: 'Run the target repository unit tests and inspect their results.' },
  'static-analysis': { label: 'Static analysis', buttonLabel: 'Run static analysis', description: 'Run configured linters, type checks, and other static analysis.' },
  'integration-tests': { label: 'Integration tests', buttonLabel: 'Run integration tests', description: 'Run integration and end-to-end checks against the target repository.' },
  'dependency-security': { label: 'Dependency security', buttonLabel: 'Scan dependencies', description: 'Review dependency vulnerabilities, freshness, and update notices.' },
};
const emptyState = (): DoctorState => ({ version: 1, checks: {}, results: {} });
const isCheckId = (value: unknown): value is CheckId => typeof value === 'string' && (checkIds as readonly string[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export type DoctorInput = { checks: Partial<Record<CheckId, DoctorCheckConfig>> };
export function doctorInput(input: PackageInput): DoctorInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Doctor input is invalid: ${parsed.error.issues[0].message}`);
  const checks: Partial<Record<CheckId, DoctorCheckConfig>> = {};
  for (const [id, value] of Object.entries(parsed.data.checks || {})) if (isCheckId(id)) checks[id] = value;
  return { checks };
}
function stateValue(value: unknown): DoctorState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.checks) || !isRecord(value.results)) return emptyState();
  return { version: 1, checks: value.checks as DoctorState['checks'], results: value.results as DoctorState['results'] };
}
async function readState(context: HostContext): Promise<DoctorState> { return stateValue(await context.state?.read() || null); }
async function writeState(context: HostContext, state: DoctorState): Promise<void> { await context.state?.write(state); }
async function discoverUnitTest(context: HostContext): Promise<DoctorCheckConfig | null> {
  const packagePath = context.resolveRepositoryPath('package.json');
  if (!packagePath) return null;
  try {
    const value = JSON.parse(await readFile(path.join(context.repositoryRoot, packagePath), 'utf8'));
    if (typeof value?.scripts?.test !== 'string' || !value.scripts.test.trim()) return null;
    const packageManager = typeof value.packageManager === 'string' ? value.packageManager.split('@')[0] : '';
    const hasBun = packageManager === 'bun' || Boolean(context.resolveRepositoryPath('bun.lock')) || Boolean(context.resolveRepositoryPath('bun.lockb'));
    return hasBun ? { runner: 'bun', executable: 'bun', args: ['test'], timeoutMs: 120_000 } : null;
  } catch { return null; }
}
async function repositorySnapshot(root: string): Promise<{ revision?: string; dirty?: boolean }> {
  try {
    const revision = (await runFile('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })).stdout.trim();
    const status = (await runFile('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' })).stdout;
    return { revision: revision || undefined, dirty: Boolean(status) };
  } catch { return {}; }
}
function sendError(response: HostResponse, error: unknown, status = 500): void { response.json(status, { error: error instanceof Error ? error.message : String(error) }); }
function publicCheck(id: CheckId, config: DoctorCheckConfig | undefined, result: DoctorResult | undefined, candidate: DoctorCheckConfig | null) {
  const details = checkDetails[id];
  return { id, ...details, configured: Boolean(config), lastStatus: result?.status || null, candidate: candidate ? { runner: candidate.runner, executable: candidate.executable, args: candidate.args } : null };
}
function bounded(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value || '', 'utf8');
  return bytes.byteLength <= maxBytes ? value || '' : `${bytes.subarray(0, maxBytes).toString('utf8')}…`;
}
function persistedResult(result: DoctorResult): DoctorResult {
  const compact = {
    ...result,
    stdout: bounded(result.stdout, 2 * 1024), stderr: bounded(result.stderr, 2 * 1024), outputTruncated: result.outputTruncated || Buffer.byteLength(result.stdout || '') > 2 * 1024 || Buffer.byteLength(result.stderr || '') > 2 * 1024,
    groups: result.groups.map((group) => ({ ...group, name: bounded(group.name, 512), tests: group.tests.slice(0, 100).map((test) => ({ ...test, name: bounded(test.name, 512), message: test.message ? bounded(test.message, 1024) : undefined, output: test.output ? bounded(test.output, 1024) : undefined })) })),
  };
  if (Buffer.byteLength(JSON.stringify(compact), 'utf8') <= 48 * 1024) return compact;
  return { ...compact, stdout: '', stderr: '', outputTruncated: true, groups: compact.groups.map((group) => ({ ...group, tests: group.tests.slice(0, 20).map(({ name, status, durationMs }) => ({ name, status, durationMs })) })) };
}

export function createDoctorPackage({ runCheck = (config, options) => runBunUnitTests({ ...config, ...options }) }: { runCheck?: (config: DoctorCheckConfig, options: { root: string; revision?: string; dirty?: boolean; signal?: AbortSignal }) => Promise<DoctorResult> } = {}): PackageDefinition {
  return {
    metadata,
    register(context, input): PackageRegistration {
      const config = doctorInput(input);
      let activeRun = false;
      const getChecks = async () => {
        const state = await readState(context);
        const candidate = await discoverUnitTest(context);
        return { state, candidate, configs: { ...state.checks, ...config.checks } };
      };
      return {
        metadata,
        routes: [
          {
            method: 'GET', path: '/api/doctor', handler: async (_request, response) => {
              const { state, candidate, configs } = await getChecks();
              response.json(200, {
                id: metadata.id, label: metadata.label, onboardingRequired: !configs['unit-tests'] && Boolean(candidate),
                checks: checkIds.map((id) => publicCheck(id, configs[id], state.results[id], id === 'unit-tests' ? candidate : null)),
              });
            },
          },
          {
            method: 'GET', path: '/api/doctor/results', handler: async (_request, response) => response.json(200, { results: (await readState(context)).results }),
          },
          {
            method: 'POST', path: '/api/doctor/configure', handler: async (request, response) => {
              try {
                const body = await request.readJson<{ checkId?: unknown }>(8 * 1024);
                if (!isRecord(body) || !isCheckId(body.checkId)) { sendError(response, new Error('checkId must identify a supported Doctor check.'), 400); return; }
                const candidate = body.checkId === 'unit-tests' ? await discoverUnitTest(context) : null;
                if (!candidate) { sendError(response, new Error('No supported check was discovered for this repository.'), 422); return; }
                const state = await readState(context); state.checks[body.checkId] = candidate; await writeState(context, state);
                response.json(200, { ok: true, check: publicCheck(body.checkId, candidate, state.results[body.checkId], candidate) });
              } catch (error) { sendError(response, error, error?.status || 500); }
            },
          },
          {
            method: 'POST', path: '/api/doctor/run', handler: async (request, response) => {
              if (activeRun) { sendError(response, new Error('A Doctor check is already running.'), 409); return; }
              try {
                const body = await request.readJson<{ checkId?: unknown }>(8 * 1024);
                if (!isRecord(body) || !isCheckId(body.checkId)) { sendError(response, new Error('checkId must identify a supported Doctor check.'), 400); return; }
                const { state, configs } = await getChecks();
                const check = configs[body.checkId];
                if (!check) { sendError(response, new Error('This check needs to be configured before it can run.'), 409); return; }
                activeRun = true;
                const snapshot = await repositorySnapshot(context.repositoryRoot);
                const controller = new AbortController();
                request.onAbort(() => controller.abort());
                const result = await runCheck(check, { root: context.repositoryRoot, ...snapshot, signal: controller.signal });
                const nextResult = persistedResult({ ...result, revision: result.revision || snapshot.revision, dirty: result.dirty ?? snapshot.dirty, runtime: result.runtime || process.versions.bun || process.version });
                const next = { ...state, results: { ...state.results, [body.checkId]: nextResult } };
                await writeState(context, next);
                if (!response.closed) response.json(200, { result: next.results[body.checkId] });
              } catch (error) { if (!response.closed) sendError(response, error, error?.status || 500); }
              finally { activeRun = false; }
            },
          },
        ],
        assets: [{ path: '/assets/doctor/doctor.js', file: 'src/packages/doctor/doctor.js', contentType: 'text/javascript; charset=utf-8' }, { path: '/assets/doctor/doctor.css', file: 'src/packages/doctor/doctor.css', contentType: 'text/css; charset=utf-8' }],
        navigation: [{ id: metadata.id, label: metadata.label, order: metadata.order }],
        browser: { id: metadata.id, entry: '/assets/doctor/doctor.js', stylesheet: '/assets/doctor/doctor.css' },
      };
    },
  };
}

const packageDefinition = createDoctorPackage();
export default packageDefinition;
