import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  approve,
  baseURL,
  fixture,
  session,
  state,
  submit,
  until,
} from "./recovery-client.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const project = process.env.COMPOSE_PROJECT_NAME ?? "cerebro-slice";
const command = [
  "proxy",
  "docker",
  "compose",
  "-p",
  project,
  "-f",
  "experiments/celld-slice/compose.yaml",
];
const commands = [];
const compose = (...args) => {
  const output = execFileSync("rtk", [...command, ...args], {
    cwd: root,
    encoding: "utf-8",
    maxBuffer: 2_000_000,
    timeout: 180_000,
  });
  commands.push({ args, exit: 0 });
  return output;
};
const kill = () => {
  compose("kill", "-s", "SIGKILL", "celld");
  const id = compose("ps", "-aq", "celld").trim();
  const exit = execFileSync(
    "rtk",
    ["proxy", "docker", "inspect", "--format", "{{.State.ExitCode}}", id],
    { encoding: "utf-8" }
  ).trim();
  assert.equal(exit, "137");
  commands.push({ containerExitCode: 137 });
};
const start = () => compose("up", "-d", "--no-deps", "--wait", "celld");
const restart = () => {
  kill();
  start();
};
const phase = async (id, expected, since = {}) =>
  await until(
    async () => {
      const response = await fixture(`/checkpoints/${id}`);
      return response.body;
    },
    (body) =>
      body.phases?.some(
        (entry) =>
          entry.phase === expected &&
          (!since.at || entry.at >= since.at) &&
          (!since.instance || entry.instance !== since.instance)
      ),
    `autonomous checkpoint ${expected}`,
    300_000
  );
const observeEffect = async (id) =>
  await fixture(`/effects/${encodeURIComponent(id)}`);
const results = [];
const record = async (id, run) => {
  process.stdout.write(`Starting ${id}\n`);
  const started = performance.now();
  try {
    const evidence = await run();
    results.push({
      durationMs: Math.round(performance.now() - started),
      evidence,
      id,
      status: "pass",
    });
  } catch (error) {
    results.push({
      durationMs: Math.round(performance.now() - started),
      error: error.message,
      id,
      status: "fail",
    });
    throw error;
  } finally {
    await mkdir(new URL("../results/", import.meta.url), { recursive: true });
    await writeFile(
      new URL("../results/recovery-evidence.json", import.meta.url),
      `${JSON.stringify({ commands, project, results, timestamp: new Date().toISOString() }, null, 2)}\n`
    );
  }
};

await record("recovery.before-model", async () => {
  const id = await submit({ startDelayMs: 15_000 });
  const accepted = await session(id, "state");
  assert.equal(accepted.body.run.status, "accepted");
  const boundary = { at: Date.now(), instance: accepted.body.instanceId };
  assert.equal(typeof boundary.instance, "string");
  kill();
  let beforeRestart;
  try {
    const observed = await fixture(`/checkpoints/${id}`);
    assert.equal(observed.status, 200);
    beforeRestart = observed.body;
    assert.ok(Array.isArray(beforeRestart.phases));
    assert.ok(
      !beforeRestart.phases.some(
        (entry) =>
          entry.phase === "model-started" ||
          entry.phase === "waiting-for-approval"
      ),
      "The model must not have started before the before-model SIGKILL"
    );
  } finally {
    start();
  }
  const wake = await phase(id, "waiting-for-approval", boundary);
  const waiting = await state(id, "waiting-for-approval");
  assert.equal(waiting.status, "waiting-for-approval");
  const unapprovedEffect = await observeEffect(waiting.invocation.invocationId);
  assert.equal(unapprovedEffect.status, 404);
  await approve(id, waiting);
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
  return {
    beforeRestart,
    complete,
    id,
    noSessionRequestBeforeWake: true,
    wake,
  };
});

