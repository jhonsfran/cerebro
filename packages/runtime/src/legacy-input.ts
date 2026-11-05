/* oxlint-disable no-await-in-loop -- A changed profile requires a new authorization before the next native mutation. */
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { Conversation, Harness } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";

import { ProfileChanged } from "./conversation-bindings.ts";
import type { createNativeOperations } from "./conversation-native-operations.ts";
import type { ConversationProfile } from "./conversation-profile.ts";
import { piContext } from "./pi-harness.ts";
import { requireInputAdmissionIn } from "./source-admission.ts";

export const sendLegacyInput = async (
  options: {
    readonly pi: Harness;
    readonly native: Conversation;
    readonly harness: PiHarness;
    readonly current: () => ConversationProfile;
    readonly operations: ReturnType<typeof createNativeOperations>;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
  input: {
    readonly operationId: string;
    readonly text: string;
    readonly authority: "ordinary" | "saved-slack";
  },
  context: ExecutionContext,
  signal?: AbortSignal
) => {
  for (;;) {
    const profile = options.current();
    try {
      const guard = async (
        tx: Parameters<typeof requireInputAdmissionIn>[0]
      ) => {
        await profile.runtime.guardIn(tx);
        if (
          input.authority === "ordinary" &&
          input.text !== "status" &&
          input.text !== "stop"
        ) {
          await requireInputAdmissionIn(tx, {
            nativeId: options.native.id,
            address: profile.runtime.configuration.address,
            operationId: input.operationId,
            text: input.text,
          });
        }
      };
      await profile.runtime.authorize(context, "coordinate", signal);
      await options.pi.commit(guard, piContext(signal));
      if (
        await profile.routeHuman(input.operationId, input.text, context, signal)
      ) {
        return {
          accepted: true,
          operationId: input.operationId,
          session: String(options.native.id),
        };
      }
      const receipt = await options.operations.run(
        async (active) => {
          if (active !== profile) {
            throw new ProfileChanged();
          }
          await active.runtime.authorize(context, "send", signal);
        },
        async () => {
          await profile.coordination.rememberHumanOperation(input.operationId);
          return await options.harness.submit(input.text, {
            session: String(options.native.id),
            operationId: input.operationId,
          });
        },
        true,
        signal,
        guard
      );
      options.waitUntil(options.native.waitForIdle(piContext()));
      return receipt;
    } catch (error) {
      if (error instanceof ProfileChanged && !signal?.aborted) {
        continue;
      }
      throw error;
    }
  }
};
