import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  HostContext,
  HostResponse,
  PackageDefinition,
  PackageInput,
  PackageRegistration,
} from "../../package-contract.ts";
import { createTelemetry } from '../../telemetry.ts';
import { createDoctorAgentSession, createDoctorDeepAgentsRuntimeFactory, type DoctorAgentCheck, type DoctorAgentRuntimeFactory } from './doctor-agent.ts';
import {
  runBunDependencySecurity,
  runBunUnitTests,
  runCommandCheck,
  type DoctorResult,
} from "./doctor-runner.ts";

const metadata = {
  id: "doctor",
  version: "1.0.0",
  hostVersion: "1",
  label: "Doctor",
  order: 40,
} as const;
const runFile = promisify(execFile);
const checkIds = [
  "unit-tests",
  "type-check",
  "lint-format",
  "integration-tests",
  "dependency-security",
] as const;
type CheckId = (typeof checkIds)[number];
type DoctorCheckConfig = {
  runner: "bun" | "command" | "dependency-security";
  executable: string;
  args: string[];
  timeoutMs: number;
};
type DoctorState = {
  version: 1;
  checks: Partial<Record<CheckId, DoctorCheckConfig>>;
  results: Partial<Record<CheckId, DoctorResult>>;
};
const checkSchema = z
  .object({
    runner: z
      .enum(["bun", "command", "dependency-security"])
      .default("command"),
    executable: z.string().trim().min(1).max(128).default("bun"),
    args: z.array(z.string().max(256)).max(32).default(["test"]),
    timeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(15 * 60 * 1000)
      .default(120_000),
  })
  .strict();
const inputSchema = z
  .object({ provider: z.enum(["openai", "openrouter"]).default("openrouter"), model: z.string().trim().min(1).max(200).default("deepseek/deepseek-v4-flash"), checks: z.record(checkSchema).optional() })
  .strict();
const checkDetails: Record<
  CheckId,
  { label: string; buttonLabel: string; description: string }
