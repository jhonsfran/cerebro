import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { z } from "zod";

import { waitForFixture } from "../../slice-1/application.ts";
import {
  evidence,
  fixture,
  literal,
  metadata,
  observed,
} from "./team-support.ts";
import {
  conversationSchema,
  observe,
  publishedSchema,
  read,
  receiptSchema,
  sendMessage,
} from "./web-team-support.ts";

const forbiddenForeground = [
  "fixture-read",
  "fixture_effect",
  "subagent",
  "search_history",
  "search_conversations",
];
const inputDigest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

test(
  "native product keeps one primary through publish, replay, reconnect, and current read denial",
  { timeout: 240_000 },
  async () => {
    const definition = {
      enabledToolIds: ["fixture-read", "fixture_effect"],
      grants: [],
      instructions:
        "Answer ordinary questions with one brief sentence. PROFILE_NATIVE_V1.",
      model: "fixture/slice-1",
      name: "Persistent primary verification",
      operationId: crypto.randomUUID(),
    };
    const published = await fixture.json(
      "/api/product/agents",
      metadata.owner.cookie,
      publishedSchema,
      definition
    );
    assert.deepEqual(
      await fixture.json(
        "/api/product/agents",
        metadata.owner.cookie,
        publishedSchema,
        definition
      ),
      published
    );
    const open = (operationId: string) =>
      fixture.json(
        "/api/product/conversations",
        metadata.owner.cookie,
        conversationSchema,
        {
          agentId: published.agentId,
          operationId,
        }
      );
    const openOperation = crypto.randomUUID();
    const conversation = await open(openOperation);
    assert.deepEqual(await open(openOperation), conversation);
    assert.deepEqual(await open(crypto.randomUUID()), conversation);
    const route = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
    const outsider = await fixture.signup("Primary conversation outsider");
    const deniedReads = (cookie: string) =>
      Promise.all(
        ["", "/observations", "/inspection"].map(async (suffix) => {
          const denied = await fixture.request(
            route + suffix,
            cookie,
            suffix === "/inspection"
              ? { query: { kind: "overview" } }
              : undefined
          );
          assert.equal(denied.status, 403);
          await denied.body?.cancel();
        })
      );
    await deniedReads(outsider.cookie);
    const before = await observed();
    const input = {
      operationId: crypto.randomUUID(),
      text: "Give one ordinary answer about the planning meeting. primary-first.",
    };
    const first = await sendMessage(route, input);
    const replay = await sendMessage(route, input);
    assert.equal(first.receipt.accepted, true);
    assert.deepEqual(replay.receipt, { ...first.receipt, accepted: false });
    const final = await waitForFixture(
      () => read(route),
      (view) =>
        !view.snapshot.busy &&
        view.snapshot.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.text === "Cerebro slice 1 completed."
        )
    );
    assert.deepEqual(
      final.snapshot.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      [input.text]
    );
    assert.deepEqual(final.snapshot.approvals, []);
    assert.deepEqual(final.snapshot.tools, []);
    const firstPhysical = await observed();
    const initialCalls = firstPhysical.model.slice(before.model.length);
    assert.equal(initialCalls.length, 1);
    assert.equal(initialCalls[0]?.model, "slice-1");
    assert.ok(
      initialCalls[0]?.messageTextDigests.includes(inputDigest(input.text))
    );
    assert.ok(
      forbiddenForeground.every(
        (name) => !initialCalls[0]?.toolNames.includes(name)
      )
    );
    assert.deepEqual(firstPhysical.slack.calls, []);
    const attached = await observe(route);
    let firstFrame;
    try {
      firstFrame = await attached.next();
      assert.equal(firstFrame?.type, "snapshot");
    } finally {
      await attached.close();
    }
    const reattached = await observe(route);
    try {
      assert.deepEqual(await reattached.next(), firstFrame);
    } finally {
      await reattached.close();
    }
    const retainedIds = final.snapshot.messages.map((message) => message.id);
    const nextDefinition = {
      ...definition,
      expectedVersion: published.version,
      operationId: crypto.randomUUID(),
      model: "fixture/slack-worker",
      instructions:
        "Answer ordinary questions with one brief sentence. PROFILE_NATIVE_V2.",
    };
    const next = await fixture.json(
      `/api/product/agents/${encodeURIComponent(published.agentId)}`,
      metadata.owner.cookie,
      publishedSchema,
      nextDefinition,
      "PUT"
    );
    assert.equal(next.agentId, published.agentId);
    assert.equal(next.version, published.version + 1);
    assert.deepEqual(await open(crypto.randomUUID()), conversation);
    const later = {
      operationId: crypto.randomUUID(),
      text: "Give one ordinary answer about tomorrow. primary-second.",
    };
    await sendMessage(route, later);
    const updated = await waitForFixture(
      () => read(route),
      (view) =>
        !view.snapshot.busy &&
        view.snapshot.agentVersion === next.version &&
        view.snapshot.messages.some(
          (message) => message.role === "user" && message.text === later.text
        )
    );
    assert.deepEqual(updated.snapshot.address, final.snapshot.address);
    assert.deepEqual(
      updated.snapshot.messages
        .slice(0, retainedIds.length)
        .map((message) => message.id),
      retainedIds
    );
    assert.deepEqual(await read(route), updated);
    assert.deepEqual(await read(route), updated);
    const afterPublish = await observed();
    const updatedCalls = afterPublish.model.slice(firstPhysical.model.length);
    assert.equal(updatedCalls.length, 1);
    assert.equal(updatedCalls[0]?.model, "slack-worker");
    assert.ok(
      updatedCalls[0]?.messageTextDigests.includes(inputDigest(later.text))
    );
    assert.ok(
      forbiddenForeground.every(
        (name) => !updatedCalls[0]?.toolNames.includes(name)
      )
    );
    assert.equal(
      await fixture.sql(
        `SELECT count(*) FROM channel_conversation WHERE organization_id=${literal(metadata.agent.organizationId)} AND owner_principal_id=${literal(metadata.agent.principalId)} AND agent_id=${literal(published.agentId)} AND kind='web'`
      ),
      "1"
    );
    const accessRoute = `/api/product/agents/${encodeURIComponent(published.agentId)}/access/${encodeURIComponent(metadata.agent.principalId)}`;
    const changeAccess = (actions: string[]) =>
      fixture.json(
        accessRoute,
        metadata.owner.cookie,
        z.unknown(),
        { operationId: crypto.randomUUID(), actions },
        "PUT"
      );
    await changeAccess(["execute"]);
    try {
      await deniedReads(metadata.owner.cookie);
      await evidence("native-primary-continuity", {
        conversation,
        openOperation,
        published,
        next,
        first,
        replay,
        final,
        retainedIds,
        updated,
        before,
        firstPhysical,
        afterPublish,
      });
    } finally {
      await changeAccess(["read", "execute", "approve"]);
    }
    const exactReplay = await fixture.json(
      `${route}/messages`,
      metadata.owner.cookie,
      receiptSchema,
      input
    );
    assert.equal(exactReplay.receipt.accepted, false);
    assert.equal(exactReplay.receipt.operationId, input.operationId);
    assert.deepEqual(await read(route), updated);
  }
);
