import { WorkerEntrypoint } from "cloudflare:workers";

import type { TestEnvironment } from "./environment.ts";

export class FixtureEffectGateway extends WorkerEntrypoint<TestEnvironment> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/effect") {
      return await fetch(`${this.env.FIXTURE_URL}/effects${url.search}`);
    }
    if (request.method !== "POST" || url.pathname !== "/effect") {
      return new Response(null, { status: 404 });
    }
    const response = await fetch(`${this.env.FIXTURE_URL}/effects`, {
      body: await request.text(),
      headers: {
        Authorization: "Bearer fixture-connector-key",
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: request.signal,
    });
    if (this.env.FAIL_FIRST_EFFECT === "1" && response.ok) {
      await response.text();
      return new Response("Injected lost write response", { status: 503 });
    }
    return response;
  }
}
