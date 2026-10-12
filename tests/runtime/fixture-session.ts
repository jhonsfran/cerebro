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
import type { ToolExecutor } from "../../packages/contracts/src/tool-service.ts";
import { createApprovalStore } from "../../packages/runtime/src/approval-store.ts";
import { SessionAgent as NativeSessionAgent } from "../../packages/runtime/src/session-agent.ts";
import type { SessionHostConfiguration } from "../../packages/runtime/src/session-agent.ts";
import { createControlledToolExecutor } from "../../packages/tools/src/broker.ts";
import {
  bindRegisteredTool,
  createToolRegistry,
} from "../../packages/tools/src/registry.ts";
import type { TestEnvironment } from "./environment.ts";

const ownerContext = (address: EventAddress): ExecutionContext => ({
  actor: {
    id: id.principal(`user:${address.organizationId}`),
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
const addressTuple = z.tuple([z.string(), z.string(), z.string(), z.string()]);

export class SessionAgent extends NativeSessionAgent<TestEnvironment> {
  private configuration: SessionHostConfiguration | undefined;

  private nativeStorage() {
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
          "SELECT id, conversation_id, request_id, status FROM pi_submissions ORDER BY id"
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
          "SELECT id, conversation_id, kind, status, abort_requested, json_extract(record, '$.state') AS state, json_extract(record, '$.memos') AS memos FROM pi_tasks ORDER BY id"
        )
        .toArray(),
    };
  }

  private enabled(): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ enabled: number }>(
        "SELECT enabled FROM fixture_authority WHERE id=1"
      )
      .toArray();
    return row?.enabled === 1;
  }

  private contentEnabled(): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ enabled: number }>(
        "SELECT enabled FROM fixture_content_authority WHERE id=1"
      )
      .toArray();
    return row?.enabled === 1;
  }

  protected override configure(): Effect.Effect<
    SessionHostConfiguration,
    ContractFailure
  > {
    return Effect.gen({ self: this }, function* fixtureComposition() {
      if (this.configuration) {
        return this.configuration;
      }
      const tuple = addressTuple.parse(JSON.parse(this.ctx.id.name ?? "null"));
      const address: EventAddress = {
        agentId: id.agent(tuple[1]),
        conversationId: id.conversation(tuple[2]),
        organizationId: id.organization(tuple[0]),
        sessionId: id.session(tuple[3]),
      };
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_authority (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_authority VALUES (1, 1)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_content_authority (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_content_authority VALUES (1, 1)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_tool_dependency_gate (id INTEGER PRIMARY KEY, armed INTEGER NOT NULL, released INTEGER NOT NULL, waiting INTEGER NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_tool_dependency_gate VALUES (1, 0, 1, 0)"
      );
      const context = ownerContext(address);
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS cerebro_session_metadata (id INTEGER PRIMARY KEY, agent_version INTEGER NOT NULL, owner_principal_id TEXT NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_session_metadata VALUES (1, 1, ?)",
        context.actor.id
      );
      const authenticate = (request: Request): Promise<ExecutionContext> =>
        request.headers.get("x-fixture-principal") === context.actor.id &&
        this.enabled()
          ? Promise.resolve(context)
          : Promise.reject(
              new Denied({
                code: "unauthorized",
                reason: "Fixture caller has no current access.",
              })
            );
      const agent = {
        agentId: address.agentId,
        enabledToolIds: ["fixture_effect"],
        grants: [],
        instructions: "Use the fixture_effect tool once for each user input.",
        model: "fixture/slice-1",
        organizationId: address.organizationId,
        version: 1,
      };
      const authority: AuthorityService = {
        evaluate: (request) =>
          Effect.sync(() =>
            this.enabled() &&
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
      const registry = createToolRegistry(
        [
          {
            definition: {
              connectorId: "fixture",
              effect: "write",
              id: id.tool("fixture_effect"),
              version: "1",
            },
            description: "Apply one controlled fixture write.",
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
      const approvals = createApprovalStore(this.ctx.storage);
      const driver: ToolExecutor = {
        execute: (call, _capability, options) =>
          Effect.tryPromise({
            catch: () =>
              new Unavailable({
                reason: "Fixture gateway response unavailable.",
              }),
            try: async (signal) => {
              const response = await this.env.TOOL_GATEWAY.fetch(
                new Request("https://gateway.internal/effect", {
                  body: JSON.stringify({
                    arguments: call.arguments,
                    operationId: options.operationId,
                  }),
                  headers: { "Content-Type": "application/json" },
                  method: "POST",
                  signal,
                })
              );
              if (!response.ok) {
                throw new Error("Fixture gateway did not confirm the write.");
              }
              const output = receiptOutput.parse(await response.json());
              return { output, providerReceipt: output.receipt };
            },
          }),
      };
      const executor = createControlledToolExecutor({
        address,
        approval: (invocation) =>
          Effect.succeed(approvals.permit(invocation.operationId)),
        authority,
        checkApprover: (permit, invocation, options) =>
          Effect.asVoid(
            authority.require(
              {
                action: "approve",
                address,
                context: { actor: { ...context.actor, id: permit.approverId } },
                pinnedAgent: agent,
                resource: {
                  id: invocation.tool.id,
                  kind: "tool",
                  organizationId: address.organizationId,
                },
              },
              options
            )
          ),
        driver,
        pinnedAgent: agent,
        registry,
      });
      const model: Model<"openai-completions"> = {
        api: "openai-completions",
        baseUrl: `${this.env.FIXTURE_URL}/v1`,
        contextWindow: 16_384,
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
      this.configuration = {
        address,
        agent,
        authenticate,
        authority,
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
              this.contentEnabled()
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
          deadlineMs: 300_000,
          fetch: async (input, init) => {
            const pending = await this.harness.pending();
            const active = pending.find(
              (operation) => operation.status === "running"
            );
            if (!active) {
              throw new Error("Fixture model call has no native placed input.");
            }
            const headers = new Headers(init?.headers);
            headers.set("x-fixture-request-id", active.operationId);
            return await fetch(input, { ...init, headers });
          },
          maxInputBytes: 131_072,
          model,
          provider,
        },
        toolDependencies: () =>
          Effect.gen({ self: this }, function* fixtureToolDependencies() {
            const [gate] = this.ctx.storage.sql
              .exec<{ armed: number; released: number; waiting: number }>(
                "SELECT armed, released, waiting FROM fixture_tool_dependency_gate WHERE id=1"
              )
              .toArray();
            if (
              gate?.armed === 1 &&
              approvals.all().some((approval) => approval.state === "allowed")
            ) {
              this.ctx.storage.sql.exec(
                "UPDATE fixture_tool_dependency_gate SET armed=0, waiting=1 WHERE id=1"
              );
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
                    "SELECT released FROM fixture_tool_dependency_gate WHERE id=1"
                  )
                  .toArray();
                if (current?.released === 1) {
                  break;
                }
                yield* Effect.sleep(50);
              }
              this.ctx.storage.sql.exec(
                "UPDATE fixture_tool_dependency_gate SET waiting=0 WHERE id=1"
              );
            }
            return { sourceIds: [], toolIds: [definition.id] };
          }),
        tools: [
          {
            definition,
            description: entry.description,
            parameters: Type.Object({ value: Type.String() }),
            requiresApproval: true,
          },
        ],
      };
      return this.configuration;
    });
  }

  onAlarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixture_alarm_evidence (at INTEGER NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO fixture_alarm_evidence VALUES (?)",
      Date.now()
    );
    return this.ctx.storage.sync();
  }

  override async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/fixture/")) {
      return await super.onRequest(request);
    }
    try {
      const configuration = await Effect.runPromise(this.configure());
      if (path === "/fixture/access" || path === "/fixture/content-access") {
        if (
          request.headers.get("x-fixture-principal") !==
          ownerContext(configuration.address).actor.id
        ) {
          throw new Denied({
            code: "unauthorized",
            reason: "Fixture access control requires its owner.",
          });
        }
        const input = z
          .object({ enabled: z.boolean() })
          .parse(await request.json());
        this.ctx.storage.sql.exec(
          path === "/fixture/content-access"
            ? "UPDATE fixture_content_authority SET enabled=? WHERE id=1"
            : "UPDATE fixture_authority SET enabled=? WHERE id=1",
          input.enabled ? 1 : 0
        );
        await this.ctx.storage.sync();
        return Response.json({
          status: "ok",
          value: { enabled: input.enabled },
        });
      }
      await configuration.authenticate(request);
      if (path === "/fixture/dependency-checkpoint") {
        const input = z
          .object({
            armed: z.boolean().optional(),
            released: z.boolean().optional(),
          })
          .parse(await request.json());
        if (input.armed !== undefined) {
          this.ctx.storage.sql.exec(
            "UPDATE fixture_tool_dependency_gate SET armed=?, waiting=0 WHERE id=1",
            input.armed ? 1 : 0
          );
        }
        if (input.released !== undefined) {
          this.ctx.storage.sql.exec(
            "UPDATE fixture_tool_dependency_gate SET released=? WHERE id=1",
            input.released ? 1 : 0
          );
        }
        await this.ctx.storage.sync();
        const [gate] = this.ctx.storage.sql
          .exec<{ armed: number; released: number; waiting: number }>(
            "SELECT armed, released, waiting FROM fixture_tool_dependency_gate WHERE id=1"
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
      if (path === "/fixture/native-storage") {
        return Response.json({ status: "ok", value: this.nativeStorage() });
      }
      if (path === "/fixture/lifecycle") {
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS fixture_alarm_evidence (at INTEGER NOT NULL)"
        );
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
            pending: await this.harness.pending(),
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
