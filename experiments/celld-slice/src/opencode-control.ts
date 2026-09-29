import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";
import { DurableObject } from "cloudflare:workers";

export class OpenCodeControl extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    try {
      const fixture = new URL(request.url).searchParams.get("schema");
      if (fixture === "unknown") {
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS unknown_fixture (id TEXT PRIMARY KEY)"
        );
      } else if (fixture === "partial") {
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS project (id TEXT PRIMARY KEY)"
        );
      } else if (fixture === "similar-agent-prefix") {
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS cf_agents_unknown (id TEXT PRIMARY KEY)"
        );
      } else if (fixture === "similar-cerebro-prefix") {
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS cerebro_unknown (id TEXT PRIMARY KEY)"
        );
      } else if (fixture !== null) {
        return Response.json(
          { error: "Unknown schema fixture", ok: false },
          { status: 400 }
        );
      }
      const tablesBefore = this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        .toArray();
      const client = await OpenCodeWorkerd.create({
        models: { fetch: false },
        storage: this.ctx.storage,
      });
      try {
        const health = await client.health.get();
        return Response.json({ health, ok: true, tablesBefore });
      } finally {
        await client.close();
      }
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error &&
            error.message === "Database is not empty and has no session table"
              ? "Database is not empty and has no session table"
              : "OpenCode control failed",
          ok: false,
          tablesAfter: this.ctx.storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
            )
            .toArray(),
        },
        { status: 500 }
      );
    }
  }
}
