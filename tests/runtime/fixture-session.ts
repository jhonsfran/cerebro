import { Type } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { ToolTask } from "@earendil-works/pi-durable";
import { Effect, Result, Schema } from "effect";
import { z } from "zod";

import { enforceDecision } from "../../packages/contracts/src/authority-service.ts";
import type { AuthorityService } from "../../packages/contracts/src/authority-service.ts";
import type { EventAddress } from "../../packages/contracts/src/events.ts";
import type { DurableHandoff } from "../../packages/contracts/src/execution.ts";
import {
  Conflict,
  Denied,
  InvalidInput,
  Unavailable,
  failureToHttp,
} from "../../packages/contracts/src/failures.ts";
import type { ContractFailure } from "../../packages/contracts/src/failures.ts";
import {
  id,
  isExecutionContextActiveAt,
} from "../../packages/contracts/src/identity.ts";
import type { ExecutionContext } from "../../packages/contracts/src/identity.ts";
import { ToolReceiptStore } from "../../packages/contracts/src/receipt-service.ts";
import { DomainSnapshot } from "../../packages/contracts/src/session-service.ts";
import type {
  BoundApproval,
  ToolExecutor,
} from "../../packages/contracts/src/tool-service.ts";
import { createCelldToolReceiptStore } from "../../packages/runtime/src/celld-tool-receipts.ts";
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
const checkpointControl = z.object({
  action: z.enum(["fail", "delay"]),
  boundary: z.enum([
    "after-admission",
    "before-approval",
    "before-engine-submission",
    "before-projection",
  ]),
  delayMs: z.number().int().min(0).max(10_000).optional(),
  failureTag: z.enum(["Denied", "Conflict"]).optional(),
});
const fixtureInput = z.object({
  checkpoint: checkpointControl.nullable().optional(),
  enabled: z.boolean().optional(),
  operationId: z.string().optional(),
  replacementOperationId: z.string().optional(),
});

export class SessionAgent extends NativeSessionAgent<TestEnvironment> {
  private configuration: SessionHostConfiguration | undefined;
  private traceInstalled = false;
  private readonly tracedHarnesses = new WeakSet<object>();

  private trace(phase: string, status: string, value?: unknown): void {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixture_native_trace (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, phase TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO fixture_native_trace (at, phase, status, value) VALUES (?, ?, ?, ?)",
      Date.now(),
      phase,
      status,
      JSON.stringify(value ?? null)
    );
  }

  private async traced<A>(phase: string, run: () => Promise<A>): Promise<A> {
    this.trace(phase, "start");
    try {
      const value = await run();
      this.trace(phase, "return");
      return value;
    } catch (error) {
      this.trace(phase, "error", String(error));
      throw error;
    }
  }

