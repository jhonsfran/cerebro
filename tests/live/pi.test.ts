/* oxlint-disable no-await-in-loop -- Failure cleanup cancels only work created in this test conversation. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { z } from "zod";

import type { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";
import {
  decodeLiveReceipt,
  decodeLiveSnapshot,
  waitForLiveRead,
} from "./pi-acceptance.ts";

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
const remoteEndpoint = (value: string): boolean => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !["fixture", "localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
};

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
            effect: z.enum(["read", "write"]),
            id: z.string(),
            requiresApproval: z.boolean(),
            target: z.object({
              kind: z.enum(["mcp", "mcp-read", "http-write"]),
              url: z.url(),
            }),
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
    assert.ok(
      remoteEndpoint(model.baseUrl),
      "The live model must use a remote HTTPS endpoint."
    );
    assert.ok(
      remoteEndpoint(tool.target.url),
      "The live MCP must use a remote HTTPS endpoint."
    );
    assert.equal(tool.effect, "read");
    assert.equal(tool.requiresApproval, false);
    assert.ok(["mcp", "mcp-read"].includes(tool.target.kind));
    assert.ok(
      !config.modelId.startsWith("fixture") &&
        !config.toolId.startsWith("fixture")
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
      new URL("/api/fixture/runtime/isolation", config.apiUrl),
      { signal: AbortSignal.timeout(20_000) }
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
    const operationId = `pi-live-${identity}`;
    const conversation = z.object({ conversationId: z.string() }).parse(
      await request("/api/product/conversations", {
        agentId: config.agentId,
        operationId,
      })
    );
    const route = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
    let latest: ChatSnapshot | undefined;
    let passed = false;
    try {
      const input = { operationId, text: config.prompt };
      const receipt = decodeLiveReceipt(
        await request(`${route}/messages`, input)
      );
      assert.equal(receipt.accepted, true);
      assert.equal(receipt.operationId, operationId);
      const read = async () => {
        const value = await request(route);
        latest = decodeLiveSnapshot(value);
        return value;
      };
      const options = {
        agentId: config.agentId,
        conversationId: conversation.conversationId,
        prompt: config.prompt,
        read,
        toolId: config.toolId,
      };
      const result = await waitForLiveRead(options);
      const replay = decodeLiveReceipt(
        await request(`${route}/messages`, input)
      );
      assert.deepEqual(replay, { ...receipt, accepted: false });
      const repeated = await waitForLiveRead(options);
      assert.equal(repeated.execution.id, result.execution.id);
      assert.equal(repeated.answer.id, result.answer.id);
      const execute = promisify(execFile);
      const [revision, status] = await Promise.all([
        execute("rtk", ["proxy", "git", "rev-parse", "HEAD"]),
        execute("rtk", [
          "proxy",
          "git",
          "status",
          "--porcelain=v1",
          "--",
          ".",
          ":(exclude)artifacts/**",
        ]),
      ]);
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
            answerId: result.answer.id,
            conversationId: conversation.conversationId,
            fixtureId: config.fixtureId,
            modelId: config.modelId,
            operationId,
            replayAccepted: replay.accepted,
            session: receipt.session,
            sha,
            sourceCheckoutDirty: status.stdout.trim().length > 0,
            state: "PASS",
            toolExecutionId: result.execution.id,
            toolId: config.toolId,
          },
          null,
          2
        )}\n`
      );
      passed = true;
    } finally {
      if (!passed) {
        for (const reminder of latest?.activity?.reminders ?? []) {
          if (reminder.state === "scheduled") {
            try {
              await request(`${route}/control`, {
                kind: "cancel-schedule",
                scheduleId: reminder.id,
              });
            } catch {
              // Preserve the acceptance failure if access also prevents cleanup.
            }
          }
        }
        try {
          await request(`${route}/stop`, {});
        } catch {
          // Preserve the acceptance failure if access also prevents cleanup.
        }
      }
    }
  }
);
