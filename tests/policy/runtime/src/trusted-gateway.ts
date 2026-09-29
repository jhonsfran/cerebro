import { WorkerEntrypoint } from "cloudflare:workers";

import { gatewayObject } from "./shared.ts";
import type { Environment } from "./shared.ts";

export class TrustedGateway extends WorkerEntrypoint<Environment> {
  async fetch(request: Request): Promise<Response> {
    return await gatewayObject(this.env).fetch(request);
  }
}
