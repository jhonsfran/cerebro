import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Effect, Schema } from "effect";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import { InvalidInput } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import {
  CoordinationProfileSchema,
  SlackThreadSchema,
} from "../../packages/contracts/src/work.ts";
import type { TeamCommand } from "../../packages/contracts/src/work.ts";
import type { MetadataTransaction } from "../../packages/runtime/src/session-agent.ts";
import { SessionAgent } from "./fixture-session.ts";

export class CoordinatorFixture extends SessionAgent {
  protected override configure(
    address: EventAddress,
    metadata: MetadataTransaction
  ) {
    return super.configure(address, metadata).pipe(
      Effect.map((configuration) => {
        const { contentDependencies } = configuration;
        if (!contentDependencies) {
          throw new InvalidInput({
            reason: "The fixture source dependency port is missing.",
          });
        }
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS coordinator_fixture_transport (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, command TEXT NOT NULL)"
        );
        const faux = fauxProvider({
          provider: configuration.provider.model.provider,
          models: [{ id: configuration.provider.model.id }],
        });
        faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall("start_team", { goal: "Continue in the background." }),
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage("The coordinator answer is complete."),
        ]);
        return {
          ...configuration,
          provider: {
            ...configuration.provider,
            provider: faux.provider,
            model: faux.getModel(),
          },
          coordination: {
            ownerPrincipalId: id.principal(`user:${address.organizationId}`),
            thread: Schema.decodeUnknownSync(SlackThreadSchema)({
              channelId: "D-source",
              workspaceId: "T-source",
              rootTimestamp: "1800000000.000001",
            }),
            profile: Schema.decodeUnknownSync(CoordinationProfileSchema)({
              leadAgentId: "lead",
              workerAgentId: "worker",
            }),
            contentDependencies,
            resolveRolePins: () =>
              Promise.resolve({
                lead: { agentId: id.agent("lead"), agentVersion: 1 },
                worker: { agentId: id.agent("worker"), agentVersion: 1 },
              }),
            sendCommand: async (command: TeamCommand) => {
              const count = await metadata(() => {
                this.ctx.storage.sql.exec(
                  "INSERT INTO coordinator_fixture_transport(at, command) VALUES (?, ?)",
                  Date.now(),
                  JSON.stringify(command)
                );
                return this.ctx.storage.sql
                  .exec<{ count: number }>(
                    "SELECT COUNT(*) AS count FROM coordinator_fixture_transport"
                  )
                  .toArray()[0]?.count;
              });
              if (count === 1) {
                throw new Error("The first queue attempt failed.");
              }
            },
          },
        };
      })
    );
  }

  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/inspect") {
      return Response.json({
        transport: this.ctx.storage.sql
          .exec("SELECT * FROM coordinator_fixture_transport ORDER BY id")
          .toArray(),
      });
    }
    return await super.onRequest(request);
  }
}
