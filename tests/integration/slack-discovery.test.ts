import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Schema } from "effect";

import {
  authenticateIdentityRequest,
  signIdentityRequest,
} from "../../apps/server/src/session/proof.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { SlackThreadSchema } from "../../packages/contracts/src/work.ts";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  createRegistry,
  Harness,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { NodeSqliteDatabase } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { SqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/storage.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { createCoordinatorEvents } from "../../packages/runtime/src/coordinator-events.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";

test("authenticated fresh-identity discovery needs no default bot, source scope, or configured model", async () => {
  const context = piContext();
  const storage = await SqliteStorage.open(
    new NodeSqliteDatabase(new DatabaseSync(":memory:"))
  );
  const pi = await Harness.open(
    storage,
    {
      models: createModels(),
      registry: createRegistry(),
      settings: { extensions: [] },
    },
    context
  );
  let sourceOpens = 0;
  try {
    const events = createCoordinatorEvents({
      pi,
      targetIn: () =>
        Promise.reject(new Error("There is no default bot binding.")),
      resolve: () => {
        sourceOpens += 1;
        return Promise.reject(
          new Error("There is no configured default model.")
        );
      },
      scan: () => Promise.resolve({ keys: [] }),
      waitUntil: () => {
        throw new Error("A read must create no progress task.");
      },
    });
    const identity = {
      organizationId: id.organization("fresh-org"),
      ownerPrincipalId: id.principal("fresh-owner"),
    };
    const caller = {
      actor: {
        id: identity.ownerPrincipalId,
        organizationId: identity.organizationId,
        kind: "human" as const,
        state: "active" as const,
      },
    };
    const body = JSON.stringify({
      thread: {
        workspaceId: "workspace-A",
        channelId: "D-A",
        rootTimestamp: "1800000000.000001",
      },
    });
    const secret = "synthetic-private-discovery-key-0000000001";
    const proof = await signIdentityRequest(identity, caller, body, secret);
    const request = new Request("https://session.internal/slack-targets", {
      method: "POST",
      body,
      headers: { "x-cerebro-identity-proof": proof },
    });
    const authenticated = await authenticateIdentityRequest(
      request,
      secret,
      identity
    );
    const input = Schema.decodeUnknownSync(
      Schema.Struct({ thread: SlackThreadSchema }),
      { onExcessProperty: "error" }
    )(await request.json());
    assert.deepEqual(
      await events.listSubscribedBotSources(input.thread, authenticated),
      []
    );
    assert.equal(sourceOpens, 0);
    assert.equal(await pi.snapshot(Bindings, context), undefined);
    const conversations = await pi.commit(
      (tx) => tx.scanConversations({}, 64),
      context
    );
    assert.equal(conversations.items.length, 0);
  } finally {
    await pi.close(context);
  }
});
