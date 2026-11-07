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
import { InspectionQuery } from "@cerebro/contracts/inspection";
import type { ReadOptions } from "@cerebro/contracts/port";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import type { ToolExecutor } from "@cerebro/contracts/tool-service";
import type {
  ReplyPorts,
  TriggerAdmissionInput,
} from "@cerebro/contracts/triggers";
import type { SlackThread } from "@cerebro/contracts/work";
import { createModels } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { Harness, configure, createRegistry } from "@earendil-works/pi-durable";
import type { Registry, Storage } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome,
} from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import type { CompanySkill } from "./company-skills.ts";
import { initializeContentSchema } from "./content-dependency-store.ts";
import type { createSourceDependencyStore } from "./content-dependency-store.ts";
import { Bindings } from "./conversation-bindings.ts";
import type { ConversationBinding } from "./conversation-bindings.ts";
import { CompactPayload } from "./conversation-compaction.ts";
import { selectedRegistrationsIn } from "./conversation-drain.ts";
import { readConversationInspection } from "./conversation-inspection.ts";
import type { InspectionAccess } from "./conversation-inspection.ts";
import { ReminderPayload } from "./conversation-reminders.ts";
import { ConversationScope } from "./conversation-scope.ts";
import { terminalNoticeIn } from "./coordinator-event-content.ts";
import type { ScanWorkKeys } from "./coordinator-history.ts";
import { WorkDocuments } from "./coordinator-ledger.ts";
import { wakeCoordinatorJob } from "./coordinator-work.ts";
import type { CoordinationServices } from "./coordinator-work.ts";
import { readImportedContent } from "./imported-content.ts";
import { scanInspectionKeys } from "./inspection-page.ts";
import { piContext } from "./pi-harness.ts";
import type { ControlledProviderConfiguration } from "./pi-provider.ts";
import type { PiToolConfiguration, PiRegisteredTool } from "./pi-tools.ts";
import { createReplies } from "./replies.ts";
import type { ReplyOutbox } from "./replies.ts";
import { Receipts, createTriggers } from "./triggers.ts";
import type { Triggers } from "./triggers.ts";

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
      readonly admission: TriggerAdmissionInput;
    };
