import assert from "node:assert/strict";
import { test } from "node:test";

import { defineDoc } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { context, setup } from "./coordinator-fixture.ts";

test("a persisted v1 binding migrates its exact definition, native identity, and legacy alias provenance", async () => {
  const fixture = await setup();
  try {
    const source = fixture.source("a");
    const legacy = defineDoc({
      kind: "cerebro.conversation-bindings",
      scope: "session",
      version: 1,
      initial: () => ({
        conversations: {
          [source.address.sessionId]: {
            address: { ...source.address },
            agentVersion: 1,
            nativeId: source.native.id,
          },
        },
      }),
    });
    await fixture.pi().commit((tx) => tx.doc(legacy), context);
    await fixture.reopen();
    const stored = await fixture.pi().snapshot(Bindings, context);
    assert.deepEqual(stored?.conversations[source.address.sessionId], {
      address: source.address,
      agentVersion: 1,
      policyVersion: 0,
      nativeId: source.native.id,
      legacyVersion: 1,
      origin: null,
      refresh: null,
      releaseEvent: null,
    });
    assert.equal(fixture.source("a").native.id, source.native.id);
  } finally {
    await fixture.close();
  }
});
