/* oxlint-disable no-await-in-loop -- Profile retries and exact restoration depend on the previous native boundary. */
import {
  Denied,
  InvalidInput,
  Unavailable,
  NotFound,
  failureToHttp,
  toContractFailure,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type {
  ChatControl as ChatControlValue,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { ChatControl } from "@cerebro/contracts/session-service";
import { TeamEventReturnSchema } from "@cerebro/contracts/team-events";
import { TeamReportDeliverySchema } from "@cerebro/contracts/work";
import type { Provider } from "@earendil-works/pi-ai/models";
import { configure } from "@earendil-works/pi-durable";
import type {
  AgentChange,
  Conversation,
  Extension,
  Harness,
  Tx,
} from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import type { LifecycleJobs } from "agents/lifecycle";
import { Effect, Result, Schema } from "effect";

import type { createApprovalStore } from "./approval-store.ts";
import { companySkillsExtension } from "./company-skills.ts";
import {
  Bindings,
  ProfileChanged,
  profileKey,
  requireProfileIn,
  sameProfile,
} from "./conversation-bindings.ts";
import type { ProfileIdentity } from "./conversation-bindings.ts";
import {
  nativeDrainIn,
  selectedRegistrationsIn,
} from "./conversation-drain.ts";
import { createNativeOperations } from "./conversation-native-operations.ts";
import { observeConversation } from "./conversation-observation.ts";
import {
  createConversationProfile,
  profileInstructions,
} from "./conversation-profile.ts";
import type {
  ConversationProfile,
  ProfileState,
} from "./conversation-profile.ts";
import { conversationProvider } from "./conversation-provider.ts";
import { createReminderSerialization } from "./conversation-reminders.ts";
import { createConversationResources } from "./conversation-resources.ts";
import { conversationSnapshot } from "./conversation-snapshot.ts";
import type { ScanWorkKeys } from "./coordinator-history.ts";
import { sameWorkSource, CoordinatorAdmissions } from "./coordinator-ledger.ts";
import { piContext, snapshotToolIds } from "./pi-harness.ts";
import { profileReplyScope } from "./replies.ts";
import type { ReplyOutbox, ReplyScope } from "./replies.ts";
import { submitSavedTimer } from "./saved-timer-submit.ts";
import type {
  MetadataTransaction,
  SessionHostConfiguration,
} from "./session-agent.ts";
import { profileTriggerScope } from "./triggers.ts";
import type { TriggerScope, Triggers } from "./triggers.ts";

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
  operationId: Schema.NonEmptyString.check(
    Schema.isMaxLength(512),
    Schema.makeFilter((value) => value.trim() === value)
  ),
  text: Schema.NonEmptyString.check(Schema.isMaxLength(16_000)),
});
const decisionSchema = Schema.Struct({
  approvalId: Schema.NonEmptyString,
  decision: Schema.Literals(["allow", "deny"]),
});

export interface ConversationScopeServices {
  readonly publication?: {
    readonly identity: ProfileIdentity;
    readonly resolve: (
      version: number | "latest"
    ) => Promise<SessionHostConfiguration>;
    readonly reconcile: (version: number) => Promise<void>;
    readonly recover: () => void;
    readonly setProvider: (provider: Provider) => void;
    readonly deleteProvider: (id: string) => void;
    readonly uninstall: (extension: Extension) => void;
  };
  readonly triggers: Triggers;
  readonly replies: ReplyOutbox;
  readonly scanWorkKeys: ScanWorkKeys;
  readonly jobs: LifecycleJobs;
  readonly install: (extension: Extension) => void;
  readonly pi: Harness;
  readonly harness: PiHarness;
  readonly storage: DurableObjectStorage;
  readonly metadata: MetadataTransaction;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}
export interface ConversationRegistration {
  readonly agent: AgentChange;
  readonly extensions: readonly Extension[];
  readonly provider: Provider;
}

export class ConversationScope {
  readonly native: Conversation;
  private readonly services: ConversationScopeServices;
  private readonly shared: ProfileState;
  private current: ConversationProfile | undefined;
  private unavailable = false;
  private readonly profiles = new Map<string, ConversationProfile>();
  private readonly nativeOperations: ReturnType<typeof createNativeOperations>;
  private advancing: Promise<"open" | "waiting"> | undefined;

