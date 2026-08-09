import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DOMParser } from "linkedom";

export const DOCTOR_OUTPUT_MAX_BYTES = 32 * 1024;
export const DOCTOR_DEFAULT_TIMEOUT_MS = 120_000;

export type DoctorTestStatus = "passed" | "failed" | "skipped" | "errored";
export type DoctorRunStatus =
  | DoctorTestStatus
  | "timed-out"
  | "cancelled"
  | "parse-error"
  | "runner-error"
  | "no-tests";
export type DoctorTest = {
  name: string;
  status: DoctorTestStatus;
  durationMs?: number;
  message?: string;
  output?: string;
  details?: Record<string, string | number | boolean | null>;
};
export type DoctorGroup = {
  name: string;
  status: DoctorTestStatus;
  tests: DoctorTest[];
};
export type DoctorResult = {
  status: DoctorRunStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  command: string[];
  commands?: string[][];
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    errored: number;
  };
  groups: DoctorGroup[];
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  message?: string;
  exitCode?: number | null;
  signal?: string | null;
  revision?: string;
  dirty?: boolean;
  runtime?: string;
};

type ParseOptions = Pick<
  DoctorResult,
  "startedAt" | "completedAt" | "command" | "stdout" | "stderr"
> & {
  exitCode: number | null;
  signal?: string | null;
  durationMs?: number;
  outputTruncated?: boolean;
  revision?: string;
  dirty?: boolean;
  runtime?: string;
  commands?: string[][];
};

function attribute(element: Element, name: string): string | undefined {
  const value = element.getAttribute(name);
  return value === null ? undefined : value;
}
function durationMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 1000) : undefined;
}
function child(element: Element, tag: string): Element | null {
  return (
    Array.from(element.children).find(
      (candidate) => candidate.tagName.toLowerCase() === tag,
    ) || null
  );
}
function testStatus(testcase: Element): DoctorTestStatus {
  if (child(testcase, "error")) return "errored";
  if (child(testcase, "failure")) return "failed";
  if (child(testcase, "skipped")) return "skipped";
  return "passed";
}
function groupStatus(tests: DoctorTest[]): DoctorTestStatus {
  if (tests.some((test) => test.status === "errored")) return "errored";
  if (tests.some((test) => test.status === "failed")) return "failed";
  if (tests.some((test) => test.status === "skipped")) return "skipped";
  return "passed";
}
function summary(groups: DoctorGroup[]) {
  const values = groups.flatMap((group) => group.tests);
  return {
    total: values.length,
    passed: values.filter((test) => test.status === "passed").length,
    failed: values.filter((test) => test.status === "failed").length,
    skipped: values.filter((test) => test.status === "skipped").length,
    errored: values.filter((test) => test.status === "errored").length,
  };
}
function baseResult(
  options: ParseOptions,
  status: DoctorRunStatus,
  groups: DoctorGroup[],
  message?: string,
): DoctorResult {
  return {
    status,
    startedAt: options.startedAt,
    completedAt: options.completedAt,
    durationMs:
      options.durationMs ??
      Math.max(
        0,
        Date.parse(options.completedAt) - Date.parse(options.startedAt),
      ),
    command: options.command,
    summary: summary(groups),
    groups,
    stdout: options.stdout,
    stderr: options.stderr,
    outputTruncated: options.outputTruncated ?? false,
    ...(message ? { message } : {}),
    ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.revision ? { revision: options.revision } : {}),
    ...(options.dirty !== undefined ? { dirty: options.dirty } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.commands ? { commands: options.commands } : {}),
  };
}

