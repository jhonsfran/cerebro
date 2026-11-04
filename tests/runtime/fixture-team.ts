import {
  Type,
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { Effect, Schema } from "effect";

import { createAgentAuthority } from "../../packages/authorization/src/agent-authority.ts";
import { prepareTeamReport } from "../../packages/channels/src/team-reports.ts";
import { enforceDecision } from "../../packages/contracts/src/authority-service.ts";
import type { AuthorityService } from "../../packages/contracts/src/authority-service.ts";
import { Denied, Unavailable } from "../../packages/contracts/src/failures.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import type { AgentDefinition } from "../../packages/contracts/src/session.ts";
import type {
  TeamReportDelivery,
  WorkReport,
  WorkAdmission,
} from "../../packages/contracts/src/work.ts";
import {
  BoundedContentDependenciesSchema,
  TeamCommandSchema,
  workCellName,
} from "../../packages/contracts/src/work.ts";
import type { ConversationId } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { createSourceDependencyStore } from "../../packages/runtime/src/content-dependency-store.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import type { MetadataTransaction } from "../../packages/runtime/src/session-agent.ts";
import { TeamAgent } from "../../packages/runtime/src/team-agent.ts";
import { TeamReportOutbox } from "../../packages/runtime/src/team-report-outbox.ts";
import type { TeamRoleConfiguration } from "../../packages/runtime/src/team-role.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";
import type { TestEnvironment } from "./environment.ts";

export class TeamFixture extends TeamAgent<TestEnvironment> {
  private readonly instanceId = crypto.randomUUID();
  private activeWork: WorkAdmission | undefined;
  private readonly modelHolds = new Map<string, () => void>();

  protected override reportTransport(work: WorkAdmission) {
    return {
      prepare: (report: WorkReport) => prepareTeamReport(work, report),
      send: async (delivery: TeamReportDelivery) => {
        if (work.goal.includes("report-flow")) {
          const response = await this.env.COORDINATOR.get(
            this.env.COORDINATOR.idFromName(
              JSON.stringify([
                work.key.organizationId,
                work.key.ownerPrincipalId,
              ])
            )
          ).fetch("https://source.internal/team-report", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-fixture-principal": work.key.ownerPrincipalId,
            },
            body: JSON.stringify(delivery),
          });
          if (!response.ok) {
            throw new Error("Fixture report admission failed.");
          }
        }
        await this.ctx.storage.put("fixture-report", {
          delivery,
          at: Date.now(),
        });
      },
    };
  }
  protected override reportFailure(error: unknown): void {
    console.error("TEAM_FIXTURE_FAILURE", this.ctx.id.name, error);
  }

  protected override async resolve(request: Request) {
    const command = Schema.decodeUnknownSync(TeamCommandSchema, {
      onExcessProperty: "error",
    })(await request.json());
    if (this.ctx.id.name !== workCellName(command.work.key)) {
      throw new Denied({ code: "unauthorized", reason: "Wrong team fixture." });
    }
    return command;
  }

  protected override async configure(
    work: WorkAdmission,
    metadata: MetadataTransaction
  ): Promise<readonly TeamRoleConfiguration[]> {
    this.activeWork = work;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS team_fixture_flags (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS team_fixture_io (kind TEXT NOT NULL, role TEXT NOT NULL, at INTEGER NOT NULL, body TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO team_fixture_flags VALUES ('source', 1)"
    );
    if (work.goal.includes("config-unavailable")) {
      const [opened] = this.ctx.storage.sql
        .exec("SELECT name FROM team_fixture_flags WHERE name='opened-once'")
        .toArray();
      if (opened) {
        throw new Unavailable({
          reason: "Fixture role configuration is unavailable.",
        });
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO team_fixture_flags VALUES ('opened-once', 1)"
      );
    }
    const pins = [
      work.lead,
      ...Array.from({ length: work.limits.maxWorkers }, () => work.worker),
    ];
    const readTool = {
      id: id.tool("team_read"),
      connectorId: "team-fixture",
      version: "1",
      effect: "read" as const,
      connectorFingerprint: id.digest("fixture-read"),
    };
    const writeTool = {
      ...readTool,
      id: id.tool("team_write"),
      effect: "write" as const,
    };
    return await Promise.all(
      pins.map((pin, index): TeamRoleConfiguration => {
        const role = index === 0 ? "lead" : `worker-${index}`;
        const address = {
          organizationId: work.key.organizationId,
          agentId: pin.agentId,
          conversationId: id.conversation(`team-${role}`),
          sessionId: id.session(`team-${role}`),
        };
        const context = {
          actor: {
            id: work.key.ownerPrincipalId,
            kind: "human" as const,
            organizationId: work.key.organizationId,
            state: "active" as const,
          },
        };
        let memoryIds = ["source-A", "source-B"];
        if (index > 0 && work.goal.includes("worker-narrow")) {
          memoryIds = [];
        } else if (index === 0 && work.goal.includes("lead-narrow")) {
          memoryIds = ["source-A"];
        }
        const agent: AgentDefinition = {
          agentId: pin.agentId,
          organizationId: work.key.organizationId,
          version: pin.agentVersion,
          enabledToolIds: [readTool.id, writeTool.id],
          instructions: `Published ${role} version ${pin.agentVersion}.`,
          model: `model-${index === 0 ? "lead" : "worker"}-v${pin.agentVersion}`,
          grants: [
            ...memoryIds.map((sourceId) => ({
              action: "read" as const,
              resource: {
                kind: "memory" as const,
                id: sourceId,
                organizationId: work.key.organizationId,
              },
            })),
            ...[readTool, writeTool].flatMap((tool) =>
              ["read", "execute"].map((action) => ({
                action,
                resource: {
                  kind: "tool" as const,
                  id: tool.id,
                  organizationId: work.key.organizationId,
                },
              }))
            ),
            {
              action: "execute",
              resource: {
                kind: "tool",
                id: readTool.connectorId,
                organizationId: work.key.organizationId,
              },
            },
          ],
        };
        const enabled = () =>
          this.ctx.storage.sql
            .exec<{ enabled: number }>(
              "SELECT enabled FROM team_fixture_flags WHERE name='source'"
            )
            .toArray()[0]?.enabled === 1;
        const current: AuthorityService = {
          evaluate: () =>
            Effect.succeed({ decision: "allow", policyVersion: "current" }),
          require: (request, options) =>
            current
              .evaluate(request, options)
              .pipe(
                Effect.flatMap((decision) =>
                  enforceDecision(request, Date.now(), decision)
                )
              ),
        };
        const authority = createAgentAuthority({
          current,
          enabledModels: [agent.model],
          tools: [readTool, writeTool],
          entitlements: {
            check: () =>
              Promise.resolve({ status: "ok", value: { decision: "allow" } }),
          },
          checkSession: () =>
            enabled()
              ? Effect.void
              : Effect.fail(
                  new Denied({ code: "revoked", reason: "Source revoked." })
                ),
        });
        const sources = createSourceDependencyStore(
          this.ctx.storage,
          address.sessionId,
          metadata,
          true
        );
        const dependencies = async () => ({
          sourceIds: await sources.all(),
          toolIds: await sources.tools(),
        });
        const record = (kind: string, body: unknown) =>
          metadata(() => {
            this.ctx.storage.sql.exec(
              "INSERT INTO team_fixture_io VALUES (?, ?, ?, ?)",
              kind,
              role,
              Date.now(),
              JSON.stringify(body)
            );
          });
        const faux = fauxProvider({
          provider: "shared-physical-provider",
          models: [{ id: agent.model }],
        });
        const physical = faux.provider;
        const provider = {
          ...physical,
          streamSimple: (
            model: Parameters<typeof physical.streamSimple>[0],
            transcript: Parameters<typeof physical.streamSimple>[1],
            options?: Parameters<typeof physical.streamSimple>[2]
          ) => {
            const stream = createAssistantMessageEventStream();
            const pump = async () => {
              try {
                if (!options?.fetch) {
                  throw new Error("The guarded fetch is missing.");
                }
                await options.fetch("https://fixture.invalid/model", {
                  method: "POST",
                  body: JSON.stringify({
                    model: model.id,
                    messages: transcript.messages,
                    tools: transcript.tools,
                  }),
                  signal: options.signal,
                });
                if (work.goal.includes("retry-loop")) {
                  await options.fetch("https://fixture.invalid/model-retry", {
                    method: "POST",
                    body: "{}",
                    signal: options.signal,
                  });
                }
                const toolResults = transcript.messages.filter(
                  (message) => message.role === "toolResult"
                );
                let answer = fauxAssistantMessage(`Answer from ${role}.`);
                if (
                  index === 0 &&
                  work.goal.includes("delegate") &&
                  toolResults.length === 0
                ) {
                  answer = fauxAssistantMessage(
                    [
                      fauxToolCall(
                        "delegate_worker",
                        { text: "Worker question one." },
                        { id: "worker-one" }
                      ),
                      fauxToolCall(
                        "delegate_worker",
                        { text: "Worker question two." },
                        { id: "worker-two" }
                      ),
                    ],
                    { stopReason: "toolUse" }
                  );
                }
                if (
                  work.goal.includes("retry-loop") ||
                  ((work.goal.includes("hold-tool") ||
                    work.goal.includes("hold-for-revoke")) &&
                    toolResults.length === 0) ||
                  (index > 0 && toolResults.length === 0)
                ) {
                  answer = fauxAssistantMessage(
                    fauxToolCall(
                      "team_read",
                      {},
                      { id: `read-${toolResults.length}` }
                    ),
                    { stopReason: "toolUse" }
                  );
                }
                if (
                  work.goal.includes("tool-fanout") &&
                  toolResults.length === 0
                ) {
                  answer = fauxAssistantMessage(
                    Array.from({ length: 61 }, (_, callIndex) =>
                      fauxToolCall(
                        "team_read",
                        {},
                        { id: `fanout-${callIndex}` }
                      )
                    ),
                    { stopReason: "toolUse" }
                  );
                }
                faux.setResponses([answer]);
                const source = physical.streamSimple(
                  model,
                  transcript,
                  options
                );
                for await (const event of source) {
                  stream.push(event);
                }
                stream.end(await source.result());
              } catch {
                const error = fauxAssistantMessage("", { stopReason: "error" });
                stream.push({ type: "error", reason: "error", error });
                stream.end(error);
              }
            };
            void pump();
            return stream;
          },
        };
        return {
          address,
          agent,
          authority,
          ownerContext: () => Effect.succeed(context),
          audit: () => Effect.void,
          contentDependencies: dependencies,
          importDependencies: sources.importDependencies,
          checkDependencies: (owner, requested, options) =>
            Effect.gen(function* checkRoleDependencies() {
              const saved = yield* Effect.tryPromise({
                catch: () =>
                  new Unavailable({ reason: "Dependencies unavailable." }),
                try: dependencies,
              });
              const combined = Schema.decodeUnknownSync(
                BoundedContentDependenciesSchema
              )({
                sourceIds: [
                  ...new Set([...saved.sourceIds, ...requested.sourceIds]),
                ],
                toolIds: [...new Set([...saved.toolIds, ...requested.toolIds])],
              });
              yield* Effect.all(
                combined.sourceIds.map((sourceId) =>
                  authority.require(
                    {
                      action: "read",
                      address,
                      context: owner,
                      pinnedAgent: agent,
                      resource: {
                        kind: "memory",
                        id: sourceId,
                        organizationId: work.key.organizationId,
                      },
                    },
                    options
                  )
                )
              );
              yield* Effect.all(
                combined.toolIds.map((toolId) =>
                  authority.require(
                    {
                      action: "read",
                      address,
                      context: owner,
                      pinnedAgent: agent,
                      tool: readTool,
                      resource: {
                        kind: "tool",
                        id: toolId,
                        organizationId: work.key.organizationId,
                      },
                    },
                    options
                  )
                )
              );
            }),
          provider: {
            model: faux.getModel(),
            provider,
            maxInputBytes: 200_000,
            maxResponseBytes: 200_000,
            deadlineMs: 30_000,
            fetch: async (_input, init) => {
              await record("model", {
                body: init?.body,
                instanceId: this.instanceId,
              });
              if (work.goal.includes("hold-model")) {
                const signal = init?.signal;
                const blocked = Promise.withResolvers<boolean>();
                const abort = async () => {
                  await record("model-aborted", {});
                  blocked.reject(new Error("Aborted"));
                };
                if (signal?.aborted) {
                  void abort();
                } else {
                  signal?.addEventListener(
                    "abort",
                    () => {
                      void abort();
                    },
                    { once: true }
                  );
                }
                await blocked.promise;
              }
              if (work.goal.includes("hold-for-revoke")) {
                const blocked = Promise.withResolvers<boolean>();
                this.modelHolds.set(role, () => blocked.resolve(true));
                await blocked.promise;
              }
              return new Response("model fixture");
            },
          },
          toolDependencies: () =>
            Effect.tryPromise({
              catch: () =>
                new Unavailable({ reason: "Tool provenance unavailable." }),
              try: async () => {
                const sourceIds = index > 0 ? [id.source("source-B")] : [];
                await metadata(() =>
                  sources.importDependencies({
                    sourceIds,
                    toolIds: [readTool.id],
                  })
                );
                return { sourceIds, toolIds: [readTool.id] };
              },
            }),
          tools: [
            {
              definition: readTool,
              description: "Read fixture data.",
              parameters: Type.Object({}),
              idempotent: true,
            },
            {
              definition: writeTool,
              description: "Must be unavailable.",
              parameters: Type.Object({}),
              requiresApproval: true,
            },
          ],
          executor: {
            execute: (_call, options) =>
              Effect.tryPromise({
                catch: () =>
                  new Unavailable({ reason: "Fixture tool unavailable." }),
                try: async () => {
                  await record("tool", { deadlineAt: options.deadlineAt });
                  if (work.goal.includes("hold-tool")) {
                    const blocked = Promise.withResolvers<boolean>();
                    const abort = async () => {
                      await record("tool-aborted", {});
                      blocked.reject(new Error("Aborted tool"));
                    };
                    if (options.signal?.aborted) {
                      void abort();
                    } else {
                      options.signal?.addEventListener(
                        "abort",
                        () => {
                          void abort();
                        },
                        { once: true }
                      );
                    }
                    await blocked.promise;
                  }
                  return {
                    output:
                      index > 0 ? "Private worker source-B." : "Lead source-A.",
                  };
                },
              }),
          },
        };
      })
    );
  }

  protected override async submit(
    nativeId: ConversationId,
    text: string,
    operationId: string
  ): Promise<unknown> {
    if (this.activeWork?.goal.includes("pause-admission")) {
      const [paused] = this.ctx.storage.sql
        .exec(
          "SELECT name FROM team_fixture_flags WHERE name='admission-paused'"
        )
        .toArray();
      if (!paused) {
        this.ctx.storage.sql.exec(
          "INSERT INTO team_fixture_flags VALUES ('admission-paused', 1)"
        );
        await this.ctx.storage.sync();
        await Promise.withResolvers<boolean>().promise;
      }
    }
    return await super.submit(nativeId, text, operationId);
  }

  override async onRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/published") {
      return Response.json(
        (await this.ctx.storage.get("fixture-report")) ?? null
      );
    }

    const path = new URL(request.url).pathname;
    if (path === "/inspect") {
      const pi = await this.harness.pi();
      const outbox = await pi.snapshot(TeamReportOutbox, piContext());
      return Response.json({
        outbox,
        reportTask: outbox?.taskId
          ? await pi.getTask(outbox.taskId, piContext())
          : null,
        state: await pi.snapshot(TeamState, piContext()),
        io: this.ctx.storage.sql
          .exec("SELECT * FROM team_fixture_io ORDER BY rowid")
          .toArray(),
        approvals:
          this.ctx.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM cerebro_approval"
            )
            .toArray()[0]?.count ?? 0,
      });
    }
    if (path === "/revoke") {
      this.ctx.storage.sql.exec(
        "UPDATE team_fixture_flags SET enabled=0 WHERE name='source'"
      );
      return Response.json({ ok: true });
    }
    if (path === "/release") {
      for (const release of this.modelHolds.values()) {
        release();
      }
      this.modelHolds.clear();
      return Response.json({ ok: true });
    }
    return await super.onRequest(request);
  }
}
