/* oxlint-disable no-await-in-loop -- A changed profile requires a new authorization before the next native mutation. */
import type { Harness, Tx } from "@earendil-works/pi-durable";

import { ProfileChanged } from "./conversation-bindings.ts";
import type { ConversationProfile } from "./conversation-profile.ts";
import { piContext } from "./pi-harness.ts";

export const createNativeOperations = (options: {
  readonly pi: Harness;
  readonly current: () => ConversationProfile;
  readonly guardIn: (
    tx: Tx,
    profile: ConversationProfile,
    admission: boolean
  ) => Promise<void>;
}) => {
  const active = new Set<symbol>();
  return {
    pending: () => active.size > 0,
    run: async <Value>(
      authorize: (profile: ConversationProfile) => Promise<void>,
      operation: () => Promise<Value>,
      admission = false,
      signal?: AbortSignal,
      guardIn?: (tx: Tx) => Promise<void>
    ): Promise<Value> => {
      for (;;) {
        const profile = options.current();
        const token = Symbol("native-profile-operation");
        try {
          try {
            signal?.throwIfAborted();
            await authorize(profile);
            await options.pi.commit(async (tx) => {
              signal?.throwIfAborted();
              await options.guardIn(tx, profile, admission);
              await guardIn?.(tx);
              active.add(token);
            }, piContext());
          } catch (error) {
            if (profile !== options.current()) {
              if (admission) {
                throw new ProfileChanged();
              }
              continue;
            }
            throw error;
          }
          return await operation();
        } finally {
          active.delete(token);
        }
      }
    },
  };
};
