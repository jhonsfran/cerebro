import { InvalidInput } from "@cerebro/contracts/failures";

export const boundedModelResponse = (
  response: Response,
  maxBytes: number
): Response => {
  if (!response.body) {
    return response;
  }
  const reader = response.body.getReader();
  let receivedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel: async (reason) => {
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
    pull: async (controller) => {
      try {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        receivedBytes += next.value.byteLength;
        if (receivedBytes > maxBytes) {
          throw new InvalidInput({
            reason: "Model response exceeds the configured byte limit",
          });
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        try {
          await reader.cancel(error);
        } finally {
          reader.releaseLock();
        }
      }
    },
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
};
