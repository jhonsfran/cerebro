import assert from "node:assert/strict";
import { test } from "node:test";

import { defineDoc } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { WorkLedger } from "../../packages/runtime/src/coordinator-ledger.ts";
import { context, setup } from "./coordinator-fixture.ts";

for (const version of [2, 3, 4]) {
  test(`version ${version} bindings retain the primary's native conversation`, async () => {
    const fixture = await setup();
    try {
      const source = fixture.source("a");
      const previous = defineDoc({
        kind: "cerebro.conversation-bindings",
        scope: "session",
        version,
        initial: () => ({
          conversations: {
            [source.address.sessionId]: {
              address: { ...source.address },
              agentVersion: 1,
              nativeId: source.native.id,
              refresh: {
                agentVersion: 2,
                ...(version < 4 ? { policyVersion: 1 } : {}),
              },
              releaseEvent: null,
              ...(version < 4 ? { policyVersion: 1, legacyVersion: null } : {}),
              ...(version === 2 ? { origin: null } : {}),
            },
          },
        }),
      });
      await fixture.pi().commit((tx) => tx.doc(previous), context);
      const saved = await fixture.pi().snapshot(Bindings, context);
      assert.deepEqual(saved?.conversations[source.address.sessionId], {
        address: source.address,
        agentVersion: 1,
        nativeId: source.native.id,
        refresh: { agentVersion: 2 },
      });
      assert.ok(await fixture.pi().conversation(source.native.id, context));
    } finally {
      await fixture.close();
    }
  });
}

test("retired roots do not become active coordinator bindings and their native history remains", async () => {
  const fixture = await setup();
  try {
    const source = fixture.source("a");
    const previous = defineDoc({
      kind: "cerebro.conversation-bindings",
      scope: "session",
      version: 2,
      initial: () => ({
        conversations: {
          [source.address.sessionId]: {
            address: { ...source.address },
            agentVersion: 1,
            nativeId: source.native.id,
            policyVersion: 0,
            legacyVersion: 1,
            refresh: null,
            releaseEvent: null,
            origin: null,
          },
        },
      }),
    });
    await fixture.pi().commit((tx) => tx.doc(previous), context);
    assert.deepEqual(await fixture.pi().snapshot(Bindings, context), {
      conversations: {},
    });
    assert.ok(await fixture.pi().conversation(source.native.id, context));
  } finally {
    await fixture.close();
  }
});

test("version 2 work indexes retain identity, active work, and queued work", async () => {
  const fixture = await setup();
  try {
    const source = fixture.source("a");
    const value = {
      identity: { organizationId: "org-A", ownerPrincipalId: "owner-A" },
      active: {
        running: {
          source: { ...source.address },
          deadlineAt: 1_800_000_600_000,
        },
      },
      queue: [
        {
          workId: "queued",
          source: { ...source.address },
          deadlineAt: 1_800_000_600_000,
        },
      ],
    };
    const previous = defineDoc({
      kind: "cerebro.coordinator-index",
      scope: "session",
      version: 2,
      initial: () => value,
    });
    await fixture.pi().commit((tx) => tx.doc(previous), context);
    assert.deepEqual(await fixture.pi().snapshot(WorkLedger, context), value);
  } finally {
    await fixture.close();
  }
});