await record("recovery.approval", async () => {
  const id = await submit();
  const waiting = await state(id, "waiting-for-approval");
  assert.equal(waiting.status, "waiting-for-approval");
  restart();
  await setTimeout(2000);
  const unapprovedEffect = await observeEffect(waiting.invocation.invocationId);
  assert.equal(unapprovedEffect.status, 404);
  const preservedResponse = await session(id, "state");
  const preserved = preservedResponse.body.run;
  assert.equal(preserved.invocation.state, "waiting-for-approval");
  assert.equal(preserved.invocation.digest, waiting.invocation.digest);
  await approve(id, preserved);
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
  const effect = await observeEffect(waiting.invocation.invocationId);
  assert.equal(effect.body.effects, 1);
  return { complete, effect: effect.body, id, pendingApprovalPreserved: true };
});

for (const mode of ["idempotent", "non-idempotent"]) {
  // oxlint-disable-next-line no-await-in-loop -- Each case stops and restarts the same celld service.
  await record(
    mode === "idempotent"
      ? "recovery.idempotent-effect"
      : "recovery.unknown-effect",
    async () => {
      const id = await submit({ holdAfterEffect: true, mode });
      const waiting = await state(id, "waiting-for-approval");
      assert.equal(waiting.status, "waiting-for-approval");
      await approve(id, waiting);
      const invocation = waiting.invocation.invocationId;
      const committed = await until(
        async () => {
          const response = await observeEffect(invocation);
          return response.body;
        },
        (body) => body.held === true && body.effects === 1,
        "held committed effect"
      );
      const beforeKill = await session(id, "state");
      assert.equal(beforeKill.body.run.invocation.state, "executing");
      const boundary = { at: Date.now(), instance: beforeKill.body.instanceId };
      kill();
      await fixture(`/release/${encodeURIComponent(invocation)}`, {});
      start();
      const expected = mode === "idempotent" ? "completed" : "unknown-outcome";
      const checkpoint = await phase(id, expected, boundary);
      const recoveredResponse = await session(id, "state");
      const recovered = recoveredResponse.body.run;
      assert.equal(recovered.status, expected);
      await setTimeout(2000);
      const effectResponse = await observeEffect(invocation);
      const effect = effectResponse.body;
      assert.equal(effect.effects, 1);
      assert.equal(effect.calls, mode === "idempotent" ? 2 : 1);
      if (mode === "idempotent") {
        assert.equal(recovered.reply, "Cerebro fixture completed.");
        assert.ok(
          recovered.toolDiagnostics.some(
            (tool) =>
              tool.tool === "fixture_effect" &&
              tool.status === "completed" &&
              tool.resultMatchesLedger
          )
        );
        assert.deepEqual(recovered.invocation.result, committed.result);
      } else {
        assert.equal(recovered.invocation.state, "unknown-outcome");
        assert.equal(recovered.invocation.result, null);
      }
      return {
        checkpoint,
        committed,
        effect,
        id,
        noSessionRequestBeforeRecovery: true,
        recovered,
      };
    }
  );
}

await record("recovery.completed", async () => {
  const id = await submit();
  const waiting = await state(id, "waiting-for-approval");
  assert.equal(waiting.status, "waiting-for-approval");
  await approve(id, waiting);
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
  const pendingResponse = fetch(`${baseURL}/recovery/${id}/result?hold=true`, {
    signal: AbortSignal.timeout(90_000),
  }).then(
    async (response) => ({
      body: await response.text(),
      status: response.status,
    }),
    () => ({ disconnected: true })
  );
  await phase(id, "result-held");
  restart();
  const lost = await pendingResponse;
  assert.ok("disconnected" in lost || lost.status >= 500);
  const repeated = await session(id, "result");
  assert.equal(repeated.status, 200);
  assert.deepEqual(
    repeated.body.run.invocation.result,
    complete.invocation.result
  );
  const effectResponse = await observeEffect(complete.invocation.invocationId);
  const effect = effectResponse.body;
  assert.equal(effect.effects, 1);
  assert.equal(effect.calls, 1);
  return { effect, id, lost, repeated: repeated.body };
});
process.stdout.write(
  `${JSON.stringify(
    results.map(({ id, status }) => ({ id, status })),
    null,
    2
  )}\n`
);
