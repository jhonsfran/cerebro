import { DurableObject } from "cloudflare:workers";

import { SessionLedger } from "../../packages/runtime/src/ledger.ts";
import type { TestEnvironment } from "./environment.ts";

export class LedgerMigrationProbe extends DurableObject<TestEnvironment> {
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split("/").at(-1);
    if (action === "seed") {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS cerebro_session (key TEXT PRIMARY KEY, session_id TEXT NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS cerebro_operation (id TEXT PRIMARY KEY, result TEXT)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_session (key, session_id) VALUES ('opencode', 'legacy-session')"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_operation (id, result) VALUES ('legacy-operation', 'legacy-result')"
      );
      await this.ctx.storage.sync();
      return Response.json({ seeded: true });
    }
    if (action === "upgrade") {
      const ledger = new SessionLedger(this.ctx.storage);
      if (ledger.stream("0").length !== 0) {
        throw new Error("Legacy data became a stream event");
      }
      const session = this.ctx.storage.sql
        .exec<{ session_id: string }>(
          "SELECT session_id FROM cerebro_session WHERE key = 'opencode'"
        )
        .one();
      const operation = this.ctx.storage.sql
        .exec<{ result: string }>(
          "SELECT result FROM cerebro_operation WHERE id = 'legacy-operation'"
        )
        .one();
      const version = this.ctx.storage.sql
        .exec<{ session_id: string }>(
          "SELECT session_id FROM cerebro_session WHERE key = 'schema-version'"
        )
        .one();
      return Response.json({
        result: operation.result,
        sessionId: session.session_id,
        version: version.session_id,
      });
    }
    return new Response(null, { status: 404 });
  }
}
