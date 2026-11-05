import { normalizeEventAdmission } from "@cerebro/contracts/bot-routing";
import { Denied } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { Conversation } from "@earendil-works/pi-durable";
import { Effect, Result } from "effect";

import { Bindings, ProfileChanged } from "./conversation-bindings.ts";
import type { ConversationProfile } from "./conversation-profile.ts";
import type { BotEventScope, EventRouteIn } from "./coordinator-events.ts";

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
        if (configuration.coordination) {
          return guarded(await subscriptions.prepare(input, context));
        }
        if (normalizeEventAdmission(input).routing.kind !== "automatic") {
          throw new Denied({
            code: "revoked",
            reason: "Team coordination is disabled.",
          });
        }
        return guarded(() => Promise.resolve({ kind: "coordinator" as const }));
      }),
    prepareLocalControl: (...args) =>
      coherent(async () => guarded(await web.prepareLocalControl(...args))),
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
