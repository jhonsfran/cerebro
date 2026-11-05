import type { BotEvent } from "@cerebro/contracts/bot-events";
import { Denied } from "@cerebro/contracts/failures";

import { ProfileChanged } from "./conversation-bindings.ts";
import type { BotEventScope } from "./coordinator-events.ts";

export const authorizeEventDelivery = async (
  scope: BotEventScope,
  event: BotEvent,
  held: boolean,
  signal?: AbortSignal
): Promise<void> => {
  try {
    await scope.authorize(event, undefined, signal);
  } catch (error) {
    if (
      error instanceof Denied &&
      held &&
      (await scope.prepareAdmission?.(event.id)) === false
    ) {
      throw new ProfileChanged();
    }
    throw error;
  }
};