export interface SessionHostConfiguration {
  readonly replyPorts?: ReplyPorts;
  readonly contentState?: ReturnType<typeof createSourceDependencyStore>;
  readonly reconcileVersion?: (version: number) => Promise<void>;
  readonly address: EventAddress;
  readonly coordination?: CoordinationServices;
  readonly contentDependencies?: () => Promise<ContentDependencies>;
  readonly importDependencies?: (dependencies: ContentDependencies) => void;
  readonly checkImportedDependencies?: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
  readonly agent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly executor: ToolExecutor;
  readonly provider: Omit<ControlledProviderConfiguration, "authorize">;
  readonly tools: readonly PiRegisteredTool[];
  // Company skills the model can activate by name; their bodies load on demand.
  readonly skills?: readonly CompanySkill[];
  readonly ownerContext: () => Effect.Effect<ExecutionContext, ContractFailure>;
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
  readonly store: Storage;
  restoring: boolean;
  readonly triggers: Triggers;
  readonly replies: ReplyOutbox;
  readonly scanWorkKeys: ScanWorkKeys;
  readonly pi: Harness;
  readonly models: MutableModels;
  readonly registry: Registry;
}
const jobPayload = Schema.Struct({ sessionId: Schema.NonEmptyString });
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
            followUpMode: "all",
            stream: { maxRetries: 0, transport: "sse" },
          },
        },
        context
      );
      const scanWorkKeys: ScanWorkKeys = (cursor) =>
        scanInspectionKeys(pi, storage, WorkDocuments.definition.kind, cursor);
      const waitUntil = (promise: Promise<unknown>) => {
        this.lifecycle.trackAlarmWork(promise);
        this.ctx.waitUntil(promise);
      };
      const host: NativeHost = {
        store: storage,
        models,
        pi,
        registry,
        scanWorkKeys,
        restoring: true,
        replies: createReplies({
          pi,
          persist: () => this.ctx.storage.sync(),
          resolve: async (address) => {
            const scope = await this.boundScope(address, host);
            return scope.replyScope();
          },
          waitUntil,
        }),
        triggers: createTriggers({
          pi,
          targetIn: async (tx, address) => {
            const bindings = await tx.doc(Bindings);
            const binding = bindings.conversations[address.sessionId];
            if (!binding || !sameAddress(binding.address, address)) {
              throw new NotFound({ resource: "Event coordinator binding" });
            }
            return binding;
          },
          resolve: async (address) => {
            const scope = await this.boundScope(address, host);
            return await scope.triggerScope();
          },
          scan: (cursor) =>
            scanInspectionKeys(pi, storage, Receipts.definition.kind, cursor),
          waitUntil,
        }),
      };
      registry.install({
        name: "cerebro.bot-events",
        tasks: [host.replies.definition],
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
        await pi.commit(
          () => initializeContentSchema(this.ctx.storage),
          context
        );
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
        waitUntil(
          host.triggers.drainAll(
            Object.values(bindings?.conversations ?? {}).map(
              (binding) => binding.nativeId
            )
          )
        );
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

  // oxlint-disable-next-line class-methods-use-this -- Server subclasses provide current read authority and private transport.
  protected inspectionAccess(): InspectionAccess {
    throw new Unavailable({
      reason: "Inspection read access is not configured.",
    });
  }

  private async openScope(
    address: EventAddress,
    host: NativeHost,
    binding?: ConversationBinding
  ): Promise<ConversationScope> {
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
      opening = this.createScope(address, host, binding);
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

  private async boundScope(address: EventAddress, host: NativeHost) {
    const bindings = await host.pi.snapshot(Bindings, piContext());
    return await this.openScope(
      address,
      host,
      bindings?.conversations[address.sessionId]
    );
  }

  private async createScope(
    address: EventAddress,
    host: NativeHost,
    binding?: ConversationBinding
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
    if (
      !sameAddress(address, configuration.address) ||
      configuration.agent.agentId !== address.agentId ||
      (binding &&
        (binding.agentVersion !== configuration.agent.version ||
          !sameAddress(binding.address, address)))
    ) {
      throw new InvalidInput({
        reason:
          "The conversation configuration does not match its durable binding.",
      });
    }
    const scope = await ConversationScope.open(
      configuration,
      {
        publication: {
          identity: { agentVersion: configuration.agent.version },
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
        triggers: host.triggers,
        replies: host.replies,
        install: (extension) => host.registry.install(extension),
        jobs: this.lifecycle.jobs,
        metadata,
        pi: host.pi,
        scanWorkKeys: host.scanWorkKeys,
        storage: this.ctx.storage,
        waitUntil: (promise) => {
          this.lifecycle.trackAlarmWork(promise);
          this.ctx.waitUntil(promise);
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
                current.agentVersion !== configuration.agent.version
              ) {
                throw new InvalidInput({
                  reason:
                    "The public conversation changed its durable binding.",
                });
              }
              return current.nativeId;
            }
            const created = await tx.createConversation({
              ownership: { kind: "ownerless" },
            });
            await configure(tx, created.id, agent);
            bindings.conversations[address.sessionId] = {
              address: { ...address },
              agentVersion: configuration.agent.version,
              refresh: null,
              nativeId: created.id,
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
      await scope.restoreProfiles([...selections]);
    } catch {
      this.scopes.delete(binding.address.sessionId);
      throw new Unavailable({
        reason:
          "A stored native profile could not be restored before scheduling.",
      });
    }
    await scope.runtime.configuration.reconcileVersion?.(binding.agentVersion);
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

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (
      !["cerebro-reminder", "cerebro-compact", "cerebro-coordination"].includes(
        job.fn
      )
    ) {
      return;
    }
    try {
      const { sessionId } = Schema.decodeUnknownSync(jobPayload)(job.payload);
      const pi = await this.harness.pi();
      const bindings = await pi.snapshot(Bindings, piContext());
      const binding = bindings?.conversations[sessionId];
      if (binding) {
        if (job.fn === "cerebro-coordination") {
          const source = await this.scope(binding.address);
          await source.reminders.restore();
          const outcome = await wakeCoordinatorJob({
            pi,
            address: binding.address,
            restore: async () => {
              const { coordination } = await this.scope(binding.address);
              return coordination;
            },
            terminalNoticeIn: this.active
              ? terminalNoticeIn(this.active.triggers)
              : undefined,
          });
          const waiting =
            (await this.active?.triggers.drain(binding.nativeId)) === "waiting";
          const pendingReplies = await this.active?.replies.hold(
            binding.nativeId
          );
          // Placed triggers bypass the harness's own wake, so this job is the alarm that resumes Pi after an eviction.
          const unsettled = await this.harness.pending({
            session: String(binding.nativeId),
          });
          const delay = waiting ? 1000 : 5000;
          return waiting || pendingReplies || unsettled.length > 0
            ? {
                rescheduleAt: Math.min(
                  typeof outcome === "object" ? outcome.rescheduleAt : Infinity,
                  Date.now() + delay
                ),
              }
            : outcome;
        }
        const scope = await this.scope(binding.address);
        if (job.fn === "cerebro-reminder") {
          const payload = Schema.decodeUnknownSync(ReminderPayload)(
            job.payload
          );
          return await scope.reminders.deliver(
            payload.reminderId,
            payload.occurrence
          );
        }
        if (job.fn === "cerebro-compact") {
          const payload = Schema.decodeUnknownSync(CompactPayload)(job.payload);
          return await scope.compaction.run({ ...payload, kind: "compact" });
        }
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
        const targets = await this.active.triggers.listSubscribedBotSources(
          resolved.thread,
          resolved.context
        );
        return Response.json({ status: "ok", value: targets });
      }
      const { address, context } = resolved;
      if (new URL(request.url).pathname === "/inspect") {
        const query = Schema.decodeUnknownSync(InspectionQuery, {
          onExcessProperty: "error",
        })(await request.json());
        await this.harness.pi();
        const host = this.active;
        if (!host) {
          throw new Unavailable({
            reason: "The identity runtime is unavailable.",
          });
        }
        return Response.json(
          await readConversationInspection({
            pi: host.pi,
            storage: this.ctx.storage,
            address,
            context,
            query,
            signal: request.signal,
            access: this.inspectionAccess(),
            scanWorkKeys: host.scanWorkKeys,
            scanEventKeys: (cursor) =>
              scanInspectionKeys(
                host.pi,
                host.store,
                Receipts.definition.kind,
                cursor
              ),
          })
        );
      }
      const scope = await this.scope(address);
      if ("kind" in resolved && resolved.kind === "owned-event") {
        if (!this.active) {
          throw new Unavailable({
            reason: "The identity runtime is unavailable.",
          });
        }
        const receipt = await this.active.triggers.admit(
          resolved.admission,
          context
        );
        await this.ctx.storage.sync();
        return Response.json({
          status: "ok",
          value: { eventId: receipt.trigger.id },
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
