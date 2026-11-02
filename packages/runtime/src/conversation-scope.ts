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
  ChatActivity,
  ChatControl as ChatControlValue,
  ChatObservation,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { ChatControl } from "@cerebro/contracts/session-service";
import { isInternalToolName } from "@cerebro/tools/tool-names";
import type { Provider } from "@earendil-works/pi-ai/models";
import { LiveDoc } from "@earendil-works/pi-durable";
import type {
  AgentChange,
  Conversation,
  ConversationView,
  Extension,
  Harness,
} from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import type { LifecycleJobs } from "agents/lifecycle";
import { Effect, Result, Schema } from "effect";

import { createApprovalStore } from "./approval-store.ts";
import { companySkillsExtension } from "./company-skills.ts";
import { createConversationCompaction } from "./conversation-compaction.ts";
import { conversationProvider } from "./conversation-provider.ts";
import { createConversationReminders } from "./conversation-reminders.ts";
import { createConversationWork } from "./conversation-work.ts";
import type { SearchResult } from "./conversation-work.ts";
import { createGenerativeUiTool } from "./generative-ui-tool.ts";
import { chatSnapshot, piContext, snapshotToolIds } from "./pi-harness.ts";
import { createControlledProvider } from "./pi-provider.ts";
import { createPiTools } from "./pi-tools.ts";
import type {
  MetadataTransaction,
  SessionHostConfiguration,
} from "./session-agent.ts";

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

const createResources = (
  configuration: SessionHostConfiguration,
  storage: DurableObjectStorage,
  metadata: MetadataTransaction
) => {
  const approvals = createApprovalStore(
    storage,
    configuration.address.sessionId
  );
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
    if (operation === "read" || operation === "send" || operation === "allow") {
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
    metadata,
    ownerContext: configuration.ownerContext,
    persist: () =>
      Effect.tryPromise({
        catch: () =>
          new Unavailable({ reason: "Native tool dispatch flush failed." }),
        try: () => storage.sync(),
      }),
    tools: configuration.tools,
  });
  return { approvals, authorize, configuration, provider, tools };
};

interface ConversationScopeServices {
  readonly jobs: LifecycleJobs;
  readonly install: (extension: Extension) => void;
  readonly search: (
    term: string,
    signal?: AbortSignal
  ) => Promise<SearchResult>;
  readonly pi: Harness;
  readonly harness: PiHarness;
  readonly storage: DurableObjectStorage;
  readonly metadata: MetadataTransaction;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly scheduleNotify: (
    address: EventAddress,
    nativeId: string
  ) => Promise<void>;
}
export interface ConversationRegistration {
  readonly agent: AgentChange;
  readonly extensions: readonly Extension[];
  readonly provider: Provider;
}

export class ConversationScope {
  readonly runtime: ReturnType<typeof createResources>;
  readonly native: Conversation;
  private readonly services: ConversationScopeServices;
  readonly work: ReturnType<typeof createConversationWork>;
  readonly reminders: ReturnType<typeof createConversationReminders>;
  readonly compaction: ReturnType<typeof createConversationCompaction>;

  private constructor(
    runtime: ReturnType<typeof createResources>,
    native: Conversation,
    services: ConversationScopeServices,
    work: ReturnType<typeof createConversationWork>,
    reminders: ReturnType<typeof createConversationReminders>,
    compaction: ReturnType<typeof createConversationCompaction>
  ) {
    this.runtime = runtime;
    this.native = native;
    this.services = services;
    this.work = work;
    this.reminders = reminders;
    this.compaction = compaction;
  }