  private get profile(): ConversationProfile {
    if (this.unavailable || !this.current) {
      throw new Unavailable({
        reason: "The conversation profile is unavailable.",
      });
    }
    return this.current;
  }
  private recoverProfile(): void {
    this.unavailable = true;
    queueMicrotask(() => this.services.publication?.recover());
  }
  get runtime() {
    return this.profile.runtime;
  }
  get reminders() {
    return this.profile.reminders;
  }
  get compaction() {
    return this.profile.compaction;
  }
  get coordination() {
    return this.profile.coordination;
  }

  private constructor(
    native: Conversation,
    services: ConversationScopeServices,
    approvals: ReturnType<typeof createApprovalStore>
  ) {
    this.native = native;
    this.services = services;
    this.nativeOperations = createNativeOperations({
      pi: services.pi,
      current: () => this.profile,
      guardIn: (tx, profile, admission) =>
        this.guardIn(tx, profile.identity, admission),
    });
    this.shared = {
      approvals,
      serialize: createReminderSerialization(),
      guardIn: (identity) => (tx) => this.guardIn(tx, identity),
      requireCurrent: (identity) => {
        if (!sameProfile(this.profile.identity, identity)) {
          throw new ProfileChanged();
        }
      },
      nativeGuardIn: (identity) => (tx) => this.guardIn(tx, identity, true),
      submitOccurrence: (occurrence) =>
        submitSavedTimer({
          pi: services.pi,
          nativeId: native.id,
          triggers: services.triggers,
          current: () => this.profile,
          occurrence,
        }),
      submit: (text, operationId) =>
        this.nativeOperations.run(
          async (profile) => {
            await profile.runtime.authorize(
              await run(profile.runtime.configuration.ownerContext()),
              "send"
            );
          },
          () =>
            services.harness.submit(text, {
              operationId,
              session: String(native.id),
            }),
          true
        ),
      dispatchAccess: () => {
        const { runtime } = this.profile;
        const currentConfiguration = runtime.configuration;
        return Promise.resolve({
          services: currentConfiguration.coordination,
          authorize: async (signal) =>
            runtime.authorize(
              await run(currentConfiguration.ownerContext()),
              "coordinate",
              signal
            ),
          checkDependencies: async (dependencies, signal) => {
            const owner = await run(currentConfiguration.ownerContext());
            await runtime.authorize(owner, "transfer", signal);
            await run(
              currentConfiguration.checkDependencies(owner, dependencies, {
                deadlineAt: Date.now() + 30_000,
                signal,
              })
            );
          },
        });
      },
    };
  }

  private async guardIn(
    tx: Tx,
    identity: ProfileIdentity,
    native = false
  ): Promise<void> {
    if (this.unavailable) {
      throw new Unavailable({
        reason: "The conversation profile is unavailable.",
      });
    }
    if (this.services.publication) {
      const binding = await requireProfileIn(
        tx,
        this.runtime.configuration.address.sessionId,
        identity
      );
      if (native && binding.refresh) {
        throw new Unavailable({
          reason: "The conversation is waiting for a safe profile boundary.",
          retryAfter: 1,
        });
      }
    } else if (this.current && !sameProfile(this.current.identity, identity)) {
      throw new ProfileChanged();
    }
  }

