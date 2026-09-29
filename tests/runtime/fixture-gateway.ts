import { WorkerEntrypoint } from "cloudflare:workers";

import type { TestEnvironment } from "./environment.ts";

export class FixtureEffectGateway extends WorkerEntrypoint<TestEnvironment> {
  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/effect"
    ) {
      return new Response(null, { status: 404 });
    }
    return await fetch(`${this.env.FIXTURE_URL}/effects`, {
      body: await request.text(),
      headers: {
        "Content-Type": "application/json",
        "x-fixture-secret": "cerebro-local-fixture-secret",
      },
      method: "POST",
    });
  }
}
