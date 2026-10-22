import { Type } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { Effect } from "effect";
import { z } from "zod";

import { enforceDecision } from "../../packages/contracts/src/authority-service.ts";
import type { AuthorityService } from "../../packages/contracts/src/authority-service.ts";
import type { EventAddress } from "../../packages/contracts/src/events.ts";
import {
  Denied,
  InvalidInput,
  Unavailable,
  failureToHttp,
  toContractFailure,
} from "../../packages/contracts/src/failures.ts";
import type { ContractFailure } from "../../packages/contracts/src/failures.ts";
import {
  id,
  isExecutionContextActiveAt,
} from "../../packages/contracts/src/identity.ts";
import type { ExecutionContext } from "../../packages/contracts/src/identity.ts";
import type { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";
import { createApprovalStore } from "../../packages/runtime/src/approval-store.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { SessionAgent as NativeSessionAgent } from "../../packages/runtime/src/session-agent.ts";
import type {
  MetadataTransaction,
  SessionHostConfiguration,
} from "../../packages/runtime/src/session-agent.ts";
import { createConnectorExecutor } from "../../packages/tools/src/connector.ts";
import {
  bindRegisteredTool,
  createToolRegistry,
} from "../../packages/tools/src/registry.ts";
import type { TestEnvironment } from "./environment.ts";
import { capabilityFixture } from "./fixture-capabilities.ts";
import {
  fixtureAddress,
  forkOrigin,
  requestAddress,
} from "./fixture-contracts.ts";

const ownerContext = (
  address: EventAddress,
  principalId: string
): ExecutionContext => ({
  actor: {
    id: id.principal(principalId),
    kind: "human",
    organizationId: address.organizationId,
    state: "active",
  },
});
const receiptOutput = z.object({
  operationId: z.string(),
  receipt: z.string(),
  value: z.string(),
});
const identityTuple = z.tuple([z.string(), z.string()]);

export class SessionAgent extends NativeSessionAgent<TestEnvironment> {
  private readonly instanceId = crypto.randomUUID();
  private readonly configurations = new Map<string, SessionHostConfiguration>();
  private readonly authorityCallCounts = new Map<string, number>();
  private readonly failingToolChecks = new Set<string>();

  private identity() {
    const [organizationId, principalId] = identityTuple.parse(
      JSON.parse(this.ctx.id.name ?? "null")
    );
    return { organizationId, principalId };
  }

  protected override resolve(
    request: Request
  ): Effect.Effect<
    { address: EventAddress; context: ExecutionContext },
    ContractFailure
  > {
    return Effect.gen({ self: this }, function* resolveFixtureRequest() {
      const address = yield* Effect.tryPromise({
        try: () => requestAddress(request),
        catch: () =>
          new InvalidInput({
            reason: "Fixture request has no valid conversation address.",
          }),
      });
      const identity = this.identity();
      if (
        address.organizationId !== identity.organizationId ||
        request.headers.get("x-fixture-principal") !== identity.principalId
      ) {
        return yield* Effect.fail(
          new Denied({
            code: "unauthorized",
            reason: "Fixture caller is not the identity owner.",
          })
        );
      }
      return { address, context: ownerContext(address, identity.principalId) };
    });
  }

  private nativeStorage(nativeId: string) {
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .toArray()
      .map((row) => row.name);
    if (!tables.includes("pi_tasks") || !tables.includes("pi_submissions")) {
      return { submissions: [], tables, tasks: [] };
    }
    return {
      submissions: this.ctx.storage.sql
        .exec<{
          id: number;
          conversation_id: number;
          request_id: string | null;
          status: string;
        }>(
          "SELECT id, conversation_id, json_extract(record, '$.requestId') AS request_id, status FROM pi_submissions WHERE conversation_id=? ORDER BY id",
          nativeId
        )
        .toArray(),
      tables,
      tasks: this.ctx.storage.sql
        .exec<{
          id: number;
          conversation_id: number;
          kind: string;
          status: string;
          abort_requested: number;
          state: string;
          memos: string | null;
        }>(
          "SELECT id, conversation_id, json_extract(record, '$.kind') AS kind, status, abort_requested, json_extract(record, '$.state') AS state, json_extract(record, '$.memos') AS memos FROM pi_tasks WHERE conversation_id=? ORDER BY id",
          nativeId
        )
        .toArray(),
    };
  }

  private enabled(address: EventAddress): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ enabled: number }>(
        "SELECT enabled FROM fixture_authority WHERE session_id=?",
        address.sessionId
      )
      .toArray();
    return row?.enabled === 1;
  }

  private contentEnabled(address: EventAddress): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ enabled: number }>(
        "SELECT enabled FROM fixture_content_authority WHERE session_id=?",
        address.sessionId
      )
      .toArray();
    return row?.enabled === 1;
  }

  protected override configure(
    address: EventAddress,
    metadata: MetadataTransaction
  ): Effect.Effect<SessionHostConfiguration, ContractFailure> {
    return Effect.gen({ self: this }, function* fixtureComposition() {
      const existing = this.configurations.get(address.sessionId);
      if (existing) {
        if (
          Object.entries(address).some(
            ([key, value]) =>
              existing.address[key as keyof EventAddress] !== value
          )
        ) {
          return yield* Effect.fail(
            new Denied({
              code: "unauthorized",
              reason: "Fixture session address changed.",
            })
          );
        }
        return existing;
      }
      const identity = this.identity();
      if (identity.organizationId !== address.organizationId) {
        return yield* Effect.fail(
          new Denied({
            code: "unauthorized",
            reason: "Fixture identity organization differs.",
          })
        );
      }
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_conversation (session_id TEXT PRIMARY KEY, address TEXT NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_fork_origin (session_id TEXT PRIMARY KEY, origin TEXT NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_content_reference (session_id TEXT NOT NULL, source_session_id TEXT NOT NULL, source_address TEXT NOT NULL, history INTEGER NOT NULL, PRIMARY KEY(session_id, source_session_id))"
      );
      const [originRow] = this.ctx.storage.sql
        .exec<{ origin: string }>(
          "SELECT origin FROM fixture_fork_origin WHERE session_id=?",
          address.sessionId
        )
        .toArray();
      const origin = originRow
        ? forkOrigin.parse(JSON.parse(originRow.origin))
        : undefined;
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_conversation VALUES (?, ?)",
        address.sessionId,
        JSON.stringify(address)
      );
      const [saved] = this.ctx.storage.sql
        .exec<{ address: string }>(
          "SELECT address FROM fixture_conversation WHERE session_id=?",
          address.sessionId
        )
        .toArray();
      const savedAddress = fixtureAddress.parse(
        JSON.parse(saved?.address ?? "null")
      );
      if (
        Object.entries(address).some(
          ([key, value]) => savedAddress[key as keyof EventAddress] !== value
        )
      ) {
        return yield* Effect.fail(
          new Denied({
            code: "unauthorized",
            reason: "Fixture conversation address does not match its record.",
          })
        );
      }
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_authority (session_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_authority VALUES (?, 1)",
        address.sessionId
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_content_authority (session_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_content_authority VALUES (?, 1)",
        address.sessionId
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_tool_dependency_gate (session_id TEXT PRIMARY KEY, armed INTEGER NOT NULL, released INTEGER NOT NULL, waiting INTEGER NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_tool_dependency_gate VALUES (?, 0, 1, 0)",
        address.sessionId
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_commit_failure (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, instance_id TEXT NOT NULL, committed_seq INTEGER NOT NULL, PRIMARY KEY(session_id, operation_id))"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_notification (session_id TEXT NOT NULL, snapshot TEXT NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_model_request (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL)"
      );
      const context = ownerContext(address, identity.principalId);
      const agent = {
        agentId: address.agentId,
        enabledToolIds: address.agentId.includes("no-tools")
          ? []
          : ["fixture_effect"],
        grants: [],
        instructions: `Agent scope ${address.agentId}. Use the fixture_effect tool once for each user input.`,
        model: "fixture/slice-1",
        organizationId: address.organizationId,
        version:
          origin?.agentVersion ?? (address.agentId.endsWith("-v2") ? 2 : 1),
      };
      const authority: AuthorityService = {
        evaluate: (request) => {
          this.authorityCallCounts.set(
            address.sessionId,
            (this.authorityCallCounts.get(address.sessionId) ?? 0) + 1
          );
          if (
            this.failingToolChecks.has(address.sessionId) &&
            request.resource.kind === "tool"
          ) {
            this.failingToolChecks.delete(address.sessionId);
            return Effect.fail(
              new Unavailable({ reason: "Fixture authority is unavailable." })
            );
          }
          return Effect.sync(() =>
            this.enabled(address) &&
            request.context.actor.id === context.actor.id &&
            isExecutionContextActiveAt(
              request.context,
              address.organizationId,
              Date.now()
            )
              ? { decision: "allow" as const, policyVersion: "fixture-v1" }
              : {
                  decision: "deny" as const,
                  policyVersion: "fixture-v1",
                  reason: "Current fixture access denied.",
                }
          );
        },
        require: (request, options) =>
          Effect.flatMap(authority.evaluate(request, options), (decision) =>
            enforceDecision(request, Date.now(), decision)
          ),
      };
      const registry = createToolRegistry(
        [
          {
            definition: {
              connectorId: "fixture",
              effect: "write",
              id: id.tool("fixture_effect"),
              version: "1",
            },
            description: `Apply one controlled fixture write for ${address.agentId}.`,
            input: z.object({ value: z.string() }),
            maxInputBytes: 4096,
            maxOutputBytes: 4096,
            output: receiptOutput,
            requiresApproval: true,
            retryMode: "at-most-once",
            target: {
              kind: "http-write",
              method: "POST",
              url: `${this.env.FIXTURE_URL}/effects`,
            },
          },
        ],
        "local"
      );
      const [entry] = registry.list();
      if (!entry) {
        return yield* Effect.fail(
          new Unavailable({ reason: "Fixture tool is missing." })
        );
      }
      const definition = yield* bindRegisteredTool(entry);
      const approvals = createApprovalStore(
        this.ctx.storage,
        address.sessionId
      );
      // The real connector executor; FAIL_FIRST_EFFECT loses the response after the write.
      const executor = createConnectorExecutor({
        credentials: () =>
          Promise.resolve({
            headers: { Authorization: "Bearer fixture-connector-key" },
            secrets: [],
          }),
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          if (this.env.FAIL_FIRST_EFFECT === "1" && response.ok) {
            await response.text();
            throw new Error("Injected lost write response");
          }
          return response;
        },
        registry,
      });
      const model: Model<"openai-completions"> = {
        api: "openai-completions",
        baseUrl: `${this.env.FIXTURE_URL}/v1`,
        contextWindow: address.agentId.startsWith("cap-") ? 262_144 : 16_384,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "slice-1",
        input: ["text"],
        maxTokens: 256,
        name: "fixture/slice-1",
        provider: "fixture",
        reasoning: false,
      };
      const provider = createProvider({
        api: openAICompletionsApi(),
        auth: {
          apiKey: {
            name: "fixture",
            resolve: () =>
              Promise.resolve({ auth: { apiKey: "fixture-model-key" } }),
          },
        },
        baseUrl: model.baseUrl,
        id: model.provider,
        models: [model],
      });
      const configuration: SessionHostConfiguration = {
        address,
        agent,
        authority,
        ...(origin
          ? {
              origin: {
                ...origin,
                address: {
                  agentId: id.agent(origin.address.agentId),
                  conversationId: id.conversation(
                    origin.address.conversationId
                  ),
                  organizationId: id.organization(
                    origin.address.organizationId
                  ),
                  sessionId: id.session(origin.address.sessionId),
                },
              },
            }
          : {}),
        contentDependencies: () =>
          Promise.resolve({ sourceIds: [], toolIds: [] }),
        inheritDependencies: (source, _toolIds, history) => {
          this.ctx.storage.sql.exec(
            "INSERT INTO fixture_content_reference VALUES (?, ?, ?, ?) ON CONFLICT(session_id, source_session_id) DO UPDATE SET history=MAX(history, excluded.history)",
            address.sessionId,
            source.sessionId,
            JSON.stringify(source),
            history ? 1 : 0
          );
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO fixture_content_reference SELECT ?, source_session_id, source_address, history FROM fixture_content_reference WHERE session_id=?",
            address.sessionId,
            source.sessionId
          );
        },
        checkDependencies: (caller, _dependencies, options) =>
          Effect.flatMap(
            authority.require(
              {
                action: "read",
                address,
                context: caller,
                pinnedAgent: agent,
                resource: {
                  id: address.agentId,
                  kind: "agent",
                  organizationId: address.organizationId,
                },
              },
              options
            ),
            () => {
              const references = this.ctx.storage.sql
                .exec<{ source_address: string; history: number }>(
                  "SELECT source_address, history FROM fixture_content_reference WHERE session_id=?",
                  address.sessionId
                )
                .toArray();
              const permitted = references.every((reference) => {
                const source = fixtureAddress.parse(
                  JSON.parse(reference.source_address)
                );
                const sourceAddress: EventAddress = {
                  agentId: id.agent(source.agentId),
                  conversationId: id.conversation(source.conversationId),
                  organizationId: id.organization(source.organizationId),
                  sessionId: id.session(source.sessionId),
                };
                return (
                  this.contentEnabled(sourceAddress) &&
                  (reference.history === 0 || this.enabled(sourceAddress))
                );
              });
              return this.contentEnabled(address) && permitted
                ? Effect.void
                : Effect.fail(
                    new Denied({
                      code: "unauthorized",
                      reason: "Fixture content access is revoked.",
                    })
                  );
            }
          ),
        executor,
        ...(address.conversationId.startsWith("notify-")
          ? {
              notify: async (snapshot: ChatSnapshot) => {
                await metadata(() => {
                  this.ctx.storage.sql.exec(
                    "INSERT INTO fixture_notification VALUES (?, ?)",
                    address.sessionId,
                    JSON.stringify(snapshot)
                  );
                });
                await this.ctx.storage.sync();
              },
            }
          : {}),
        ownerContext: () => Effect.succeed(context),
        provider: {
          deadlineMs: address.agentId.includes("short-deadline")
            ? 250
            : 300_000,
          fetch: async (input, init) => {
            const nativeId = await this.nativeSession(address);
            const pending = await this.harness.pending({ session: nativeId });
            const active = pending.find(
              (operation) => operation.status === "running"
            );
            if (!active && !address.agentId.startsWith("cap-")) {
              throw new Error("Fixture model call has no native placed input.");
            }
            const operationId =
              active?.operationId ?? `maintenance:${address.sessionId}`;
            await metadata(() => {
              this.ctx.storage.sql.exec(
                "INSERT INTO fixture_model_request VALUES (?, ?, ?)",
                address.sessionId,
                operationId,
                String(init?.body ?? "")
              );
            });
            const headers = new Headers(init?.headers);
            headers.set("x-fixture-request-id", operationId);
            if (address.agentId.startsWith("cap-")) {
              headers.set("x-fixture-capabilities", "1");
              headers.set("x-fixture-public-session", address.sessionId);
            }
            return await fetch(input, { ...init, headers });
          },
          maxInputBytes: address.agentId.includes("small-input")
            ? 256
            : 131_072 * (address.agentId.startsWith("cap-") ? 4 : 1),
          maxResponseBytes: 1_048_576,
          model,
          provider,
        },
        toolDependencies: () =>
          Effect.gen({ self: this }, function* fixtureToolDependencies() {
            const [gate] = this.ctx.storage.sql
              .exec<{ armed: number; released: number; waiting: number }>(
                "SELECT armed, released, waiting FROM fixture_tool_dependency_gate WHERE session_id=?",
                address.sessionId
              )
              .toArray();
            if (
              gate?.armed === 1 &&
              approvals.all().some((approval) => approval.state === "allowed")
            ) {
              yield* Effect.tryPromise({
                catch: () =>
                  new Unavailable({
                    reason: "Fixture dependency gate update failed.",
                  }),
                try: () =>
                  metadata(() => {
                    this.ctx.storage.sql.exec(
                      "UPDATE fixture_tool_dependency_gate SET armed=0, waiting=1 WHERE session_id=?",
                      address.sessionId
                    );
                  }),
              });
              yield* Effect.tryPromise({
                catch: () =>
                  new Unavailable({
                    reason: "Fixture dependency gate flush failed.",
                  }),
                try: () => this.ctx.storage.sync(),
              });
              while (true) {
                const [current] = this.ctx.storage.sql
                  .exec<{ released: number }>(
                    "SELECT released FROM fixture_tool_dependency_gate WHERE session_id=?",
                    address.sessionId
                  )
                  .toArray();
                if (current?.released === 1) {
                  break;
                }
                yield* Effect.sleep(50);
              }
              yield* Effect.tryPromise({
                catch: () =>
                  new Unavailable({
                    reason: "Fixture dependency gate update failed.",
                  }),
                try: () =>
                  metadata(() => {
                    this.ctx.storage.sql.exec(
                      "UPDATE fixture_tool_dependency_gate SET waiting=0 WHERE session_id=?",
                      address.sessionId
                    );
                  }),
              });
            }
            return { sourceIds: [], toolIds: [definition.id] };
          }),
        tools: agent.enabledToolIds.length
          ? [
              {
                definition,
                description: entry.description,
                parameters: Type.Object({ value: Type.String() }),
                requiresApproval: true,
              },
            ]
          : [],
      };
      this.configurations.set(address.sessionId, configuration);
      return configuration;
    });
  }

  private async fixtureTransaction<A>(
    operation: () => A | Promise<A>
  ): Promise<A> {
    const pi = await this.harness.pi();
    return await pi.commit(operation, piContext());
  }

  async onAlarm(): Promise<void> {
    await this.fixtureTransaction(() => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_alarm_evidence (at INTEGER NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO fixture_alarm_evidence VALUES (?)",
        Date.now()
      );
    });
    await this.ctx.storage.sync();
  }

  private async armCommitFailure(
    address: EventAddress,
    operationId: string,
    kind: "submission" | "compaction" = "submission"
  ): Promise<void> {
    const nativeId = await this.nativeSession(address);
    const storage = await this.harness.storage();
    const commit = storage.commit.bind(storage);
    storage.commit = async (writes, context) => {
      const matches = writes.some(
        (write) =>
          ((kind === "submission" &&
            write.type === "submission" &&
            write.value.requestId === operationId) ||
            (kind === "compaction" &&
              write.type === "task" &&
              write.value.kind === "pi.compaction")) &&
          String(write.value.conversationId) === nativeId
      );
      if (!matches) {
        return await commit(writes, context);
      }
      storage.commit = commit;
      const seq = await commit(writes, context);
      this.ctx.storage.sql.exec(
        "INSERT INTO fixture_commit_failure VALUES (?, ?, ?, ?)",
        address.sessionId,
        operationId,
        this.instanceId,
        seq
      );
      await this.ctx.storage.sync();
      throw new Error("Injected lost native commit response");
    };
  }

  private setFailingToolCheck(
    address: EventAddress,
    enabled: boolean | undefined
  ): void {
    if (enabled === undefined) {
      return;
    }
    if (enabled) {
      this.failingToolChecks.add(address.sessionId);
    } else {
      this.failingToolChecks.delete(address.sessionId);
    }
  }

  private async setAccess(
    request: Request,
    path: string,
    configuration: SessionHostConfiguration
  ): Promise<Response> {
    if (
      request.headers.get("x-fixture-principal") !== this.identity().principalId
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "Fixture access control requires its owner.",
      });
    }
    const input = z
      .object({ enabled: z.boolean() })
      .parse(await request.json());
    await this.fixtureTransaction(() => {
      this.ctx.storage.sql.exec(
        path === "/fixture/content-access"
          ? "UPDATE fixture_content_authority SET enabled=? WHERE session_id=?"
          : "UPDATE fixture_authority SET enabled=? WHERE session_id=?",
        input.enabled ? 1 : 0,
        configuration.address.sessionId
      );
    });
    await this.ctx.storage.sync();
    return Response.json({
      status: "ok",
      value: { enabled: input.enabled },
    });
  }

  override async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/fixture/")) {
      return await super.onRequest(request);
    }
    try {
      const address = await requestAddress(request);
      await Effect.runPromise(this.resolve(request));
      if (path.startsWith("/fixture/capabilities/")) {
        return await capabilityFixture(request, path, address, {
          transaction: (operation) => this.fixtureTransaction(operation),
          storage: this.ctx.storage,
          nativeSession: (value) => this.nativeSession(value),
          harness: this.harness,
          jobs: this.lifecycle.jobs,
        });
      }
      const nativeId = await this.nativeSession(address);
      const configuration = this.configurations.get(address.sessionId);
      if (!configuration) {
        throw new Unavailable({
          reason: "Fixture conversation is not configured.",
        });
      }
      if (path === "/fixture/access" || path === "/fixture/content-access") {
        return await this.setAccess(request, path, configuration);
      }
      if (path === "/fixture/fail-commit") {
        const { operationId, kind } = z
          .object({
            operationId: z.string().min(1),
            kind: z.enum(["submission", "compaction"]).optional(),
          })
          .parse(await request.json());
        await this.armCommitFailure(address, operationId, kind);
        return Response.json({
          status: "ok",
          value: { instanceId: this.instanceId },
        });
      }
      if (path === "/fixture/runtime") {
        return Response.json({
          status: "ok",
          value: {
            failures: this.ctx.storage.sql
              .exec<{
                operationId: string;
                instanceId: string;
                committedSeq: number;
              }>(
                "SELECT operation_id AS operationId, instance_id AS instanceId, committed_seq AS committedSeq FROM fixture_commit_failure WHERE session_id=? ORDER BY rowid",
                address.sessionId
              )
              .toArray(),
            instanceId: this.instanceId,
            nativeSessionId: nativeId,
            modelRequests: this.ctx.storage.sql
              .exec<{ operationId: string; body: string }>(
                "SELECT operation_id AS operationId, body FROM fixture_model_request WHERE session_id=? ORDER BY rowid",
                address.sessionId
              )
              .toArray()
              .map((row) => ({
                operationId: row.operationId,
                body: JSON.parse(row.body),
              })),
            notifications: this.ctx.storage.sql
              .exec<{ snapshot: string }>(
                "SELECT snapshot FROM fixture_notification WHERE session_id=? ORDER BY rowid",
                address.sessionId
              )
              .toArray()
              .map((row) => JSON.parse(row.snapshot)),
          },
        });
      }
      if (path === "/fixture/dependency-checkpoint") {
        const input = z
          .object({
            armed: z.boolean().optional(),
            released: z.boolean().optional(),
          })
          .parse(await request.json());
        await this.fixtureTransaction(() => {
          if (input.armed !== undefined) {
            this.ctx.storage.sql.exec(
              "UPDATE fixture_tool_dependency_gate SET armed=?, waiting=0 WHERE session_id=?",
              input.armed ? 1 : 0,
              address.sessionId
            );
          }
          if (input.released !== undefined) {
            this.ctx.storage.sql.exec(
              "UPDATE fixture_tool_dependency_gate SET released=? WHERE session_id=?",
              input.released ? 1 : 0,
              address.sessionId
            );
          }
        });
        await this.ctx.storage.sync();
        const [gate] = this.ctx.storage.sql
          .exec<{ armed: number; released: number; waiting: number }>(
            "SELECT armed, released, waiting FROM fixture_tool_dependency_gate WHERE session_id=?",
            address.sessionId
          )
          .toArray();
        return Response.json({
          status: "ok",
          value: {
            armed: gate?.armed === 1,
            released: gate?.released === 1,
            waiting: gate?.waiting === 1,
          },
        });
      }
      if (path === "/fixture/authority") {
        const input = z
          .object({ failNextToolCheck: z.boolean().optional() })
          .parse(await request.json());
        this.setFailingToolCheck(address, input.failNextToolCheck);
        return Response.json({
          status: "ok",
          value: {
            calls: this.authorityCallCounts.get(address.sessionId) ?? 0,
            failNextToolCheck: this.failingToolChecks.has(address.sessionId),
          },
        });
      }
      if (path === "/fixture/native-storage") {
        return Response.json({
          status: "ok",
          value: this.nativeStorage(nativeId),
        });
      }
      if (path === "/fixture/lifecycle") {
        await this.fixtureTransaction(() => {
          this.ctx.storage.sql.exec(
            "CREATE TABLE IF NOT EXISTS fixture_alarm_evidence (at INTEGER NOT NULL)"
          );
        });
        return Response.json({
          status: "ok",
          value: {
            alarmAt: await this.ctx.storage.getAlarm(),
            alarms: this.ctx.storage.sql
              .exec<{ at: number }>(
                "SELECT at FROM fixture_alarm_evidence ORDER BY at"
              )
              .toArray(),
            jobs: this.ctx.storage.sql
              .exec<{
                id: string;
                capability: string;
                fn: string;
                time: number;
                running: number;
                execution_started_at: number | null;
              }>(
                "SELECT id, capability, fn, time, running, execution_started_at FROM cf_agents_jobs ORDER BY time"
              )
              .toArray(),
            pending: await this.harness.pending({ session: nativeId }),
          },
        });
      }
      throw new InvalidInput({ reason: `Unknown fixture route ${path}` });
    } catch (error) {
      const failure = failureToHttp(toContractFailure(error));
      return Response.json(failure.body, { status: failure.status });
    }
  }
}
