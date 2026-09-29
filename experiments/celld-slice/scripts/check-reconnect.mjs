import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  approve,
  baseURL,
  fixture,
  session,
  state,
  submit,
  until,
} from "./recovery-client.mjs";

const resultsDirectory = process.env.RESULTS_DIR ?? "/results";
const controller = new AbortController();
const started = performance.now();
let invocationId;
let released = false;
let report;
const waitForCheckpoint = async (operationId, expected, since) =>
  await until(
    async () => {
      const response = await fixture(`/checkpoints/${operationId}`);
      return response.body;
    },
    (body) =>
      body.phases?.some(
        (entry) => entry.phase === expected && entry.at >= since
      ),
    `Reconnect checkpoint ${expected}`,
    90_000
  );
try {
  const operationId = await submit({ holdAfterEffect: true });
  const waiting = await state(operationId, "waiting-for-approval");
  assert.equal(waiting.status, "waiting-for-approval");
  ({ invocationId } = waiting.invocation);
  await approve(operationId, waiting);
  const committed = await until(
    async () => {
      const response = await fixture(
        `/effects/${encodeURIComponent(invocationId)}`
      );
      return response.body;
    },
    (body) => body.held === true && body.effects === 1,
    "Held effect before client disconnect"
  );
  const executing = await session(operationId, "state");
  assert.equal(executing.body.run.status, "executing");
  const observingAt = Date.now();
  let observed;
  const observe = async () => {
    try {
      const response = await fetch(
        `${baseURL}/recovery/${operationId}/result?wait=true`,
        {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(60_000),
          ]),
        }
      );
      await response.body?.cancel();
      observed = { kind: "response", status: response.status };
    } catch (error) {
      observed = {
        clientAborted: controller.signal.aborted,
        errorName: error instanceof Error ? error.name : "unknown",
        kind: "error",
      };
    }
    return observed;
  };
  const pending = observe();
  const observing = await waitForCheckpoint(
    operationId,
    "result-waiting",
    observingAt
  );
  assert.equal(
    observed,
    undefined,
    "The observer must still be waiting during execution"
  );
  controller.abort();
  const disconnected = await pending;
  assert.equal(disconnected.kind, "error");
  assert.equal(disconnected.errorName, "AbortError");
  assert.equal(disconnected.clientAborted, true);
  const afterDisconnect = await fixture(
    `/effects/${encodeURIComponent(invocationId)}`
  );
  assert.equal(afterDisconnect.body.held, true);
  assert.equal(afterDisconnect.body.effects, 1);
  const releasedAt = Date.now();
  const release = await fixture(
    `/release/${encodeURIComponent(invocationId)}`,
    {}
  );
  assert.equal(release.status, 200);
  released = true;
  const completed = await waitForCheckpoint(
    operationId,
    "completed",
    releasedAt
  );
  const reconnected = await session(operationId, "result");
  assert.equal(reconnected.status, 200);
  const { run } = reconnected.body;
  assert.equal(run.status, "completed");
  assert.equal(run.operationId, operationId);
  assert.equal(run.sessionId, executing.body.run.sessionId);
  assert.equal(run.reply, "Cerebro fixture completed.");
  assert.deepEqual(run.invocation.result, committed.result);
  assert.ok(
    run.toolDiagnostics.some(
      (tool) =>
        tool.tool === "fixture_effect" &&
        tool.status === "completed" &&
        tool.resultMatchesLedger
    )
  );
  const effect = await fixture(`/effects/${encodeURIComponent(invocationId)}`);
  assert.equal(effect.body.effects, 1);
  assert.equal(effect.body.calls, 1);
  report = {
    assertions: {
      clientDisconnectedDuringExecution: true,
      completedSDKTool: true,
      completedWithoutReconnectRequest: true,
      oneProviderCall: true,
      oneProviderEffect: true,
      sameOperationSessionAndReceipt: true,
    },
    completed,
    disconnected,
    durationMs: Math.round(performance.now() - started),
    effect: effect.body,
    id: "agent.reconnect",
    observing,
    operationId,
    reconnected: run,
    status: "pass",
    transport: "HTTP long-poll result observer; no SSE coverage",
  };
} catch {
  report = {
    durationMs: Math.round(performance.now() - started),
    error: "Client reconnect check failed; response bodies omitted",
    id: "agent.reconnect",
    status: "fail",
    transport: "HTTP long-poll result observer; no SSE coverage",
  };
  process.exitCode = 1;
} finally {
  controller.abort();
  if (invocationId && !released) {
    try {
      await fixture(`/release/${encodeURIComponent(invocationId)}`, {});
    } catch {
      report.cleanupError = "Held fixture effect release failed";
      process.exitCode = 1;
    }
  }
}
await mkdir(resultsDirectory, { recursive: true });
await writeFile(
  path.join(resultsDirectory, "reconnect-evidence.json"),
  `${JSON.stringify({ ...report, timestamp: new Date().toISOString() }, null, 2)}\n`
);
process.stdout.write(
  `${JSON.stringify({ id: report.id, status: report.status }, null, 2)}\n`
);

if (report.status !== "pass" || report.cleanupError) {
  throw new Error("Client reconnect check failed; see reconnect-evidence.json");
}
