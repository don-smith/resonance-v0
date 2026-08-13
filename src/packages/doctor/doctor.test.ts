import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { createApp } from "../../server.ts";
import { createHost } from "../../host.ts";
import { createDoctorPackage } from "./index.ts";
import createPackage from "./doctor.js";
import { createTelemetry } from "../../telemetry.ts";
import { createDoctorAgentSession } from "./doctor-agent.ts";

async function withServer(run, options) {
  const server = await createApp(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("doctor composes through server and browser contracts", async () => {
  const root = await mkdtemp(`${tmpdir()}/resonance-doctor-`);
  try {
    const appRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const config = {
      version: 1,
      packages: {
        shell: { module: "src/packages/shell/index.ts" },
        doctor: { module: "src/packages/doctor/index.ts" },
      },
    };
    await withServer(
      async (baseUrl) => {
        const manifest = await fetch(`${baseUrl}/api/manifest`).then(
          (response) => response.json(),
        );
        assert.ok(manifest.packages.some((item) => item.id === "doctor"));
        const doctor = await fetch(`${baseUrl}/api/doctor`).then((response) =>
          response.json(),
        );
        assert.equal(doctor.id, "doctor");
        assert.equal(doctor.label, "Doctor");
        assert.equal(doctor.checks.length, 5);
        const agentState = await fetch(`${baseUrl}/api/doctor/agent/state`).then((response) => response.json());
        assert.deepEqual(agentState, { messages: [], status: "idle", hasSession: false, error: null, context: null });
        assert.equal((await fetch(`${baseUrl}/api/doctor/agent/prompt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "Explain this check", selectedCheck: "unit-tests" }) })).status, 202);
        assert.equal(

          (await fetch(`${baseUrl}/assets/doctor/doctor.js`)).status,
          200,
        );
        assert.equal(
          (await fetch(`${baseUrl}/assets/doctor/doctor.css`)).status,
          200,
        );
      },
      { root, appRoot, config },
    );
    const { document } = parseHTML("<!doctype html><body></body>");
    const mount = document.createElement("section");
    const instance = createPackage({
      fetchFn: async () => ({
        ok: true,
        async json() {
          return { label: "Doctor" };
        },
      }),
    });
    instance.mount(mount);
    await instance.activate();
    assert.equal(
      mount.querySelector(".doctor-navigator h1").textContent,
      "Doctor",
    );
    instance.deactivate();
    assert.equal(mount.hidden, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discovers, configures, runs, and remembers the target repository unit tests", async () => {
  const root = await mkdtemp(`${tmpdir()}/resonance-doctor-run-`);
  try {
    await writeFile(
      `${root}/package.json`,
      JSON.stringify({
        packageManager: "bun@1.3.13",
        scripts: {
          test: "bun test",
          typecheck: "tsc --noEmit",
          lint: "prettier --check .",
          integration:
            "bun test src/server.test.ts src/packages/browser-integration.test.ts",
        },
      }),
    );
    await writeFile(`${root}/bun.lock`, "");
    const result = {
      status: "passed",
      startedAt: "2026-03-10T14:22:01.000Z",
      completedAt: "2026-03-10T14:22:02.000Z",
      durationMs: 1000,
      command: ["bun", "test"],
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 },
      groups: [
        {
          name: "unit.test.ts",
          status: "passed",
          tests: [{ name: "works", status: "passed" }],
        },
      ],
      stdout: "",
      stderr: "",
      outputTruncated: false,
    };
    const registry = createHost({
      root,
      appRoot: fileURLToPath(new URL("../../../", import.meta.url)),
      config: { version: 1, packages: { doctor: {} } },
      packages: [
        createDoctorPackage({
          runCheck: async () => result,
          runDependencyCheck: async () => result,
        }),
      ],
    });
    const server = await createApp({ registry });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      const initial = await fetch(`${baseUrl}/api/doctor`).then((response) =>
        response.json(),
      );
      assert.equal(initial.onboardingRequired, true);
      assert.equal(
        initial.checks.find((check) => check.id === "unit-tests").candidate
          .executable,
        "bun",
      );
      assert.deepEqual(
        initial.checks.find((check) => check.id === "type-check").candidate
          .args,
        ["run", "typecheck"],
      );
      assert.deepEqual(
        initial.checks.find((check) => check.id === "lint-format").candidate
          .args,
        ["run", "lint"],
      );
      assert.deepEqual(
        initial.checks.find((check) => check.id === "integration-tests")
          .candidate.args,
        ["run", "integration"],
      );
      assert.equal(
        initial.checks.find((check) => check.id === "dependency-security")
          .candidate.runner,
        "dependency-security",
      );
      assert.equal(
        initial.checks.find((check) => check.id === "dependency-security")
          .candidate.command,
        "bun audit --json + bun outdated",
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/doctor/configure`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ checkId: "unit-tests" }),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/doctor/configure`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ checkId: "type-check" }),
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await fetch(`${baseUrl}/api/doctor/configure`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ checkId: "dependency-security" }),
          })
        ).status,
        200,
      );
      const run = await fetch(`${baseUrl}/api/doctor/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkId: "unit-tests" }),
      }).then((response) => response.json());
      assert.equal(run.result.status, "passed");
      const dependencyRun = await fetch(`${baseUrl}/api/doctor/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkId: "dependency-security" }),
      }).then((response) => response.json());
      assert.equal(dependencyRun.result.status, "passed");
      assert.equal(
        (
          await fetch(`${baseUrl}/api/doctor/results`).then((response) =>
            response.json(),
          )
        ).results["unit-tests"].summary.passed,
        1,
      );
    } finally {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    assert.equal(
      JSON.parse(
        await readFile(`${root}/.resonance/state/doctor/state.json`, "utf8"),
      ).results["unit-tests"].status,
      "passed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configures a discovered unit-test command without replacing the workspace with an activation error", async () => {
  const { document } = parseHTML("<!doctype html><body></body>");
  const mount = document.createElement("section");
  const checks = [
    "Unit tests",
    "Type checking",
    "Lint / format",
    "Integration tests",
    "Dependency security",
  ].map((label, index) => ({
    id: [
      "unit-tests",
      "type-check",
      "lint-format",
      "integration-tests",
      "dependency-security",
    ][index],
    label,
    buttonLabel: `Run ${label.toLowerCase()}`,
    description: label,
    configured: index !== 0,
    candidate:
      index === 0 ? { runner: "bun", executable: "bun", args: ["test"] } : null,
    lastStatus: null,
  }));
  const instance = createPackage({
    fetchFn: async (url) => ({
      ok: true,
      async json() {
        if (url === "/api/doctor") return { label: "Doctor", checks };
        if (url === "/api/doctor/configure") return { ok: true };
        return { results: {} };
      },
    }),
  });
  instance.mount(mount);
  await instance.activate();
  mount.querySelector(".doctor-configure-check").click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(mount.querySelector('[role="alert"]'), null);
  assert.ok(mount.querySelector(".doctor-workspace"));
  instance.deactivate();
});

test("renders the persisted result with grouped statuses and timing", async () => {
  const { document } = parseHTML("<!doctype html><body></body>");
  const mount = document.createElement("section");
  const result = {
    status: "failed",
    completedAt: "2026-03-10T14:22:02.000Z",
    durationMs: 1200,
    summary: { total: 2, passed: 1, failed: 1, skipped: 0, errored: 0 },
    groups: [
      {
        name: "src/example.test.ts",
        status: "failed",
        tests: [
          { name: "passes", status: "passed" },
          { name: "fails", status: "failed", message: "Expected true" },
        ],
      },
    ],
  };
  const checks = [
    "Unit tests",
    "Type checking",
    "Lint / format",
    "Integration tests",
    "Dependency security",
  ].map((label, index) => ({
    id: [
      "unit-tests",
      "type-check",
      "lint-format",
      "integration-tests",
      "dependency-security",
    ][index],
    label,
    buttonLabel: `Run ${label.toLowerCase()}`,
    description: label,
    configured: true,
    candidate: null,
    lastStatus: index === 0 ? "failed" : null,
  }));
  const instance = createPackage({
    fetchFn: async (url) => ({
      ok: true,
      async json() {
        return url === "/api/doctor"
          ? { label: "Doctor", checks }
          : { results: { "unit-tests": result } };
      },
    }),
  });
  instance.mount(mount);
  await instance.activate();
  assert.equal(mount.querySelector(".doctor-results h1").textContent, "Failed");
  assert.equal(
    mount.querySelector(".doctor-result-group-name").textContent,
    "src/example.test.ts",
  );
  assert.equal(
    mount.querySelector(".doctor-result-failure").textContent,
    "Expected true",
  );
  assert.equal(
    mount.querySelector(".doctor-nav-test").dataset.status,
    "failed",
  );
  instance.deactivate();
});

test("restores Doctor's selected check and agent visibility from package-local storage", async () => {
  const { window, document } = parseHTML("<!doctype html><body></body>");
  globalThis.window = window;
  globalThis.document = document;
  const values = new Map();
  window.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
  const fetchFn = async (url) => ({
    ok: true,
    async json() {
      return url === "/api/doctor" ? { label: "Doctor" } : { results: {} };
    },
  });
  try {
    const mount = document.createElement("section");
    document.body.append(mount);
    const first = createPackage({ fetchFn });
    first.mount(mount);
    await first.activate();
    mount.querySelector('[data-check-id="type-check"]').click();
    mount.querySelector(".doctor-agent-toggle").click();
    assert.equal(values.get("resonance:doctor:selected-check"), "type-check");
    assert.equal(values.get("resonance:doctor:agent-visible"), "false");
    first.deactivate();
    const restoredMount = document.createElement("section");
    document.body.append(restoredMount);
    const second = createPackage({ fetchFn });
    second.mount(restoredMount);
    await second.activate();
    assert.equal(
      restoredMount.querySelector(".doctor-nav-test.active").dataset.checkId,
      "type-check",
    );
    assert.equal(restoredMount.querySelector(".doctor-agent").hidden, true);
    second.deactivate();
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("the Doctor agent preserves check context and streams through the shared session contract", async () => {
  const events: any[] = [];
  const session = createDoctorAgentSession({ provider: "openrouter", model: "test-model", telemetry: createTelemetry({ config: { mode: "off" } }), credentialProvider: async () => "local-key", runtimeFactory: async () => ({
    async *stream() { yield { kind: "context" as const, context: { inputTokens: 2400, maxInputTokens: 10000 } }; yield { kind: "assistant" as const, text: "Review the failure." }; },
    async dispose() {},
  }) });
  session.subscribe((event) => events.push(event));
  await session.submitPrompt({ prompt: "Why did this fail?", check: { id: "unit-tests", label: "Unit tests", description: "Run tests", result: undefined } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.snapshot().context?.inputTokens, 2400);
  assert.match(session.snapshot().messages.at(-1)?.content || "", /Review the failure/);
  assert.ok(events.some((event) => event.type === "context"));
  await session.dispose();
});

test("keeps each Doctor response after the prompt that produced it", async () => {
  const session = createDoctorAgentSession({
    provider: "openrouter",
    model: "test-model",
    credentialProvider: async () => "local-key",
    runtimeFactory: async () => ({
      async *stream(turn) {
        const promptCount = turn.messages.filter((message) => message.role === "user").length;
        yield { kind: "assistant" as const, text: `Response ${promptCount}` };
      },
      async dispose() {},
    }),
  });
  const check = { id: "unit-tests", label: "Unit tests", description: "Run tests" };
  await session.submitPrompt({ prompt: "First request", check });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await session.submitPrompt({ prompt: "Second request", check });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(session.snapshot().messages.map((message) => [message.role, message.content]), [
    ["user", "First request"],
    ["assistant", "Response 1"],
    ["user", "Second request"],
    ["assistant", "Response 2"],
  ]);
  await session.dispose();
});

test("renders check navigation, a default unit-test view, and a toggleable agent panel", async () => {
  const { document } = parseHTML("<!doctype html><body></body>");
  const mount = document.createElement("section");
  let stream;
  const instance = createPackage({
    eventSourceFactory: () => (stream = { close() {} }),
    fetchFn: async () => ({
      ok: true,
      async json() {
        return { label: "Doctor" };
      },
    }),
  });
  instance.mount(mount);
  await instance.activate();
  stream.onmessage({ data: JSON.stringify({ type: "status", status: "working" }) });
  assert.equal(mount.querySelector(".doctor-send").textContent, "Stop");
  assert.equal(mount.querySelector(".doctor-send").classList.contains("resonance-agent-stop"), true);
  stream.onmessage({ data: JSON.stringify({ type: "status", status: "idle" }) });

  assert.deepEqual(
    [...mount.querySelectorAll(".doctor-nav-test")].map(
      (button) => button.textContent,
    ),
    [
      "Unit tests",
      "Type checking",
      "Lint / format",
      "Integration tests",
      "Dependency security",
    ],
  );
  assert.equal(
    mount.querySelector(".doctor-test-name").textContent,
    "Unit tests",
  );
  assert.equal(
    mount.querySelector(".doctor-results h1").textContent,
    "Select a test to run",
  );
  assert.equal(
    mount.querySelector(".doctor-run-check").textContent,
    "Run unit tests",
  );
  assert.equal(mount.querySelector(".doctor-transcript").textContent, "Ask about the selected item.");
  const prompt = mount.querySelector(".doctor-composer textarea");
  const send = mount.querySelector(".doctor-send");
  assert.equal(send.disabled, true);
  prompt.value = "What failed?";
  prompt.dispatchEvent(
    new document.defaultView.Event("input", { bubbles: true }),
  );
  assert.equal(send.disabled, false);
  assert.equal(
    mount.querySelector(".doctor-nav-test.active").textContent,
    "Unit tests",
  );
  mount.querySelector('[data-check-id="type-check"]').click();
  assert.equal(
    mount.querySelector(".doctor-test-name").textContent,
    "Type checking",
  );
  assert.equal(
    mount.querySelector(".doctor-run-check").textContent,
    "Run type checking",
  );
  assert.equal(
    mount.querySelector(".doctor-nav-test.active").textContent,
    "Type checking",
  );

  const css = await readFile(new URL("./doctor.css", import.meta.url), "utf8");
  assert.match(css, /\.doctor-instructions \{[^}]*margin: 0 auto;/s);
  assert.match(
    css,
    /\.doctor-composer textarea \{[^}]*background: var\(--paper/,
  );
  assert.match(
    css,
    /\.doctor-reset,\s*\.doctor-retry \{[^}]*background: transparent !important;/s,
  );
  assert.deepEqual(
    [...css.matchAll(/\.doctor-agent-toggle \{[^}]*right: (\d+)px;/gs)].map(
      (match) => match[1],
    ),
    ["20", "20", "20"],
  );

  const toggle = mount.querySelector(".doctor-agent-toggle");
  const agent = mount.querySelector(".doctor-agent");
  toggle.click();
  assert.equal(agent.hidden, true);
  assert.equal(
    mount
      .querySelector(".doctor-workspace")
      .classList.contains("doctor-agent-hidden"),
    true,
  );
  toggle.click();
  assert.equal(agent.hidden, false);
  instance.deactivate();
});
