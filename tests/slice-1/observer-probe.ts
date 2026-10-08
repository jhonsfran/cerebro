/* oxlint-disable no-await-in-loop -- Each native subscription must attach and detach before the next cycle. */
import assert from "node:assert/strict";

import { Schema } from "effect";
import { z } from "zod";

import { Observation } from "../../packages/contracts/src/session-service.ts";
import type { applicationFixture } from "./application.ts";
import { waitForFixture } from "./application.ts";

export const probeObservers = async (
  fixture: ReturnType<typeof applicationFixture>,
  cookie: string,
  conversationId: string,
  cycles = 100
) => {
  assert.equal(cycles, 100);
  const count = async () => {
    const result = await fixture.json(
      "/api/fixture/runtime/observers",
      cookie,
      z.object({ observerCount: z.number().int().nonnegative() }),
      { conversationId }
    );
    return result.observerCount;
  };
  assert.equal(await count(), 0);
  const samples: {
    attachedAt: number;
    detachedAt: number;
    epoch: string;
    nativeAttached: number;
    nativeDetached: number;
    startedAt: number;
  }[] = [];
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const response = await fetch(
      `${fixture.boot.apiUrl}/api/product/conversations/${encodeURIComponent(conversationId)}/observations?accessGeneration=${cycle}`,
      {
        headers: { Cookie: cookie, Origin: fixture.boot.webUrl },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      }
    );
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    let buffer = "";
    const decoder = new TextDecoder();
    let epoch = "";
    let attachedAt = 0;
    let nativeAttached = 0;
    try {
      while (!buffer.includes("\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      const frame = Schema.decodeUnknownSync(Observation)(
        JSON.parse(buffer.slice(0, buffer.indexOf("\n")))
      );
      assert.equal(frame.type, "snapshot");
      assert.equal(frame.accessGeneration, cycle);
      ({ epoch } = frame);
      attachedAt = Date.now();
      nativeAttached = await count();
      assert.equal(nativeAttached, 1);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => null);
      reader.releaseLock();
    }
    const nativeDetached = await waitForFixture(
      count,
      (value) => value === 0,
      1500
    );
    samples.push({
      attachedAt,
      detachedAt: Date.now(),
      epoch,
      nativeAttached,
      nativeDetached,
      startedAt,
    });
  }
  assert.equal(new Set(samples.map((sample) => sample.epoch)).size, cycles);
  return {
    attachDetachCycles: cycles,
    liveObserversAfterDetach: await count(),
    samples,
  };
};
