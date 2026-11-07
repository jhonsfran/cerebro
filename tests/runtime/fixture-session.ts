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
import type { ToolExecutor } from "../../packages/contracts/src/tool-service.ts";
import { sendToAuditSink } from "../../packages/runtime/src/audit-sink.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { SessionAgent as NativeSessionAgent } from "../../packages/runtime/src/session-agent.ts";
import type {
  MetadataTransaction,
  SessionHostConfiguration,
} from "../../packages/runtime/src/session-agent.ts";
import type { TestEnvironment } from "./environment.ts";
import { capabilityFixture } from "./fixture-capabilities.ts";
import { fixtureAddress, requestAddress } from "./fixture-contracts.ts";
import {
  commitFailures,
  matchCommittedInput,
  physicalInput,
  readInputCorrelation,
} from "./fixture-input.ts";

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
const identityTuple = z.tuple([z.string(), z.string()]);

export class SessionAgent extends NativeSessionAgent<TestEnvironment> {
  private readonly instanceId = crypto.randomUUID();
  private readonly configurations = new Map<string, SessionHostConfiguration>();

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
        "CREATE TABLE IF NOT EXISTS fixture_commit_failure (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, instance_id TEXT NOT NULL, committed_seq INTEGER NOT NULL, PRIMARY KEY(session_id, operation_id))"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_commit_witness (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id, operation_id))"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_model_request (session_id TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL)"
      );
      const context = ownerContext(address, identity.principalId);
      const agent = {
        agentId: address.agentId,
        enabledToolIds: [],
        grants: [],
        instructions: `Agent scope ${address.agentId}.`,
        model: "fixture/slice-1",
        organizationId: address.organizationId,
        version: address.agentId.endsWith("-v2") ? 2 : 1,
      };
      const authority: AuthorityService = {
        evaluate: (request) =>
          Effect.sync(() =>
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
          ),
        require: (request, options) =>
          Effect.flatMap(authority.evaluate(request, options), (decision) =>
            enforceDecision(request, Date.now(), decision)
          ),
      };
      const executor: ToolExecutor = {
        execute: () =>
          Effect.fail(
            new Unavailable({
              reason: "The fixture registers no connector tools.",
            })
          ),
      };
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
        audit: sendToAuditSink(this.env.AUDIT_SINK),
        authority,
        contentDependencies: () =>
          Promise.resolve({ sourceIds: [], toolIds: [] }),
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
            () =>
              this.contentEnabled(address)
                ? Effect.void
                : Effect.fail(
                    new Denied({
                      code: "unauthorized",
                      reason: "Fixture content access is revoked.",
                    })
                  )
          ),
        executor,
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
            headers.set(
              "x-fixture-input",
              JSON.stringify(
                await physicalInput(
                  await this.harness.pi(),
                  {
                    address,
                    ownerPrincipalId: context.actor.id,
                    nativeSessionId: nativeId,
                  },
                  active?.operationId,
                  this.instanceId
                )
              )
            );
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
        toolDependencies: () => Effect.succeed({ sourceIds: [], toolIds: [] }),
        tools: [],
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
      const matched = matchCommittedInput(writes, nativeId, operationId, kind);
      if (!matched) {
        return await commit(writes, context);
      }
      storage.commit = commit;
      const seq = await commit(writes, context);
      if (!(seq > 0)) {
        throw new Error(
          "The injected fixture commit has no positive sequence."
        );
      }
      this.ctx.storage.sql.exec(
        "INSERT INTO fixture_commit_failure VALUES (?, ?, ?, ?)",
        address.sessionId,
        operationId,
        this.instanceId,
        seq
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO fixture_commit_witness VALUES (?, ?, ?)",
        address.sessionId,
        operationId,
        JSON.stringify({
          ...matched,
          address,
          nativeSessionId: nativeId,
          at: Date.now(),
        })
      );
      await this.ctx.storage.sync();
      throw new Error("Injected lost native commit response");
    };
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
        return await capabilityFixture(path, address, {
          transaction: (operation) => this.fixtureTransaction(operation),
          storage: this.ctx.storage,
          nativeSession: (value) => this.nativeSession(value),
          harness: this.harness,
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
      if (path === "/fixture/input-correlation") {
        const { operationId, text } = z
          .object({ operationId: z.string().min(1), text: z.string() })
          .parse(await request.json());
        return Response.json({
          status: "ok",
          value: await readInputCorrelation(
            await this.harness.pi(),
            {
              address,
              ownerPrincipalId: id.principal(this.identity().principalId),
              nativeSessionId: nativeId,
            },
            operationId,
            text
          ),
        });
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
            failures: commitFailures(this.ctx.storage, address.sessionId),
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
