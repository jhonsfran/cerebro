import { AuthorityService } from "@cerebro/contracts/authority-service";
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
import type {
  LifecycleJobContext,
  LifecycleJobOutcome,
} from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Context, Effect, Exit, Layer, Result, Scope, Stream } from "effect";

import { drainAuditProjection } from "./audit-projection.ts";
import type { AuditProjection } from "./audit-projection.ts";
import { createCelldSessionStore } from "./celld-session-store.ts";
import {
  createPiExecutionEngine,
  modelAuthority,
  piContext,
} from "./pi-harness.ts";
import { pendingRun } from "./pi-projection.ts";
import { createControlledProvider } from "./pi-provider.ts";
import type { ControlledProviderConfiguration } from "./pi-provider.ts";
import { createPiTools } from "./pi-tools.ts";
import type { PiToolConfiguration, PiRegisteredTool } from "./pi-tools.ts";
import { attempt, checkOptions } from "./runtime-ports.ts";
import type { HostCheckpoint } from "./runtime-ports.ts";
import { SessionCoordinator, sessionServiceLayer } from "./session-service.ts";

interface ProjectionFailureDiagnostic {
  readonly tag: ContractFailure["_tag"];
  readonly code: string | null;
  readonly reasonSHA256: string;
}
const projectionFailureKey = "cerebro:projection:first-failure";
const lastProjectionFailureKey = "cerebro:projection:last-failure";
const projectionBlockedKey = "cerebro:projection:blocked";

