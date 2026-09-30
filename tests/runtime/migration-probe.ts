import { DurableObject } from "cloudflare:workers";

import { id } from "../../packages/contracts/src/identity.ts";
import { SessionLedger } from "../../packages/runtime/src/ledger.ts";
import { createOpenCodeClient } from "../../packages/runtime/src/opencode-adapter.ts";
import {
  DurableOperationJournal,
  durableJournalDatabase,
} from "../../packages/runtime/src/operation-journal.ts";
import type { TestEnvironment } from "./environment.ts";

export class LedgerMigrationProbe extends DurableObject<TestEnvironment> {
  async fetch(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split("/").at(-1);
    if (action === "journal-write" || action === "journal-read") {
      const organizationId = id.organization("journal-company");
      const operationId = id.operation("journal-operation");
      const requestDigest = id.digest("sha256:journal-request");
      const options = {
        deadlineAt: Date.now() + 60_000,
        operationId,
        requestDigest,
      };
      const journal = new DurableOperationJournal<{ count: number }>(
        durableJournalDatabase(this.ctx.storage),
        "native-model"
      );
      if (action === "journal-write") {
        const claim = await journal.claim(
          {
            operationId,
            organizationId,
            request: { model: "controlled" },
            requestDigest,
          },
          options
        );
        if (claim.status !== "ok" || claim.value.state !== "claimed") {
          throw new Error("Native journal claim failed.");
        }
        await journal.dispatch(
          claim.value.claimToken,
          { reservationId: "native-reservation" },
          options
        );
        await journal.recordOutcome(
          claim.value.claimToken,
          { status: "ok", value: { count: 1 } },
          { unit: "credits", units: 3 },
          options
        );
        const client = await createOpenCodeClient(
          this.ctx.storage,
          this.env,
          {
            agentId: id.agent("probe-agent"),
            enabledToolIds: [],
            instructions: "Do nothing.",
            model: "fixture/controlled",
            organizationId,
            version: 1,
          },
          () => Promise.resolve({ content: "" })
        );
        await client.session.create();
        await this.ctx.storage.sync();
        await client.close();
      }
      return Response.json(
        await journal.read(organizationId, operationId, options)
      );
    }
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
