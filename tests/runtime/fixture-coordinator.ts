import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Effect, Schema } from "effect";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import { Denied, InvalidInput } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { ContentDependencies } from "../../packages/contracts/src/session.ts";
import {
  CoordinationProfileSchema,
  SlackThreadSchema,
  TeamReportDeliverySchema,
  workCellName,
} from "../../packages/contracts/src/work.ts";
import type { TeamCommand } from "../../packages/contracts/src/work.ts";
import { createSourceDependencyStore } from "../../packages/runtime/src/content-dependency-store.ts";
import type { MetadataTransaction } from "../../packages/runtime/src/session-agent.ts";
import { SessionAgent } from "./fixture-session.ts";

export class CoordinatorFixture extends SessionAgent {
  protected override resolve(request: Request) {
    if (new URL(request.url).pathname !== "/team-report") {
      return super.resolve(request);
    }
    return Effect.tryPromise({
      try: async () =>
        Schema.decodeUnknownSync(TeamReportDeliverySchema)(
          await request.clone().json()
        ),
      catch: () => new InvalidInput({ reason: "Invalid fixture report." }),
    }).pipe(
      Effect.flatMap((delivery) =>
        super.resolve(
          new Request(request, {
            method: "POST",
            body: JSON.stringify({ address: delivery.sourceEventAddress }),
          })
        )
      )
    );
  }

  protected override configure(
    address: EventAddress,
    metadata: MetadataTransaction,
    importedDependencies: () => Promise<ContentDependencies>
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
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS coordinator_fixture_models (at INTEGER NOT NULL)"
        );
        const recordModel = () =>
          metadata(() => {
            this.ctx.storage.sql.exec(
              "INSERT INTO coordinator_fixture_models VALUES (?)",
              Date.now()
            );
          });
        let goal = "Continue in the background.";
        if (address.conversationId.includes("report-flow")) {
          goal = "report-flow delegate two workers";
        }
        if (address.conversationId.includes("held")) {
          goal = "report-flow hold-model";
        }
        faux.setResponses([
          async () => {
            await recordModel();
            return fauxAssistantMessage(
              fauxToolCall("start_team", {
                goal,
              }),
              { stopReason: "toolUse" }
            );
          },
          async () => {
            await recordModel();
            return fauxAssistantMessage("The coordinator answer is complete.");
          },
        ]);
        const sources = createSourceDependencyStore(
          this.ctx.storage,
          address.sessionId,
          metadata
        );
        const dependencies = async () => {
          const recorded = await contentDependencies();
          const imported = await importedDependencies();
          return {
            sourceIds: [
              ...new Set([...recorded.sourceIds, ...imported.sourceIds]),
            ],
            toolIds: [...new Set([...recorded.toolIds, ...imported.toolIds])],
          };
        };
        return {
          ...configuration,
          authority: {
            evaluate: configuration.authority.evaluate,
            require: (request, options) =>
              Effect.gen({ self: this }, function* currentCoordinatorModel() {
                const enabled = yield* Effect.promise(() =>
                  this.ctx.storage.get<boolean>("coordinator-model-enabled")
                );
                if (request.model && enabled === false) {
                  return yield* Effect.fail(
                    new Denied({
                      code: "revoked",
                      reason: "Coordinator model disabled.",
                    })
                  );
                }
                return yield* configuration.authority.require(request, options);
              }),
          },
          contentDependencies: dependencies,
          checkImportedDependencies: configuration.checkDependencies,
          importDependencies: sources.importDependencies,
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
            contentDependencies: dependencies,
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
              if (address.conversationId.includes("report-flow")) {
                const response = await this.env.TEAM.get(
                  this.env.TEAM.idFromName(workCellName(command.work.key))
                ).fetch("https://team.internal/control", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(command),
                });
                await this.ctx.storage.put("team-receipt", {
                  status: response.status,
                  body: await response.clone().text(),
                });
                if (!response.ok) {
                  throw new Error("Fixture team admission failed.");
                }
              }
            },
          },
        };
      })
    );
  }

  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/model-access") {
      await this.ctx.storage.put("coordinator-model-enabled", false);
      return Response.json({ disabled: true });
    }
    if (new URL(request.url).pathname === "/inspect") {
      return Response.json({
        receipt: (await this.ctx.storage.get("team-receipt")) ?? null,
        models: this.ctx.storage.sql
          .exec("SELECT * FROM coordinator_fixture_models")
          .toArray(),
        notifications: this.ctx.storage.sql
          .exec("SELECT snapshot FROM fixture_notification")
          .toArray(),
        transport: this.ctx.storage.sql
          .exec("SELECT * FROM coordinator_fixture_transport ORDER BY id")
          .toArray(),
      });
    }
    return await super.onRequest(request);
  }
}