export function parseJUnit(
  contents: string,
  options: ParseOptions,
): DoctorResult {
  let document: any;
  try {
    document = new DOMParser().parseFromString(contents, "text/xml");
  } catch (error) {
    return baseResult(
      options,
      "parse-error",
      [],
      `JUnit output could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parserError = document.querySelector("parsererror");
  const suites = Array.from(document.querySelectorAll("testsuite")) as any[];
  if (parserError || !suites.length)
    return baseResult(
      options,
      "parse-error",
      [],
      "JUnit output was missing a valid testsuite document.",
    );
  const groups = suites
    .flatMap((suite) => {
      const tests = (Array.from((suite as any).children) as any[])
        .filter((element) => element.tagName.toLowerCase() === "testcase")
        .map((testcase) => {
          const failure = child(testcase, "failure");
          const error = child(testcase, "error");
          const detail = failure || error;
          return {
            groupName:
              attribute(testcase, "classname") ||
              attribute(suite, "file") ||
              attribute(suite, "name") ||
              "Unnamed suite",
            test: {
              name: attribute(testcase, "name") || "Unnamed test",
              status: testStatus(testcase),
              durationMs: durationMs(attribute(testcase, "time")),
              ...(detail?.getAttribute("message")
                ? { message: detail.getAttribute("message") || undefined }
                : {}),
              ...(detail?.textContent?.trim()
                ? { output: detail.textContent.trim() }
                : {}),
            },
          };
        });
      return [...new Set(tests.map((test) => test.groupName))].map((name) => {
        const grouped = tests
          .filter((test) => test.groupName === name)
          .map((test) => test.test);
        return { name, status: groupStatus(grouped), tests: grouped };
      });
    })
    .filter((group) => group.tests.length > 0);
  const counts = summary(groups);
  if (!counts.total)
    return baseResult(
      options,
      options.exitCode === 0 ? "no-tests" : "runner-error",
      groups,
      "JUnit output contained no test cases.",
    );
  const status: DoctorRunStatus =
    options.exitCode === 0
      ? counts.failed || counts.errored
        ? "failed"
        : "passed"
      : counts.errored
        ? "errored"
        : "failed";
  return baseResult(options, status, groups);
}

function appendOutput(
  current: { value: string; truncated: boolean },
  chunk: Buffer | string,
): void {
  const incoming = Buffer.from(chunk).toString("utf8");
  const remaining =
    DOCTOR_OUTPUT_MAX_BYTES - Buffer.byteLength(current.value, "utf8");
  if (remaining <= 0) {
    current.truncated = true;
    return;
  }
  const bytes = Buffer.from(incoming, "utf8");
  if (bytes.byteLength > remaining) {
    current.value += bytes.subarray(0, remaining).toString("utf8");
    current.truncated = true;
  } else current.value += incoming;
}

export type BunRunnerOptions = {
  root: string;
  executable?: string;
  args?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  revision?: string;
  dirty?: boolean;
  runtime?: string;
  spawnFn?: typeof spawn;
};

export async function runBunUnitTests(
  options: BunRunnerOptions,
): Promise<DoctorResult> {
  const executable = options.executable || "bun";
  const args = options.args || ["test"];
  const command = [executable, ...args];
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const directory = await mkdtemp(path.join(os.tmpdir(), "resonance-doctor-"));
  const report = path.join(directory, "junit.xml");
  const stdout = { value: "", truncated: false };
  const stderr = { value: "", truncated: false };
  const spawnProcess = options.spawnFn || spawn;
  let childProcess;
  let timedOut = false;
  let cancelled = false;
  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: string | null;
    }>((resolve, reject) => {
      childProcess = spawnProcess(
        executable,
        [...args, "--reporter=junit", "--reporter-outfile", report],
        {
          cwd: options.root,
          env: { ...process.env, CI: "1", TZ: "UTC", FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      childProcess.stdout?.on("data", (chunk) => appendOutput(stdout, chunk));
      childProcess.stderr?.on("data", (chunk) => appendOutput(stderr, chunk));
      let forceTimeout;
      const timeout = setTimeout(() => {
        timedOut = true;
        childProcess.kill("SIGTERM");
        forceTimeout = setTimeout(() => childProcess.kill("SIGKILL"), 1000);
      }, options.timeoutMs || DOCTOR_DEFAULT_TIMEOUT_MS);
      const cancel = () => {
        cancelled = true;
        childProcess.kill("SIGTERM");
      };
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener("abort", cancel, { once: true });
      childProcess.once("error", reject);
      childProcess.once("close", (exitCode, signal) => {
        clearTimeout(timeout);
        if (forceTimeout) clearTimeout(forceTimeout);
        options.signal?.removeEventListener("abort", cancel);
        resolve({ exitCode, signal });
      });
    });
    const completedAt = new Date().toISOString();
    if (timedOut)
      return baseResult(
        {
          ...options,
          startedAt,
          completedAt,
          command,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: stdout.value,
          stderr: stderr.value,
          outputTruncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - started,
        },
        "timed-out",
        [],
        "The test run exceeded its timeout.",
      );
    if (cancelled)
      return baseResult(
        {
          ...options,
          startedAt,
          completedAt,
          command,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: stdout.value,
          stderr: stderr.value,
          outputTruncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - started,
        },
        "cancelled",
        [],
        "The test run was cancelled.",
      );
    let contents: string;
    try {
      contents = await readFile(report, "utf8");
    } catch {
      return baseResult(
        {
          ...options,
          startedAt,
          completedAt,
          command,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: stdout.value,
          stderr: stderr.value,
          outputTruncated: stdout.truncated || stderr.truncated,
          durationMs: Date.now() - started,
        },
        "runner-error",
        [],
        "The test runner did not produce JUnit output.",
      );
    }
    return parseJUnit(contents, {
      startedAt,
      completedAt,
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: stdout.value,
      stderr: stderr.value,
      outputTruncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started,
      revision: options.revision,
      dirty: options.dirty,
      runtime: options.runtime,
    });
  } catch (error) {
    const completedAt = new Date().toISOString();
    return baseResult(
      {
        startedAt,
        completedAt,
        command,
        exitCode: null,
        stdout: stdout.value,
        stderr: stderr.value,
        outputTruncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
        revision: options.revision,
        dirty: options.dirty,
        runtime: options.runtime,
      },
      "runner-error",
      [],
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export type CommandRunnerOptions = {
  root: string;
  executable: string;
  args: string[];
  label: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  revision?: string;
  dirty?: boolean;
  runtime?: string;
  spawnFn?: typeof spawn;
};

export async function runCommandCheck(
  options: CommandRunnerOptions,
): Promise<DoctorResult> {
  const command = [options.executable, ...options.args];
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const stdout = { value: "", truncated: false };
  const stderr = { value: "", truncated: false };
  let timedOut = false;
  let cancelled = false;
  let childProcess;
  try {
    const result = await new Promise<{
      exitCode: number | null;
      signal: string | null;
    }>((resolve, reject) => {
      childProcess = (options.spawnFn || spawn)(
        options.executable,
        options.args,
        {
          cwd: options.root,
          env: { ...process.env, CI: "1", TZ: "UTC", FORCE_COLOR: "0" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      childProcess.stdout?.on("data", (chunk) => appendOutput(stdout, chunk));
      childProcess.stderr?.on("data", (chunk) => appendOutput(stderr, chunk));
      let forceTimeout;
      const timeout = setTimeout(() => {
        timedOut = true;
        childProcess.kill("SIGTERM");
        forceTimeout = setTimeout(() => childProcess.kill("SIGKILL"), 1000);
      }, options.timeoutMs || DOCTOR_DEFAULT_TIMEOUT_MS);
      const cancel = () => {
        cancelled = true;
        childProcess.kill("SIGTERM");
      };
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener("abort", cancel, { once: true });
      childProcess.once("error", reject);
      childProcess.once("close", (exitCode, signal) => {
        clearTimeout(timeout);
        if (forceTimeout) clearTimeout(forceTimeout);
        options.signal?.removeEventListener("abort", cancel);
        resolve({ exitCode, signal });
      });
    });
    const completedAt = new Date().toISOString();
    const resultOptions = {
      startedAt,
      completedAt,
      command,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: stdout.value,
      stderr: stderr.value,
      outputTruncated: stdout.truncated || stderr.truncated,
      durationMs: Date.now() - started,
      revision: options.revision,
      dirty: options.dirty,
      runtime: options.runtime,
    };
    if (timedOut)
      return baseResult(
        resultOptions,
        "timed-out",
        [],
        "The check exceeded its timeout.",
      );
    if (cancelled)
      return baseResult(
        resultOptions,
        "cancelled",
        [],
        "The check was cancelled.",
      );
    const status: DoctorTestStatus =
      result.exitCode === 0 ? "passed" : "failed";
    const detail = [stderr.value, stdout.value]
      .filter(Boolean)
      .join("\n")
      .trim();
    const groups: DoctorGroup[] = [
      {
        name: options.label,
        status,
        tests: [
          {
            name: options.label,
            status,
            ...(detail ? { output: detail } : {}),
          },
        ],
      },
    ];
    return baseResult(
      resultOptions,
      status,
      groups,
      result.exitCode === 0
        ? undefined
        : `The command exited with code ${result.exitCode ?? "unknown"}.`,
    );
  } catch (error) {
    const completedAt = new Date().toISOString();
    return baseResult(
      {
        startedAt,
        completedAt,
        command,
        exitCode: null,
        stdout: stdout.value,
        stderr: stderr.value,
        outputTruncated: stdout.truncated || stderr.truncated,
        durationMs: Date.now() - started,
        revision: options.revision,
        dirty: options.dirty,
        runtime: options.runtime,
      },
      "runner-error",
      [],
      error instanceof Error ? error.message : String(error),
    );
  }
}

export type BunAuditFinding = {
  packageName: string;
  advisoryId: string;
  url?: string;
  title?: string;
  severity?: string;
  vulnerableVersions?: string;
};

function jsonObject(contents: string): Record<string, unknown> {
  const start = contents.indexOf("{");
  if (start < 0) throw new Error("Bun audit output did not contain JSON.");
  try {
    const value = JSON.parse(contents.slice(start).trim());
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Bun audit JSON was not an object.");
    return value;
  } catch (error) {
    throw new Error(
      `Bun audit JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function parseBunAudit(contents: string): BunAuditFinding[] {
  const value = jsonObject(contents);
  return Object.entries(value).flatMap(([packageName, advisories]) => {
    if (!Array.isArray(advisories)) return [];
    return advisories.flatMap((advisory) => {
      if (!advisory || typeof advisory !== "object") return [];
      const item = advisory as Record<string, unknown>;
      if (item.id === undefined || item.id === null) return [];
      return [
        {
          packageName,
          advisoryId: String(item.id),
          ...(typeof item.url === "string" ? { url: item.url } : {}),
          ...(typeof item.title === "string" ? { title: item.title } : {}),
          ...(typeof item.severity === "string"
            ? { severity: item.severity }
            : {}),
          ...(typeof item.vulnerable_versions === "string"
            ? { vulnerableVersions: item.vulnerable_versions }
            : {}),
        },
      ];
    });
  });
}

export type BunOutdatedDependency = {
  packageName: string;
  current: string;
  update: string;
  latest: string;
  dev: boolean;
};

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
}

export function parseBunOutdated(contents: string): BunOutdatedDependency[] {
  const rows = stripAnsi(contents)
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  const header = rows.findIndex(
    (row) =>
      row.length === 4 &&
      row[0] === "Package" &&
      row[1] === "Current" &&
      row[2] === "Update" &&
      row[3] === "Latest",
  );
  if (header < 0) {
    if (/no outdated (packages|dependencies)/i.test(contents)) return [];
    throw new Error("Bun outdated output did not contain its package table.");
  }
  return rows.slice(header + 1).flatMap((row) => {
    if (row.length !== 4 || !row[0] || /^-+$/.test(row[0])) return [];
    const dev = /\s+\(dev\)$/.test(row[0]);
    return [
      {
        packageName: row[0].replace(/\s+\(dev\)$/, ""),
        current: row[1],
        update: row[2],
        latest: row[3],
        dev,
      },
    ];
  });
}

export type BunDependencySecurityOptions = BunRunnerOptions & {
  commandRunner?: (options: CommandRunnerOptions) => Promise<DoctorResult>;
};

export async function runBunDependencySecurity(
  options: BunDependencySecurityOptions,
): Promise<DoctorResult> {
  const started = Date.now();
  const executable = options.executable || "bun";
  const commandRunner = options.commandRunner || runCommandCheck;
  const audit = await commandRunner({
    root: options.root,
    executable,
    args: ["audit", "--json"],
    label: "Bun audit",
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    revision: options.revision,
    dirty: options.dirty,
    runtime: options.runtime,
    spawnFn: options.spawnFn,
  });
  if (audit.status !== "passed" && audit.status !== "failed") return audit;

  let vulnerabilities: BunAuditFinding[];
  try {
    vulnerabilities = parseBunAudit(audit.stdout);
  } catch (error) {
    return {
      ...audit,
      status: "parse-error",
      message: error instanceof Error ? error.message : String(error),
      groups: [],
    };
  }
  if (audit.exitCode !== 0 && audit.exitCode !== 1)
    return {
      ...audit,
      status: "runner-error",
      message: `Bun audit exited with code ${audit.exitCode ?? "unknown"}.`,
      groups: [],
    };

  const outdated = await commandRunner({
    root: options.root,
    executable,
    args: ["outdated"],
    label: "Bun outdated",
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    revision: options.revision,
    dirty: options.dirty,
    runtime: options.runtime,
    spawnFn: options.spawnFn,
  });
  if (outdated.status !== "passed") return outdated;

  let updates: BunOutdatedDependency[];
  try {
    updates = parseBunOutdated(outdated.stdout);
  } catch (error) {
    return {
      ...outdated,
      status: "parse-error",
      message: error instanceof Error ? error.message : String(error),
      groups: [],
    };
  }
  const vulnerabilityTests: DoctorTest[] = vulnerabilities.length
    ? vulnerabilities.map((finding) => ({
        name: `${finding.packageName} · ${finding.advisoryId}`,
        status: "failed",
        ...(finding.title ? { message: finding.title } : {}),
        details: {
          packageName: finding.packageName,
          advisoryId: finding.advisoryId,
          ...(finding.url ? { url: finding.url } : {}),
          ...(finding.severity ? { severity: finding.severity } : {}),
          ...(finding.vulnerableVersions
            ? { vulnerableVersions: finding.vulnerableVersions }
            : {}),
        },
      }))
    : [{ name: "No known vulnerabilities", status: "passed" }];
  const outdatedTests: DoctorTest[] = updates.length
    ? updates.map((dependency) => ({
        name: dependency.packageName,
        status: "failed",
        message: `${dependency.current} → ${dependency.update} (latest ${dependency.latest})`,
        details: dependency,
      }))
    : [{ name: "All dependencies are current", status: "passed" }];
  const groups = [
    {
      name: "Vulnerabilities",
      status: groupStatus(vulnerabilityTests),
      tests: vulnerabilityTests,
    },
    {
      name: "Outdated dependencies",
      status: groupStatus(outdatedTests),
      tests: outdatedTests,
    },
  ];
  const findings = vulnerabilities.length + updates.length;
  const completedAt = new Date().toISOString();
  return baseResult(
    {
      startedAt: audit.startedAt,
      completedAt,
      command: audit.command,
      commands: [audit.command, outdated.command],
      exitCode: findings ? 1 : 0,
      stdout: `--- bun audit --json ---\n${audit.stdout}\n--- bun outdated ---\n${outdated.stdout}`,
      stderr: [audit.stderr, outdated.stderr].filter(Boolean).join("\n"),
      outputTruncated: audit.outputTruncated || outdated.outputTruncated,
      durationMs: Date.now() - started,
      revision: options.revision,
      dirty: options.dirty,
      runtime: options.runtime,
    },
    findings ? "failed" : "passed",
    groups,
    findings
      ? `Found ${vulnerabilities.length} vulnerabilities and ${updates.length} outdated dependencies.`
      : undefined,
  );
}
