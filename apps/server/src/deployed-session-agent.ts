import { SessionAgent as NativeSessionAgent } from "@cerebro/runtime/session-agent";
import { Effect } from "effect";

import type { WorkerEnv } from "./env.server";
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
}
