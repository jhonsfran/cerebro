import type { StoredRun } from "@cerebro/runtime/ledger";
import type { RuntimePorts } from "@cerebro/runtime/runtime-ports";
import { SessionAgent as NativeSessionAgent } from "@cerebro/runtime/session-agent";

import type { WorkerEnv } from "./env.server";
import { createRuntimeComposition } from "./runtime-composition";
import { runtimeConfiguration } from "./runtime-services";

export class SessionAgent extends NativeSessionAgent {
  private readonly runtimeEnv: WorkerEnv;
  constructor(state: DurableObjectState, env: WorkerEnv) {
    super(state, env);
    this.runtimeEnv = env;
  }
  protected override createRuntime(run: StoredRun): Promise<RuntimePorts> {
    return createRuntimeComposition(
      this.runtimeEnv,
      this.ctx.storage,
      this.storage(),
      run
    );
  }
  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/ready") {
      runtimeConfiguration(this.runtimeEnv);
      this.storage();
      return Response.json({ ok: true });
    }
    return await super.onRequest(request);
  }
}
