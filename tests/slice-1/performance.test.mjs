import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { validatePerformance } from "./performance.mjs";

const expected = {
  baselineFixtureId: "cerebro-s1-validator-trunk",
  baselineSha: "a".repeat(40),
  fixtureId: "cerebro-s1-validator",
  headSha: "b".repeat(40),
};
const scenario = {
  alternatingRunsPerRevision: 5,
  attachDetachCycles: 100,
  budgets: {
    admissionP95Ms: 2000,
    alarmRecoveryMs: 60_000,
    concurrentTerminalMs: 90_000,
    firstTextAdapterP95Ms: 500,
    historyP95Ms: 5000,
    liveObserversAfterDetach: 0,
  },
  concurrentTurns: 10,
  requiredMeasurements: [
    "permissionAdapterMs",
    "projectionAdapterMs",
    "idleMemoryBytes",
  ],
};
const report = () => ({
  ...expected,
  alarmSample: {
    dueAt: 1000,
    eventId: "alarm-event",
    fixtureId: expected.fixtureId,
    runId: "alarm-run",
    sha: expected.headSha,
    terminal: "completed",
    terminalAt: 2000,
  },
  baselineBoot: {
    fixtureId: expected.baselineFixtureId,
    mode: "application",
    sha: expected.baselineSha,
    sourceCheckoutDirty: false,
  },
  boot: {
    fixtureId: expected.fixtureId,
    mode: "application",
    sha: expected.headSha,
    sourceCheckoutDirty: false,
  },
  concurrentSamples: Array.from({ length: 10 }, (_, index) => ({
    acknowledgedAt: 200,
    eventId: `c${index}`,
    runId: `c${index}`,
    submittedAt: 100,
    terminal: "completed",
    terminalAt: 500,
  })),
  detachSamples: Array.from({ length: 100 }, (_, index) => ({
    attachedAt: 1,
    detachedAt: 2,
    liveObserversAfterDetach: 0,
    observerId: `o${index}`,
  })),
  metrics: { admissionP95Ms: 0 },
  samples: Array.from({ length: 10 }, (_, index) => ({
    acknowledgedAt: 200,
    browserFirstTextAt: 500,
    eventId: `e${index}`,
    fixtureId:
      index % 2 === 0 ? expected.baselineFixtureId : expected.fixtureId,
    historyReceivedAt: 1000,
    historyRequestedAt: 600,
    idleMemoryBytes: 1024,
    permissionAdapterMs: 10,
    projectionAdapterMs: 20,
    providerFirstTokenAt: 400,
    revision: index % 2 === 0 ? "baseline" : "head",
    runId: `r${index}`,
    sha: index % 2 === 0 ? expected.baselineSha : expected.headSha,
    submittedAt: 100,
    terminal: "completed",
  })),
  sourceCheckoutDirty: false,
  warmup: { revision: "baseline", sha: expected.baselineSha },
});

test("performance metrics are calculated from raw events", () => {
  assert.equal(
    validatePerformance(report(), scenario, expected).admissionP95Ms,
    100
  );
});
test("another tested head cannot pass", () => {
  const value = report();
  value.samples[1].sha = "c".repeat(40);
  assert.throws(() => validatePerformance(value, scenario, expected));
});
test("an unrelated boot cannot pass", () => {
  const value = report();
  value.boot.fixtureId = "cerebro-s1-other";
  assert.throws(() => validatePerformance(value, scenario, expected));
});
test("driver summary cannot hide a slow admission", () => {
  const value = report();
  value.samples[1].acknowledgedAt = 3000;
  assert.throws(() => validatePerformance(value, scenario, expected));
});
test("metadata without raw samples cannot pass", () => {
  const value = report();
  delete value.alarmSample;
  assert.throws(() => validatePerformance(value, scenario, expected));
});
test("dirty checkout evidence cannot pass", () => {
  const value = report();
  value.sourceCheckoutDirty = true;
  assert.throws(() => validatePerformance(value, scenario, expected));
});

test("a failed or foreign alarm run cannot pass on timing alone", () => {
  const value = report();
  value.alarmSample.terminal = "failed";
  assert.throws(() => validatePerformance(value, scenario, expected));
  value.alarmSample.terminal = "completed";
  value.alarmSample.fixtureId = "foreign-fixture";
  assert.throws(() => validatePerformance(value, scenario, expected));
});

test("repeated samples cannot substitute for five measured runs", () => {
  const value = report();
  value.samples = Array.from(
    { length: 10 },
    (_, index) => value.samples[index % 2]
  );
  assert.throws(() => validatePerformance(value, scenario, expected));
});

test("unavailable trunk features require explicit reasons and do not replace head measurements", () => {
  const value = report();
  for (const sample of value.samples.filter(
    (row) => row.revision === "baseline"
  )) {
    sample.browserFirstTextAt = null;
    sample.projectionAdapterMs = null;
    sample.unavailable = {
      firstText: "Trunk buffers the complete answer before browser delivery",
      projectionAdapterMs:
        "Trunk has no separate projection timing observation",
    };
  }
  assert.equal(
    validatePerformance(value, scenario, expected).firstTextAdapterP95Ms,
    100
  );
  value.samples[1].browserFirstTextAt = null;
  assert.throws(() => validatePerformance(value, scenario, expected));
});

test("missing trunk measurements without a reason cannot pass", () => {
  const value = report();
  value.samples[0].browserFirstTextAt = null;
  assert.throws(() => validatePerformance(value, scenario, expected));
});

test("an unrelated or dirty trunk boot cannot pass", () => {
  const value = report();
  value.baselineBoot.fixtureId = "foreign-trunk";
  assert.throws(() => validatePerformance(value, scenario, expected));
  value.baselineBoot.fixtureId = expected.baselineFixtureId;
  value.baselineBoot.sourceCheckoutDirty = true;
  assert.throws(() => validatePerformance(value, scenario, expected));
});

test("the performance CLI passes the baseline fixture identity and verifies checkout dirtiness", async () => {
  const execute = promisify(execFile);
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-s1-perf-cli-"));
  const driver = path.join(directory, "driver.mjs");
  await writeFile(
    driver,
    `export const runScenario = async ({sha}) => ({...${JSON.stringify(report())}, headSha:sha, alarmSample:{...${JSON.stringify(report().alarmSample)},sha}, boot:{...${JSON.stringify(report().boot)},sha}, samples:${JSON.stringify(report().samples)}.map(row=>row.revision === "head" ? {...row,sha} : row), status:"pass"});`
  );
  const arguments_ = [
    "tests/slice-1/probe.mjs",
    "--scenario",
    "performance",
    "--driver",
    driver,
    "--fixture-id",
    expected.fixtureId,
    "--baseline-sha",
    expected.baselineSha,
  ];
  try {
    await assert.rejects(execute(process.execPath, arguments_), (error) => {
      assert.match(error.stderr, /assert.ok\(expected.baselineFixtureId\)/u);
      return true;
    });
    try {
      const result = await execute(process.execPath, [
        ...arguments_,
        "--baseline-fixture-id",
        expected.baselineFixtureId,
      ]);
      const value = JSON.parse(result.stdout);
      assert.equal(value.metrics.firstTextAdapterP95Ms, 100);
      assert.equal(value.sourceCheckoutDirty, false);
    } catch (error) {
      assert.match(
        error.stderr,
        /Performance requires a clean source checkout/u
      );
      const status = await execute("git", [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude)artifacts/**",
      ]);
      assert.ok(
        status.stdout.trim(),
        "Only a dirty checkout may fail this caller path"
      );
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