  static async open(
    configuration: SessionHostConfiguration,
    services: ConversationScopeServices,
    bind: (registration: ConversationRegistration) => Promise<Conversation>
  ): Promise<ConversationScope> {
    const identity = services.publication?.identity ?? {
      agentVersion: configuration.agent.version,
    };
    const runtime = createConversationResources(
      configuration,
      services.storage,
      services.metadata
    );
    const suffix = profileKey(identity);
    const provider = conversationProvider(
      configuration.address.sessionId,
      configuration.provider.model,
      runtime.provider,
      suffix
    );
    const extension = {
      name: `cerebro-tools:${configuration.address.sessionId}:${suffix}`,
      tools: runtime.tools,
    };
    const initialExtensions: Extension[] = [extension];
    if (configuration.skills?.length) {
      initialExtensions.push({
        ...(await companySkillsExtension(configuration.skills)),
        name: `cerebro-skills:${configuration.address.sessionId}:${suffix}`,
      });
    }
    const native = await bind({
      agent: {
        extensions: initialExtensions,
        instructions: profileInstructions(configuration),
        tools: null,
        modelTools: null,
        model: {
          modelId: configuration.provider.model.id,
          provider: provider.id,
        },
      },
      extensions: initialExtensions,
      provider,
    });
    const scope = new ConversationScope(native, services, runtime.approvals);
    const profile = await scope.prepare(configuration, identity);
    scope.current = profile;
    services.install({
      name: `cerebro-state:${configuration.address.sessionId}`,
      tasks: profile.coordination.tasks,
    });
    if (services.publication) {
      services.pi.subscribeCommits((publication) => {
        for (const change of publication.changes) {
          if (
            change.type !== "document" ||
            change.record.kind !== Bindings.definition.kind ||
            !change.value
          ) {
            continue;
          }
          try {
            const versions = Schema.decodeUnknownSync(
              Schema.Struct({
                conversations: Schema.Record(
                  Schema.String,
                  Schema.Struct({ agentVersion: Schema.Number })
                ),
              })
            )(change.value);
            const next =
              versions.conversations[configuration.address.sessionId];
            if (!next || sameProfile(scope.profile.identity, next)) {
              continue;
            }
            const prepared = scope.profiles.get(profileKey(next));
            if (!prepared) {
              throw new Error(
                "The adopted conversation profile was not prepared."
              );
            }
            scope.current = prepared;
          } catch {
            scope.recoverProfile();
          }
        }
      });
    }
    return scope;
  }

  private async prepare(
    configuration: SessionHostConfiguration,
    identity: ProfileIdentity
  ): Promise<ConversationProfile> {
    if (configuration.agent.version !== identity.agentVersion) {
      throw new Unavailable({
        reason: "The prepared definition does not match its profile identity.",
      });
    }
    const profile = await createConversationProfile(
      configuration,
      this.services,
      this.native,
      this.shared,
      identity
    );
    for (const extension of profile.registration.extensions) {
      this.services.install(extension);
    }
    this.services.publication?.setProvider(profile.registration.provider);
    this.profiles.set(profileKey(identity), profile);
    return profile;
  }

  private async prepareTarget(
    target: ProfileIdentity
  ): Promise<ConversationProfile> {
    try {
      const prepared = this.profiles.get(profileKey(target));
      if (prepared) {
        return prepared;
      }
      const configuration = await this.services.publication?.resolve(
        target.agentVersion
      );
      if (!configuration) {
        throw new Unavailable({ reason: "The publication is unavailable." });
      }
      return await this.prepare(configuration, target);
    } catch (error) {
      this.recoverProfile();
      throw error;
    }
  }

  async restoreProfiles(
    providers: readonly (string | undefined)[]
  ): Promise<void> {
    const { publication } = this.services;
    if (!publication) {
      return;
    }
    const { sessionId } = this.runtime.configuration.address;
    const prefixes = [
      `cerebro:${sessionId}`,
      `cerebro-tools:${sessionId}`,
      `cerebro-skills:${sessionId}`,
    ];
    for (const provider of new Set(providers)) {
      const prefix = prefixes.find(
        (value) => provider === value || provider?.startsWith(`${value}:`)
      );
      if (!provider || !prefix) {
        continue;
      }
      const parts = provider
        .slice(prefix.length)
        .match(/^:v(?<version>[1-9][0-9]*)$/u);
      if (!parts) {
        throw new Unavailable({
          reason: "A native profile selection is invalid.",
        });
      }
      const identity: ProfileIdentity = {
        agentVersion: Number(parts.groups?.version),
      };
      if (this.profiles.has(profileKey(identity))) {
        continue;
      }
      await this.prepare(
        await publication.resolve(identity.agentVersion),
        identity
      );
    }
  }

  /**
   * The publication gate. "open": the bound definition is current and the next placement may run under it.
   * "waiting": a newer definition is published and Pi has not drained, so inputs stay in the backlog.
   */
  async advancePublication(): Promise<"open" | "waiting"> {
    if (!this.services.publication) {
      return "open";
    }
    this.advancing ??= this.advance();
    const { advancing } = this;
    try {
      return await advancing;
    } finally {
      if (this.advancing === advancing) {
        this.advancing = undefined;
      }
    }
  }

