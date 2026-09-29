import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import postgres from "postgres";

const baseURL = process.env.BASE_URL ?? "http://localhost:18765";
const resultsDirectory = process.env.RESULTS_DIR ?? "/results";
const requestDeadlineMs = 60_000;
const sampleIntervalMs = 100;
const expectedReply = "Cerebro fixture completed.";
const sql = postgres(process.env.DATABASE_URL, {
  connect_timeout: 5,
  connection: {
    application_name: "cerebro-baseline-observer",
    statement_timeout: 5000,
  },
  idle_timeout: 5,
  max: 1,
});
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

const runSession = async () => {
  const conversation = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const started = performance.now();
  let stage = "request";
  let httpStatus = null;
  try {
    const response = await fetch(`${baseURL}/sessions/${conversation}/prompt`, {
      body: JSON.stringify({ operationId }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(requestDeadlineMs),
    });
    httpStatus = response.status;
    stage = "http-status";
    assert.equal(httpStatus, 200);
    stage = "response-body";
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.operationId, operationId);
    assert.equal(body.toolCalls, 1);
    assert.equal(body.reply, expectedReply);
    assert.equal(typeof body.sessionId, "string");
    assert.ok(body.sessionId.length > 0);
    return {
      conversation,
      durationMs: Math.round(performance.now() - started),
      httpStatus,
      operationId,
      reply: expectedReply,
      sessionId: body.sessionId,
      status: "pass",
      toolCalls: 1,
    };
  } catch {
    return {
      conversation,
      durationMs: Math.round(performance.now() - started),
      error: "Session probe failed; response omitted",
      httpStatus,
      operationId,
      stage,
      status: "fail",
    };
  }
};

const latencySummary = (requests) => {
  const durations = requests
    .filter((request) => request.status === "pass")
    .map((request) => request.durationMs)
    .toSorted((left, right) => left - right);
  if (durations.length === 0) {
    return null;
  }
  return {
    count: durations.length,
    max: durations.at(-1),
    mean: Math.round(
      durations.reduce((total, duration) => total + duration, 0) /
        durations.length
    ),
    min: durations[0],
    p50: durations[Math.ceil(durations.length * 0.5) - 1],
    p95: durations[Math.ceil(durations.length * 0.95) - 1],
  };
};

const runPhase = async (concurrency) => {
  const id =
    concurrency === 1 ? "baseline.one-session" : "baseline.ten-sessions";
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const samples = [];
  let observerError = null;
  const sample = async (period) => {
    const [counts] = await sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE pid = pg_backend_pid())::int AS observer,
        count(*) FILTER (WHERE pid <> pg_backend_pid())::int AS workload,
        count(*) FILTER (WHERE pid <> pg_backend_pid() AND state = 'active')::int AS active,
        count(*) FILTER (WHERE pid <> pg_backend_pid() AND state = 'idle')::int AS idle,
        count(*) FILTER (WHERE pid <> pg_backend_pid() AND state LIKE 'idle in transaction%')::int AS idle_in_transaction
      FROM pg_stat_activity
      WHERE datname = 'slice'
    `;
    assert.equal(counts.observer, 1);
    samples.push({
      ...counts,
      elapsedMs: Math.round(performance.now() - started),
      period,
      timestamp: new Date().toISOString(),
    });
  };
  emit({
    concurrency,
    event: "baseline.phase.start",
    id,
    timestamp: startedAt,
  });
  try {
    await sample("before");
  } catch {
    observerError = "PostgreSQL baseline sample failed";
  }
  let sampling = true;
  const observe = async () => {
    if (!sampling) {
      return;
    }
    try {
      await sample("during");
    } catch {
      observerError = "PostgreSQL workload sampling failed";
      return;
    }
    await setTimeout(sampleIntervalMs);
    await observe();
  };
  const requestsInProgress = Array.from({ length: concurrency }, runSession);
  const observer = observe();
  const requests = await Promise.all(requestsInProgress);
  sampling = false;
  await observer;
  try {
    await sample("after");
  } catch {
    observerError = "PostgreSQL final sample failed";
  }
  const allSessionsPassed = requests.every(
    (request) => request.status === "pass"
  );
  const uniqueSessions = new Set(
    requests
      .filter((request) => request.status === "pass")
      .map((request) => request.sessionId)
  ).size;
  const status =
    allSessionsPassed && uniqueSessions === concurrency && !observerError
      ? "pass"
      : "fail";
  const result = {
    concurrency,
    durationMs: Math.round(performance.now() - started),
    finishedAt: new Date().toISOString(),
    id,
    latencyMs: latencySummary(requests),
    postgres: {
      database: "slice",
      observerError,
      peakTotal: samples.length
        ? Math.max(...samples.map((entry) => entry.total))
        : null,
      peakWorkload: samples.length
        ? Math.max(...samples.map((entry) => entry.workload))
        : null,
      requestedSampleIntervalMs: sampleIntervalMs,
      samples,
    },
    requests,
    startedAt,
    status,
    uniqueSessions,
  };
  emit({
    event: "baseline.phase.end",
    id,
    latencyMs: result.latencyMs,
    status,
    timestamp: result.finishedAt,
  });
  return result;
};

const phases = [];
let cleanupError = null;
try {
  phases.push(await runPhase(1), await runPhase(10));
} finally {
  try {
    await sql.end({ timeout: 5 });
  } catch {
    cleanupError = "PostgreSQL observer cleanup failed";
  }
}
const report = {
  cleanupError,
  memory: {
    source: "external-host-docker-stats",
    status: "external-measurement-required",
  },
  ok:
    phases.length === 2 &&
    phases.every((phase) => phase.status === "pass") &&
    !cleanupError,
  phases,
  requestDeadlineMs,
  timestamp: new Date().toISOString(),
  workload: "Deterministic OpenCode fixture_probe loop; no real provider",
};
await mkdir(resultsDirectory, { recursive: true });
await writeFile(
  path.join(resultsDirectory, "baseline-evidence.json"),
  `${JSON.stringify(report, null, 2)}\n`
);
emit({
  event: "baseline.complete",
  ok: report.ok,
  timestamp: report.timestamp,
});
process.exitCode = report.ok ? 0 : 1;
