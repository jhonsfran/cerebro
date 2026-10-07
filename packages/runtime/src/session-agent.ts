import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import type { DurableHandoff } from "@cerebro/contracts/execution";
import {
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  failureToHttp,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext, RunId } from "@cerebro/contracts/identity";
import type { EffectOptions, ReadOptions } from "@cerebro/contracts/port";
import type { ToolReceiptStore } from "@cerebro/contracts/receipt-service";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import type {
  ApprovalCommand,
  DomainSnapshot,
  SubmitCommand,
} from "@cerebro/contracts/session-service";
import type {
  BoundApproval,
  BoundInvocation,
  ToolExecutor,
} from "@cerebro/contracts/tool-service";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import type { Storage } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Effect, Exit, Result, Scope, Stream } from "effect";

import { createCelldSessionStore } from "./celld-session-store.ts";
import { createPiExecutionEngine, modelAuthority } from "./pi-harness.ts";
import { createControlledProvider } from "./pi-provider.ts";
import type { ControlledProviderConfiguration } from "./pi-provider.ts";
import { createPiTools } from "./pi-tools.ts";
import type { PiToolConfiguration, PiRegisteredTool } from "./pi-tools.ts";
import { attempt, checkOptions } from "./runtime-ports.ts";
import { createSessionService } from "./session-service.ts";

export type SessionEnvironment = Readonly<Record<string, unknown>>;
export interface SessionHostConfiguration {
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly executor: ToolExecutor;
  readonly receipts: ToolReceiptStore;
  readonly provider: Omit<ControlledProviderConfiguration, "authorize">;
  readonly tools: readonly PiRegisteredTool[];
  readonly authenticate: (
    request: Request
  ) => Effect.Effect<ExecutionContext, ContractFailure>;
  readonly content: (
    handoff: DurableHandoff
  ) => Effect.Effect<
    Pick<DomainSnapshot["outputs"][number], "dependencies" | "citations">,
    ContractFailure
  >;
  readonly toolDependencies: PiToolConfiguration["dependencies"];
  readonly checkDependencies: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
}

const hostOptions = () => ({ deadlineAt: Date.now() + 30_000 });
const validApproval = (command: ApprovalCommand): boolean =>
  typeof command?.approvalId === "string" &&
  typeof command.runId === "string" &&
  (command.decision === "allow" || command.decision === "deny");
const requestOptions = (value: unknown): EffectOptions => {
  const supplied = value as Partial<EffectOptions> | undefined;
  if (
    typeof supplied?.operationId !== "string" ||
    !supplied.operationId.trim() ||
    typeof supplied.requestDigest !== "string" ||
    !supplied.requestDigest.trim() ||
    typeof supplied.deadlineAt !== "number"
  ) {
    throw new InvalidInput({
      reason: "Stable operation identity and deadline are required",
    });
  }
  const options = {
    deadlineAt: supplied.deadlineAt,
    operationId: supplied.operationId,
    requestDigest: supplied.requestDigest,
  };
  checkOptions(options);
  return options;
};

// S1-F supplies the trusted configuration and authentication adapters in a subclass.
// This plain host installs only official Pi and Lifecycle capabilities.
export class SessionAgent<
  Environment extends SessionEnvironment = SessionEnvironment,