export type SessionEnvironment = Readonly<Record<string, unknown>>;
export interface SessionHostConfiguration {
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly executor: ToolExecutor;
  readonly checkpoint?: HostCheckpoint;
  readonly projectAudit?: (
    event: AuditProjection
  ) => Effect.Effect<void, ContractFailure>;
  // Runs after durable commits with the current snapshot, for example to post
  // a channel reply. It must be idempotent: a persisted job retries a failure,
  // and several commits may share one call.
  readonly notify?: (
    snapshot: DomainSnapshot
  ) => Effect.Effect<void, ContractFailure>;
  readonly provider: Omit<ControlledProviderConfiguration, "authorize">;
  readonly tools: readonly PiRegisteredTool[];
  readonly authenticate: (
    request: Request
  ) => Effect.Effect<ExecutionContext, ContractFailure>;
  readonly prepareInput?: (
    handoff: DurableHandoff
  ) => Effect.Effect<string, ContractFailure>;
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
// Lifecycle runs one object's due jobs one at a time, so a host job must return
// quickly: Pi's own wake job resumes tools and approvals behind it. A repair
// pass that finds work still pending reschedules instead of waiting.
const REPAIR_PASS_MS = 2000;
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
  private auditWork: Promise<void> | undefined;
  private notifyWork: Promise<void> | undefined;
  private notifyAgain = false;
  private projectionWork: Promise<LifecycleJobOutcome> | undefined;
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
      this.ctx.waitUntil(
        (async () => {
          try {
            if (!(await this.ctx.storage.get(projectionBlockedKey))) {
              await Effect.runPromise(runtime.recover());
            }
          } finally {
            const root = await pi.root(context);
            await root.waitForIdle(context);
          }
        })()
      );
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
      const authorizeMetadata = (
        context: ExecutionContext,
        options: ReadOptions
      ) =>
        configuration.authority
          .require(
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
          )
          .pipe(Effect.asVoid);
      const store = createCelldSessionStore(this.ctx.storage, {
        address: configuration.address,
        agent: configuration.agent,
        authorize: (context, dependencies, options) =>
          Effect.gen(function* authorizeProjection() {
            yield* authorizeMetadata(context, options);
            yield* configuration.checkDependencies(
              context,
              dependencies,
              options
            );
          }),
        authorizeMetadata,
        onCommit:
          configuration.projectAudit || configuration.notify
            ? () =>
                Effect.tryPromise({
                  catch: () =>
                    new Unavailable({
                      reason: "Commit follow-up could not be persisted",
                    }),
                  try: async () => {
                    if (configuration.projectAudit) {
                      await this.scheduleAudit();
                    }
                    if (configuration.notify) {
                      await this.scheduleNotify();
                    }
                  },
                })
            : undefined,
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
        prepareInput: configuration.prepareInput,
        snapshot: store.domain,
        storage: () => {
          if (!this.piStorage) {
            throw new Unavailable({
              reason: "Official Pi storage is not open",
            });
          }
          return this.piStorage;
        },
      });
      const services = yield* Layer.buildWithScope(
        sessionServiceLayer({
          ...configuration,
          onProjectionFailure: (failure) =>
            Effect.tryPromise({
              catch: () =>
                new Unavailable({
                  reason: "Projection recovery intent could not be persisted",
                }),
              try: async () => {
                await this.recordProjectionFailure(failure);
                if (failure._tag === "Unavailable") {
                  await this.scheduleProjection(5000);
                }
              },
            }),
          retainDurableWork: (completion) => {
            this.ctx.waitUntil(
              (async () => {
                await completion;
                await this.retainNativeWork();
              })()
            );
          },
          retainProjection: () =>
            Effect.tryPromise({
              catch: () =>
                new Unavailable({
                  reason: "Projection recovery intent could not be persisted",
                }),
              try: async () => {
                await this.ctx.storage.delete(projectionBlockedKey);
                await this.scheduleProjection();
              },
            }),
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              engine.layer,
              store.layer,
              Layer.succeed(AuthorityService, configuration.authority)
            )
          )
        ),
        this.hostScope
      );
      const runtime = Context.get(services, SessionCoordinator);
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
        persist: () =>
          Effect.tryPromise({
            catch: () =>
              new Unavailable({ reason: "Tool dispatch state flush failed" }),
            try: () => this.ctx.storage.sync(),
          }),
        publish: store.publish,
        resolve,
        tools: configuration.tools,
      });
      const provider = createControlledProvider({
        ...configuration.provider,
        authorize: (options) =>
          Effect.gen(function* authorizePhysicalModel() {
            const values = yield* engine.records(options);
            const active = values
              .filter((value) => value.record.status === "placed")
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

  private async scheduleAudit(): Promise<void> {
    await this.lifecycle.jobs.push({
      fn: "cerebro-audit",
      id: "cerebro-audit",
      recoveryLoop: true,
      singleflight: true,
      time: Date.now() + 1000,
    });
    await this.ctx.storage.sync();
    this.ctx.waitUntil(
      (async () => {
        try {
          await this.drainAudit();
        } catch {
          // The persisted Lifecycle job retries the retained outbox.
        }
      })()
    );
  }

  private drainAudit(): Promise<void> {
    this.auditWork ??= (async () => {
      try {
        const runtime = await this.ready();
        if (!runtime.configuration.projectAudit) {
          return;
        }
        await Effect.runPromise(
          drainAuditProjection(
            runtime.configuration.address,
            runtime.store,
            runtime.configuration.projectAudit,
            1
          )
        );
      } finally {
        this.auditWork = undefined;
      }
    })();
    return this.auditWork;
  }

  private async scheduleNotify(): Promise<void> {
    await this.lifecycle.jobs.push({
      fn: "cerebro-notify",
      id: "cerebro-notify",
      recoveryLoop: true,
      singleflight: true,
      time: Date.now() + 1000,
    });
    await this.ctx.storage.sync();
    this.ctx.waitUntil(
      (async () => {
        try {
          await this.drainNotify();
        } catch {
          // The persisted Lifecycle job retries the notification.
        }
      })()
    );
  }

  // One notification runs at a time; a commit during a run asks for one more
  // pass so the latest snapshot is always delivered.
  private drainNotify(): Promise<void> {
    if (this.notifyWork) {
      this.notifyAgain = true;
      return this.notifyWork;
    }
    this.notifyWork = (async () => {
      try {
        do {
          this.notifyAgain = false;
          // oxlint-disable-next-line no-await-in-loop -- Each pass delivers the snapshot after the previous one finished.
          const runtime = await this.ready();
          const { notify } = runtime.configuration;
          if (!notify) {
            return;
          }
          // oxlint-disable-next-line no-await-in-loop -- Notifications for one session run one at a time.
          await Effect.runPromise(notify(runtime.store.domain()));
        } while (this.notifyAgain);
      } finally {
        this.notifyWork = undefined;
      }
    })();
    return this.notifyWork;
  }

  async onStart(): Promise<void> {
    const runtime = await this.ready();
    if (
      runtime.store.domain().runs.some(pendingRun) &&
      !(await this.ctx.storage.get(projectionBlockedKey))
    ) {
      await this.scheduleProjection();
    }
    if (runtime.configuration.projectAudit && runtime.store.outbox().length) {
      await this.scheduleAudit();
    }
    if (runtime.configuration.notify && runtime.store.domain().runs.length) {
      await this.scheduleNotify();
    }
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn === "cerebro-projection") {
      return this.repairProjection();
    }
    if (job.fn === "cerebro-notify") {
      try {
        await this.drainNotify();
      } catch {
        return { rescheduleAt: Date.now() + 5000 };
      }
      return;
    }
    if (job.fn !== "cerebro-audit") {
      return;
    }
    try {
      await this.drainAudit();
      const runtime = await this.ready();
      if (runtime.store.outbox().length) {
        return { rescheduleAt: Date.now() + 1000 };
      }
    } catch {
      return { rescheduleAt: Date.now() + 5000 };
    }
  }

  private async scheduleProjection(delayMs = 1000): Promise<void> {
    await this.lifecycle.jobs.push({
      fn: "cerebro-projection",
      id: "cerebro-projection",
      recoveryLoop: true,
      singleflight: true,
      time: Date.now() + delayMs,
    });
    await this.ctx.storage.sync();
  }

  private repairProjection(): Promise<LifecycleJobOutcome> {
    this.projectionWork ??= (async () => {
      try {
        if (await this.ctx.storage.get(projectionBlockedKey)) {
          return;
        }
        const runtime = await this.ready();
        const failure = runtime.backgroundFailure();
        if (failure) {
          const recorded = await Effect.runPromise(
            Effect.result(
              Effect.tryPromise({
                catch: () =>
                  new Unavailable({
                    reason:
                      "Projection failure diagnostic could not be persisted",
                  }),
                try: () => this.recordProjectionFailure(failure),
              })
            )
          );
          if (Result.isFailure(recorded)) {
            return { rescheduleAt: Date.now() + 5000 };
          }
        }
        const result = await Effect.runPromise(
          Effect.result(
            runtime.repairProjection({
              deadlineAt: Date.now() + REPAIR_PASS_MS,
            })
          )
        );
        if (Result.isFailure(result)) {
          const recorded = await Effect.runPromise(
            Effect.result(
              Effect.tryPromise({
                catch: () =>
                  new Unavailable({
                    reason:
                      "Projection failure diagnostic could not be persisted",
                  }),
                try: () => this.recordProjectionFailure(result.failure),
              })
            )
          );
          if (
            Result.isFailure(recorded) ||
            result.failure._tag === "Unavailable"
          ) {
            return { rescheduleAt: Date.now() + 5000 };
          }
        } else if (!result.success) {
          return { rescheduleAt: Date.now() + 5000 };
        }
      } finally {
        this.projectionWork = undefined;
      }
    })();
    return this.projectionWork;
  }

  private async recordProjectionFailure(
    failure: ContractFailure
  ): Promise<void> {
    const diagnostic = await SessionAgent.safeProjectionFailure(failure);
    await this.ctx.storage.transaction(async (transaction) => {
      if (!(await transaction.get(projectionFailureKey))) {
        await transaction.put(projectionFailureKey, diagnostic);
      }
      await transaction.put(lastProjectionFailureKey, diagnostic);
      if (failure._tag !== "Unavailable") {
        await transaction.put(projectionBlockedKey, true);
      }
    });
    await this.ctx.storage.sync();
  }

  private static async safeProjectionFailure(
    failure: ContractFailure
  ): Promise<ProjectionFailureDiagnostic> {
    const reason = "reason" in failure ? failure.reason : failure.resource;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(reason)
    );
    return {
      code: "code" in failure ? failure.code : null,
      reasonSHA256: Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0")
      ).join(""),
      tag: failure._tag,
    };
  }

  protected async observerCount(): Promise<number> {
    const runtime = await this.ready();
    return runtime.store.observerCount();
  }

  protected async projectionFailure(): Promise<ProjectionFailureDiagnostic | null> {
    const runtime = await this.ready();
    const failure = runtime.backgroundFailure();
    if (failure) {
      return SessionAgent.safeProjectionFailure(failure);
    }
    return (await this.ctx.storage.get(projectionBlockedKey))
      ? ((await this.ctx.storage.get<ProjectionFailureDiagnostic>(
          lastProjectionFailureKey
        )) ?? null)
      : null;
  }

  protected async firstProjectionFailure(): Promise<ProjectionFailureDiagnostic | null> {
    return (
      (await this.ctx.storage.get<ProjectionFailureDiagnostic>(
        projectionFailureKey
      )) ?? null
    );
  }

  // Called by the coordinator's host startup hook. Official Lifecycle resumes Pi;
  // this only repairs Cerebro command markers and product projection.
  async recover(): Promise<void> {
    const runtime = await this.ready();
    try {
      if (!(await this.ctx.storage.get(projectionBlockedKey))) {
        await Effect.runPromise(runtime.recover());
      }
    } finally {
      this.ctx.waitUntil(this.retainNativeWork());
    }
  }

  private async retainNativeWork(): Promise<void> {
    if (!this.piStorage) {
      return;
    }
    const pi = await this.harness.pi();
    const context = piContext();
    const root = await pi.root(context);
    await root.waitForIdle(context);
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
