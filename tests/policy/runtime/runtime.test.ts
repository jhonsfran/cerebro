/* oxlint-disable no-await-in-loop -- Policy cases depend on prior durable effects and authority changes. */
/* oxlint-disable unicorn/no-await-expression-member -- Boundary assertions compare completed HTTP responses. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";
import { z } from "zod";

import { id } from "../../../packages/contracts/src/identity.ts";
import { DomainSnapshot } from "../../../packages/contracts/src/session-service.ts";
import {
  context,
  fixtureToken,
  organizationId,
  agentId,
  principalId,
} from "./src/fixture-identity.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const composeFile = fileURLToPath(new URL("compose.yaml", import.meta.url));
const source = () => {
  const head = spawnSync("rtk", ["proxy", "git", "rev-parse", "HEAD"], {
    encoding: "utf-8",
  });
  const status = spawnSync(
    "rtk",
    [
      "proxy",
      "git",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ".",
      ":(exclude)artifacts/**",
    ],
    { encoding: "utf-8" }
  );
  if (head.status !== 0 || status.status !== 0) {
    throw new Error("Source identity unavailable");
  }
  const hash = createHash("sha256");
  for (const directory of [
    "packages/runtime/src",
    "packages/tools/src",
    "packages/contracts/src",
    "packages/db/src",
    "tests/policy/runtime",
    "tests/policy/fixtures",
  ]) {
    for (const file of readdirSync(directory, { recursive: true })
      .filter(
        (name): name is string =>
          typeof name === "string" && /\.(?:ts|mjs|yaml|md)$/u.test(name)
      )
      .toSorted()) {
      hash.update(`${directory}/${file}\n`);
      hash.update(readFileSync(`${directory}/${file}`));
    }
  }
  for (const file of [
    "tests/runtime/Dockerfile",
    "tests/runtime/package.json",
    "tests/runtime/package-lock.json",
  ]) {
    hash.update(file);
    hash.update(readFileSync(file));
  }
  return {
    dirtyCheckout: status.stdout.length > 0,
    identity: `${head.stdout.trim()}:sha256:${hash.digest("hex")}`,
  };
};
const addressFor = (session: string) => ({
  agentId,
  conversationId: id.conversation(`conversation:${session}`),
  organizationId,
  sessionId: id.session(`session:${session}`),
});
const options = (operationId: string) => ({
  deadlineAt: Date.now() + 120_000,
  operationId,
  requestDigest: `sha256:${operationId}`,
});
const eventFor = (session: string, tool: string) => ({
  ...addressFor(session),
  context,
  event: {
    payload: {
      text: `forcedTool=${tool} Call the named tool once with value runtime-value.`,
    },
    type: "user.message",
  },
  eventId: id.event(session),
  occurredAt: Date.now(),
  payloadDigest: id.digest(`sha256:${session}`),
  schemaVersion: 1,
});
const resultSchema = z.object({
  status: z.string(),
  value: z
    .object({ output: z.unknown(), providerReceipt: z.string().optional() })
    .optional(),
});
const countsSchema = z.object({
  effects: z.array(
    z.object({
      calls: z.number(),
      effects: z.number(),
      operation_id: z.string(),
    })
  ),
  fixtureId: z.string(),
  observations: z.array(
    z.object({
      advertisedTools: z.array(z.string()).optional(),
      kind: z.string(),
      secretPresent: z.boolean(),
    })
  ),
  sourceIdentity: z.string(),
});
const receiptSchema = z.object({
  outcome: z
    .object({ execution: z.object({ output: z.unknown() }), state: z.string() })
    .optional(),
  state: z.string(),
});
const nativeSchema = z.object({
  entries: z.array(z.object({ model: z.array(z.unknown()).optional() })),
  receiptCount: z.number(),
  tools: z.array(
    z.object({ name: z.string(), status: z.string() }).passthrough()
  ),
});
const physical = (counts: z.infer<typeof countsSchema>) => ({
  effects: counts.effects,
  reads: counts.observations.filter((item) => item.kind === "read").length,
});
const poll = async <Value>(
  read: () => Promise<Value>,
  ready: (value: Value) => boolean
): Promise<Value> => {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) {
      return value;
    }
    await delay(100);
  }
  throw new Error("Native policy fixture did not reach the required state");
};

test(
  "actual production Pi host, receipts and signed restricted gateway enforce policy",
  { timeout: 540_000 },
  async () => {
    const project = `cerebro-s1-policy-native-${randomUUID().slice(0, 8)}`;
    const identity = source();
    const directory = `/tmp/cerebro-policy-native-evidence/${project}`;
    const compose = (args: readonly string[]) => {
      const result = spawnSync(
        "rtk",
        [
          "proxy",
          "docker",
          "compose",
          "--project-name",
          project,
          "--file",
          composeFile,
          ...args,
        ],
        {
          cwd: root,
          encoding: "utf-8",
          env: {
            ...process.env,
            CEREBRO_S4_WORKTREE: root,
            COMPOSE_PROJECT_NAME: project,
            POLICY_SOURCE_ID: identity.identity,
          },
          maxBuffer: 10 * 1024 * 1024,
          timeout: 180_000,
        }
      );
      if (result.status !== 0) {
        throw new Error(result.stderr || result.stdout);
      }
      return result.stdout.trim();
    };
    let base = "";
    let provider = "";
    let passed = false;
    const request = async (
      path: string,
      body: unknown,
      trusted = true,
      principal: string = principalId
    ) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await fetch(`${base}${path}`, {
            body: JSON.stringify(body),
            headers: {
              "Content-Type": "application/json",
              ...(trusted
                ? {
                    Authorization: `Bearer ${fixtureToken}`,
                    "x-fixture-principal": principal,
                  }
                : {}),
            },
            method: "POST",
            signal: AbortSignal.timeout(70_000),
          });
        } catch (error) {
          if (!(error instanceof TypeError) || attempt === 2) {
            throw error;
          }
          await delay(200);
        }
      }
      throw new Error("Policy fixture transport unavailable");
    };
    const command = async (path: string, body: unknown): Promise<unknown> => {
      const response = await request(`/runtime${path}`, body);
      const value: unknown = await response.json();
      if (!response.ok) {
        throw new Error(`HTTP${response.status}: ${JSON.stringify(value)}`);
      }
      return z
        .object({ status: z.literal("ok"), value: z.unknown() })
        .parse(value).value;
    };
    const inspect = async (address: ReturnType<typeof addressFor>) =>
      Schema.decodeUnknownSync(DomainSnapshot)(
        await command("/inspect", {
          address,
          options: options(`inspect:${randomUUID()}`),
        })
      );
    const counts = async () => {
      const response = await fetch(`${provider}/counts`, {
        signal: AbortSignal.timeout(5000),
      });
      return countsSchema.parse(await response.json());
    };
    const ownership = () => {
      const containerIds = compose(["ps", "--all", "--quiet"]).split(/\s+/u);
      const result = spawnSync(
        "rtk",
        ["proxy", "docker", "inspect", ...containerIds],
        {
          encoding: "utf-8",
        }
      );
      assert.equal(result.status, 0, result.stderr);
      const containers = z
        .array(
          z.object({
            Config: z.object({
              Env: z.array(z.string()),
              Labels: z.record(z.string(), z.string()),
            }),
            Id: z.string(),
            Image: z.string(),
            Mounts: z.array(
              z.object({
                Destination: z.string(),
                Name: z.string().optional(),
                Source: z.string(),
                Type: z.string(),
              })
            ),
            Name: z.string(),
            State: z.object({
              FinishedAt: z.string(),
              StartedAt: z.string(),
              Status: z.string(),
            }),
          })
        )
        .parse(JSON.parse(result.stdout));
      return containers.map((container) => {
        assert.equal(
          container.Config.Labels["com.docker.compose.project"],
          project
        );
        return {
          containerId: container.Id,
          imageId: container.Image,
          mounts: container.Mounts,
          name: container.Name,
          project,
          service: container.Config.Labels["com.docker.compose.service"],
          state: container.State,
          wakerTick: container.Config.Env.find((entry) =>
            entry.startsWith("CELLD_WAKER_TICK_MS=")
          ),
        };
      });
    };
    const save = async (name: string, value: unknown) => {
      await mkdir(directory, { recursive: true });
      await writeFile(
        `${directory}/${name}.json`,
        JSON.stringify(
          {
            containers: compose(["ps", "--all", "--format", "json"]),
            dirtyCheckout: identity.dirtyCheckout,
            ownership: ownership(),
            project,
            sourceIdentity: identity.identity,
            value,
            versions: JSON.parse(
              compose(["exec", "-T", "celld", "cat", "/run/s4/versions.json"])
            ),
          },
          null,
          2
        )
      );
    };
    const submit = async (event: ReturnType<typeof eventFor>) =>
      z.object({ replayed: z.boolean(), runId: z.string() }).parse(
        await command("/submit", {
          address: event,
          command: { event, mode: "follow-up", type: "submit" },
          options: options(`submit:${event.eventId}`),
        })
      );
    try {
      const existing = spawnSync(
        "rtk",
        [
          "proxy",
          "docker",
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ],
        { encoding: "utf-8" }
      );
      assert.equal(existing.status, 0);
      assert.equal(existing.stdout.trim(), "");
      compose(["up", "--build", "--detach", "--wait", "--wait-timeout", "120"]);
      base = `http://${compose(["port", "celld", "8080"])}`;
      provider = `http://${compose(["port", "fixture", "8090"])}`;
      const initial = await counts();
      assert.equal(initial.fixtureId, project);
      assert.equal(initial.sourceIdentity, identity.identity);
      const address = addressFor("controls");
      for (const path of [
        "/runtime/inspect",
        "/runtime/approve",
        "/runtime/fixture/isolation",
        "/private/gateway/invoke",
        "/private/gateway/approve",
        "/private/gateway/reconcile",
        "/private/gateway/journal",
        "/private/gateway/authority",
      ]) {
        const denied = await request(
          path,
          { address, options: options(`denied:${path}`) },
          false
        );
        assert.equal(denied.status, 403, `Unauthenticated ${path} must fail`);
      }
      assert.equal(
        (
          await request(
            "/runtime/inspect",
            { address, options: options("outsider") },
            true,
            "foreign-human"
          )
        ).status,
        403
      );
      assert.equal(
        (
          await request("/runtime/inspect", {
            address: { ...address, organizationId: "foreign-company" },
            options: options("cross-company"),
          })
        ).status,
        403
      );
      assert.deepEqual(physical(await counts()), physical(initial));
      await save("private-denials", { counts: await counts() });
      const isolationSchema = z.object({
        parent: z.object({ ok: z.boolean() }),
        parentStatus: z.number(),
        wrapper: z.object({
          directError: z.string(),
          directStatus: z.null(),
          gateway: resultSchema,
        }),
      });
      const isolation = isolationSchema.parse(
        await command("/fixture/isolation", {
          address,
          operationId: "isolation-read",
          tool: "controlled_read",
          value: "runtime-value",
        })
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
      const beforeTamper = physical(await counts());
      const attacks = z
        .record(
          z.string(),
          z.object({ httpStatus: z.number(), result: resultSchema })
        )
        .parse(
          await command("/fixture/tamper", {
            address,
            operationId: "tampered-read",
            tool: "controlled_read",
            value: "runtime-value",
          })
        );
      for (const [name, attack] of Object.entries(attacks)) {
        assert.equal(
          attack.result.status,
          ["widened", "changedVersion"].includes(name)
            ? "invalid-input"
            : "denied",
          name
        );
      }
      assert.deepEqual(physical(await counts()), beforeTamper);
      await save("capability-and-egress", {
        attacks,
        counts: await counts(),
        isolation,
      });
      const readEvent = eventFor("native-read", "controlled_read");
      const readAccepted = await submit(readEvent);
      const read = await poll(
        () => inspect(readEvent),
        (value) => value.runs[0]?.state === "completed"
      );
      assert.equal(read.tools[0]?.state, "succeeded");
      assert.deepEqual(read.tools[0]?.output, {
        secret: "[redacted]",
        source: "controlled-read",
        value: "runtime-value",
      });
      assert.equal(read.outputs.length, 1);
      const writeEvent = eventFor("native-write", "controlled_write");
      const writeAccepted = await submit(writeEvent);
      const waiting = await poll(
        () => inspect(writeEvent),
        (value) => value.approvals[0]?.state === "pending"
      );
      const [approval] = waiting.approvals;
      assert.ok(approval);
      assert.equal((await counts()).effects.length, 0);
      await command("/approve", {
        address: writeEvent,
        command: {
          address: writeEvent,
          approvalId: approval.approvalId,
          context,
          decision: "allow",
          runId: approval.runId,
          type: "approve",
        },
        options: options("approve-native-write"),
      });
      const written = await poll(
        () => inspect(writeEvent),
        (value) => value.runs[0]?.state === "completed"
      );
      assert.equal(written.outputs.length, 1);
      assert.equal(written.tools[0]?.state, "succeeded");
      const receipt = receiptSchema.parse(
        await command("/fixture/receipt", {
          address: writeEvent,
          operationId: approval.operationId,
        })
      );
      assert.equal(receipt.state, "completed");
      assert.equal((await submit(writeEvent)).replayed, true);
      const replay = z
        .object({ output: z.unknown(), providerReceipt: z.string().optional() })
        .parse(
          await command("/fixture/replay", {
            address: writeEvent,
            operationId: approval.operationId,
          })
        );
      assert.deepEqual(replay.output, receipt.outcome?.execution.output);
      const beforeRestart = await counts();
      assert.deepEqual(beforeRestart.effects, [
        { calls: 1, effects: 1, operation_id: approval.operationId },
      ]);
      const instance = z
        .object({ instanceId: z.string() })
        .parse(await command("/fixture/state", { address: writeEvent }));
      await save("before-restart", {
        instance,
        provider: beforeRestart,
        read,
        readAccepted,
        receipt,
        replay,
        writeAccepted,
        written,
      });
      compose(["kill", "-s", "SIGKILL", "celld"]);
      compose(["up", "--detach", "--wait", "celld"]);
      base = `http://${compose(["port", "celld", "8080"])}`;
      const reopened = await inspect(writeEvent);
      assert.deepEqual(reopened, written);
      const replacement = z
        .object({ instanceId: z.string() })
        .parse(await command("/fixture/state", { address: writeEvent }));
      assert.notEqual(replacement.instanceId, instance.instanceId);
      assert.equal((await submit(writeEvent)).replayed, true);
      await command("/fixture/replay", {
        address: writeEvent,
        operationId: approval.operationId,
      });
      const journal = z
        .object({
          status: z.literal("ok"),
          value: z.object({ state: z.literal("completed") }),
        })
        .parse(
          await command("/fixture/journal", {
            address: writeEvent,
            operationId: approval.operationId,
          })
        );
      assert.deepEqual(physical(await counts()), physical(beforeRestart));
      await save("native-replay", {
        journal,
        provider: await counts(),
        reopened,
        replacement,
      });
      await command("/fixture/access", { address, enabled: false });
      const authorityBaseline = await counts();
      for (const path of ["/inspect", "/fixture/receipt", "/fixture/replay"]) {
        const denied = await request(`/runtime${path}`, {
          address: writeEvent,
          operationId: approval.operationId,
          options: options(`revoked:${path}`),
        });
        assert.equal(denied.status, 403, path);
      }
      const deniedSubmit = await request("/runtime/submit", {
        address: writeEvent,
        command: { event: writeEvent, mode: "follow-up", type: "submit" },
        options: options("revoked-submit"),
      });
      assert.equal(deniedSubmit.status, 403);
      const revoked = isolationSchema.parse(
        await command("/fixture/isolation", {
          address,
          operationId: "isolation-read",
          tool: "controlled_read",
          value: "runtime-value",
        })
      );
      assert.equal(revoked.wrapper.gateway.status, "denied");
      compose(["kill", "-s", "SIGKILL", "celld"]);
      compose(["up", "--detach", "--wait", "celld"]);
      base = `http://${compose(["port", "celld", "8080"])}`;
      assert.equal(
        (
          await request("/runtime/inspect", {
            address: writeEvent,
            options: options("revoked-reopen"),
          })
        ).status,
        403
      );
      assert.deepEqual(physical(await counts()), physical(authorityBaseline));
      await command("/fixture/access", { address, enabled: true });
      assert.equal((await submit(writeEvent)).replayed, true);
      const restored = await inspect(writeEvent);
      assert.deepEqual(restored.outputs, written.outputs);
      const gatewayReplay = isolationSchema.parse(
        await command("/fixture/isolation", {
          address,
          operationId: "isolation-read",
          tool: "controlled_read",
          value: "runtime-value",
        })
      );
      assert.equal(gatewayReplay.wrapper.gateway.status, "ok");
      assert.deepEqual(physical(await counts()), physical(authorityBaseline));
      await save("current-authority", {
        gatewayReplay,
        provider: await counts(),
        restored,
        revoked,
      });
      const baseline = physical(await counts());
      const unsupported = [];
      for (const tool of ["shell", "webfetch", "execute", "mcp_unregistered"]) {
        const event = eventFor(`denial-${tool}`, tool);
        await submit(event);
        const completed = await poll(
          () => inspect(event),
          (value) => value.runs[0]?.state === "completed"
        );
        const native = nativeSchema.parse(
          await command("/fixture/native", { address: event })
        );
        const toolResult = z.object({
          content: z.array(
            z.object({ text: z.string(), type: z.literal("text") })
          ),
          isError: z.boolean(),
          role: z.literal("toolResult"),
          toolName: z.string(),
        });
        const recorded = native.entries
          .flatMap((entry) => entry.model ?? [])
          .flatMap((message) => {
            const result = toolResult.safeParse(message);
            return result.success ? [result.data] : [];
          })
          .find((message) => message.toolName === tool);
        assert.ok(recorded, `Pi must record forced ${tool}`);
        assert.equal(recorded.isError, true);
        assert.match(
          recorded.content.map((part) => part.text).join(""),
          new RegExp(`Tool ${tool} is not available`, "u")
        );
        assert.equal(native.receiptCount, 0);
        assert.deepEqual(physical(await counts()), baseline);
        unsupported.push({ completed, native, tool });
      }
      const final = await counts();
      assert.ok(
        final.observations.filter((item) => item.kind === "model").length >= 12
      );
      assert.equal(
        final.observations.some((item) => item.secretPresent),
        false
      );
      for (const observation of final.observations.filter(
        (item) => item.kind === "model"
      )) {
        assert.deepEqual(observation.advertisedTools, [
          "controlled_read",
          "controlled_write",
        ]);
      }
      await save("unsupported-native-tools", { provider: final, unsupported });
      passed = true;
    } catch (error) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        `${directory}/failure.json`,
        JSON.stringify(
          {
            containers: compose(["ps", "--all", "--format", "json"]),
            dirtyCheckout: identity.dirtyCheckout,
            error: String(error),
            logs: compose([
              "logs",
              "--no-color",
              "--tail=100",
              "bootstrap",
              "celld",
              "fixture",
            ]),
            project,
            sourceIdentity: identity.identity,
          },
          null,
          2
        )
      );
      throw error;
    } finally {
      if (passed) {
        compose(["down", "--volumes"]);
      }
    }
  }
);