> = {
  "unit-tests": {
    label: "Unit tests",
    buttonLabel: "Run unit tests",
    description:
      "Run the target repository unit tests and inspect their results.",
  },
  "type-check": {
    label: "Type checking",
    buttonLabel: "Run type checking",
    description:
      "Run the target repository type checker and inspect its diagnostics.",
  },
  "lint-format": {
    label: "Lint / format",
    buttonLabel: "Run lint / format",
    description: "Run the target repository linting and formatting policy.",
  },
  "integration-tests": {
    label: "Integration tests",
    buttonLabel: "Run integration tests",
    description:
      "Run integration and end-to-end checks against the target repository.",
  },
  "dependency-security": {
    label: "Dependency security",
    buttonLabel: "Scan dependencies",
    description:
      "Review dependency vulnerabilities, freshness, and update notices.",
  },
};
const emptyState = (): DoctorState => ({ version: 1, checks: {}, results: {} });
const isCheckId = (value: unknown): value is CheckId =>
  typeof value === "string" && (checkIds as readonly string[]).includes(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export type DoctorInput = {
  provider: "openai" | "openrouter";
  model: string;
  checks: Partial<Record<CheckId, DoctorCheckConfig>>;
};
export function doctorInput(input: PackageInput): DoctorInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      `Doctor input is invalid: ${parsed.error.issues[0].message}`,
    );
  const checks: Partial<Record<CheckId, DoctorCheckConfig>> = {};
  for (const [id, value] of Object.entries(parsed.data.checks || {}))
    if (isCheckId(id)) {
      const normalized = value as Partial<DoctorCheckConfig>;
      checks[id] = {
        runner: normalized.runner || "command",
        executable: normalized.executable || "bun",
        args: normalized.args || ["test"],
        timeoutMs: normalized.timeoutMs || 120_000,
      };
    }
  return { provider: parsed.data.provider, model: parsed.data.model, checks };
}
function stateValue(value: unknown): DoctorState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.checks) ||
    !isRecord(value.results)
  )
    return emptyState();
  return {
    version: 1,
    checks: value.checks as DoctorState["checks"],
    results: value.results as DoctorState["results"],
  };
}
async function readState(context: HostContext): Promise<DoctorState> {
  return stateValue((await context.state?.read()) || null);
}
async function writeState(
  context: HostContext,
  state: DoctorState,
): Promise<void> {
  await context.state?.write(state);
}
function credentialFilename(root: string): string { return path.join(root, ".resonance", "doctor-agent.env"); }
async function readCredential(root: string): Promise<string | null> {
  try {
    const value = await readFile(credentialFilename(root), "utf8");
    const match = value.match(/^OPEN(?:AI|ROUTER)_API_KEY=(.+)$/m);
    return match?.[1]?.trim() || null;
  } catch { return null; }
}
async function writeCredential(root: string, provider: "openai" | "openrouter", apiKey: string): Promise<void> {
  if (!apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey) || apiKey !== apiKey.trim()) throw new Error("Credential must be a single-line API key.");
  const directory = path.dirname(credentialFilename(root));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = credentialFilename(root);
  const temporary = path.join(directory, `.doctor-agent.${crypto.randomUUID()}.tmp`);
  try { await writeFile(temporary, `${provider === "openai" ? "OPENAI" : "OPENROUTER"}_API_KEY=${apiKey}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, filename); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
}
async function discoverChecks(
  context: HostContext,
): Promise<Partial<Record<CheckId, DoctorCheckConfig>>> {
  const packagePath = context.resolveRepositoryPath("package.json");
  if (!packagePath) return {};
  try {
    const value = JSON.parse(
      await readFile(path.join(context.repositoryRoot, packagePath), "utf8"),
    );
    const packageManager =
      typeof value.packageManager === "string"
        ? value.packageManager.split("@")[0]
        : "";
    const executable = ["bun", "npm", "pnpm", "yarn"].includes(packageManager)
      ? packageManager
      : context.resolveRepositoryPath("bun.lock") ||
          context.resolveRepositoryPath("bun.lockb")
        ? "bun"
        : null;
    if (!executable || !value.scripts || typeof value.scripts !== "object")
      return {};
    const fromScript = (script: string): DoctorCheckConfig | null =>
      typeof value.scripts[script] === "string" && value.scripts[script].trim()
        ? {
            runner: "command",
            executable,
            args: ["run", script],
            timeoutMs: 120_000,
          }
        : null;
    return {
      ...(executable === "bun" &&
      typeof value.scripts.test === "string" &&
      value.scripts.test.trim()
        ? {
            "unit-tests": {
              runner: "bun",
              executable,
              args: ["test"],
              timeoutMs: 120_000,
            },
          }
        : {}),
      ...(fromScript("typecheck")
        ? { "type-check": fromScript("typecheck") }
        : {}),
      ...(fromScript("lint") ? { "lint-format": fromScript("lint") } : {}),
      ...(fromScript("integration")
        ? { "integration-tests": fromScript("integration") }
        : fromScript("test:integration")
          ? { "integration-tests": fromScript("test:integration") }
          : {}),
      ...(executable === "bun" &&
      (context.resolveRepositoryPath("bun.lock") ||
        context.resolveRepositoryPath("bun.lockb"))
        ? {
            "dependency-security": {
              runner: "dependency-security",
              executable,
              args: ["audit", "--json"],
              timeoutMs: 120_000,
            },
          }
        : {}),
    };
  } catch {
    return {};
  }
}
async function repositorySnapshot(
  root: string,
): Promise<{ revision?: string; dirty?: boolean }> {
  try {
    const revision = (
      await runFile("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      })
    ).stdout.trim();
    const status = (
      await runFile("git", ["-C", root, "status", "--porcelain"], {
        encoding: "utf8",
      })
    ).stdout;
    return { revision: revision || undefined, dirty: Boolean(status) };
  } catch {
    return {};
  }
}
function sendError(response: HostResponse, error: unknown, status = 500): void {
  response.json(status, {
    error: error instanceof Error ? error.message : String(error),
  });
}
function publicCheck(
  id: CheckId,
  config: DoctorCheckConfig | undefined,
  result: DoctorResult | undefined,
  candidate: DoctorCheckConfig | null,
) {
  const details = checkDetails[id];
  return {
    id,
    ...details,
    configured: Boolean(config),
    lastStatus: result?.status || null,
    candidate: candidate
      ? {
          runner: candidate.runner,
          executable: candidate.executable,
          args: candidate.args,
          command:
            candidate.runner === "dependency-security"
              ? "bun audit --json + bun outdated"
              : `${candidate.executable} ${candidate.args.join(" ")}`,
        }
      : null,
  };
}
function bounded(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value || "", "utf8");
  return bytes.byteLength <= maxBytes
    ? value || ""
    : `${bytes.subarray(0, maxBytes).toString("utf8")}…`;
}
function persistedResult(result: DoctorResult): DoctorResult {
  const compact = {
    ...result,
    stdout: bounded(result.stdout, 2 * 1024),
    stderr: bounded(result.stderr, 2 * 1024),
    outputTruncated:
      result.outputTruncated ||
      Buffer.byteLength(result.stdout || "") > 2 * 1024 ||
      Buffer.byteLength(result.stderr || "") > 2 * 1024,
    groups: result.groups.map((group) => ({
      ...group,
      name: bounded(group.name, 512),
      tests: group.tests.slice(0, 100).map((test) => ({
        ...test,
        name: bounded(test.name, 512),
        message: test.message ? bounded(test.message, 1024) : undefined,
        output: test.output ? bounded(test.output, 1024) : undefined,
      })),
    })),
  };
  if (Buffer.byteLength(JSON.stringify(compact), "utf8") <= 48 * 1024)
    return compact;
  return {
    ...compact,
    stdout: "",
    stderr: "",
    outputTruncated: true,
    groups: compact.groups.map((group) => ({
      ...group,
      tests: group.tests
        .slice(0, 20)
        .map(({ name, status, durationMs }) => ({ name, status, durationMs })),
    })),
  };
}

type DoctorRunOptions = {
  root: string;
  revision?: string;
  dirty?: boolean;
  signal?: AbortSignal;
};
export function createDoctorPackage({
  runCheck = (config, options) => runBunUnitTests({ ...config, ...options }),
  runDependencyCheck = (config, options) =>
    runBunDependencySecurity({ ...config, ...options }),
  runtimeFactory,
}: {
  runCheck?: (
    config: DoctorCheckConfig,
    options: DoctorRunOptions,
  ) => Promise<DoctorResult>;
  runDependencyCheck?: (
    config: DoctorCheckConfig,
    options: DoctorRunOptions,
  ) => Promise<DoctorResult>;
  runtimeFactory?: DoctorAgentRuntimeFactory;
} = {}): PackageDefinition {
  return {
    metadata,
    register(context, input): PackageRegistration {
      const config = doctorInput(input);
      const telemetry = context.telemetry.child({ package: metadata.id });
      const agent = createDoctorAgentSession({ provider: config.provider, model: config.model, telemetry, credentialProvider: () => readCredential(context.repositoryRoot), runtimeFactory: runtimeFactory || createDoctorDeepAgentsRuntimeFactory() });
      const activeStreams = new Set<() => void>();
      let activeRun = false;
      const getChecks = async () => {
        const state = await readState(context);
        const candidates = await discoverChecks(context);
        return {
          state,
          candidates,
          configs: { ...state.checks, ...config.checks },
        };
      };
      const agentCheck = async (id: string): Promise<DoctorAgentCheck> => {
        const state = await readState(context);
        const checkId = isCheckId(id) ? id : "unit-tests";
        const check = checkDetails[checkId];
        return { id: checkId, ...check, result: state.results[checkId] };
      };
      return {
        metadata,
        routes: [
          {
            method: "GET",
            path: "/api/doctor",
            handler: async (_request, response) => {
              const { state, candidates, configs } = await getChecks();
              response.json(200, {
                id: metadata.id,
                label: metadata.label,
                onboardingRequired: checkIds.some(
                  (id) => !configs[id] && candidates[id],
                ),
                checks: checkIds.map((id) =>
                  publicCheck(
                    id,
                    configs[id],
                    state.results[id],
                    candidates[id] || null,
                  ),
                ),
              });
            },
          },
          {
            method: "GET",
            path: "/api/doctor/results",
            handler: async (_request, response) =>
              response.json(200, {
                results: (await readState(context)).results,
              }),
          },
          { method: "GET", path: "/api/doctor/agent/state", handler: async (_request, response) => response.json(200, agent.snapshot()) },
          { method: "GET", path: "/api/doctor/agent/events", handler: async (request, response) => {
            const stream = response.sse(); let closed = false; let unsubscribe: (() => void) | null = null; let cleanupBeforeSubscribe = false; let resolveClosed = () => {};
            const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
            const close = () => { if (closed) return; closed = true; if (unsubscribe) unsubscribe(); else cleanupBeforeSubscribe = true; activeStreams.delete(close); stream.close(); resolveClosed(); };
            activeStreams.add(close); request.onAbort(close); response.onClose(close); unsubscribe = agent.subscribe((event) => { stream.write(event); if (response.closed) close(); }); if (cleanupBeforeSubscribe) unsubscribe(); await closedPromise;
          } },
          { method: "POST", path: "/api/doctor/agent/prompt", handler: async (request, response) => {
            try { const body = await request.readJson<{ prompt?: unknown; selectedCheck?: unknown }>(32 * 1024); if (!isRecord(body) || typeof body.prompt !== "string" || !body.prompt.trim() || typeof body.selectedCheck !== "string") { sendError(response, new Error("prompt and selectedCheck must be non-empty strings."), 400); return; } response.json(202, await agent.submitPrompt({ prompt: body.prompt, check: await agentCheck(body.selectedCheck) })); }
            catch (error) { sendError(response, error, error?.status || 500); }
          } },
          { method: "POST", path: "/api/doctor/agent/credential", handler: async (request, response) => {
            try { const body = await request.readJson<{ apiKey?: unknown }>(8 * 1024); if (!isRecord(body) || typeof body.apiKey !== "string") { sendError(response, new Error("apiKey must be a string."), 400); return; } await writeCredential(context.repositoryRoot, config.provider, body.apiKey); response.json(200, { ok: true }); }
            catch (error) { sendError(response, error, error?.status || 500); }
          } },
          { method: "POST", path: "/api/doctor/agent/stop", handler: async (_request, response) => { try { response.json(200, await agent.stop()); } catch (error) { sendError(response, error, error?.status || 500); } } },
          { method: "POST", path: "/api/doctor/agent/reset", handler: async (_request, response) => { try { response.json(200, { state: await agent.reset() }); } catch (error) { sendError(response, error, error?.status || 500); } } },
          {
            method: "POST",
            path: "/api/doctor/configure",
            handler: async (request, response) => {
              try {
                const body = await request.readJson<{ checkId?: unknown }>(
                  8 * 1024,
                );
                if (!isRecord(body) || !isCheckId(body.checkId)) {
                  sendError(
                    response,
                    new Error(
                      "checkId must identify a supported Doctor check.",
                    ),
                    400,
                  );
                  return;
                }
                const candidates = await discoverChecks(context);
                const candidate = candidates[body.checkId];
                if (!candidate) {
                  sendError(
                    response,
                    new Error(
                      "No supported check was discovered for this repository.",
                    ),
                    422,
                  );
                  return;
                }
                const state = await readState(context);
                state.checks[body.checkId] = candidate;
                await writeState(context, state);
                response.json(200, {
                  ok: true,
                  check: publicCheck(
                    body.checkId,
                    candidate,
                    state.results[body.checkId],
                    candidate,
                  ),
                });
              } catch (error) {
                sendError(response, error, error?.status || 500);
              }
            },
          },
          {
            method: "POST",
            path: "/api/doctor/run",
            handler: async (request, response) => {
              if (activeRun) {
                sendError(
                  response,
                  new Error("A Doctor check is already running."),
                  409,
                );
                return;
              }
              try {
                const body = await request.readJson<{ checkId?: unknown }>(
                  8 * 1024,
                );
                if (!isRecord(body) || !isCheckId(body.checkId)) {
                  sendError(
                    response,
                    new Error(
                      "checkId must identify a supported Doctor check.",
                    ),
                    400,
                  );
                  return;
                }
                const { state, configs } = await getChecks();
                const check = configs[body.checkId];
                if (!check) {
                  sendError(
                    response,
                    new Error(
                      "This check needs to be configured before it can run.",
                    ),
                    409,
                  );
                  return;
                }
                activeRun = true;
                const snapshot = await repositorySnapshot(
                  context.repositoryRoot,
                );
                const controller = new AbortController();
                request.onAbort(() => controller.abort());
                const result =
                  check.runner === "bun"
                    ? await runCheck(check, {
                        root: context.repositoryRoot,
                        ...snapshot,
                        signal: controller.signal,
                      })
                    : check.runner === "dependency-security"
                      ? await runDependencyCheck(check, {
                          root: context.repositoryRoot,
                          ...snapshot,
                          signal: controller.signal,
                        })
                      : await runCommandCheck({
                          root: context.repositoryRoot,
                          executable: check.executable,
                          args: check.args,
                          timeoutMs: check.timeoutMs,
                          label: checkDetails[body.checkId].label,
                          ...snapshot,
                          signal: controller.signal,
                        });
                const nextResult = persistedResult({
                  ...result,
                  revision: result.revision || snapshot.revision,
                  dirty: result.dirty ?? snapshot.dirty,
                  runtime:
                    result.runtime || process.versions.bun || process.version,
                });
                const next = {
                  ...state,
                  results: { ...state.results, [body.checkId]: nextResult },
                };
                await writeState(context, next);
                if (!response.closed)
                  response.json(200, { result: next.results[body.checkId] });
              } catch (error) {
                if (!response.closed)
                  sendError(response, error, error?.status || 500);
              } finally {
                activeRun = false;
              }
            },
          },
        ],
        assets: [
          {
            path: "/assets/doctor/doctor.js",
            file: "src/packages/doctor/doctor.js",
            contentType: "text/javascript; charset=utf-8",
          },
          {
            path: "/assets/doctor/doctor.css",
            file: "src/packages/doctor/doctor.css",
            contentType: "text/css; charset=utf-8",
          },
        ],
        navigation: [
          { id: metadata.id, label: metadata.label, order: metadata.order },
        ],
        browser: {
          id: metadata.id,
          entry: "/assets/doctor/doctor.js",
          stylesheet: "/assets/doctor/doctor.css",
        },
        dispose: async () => { [...activeStreams].forEach((close) => close()); await agent.dispose(); },
      };
    },
  };
}

const packageDefinition = createDoctorPackage();
export default packageDefinition;
