/* oxlint-disable no-await-in-loop -- The live read must complete before its durable result is checked. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { z } from "zod";

const localUrl = z
  .url()
  .refine((value) =>
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname)
  );
const credentials = z.strictObject({
  agentId: z.string().min(1),
  apiUrl: localUrl,
  cookie: z.string().min(1),
  fixtureId: z.string().min(1),
  modelId: z.string().min(1),
  prompt: z.string().min(1).max(4096),
  runtimeConfigurationPath: z.string().min(1),
  toolId: z.string().min(1),
  webUrl: localUrl,
});
const snapshotSchema = z.object({
  snapshot: z.object({
    outputs: z.array(
      z.object({
        answerId: z.string(),
        dependencies: z.object({ toolIds: z.array(z.string()) }),
        runIds: z.array(z.string()),
      })
    ),
    runs: z.array(z.object({ runId: z.string(), state: z.string() })),
    tools: z.array(
      z.object({
        effect: z.enum(["read", "write"]),
        operationId: z.string(),
        runId: z.string(),
        state: z.string(),
        toolId: z.string(),
      })
    ),
  }),
});

test(
  "configured live Pi model completes one real controlled MCP read",
  { timeout: 180_000 },
  async () => {
    const configPath = process.env.CEREBRO_PI_LIVE_CONFIG;
    assert.ok(
      configPath,
      "NOT_RUN: set CEREBRO_PI_LIVE_CONFIG to the private local acceptance configuration file."
    );
    const config = credentials.parse(
      JSON.parse(await readFile(configPath, "utf-8"))
    );
    const runtime = z
      .object({
        mode: z.literal("local"),
        models: z.array(z.object({ baseUrl: z.url(), id: z.string() })),
        tools: z.array(
          z.object({
            effect: z.literal("read"),
            id: z.string(),
            target: z.object({ kind: z.literal("mcp-read"), url: z.url() }),
          })
        ),
      })
      .parse(
        JSON.parse(await readFile(config.runtimeConfigurationPath, "utf-8"))
      );
    const model = runtime.models.find((value) => value.id === config.modelId);
    const tool = runtime.tools.find((value) => value.id === config.toolId);
    assert.ok(
      model && tool,
      "Select a configured live model and controlled MCP read."
    );
    assert.equal(new URL(model.baseUrl).protocol, "https:");
    assert.ok(
      !config.modelId.startsWith("fixture") &&
        !config.toolId.startsWith("fixture")
    );
    assert.ok(
      !["fixture", "localhost", "127.0.0.1", "[::1]"].includes(
        new URL(tool.target.url).hostname
      )
    );
    const request = async (route: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(new URL(route, config.apiUrl), {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Cookie: config.cookie,
          Origin: config.webUrl,
        },
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(20_000),
      });
      assert.equal(
        response.status,
        200,
        `Live application request failed: ${route} (${response.status}).`
      );
      return await response.json();
    };
    const fixtureRoute = await fetch(
      new URL("/api/fixture/runtime/isolation", config.apiUrl)
    );
    assert.equal(
      fixtureRoute.status,
      404,
      "The credentialed gate must not expose test-only routes."
    );
    const agent = z
      .object({
        definition: z.object({
          enabledToolIds: z.array(z.string()),
          model: z.string(),
        }),
      })
      .parse(
        await request(
          `/api/product/agents/${encodeURIComponent(config.agentId)}`
        )
      );
    assert.equal(agent.definition.model, config.modelId);
    assert.deepEqual(agent.definition.enabledToolIds, [config.toolId]);
    const identity = randomUUID();
    const conversation = z.object({ conversationId: z.string() }).parse(
      await request("/api/product/conversations", {
        agentId: config.agentId,
        operationId: `pi-live-${identity}`,
      })
    );
    const route = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
    const accepted = z
      .object({ receipt: z.object({ runId: z.string() }) })
      .parse(
        await request(`${route}/messages`, {
          eventId: `pi-live-${identity}`,
          mode: "follow-up",
          text: config.prompt,
        })
      );
    const { receipt } = accepted;
    const deadlineAt = Date.now() + 120_000;
    let result = snapshotSchema.parse(await request(route));
    while (
      Date.now() < deadlineAt &&
      result.snapshot.runs.find((run) => run.runId === receipt.runId)?.state !==
        "completed"
    ) {
      const run = result.snapshot.runs.find(
        (value) => value.runId === receipt.runId
      );
      assert.ok(
        !run ||
          ["queued", "running", "waiting-for-approval"].includes(run.state),
        `The live run terminated as ${run?.state}.`
      );
      await delay(250);
      result = snapshotSchema.parse(await request(route));
    }
    assert.equal(
      result.snapshot.runs.find((run) => run.runId === receipt.runId)?.state,
      "completed"
    );
    const tools = result.snapshot.tools.filter(
      (value) => value.runId === receipt.runId
    );
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.toolId, config.toolId);
    assert.equal(tools[0]?.effect, "read");
    assert.equal(tools[0]?.state, "succeeded");
    const outputs = result.snapshot.outputs.filter((value) =>
      value.runIds.includes(receipt.runId)
    );
    assert.equal(outputs.length, 1);
    assert.ok(outputs[0]?.dependencies.toolIds.includes(config.toolId));
    const execute = promisify(execFile);
    const revision = await execute("git", ["rev-parse", "HEAD"]);
    const sha = revision.stdout.trim();
    const directory = path.resolve(
      "artifacts/slice-1",
      sha,
      `pi-live-${identity}`
    );
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, "acceptance.json"),
      `${JSON.stringify(
        {
          answerId: outputs[0]?.answerId,
          conversationId: conversation.conversationId,
          fixtureId: config.fixtureId,
          modelId: config.modelId,
          operationId: tools[0]?.operationId,
          runId: receipt.runId,
          sha,
          state: "PASS",
          toolId: config.toolId,
        },
        null,
        2
      )}\n`
    );
  }
);
