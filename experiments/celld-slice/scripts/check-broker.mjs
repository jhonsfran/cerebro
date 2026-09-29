import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

import {
  approve,
  fixture,
  session,
  state,
  submit,
} from "./recovery-client.mjs";

const beforeObservations = await fixture("/model-observations");
const beforeModels = beforeObservations.body.modelCalls;
const id = await submit();
const waiting = await state(id, "waiting-for-approval");
assert.equal(waiting.status, "waiting-for-approval");
assert.equal(waiting.invocation.state, "waiting-for-approval");
const foreignRoute = crypto.randomUUID();
const sameOperationOnOtherRoute = await session(foreignRoute, "submit", {
  holdAfterEffect: false,
  mode: "idempotent",
  operationId: id,
});
assert.equal(sameOperationOnOtherRoute.status, 400);
const rejectedRouteState = await session(foreignRoute, "state");
assert.equal(rejectedRouteState.status, 200);
assert.equal(rejectedRouteState.body.run, null);
const before = await fixture(
  `/effects/${encodeURIComponent(waiting.invocation.invocationId)}`
);
assert.equal(before.status, 404);
const wrongApproval = await session(id, "approve", {
  digest: "changed-digest",
  eventId: crypto.randomUUID(),
});
assert.equal(wrongApproval.status, 409);
const { eventId } = await approve(id, waiting);
await approve(id, waiting, eventId);
const complete = await state(id, "completed");
assert.equal(complete.status, "completed");
assert.ok(
  complete.toolDiagnostics.some(
    (tool) =>
      tool.tool === "fixture_effect" &&
      tool.status === "completed" &&
      tool.resultMatchesLedger
  )
);
assert.equal(complete.reply, "Cerebro fixture completed.");
assert.equal(complete.invocation.state, "completed");
assert.equal(complete.invocation.result.value, "approved-fixture");
assert.equal(complete.approvalEvents.length, 1);
const repeated = await session(id, "submit", {
  holdAfterEffect: false,
  mode: "idempotent",
  operationId: id,
});
assert.equal(repeated.status, 200);
assert.deepEqual(
  repeated.body.run.invocation.result,
  complete.invocation.result
);
const conflict = await session(id, "submit", {
  holdAfterEffect: false,
  mode: "non-idempotent",
  operationId: id,
});
assert.equal(conflict.status, 409);
const effect = await fixture(
  `/effects/${encodeURIComponent(complete.invocation.invocationId)}`
);
assert.equal(effect.body.effects, 1);
assert.equal(effect.body.calls, 1);
const secondId = await submit();
const secondWaiting = await state(secondId, "waiting-for-approval");
assert.equal(secondWaiting.status, "waiting-for-approval");
const foreignApproval = await session(secondId, "approve", {
  digest: waiting.invocation.digest,
  eventId,
});
assert.equal(foreignApproval.status, 409);
const secondEffect = await fixture(
  `/effects/${encodeURIComponent(secondWaiting.invocation.invocationId)}`
);
assert.equal(secondEffect.status, 404);
await approve(secondId, secondWaiting);
const secondComplete = await state(secondId, "completed");
assert.equal(secondComplete.status, "completed");
const observations = await fixture("/model-observations");
const controlled = observations.body.observations
  .slice(beforeModels)
  .filter((entry) => entry.model === "controlled");
assert.ok(controlled.length >= 2);
assert.ok(
  controlled.some((entry) => entry.advertisedTools.includes("fixture_effect"))
);
for (const entry of controlled) {
  assert.ok(entry.advertisedTools.every((tool) => tool === "fixture_effect"));
  assert.equal(
    entry.secretPresent,
    false,
    "Model request contained the fixture secret or was not inspected"
  );
  assert.equal(
    entry.responseSecretPresent,
    false,
    "Model response contained the fixture secret or was not inspected"
  );
  assert.equal(typeof entry.toolCallsEmitted, "number");
  assert.equal(typeof entry.toolResultsObserved, "number");
}
assert.ok(
  controlled.some((entry) => entry.toolCallsEmitted > 0),
  "No actual model tool arguments were inspected"
);
assert.ok(
  controlled.some((entry) => entry.toolResultsObserved > 0),
  "No actual tool results in model messages were inspected"
);
const serialized = JSON.stringify({
  complete,
  observations: observations.body,
});
assert.ok(!serialized.includes("cerebro-local-fixture-secret"));
const report = {
  assertions: {
    approvedEffectOnly: true,
    changedRequestDenied: true,
    completedOperationReused: true,
    crossOperationApprovalDenied: true,
    duplicateApprovalReused: true,
    fixtureSecretAbsent: true,
    invalidDigestDenied: true,
    modelRequestSecretAbsent: true,
    modelResponseSecretAbsent: true,
    oneProviderEffect: true,
    sameOperationDifferentRouteDenied: true,
    toolArgumentsAndResultsObserved: true,
  },
  complete,
  effect: effect.body,
  observations: controlled,
  operationId: id,
  timestamp: new Date().toISOString(),
  waiting,
};
await mkdir("/results", { recursive: true });
await writeFile(
  "/results/broker-evidence.json",
  `${JSON.stringify(report, null, 2)}\n`
);
process.stdout.write(`${JSON.stringify(report.assertions, null, 2)}\n`);
