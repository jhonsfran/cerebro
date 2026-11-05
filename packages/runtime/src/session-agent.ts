import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAdmission } from "@cerebro/contracts/bot-routing";
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
import type { ChatSnapshot } from "@cerebro/contracts/session-service";
import { ChatForkReceipt } from "@cerebro/contracts/session-service";
import type { ToolExecutor } from "@cerebro/contracts/tool-service";
import type { SlackThread } from "@cerebro/contracts/work";
import { createModels } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
  Harness,
  configure,
  createRegistry,
  UserEntry,
  AssistantEntry,
} from "@earendil-works/pi-durable";
import type { EntryId, Registry } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome,
} from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import type { CompanySkill } from "./company-skills.ts";
import type { createSourceDependencyStore } from "./content-dependency-store.ts";
import { Bindings } from "./conversation-bindings.ts";
import type { ConversationBinding } from "./conversation-bindings.ts";
import { CompactPayload } from "./conversation-compaction.ts";
import { selectedRegistrationsIn } from "./conversation-drain.ts";
import { searchConversationHistory } from "./conversation-history.ts";
import { ReminderPayload } from "./conversation-reminders.ts";
import { ConversationScope } from "./conversation-scope.ts";
import type { SearchResult } from "./conversation-work.ts";
import { terminalNoticeIn } from "./coordinator-event-content.ts";
import { webEventForkPointIn } from "./coordinator-event-input.ts";
import { eventOf } from "./coordinator-event-state.ts";
import {
  BotEventReceipts,
  createCoordinatorEvents,
} from "./coordinator-events.ts";
import type { CoordinatorEvents } from "./coordinator-events.ts";
import type { ScanWorkKeys } from "./coordinator-history.ts";
import { WorkDocuments } from "./coordinator-ledger.ts";
import { createCoordinatorReplies } from "./coordinator-replies.ts";
import type {
  CoordinatorReplyOutbox,
  EventReplyServices,
} from "./coordinator-replies.ts";
import { wakeCoordinatorJob } from "./coordinator-work.ts";
import type { CoordinationServices } from "./coordinator-work.ts";
import { readImportedContent } from "./imported-content.ts";
import { piContext, snapshotToolIds } from "./pi-harness.ts";
import type { ControlledProviderConfiguration } from "./pi-provider.ts";
import type { PiToolConfiguration, PiRegisteredTool } from "./pi-tools.ts";

export interface DefinitionSelection {
  readonly version: number | "latest";
  readonly contentState?: ReturnType<typeof createSourceDependencyStore>;
}
export type SessionEnvironment = Readonly<Record<string, unknown>>;
export type MetadataTransaction = <A>(
  operation: () => A | Promise<A>
) => Promise<A>;
export type ResolvedSessionRequest =
  | { readonly address: EventAddress; readonly context: ExecutionContext }
  | {
      readonly kind: "subscribed-bots";
      readonly thread: SlackThread;
      readonly context: ExecutionContext;
    }
  | {
      readonly kind: "owned-event";
      readonly address: EventAddress;
      readonly context: ExecutionContext;
      readonly admission: EventAdmission;
    };
export interface SessionHostConfiguration {
  readonly eventReplies?: EventReplyServices;
  readonly publicationPolicy?: "primary" | "pinned";
  readonly contentState?: ReturnType<typeof createSourceDependencyStore>;
  readonly reconcileVersion?: (version: number) => Promise<void>;
  readonly address: EventAddress;
  readonly conversationKind?: "web" | "slack";
  readonly coordination?: CoordinationServices;
  readonly origin?: {
    readonly address: EventAddress;
    readonly entryId: string;
    readonly agentVersion: number;
  };
  readonly contentDependencies?: () => Promise<ContentDependencies>;
  readonly importDependencies?: (dependencies: ContentDependencies) => void;
  readonly checkImportedDependencies?: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
  readonly inheritDependencies?: (
    source: EventAddress,
    toolIds: readonly string[],
    history: boolean
  ) => void;
  readonly agent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly executor: ToolExecutor;
  readonly provider: Omit<ControlledProviderConfiguration, "authorize">;
  readonly tools: readonly PiRegisteredTool[];
  // Company skills the model can activate by name; their bodies load on demand.
  readonly skills?: readonly CompanySkill[];
  readonly ownerContext: () => Effect.Effect<ExecutionContext, ContractFailure>;
  readonly notify?: (snapshot: ChatSnapshot) => Promise<void>;
  readonly prepareInput?: (
    text: string,
    context: ExecutionContext
  ) => Effect.Effect<string, ContractFailure>;
  readonly toolDependencies: PiToolConfiguration["dependencies"];
  readonly audit: PiToolConfiguration["audit"];
  readonly checkDependencies: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
}

