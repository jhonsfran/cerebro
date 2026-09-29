import { WorkerEntrypoint } from "cloudflare:workers";

import type { TestEnvironment } from "./environment.ts";

export class FixtureEffectGateway extends WorkerEntrypoint<TestEnvironment> {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path.startsWith("/effect/")) {
      return await fetch(
        `${this.env.FIXTURE_URL}/effects/${path.slice("/effect/".length)}`
      );
    }
    if (request.method !== "POST" || path !== "/effect") {
      return new Response(null, { status: 404 });
    }
    const body = await request.text();
    const response = await fetch(`${this.env.FIXTURE_URL}/effects`, {
      body,
      headers: {
        "Content-Type": "application/json",
        "x-fixture-secret": "cerebro-local-fixture-secret",
      },
      method: "POST",
    });
    if (this.env.FAIL_FIRST_EFFECT === "1" && response.ok) {
      const input: unknown = JSON.parse(body);
      if (
        input &&
        typeof input === "object" &&
        "invocationId" in input &&
        typeof input.invocationId === "string"
      ) {
        const state = await fetch(
          `${this.env.FIXTURE_URL}/effects/${encodeURIComponent(input.invocationId)}`
        );
        const record: unknown = await state.json();
        if (
          record &&
          typeof record === "object" &&
          "calls" in record &&
          record.calls === 1
        ) {
          return new Response("Injected response failure", { status: 503 });
        }
      }
    }
    return response;
  }
}