  private installTrace(): void {
    if (this.traceInstalled || this.env.TRACE_NATIVE !== "1") {
      return;
    }
    this.traceInstalled = true;
    // Each TRACE_NATIVE fixture uses one session in its disposable Worker.
    const callPhase = ToolTask.definition.phases.call;
    const executePhase = ToolTask.definition.phases.execute;
    const abortPhase = ToolTask.definition.abort;
    const instrumentTool = (runtime: Parameters<typeof callPhase>[1]) => {
      const agent = runtime.agent.bind(runtime);
      runtime.agent = async (...args) => {
        const value = await agent(...args);
        return {
          ...value,
          tools: value.tools.map((tool) => {
            const execute = tool.execute.bind(tool);
            return {
              ...tool,
              execute: async (...toolArgs: Parameters<typeof execute>) => {
                this.trace("native.tool.execute", "start", {
                  contextAborted: toolArgs[2].abortSignal?.aborted,
                  taskAborted: runtime.signal.aborted,
                  taskId: runtime.taskId,
                });
                try {
                  const result = await execute(...toolArgs);
                  this.trace("native.tool.execute", "return", {
                    contextAborted: toolArgs[2].abortSignal?.aborted,
                    isError: result.isError,
                    taskAborted: runtime.signal.aborted,
                    taskId: runtime.taskId,
                    terminate: result.control?.terminate,
                  });
                  return result;
                } catch (error) {
                  this.trace("native.tool.execute", "error", {
                    contextAborted: toolArgs[2].abortSignal?.aborted,
                    error: String(error),
                    taskAborted: runtime.signal.aborted,
                    taskId: runtime.taskId,
                  });
                  throw error;
                }
              },
            };
          }),
        };
      };
    };
    const tracedCall: typeof callPhase = async (...args) => {
      instrumentTool(args[1]);
      return await this.traced("native.tool.phase.call", () =>
        callPhase(...args)
      );
    };
    const tracedExecute: typeof executePhase = async (...args) => {
      instrumentTool(args[1]);
      return await this.traced("native.tool.phase.execute", () =>
        executePhase(...args)
      );
    };
    Object.defineProperty(ToolTask.definition.phases, "call", {
      value: tracedCall,
    });
    Object.defineProperty(ToolTask.definition.phases, "execute", {
      value: tracedExecute,
    });
    Object.defineProperty(ToolTask.definition, "abort", {
      value: (...args: Parameters<typeof abortPhase>) =>
        this.traced("native.tool.phase.abort", () => abortPhase(...args)),
    });
    const sync = this.ctx.storage.sync.bind(this.ctx.storage);
    this.ctx.storage.sync = (...args) =>
      this.traced("storage.sync", async () => {
        const value = await sync(...args);
        this.trace("native.storage", "observed", this.nativeStorage());
        return value;
      });
    const session = this.harness.session.bind(this.harness);
    this.harness.session = (...args) => {
      const value = session(...args);
      const abort = value.abort.bind(value);
      const wait = value.wait.bind(value);
      const events = value.events.bind(value);
      value.abort = (...abortArgs) =>
        this.traced("native.abort", () => abort(...abortArgs));
      value.wait = (...waitArgs) =>
        this.traced("native.wait", () => wait(...waitArgs));
      value.events = (...eventArgs) =>
        this.traced("native.events", async () => {
          const stream = await events(...eventArgs);
          this.trace("native.snapshot", "observed", {
            inbox: stream.snapshot.inbox,
            run: stream.snapshot.run,
            tools: stream.snapshot.tools.map((tool) => ({
              callId: tool.callId,
              name: tool.name,
              status: tool.status,
              taskId: tool.taskId,
            })),
          });
          const start = stream.start.bind(stream);
          stream.start = (listener) =>
            start(async (batch, context) => {
              this.trace(
                "native.events.batch",
                "observed",
                batch.map((event) => event.type)
              );
              await listener(batch, context);
            });
          return stream;
        });
      return value;
    };
    const pi = this.harness.pi.bind(this.harness);
    this.harness.pi = (...args) =>
      this.traced("native.pi", async () => {
        const value = await pi(...args);
        if (!this.tracedHarnesses.has(value)) {
          this.tracedHarnesses.add(value);
          const abortTask = value.abortTask.bind(value);
          const waitForTask = value.waitForTask.bind(value);
          value.abortTask = (...taskArgs) =>
            this.traced("native.abortTask", () => abortTask(...taskArgs));
          value.waitForTask = (...taskArgs) =>
            this.traced("native.waitForTask", () => waitForTask(...taskArgs));
        }
        return value;
      });
  }

