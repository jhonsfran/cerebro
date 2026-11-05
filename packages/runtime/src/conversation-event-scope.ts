import type { BotEvent } from "@cerebro/contracts/bot-events";
import { normalizeEventAdmission } from "@cerebro/contracts/bot-routing";
import { Denied, NotFound } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { SlackReplyDestination } from "@cerebro/contracts/slack-events";
import type { Conversation, Tx } from "@earendil-works/pi-durable";
import { Effect, Result } from "effect";

import { Bindings, ProfileChanged } from "./conversation-bindings.ts";
import type { ConversationProfile } from "./conversation-profile.ts";
import { eventOf } from "./coordinator-event-state.ts";
import type { BotEventScope, EventRouteIn } from "./coordinator-events.ts";
import type {
  CoordinatorReplyOutbox,
  ReplyAnswer,
} from "./coordinator-replies.ts";
import { requireFreshSourceIn } from "./source-admission.ts";

const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};
export const createConversationEventScope = async (
  profile: ConversationProfile,
  options: {
    readonly native: Conversation;
    readonly replies?: CoordinatorReplyOutbox;
    readonly publication: boolean;
    readonly isCurrent: () => boolean;
    readonly advancePublication: (eventId: string) => Promise<boolean>;
  }
): Promise<BotEventScope> => {
  const { runtime, coordination, subscriptions, web } = profile;
  const { configuration } = runtime;
  const requireCurrent = () => {
    if (!options.isCurrent()) {
      throw new ProfileChanged();
    }
  };
  const coherent = async <A>(operation: () => Promise<A>): Promise<A> => {
    try {
      return await operation();
    } finally {
      requireCurrent();
    }
  };
  const owner = await coherent(() => run(configuration.ownerContext()));
  const guarded =
    (operation: EventRouteIn): EventRouteIn =>
    async (tx) => {
      await runtime.guardIn(tx);
      return await operation(tx);
    };
  const prepareReply = async (
    event: BotEvent
  ): Promise<(tx: Tx, answer: ReplyAnswer) => Promise<void>> => {
    const outbox = options.replies;
    if (!outbox) {
      return () => Promise.resolve();
    }
    const origin = await coherent(() => outbox.origin(event));
    if (!origin) {
      return () => Promise.resolve();
    }
    const recorded = await coherent(
      () =>
        configuration.contentDependencies?.() ??
        Promise.resolve({ sourceIds: [], toolIds: [] })
    );
    const dependencies: ContentDependencies = {
      sourceIds: [
        ...new Set([...recorded.sourceIds, ...event.dependencies.sourceIds]),
      ],
      toolIds: [
        ...new Set([...recorded.toolIds, ...event.dependencies.toolIds]),
      ],
    };
    let destination: SlackReplyDestination | null = null;
    let blocked = false;
    try {
      const port = configuration.eventReplies;
      if (!port) {
        throw new Denied({
          code: "revoked",
          reason: "Reply delivery is unavailable.",
        });
      }
      await coherent(async () => {
        const caller = await run(configuration.ownerContext());
        await runtime.authorize(caller, "read");
        await run(
          configuration.checkDependencies(caller, dependencies, {
            deadlineAt: Date.now() + 30_000,
          })
        );
        destination =
          origin.kind === "saved-timer"
            ? origin.destination
            : await port.destination(origin.event);
        await port.authorize(destination);
      });
    } catch (error) {
      if (!(error instanceof Denied || error instanceof NotFound)) {
        throw error;
      }
      blocked = true;
    }
    return async (tx, answer) => {
      await runtime.guardIn(tx);
      await outbox.enqueueIn(tx, {
        event,
        nativeId: options.native.id,
        answer,
        destination,
        dependencies,
        blocked,
      });
    };
  };
  return {
    native: options.native,
    requireCurrent,
    agentVersion: configuration.agent.version,
    policyVersion: profile.identity.policyVersion,
    prepareAdmission: async (eventId) =>
      (await options.advancePublication(eventId)) && options.isCurrent(),
    claimIn: async (tx, eventId) => {
      await runtime.guardIn(tx);
      if (!options.publication) {
        return true;
      }
      const bindings = await tx.doc(Bindings);
      const binding = bindings.conversations[configuration.address.sessionId];
      if (
        !binding ||
        binding.refresh ||
        (binding.releaseEvent && binding.releaseEvent !== eventId)
      ) {
        return false;
      }
      binding.releaseEvent = null;
      return true;
    },
    ownerPrincipalId: owner.represented?.id ?? owner.actor.id,
    admissions: coordination.admissions,
    prepareRoute: (input, context) =>
      coherent(async () => {
        const fresh =
          (operation: EventRouteIn): EventRouteIn =>
          async (tx) => {
            if (normalizeEventAdmission(input).routing.kind === "automatic") {
              await requireFreshSourceIn(tx, options.native.id);
            }
            return await operation(tx);
          };
        if (configuration.coordination) {
          return guarded(fresh(await subscriptions.prepare(input, context)));
        }
        if (normalizeEventAdmission(input).routing.kind !== "automatic") {
          throw new Denied({
            code: "revoked",
            reason: "Team coordination is disabled.",
          });
        }
        return guarded(
          fresh(() => Promise.resolve({ kind: "coordinator" as const }))
        );
      }),
    prepareLocalControl: (...args) =>
      coherent(async () => {
        const replyIn = await prepareReply(args[0]);
        const localIn = await web.prepareLocalControl(...args, (tx, answer) =>
          replyIn(tx, { kind: "local", entryId: answer.id, text: answer.text })
        );
        return guarded(localIn);
      }),
    prepareSettlement: (receipt, result) =>
      coherent(async () => {
        const replyIn = await prepareReply(eventOf(receipt));
        return async (tx) => {
          await runtime.guardIn(tx);
          if (result.type === "input" && result.status === "done") {
            await replyIn(tx, { kind: "native", entryId: result.answer });
          }
        };
      }),
    deliverReply: (record, store, signal) =>
      coherent(async () => {
        const port = configuration.eventReplies;
        const { destination } = record;
        if (!port || !destination) {
          throw new Denied({
            code: "revoked",
            reason: "Reply delivery is unavailable.",
          });
        }
        await port.deliver({
          destination,
          key: record.key,
          text: record.text,
          store,
          beforePost: () =>
            coherent(async () => {
              signal?.throwIfAborted();
              const caller = await run(configuration.ownerContext());
              await runtime.authorize(caller, "read");
              await run(
                configuration.checkDependencies(caller, record.dependencies, {
                  deadlineAt: Date.now() + 30_000,
                })
              );
              await port.authorize(destination);
              signal?.throwIfAborted();
            }),
        });
      }),
    routingAccess: (context, dependencies) =>
      coherent(async () => {
        if (!configuration.coordination) {
          throw new Denied({
            code: "revoked",
            reason: "Team coordination is disabled.",
          });
        }
        await runtime.authorize(context, "coordinate");
        await runtime.authorize(context, "transfer");
        await run(
          configuration.checkDependencies(context, dependencies, {
            deadlineAt: Date.now() + 30_000,
          })
        );
      }),
    readAccess: (context) => coherent(() => runtime.authorize(context, "read")),
    authorize: (event, context, signal, action = "deliver") =>
      coherent(async () => {
        const caller = context ?? (await run(configuration.ownerContext()));
        let permission: "read" | "coordinate" | "send" = "send";
        if (action === "read") {
          permission = "read";
        } else if (
          configuration.coordination ||
          action === "control" ||
          action === "admit"
        ) {
          permission = "coordinate";
        }
        await runtime.authorize(caller, permission, signal);
        if (action !== "read") {
          await runtime.authorize(caller, "transfer", signal);
        }
        await run(
          configuration.checkDependencies(caller, event.dependencies, {
            deadlineAt: Date.now() + 30_000,
            signal,
          })
        );
      }),
  };
};
