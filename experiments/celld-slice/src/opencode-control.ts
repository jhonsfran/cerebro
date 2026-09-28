import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";
import { DurableObject } from "cloudflare:workers";

export class OpenCodeControl extends DurableObject {
  private client: Promise<OpenCodeWorkerd.Interface> | undefined;

  async fetch(): Promise<Response> {
    try {
      const tablesBefore = this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        .toArray();
      this.client ??= OpenCodeWorkerd.create({
        models: { fetch: false },
        storage: this.ctx.storage,
      });
      const client = await this.client;
      const health = await client.health.get();
      return Response.json({ health, ok: true, tablesBefore });
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
        },
        { status: 500 }
      );
    }
  }
}
