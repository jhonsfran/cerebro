/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Native observation frames and dependent authority changes are ordered. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";
import { z } from "zod";

import {
  ChatSnapshot,
  ChatObservation,
  ChatReceipt,
  ChatDecisionReceipt,
} from "../../../packages/contracts/src/session-service.ts";
import {
  applicationFixture,
  readApplicationBoot,
  waitForFixture,
} from "../../slice-1/application.ts";

const metadataPath = process.env.CHANNEL_NATIVE_METADATA;
if (!metadataPath) {
  throw new Error(
    "Run tests/channels/native/run.mjs to boot a fresh owned application."
  );
}
const metadata = z
  .object({
    agent: z.object({
      agentId: z.string(),
      organizationId: z.string(),
      principalId: z.string(),
      version: z.number(),
    }),
    bootPath: z.string(),
    owner: z.object({ cookie: z.string(), userId: z.string() }),
    sourceCheckoutDirty: z.boolean(),
    sourceIdentity: z.string(),
  })
  .parse(JSON.parse(await readFile(metadataPath, "utf-8")));
const boot = await readApplicationBoot(metadata.bootPath);
const fixture = applicationFixture(boot);
const directory = path.dirname(metadataPath);
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const createdAgent = z.object({ agentId: z.string(), version: z.number() });
const conversationSchema = z.object({
  conversationId: z.string(),
  sessionId: z.string(),
});
const receiptSchema = z.object({
  receipt: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(ChatReceipt)(value)),
});
const viewSchema = z.object({
  agentId: z.string(),
  conversationId: z.string(),
  sessionId: z.string(),
  snapshot: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(ChatSnapshot)(value)),
});
const providerSchema = z.object({
  model: z.array(
    z.object({ completedAt: z.number().optional(), operationId: z.string() })
  ),
  tools: z.array(z.object({ operationId: z.string(), write: z.boolean() })),
});
const provider = async () => providerSchema.parse(await fixture.observations());
const firstSnapshot = async (
  route: string,
  cookie: string
): Promise<ChatObservation> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const response = await fetch(`${boot.apiUrl}${route}/observations`, {
    headers: { Cookie: cookie, Origin: boot.webUrl },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/x-ndjson/u
  );
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const result = await reader.read();
      assert.equal(
        result.done,
        false,
        "An authorized native observation must start with a snapshot"
      );
      buffer += decoder.decode(result.value, { stream: true });
      const index = buffer.indexOf("\n");
      if (index !== -1) {
        const frame = Schema.decodeUnknownSync(ChatObservation)(
          JSON.parse(buffer.slice(0, index))
        );
        assert.equal(frame.type, "snapshot");
        return frame;
      }
    }
  } finally {
    controller.abort();
    clearTimeout(timeout);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

test(
  "native production REST preserves publish replay, session retry, approval and current access",
  { timeout: 240_000 },
  async () => {
    const saved: Record<string, unknown> = {};
    let revoked = false;
    try {
      const { owner, agent } = metadata;
      await fixture.controls({ delayMs: 0, failFirst: false });
      const publishInput = {
        enabledToolIds: ["fixture-read"],
        grants: [],
        instructions: "Answer from the local source.",
        model: "fixture/slice-1",
        name: "Native publish replay",
        operationId: randomUUID(),
      };
      const published = await fixture.json(
        "/api/product/agents",
        owner.cookie,
        createdAgent,
        publishInput
      );
      assert.deepEqual(
        await fixture.json(
          "/api/product/agents",
          owner.cookie,
          createdAgent,
          publishInput
        ),
        published
      );
      const conversation = await fixture.json(
        "/api/product/conversations",
        owner.cookie,
        conversationSchema,
        { agentId: agent.agentId, operationId: randomUUID() }
      );
      const route = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
      const outsider = await fixture.signup("Native channel outsider");
      for (const suffix of ["", "/sources/pilot-source", "/observations"]) {
        const response = await fixture.request(
          `${route}${suffix}`,
          outsider.cookie
        );
        assert.equal(response.status, 403);
        await response.body?.cancel();
      }
      const message = {
        operationId: randomUUID(),
        text: "Use fixture-read for the refund policy.",
      };
      const first = await fixture.json(
        `${route}/messages`,
        owner.cookie,
        receiptSchema,
        message
      );
      const retry = await fixture.json(
        `${route}/messages`,
        owner.cookie,
        receiptSchema,
        message
      );
      assert.equal(first.receipt.accepted, true);
      assert.deepEqual(retry.receipt, { ...first.receipt, accepted: false });
      const final = await waitForFixture(
        () => fixture.json(route, owner.cookie, viewSchema),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.messages.some(
            (entry) =>
              entry.role === "assistant" &&
              entry.text === "Cerebro slice 1 completed."
          )
      );
      assert.equal(
        final.snapshot.messages.filter((entry) => entry.role === "user").length,
        1
      );
      assert.ok(
        final.snapshot.messages.some(
          (entry) => entry.role === "tool" && entry.toolName === "fixture-read"
        )
      );
      const attached = await firstSnapshot(route, owner.cookie);
      const reattached = await firstSnapshot(route, owner.cookie);
      assert.equal(attached.type, "snapshot");
      assert.deepEqual(reattached, attached);
      const source = await fixture.request(
        `${route}/sources/pilot-source`,
        owner.cookie
      );
      assert.equal(source.status, 200);
      assert.match(await source.text(), /policy/iu);
      await fixture.json(`${route}/messages`, owner.cookie, receiptSchema, {
        operationId: randomUUID(),
        text: "Apply fixture_effect once.",
      });
      const pending = await waitForFixture(
        () => fixture.json(route, owner.cookie, viewSchema),
        (value) =>
          value.snapshot.approvals.some(
            (approval) => approval.state === "pending"
          )
      );
      const approval = pending.snapshot.approvals.find(
        (entry) => entry.state === "pending"
      );
      assert.ok(approval);
      const approvalRoute = `${route}/approvals/${encodeURIComponent(approval.approvalId)}`;
      const decisionSchema = z.object({
        approval: z
          .unknown()
          .transform((value) =>
            Schema.decodeUnknownSync(ChatDecisionReceipt)(value)
          ),
      });
      await fixture.json(approvalRoute, owner.cookie, decisionSchema, {
        decision: "allow",
      });
      await fixture.json(approvalRoute, owner.cookie, decisionSchema, {
        decision: "allow",
      });
      const settled = await waitForFixture(
        () => fixture.json(route, owner.cookie, viewSchema),
        (value) =>
          !value.snapshot.busy &&
          value.snapshot.messages.filter((entry) => entry.role === "user")
            .length === 2
      );
      const observed = await provider();
      assert.equal(
        observed.tools.filter(
          (tool) => tool.operationId === approval.operationId && tool.write
        ).length,
        1
      );
      await fixture.sql(
        `DELETE FROM identity_grant WHERE organization_id=${literal(agent.organizationId)} AND principal_id=${literal(agent.principalId)} AND action='read' AND resource_kind='agent' AND resource_id=${literal(agent.agentId)}`
      );
      revoked = true;
      for (const suffix of ["", "/observations", "/sources/pilot-source"]) {
        const response = await fixture.request(
          `${route}${suffix}`,
          owner.cookie
        );
        assert.equal(response.status, 403);
        await response.body?.cancel();
      }
      Object.assign(saved, {
        approval,
        attached,
        final,
        first,
        observed,
        retry,
        settled,
      });
      await writeFile(
        path.join(directory, "native-channel-evidence.json"),
        `${JSON.stringify({ saved, sourceIdentity: metadata.sourceIdentity }, null, 2)}\n`
      );
    } catch (error) {
      await writeFile(
        path.join(directory, "native-channel-failure.json"),
        `${JSON.stringify({ message: String(error), saved }, null, 2)}\n`
      );
      throw error;
    } finally {
      if (revoked) {
        const { agent } = metadata;
        await fixture.sql(
          `INSERT INTO identity_grant (organization_id,principal_id,action,resource_kind,resource_id,source) VALUES (${literal(agent.organizationId)},${literal(agent.principalId)},'read','agent',${literal(agent.agentId)},'native-channel-test') ON CONFLICT DO NOTHING`
        );
      }
    }
  }
);
