import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";

import type { ToolBindings } from "./tool";

const effectRequest = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    hold: z.boolean(),
    invocationId: z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/u),
    mode: z.enum(["idempotent", "non-idempotent"]),
    value: z.literal("approved-fixture"),
  })
  .strict();
const effectResult = z
  .object({
    invocationId: z.string(),
    receipt: z.string(),
    value: z.string(),
  })
  .strict();
export type EffectRequest = z.infer<typeof effectRequest>;
export type EffectResult = z.infer<typeof effectResult>;
interface GatewayBindings {
  FIXTURE_URL: string;
}
const fixtureSecret = "cerebro-local-fixture-secret";
const workerSource = `export default {
  async fetch(request, env) {
    return await env.GATEWAY.fetch(new Request("https://effect-gateway.invalid/effect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await request.text(),
    }));
  },
};`;

export class EffectGateway extends WorkerEntrypoint<GatewayBindings> {
  async fetch(request: Request): Promise<Response> {
    if (
      request.method !== "POST" ||
      new URL(request.url).pathname !== "/effect"
    ) {
      return Response.json({ error: "Unknown effect route" }, { status: 404 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json(
        { error: "Invalid effect request" },
        { status: 400 }
      );
    }
    const parsed = effectRequest.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "Invalid effect request" },
        { status: 400 }
      );
    }
    const response = await fetch(`${this.env.FIXTURE_URL}/effects`, {
      body: JSON.stringify(parsed.data),
      headers: {
        "Content-Type": "application/json",
        "x-fixture-secret": fixtureSecret,
      },
      method: "POST",
      signal: AbortSignal.timeout(14_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return Response.json(
        { error: "Fixture effect rejected" },
        { status: response.status }
      );
    }
    const result = effectResult.safeParse(await response.json());
    if (!result.success) {
      return Response.json(
        { error: "Invalid fixture result" },
        { status: 502 }
      );
    }
    return Response.json(result.data);
  }
}

export const executeFixtureEffect = async (
  env: ToolBindings,
  request: EffectRequest
): Promise<EffectResult> => {
  const parsed = effectRequest.parse(request);
  const worker = env.LOADER.get("cerebro-effect-v1", () => ({
    compatibilityDate: "2026-08-30",
    env: { GATEWAY: env.GATEWAY },
    globalOutbound: null,
    mainModule: "effect.js",
    modules: { "effect.js": workerSource },
  }));
  const response = await worker.getEntrypoint().fetch(
    new Request("https://effect-wrapper.invalid/effect", {
      body: JSON.stringify(parsed),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Fixture effect failed with HTTP ${response.status}`);
  }
  const result = effectResult.parse(await response.json());
  if (
    result.invocationId !== parsed.invocationId ||
    result.value !== parsed.value
  ) {
    throw new Error("Fixture effect result does not match request");
  }
  return result;
};
