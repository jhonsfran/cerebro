import assert from "node:assert/strict";

const shaPattern = /^[a-f0-9]{40}$/u;
const finite = (value, name) => {
  assert.ok(
    Number.isFinite(value) && value >= 0,
    `${name} must be a nonnegative measurement`
  );
  return value;
};
const duration = (row, from, to) => {
  finite(row[from], from);
  finite(row[to], to);
  assert.ok(row[to] >= row[from], `${to} precedes ${from}`);
  return row[to] - row[from];
};
const p95 = (samples) => {
  assert.ok(samples.length > 0, "Measurements are required");
  const sorted = samples.toSorted((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
};

// Acceptance uses raw events tied to the booted checkout, not driver summaries.
export const validatePerformance = (report, scenario, expected) => {
  assert.match(expected.headSha, shaPattern);
  assert.match(expected.baselineSha, shaPattern);
  assert.notEqual(expected.headSha, expected.baselineSha);
  assert.ok(expected.fixtureId);
  assert.ok(expected.baselineFixtureId);
  assert.notEqual(expected.baselineFixtureId, expected.fixtureId);
  assert.equal(report.fixtureId, expected.fixtureId);
  assert.equal(report.headSha, expected.headSha);
  assert.equal(report.baselineSha, expected.baselineSha);
  assert.equal(
    report.sourceCheckoutDirty,
    false,
    "Performance requires a clean source checkout"
  );
  assert.equal(report.boot.sha, expected.headSha);
  assert.equal(report.boot.fixtureId, expected.fixtureId);
  assert.equal(report.boot.sourceCheckoutDirty, false);
  assert.equal(report.boot.mode, "application");
  assert.equal(report.baselineBoot.sha, expected.baselineSha);
  assert.equal(report.baselineBoot.fixtureId, expected.baselineFixtureId);
  assert.equal(report.baselineBoot.sourceCheckoutDirty, false);
  assert.equal(report.baselineBoot.mode, "application");
  assert.equal(report.warmup.revision, "baseline");
  assert.equal(report.warmup.sha, expected.baselineSha);
  assert.equal(report.samples.length, scenario.alternatingRunsPerRevision * 2);
  assert.equal(
    new Set(report.samples.map((sample) => sample.eventId)).size,
    report.samples.length
  );
  const head = [];
  for (const [index, sample] of report.samples.entries()) {
    const revision = index % 2 === 0 ? "baseline" : "head";
    assert.equal(sample.revision, revision);
    assert.equal(
      sample.sha,
      revision === "head" ? expected.headSha : expected.baselineSha
    );
    assert.equal(
      sample.fixtureId,
      revision === "head" ? expected.fixtureId : expected.baselineFixtureId
    );
    assert.ok(sample.eventId);
    if (revision === "baseline") {
      finite(sample.submittedAt, "submittedAt");
      assert.ok(
        ["completed", "failed", "unavailable"].includes(sample.terminal)
      );
      for (const [name, from, to] of [
        ["admission", "submittedAt", "acknowledgedAt"],
        ["firstText", "providerFirstTokenAt", "browserFirstTextAt"],
        ["history", "historyRequestedAt", "historyReceivedAt"],
      ]) {
        if (sample[to] === null) {
          assert.ok(
            typeof sample.unavailable?.[name] === "string" &&
              sample.unavailable[name].trim(),
            `Unavailable trunk ${name} requires a reason`
          );
        } else {
          duration(sample, from, to);
        }
      }
      for (const name of [
        "permissionAdapterMs",
        "projectionAdapterMs",
        "idleMemoryBytes",
      ]) {
        if (sample[name] === null) {
          assert.ok(
            typeof sample.unavailable?.[name] === "string" &&
              sample.unavailable[name].trim(),
            `Unavailable trunk ${name} requires a reason`
          );
        } else {
          finite(sample[name], name);
        }
      }
      continue;
    }
    assert.ok(sample.runId);
    assert.equal(sample.terminal, "completed");
    duration(sample, "submittedAt", "acknowledgedAt");
    duration(sample, "providerFirstTokenAt", "browserFirstTextAt");
    duration(sample, "historyRequestedAt", "historyReceivedAt");
    finite(sample.permissionAdapterMs, "permissionAdapterMs");
    finite(sample.projectionAdapterMs, "projectionAdapterMs");
    finite(sample.idleMemoryBytes, "idleMemoryBytes");
    if (revision === "head") {
      head.push(sample);
    }
  }
  assert.equal(report.detachSamples.length, scenario.attachDetachCycles);
  assert.equal(new Set(head.map((sample) => sample.runId)).size, head.length);
  for (const sample of report.detachSamples) {
    assert.ok(sample.observerId);
    duration(sample, "attachedAt", "detachedAt");
    assert.equal(sample.liveObserversAfterDetach, 0);
  }
  assert.equal(report.concurrentSamples.length, scenario.concurrentTurns);
  assert.equal(
    new Set(report.concurrentSamples.map((sample) => sample.eventId)).size,
    scenario.concurrentTurns
  );
  assert.equal(
    new Set(report.concurrentSamples.map((sample) => sample.runId)).size,
    scenario.concurrentTurns
  );
  for (const sample of report.concurrentSamples) {
    assert.equal(sample.terminal, "completed");
    duration(sample, "submittedAt", "acknowledgedAt");
    duration(sample, "submittedAt", "terminalAt");
  }
  assert.equal(report.alarmSample.sha, expected.headSha);
  assert.equal(report.alarmSample.fixtureId, expected.fixtureId);
  assert.ok(report.alarmSample.eventId);
  assert.ok(report.alarmSample.runId);
  assert.equal(report.alarmSample.terminal, "completed");
  const metrics = {
    admissionP95Ms: p95(
      head.map((sample) => duration(sample, "submittedAt", "acknowledgedAt"))
    ),
    alarmRecoveryMs: duration(report.alarmSample, "dueAt", "terminalAt"),
    concurrentTerminalMs:
      Math.max(...report.concurrentSamples.map((sample) => sample.terminalAt)) -
      Math.min(...report.concurrentSamples.map((sample) => sample.submittedAt)),
    firstTextAdapterP95Ms: p95(
      head.map((sample) =>
        duration(sample, "providerFirstTokenAt", "browserFirstTextAt")
      )
    ),
    historyP95Ms: p95(
      head.map((sample) =>
        duration(sample, "historyRequestedAt", "historyReceivedAt")
      )
    ),
    idleMemoryBytes: p95(head.map((sample) => sample.idleMemoryBytes)),
    liveObserversAfterDetach: Math.max(
      ...report.detachSamples.map((sample) => sample.liveObserversAfterDetach)
    ),
    permissionAdapterMs: p95(head.map((sample) => sample.permissionAdapterMs)),
    projectionAdapterMs: p95(head.map((sample) => sample.projectionAdapterMs)),
  };
  for (const [name, maximum] of Object.entries(scenario.budgets)) {
    assert.ok(
      metrics[name] <= maximum,
      `${name} exceeds its acceptance budget`
    );
  }
  for (const name of scenario.requiredMeasurements) {
    finite(metrics[name], name);
  }
  return metrics;
};