  static async open(
    configuration: SessionHostConfiguration,
    services: ConversationScopeServices,
    bind: (registration: ConversationRegistration) => Promise<Conversation>
  ): Promise<ConversationScope> {
    const runtime = await services.metadata(() =>
      createResources(configuration, services.storage, services.metadata)
    );
    const extensions: Extension[] = [
      {
        name: `cerebro-tools:${configuration.address.sessionId}`,
        tools: runtime.tools,
      },
    ];
    const companySkills = configuration.skills ?? [];
    if (companySkills.length > 0) {
      const extension = await companySkillsExtension(companySkills);
      extensions.push({
        ...extension,
        name: `cerebro-skills:${configuration.address.sessionId}`,
      });
    }
    const provider = conversationProvider(
      configuration.address.sessionId,
      configuration.provider.model,
      runtime.provider
    );
    const native = await bind({
      agent: {
        extensions,
        instructions: configuration.agent.instructions,
        model: {
          modelId: configuration.provider.model.id,
          provider: provider.id,
        },
      },
      extensions,
      provider,
    });
    const authorize = async (signal?: AbortSignal) => {
      const owner = await run(configuration.ownerContext());
      await runtime.authorize(owner, "send", signal);
    };
    const work = createConversationWork({
      address: configuration.address,
      authorize,
      ensureDeadline: (childId, deadlineAt) =>
        services.metadata(async () => {
          const id = `cerebro-child:${configuration.address.sessionId}:${childId}`;
          if (!services.jobs.get(id)) {
            await services.jobs.push({
              id,
              fn: "cerebro-child",
              time: deadlineAt,
              payload: { sessionId: configuration.address.sessionId, childId },
              singleflight: true,
            });
          }
        }),
      nativeId: native.id,
      pi: services.pi,
      search: services.search,
    });
    const reminders = createConversationReminders({
      authorize,
      authorizeCancel: async () =>
        runtime.authorize(await run(configuration.ownerContext()), "stop"),
      jobs: services.jobs,
      metadata: services.metadata,
      nativeId: native.id,
      persist: () => services.storage.sync(),
      pi: services.pi,
      sessionId: configuration.address.sessionId,
      submit: (text, operationId) =>
        services.harness.submit(text, {
          operationId,
          session: String(native.id),
        }),
    });
    const compaction = createConversationCompaction({
      authorize,
      jobs: services.jobs,
      metadata: services.metadata,
      nativeId: native.id,
      persist: () => services.storage.sync(),
      pi: services.pi,
      sessionId: configuration.address.sessionId,
      waitUntil: services.waitUntil,
    });
    const scope = new ConversationScope(
      runtime,
      native,
      services,
      work,
      reminders,
      compaction
    );
    services.install({
      name: `cerebro-tools:${configuration.address.sessionId}`,
      hooks: scope.work.hooks,
      tools: [
        ...runtime.tools,
        ...scope.work.tools,
        ...scope.reminders.tools,
        createGenerativeUiTool({ authorize }),
      ],
    });
    await scope.reminders.restore();
    if (configuration.notify) {
      const watch = await native.watch(piContext());
      watch.start(() => scope.scheduleNotify());
      await scope.scheduleNotify();
    }
    return scope;
  }

  private scheduleNotify(): Promise<void> {
    return this.services.scheduleNotify(
      this.runtime.configuration.address,
      String(this.native.id)
    );
  }

  async notify(): Promise<void> {
    const { configuration } = this.runtime;
    if (!configuration.notify) {
      return;
    }
    const owner = await run(configuration.ownerContext());
    const snapshot = await this.read(owner);
    await configuration.notify(snapshot);
  }
  private async snapshot(view: ConversationView): Promise<ChatSnapshot> {
    const { runtime } = this;
    const { pi } = this.services;
    const approvals = await pi.commit(
      () => runtime.approvals.all(),
      piContext()
    );
    const [children, known, reminders, inspection, live] = await Promise.all([
      this.work.children(),
      this.work.known(),
      this.reminders.list(),
      pi.inspect(piContext()),
      pi.snapshot(LiveDoc, this.native.id, piContext()),
    ]);
    const childrenByNativeId = new Map(
      known.map((child) => [child.nativeId, child])
    );
    const activity: ChatActivity = {
      children,
      reminders,
      compactions: (live?.compactions ?? []).map((compaction) => ({
        id: String(compaction.taskId),
        reason: compaction.reason,
        attempt: compaction.attempt,
        blocking: compaction.blocking,
        ...(compaction.retry ? { retryAt: compaction.retry.at } : {}),
      })),
      ...(live?.compactionFailure
        ? {
            compactionFailure:
              "Context compaction failed. Try again after checking model access.",
          }
        : {}),
      ...(runtime.configuration.origin
        ? {
            origin: {
              conversationId:
                runtime.configuration.origin.address.conversationId,
              entryId: runtime.configuration.origin.entryId,
            },
          }
        : {}),
      tasks: inspection.tasks
        .filter(
          ({ record }) =>
            record.conversationId === this.native.id ||
            childrenByNativeId.has(record.conversationId)
        )
        .map(({ record }) => {
          const child = childrenByNativeId.get(record.conversationId);
          const ownerTaskId = record.owner ?? child?.ownerTaskId;
          return {
            id: String(record.id),
            conversationId:
              child?.id ?? runtime.configuration.address.conversationId,
            kind: record.kind,
            background: record.background === true,
            ...(ownerTaskId === undefined
              ? {}
              : { ownerTaskId: String(ownerTaskId) }),
            state:
              record.state.status === "terminal"
                ? "completing"
                : record.state.status,
          };
        }),
    };
    const snapshot = chatSnapshot({
      address: runtime.configuration.address,
      agentVersion: runtime.configuration.agent.version,
      approvals,
      view,
    });
    return {
      ...snapshot,
      activity,
      busy:
        snapshot.busy ||
        activity.compactions.some(
          (compaction) => compaction.reason === "manual"
        ),
    };
  }

