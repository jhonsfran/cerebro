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
import type { ChatSnapshot } from "@cerebro/contracts/session-service";
import { ChatForkReceipt } from "@cerebro/contracts/session-service";
import type { ToolExecutor } from "@cerebro/contracts/tool-service";
import { createModels } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
  Harness,
  configure,
  createRegistry,
  defineDoc,
  UserEntry,
  AssistantEntry,
} from "@earendil-works/pi-durable";
import type {
  ConversationId as NativeConversationId,
  EntryId,
  JsonObject,
  Registry,
} from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome,
} from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Effect, Result, Schema } from "effect";

import type { CompanySkill } from "./company-skills.ts";
import { CompactPayload } from "./conversation-compaction.ts";
import { searchConversationHistory } from "./conversation-history.ts";
import { ReminderPayload } from "./conversation-reminders.ts";
import { ConversationScope } from "./conversation-scope.ts";
import type { SearchResult } from "./conversation-work.ts";
import { piContext, snapshotToolIds } from "./pi-harness.ts";
import type { ControlledProviderConfiguration } from "./pi-provider.ts";
import type { PiToolConfiguration, PiRegisteredTool } from "./pi-tools.ts";

export type SessionEnvironment = Readonly<Record<string, unknown>>;
export type MetadataTransaction = <A>(
  operation: () => A | Promise<A>
) => Promise<A>;
export interface SessionHostConfiguration {
  readonly address: EventAddress;
  readonly origin?: {
    readonly address: EventAddress;
    readonly entryId: string;
    readonly agentVersion: number;
  };
  readonly contentDependencies?: () => Promise<ContentDependencies>;
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
  readonly checkDependencies: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
}

interface ConversationBinding extends JsonObject {
  address: { [Key in keyof EventAddress]: EventAddress[Key] };
  agentVersion: number;
  nativeId: NativeConversationId;
  origin: string | null;
}
const Bindings = defineDoc({
  initial: (): { conversations: Record<string, ConversationBinding> } => ({
    conversations: {},
  }),
  kind: "cerebro.conversation-bindings",
  scope: "session",
  version: 1,
});
interface NativeHost {
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
            stream: { maxRetries: 0, transport: "sse" },
          },
        },
        context
      );
      const host = { models, pi, registry };
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
        this.active = host;
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
  protected resolve(_request: Request): Effect.Effect<
    {
      readonly address: EventAddress;
      readonly context: ExecutionContext;
    },
    ContractFailure
  > {
    return Effect.fail(
      new Unavailable({
        reason: "Identity request authentication is not configured.",
      })
    );
  }

  // oxlint-disable-next-line class-methods-use-this -- Server and fixture subclasses supply immutable per-conversation services.
  protected configure(
    _address: EventAddress,
    _metadata: MetadataTransaction
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

  private async createScope(
    address: EventAddress,
    host: NativeHost,
    binding?: ConversationBinding,
    ancestors: ReadonlySet<string> = new Set()
  ): Promise<ConversationScope> {
    const metadata: MetadataTransaction = (operation) =>
      host.pi.commit(operation, piContext());
    const configuration = await metadata(() =>
      run(this.configure(address, metadata))
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
        harness: this.harness,
        install: (extension) => host.registry.install(extension),
        jobs: this.lifecycle.jobs,
        metadata,
        pi: host.pi,
        search: (term, signal) => this.search(address, host, term, signal),
        scheduleNotify: (target, nativeId) =>
          host.pi.commit(
            () => this.scheduleNotify(target, nativeId),
            piContext()
          ),
        storage: this.ctx.storage,
        waitUntil: (promise) => this.ctx.waitUntil(promise),
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
              nativeId: created.id,
              origin: originKey,
            };
            return created.id;
          }, piContext()));
        const native = await host.pi.conversation(nativeId, piContext());
        if (!native) {
          throw new NotFound({ resource: "Native conversation" });
        }
        return native;
      }
    );
    this.scopes.set(address.sessionId, scope);
    return scope;
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
    if (parent.runtime.configuration.agent.version !== origin.agentVersion) {
      throw new InvalidInput({
        reason: "The fork agent version differs from its source.",
      });
    }
    const snapshot = await parent.read(await run(configuration.ownerContext()));
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
      !(UserEntry.is(point) || AssistantEntry.is(point))
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
        metadata: (operation) => host.pi.commit(operation, piContext(signal)),
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
      const { address, context } = await run(this.resolve(request));
      const scope = await this.scope(address);
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
