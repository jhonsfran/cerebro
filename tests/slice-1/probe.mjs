/* oxlint-disable no-await-in-loop, unicorn/no-await-expression-member -- Samples and fault injection must retain scenario ordering. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { validatePerformance } from "./performance.mjs";
import { boundaries, createFixture } from "./provider.mjs";

const execute = promisify(execFile);
const configuration = JSON.parse(
  await readFile(new URL("scenarios.json", import.meta.url), "utf-8")
);
const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    "baseline-fixture-id": { type: "string" },
    "baseline-sha": { type: "string" },
    driver: { type: "string" },
    "fixture-id": { type: "string" },
    "fixture-url": { type: "string" },
    output: { type: "string" },
    scenario: { default: "fixture", type: "string" },
    "self-test": { type: "boolean" },
  },
});
const request = async (url, route, input, headers = {}) => {
  const response = await fetch(`${url}${route}`, {
    body: input === undefined ? undefined : JSON.stringify(input),
    headers: { "Content-Type": "application/json", ...headers },
    method: input === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(15_000),
  });
  return { body: await response.json(), status: response.status };
};
const controls = { "X-Fixture-Control": configuration.fixture.controlToken };
const modelHeaders = (operationId, purpose = "turn") => ({
  Authorization: `Bearer ${configuration.fixture.modelKey}`,
  "X-Fixture-Purpose": purpose,
  "X-Fixture-Request-Id": operationId,
});
const toolHeaders = {
  Authorization: `Bearer ${configuration.fixture.connectorKey}`,
};

const fixtureProbe = async (url) => {
  const prefix = `probe-${Date.now()}`;
  const initial = (await request(url, "/observations")).body;
  assert.equal((await request(url, "/control", {}, {})).status, 403);
  assert.equal(
    (await request(url, "/control", { delayMs: 50, failFirst: true }, controls))
      .status,
    200
  );
  const input = {
    messages: [{ content: "no tools", role: "user" }],
    model: "slice-1",
    stream: true,
  };
  assert.equal(
    (
      await request(
        url,
        "/v1/chat/completions",
        input,
        modelHeaders(`${prefix}-text`)
      )
    ).status,
    503
  );
  const startedAt = performance.now();
  const stream = await fetch(`${url}/v1/chat/completions`, {
    body: JSON.stringify(input),
    headers: {
      "Content-Type": "application/json",
      ...modelHeaders(`${prefix}-text`),
    },
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(stream.status, 200);
  let firstTextAt;
  let text = "";
  for await (const chunk of stream.body) {
    text += new TextDecoder().decode(chunk);
    if (text.includes('"content":"Cerebro"')) {
      firstTextAt ??= performance.now();
    }
  }
  const eofAt = performance.now();
  assert.ok(
    firstTextAt && firstTextAt < eofAt - 20,
    "Text must arrive before EOF"
  );
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  await request(
    url,
    "/v1/chat/completions",
    { ...input, stream: false },
    modelHeaders(`${prefix}-compact`, "compaction")
  );
  assert.equal(
    (
      await request(
        url,
        "/v1/chat/completions",
        { ...input, stream: false },
        modelHeaders(`${prefix}-compact`, "compaction")
      )
    ).status,
    200
  );
  await request(url, "/control", { failFirst: false }, controls);
  const toolModel = await request(
    url,
    "/v1/chat/completions",
    {
      ...input,
      stream: false,
      tools: [
        {
          function: { name: "fixture_effect", parameters: { type: "object" } },
          type: "function",
        },
      ],
    },
    { ...modelHeaders(`${prefix}-tool`), "X-Fixture-Tool": "fixture_effect" }
  );
  assert.equal(toolModel.body.choices[0].finish_reason, "tool_calls");
  const operationId = `${prefix}-write`;
  const write = { operationId, value: "approved-fixture" };
  assert.equal(
    (await request(url, "/effects", write, toolHeaders)).status,
    200
  );
  assert.equal(
    (await request(url, "/effects", write, toolHeaders)).status,
    200
  );
  assert.equal(
    (
      await request(
        url,
        "/effects",
        { ...write, value: "changed" },
        toolHeaders
      )
    ).status,
    409
  );
  assert.equal(
    (await request(url, `/effects?operationId=${operationId}`)).status,
    200
  );
  const beforeReconcile = (await request(url, "/observations")).body.tools
    .length;
  await request(url, `/effects?operationId=${operationId}`);
  assert.equal(
    (await request(url, "/observations")).body.tools.length,
    beforeReconcile
  );
  assert.equal(
    (
      await request(
        url,
        "/mcp",
        {
          id: `${prefix}-read`,
          method: "pilot_read",
          params: { query: "slice-1" },
        },
        toolHeaders
      )
    ).status,
    200
  );
  for (const boundary of boundaries) {
    const checkpointId = `${prefix}-${boundary}`;
    await request(
      url,
      "/control",
      { arm: { boundary, operationId: checkpointId } },
      controls
    );
    const pending = request(
      url,
      "/checkpoints",
      { boundary, operationId: checkpointId },
      controls
    );
    let observation;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      observation = (await request(url, "/observations")).body;
      if (
        observation.checkpoints.some(
          (entry) => entry.operationId === checkpointId && entry.armed
        )
      ) {
        break;
      }
      await delay(10);
    }
    assert.ok(
      observation.checkpoints.some(
        (entry) => entry.operationId === checkpointId && entry.armed
      )
    );
    await request(url, "/control", { arm: null, release: true }, controls);
    assert.equal((await pending).status, 200);
  }
  const observed = (await request(url, "/observations")).body;
  assert.equal(observed.model.length - initial.model.length, 5);
  assert.equal(observed.tools.length - initial.tools.length, 3);
  assert.equal(
    observed.tools.filter((entry) => entry.operationId === operationId).length,
    2,
    "Repeated physical writes must remain visible"
  );
  return {
    checkpointBoundaries: boundaries,
    committed: observed,
    eofMs: eofAt - startedAt,
    firstTextMs: firstTextAt - startedAt,
    fixtureId: observed.fixtureId,
    fixtureSha: observed.sha,
    physicalModelCalls: 5,
    physicalToolCalls: 3,
    scope: "fixture infrastructure",
    status: "pass",
  };
};

if (values["self-test"]) {
  test("delayed provider, retries, compaction, physical effects and checkpoint barriers", async () => {
    const directory = await mkdtemp("/tmp/cerebro-s1-fixture-");
    const fixture = await createFixture({
      directory,
      fixtureId: "self-test",
      sha: "self-test",
    });
    fixture.server.listen(0, "127.0.0.1");
    await once(fixture.server, "listening");
    try {
      await fixtureProbe(`http://127.0.0.1:${fixture.server.address().port}`);
    } finally {
      await promisify(fixture.server.close.bind(fixture.server))();
      await fixture.flush();
    }
    const restored = await createFixture({
      directory,
      fixtureId: "self-test",
      sha: "self-test",
    });
    restored.server.listen(0, "127.0.0.1");
    await once(restored.server, "listening");
    try {
      const committed = (
        await request(
          `http://127.0.0.1:${restored.server.address().port}`,
          "/observations"
        )
      ).body;
      assert.equal(committed.model.length, 5);
      assert.equal(committed.tools.length, 3);
      assert.equal(
        committed.checkpoints.filter((entry) => entry.armed).length,
        10
      );
    } finally {
      await promisify(restored.server.close.bind(restored.server))();
    }
    await assert.rejects(
      createFixture({ directory, fixtureId: "different", sha: "self-test" }),
      /different identity/u
    );
  });
  test("SIGKILL after a physical write retains read-only reconciliation evidence", async () => {
    const directory = await mkdtemp("/tmp/cerebro-s1-kill-");
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "provider.mjs")],
      {
        env: {
          ...process.env,
          FIXTURE_DATA_DIR: directory,
          FIXTURE_ID: "kill-test",
          FIXTURE_PORT: "0",
          FIXTURE_SHA: "self-test",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }
    );
    // The standalone process reports its allocated port through IPC only in tests.
    try {
      const [{ port }] = await once(child, "message");
      const url = `http://127.0.0.1:${port}`;
      await request(
        url,
        "/control",
        { arm: { boundary: "after-tool-dispatch" } },
        controls
      );
      const pending = request(
        url,
        "/effects",
        { operationId: "unknown-write", value: "approved-fixture" },
        toolHeaders
      );
      const interrupted = (async () => {
        try {
          return await pending;
        } catch {
          return null;
        }
      })();
      let committed;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        committed = (await request(url, "/observations")).body;
        if (
          committed.checkpoints.some(
            (entry) => entry.boundary === "after-tool-dispatch" && entry.armed
          )
        ) {
          break;
        }
        await delay(10);
      }
      assert.equal(committed.tools.length, 1);
      assert.ok(
        committed.checkpoints.some(
          (entry) => entry.boundary === "after-tool-dispatch" && entry.armed
        )
      );
      child.kill("SIGKILL");
      await once(child, "exit");
      await interrupted;
      const restored = await createFixture({
        directory,
        fixtureId: "kill-test",
        sha: "self-test",
      });
      restored.server.listen(0, "127.0.0.1");
      await once(restored.server, "listening");
      try {
        const base = `http://127.0.0.1:${restored.server.address().port}`;
        assert.equal(
          (await request(base, "/effects?operationId=unknown-write")).status,
          200
        );
        assert.equal(
          (await request(base, "/observations")).body.tools.length,
          1
        );
      } finally {
        await promisify(restored.server.close.bind(restored.server))();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
  test("frozen Effect authority fake seeds foreign-company denial and revocation", async () => {
    const { Effect } = await import("effect");
    const { createAuthorityFake } =
      await import("../../packages/contracts/src/testing/effect-fakes.ts");
    const { allowedContext, userEvent } =
      await import("../../packages/contracts/src/testing/fixtures.ts");
    const { id } = await import("../../packages/contracts/src/identity.ts");
    const now = Date.now();
    const fake = createAuthorityFake(() => now);
    const input = {
      action: "read",
      address: userEvent,
      context: allowedContext,
      pinnedAgent: {
        agentId: userEvent.agentId,
        enabledToolIds: [],
        grants: [],
        instructions: "fixture",
        model: "fixture/slice-1",
        organizationId: userEvent.organizationId,
        version: 1,
      },
      resource: {
        id: userEvent.agentId,
        kind: "agent",
        organizationId: userEvent.organizationId,
      },
    };
    const options = { deadlineAt: now + 5000 };
    assert.equal(
      (await Effect.runPromise(fake.service.evaluate(input, options))).decision,
      "allow"
    );
    assert.equal(
      (
        await Effect.runPromise(
          fake.service.evaluate(
            {
              ...input,
              address: {
                ...userEvent,
                organizationId: id.organization(
                  configuration.seed.otherCompany
                ),
              },
              resource: {
                ...input.resource,
                organizationId: id.organization(
                  configuration.seed.otherCompany
                ),
              },
            },
            options
          )
        )
      ).decision,
      "deny"
    );
    fake.setDecision({
      decision: "deny",
      policyVersion: "revoked-v2",
      reason: "Fixture access revoked",
    });
    assert.equal(
      (await Effect.runPromise(fake.service.evaluate(input, options))).decision,
      "deny"
    );
  });
} else {
  const scenario = configuration.scenarios.find(
    (item) => item.id === values.scenario
  );
  if (!scenario) {
    throw new Error("Unknown scenario");
  }
  const sha = (
    await execute("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(import.meta.dirname, "../.."),
    })
  ).stdout.trim();
  const sourceCheckoutDirty = Boolean(
    (
      await execute(
        "git",
        [
          "status",
          "--porcelain",
          "--untracked-files=all",
          "--",
          ".",
          ":(exclude)artifacts/**",
        ],
        { cwd: path.resolve(import.meta.dirname, "../..") }
      )
    ).stdout.trim()
  );
  let report;
  if (scenario.scope === "infrastructure") {
    if (!values["fixture-url"] && !values["base-url"]) {
      throw new Error("A fixture URL is required");
    }
    report = await fixtureProbe(values["fixture-url"] ?? values["base-url"]);
  } else if (values.driver) {
    const driver = await import(
      pathToFileURL(path.resolve(values.driver)).href
    );
    report = await driver.runScenario({
      baseUrl: values["base-url"],
      configuration,
      fixtureUrl: values["fixture-url"],
      scenario,
      sha,
    });
    if (report.status !== "pass") {
      process.exitCode = 2;
    }
    if (scenario.id === "performance" && report.status === "pass") {
      report.sourceCheckoutDirty = sourceCheckoutDirty;
      report.metrics = validatePerformance(report, scenario, {
        baselineFixtureId: values["baseline-fixture-id"],
        baselineSha: values["baseline-sha"],
        fixtureId: values["fixture-id"],
        headSha: sha,
      });
    }
  } else {
    report = {
      reason:
        "S1-F application wiring and a scenario driver using the frozen SessionService are required",
      required: scenario,
      scenario: scenario.id,
      status: "blocked",
    };
    process.exitCode = 2;
  }
  report = {
    ...report,
    scenario: scenario.id,
    sourceCheckoutDirty,
    testedSha: sha,
  };
  if (values.output) {
    await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
