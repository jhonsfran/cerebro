import assert from "node:assert/strict";
import { test } from "node:test";

import { defineDoc } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { context, setup } from "./coordinator-fixture.ts";

test("a bindings document saved under an older version is rejected instead of migrated", async () => {
  const fixture = await setup();
  try {
    const source = fixture.source("a");
    const previous = defineDoc({
      kind: "cerebro.conversation-bindings",
      scope: "session",
      version: 4,
      initial: () => ({
        conversations: {
          [source.address.sessionId]: {
            address: { ...source.address },
            agentVersion: 1,
            nativeId: source.native.id,
            refresh: null,
          },
        },
      }),
    });
    await fixture.pi().commit((tx) => tx.doc(previous), context);
    await assert.rejects(
      fixture.pi().snapshot(Bindings, context),
      /Unsupported conversation bindings version/u
    );
  } finally {
    await fixture.close();
  }
});
