import { DurableObject } from "cloudflare:workers";

import type { WorkerEnv } from "../bindings";

export class SessionAgent extends DurableObject<WorkerEnv> {
  async fetch(): Promise<Response> {
    await this.ctx.storage.deleteAlarm();
    return Response.json(
      { error: "Retired", message: "Start a new conversation." },
      { status: 410 }
    );
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
  }
}
