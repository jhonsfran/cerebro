import { SessionAgent as NativeSessionAgent } from "@cerebro/runtime/session-agent";
import { Effect } from "effect";
import { z } from "zod";

import type { WorkerEnv } from "./env.server";
import { readFixtureMetrics } from "./fixture-metrics";
import {
  createRuntimeComposition,
  resolveSessionAddress,
} from "./runtime-composition";

export class SessionAgent extends NativeSessionAgent<WorkerEnv> {
  protected override configure() {
    return Effect.flatMap(
      resolveSessionAddress(this.env, this.ctx.id.name),
      (address) => createRuntimeComposition(this.env, this.ctx.storage, address)
    );
  }

  override async onRequest(request: Request): Promise<Response> {
    const diagnostics =
      this.env.DEPLOY_MODE === "fixture" &&
      new URL(request.url).pathname === "/inspect" &&
      z.object({ fixtureDiagnostics: z.literal("observers") }).safeParse(
        await request
          .clone()
          .json()
          .catch(() => null)
      ).success;
    const response = await super.onRequest(request);
    if (!diagnostics || !response.ok) {
      return response;
    }
    return Response.json({
      ...z.record(z.string(), z.unknown()).parse(await response.json()),
      diagnostics: {
        adapterMeasurements: readFixtureMetrics(this.ctx.storage),
        observerCount: await this.observerCount(),
      },
    });
  }
}
