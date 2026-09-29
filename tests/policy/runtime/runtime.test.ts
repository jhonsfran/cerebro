import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const composeFile = fileURLToPath(new URL("compose.yaml", import.meta.url));
const resultSchema = z.object({
  code: z.string().optional(),
  status: z.string(),
  value: z
    .object({ output: z.unknown(), providerReceipt: z.string().optional() })
    .optional(),
});
const invocationSchema = z.object({
  instanceId: z.string(),
  result: resultSchema,
});
const sdkSchema = z.object({
  attempts: z.array(
    z.object({
      callId: z.string(),
      messageId: z.string(),
      sessionId: z.string(),
      toolId: z.string(),
    })
  ),
  instanceId: z.string(),
  record: z.object({
    status: z.string(),
    value: z.object({ state: z.string() }).optional(),
  }),
  tools: z.array(
    z.object({
      name: z.string(),
      state: z.object({
        content: z
          .array(z.object({ text: z.string().optional(), type: z.string() }))
          .optional(),
        error: z.object({ message: z.string() }).optional(),
        status: z.string(),
      }),
    })
  ),
});
const countsSchema = z.object({
  effects: z.array(
    z.object({
      calls: z.number(),
      effects: z.number(),
      operation_id: z.string(),
    })
  ),
  observations: z.array(
    z.object({
      advertisedTools: z.array(z.string()).optional(),
      kind: z.string(),
      secretPresent: z.boolean(),
    })
  ),
});
const input = (
  operationId: string,
  tool: "controlled_read" | "controlled_write" = "controlled_read"
) => ({ operationId, tool, value: "runtime-value" });
const waitForHealth = async (base: string, deadline: number): Promise<void> => {
  let healthy = false;
  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    healthy = response.ok;
  } catch {
    healthy = false;
  }
  if (healthy) {
    return;
  }
  assert.ok(Date.now() < deadline, "Actual celld restart must become healthy.");
  await delay(200);
  await waitForHealth(base, deadline);
};
test(
  "actual celld and pinned OpenCode enforce the new broker and gateway",
  { timeout: 300_000 },
  async () => {
    const project = `cerebro-s4-tools-${randomUUID().slice(0, 8)}`;
    const compose = (args: string[], timeout = 120_000): string => {
      const result = spawnSync(
        "docker",
        ["compose", "--project-name", project, "--file", composeFile, ...args],
        {
          cwd: root,
          encoding: "utf-8",
          env: { ...process.env, CEREBRO_S4_WORKTREE: root },
          timeout,
        }
      );
      if (result.error) {
        throw result.error;
      }
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    const prerequisites = spawnSync(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { encoding: "utf-8", timeout: 10_000 }
    );
    assert.equal(
      prerequisites.status,
      0,
      "Docker must be available for the requested actual runtime proof."
    );
    let base = "";
    let provider = "";
    const json = async <Value>(
      path: string,
      schema: z.ZodType<Value>,
      requestBody?: unknown
    ): Promise<Value> => {
      const response = await fetch(
        `${base}${path}`,
        requestBody === undefined
          ? { signal: AbortSignal.timeout(70_000) }
          : {
              body: JSON.stringify(requestBody),
              headers: { "Content-Type": "application/json" },
              method: "POST",
              signal: AbortSignal.timeout(70_000),
            }
      );
      const value: unknown = await response.json();
      assert.equal(response.status, 200, JSON.stringify(value));
      return schema.parse(value);
    };
    const counts = async () => {
      const response = await fetch(`${provider}/counts`, {
        signal: AbortSignal.timeout(5000),
      });
      return countsSchema.parse(await response.json());
    };
    try {
      compose(["up", "--build", "--detach", "--wait", "--wait-timeout", "120"]);
      base = `http://${compose(["port", "celld", "8080"])}`;
      provider = `http://${compose(["port", "fixture", "8090"])}`;
      assert.deepEqual(
        JSON.parse(
          compose(["exec", "-T", "celld", "cat", "/run/s4/versions.json"])
        ),
        {
          "@opencode-ai/plugin": "0.0.0-dev-18697",
          "@opencode-ai/sdk": "0.0.0-dev-18697",
          agents: "0.24.0",
          celld: "celld 0.6.0",
        }
      );
      const isolation = await json(
        "/isolation",
        z.object({
          parent: z.object({ ok: z.boolean() }),
          parentStatus: z.number(),
          wrapper: z.object({
            directError: z.string(),
            directStatus: z.null(),
            gateway: resultSchema,
          }),
        }),
        input("isolation-read")
      );
      assert.equal(isolation.parentStatus, 200);
      assert.equal(isolation.parent.ok, true);
      assert.match(
        isolation.wrapper.directError,
        /not permitted to access the internet/u
      );
      assert.equal(isolation.wrapper.gateway.status, "ok");
      assert.deepEqual(isolation.wrapper.gateway.value?.output, {
        secret: "[redacted]",
        source: "controlled-read",
        value: "runtime-value",
      });
      const resultSnapshot1 = await counts();
      const readsBeforeTamper = resultSnapshot1.observations.filter(
        (item) => item.kind === "read"
      ).length;
      const tampered = await json(
        "/tamper",
        z.object({ tampered: resultSchema, widened: resultSchema }),
        input("tampered-read")
      );
      assert.equal(tampered.tampered.status, "denied");
      assert.equal(tampered.widened.status, "invalid-input");
      const resultSnapshot2 = await counts();
      assert.equal(
        resultSnapshot2.observations.filter((item) => item.kind === "read")
          .length,
        readsBeforeTamper
      );
      const read = await json(
        "/invoke",
        invocationSchema,
        input("registered-read")
      );
      assert.equal(read.result.status, "ok");
      assert.deepEqual(read.result.value?.output, {
        secret: "[redacted]",
        source: "controlled-read",
        value: "runtime-value",
      });
      const blocked = await json(
        "/invoke",
        invocationSchema,
        input("approved-write", "controlled_write")
      );
      assert.deepEqual(blocked.result, {
        code: "approval-required",
        status: "denied",
      });
      const resultSnapshot3 = await counts();
      assert.equal(resultSnapshot3.effects.length, 0);
      assert.deepEqual(
        await json(
          "/approve",
          z.object({ broker: z.boolean(), gateway: z.boolean() }),
          input("approved-write", "controlled_write")
        ),
        { broker: true, gateway: true }
      );
      const write = await json(
        "/invoke",
        invocationSchema,
        input("approved-write", "controlled_write")
      );
      assert.equal(write.result.status, "ok");
      assert.deepEqual(write.result.value?.output, {
        receipt: "approved-write:1",
        source: "controlled-write",
        value: "runtime-value",
      });
      const resultSnapshot4 = await json(
        "/invoke",
        invocationSchema,
        input("approved-write", "controlled_write")
      );
      assert.deepEqual(resultSnapshot4.result, write.result);
      const resultSnapshot5 = await counts();
      assert.deepEqual(resultSnapshot5.effects, [
        { calls: 1, effects: 1, operation_id: "approved-write" },
      ]);
      compose(["restart", "celld"]);
      base = `http://${compose(["port", "celld", "8080"])}`;
      await waitForHealth(base, Date.now() + 60_000);
      const replay = await json(
        "/invoke",
        invocationSchema,
        input("approved-write", "controlled_write")
      );
      assert.notEqual(replay.instanceId, write.instanceId);
      assert.deepEqual(replay.result, write.result);
      const resultSnapshot7 = await counts();
      assert.deepEqual(resultSnapshot7.effects, [
        { calls: 1, effects: 1, operation_id: "approved-write" },
      ]);
      const sdkRead = await json("/sdk", sdkSchema, {
        operationId: "sdk-read",
        tool: "controlled_read",
      });
      assert.equal(sdkRead.attempts.length, 1);
      assert.equal(
        sdkRead.tools.find((item) => item.name === "controlled_read")?.state
          .status,
        "completed"
      );
      assert.equal(sdkRead.record.value?.state, "completed");
      assert.deepEqual(
        JSON.parse(sdkRead.tools[0]?.state.content?.[0]?.text ?? "null"),
        {
          secret: "[redacted]",
          source: "controlled-read",
          value: "runtime-value",
        }
      );
      await json(
        "/approve",
        z.object({ broker: z.boolean(), gateway: z.boolean() }),
        input("sdk-write", "controlled_write")
      );
      const sdkWrite = await json("/sdk", sdkSchema, {
        operationId: "sdk-write",
        tool: "controlled_write",
      });
      assert.equal(
        sdkWrite.tools.find((item) => item.name === "controlled_write")?.state
          .status,
        "completed"
      );
      const sdkReplay = await json("/sdk", sdkSchema, {
        operationId: "sdk-write",
        tool: "controlled_write",
      });
      assert.equal(
        sdkReplay.tools.find((item) => item.name === "controlled_write")?.state
          .status,
        "completed"
      );
      const resultSnapshot8 = await counts();
      const baseline = resultSnapshot8.effects;
      assert.deepEqual(baseline, [
        { calls: 1, effects: 1, operation_id: "approved-write" },
        { calls: 1, effects: 1, operation_id: "sdk-write" },
      ]);
      const attackTools = ["shell", "webfetch", "execute", "mcp_unregistered"];
      const verifyAttack = async (index: number): Promise<void> => {
        const tool = attackTools[index];
        if (!tool) {
          return;
        }
        const attack = await json("/sdk", sdkSchema, {
          operationId: `denial-${tool}`,
          tool,
        });
        const recorded = attack.tools.find((item) => item.name === tool);
        assert.ok(recorded, `Actual SDK must record forced ${tool} call.`);
        assert.equal(recorded.state.status, "error");
        assert.match(
          recorded.state.error?.message ?? "",
          new RegExp(
            `Unknown tool: ${tool}|Tool is not available for this request: ${tool}|Tool execution must use a registered Cerebro broker tool.`,
            "u"
          )
        );
        assert.equal(attack.attempts.length, 0);
        assert.equal(attack.record.status, "not-found");
        const resultSnapshot9 = await counts();
        assert.deepEqual(resultSnapshot9.effects, baseline);
        await verifyAttack(index + 1);
      };
      await verifyAttack(0);
      const { observations } = await counts();
      assert.ok(
        observations.filter((item) => item.kind === "model").length >= 12
      );
      assert.equal(
        observations.some((item) => item.secretPresent),
        false
      );
      const modelObservations = observations.filter(
        (item) => item.kind === "model"
      );
      assert.ok(
        modelObservations.some(
          (item) =>
            JSON.stringify(item.advertisedTools) ===
            JSON.stringify(["controlled_read", "controlled_write"])
        )
      );
      for (const observation of modelObservations) {
        for (const tool of observation.advertisedTools ?? []) {
          assert.ok(["controlled_read", "controlled_write"].includes(tool));
        }
      }
    } catch (error) {
      const diagnostics = compose(
        ["logs", "--no-color", "--tail", "50", "bootstrap", "celld", "fixture"],
        15_000
      );
      process.stderr.write(`${diagnostics}\n`);
      throw error;
    } finally {
      compose(["down", "--volumes", "--remove-orphans"], 30_000);
    }
  }
);
