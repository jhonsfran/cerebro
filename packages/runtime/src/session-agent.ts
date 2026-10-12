import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  failureToHttp,
  toContractFailure,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import type {
  ChatObservation,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import type { ToolExecutor } from "@cerebro/contracts/tool-service";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import type { ConversationView } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome,
} from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import { createApprovalStore } from "./approval-store.ts";
import { chatSnapshot, piContext } from "./pi-harness.ts";
import { createControlledProvider } from "./pi-provider.ts";
import type { ControlledProviderConfiguration } from "./pi-provider.ts";
import { createPiTools } from "./pi-tools.ts";
import type { PiToolConfiguration, PiRegisteredTool } from "./pi-tools.ts";

export type SessionEnvironment = Readonly<Record<string, unknown>>;
export interface SessionHostConfiguration {
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly executor: ToolExecutor;
  readonly provider: Omit<ControlledProviderConfiguration, "authorize">;
  readonly tools: readonly PiRegisteredTool[];
  readonly authenticate: (request: Request) => Promise<ExecutionContext>;
  readonly ownerContext: () => Effect.Effect<ExecutionContext, ContractFailure>;
  readonly notify?: (snapshot: ChatSnapshot) => Promise<void>;
  readonly prepareInput?: (
    text: string,
    context: ExecutionContext
  ) => Effect.Effect<string, ContractFailure>;
  readonly toolDependencies: PiToolConfiguration["dependencies"];
  readonly checkDependencies: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
}

const options = (signal?: AbortSignal): ReadOptions => ({
  deadlineAt: Date.now() + 30_000,
  signal,
});
const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};
const sendSchema = Schema.Struct({
  operationId: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
});
const decisionSchema = Schema.Struct({
  approvalId: Schema.NonEmptyString,
  decision: Schema.Literals(["allow", "deny"]),
});

type ChatOperation = "read" | "send" | "stop" | "allow" | "deny";
const operationAction = {
  allow: "approve",
  deny: "approve",
  read: "read",
  send: "execute",
  stop: "execute",
} as const;

const snapshotToolIds = (snapshot: ChatSnapshot): readonly string[] => [
  ...new Set([
    ...snapshot.messages.flatMap((message) =>
      message.toolName ? [message.toolName] : []
    ),
    ...snapshot.approvals.map((approval) => approval.toolId),
  ]),
];

export class SessionAgent<
  Environment extends SessionEnvironment = SessionEnvironment,