  private async advance(): Promise<"open" | "waiting"> {
    const { publication } = this.services;
    if (!publication) {
      return "open";
    }
    const { address } = this.runtime.configuration;
    const initialBindings = await this.services.pi.snapshot(
      Bindings,
      piContext()
    );
    let binding = initialBindings?.conversations[address.sessionId];
    if (!binding) {
      return "open";
    }
    const latest = await publication.resolve("latest");
    const wanted: ProfileIdentity = { agentVersion: latest.agent.version };
    const stale = binding.refresh
      ? wanted.agentVersion > binding.refresh.agentVersion
      : !sameProfile(binding, wanted);
    if (stale) {
      const observed = binding;
      await this.services.pi.commit(async (tx) => {
        const bindings = await tx.doc(Bindings);
        const current = bindings.conversations[address.sessionId];
        if (current && sameProfile(current, observed)) {
          current.refresh = wanted;
        }
      }, piContext());
      const frozenBindings = await this.services.pi.snapshot(
        Bindings,
        piContext()
      );
      binding = frozenBindings?.conversations[address.sessionId];
    }
    const target = binding?.refresh;
    if (!target) {
      return "open";
    }
    const candidate = await this.prepareTarget(target);
    const activated = await this.services.pi.commit(async (tx) => {
      const bindings = await tx.doc(Bindings);
      const current = bindings.conversations[address.sessionId];
      if (
        !current?.refresh ||
        !sameProfile(current.refresh, target) ||
        this.nativeOperations.pending() ||
        this.shared.approvals.hasPending()
      ) {
        return false;
      }
      const leases = await tx.doc(CoordinatorAdmissions, this.native.id);
      if (
        Object.values(leases.leases).some((until) => until > Date.now()) ||
        !(await nativeDrainIn(tx, this.native.id))
      ) {
        return false;
      }
      await configure(tx, this.native.id, candidate.registration.agent);
      current.agentVersion = target.agentVersion;
      current.refresh = null;
      return true;
    }, piContext());
    if (!activated) {
      return "waiting";
    }
    await publication.reconcile(target.agentVersion);
    const selected = await this.services.pi.commit(
      (tx) => selectedRegistrationsIn(tx, this.native.id),
      piContext()
    );
    for (const [key, profile] of this.profiles) {
      if (
        profile === this.current ||
        profile.registration.extensions.some((extension) =>
          selected.has(extension.name)
        ) ||
        selected.has(profile.registration.provider.id)
      ) {
        continue;
      }
      for (const extension of profile.registration.extensions) {
        publication.uninstall(extension);
      }
      publication.deleteProvider(profile.registration.provider.id);
      this.profiles.delete(key);
    }
    return "open";
  }

  async restore(): Promise<void> {
    await this.reminders.restore();
    await this.coordination.restore();
  }

  async triggerScope(): Promise<TriggerScope> {
    const { profile } = this;
    return await profileTriggerScope(profile, {
      native: this.native,
      isCurrent: () => this.current === profile && !this.unavailable,
      gate: () => this.advancePublication(),
    });
  }

  replyScope(): ReplyScope {
    const { profile } = this;
    return profileReplyScope({
      runtime: profile.runtime,
      requireCurrent: () => {
        if (this.current !== profile || this.unavailable) {
          throw new ProfileChanged();
        }
      },
    });
  }

  private async control(
    command: ChatControlValue,
    context: ExecutionContext,
    signal?: AbortSignal
  ) {
    const { profile } = this;
    const { runtime, coordination, reminders, compaction } = profile;
    let permission: "coordinate" | "stop" | "send" = "send";
    if (command.kind === "stop-work") {
      permission = "coordinate";
    } else if (command.kind === "cancel-schedule") {
      permission = "stop";
    }
    await runtime.authorize(context, permission, signal);
    if (command.kind === "stop-work") {
      await coordination.cancel({ ...command, signal });
      return { id: command.workId, kind: command.kind };
    }
    if (command.kind === "cancel-schedule") {
      const value = await reminders.cancel(command.scheduleId);
      return { id: value.id, kind: command.kind };
    }
    if (command.kind === "schedule") {
      const value = await reminders.schedule(
        command,
        command.operationId,
        signal
      );
      return { id: value.id, kind: command.kind };
    }
    return {
      id: String(await compaction.request(command)),
      kind: command.kind,
    };
  }

