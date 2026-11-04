import { ChannelError } from "./types";

export const assertQueuePayloadSize = (payload: unknown): void => {
  const encoded = JSON.stringify(payload);
  if (!encoded || new TextEncoder().encode(encoded).byteLength > 120_000) {
    throw new ChannelError(
      413,
      "invalid-input",
      "The queue payload is too large."
    );
  }
};
