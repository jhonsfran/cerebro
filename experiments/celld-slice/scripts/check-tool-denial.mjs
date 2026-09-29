import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

import { fixture, session, state } from "./recovery-client.mjs";

const results = [];
/* oxlint-disable no-await-in-loop -- Each case uses the fixture's shared model observation stream. */
for (const tool of ["shell", "webfetch", "execute", "mcp_unregistered"]) {
  const operationId = crypto.randomUUID();
  const configured = await fixture(`/attacks/${operationId}`, { tool });
  assert.equal(configured.status, 200);
  const submitted = await session(operationId, "submit", {
    holdAfterEffect: false,
    mode: "idempotent",
    operationId,
  });
  assert.equal(submitted.status, 202);
  const run = await state(operationId, "failed");
  assert.equal(run.status, "failed");
  assert.equal(run.invocation, null);
  const denied = run.toolDiagnostics.filter((entry) => entry.tool === tool);
  assert.ok(denied.length > 0, "The SDK must record the attempted tool");
  for (const entry of denied) {
    assert.equal(entry.status, "error");
    assert.ok(["unknown-tool", "denied"].includes(entry.errorKind));
  }
  const effect = await fixture(
    `/effects/${encodeURIComponent(`${operationId}:effect`)}`
  );
  assert.equal(effect.status, 404);
  assert.equal(effect.body.effects, 0);
  results.push({ effect: effect.body, operationId, run, tool });
}
/* oxlint-enable no-await-in-loop */
await mkdir("/results", { recursive: true });
await writeFile(
  "/results/tool-denial-evidence.json",
  `${JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2)}\n`
);
process.stdout.write(
  `${JSON.stringify(
    results.map(({ tool }) => ({ status: "pass", tool })),
    null,
    2
  )}\n`
);
