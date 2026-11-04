import { receiveQueuedSlackEvent } from "@cerebro/channels/slack";
import { ChannelError } from "@cerebro/channels/types";

import type { WorkerEnv } from "./bindings";
import { createChannelOptions } from "./channels";

export const consumeSlackEvents = async (
  batch: MessageBatch<unknown>,
  env: WorkerEnv
): Promise<void> => {
  if (batch.queue !== "cerebro-slack-events") {
    throw new Error("This worker does not consume the requested queue.");
  }
  const options = createChannelOptions(env);
  await Promise.all(
    batch.messages.map(async (message) => {
      try {
        await options.withDatabase((database) =>
          receiveQueuedSlackEvent(
            database,
            options,
            message.body,
            message.attempts > 1
          )
        );
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            attempt: message.attempts,
            errorCode:
              error instanceof ChannelError ? error.code : "unavailable",
            event: "slack.delivery.failed",
            messageId: message.id,
            service: "cerebro-api",
          })
        );
        message.retry({
          delaySeconds: Math.min(60, 2 ** Math.min(message.attempts, 6)),
        });
      }
    })
  );
};