  private nativeStorage() {
    const tables = this.ctx.storage.sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pi_tasks', 'pi_submissions')"
      )
      .toArray();
    if (tables.length !== 2) {
      return { submissions: [], tasks: [] };
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
      tasks: this.ctx.storage.sql
        .exec<{
          id: number;
          conversation_id: number;
          kind: string;
          status: string;
          abort_requested: number;
          state: string;
        }>(
          "SELECT id, conversation_id, kind, status, abort_requested, json_extract(record, '$.state') AS state FROM pi_tasks ORDER BY id"
        )
        .toArray(),
    };
  }

  private domain(): DomainSnapshot | undefined {
    const [row] = this.ctx.storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM cerebro_pi_session WHERE id=1"
      )
      .toArray();
    return row
      ? Schema.decodeUnknownSync(DomainSnapshot)(JSON.parse(row.state).snapshot)
      : undefined;
  }

  private handoffs(): readonly DurableHandoff[] {
    const [row] = this.ctx.storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM cerebro_pi_session WHERE id=1"
      )
      .toArray();
    if (!row) {
      return [];
    }
    // These records are the production SessionStore's persisted handoffs.
    return (
      JSON.parse(row.state) as { readonly handoffs: readonly DurableHandoff[] }
    ).handoffs;
  }

  private enabled(): boolean {
    const [row] = this.ctx.storage.sql
      .exec<{ enabled: number }>(
        "SELECT enabled FROM fixture_authority WHERE id=1"
      )
      .toArray();
    return row?.enabled === 1;
  }

  private checkpointState(
    control: z.infer<typeof checkpointControl> | null | undefined
  ) {
    return Effect.gen({ self: this }, function* checkpointState() {
      if (control !== undefined) {
        this.ctx.storage.sql.exec(
          "UPDATE fixture_checkpoint SET control=? WHERE id=1",
          control === null ? null : JSON.stringify(control)
        );
        yield* Effect.tryPromise({
          catch: () =>
            new Unavailable({ reason: "Fixture checkpoint flush failed" }),
          try: () => this.ctx.storage.sync(),
        });
      }
      const [row] = this.ctx.storage.sql
        .exec<{ control: string | null }>(
          "SELECT control FROM fixture_checkpoint WHERE id=1"
        )
        .toArray();
      return {
        control: row?.control
          ? checkpointControl.parse(JSON.parse(row.control))
          : null,
        observations: this.ctx.storage.sql
          .exec<{
            at: number;
            boundary: string;
            operation_id: string;
            status: string;
          }>(
            "SELECT at, boundary, operation_id, status FROM fixture_checkpoint_observation ORDER BY seq"
          )
          .toArray(),
      };
    });
  }

  protected override configure(): Effect.Effect<
    SessionHostConfiguration,
    ContractFailure
  > {
    return Effect.gen({ self: this }, function* configureFixture() {
      this.installTrace();
      if (this.configuration) {
        return this.configuration;
      }
      const tuple = yield* Effect.try({
        catch: () =>
          new InvalidInput({ reason: "Invalid fixture session identity" }),
        try: () => addressTuple.parse(JSON.parse(this.ctx.id.name ?? "null")),
      });
      const address: EventAddress = {
        agentId: id.agent(tuple[1]),
        conversationId: id.conversation(tuple[2]),
        organizationId: id.organization(tuple[0]),
        sessionId: id.session(tuple[3]),
      };
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_authority (id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL, evidence INTEGER NOT NULL)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_authority VALUES (1, 1, 1)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_checkpoint (id INTEGER PRIMARY KEY, control TEXT)"
      );
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_checkpoint VALUES (1, NULL)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_checkpoint_observation (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, boundary TEXT NOT NULL, operation_id TEXT NOT NULL, status TEXT NOT NULL)"
      );
      const context = ownerContext(address);
      const authenticate = (request: Request) =>
        request.headers.get("x-fixture-principal") === context.actor.id &&
        this.enabled()
          ? Effect.succeed(context)
          : Effect.fail(
              new Denied({
                code: "unauthorized",
                reason: "Fixture caller has no current access",
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
                  reason: "Current fixture access denied",
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
            retryMode: "reconcile-only",
            target: {
              kind: "fixture-write",
              method: "POST",
              url: `${this.env.FIXTURE_URL}/effects`,
            },
          },
        ],
        "fixture"
      );
      const [entry] = registry.list();
      if (!entry) {
        return yield* Effect.fail(
          new Unavailable({ reason: "Fixture tool is missing" })
        );
      }
      const definition = yield* bindRegisteredTool(entry);
      const receipts = yield* ToolReceiptStore.pipe(
        Effect.provide(
          createCelldToolReceiptStore(this.ctx.storage, {
            address,
            authorize: (receipt, caller, options) =>
              Effect.asVoid(
                authority.require(
                  {
                    action: "read",
                    address,
                    context: caller,
                    pinnedAgent: agent,
                    resource: {
                      id: receipt.intent.invocation.tool.id,
                      kind: "tool",
                      organizationId: address.organizationId,
                    },
                    tool: receipt.intent.invocation.tool,
                  },
                  options
                )
              ),
          }).layer
        )
      );
      const approval = (operationId: string): BoundApproval | undefined =>
        this.handoffs()
          .flatMap((handoff) => handoff.approvals)
          .find((value) => value.operationId === operationId);
      const dispatch = (operationId: string, args?: unknown) =>
        Effect.tryPromise({
          catch: () =>
            new Unavailable({ reason: "Fixture gateway response unavailable" }),
          try: async (signal) => {
            const response = await this.env.TOOL_GATEWAY.fetch(
              new Request(
                args === undefined
                  ? `https://gateway.internal/effect?operationId=${encodeURIComponent(operationId)}`
                  : "https://gateway.internal/effect",
                args === undefined
                  ? { signal }
                  : {
                      body: JSON.stringify({ arguments: args, operationId }),
                      headers: { "Content-Type": "application/json" },
                      method: "POST",
                      signal,
                    }
              )
            );
            if (!response.ok) {
              throw new Error("Fixture gateway has no confirmed receipt");
            }
            const output = receiptOutput.parse(await response.json());
            return { output, providerReceipt: output.receipt };
          },
        });
      const driver: ToolExecutor = {
        execute: (call, _capability, options) =>
          dispatch(options.operationId, call.arguments),
        reconcile: (operationId) =>
          Effect.suspend(() => {
            const [row] = this.ctx.storage.sql
              .exec<{ evidence: number }>(
                "SELECT evidence FROM fixture_authority WHERE id=1"
              )
              .toArray();
            return row?.evidence === 1
              ? dispatch(operationId)
              : Effect.fail(
                  new Unavailable({
                    reason: "Injected fixture provider evidence outage",
                  })
                );
          }),
      };
      const executor = createControlledToolExecutor({
        address,
        approval: (invocation) =>
          Effect.succeed(approval(invocation.operationId)),
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
        receipts,
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
          Effect.asVoid(
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
            )
          ),
        checkpoint: (boundary, operationId) =>
          Effect.gen({ self: this }, function* fixtureCheckpoint() {
            const [row] = this.ctx.storage.sql
              .exec<{ control: string | null }>(
                "SELECT control FROM fixture_checkpoint WHERE id=1"
              )
              .toArray();
            if (!row?.control) {
              return;
            }
            const control = checkpointControl.parse(JSON.parse(row.control));
            if (control.boundary !== boundary) {
              return;
            }
            this.ctx.storage.sql.exec(
              "UPDATE fixture_checkpoint SET control=NULL WHERE id=1"
            );
            this.ctx.storage.sql.exec(
              "INSERT INTO fixture_checkpoint_observation (at, boundary, operation_id, status) VALUES (?, ?, ?, 'entered')",
              Date.now(),
              boundary,
              operationId
            );
            yield* Effect.tryPromise({
              catch: () =>
                new Unavailable({ reason: "Fixture checkpoint flush failed" }),
              try: () => this.ctx.storage.sync(),
            });
            if (control.action === "delay") {
              yield* Effect.sleep(control.delayMs ?? 0);
            }
            this.ctx.storage.sql.exec(
              "INSERT INTO fixture_checkpoint_observation (at, boundary, operation_id, status) VALUES (?, ?, ?, ?)",
              Date.now(),
              boundary,
              operationId,
              control.action === "fail" ? "failed" : "returned"
            );
            yield* Effect.tryPromise({
              catch: () =>
                new Unavailable({ reason: "Fixture checkpoint flush failed" }),
              try: () => this.ctx.storage.sync(),
            });
            if (control.action === "fail") {
              const reason = `Injected fixture checkpoint failure at ${boundary}`;
              if (control.failureTag === "Denied") {
                return yield* Effect.fail(
                  new Denied({ code: "revoked", reason })
                );
              }
              if (control.failureTag === "Conflict") {
                return yield* Effect.fail(
                  new Conflict({ code: "already-final", reason })
                );
              }
              return yield* Effect.fail(new Unavailable({ reason }));
            }
          }),
        content: () =>
          Effect.succeed({
            citations: [],
            dependencies: { sourceIds: [], toolIds: [definition.id] },
          }),
        executor,
        provider: {
          deadlineMs: 300_000,
          fetch: async (input, init) => {
            const active = this.handoffs().find((handoff) =>
              ["queued", "running", "waiting-for-approval"].includes(
                handoff.run.state
              )
            );
            if (!active) {
              throw new Error("Fixture model call has no persisted active run");
            }
            const headers = new Headers(init?.headers);
            headers.set("x-fixture-request-id", active.run.runId);
            headers.set("x-fixture-tool", "fixture_effect");
            return await fetch(input, { ...init, headers });
          },
          maxInputBytes: 131_072,
          model,
          provider,
        },
        receipts,
        toolDependencies: () =>
          Effect.succeed({ sourceIds: [], toolIds: [definition.id] }),
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

  async onAlarm(): Promise<void> {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS fixture_alarm_evidence (at INTEGER NOT NULL)"
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO fixture_alarm_evidence VALUES (?)",
      Date.now()
    );
    await this.ctx.storage.sync();
  }

  override async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/fixture/")) {
      return this.env.TRACE_NATIVE === "1"
        ? await this.traced(
            `host${path}`,
            async () => await super.onRequest(request)
          )
        : await super.onRequest(request);
    }
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen({ self: this }, function* fixtureRoute() {
          const configuration = yield* this.configure();
          const input = yield* Effect.tryPromise({
            catch: () =>
              new InvalidInput({ reason: "Invalid fixture command" }),
            try: async () => fixtureInput.parse(await request.json()),
          });
          if (
            (path === "/fixture/access" || path === "/fixture/evidence") &&
            input.enabled !== undefined
          ) {
            if (
              request.headers.get("x-fixture-principal") !==
              ownerContext(configuration.address).actor.id
            ) {
              return yield* Effect.fail(
                new Denied({
                  code: "unauthorized",
                  reason: "Fixture access control requires its owner",
                })
              );
            }
            this.ctx.storage.sql.exec(
              path === "/fixture/access"
                ? "UPDATE fixture_authority SET enabled=? WHERE id=1"
                : "UPDATE fixture_authority SET evidence=? WHERE id=1",
              input.enabled ? 1 : 0
            );
            yield* Effect.tryPromise({
              catch: () =>
                new Unavailable({ reason: "Fixture access flush failed" }),
              try: () => this.ctx.storage.sync(),
            });
            return { enabled: input.enabled };
          }
          const caller = yield* configuration.authenticate(request);

          if (path === "/fixture/checkpoint") {
            return yield* this.checkpointState(input.checkpoint);
          }

          if (path === "/fixture/trace") {
            this.trace("fixture.read", "start");
            return this.ctx.storage.sql
              .exec<{
                seq: number;
                at: number;
                phase: string;
                status: string;
                value: string;
              }>(
                "SELECT seq, at, phase, status, value FROM fixture_native_trace ORDER BY seq"
              )
              .toArray();
          }
          if (path === "/fixture/native-storage") {
            return this.nativeStorage();
          }
          if (path === "/fixture/lifecycle") {
            this.ctx.storage.sql.exec(
              "CREATE TABLE IF NOT EXISTS fixture_alarm_evidence (at INTEGER NOT NULL)"
            );
            return {
              alarmAt: yield* Effect.tryPromise({
                catch: () =>
                  new Unavailable({
                    reason: "Fixture alarm metadata unavailable",
                  }),
                try: () => this.ctx.storage.getAlarm(),
              }),
              alarms: this.ctx.storage.sql
                .exec<{ at: number }>(
                  "SELECT at FROM fixture_alarm_evidence ORDER BY at"
                )
                .toArray(),
              firstProjectionFailure: yield* Effect.tryPromise({
                catch: () =>
                  new Unavailable({
                    reason: "Fixture first projection diagnostic unavailable",
                  }),
                try: () => this.firstProjectionFailure(),
              }),
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
              pending: yield* Effect.tryPromise({
                catch: (error) =>
                  new Unavailable({
                    reason: `Fixture native pending metadata unavailable: ${String(error)}`,
                  }),
                try: () => this.harness.pending(),
              }),
              projectionFailure: yield* Effect.tryPromise({
                catch: () =>
                  new Unavailable({
                    reason: "Fixture projection diagnostic unavailable",
                  }),
                try: () => this.projectionFailure(),
              }),
              snapshot: this.domain(),
            };
          }

          if (!input.operationId) {
            return yield* Effect.fail(
              new InvalidInput({
                reason: "Fixture receipt requires operation identity",
              })
            );
          }
          const options = { deadlineAt: Date.now() + 30_000 };
          const receipt = yield* configuration.receipts.read(
            {
              operationId: id.operation(input.operationId),
              organizationId: configuration.address.organizationId,
            },
            caller,
            options
          );
          if (path === "/fixture/replay" || path === "/fixture/occurrence") {
            const { invocation, policyVersion } = receipt.intent;
            const operationId = input.replacementOperationId
              ? id.operation(input.replacementOperationId)
              : invocation.operationId;
            const deadlineAt = Date.now() + 30_000;
            return yield* configuration.executor.execute(
              {
                agentId: invocation.agentId,
                arguments: invocation.arguments,
                context: caller,
                organizationId: invocation.organizationId,
                runId: invocation.runId,
                tool: invocation.tool,
              },
              {
                actorPrincipalId: caller.actor.id,
                agentId: invocation.agentId,
                argumentDigest: invocation.argumentDigest,
                connectorFingerprint: invocation.tool.connectorFingerprint,
                connectorId: invocation.tool.connectorId,
                effect: invocation.tool.effect,
                expiresAt: deadlineAt,
                operationId,
                organizationId: invocation.organizationId,
                policyVersion,
                principalId: caller.represented?.id ?? caller.actor.id,
                runId: invocation.runId,
                toolId: invocation.tool.id,
                toolVersion: invocation.tool.version,
              },
              {
                deadlineAt,
                operationId,
                requestDigest: invocation.argumentDigest,
              }
            );
          }
          return receipt;
        })
      )
    );
    if (Result.isFailure(result)) {
      const failure = failureToHttp(result.failure);
      return Response.json(failure.body, { status: failure.status });
    }
    return Response.json({ status: "ok", value: result.success });
  }
}
