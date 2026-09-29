import { drainChannelWork } from "@cerebro/channels/drain";

import { createChannelOptions } from "./channel-services";
import type { WorkerEnv } from "./env.server";

const DRAIN_INTERVAL_MS = 5000;

export class ChannelDispatcher {
  private readonly state: DurableObjectState;
  private readonly env: WorkerEnv;

  constructor(state: DurableObjectState, env: WorkerEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(): Promise<Response> {
    if (this.env.DEPLOY_MODE !== "fixture") {
      return Response.json({ code: "UNAVAILABLE" }, { status: 503 });
    }
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + DRAIN_INTERVAL_MS);
    }
    return Response.json({ scheduled: true });
  }

  async alarm(): Promise<void> {
    if (this.env.DEPLOY_MODE !== "fixture") {
      return;
    }
    await this.state.storage.setAlarm(Date.now() + DRAIN_INTERVAL_MS);
    try {
      await drainChannelWork(createChannelOptions(this.env));
      await this.state.storage.put("lastDrainAt", Date.now());
    } catch {
      await this.state.storage.put("lastFailureAt", Date.now());
    }
  }
}