  private async accessTools(
    snapshot: ChatSnapshot
  ): Promise<readonly string[]> {
    return [
      ...new Set([
        ...snapshotToolIds(snapshot),
        ...(await this.work.toolIds()),
      ]),
    ].filter((name) => !isInternalToolName(name));
  }

  private async control(
    command: ChatControlValue,
    context: ExecutionContext,
    signal?: AbortSignal
  ) {
    await this.runtime.authorize(
      context,
      command.kind === "stop-child" || command.kind === "cancel-schedule"
        ? "stop"
        : "send",
      signal
    );
    if (command.kind === "stop-child") {
      await this.work.stop(command.childId);
      return { id: command.childId, kind: command.kind };
    }
    if (command.kind === "cancel-schedule") {
      const value = await this.reminders.cancel(command.scheduleId);
      return { id: value.id, kind: command.kind };
    }
    if (command.kind === "schedule") {
      const value = await this.reminders.schedule(
        command,
        command.operationId,
        signal
      );
      return { id: value.id, kind: command.kind };
    }
    return {
      id: String(await this.compaction.request(command)),
      kind: command.kind,
    };
  }

  async read(
    context: ExecutionContext,
    signal?: AbortSignal
  ): Promise<ChatSnapshot> {
    const { runtime } = this;
    await runtime.authorize(context, "read", signal);
    const watch = await this.native.watch(piContext(signal));
    try {
      const snapshot = await this.snapshot(watch.value);
      await runtime.authorize(
        context,
        "read",
        signal,
        await this.accessTools(snapshot)
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
    const { runtime } = this;
    await runtime.authorize(context, "read", signal);
    const abort = new AbortController();
    const nativeContext = piContext(AbortSignal.any([signal, abort.signal]));
    const watch = await this.native.watch(nativeContext);
    let initial: ChatSnapshot;
    try {
      initial = await this.snapshot(watch.value);
      await runtime.authorize(
        context,
        "read",
        signal,
        await this.accessTools(initial)
      );
    } catch (error) {
      await watch.stop();
      throw error;
    }
    const encoder = new TextEncoder();
    let resumeReader: (() => void) | undefined;
    let closed = false;
    let publishing = Promise.resolve();
    let pendingUpdate = false;
    let lastFrame = JSON.stringify(initial);
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
        const publish = () => {
          if (pendingUpdate || closed) {
            return publishing;
          }
          pendingUpdate = true;
          const previous = publishing;
          publishing = (async () => {
            await previous;
            pendingUpdate = false;
            try {
              if ((controller.desiredSize ?? 0) <= 0) {
                const pending = Promise.withResolvers<boolean>();
                resumeReader = () => pending.resolve(true);
                await pending.promise;
              }
              if (closed) {
                return;
              }
              const snapshot = await this.snapshot(watch.value);
              const accessTools = await this.accessTools(snapshot);
              await runtime.authorize(context, "read", signal, accessTools);
              const frame = JSON.stringify(snapshot);
              if (frame !== lastFrame) {
                emit({ snapshot, type: "snapshot" });
                lastFrame = frame;
              }
            } catch (error) {
              await denied(error);
            }
          })();
          return publishing;
        };
        watch.start(() => publish());
        timer = setInterval(() => {
          void publish();
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

  async handle(request: Request, context: ExecutionContext): Promise<Response> {
    try {
      const { runtime } = this;
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
          value: {
            stopped: await this.services.harness.abort({
              session: String(this.native.id),
            }),
          },
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
        const receipt = await this.services.harness.submit(command.text, {
          session: String(this.native.id),
          operationId: command.operationId,
        });
        this.services.waitUntil(this.native.waitForIdle(piContext()));
        return Response.json({ status: "ok", value: receipt });
      }
      if (path === "/control") {
        const command = await run(
          Schema.decodeUnknownEffect(Schema.Struct({ command: ChatControl }))(
            body
          ).pipe(
            Effect.mapError(
              () =>
                new InvalidInput({
                  reason: "The conversation control is invalid.",
                })
            )
          )
        );
        return Response.json({
          status: "ok",
          value: await this.control(command.command, context, request.signal),
        });
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
        const { pi } = this.services;
        const value = await pi.commit(
          () => runtime.approvals.decide(command.approvalId, command.decision),
          piContext(request.signal)
        );
        await this.services.storage.sync();
        return Response.json({
          status: "ok",
          value: { approvalId: value.approvalId, state: value.state },
        });
      }
      throw new NotFound({ resource: "Chat route" });
    } catch (error) {
      if (error instanceof Denied) {
        this.runtime.approvals.revalidate();
      }
      const response = failureToHttp(
        toContractFailure(error, "The native chat request is unavailable.")
      );
      return Response.json(response.body, { status: response.status });
    }
  }
}
