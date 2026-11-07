import assert from "node:assert/strict";
import { test } from "node:test";

import { defineDoc } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { context, setup } from "./coordinator-fixture.ts";

test("a persisted binding from an older version is rejected instead of migrated", async () => {
  const fixture = await setup();
  try {
    const older = defineDoc({
      kind: "cerebro.conversation-bindings",
      scope: "session",
      version: 1,
      initial: () => ({ conversations: {} }),
    });
    await fixture.pi().commit((tx) => tx.doc(older), context);
    await assert.rejects(
      fixture.pi().snapshot(Bindings, context),
      /Unsupported conversation bindings version\./u
    );
  } finally {
    await fixture.close();
  }
});