> extends DurableObject<Environment> {
  private initialized:
    | ReturnType<SessionAgent<Environment>["initialize"]>
    | undefined;
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const runtime = await this.ready();
      const registry = createRegistry();
      const { configuration } = runtime;
      registry.install({ name: "cerebro-controlled", tools: runtime.tools });
      const models = createModels();
      models.setProvider(runtime.provider);
      const pi = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: {
            stream: {
              maxRetries: 0,
              timeoutMs: configuration.provider.deadlineMs,
              transport: "sse",
            },
          },
        },
        context
      );
      const root = await pi.root(context, {
        agent: {
          instructions: configuration.agent.instructions,
          model: {
            modelId: configuration.provider.model.id,
            provider: configuration.provider.model.provider,
          },
        },
      });
      this.ctx.waitUntil(root.waitForIdle(context));
      if (configuration.notify) {
        const watch = await root.watch(context);
        watch.start(() => this.scheduleNotify());
        this.ctx.waitUntil(this.scheduleNotify());
      }
      return pi;
    },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  // oxlint-disable-next-line class-methods-use-this -- Server and isolated fixture subclasses supply company services.
  protected configure(): Effect.Effect<
    SessionHostConfiguration,
    ContractFailure
  > {
    return Effect.fail(
      new Unavailable({ reason: "Session host composition is not configured." })
    );
  }

  private async initialize() {
    const configuration = await run(this.configure());
    const approvals = createApprovalStore(this.ctx.storage);
    const authorize = async (
      context: ExecutionContext,
      operation: ChatOperation,
      signal?: AbortSignal,
      toolIds: readonly string[] = []
    ): Promise<void> => {
      await run(
        configuration.authority.require(
          {
            action: operationAction[operation],
            address: configuration.address,
            context,
            model: operation === "send" ? configuration.agent.model : undefined,
            pinnedAgent: configuration.agent,
            resource: {
              id: configuration.agent.agentId,
              kind: "agent",
              organizationId: configuration.address.organizationId,
            },
          },
          options(signal)
        )
      );
      if (
        operation === "read" ||
        operation === "send" ||
        operation === "allow"
      ) {
        await run(
          configuration.checkDependencies(
            context,
            { sourceIds: [], toolIds },
            options(signal)
          )
        );
      }
    };
    const provider = createControlledProvider({
      ...configuration.provider,
      ...(configuration.prepareInput
        ? {
            prepareContext: (context, readOptions) =>
              Effect.gen(function* prepareCurrentContext() {
                const { prepareInput } = configuration;
                if (!prepareInput) {
                  return context;
                }
                const index = context.messages.findLastIndex(
                  (message) => message.role === "user"
                );
                const message = context.messages[index];
                if (message?.role !== "user") {
                  return context;
                }
                const inputText =
                  typeof message.content === "string"
                    ? message.content
                    : message.content
                        .filter((block) => block.type === "text")
                        .map((block) => block.text)
                        .join("");
                if (!inputText) {
                  return context;
                }
                const owner = yield* configuration.ownerContext();
                const text = yield* prepareInput(inputText, owner);
                if (readOptions.signal?.aborted) {
                  return yield* Effect.fail(
                    new Unavailable({
                      reason: "Model context preparation was interrupted.",
                    })
                  );
                }
                return {
                  ...context,
                  messages: context.messages.map((value, position) =>
                    position === index ? { ...message, content: text } : value
                  ),
                };
              }),
          }
        : {}),
      authorize: (readOptions) =>
        Effect.gen(function* currentModelAuthority() {
          const context = yield* configuration.ownerContext();
          yield* configuration.authority.require(
            {
              action: "execute",
              address: configuration.address,
              context,
              model: configuration.agent.model,
              pinnedAgent: configuration.agent,
              resource: {
                id: configuration.agent.agentId,
                kind: "agent",
                organizationId: configuration.address.organizationId,
              },
            },
            readOptions
          );
          yield* configuration.checkDependencies(
            context,
            { sourceIds: [], toolIds: [] },
            readOptions
          );
        }),
    });
    const tools = createPiTools({
      address: configuration.address,
      agent: configuration.agent,
      approvals,
      authority: configuration.authority,
      checkDependencies: configuration.checkDependencies,
      deadlineMs: configuration.provider.deadlineMs,
      dependencies: configuration.toolDependencies,
      executor: configuration.executor,
      ownerContext: configuration.ownerContext,
      persist: () =>
        Effect.tryPromise({
          catch: () =>
            new Unavailable({ reason: "Native tool dispatch flush failed." }),
          try: () => this.ctx.storage.sync(),
        }),
      tools: configuration.tools,
    });
    return { approvals, authorize, configuration, provider, tools };
  }

  private ready() {
    this.initialized ??= this.initialize();
    return this.initialized;
  }

  private async scheduleNotify(): Promise<void> {
    await this.lifecycle.jobs.push({
      fn: "cerebro-notify",
      id: "cerebro-notify",
      recoveryLoop: true,
      singleflight: true,
      time: Date.now() + 1000,
    });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== "cerebro-notify") {
      return;
    }
    const runtime = await this.ready();
    if (!runtime.configuration.notify) {
      return;
    }
    try {
      const owner = await run(runtime.configuration.ownerContext());
      const snapshot = await this.read(owner);
      await runtime.configuration.notify(snapshot);
    } catch (error) {
      if (error instanceof Denied) {
        return;
      }
      return { rescheduleAt: Date.now() + 5000 };
    }
  }

  private async snapshot(view: ConversationView): Promise<ChatSnapshot> {
    const runtime = await this.ready();
    const pi = await this.harness.pi();
    const approvals = await pi.commit(
      () => runtime.approvals.all(),
      piContext()
    );
    return chatSnapshot({
      address: runtime.configuration.address,
      agentVersion: runtime.configuration.agent.version,
      approvals,
      view,
    });
  }

  private async read(
    context: ExecutionContext,
    signal?: AbortSignal
  ): Promise<ChatSnapshot> {
    const runtime = await this.ready();
    await runtime.authorize(context, "read", signal);
    const pi = await this.harness.pi();
    const root = await pi.root(piContext(signal));
    const watch = await root.watch(piContext(signal));
    try {
      const snapshot = await this.snapshot(watch.value);
      await runtime.authorize(
        context,
        "read",
        signal,
        snapshotToolIds(snapshot)
      );
      return snapshot;
    } finally {
      await watch.stop();
    }
  }

  private async observe(
    context: ExecutionContext,
    signal: AbortSignal
  ): Promise<Response> {
    const runtime = await this.ready();
    await runtime.authorize(context, "read", signal);
    const abort = new AbortController();
    const nativeContext = piContext(AbortSignal.any([signal, abort.signal]));
    const pi = await this.harness.pi();
    const root = await pi.root(nativeContext);
    const watch = await root.watch(nativeContext);
    let initial: ChatSnapshot;
    try {
      initial = await this.snapshot(watch.value);
      await runtime.authorize(
        context,
        "read",
        signal,
        snapshotToolIds(initial)
      );
    } catch (error) {
      await watch.stop();
      throw error;
    }
    let accessTools = snapshotToolIds(initial);
    const encoder = new TextEncoder();
    let resumeReader: (() => void) | undefined;
    let closed = false;
    let checking = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const close = async () => {
      if (closed) {
        return;
      }
      closed = true;
      if (timer) {
        clearInterval(timer);
      }
      resumeReader?.();
      abort.abort();
      await watch.stop();
    };
    const stream = new ReadableStream<Uint8Array>({
      cancel: close,
      pull: () => {
        resumeReader?.();
        resumeReader = undefined;
      },
      start: (controller) => {
        const emit = (frame: ChatObservation) =>
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        const denied = async (error: unknown) => {
          if (closed) {
            return;
          }
          if (error instanceof Denied) {
            runtime.approvals.revalidate();
            emit({
              reason:
                error.code === "unauthorized" ? "unauthorized" : "revoked",
              type: "access-denied",
            });
            controller.close();
          } else {
            controller.error(toContractFailure(error));
          }
          await close();
        };
        emit({ snapshot: initial, type: "snapshot" });
        watch.start(async (view) => {
          try {
            if ((controller.desiredSize ?? 0) <= 0) {
              const pending = Promise.withResolvers<boolean>();
              resumeReader = () => pending.resolve(true);
              await pending.promise;
            }
            if (closed) {
              return;
            }
            const snapshot = await this.snapshot(view);
            accessTools = snapshotToolIds(snapshot);
            await runtime.authorize(context, "read", signal, accessTools);
            emit({ snapshot, type: "snapshot" });
          } catch (error) {
            await denied(error);
          }
        });
        const checkAccess = async () => {
          if (closed || checking) {
            return;
          }
          checking = true;
          try {
            await runtime.authorize(context, "read", signal, accessTools);
          } catch (error) {
            await denied(error);
          } finally {
            checking = false;
          }
        };
        timer = setInterval(() => {
          void checkAccess();
        }, 1000);
        const waitForClose = async () => {
          await watch.closed;
          if (!closed) {
            controller.close();
            await close();
          }
        };
        void waitForClose();
      },
    });
    return new Response(stream, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "application/x-ndjson",
      },
    });
  }

  async dispose(): Promise<void> {
    await this.harness.dispose();
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const runtime = await this.ready();
      const context = await runtime.configuration.authenticate(request);
      const path = new URL(request.url).pathname;
      if (path === "/observe") {
        return await this.observe(context, request.signal);
      }
      if (path === "/read") {
        return Response.json({
          status: "ok",
          value: await this.read(context, request.signal),
        });
      }
      if (path === "/stop") {
        await runtime.authorize(context, "stop", request.signal);
        return Response.json({
          status: "ok",
          value: { stopped: await this.harness.abort() },
        });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new InvalidInput({ reason: "Invalid chat command JSON." });
      }
      if (path === "/send") {
        const command = await run(
          Schema.decodeUnknownEffect(sendSchema)(body).pipe(
            Effect.mapError(
              () =>
                new InvalidInput({ reason: "The chat submission is invalid." })
            )
          )
        );
        await runtime.authorize(context, "send", request.signal);
        const receipt = await this.harness.submit(command.text, {
          operationId: command.operationId,
        });
        const pi = await this.harness.pi();
        const root = await pi.root(piContext());
        this.ctx.waitUntil(root.waitForIdle(piContext()));
        return Response.json({ status: "ok", value: receipt });
      }
      if (path === "/decide") {
        const command = await run(
          Schema.decodeUnknownEffect(decisionSchema)(body).pipe(
            Effect.mapError(
              () =>
                new InvalidInput({
                  reason: "The approval decision is invalid.",
                })
            )
          )
        );
        await runtime.authorize(
          context,
          command.decision === "allow" ? "allow" : "deny",
          request.signal
        );
        const pi = await this.harness.pi();
        const value = await pi.commit(
          () => runtime.approvals.decide(command.approvalId, command.decision),
          piContext(request.signal)
        );
        await this.ctx.storage.sync();
        return Response.json({
          status: "ok",
          value: { approvalId: value.approvalId, state: value.state },
        });
      }
      throw new NotFound({ resource: "Chat route" });
    } catch (error) {
      if (error instanceof Denied) {
        // A denial may mean access was revoked; waiting approvals recheck once instead of polling.
        const runtime = await this.initialized?.catch(() => null);
        runtime?.approvals.revalidate();
      }
      const response = failureToHttp(
        toContractFailure(error, "The native chat request is unavailable.")
      );
      return Response.json(response.body, { status: response.status });
    }
  }
}
