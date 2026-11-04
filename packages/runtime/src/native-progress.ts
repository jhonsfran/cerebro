import type {
  ConversationId,
  Harness,
  TaskId,
} from "@earendil-works/pi-durable";

import { piContext } from "./pi-harness.ts";

export const trackNativeProgress = (
  pi: Harness,
  progress: {
    readonly tasks?: readonly TaskId[];
    readonly conversations?: readonly ConversationId[];
  },
  waitUntil: (promise: Promise<unknown>) => void
): void => {
  if (progress.tasks?.length) {
    waitUntil(
      Promise.all(progress.tasks.map((id) => pi.waitForTask(id, piContext())))
    );
  }
  if (progress.conversations?.length) {
    waitUntil(
      Promise.all(
        progress.conversations.map(async (id) => {
          const native = await pi.conversation(id, piContext());
          await native?.waitForIdle(piContext());
        })
      )
    );
  }
};
