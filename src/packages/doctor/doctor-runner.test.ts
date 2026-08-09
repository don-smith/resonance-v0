import test from "node:test";
import assert from "node:assert/strict";
import {
  parseBunAudit,
  parseBunOutdated,
  runBunDependencySecurity,
  parseJUnit,
  runCommandCheck,
} from "./doctor-runner.ts";

test("parses JUnit suites into grouped Doctor results", () => {
  const result = parseJUnit(
    `<?xml version="1.0"?><testsuites><testsuite name="server" tests="2" failures="1" time="0.12"><testcase classname="src/server.test.ts" name="serves health" time="0.01"/><testcase classname="src/server.test.ts" name="rejects failure" time="0.11"><failure message="Expected 200, received 500">Assertion stack</failure></testcase></testsuite></testsuites>`,
    {
      startedAt: "2026-03-10T14:22:01.000Z",
      completedAt: "2026-03-10T14:22:01.120Z",
      exitCode: 1,
      command: ["bun", "test"],
      stdout: "",
      stderr: "",
    },
  );

  assert.equal(result.status, "failed");
  assert.deepEqual(result.summary, {
    total: 2,
    passed: 1,
    failed: 1,
    skipped: 0,
    errored: 0,
  });
  assert.equal(result.groups[0].name, "src/server.test.ts");
  assert.equal(result.groups[0].tests[1].message, "Expected 200, received 500");
  assert.equal(result.groups[0].tests[1].output, "Assertion stack");
});

test("treats skipped and errored cases as distinct statuses", () => {
  const result = parseJUnit(
    `<testsuites><testsuite name="checks"><testcase classname="a.test.ts" name="skipped"><skipped/></testcase><testcase classname="a.test.ts" name="errored"><error message="process failed">details</error></testcase></testsuite></testsuites>`,
    {
      startedAt: "2026-03-10T14:22:01.000Z",
      completedAt: "2026-03-10T14:22:02.000Z",
      exitCode: 1,
      command: ["bun", "test"],
      stdout: "out",
      stderr: "err",
    },
  );

  assert.deepEqual(result.summary, {
    total: 2,
    passed: 0,
    failed: 0,
    skipped: 1,
    errored: 1,
  });
  assert.equal(result.groups[0].tests[0].status, "skipped");
  assert.equal(result.groups[0].tests[1].status, "errored");
});

test("normalizes a failing static-analysis command into a visible result", async () => {
  const result = await runCommandCheck({
    root: process.cwd(),
    executable: process.execPath,
    args: ["-e", 'console.error("type error"); process.exit(1)'],
    label: "Type checking",
  });
  assert.equal(result.status, "failed");
  assert.equal(result.groups[0].name, "Type checking");
  assert.match(result.stderr, /type error/);
  assert.equal(result.summary.failed, 1);
});

test("parses Bun audit JSON after the Bun command banner", () => {
  const vulnerabilities = parseBunAudit(`bun audit v1.3.13
{"postcss":[{"id":1124288,"url":"https://github.com/advisories/GHSA-r28c-9q8g-f849","title":"Path traversal","severity":"high","vulnerable_versions":"<=8.5.17"}]}`);

  assert.deepEqual(vulnerabilities, [
    {
      packageName: "postcss",
      advisoryId: "1124288",
      url: "https://github.com/advisories/GHSA-r28c-9q8g-f849",
      title: "Path traversal",
      severity: "high",
      vulnerableVersions: "<=8.5.17",
    },
  ]);
});

test("parses Bun outdated tables into package freshness records", () => {
  assert.deepEqual(
    parseBunOutdated(`bun outdated v1.3.13
| Package          | Current | Update  | Latest |
|------------------|---------|---------|--------|
| react            | 19.2.7  | 19.2.8  | 19.2.8 |
| typescript (dev) | 5.9.3   | 5.9.3   | 7.0.2  |
|------------------|---------|---------|--------|`),
    [
      {
        packageName: "react",
        current: "19.2.7",
        update: "19.2.8",
        latest: "19.2.8",
        dev: false,
      },
      {
        packageName: "typescript",
        current: "5.9.3",
        update: "5.9.3",
        latest: "7.0.2",
        dev: true,
      },
    ],
  );
});

test("combines Bun audit and outdated results without treating audit findings as a runner error", async () => {
  const result = await runBunDependencySecurity({
    root: process.cwd(),
    commandRunner: async (options) =>
      options.args[0] === "audit"
        ? {
            status: "failed",
            startedAt: "2026-03-10T14:22:01.000Z",
            completedAt: "2026-03-10T14:22:01.100Z",
            durationMs: 100,
            command: ["bun", "audit", "--json"],
            summary: { total: 1, passed: 0, failed: 1, skipped: 0, errored: 0 },
            groups: [],
            stdout:
              'bun audit v1.3.13\n{"postcss":[{"id":1124288,"severity":"high","title":"Path traversal"}]}',
            stderr: "",
            outputTruncated: false,
            exitCode: 1,
          }
        : {
            status: "passed",
            startedAt: "2026-03-10T14:22:01.100Z",
            completedAt: "2026-03-10T14:22:01.200Z",
            durationMs: 100,
            command: ["bun", "outdated"],
            summary: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
            groups: [],
            stdout:
              "| Package | Current | Update | Latest |\n|---|---|---|---|\n| react | 19.2.7 | 19.2.8 | 19.2.8 |",
            stderr: "",
            outputTruncated: false,
            exitCode: 0,
          },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.groups[0].name, "Vulnerabilities");
  assert.equal(result.groups[0].tests[0].details.advisoryId, "1124288");
  assert.equal(result.groups[1].tests[0].details.packageName, "react");
  assert.deepEqual(result.commands, [
    ["bun", "audit", "--json"],
    ["bun", "outdated"],
  ]);
});

test("does not report a passing result when the JUnit document is malformed", () => {
  const result = parseJUnit("<testsuites>", {
    startedAt: "2026-03-10T14:22:01.000Z",
    completedAt: "2026-03-10T14:22:02.000Z",
    exitCode: 0,
    command: ["bun", "test"],
    stdout: "",
    stderr: "",
  });

  assert.equal(result.status, "parse-error");
  assert.match(result.message, /JUnit/i);
});