> extends DurableObject<Environment> {
  private readonly hostScope = Scope.makeUnsafe();
  private piStorage: Storage | undefined;
  private initialized:
    | Promise<
        Effect.Success<ReturnType<SessionAgent<Environment>["initialize"]>>
      >
    | undefined;
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.piStorage = storage;
      const runtime = await this.ready();
      const registry = createRegistry();
      registry.install({ name: "cerebro-controlled", tools: runtime.tools });
      const models = createModels();
      models.setProvider(runtime.provider);
      const pi = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: {
            followUpMode: "one-at-a-time",
            stream: {
              maxRetries: 0,
              timeoutMs: runtime.configuration.provider.deadlineMs,
              transport: "sse",
            },
          },
        },
        context
      );
      await pi.root(context, {
        agent: {
          instructions: runtime.configuration.agent.instructions,
          model: {
            modelId: runtime.configuration.provider.model.id,
            provider: runtime.configuration.provider.model.provider,
          },
        },
      });
      this.ctx.waitUntil(Effect.runPromise(runtime.recover()));
      return pi;
    },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  // oxlint-disable-next-line class-methods-use-this -- Host subclasses provide their trusted environment bindings.
  protected configure(): Effect.Effect<
    SessionHostConfiguration,
    ContractFailure
  > {
    return Effect.fail(
      new Unavailable({ reason: "Session host composition is not configured" })
    );
  }

  private initialize() {
    return Effect.gen({ self: this }, function* initializeHost() {
      const configuration = yield* this.configure();
      const store = createCelldSessionStore(this.ctx.storage, {
        address: configuration.address,
        agent: configuration.agent,
        authorize: (context, dependencies, options) =>
          Effect.gen(function* authorizeProjection() {
            yield* configuration.authority.require(
              {
                action: "read",
                address: configuration.address,
                context,
                pinnedAgent: configuration.agent,
                resource: {
                  id: configuration.address.agentId,
                  kind: "agent",
                  organizationId: configuration.address.organizationId,
                },
              },
              options
            );
            yield* configuration.checkDependencies(
              context,
              dependencies,
              options
            );
          }),
      });
      if (
        canonicalToolArguments(store.pinnedAgent()) !==
        canonicalToolArguments(configuration.agent)
      ) {
        return yield* Effect.fail(
          new Unavailable({
            reason:
              "Resolve the conversation's persisted pinned agent before opening Pi",
          })
        );
      }
      const engine = createPiExecutionEngine({
        address: configuration.address,
        agent: configuration.agent,
        content: configuration.content,
        handoffs: () =>
          store.service.recover(configuration.address, hostOptions()),
        harness: this.harness,
        storage: () => {
          if (!this.piStorage) {
            throw new Unavailable({
              reason: "Official Pi storage is not open",
            });
          }
          return this.piStorage;
        },
      });
      const runtime = yield* createSessionService({
        ...configuration,
        engine: engine.service,
        store: store.service,
      });
      const resolve = (runId?: RunId) =>
        Effect.gen(function* resolveToolRun() {
          const values = yield* store.service.recover(
            configuration.address,
            hostOptions()
          );
          if (runId) {
            const exact = values.find(
              (handoff) => handoff.submission.runId === runId
            );
            return (
              exact ??
              (yield* Effect.fail(new NotFound({ resource: "Tool run" })))
            );
          }
          const active = (yield* engine.records(hostOptions())).find(
            (value) => value.record.status === "placed"
          );
          return active
            ? active.handoff
            : yield* Effect.fail(
                new NotFound({ resource: "Active Pi tool input" })
              );
        });
      const approve = (
        invocation: BoundInvocation,
        approval: BoundApproval,
        options: ReadOptions
      ) =>
        Effect.gen(function* durableApprovalWait() {
          const handoff = yield* resolve(invocation.runId);
          const snapshot = store.domain();
          const existing = snapshot.approvals.find(
            (value) => value.approvalId === approval.id
          );
          if (!existing) {
            const revision = Math.max(
              0,
              ...(yield* store.service.recover(
                configuration.address,
                hostOptions()
              )).map((value) => value.revision)
            );
            yield* store.service.commit(
              configuration.address,
              revision,
              { approval, runId: invocation.runId, type: "approval" },
              {
                ...hostOptions(),
                operationId: invocation.operationId,
                requestDigest: invocation.argumentDigest,
              }
            );
            yield* store.publish(invocation.runId, {
              approvalId: approval.id,
              expiresAt: approval.expiresAt,
              operationId: invocation.operationId,
              runId: invocation.runId,
              state: "pending",
              type: "approval",
            });
            yield* store.publish(invocation.runId, {
              run: { runId: invocation.runId, state: "waiting-for-approval" },
              type: "run",
            });
          }
          while (true) {
            yield* attempt(() => checkOptions(options));
            const current = yield* store.service.snapshot(
              configuration.address,
              handoff.submission.event.context,
              options
            );
            const decision = current.approvals.find(
              (value) => value.approvalId === approval.id
            );
            if (decision?.state === "allowed") {
              const accepted = (yield* resolve(
                invocation.runId
              )).approvals.find((value) => value.id === approval.id);
              if (accepted) {
                return accepted;
              }
            }
            if (decision && decision.state !== "pending") {
              return yield* Effect.fail(
                new Denied({
                  code: "revoked",
                  reason: "Approval was denied or cancelled",
                })
              );
            }
            yield* Effect.sleep(250);
          }
        });
      const tools = createPiTools({
        agent: configuration.agent,
        approval: approve,
        authority: configuration.authority,
        deadlineMs: configuration.provider.deadlineMs,
        dependencies: configuration.toolDependencies,
        executor: configuration.executor,
        publish: store.publish,
        receipts: configuration.receipts,
        resolve,
        tools: configuration.tools,
      });
      const provider = createControlledProvider({
        ...configuration.provider,
        authorize: (options) =>
          Effect.gen(function* authorizePhysicalModel() {
            const values = yield* engine.records(options);
            const active = values
              .filter(
                (value) =>
                  value.record.status === "placed" ||
                  value.record.status === "queued"
              )
              .map((value) => value.handoff);
            yield* modelAuthority(
              configuration.authority,
              configuration.address,
              configuration.agent,
              active,
              options
            );
          }),
      });
      return { ...runtime, configuration, engine, provider, store, tools };
    });
  }

  private ready() {
    this.initialized ??= Effect.runPromise(
      Scope.provide(this.hostScope)(this.initialize())
    );
    return this.initialized;
  }

  // Called by the coordinator's host startup hook. Official Lifecycle resumes Pi;
  // this only repairs Cerebro command markers and product projection.
  async recover(): Promise<void> {
    const runtime = await this.ready();
    await Effect.runPromise(runtime.recover());
  }

  async dispose(): Promise<void> {
    await Effect.runPromise(Scope.close(this.hostScope, Exit.void));
    await this.harness.dispose();
  }

  async onRequest(request: Request): Promise<Response> {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen({ self: this }, function* handleRequest() {
          const runtime = yield* Effect.tryPromise({
            catch: () =>
              new Unavailable({ reason: "Session host is unavailable" }),
            try: () => this.ready(),
          });
          const context = yield* runtime.configuration.authenticate(request);
          const { address } = runtime.configuration;
          const path = new URL(request.url).pathname;
          const body = yield* Effect.tryPromise({
            catch: () => new InvalidInput({ reason: "Invalid command JSON" }),
            try: async () => (await request.json()) as Record<string, unknown>,
          });
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return yield* Effect.fail(
              new InvalidInput({ reason: "Command must be an object" })
            );
          }
          const options = yield* attempt(() => requestOptions(body.options));
          if (path === "/inspect") {
            return Response.json({
              status: "ok",
              value: yield* runtime.service.inspect(address, context, options),
            });
          }
          if (path === "/stream") {
            yield* runtime.service.inspect(address, context, options);
            const stream = runtime.service.stream(
              address,
              context,
              {
                accessGeneration:
                  typeof body.accessGeneration === "number"
                    ? body.accessGeneration
                    : 0,
              },
              options
            );
            const bytes = Stream.map(Stream.scoped(stream), (frame) =>
              new TextEncoder().encode(`${JSON.stringify(frame)}\n`)
            );
            return new Response(Stream.toReadableStream(bytes), {
              headers: {
                "Cache-Control": "no-store",
                "Content-Type": "application/x-ndjson",
              },
            });
          }
          if (path === "/submit") {
            const submitted = body.command as SubmitCommand;
            if (submitted?.type !== "submit" || !submitted.event?.event) {
              return yield* Effect.fail(
                new InvalidInput({ reason: "Invalid submission" })
              );
            }
            const command: SubmitCommand = {
              ...submitted,
              event: { ...submitted.event, ...address, context },
            };
            return Response.json({
              status: "ok",
              value: yield* runtime.service.submit(command, options),
            });
          }
          if (path === "/approve") {
            const command = body.command as ApprovalCommand;
            if (!validApproval(command)) {
              return yield* Effect.fail(
                new InvalidInput({ reason: "Invalid approval" })
              );
            }
            return Response.json({
              status: "ok",
              value: yield* runtime.service.approve(
                { ...command, address, context, type: "approve" },
                options
              ),
            });
          }
          if (path === "/cancel") {
            const command = body.command as { readonly runId?: string };
            if (typeof command?.runId !== "string") {
              return yield* Effect.fail(
                new InvalidInput({ reason: "Invalid cancel" })
              );
            }
            return Response.json({
              status: "ok",
              value: yield* runtime.service.cancel(
                {
                  address,
                  context,
                  runId: id.run(command.runId),
                  type: "cancel",
                },
                options
              ),
            });
          }
          return yield* Effect.fail(
            new NotFound({ resource: "Session route" })
          );
        })
      )
    );
    if (Result.isFailure(result)) {
      const response = failureToHttp(result.failure);
      return Response.json(response.body, { status: response.status });
    }
    return result.success;
  }
}