  async read(
    context: ExecutionContext,
    signal?: AbortSignal
  ): Promise<ChatSnapshot> {
    return await this.readFrame(context, signal);
  }

  private async readFrame(
    context: ExecutionContext,
    signal?: AbortSignal,
    emit?: (snapshot: ChatSnapshot) => void
  ): Promise<ChatSnapshot> {
    for (;;) {
      const { profile } = this;
      let snapshot: ChatSnapshot;
      try {
        await profile.runtime.authorize(context, "read", signal);
        const watch = await this.native.watch(piContext(signal));
        try {
          snapshot = await conversationSnapshot(
            {
              pi: this.services.pi,
              triggers: this.services.triggers,
              native: this.native,
            },
            watch.value,
            profile
          );
          await profile.runtime.authorize(
            context,
            "read",
            signal,
            snapshotToolIds(snapshot)
          );
        } finally {
          await watch.stop();
        }
      } catch (error) {
        if (profile !== this.profile) {
          continue;
        }
        throw error;
      }
      if (profile !== this.profile) {
        continue;
      }
      emit?.(snapshot);
      return snapshot;
    }
  }

  async handle(request: Request, context: ExecutionContext): Promise<Response> {
    const retryBody =
      request.method === "POST" ? await request.clone().text() : undefined;
    try {
      const { profile } = this;
      const { runtime } = profile;
      const path = new URL(request.url).pathname;
      if (path === "/observe") {
        return await observeConversation(
          {
            native: this.native,
            pi: this.services.pi,
            revalidate: this.shared.approvals.revalidate,
            readFrame: (caller, signal, emit) =>
              this.readFrame(caller, signal, emit),
          },
          context,
          request.signal
        );
      }
      if (path === "/read") {
        return Response.json({
          status: "ok",
          value: await this.read(context, request.signal),
        });
      }
      if (path === "/stop") {
        const stopped = await this.nativeOperations.run(
          (active) => active.runtime.authorize(context, "stop", request.signal),
          async () => {
            await this.services.triggers.withdraw(this.native.id);
            return await this.services.harness.abort({
              session: String(this.native.id),
            });
          },
          false,
          request.signal
        );
        return Response.json({
          status: "ok",
          value: {
            stopped,
          },
        });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new InvalidInput({ reason: "Invalid chat command JSON." });
      }
      if (path === "/team-report") {
        const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
          onExcessProperty: "error",
        })(body);
        return Response.json(
          await profile.receiveReport(delivery, context, request.signal)
        );
      }
      if (path === "/team-event-return") {
        const delivery = Schema.decodeUnknownSync(TeamEventReturnSchema, {
          onExcessProperty: "error",
        })(body);
        if (
          !sameWorkSource(
            delivery.work.sourceEventAddress,
            this.runtime.configuration.address
          )
        ) {
          throw new Denied({
            code: "unauthorized",
            reason: "The event return belongs to another source.",
          });
        }
        return Response.json(
          await this.services.triggers.receiveReturn(delivery, context)
        );
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
        return Response.json({
          status: "ok",
          value: await profile.web.send(
            command.operationId,
            command.text,
            context,
            request.signal
          ),
        });
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
        const value = await pi.commit(async (tx) => {
          await runtime.guardIn(tx);
          return runtime.approvals.decide(command.approvalId, command.decision);
        }, piContext(request.signal));
        await this.services.storage.sync();
        return Response.json({
          status: "ok",
          value: { approvalId: value.approvalId, state: value.state },
        });
      }
      throw new NotFound({ resource: "Chat route" });
    } catch (error) {
      if (error instanceof ProfileChanged && !request.signal.aborted) {
        return await this.handle(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: retryBody,
            signal: request.signal,
          }),
          context
        );
      }
      if (error instanceof Denied) {
        this.shared.approvals.revalidate();
      }
      const response = failureToHttp(
        toContractFailure(error, "The native chat request is unavailable.")
      );
      return Response.json(response.body, { status: response.status });
    }
  }
}