interface NativeHost {
  restoring: boolean;
  readonly events: CoordinatorEvents;
  readonly replies: CoordinatorReplyOutbox;
  readonly scanWorkKeys: ScanWorkKeys;
  readonly pi: Harness;
  readonly models: MutableModels;
  readonly registry: Registry;
}
const notifyPayload = Schema.Struct({ sessionId: Schema.NonEmptyString });
const forkCommand = Schema.Struct({
  destination: ChatForkReceipt.fields.address,
  entryId: Schema.NonEmptyString,
  operationId: Schema.NonEmptyString,
});
const childPayload = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  childId: Schema.NonEmptyString,
});
const nativeEntryId = Schema.declare<EntryId>(
  (value): value is EntryId =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
);
const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};
const sameAddress = (left: EventAddress, right: EventAddress): boolean =>
  left.organizationId === right.organizationId &&
  left.agentId === right.agentId &&
  left.conversationId === right.conversationId &&
  left.sessionId === right.sessionId;
const permanentFailure = (error: unknown): boolean =>
  error instanceof Denied ||
  error instanceof NotFound ||
  error instanceof InvalidInput;
const reportPiFailure = (
  identity: string | undefined,
  error: unknown,
  address?: EventAddress
): void => {
  console.error(
    JSON.stringify({
      address,
      errorCode: toContractFailure(error, "Pi execution failed.")._tag,
      errorType: error instanceof Error ? error.name : typeof error,
      event: "pi.execution.failed",
      identity,
      service: "cerebro-runtime",
    })
  );
};

export class SessionAgent<
  Environment extends SessionEnvironment = SessionEnvironment,
