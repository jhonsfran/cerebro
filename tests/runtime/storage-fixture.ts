import { openPiSessionStore } from "agents/harness/pi";
import { DurableObject } from "cloudflare:workers";

import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import type { TestEnvironment } from "./environment.ts";
import { storageConformanceCases } from "./storage-conformance.ts";

export class StorageConformance extends DurableObject<TestEnvironment> {
  override async fetch(): Promise<Response> {
    let caseIndex = 0;
    const cases = storageConformanceCases(async (use) => {
      const storage = await openPiSessionStore(this.ctx.storage, {
        prefix: `conformance_${caseIndex}_`,
      });
      caseIndex += 1;
      try {
        await use(storage);
      } finally {
        await storage.close(piContext());
      }
    });
    const passed: string[] = [];
    for (const testCase of cases) {
      // oxlint-disable-next-line no-await-in-loop -- Cases share one Durable Object storage connection.
      await testCase.run();
      passed.push(testCase.name);
    }
    return Response.json({ passed });
  }
}