> extends DurableObject<Environment> {
  private active: NativeHost | undefined;
  private readonly scopes = new Map<string, ConversationScope>();
  private readonly openings = new Map<string, Promise<ConversationScope>>();
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const models = createModels();
      const registry = createRegistry();
      const pi = await Harness.open(
        storage,
        {
          models,
          onReport: (error) => reportPiFailure(this.ctx.id.name, error),
          registry,
          settings: {
            extensions: [],
            followUpMode: "one-at-a-time",
            stream: { maxRetries: 0, transport: "sse" },
          },
        },
        context
      );
      const scanWorkKeys: ScanWorkKeys = (cursor) =>
        pi.commit(async () => {
          const page = await storage.scanDocuments(
            {
              scope: { kind: "session" },
              at: "current",
              kind: WorkDocuments.definition.kind,
            },
            32,
            cursor,
            piContext()
          );
          return {
            keys: page.items.flatMap((entry) => (entry.key ? [entry.key] : [])),
            ...(page.next ? { next: page.next } : {}),
          };
        }, piContext());
      const waitUntil = (promise: Promise<unknown>) => {
        if (!this.lifecycle.trackAlarmWork(promise)) {
          this.ctx.waitUntil(promise);
        }
      };
      const host: NativeHost = {
        models,
        pi,
        registry,
        scanWorkKeys,
        restoring: true,
        replies: createCoordinatorReplies({
          pi,
          persist: () => this.ctx.storage.sync(),
          resolve: (address) => this.botEventScope(address, host),
          waitUntil,
        }),
        events: createCoordinatorEvents({
          pi,
          holdReplies: () => host.replies.hold(),
          targetIn: async (tx, address) => {
            const bindings = await tx.doc(Bindings);
            const binding = bindings.conversations[address.sessionId];
            if (!binding || !sameAddress(binding.address, address)) {
              throw new NotFound({ resource: "Event coordinator binding" });
            }
            return binding;
          },
          resolve: (address) => this.botEventScope(address, host),
          scan: (cursor) =>
            pi.commit(async () => {
              const page = await storage.scanDocuments(
                {
                  scope: { kind: "session" },
                  at: "current",
                  kind: BotEventReceipts.definition.kind,
                },
                32,
                cursor,
                piContext()
              );
              return {
                keys: page.items.flatMap((entry) =>
                  entry.key ? [entry.key] : []
                ),
                ...(page.next ? { next: page.next } : {}),
              };
            }, piContext()),
          waitUntil,
        }),
      };
      const { events } = host;
      registry.install({
        name: "cerebro.bot-events",
        tasks: [events.definition, host.replies.definition],
      });
      const resetFailedIdentity = async () => {
        const end = await pi.closed;
        if (end.reason === "failed") {
          reportPiFailure(this.ctx.id.name, end.error);
          this.ctx.abort("Pi storage failed. Reopen the identity runtime.");
        }
      };
      void resetFailedIdentity();
      try {
        const bindings = await pi.snapshot(Bindings, context);
        for (const binding of Object.values(bindings?.conversations ?? {})) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- Restore every scope before the SDK resumes any persisted task.
            await this.openScope(binding.address, host, binding);
          } catch (error) {
            if (!permanentFailure(error)) {
              throw error;
            }
            reportPiFailure(this.ctx.id.name, error, binding.address);
          }
        }
        host.restoring = false;
        for (const scope of this.scopes.values()) {
          // oxlint-disable-next-line no-await-in-loop -- Install all saved definitions before progress APIs enable Pi scheduling.
          await scope.restore();
        }
        this.active = host;
        await events.restore();
        await host.replies.hold();
        return pi;
      } catch (error) {
        this.scopes.clear();
        await pi.close(context);
        throw error;
      }
    },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  // oxlint-disable-next-line class-methods-use-this -- Server and fixture subclasses authenticate the full conversation address.
  protected resolve(
    _request: Request
  ): Effect.Effect<ResolvedSessionRequest, ContractFailure> {
    return Effect.fail(
      new Unavailable({
        reason: "Identity request authentication is not configured.",
      })
    );
  }

  // oxlint-disable-next-line class-methods-use-this -- Server and fixture subclasses supply immutable per-conversation services.
  protected configure(
    _address: EventAddress,
    _metadata: MetadataTransaction,
    _importedDependencies: () => Promise<ContentDependencies>,
    _selection?: DefinitionSelection
  ): Effect.Effect<SessionHostConfiguration, ContractFailure> {
    return Effect.fail(
      new Unavailable({
        reason: "Conversation host composition is not configured.",
      })
    );
  }

  private async openScope(
    address: EventAddress,
    host: NativeHost,
    binding?: ConversationBinding,
    ancestors: ReadonlySet<string> = new Set()
  ): Promise<ConversationScope> {
    if (ancestors.has(address.sessionId)) {
      throw new InvalidInput({
        reason: "A conversation fork cannot contain a cycle.",
      });
    }
    const existing = this.scopes.get(address.sessionId);
    if (existing) {
      if (!sameAddress(existing.runtime.configuration.address, address)) {
        throw new InvalidInput({
          reason: "The conversation address does not match its scope.",
        });
      }
      return existing;
    }
    let opening = this.openings.get(address.sessionId);
    if (!opening) {
      opening = this.createScope(address, host, binding, ancestors);
      this.openings.set(address.sessionId, opening);
    }
    try {
      const scope = await opening;
      if (!sameAddress(scope.runtime.configuration.address, address)) {
        throw new InvalidInput({
          reason: "The conversation address does not match its scope.",
        });
      }
      return scope;
    } finally {
      if (this.openings.get(address.sessionId) === opening) {
        this.openings.delete(address.sessionId);
      }
    }
  }

  private async botEventScope(address: EventAddress, host: NativeHost) {
    const bindings = await host.pi.snapshot(Bindings, piContext());
    const scope = await this.openScope(
      address,
      host,
      bindings?.conversations[address.sessionId]
    );
    return await scope.eventScope();
  }

  private async createScope(
    address: EventAddress,
    host: NativeHost,
    binding?: ConversationBinding,
    ancestors: ReadonlySet<string> = new Set()
  ): Promise<ConversationScope> {
    let importedNativeId = binding?.nativeId;
    const metadata: MetadataTransaction = (operation) =>
      host.pi.commit(operation, piContext());
    const configuration = await metadata(() =>
      run(
        this.configure(
          address,
          metadata,
          () => readImportedContent(host.pi, importedNativeId),
          binding ? { version: binding.agentVersion } : undefined
        )
      )
    );
    const originKey = configuration.origin
      ? JSON.stringify([
          configuration.origin.address.organizationId,
          configuration.origin.address.agentId,
          configuration.origin.address.conversationId,
          configuration.origin.address.sessionId,
          configuration.origin.entryId,
          configuration.origin.agentVersion,
        ])
      : null;
    if (
      !sameAddress(address, configuration.address) ||
      configuration.agent.agentId !== address.agentId ||
      (binding &&
        (binding.agentVersion !== configuration.agent.version ||
          !sameAddress(binding.address, address) ||
          (binding.origin ?? null) !== originKey))
    ) {
      throw new InvalidInput({
        reason:
          "The conversation configuration does not match its durable binding.",
      });
    }
    const { origin } = configuration;
    const fork = binding
      ? undefined
      : await this.forkSource(configuration, host, ancestors);
    const scope = await ConversationScope.open(
      configuration,
      {
        publication: {
          identity: {
            agentVersion: configuration.agent.version,
            policyVersion:
              binding?.policyVersion ??
              (configuration.publicationPolicy === "primary" ? 1 : 0),
          },
          legacy: binding
            ? binding.legacyVersion === binding.agentVersion &&
              binding.policyVersion === 0
            : configuration.publicationPolicy !== "primary",
          primary: configuration.publicationPolicy === "primary",
          resolve: (version) =>
            run(
              this.configure(
                address,
                metadata,
                () => readImportedContent(host.pi, importedNativeId),
                { version, contentState: configuration.contentState }
              )
            ),
          reconcile: async (version) => {
            await configuration.reconcileVersion?.(version);
          },
          recover: () =>
            this.ctx.abort(
              "Conversation profile adoption failed. Reopen the identity runtime."
            ),
          setProvider: (provider) => host.models.setProvider(provider),
          deleteProvider: (id) => host.models.deleteProvider(id),
          uninstall: (extension) => host.registry.uninstall(extension),
        },
        harness: this.harness,
        events: host.events,
        replies: host.replies,
        install: (extension) => host.registry.install(extension),
        jobs: this.lifecycle.jobs,
        metadata,
        pi: host.pi,
        scanWorkKeys: host.scanWorkKeys,
        search: (term, signal) => this.search(address, host, term, signal),
        scheduleNotify: (target, nativeId) =>
          host.pi.commit(
            () => this.scheduleNotify(target, nativeId),
            piContext()
          ),
        storage: this.ctx.storage,
        waitUntil: (promise) => {
          if (!this.lifecycle.trackAlarmWork(promise)) {
            this.ctx.waitUntil(promise);
          }
        },
      },
      async ({ agent, extensions, provider }) => {
        for (const extension of extensions) {
          host.registry.install(extension);
        }
        host.models.setProvider(provider);
        const nativeId =
          binding?.nativeId ??
          (await host.pi.commit(async (tx) => {
            const bindings = await tx.doc(Bindings);
            const current = bindings.conversations[address.sessionId];
            if (current) {
              if (
                !sameAddress(current.address, address) ||
                current.agentVersion !== configuration.agent.version ||
                (current.origin ?? null) !== originKey
              ) {
                throw new InvalidInput({
                  reason:
                    "The public conversation changed its durable binding.",
                });
              }
              return current.nativeId;
            }
            const parentNative = fork?.native;
            const point = fork?.point;
            if (origin && !point) {
              throw new InvalidInput({
                reason: "The fork entry does not belong to its source.",
              });
            }
            const created =
              point && parentNative
                ? await tx.forkConversation(parentNative.id, point.id, {
                    ownership: { kind: "ownerless" },
                  })
                : await tx.createConversation({
                    ownership: { kind: "ownerless" },
                  });
            await configure(tx, created.id, agent);
            if (origin) {
              configuration.inheritDependencies?.(
                origin.address,
                fork?.toolIds ?? [],
                false
              );
            }
            bindings.conversations[address.sessionId] = {
              address: { ...address },
              agentVersion: configuration.agent.version,
              policyVersion:
                configuration.publicationPolicy === "primary" ? 1 : 0,
              legacyVersion:
                configuration.publicationPolicy === "primary"
                  ? null
                  : configuration.agent.version,
              refresh: null,
              releaseEvent: null,
              nativeId: created.id,
              origin: originKey,
            };
            return created.id;
          }, piContext()));
        const native = await host.pi.conversation(nativeId, piContext());
        importedNativeId = nativeId;
        if (!native) {
          throw new NotFound({ resource: "Native conversation" });
        }
        return native;
      }
    );
    this.scopes.set(address.sessionId, scope);
    if (binding) {
      await this.restoreSelections(scope, host, binding);
    }
    if (!host.restoring) {
      await scope.restore();
    }
    return scope;
  }

  private async restoreSelections(
    scope: ConversationScope,
    host: NativeHost,
    binding: ConversationBinding
  ): Promise<void> {
    const selections = await host.pi.commit(
      (tx) => selectedRegistrationsIn(tx, binding.nativeId),
      piContext()
    );
    try {
      await scope.restoreProfiles([...selections], binding.legacyVersion);
    } catch {
      this.scopes.delete(binding.address.sessionId);
      throw new Unavailable({
        reason:
          "A stored native profile could not be restored before scheduling.",
      });
    }
    await scope.runtime.configuration.reconcileVersion?.(binding.agentVersion);
  }

  private async forkSource(
    configuration: SessionHostConfiguration,
    host: NativeHost,
    ancestors: ReadonlySet<string>
  ) {
    const { origin, address } = configuration;
    if (!origin) {
      return;
    }
    if (
      origin.address.organizationId !== address.organizationId ||
      origin.address.agentId !== address.agentId ||
      origin.agentVersion !== configuration.agent.version
    ) {
      throw new InvalidInput({
        reason: "The fork configuration differs from its source.",
      });
    }
    const bindings = await host.pi.snapshot(Bindings, piContext());
    const parent =
      this.scopes.get(origin.address.sessionId) ??
      (await this.openScope(
        origin.address,
        host,
        bindings?.conversations[origin.address.sessionId],
        new Set([...ancestors, address.sessionId])
      ));
    const owner = await run(configuration.ownerContext());
    const snapshot = await parent.read(owner);
    const toolIds = snapshotToolIds(snapshot);
    const parsedId = await run(
      Effect.try({
        catch: () =>
          new InvalidInput({ reason: "The fork entry ID is invalid." }),
        try: () =>
          Schema.decodeUnknownSync(nativeEntryId)(Number(origin.entryId)),
      })
    );
    const historical = await parent.native.entries(
      { minEntryId: parsedId, maxEntryId: parsedId },
      1,
      undefined,
      piContext()
    );
    const [point] = historical.items;
    if (
      !point ||
      String(point.id) !== origin.entryId ||
      !(
        UserEntry.is(point) ||
        AssistantEntry.is(point) ||
        (await host.pi.commit(
          (tx) =>
            webEventForkPointIn(tx, {
              point,
              nativeId: parent.native.id,
              address: origin.address,
              ownerPrincipalId: owner.represented?.id ?? owner.actor.id,
            }),
          piContext()
        ))
      )
    ) {
      throw new InvalidInput({
        reason:
          "The fork entry is not a user or assistant message in its source.",
      });
    }
    return { native: parent.native, point, toolIds };
  }

  private async search(
    address: EventAddress,
    host: NativeHost,
    term: string,
    signal?: AbortSignal
  ): Promise<SearchResult> {
    const target = this.scopes.get(address.sessionId);
    if (!target) {
      throw new NotFound({ resource: "Search conversation" });
    }
    const bindings = await host.pi.snapshot(Bindings, piContext(signal));
    const { runtime } = target;
    return searchConversationHistory(
      {
        target,
        addresses: Object.values(bindings?.conversations ?? {}).map(
          (binding) => binding.address
        ),
        open: async (source) =>
          this.scopes.get(source.sessionId) ??
          (await this.openScope(
            source,
            host,
            bindings?.conversations[source.sessionId]
          )),
        metadata: (operation) =>
          host.pi.commit(async (tx) => {
            await runtime.guardIn(tx);
            return await operation();
          }, piContext(signal)),
        persist: () => this.ctx.storage.sync(),
      },
      term,
      signal
    );
  }

  private async scope(address: EventAddress): Promise<ConversationScope> {
    await this.harness.pi();
    const host = this.active;
    if (!host) {
      throw new Unavailable({ reason: "The identity runtime is unavailable." });
    }
    const bindings = await host.pi.snapshot(Bindings, piContext());
    return this.openScope(
      address,
      host,
      bindings?.conversations[address.sessionId]
    );
  }

  protected async nativeSession(address: EventAddress): Promise<string> {
    const scope = await this.scope(address);
    return String(scope.native.id);
  }

  private async scheduleNotify(
    address: EventAddress,
    nativeId: string
  ): Promise<void> {
    await this.lifecycle.jobs.push({
      fn: "cerebro-notify",
      id: `cerebro-notify:${nativeId}`,
      payload: { sessionId: address.sessionId },
      recoveryLoop: true,
      singleflight: true,
      time: Date.now() + 1000,
    });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (
      ![
        "cerebro-notify",
        "cerebro-child",
        "cerebro-reminder",
        "cerebro-compact",
        "cerebro-coordination",
      ].includes(job.fn)
    ) {
      return;
    }
    try {
      const { sessionId } = Schema.decodeUnknownSync(notifyPayload)(
        job.payload
      );
      const pi = await this.harness.pi();
      const bindings = await pi.snapshot(Bindings, piContext());
      const binding = bindings?.conversations[sessionId];
      if (binding) {
        if (job.fn === "cerebro-coordination") {
          const outcome = await wakeCoordinatorJob({
            pi,
            address: binding.address,
            restore: async () => {
              const { coordination } = await this.scope(binding.address);
              return coordination;
            },
            terminalNoticeIn: this.active
              ? terminalNoticeIn(this.active.events)
              : undefined,
          });
          const pending = await this.active?.events.wake(binding.nativeId);
          const pendingReplies = await this.active?.replies.hold(
            binding.nativeId
          );
          return pending || pendingReplies
            ? {
                rescheduleAt: Math.min(
                  typeof outcome === "object" ? outcome.rescheduleAt : Infinity,
                  Date.now() + 5000
                ),
              }
            : outcome;
        }
        const scope = await this.scope(binding.address);
        if (job.fn === "cerebro-child") {
          const payload = Schema.decodeUnknownSync(childPayload)(job.payload);
          await scope.work.stop(payload.childId);
          return;
        }
        if (job.fn === "cerebro-reminder") {
          const payload = Schema.decodeUnknownSync(ReminderPayload)(
            job.payload
          );
          return await scope.reminders.deliver(
            payload.reminderId,
            payload.occurrence,
            payload.input
          );
        }
        if (job.fn === "cerebro-compact") {
          const payload = Schema.decodeUnknownSync(CompactPayload)(job.payload);
          return await scope.compaction.run({ ...payload, kind: "compact" });
        }
        await scope.notify();
      }
    } catch (error) {
      if (permanentFailure(error)) {
        return;
      }
      return { rescheduleAt: Date.now() + 5000 };
    }
  }

  async dispose(): Promise<void> {
    await this.harness.dispose();
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const resolved = await run(this.resolve(request));
      if ("kind" in resolved && resolved.kind === "subscribed-bots") {
        await this.harness.pi();
        if (!this.active) {
          throw new Unavailable({
            reason: "The identity runtime is unavailable.",
          });
        }
        const targets = await this.active.events.listSubscribedBotSources(
          resolved.thread,
          resolved.context
        );
        return Response.json({ status: "ok", value: targets });
      }
      const { address, context } = resolved;
      const scope = await this.scope(address);
      if ("kind" in resolved && resolved.kind === "owned-event") {
        if (!this.active) {
          throw new Unavailable({
            reason: "The identity runtime is unavailable.",
          });
        }
        const receipt = await this.active.events.admit(
          resolved.admission,
          context
        );
        await this.ctx.storage.sync();
        return Response.json({
          status: "ok",
          value: { eventId: eventOf(receipt).id },
        });
      }
      if (new URL(request.url).pathname === "/fork") {
        const command = await run(
          Effect.tryPromise({
            catch: () =>
              new InvalidInput({ reason: "The fork command is invalid." }),
            try: async () =>
              Schema.decodeUnknownSync(forkCommand)(await request.json()),
          })
        );
        await scope.read(context, request.signal);
        await scope.runtime.authorize(context, "send", request.signal);
        if (
          command.destination.organizationId !== address.organizationId ||
          command.destination.agentId !== address.agentId
        ) {
          throw new InvalidInput({
            reason: "A fork must retain its company and agent.",
          });
        }
        const destination = await this.scope(command.destination);
        const { origin } = destination.runtime.configuration;
        if (
          !origin ||
          !sameAddress(origin.address, address) ||
          origin.entryId !== command.entryId
        ) {
          throw new InvalidInput({
            reason: "The destination does not reserve this fork.",
          });
        }
        await this.ctx.storage.sync();
        return Response.json({
          status: "ok",
          value: { address: destination.runtime.configuration.address },
        });
      }
      return await scope.handle(request, context);
    } catch (error) {
      const response = failureToHttp(
        toContractFailure(error, "The native chat request is unavailable.")
      );
      return Response.json(response.body, { status: response.status });
    }
  }
}
