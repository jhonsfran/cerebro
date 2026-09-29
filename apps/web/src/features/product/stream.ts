/* eslint-disable no-await-in-loop -- Stream records and cursor batches must be read in order. */
import {
  apiUrl,
  assertCurrentAccess,
  clearProductCache,
  currentAccessGeneration,
  encoded,
  ProductError,
} from "./api";
import { conversationItemSchema } from "./types";
import type { ConversationItem } from "./types";

const pause = async (signal: AbortSignal): Promise<void> => {
  let cancel: (() => void) | undefined;
  // eslint-disable-next-line promise/avoid-new -- Browser timers do not provide a Promise API.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), 1500);
    cancel = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) {
      cancel();
    }
  });
  if (cancel) {
    signal.removeEventListener("abort", cancel);
  }
};

export const readConversationStream = async (
  path: string,
  initialCursor: string,
  signal: AbortSignal,
  receive: (item: ConversationItem) => void,
  onConnection: (state: "connected" | "current") => void
): Promise<void> => {
  const generation = currentAccessGeneration();
  let cursor = initialCursor;
  while (!signal.aborted) {
    const response = await fetch(
      apiUrl(`${path}/events?cursor=${encoded(cursor)}`),
      {
        credentials: "include",
        headers: { Accept: "text/event-stream", "Last-Event-ID": cursor },
        signal,
      }
    );
    assertCurrentAccess(generation);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        clearProductCache();
      }
      throw new ProductError(response.status, "The stream is unavailable.");
    }
    if (!response.body) {
      throw new Error("The stream has no response body.");
    }
    onConnection("connected");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        assertCurrentAccess(generation);
        if (chunk.done) {
          break;
        }
        buffer += decoder
          .decode(chunk.value, { stream: true })
          .replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data) {
            const parsed: unknown = JSON.parse(data);
            const item = conversationItemSchema.parse(parsed);
            ({ cursor } = item);
            assertCurrentAccess(generation);
            receive(item);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!signal.aborted) {
      onConnection("current");
      await pause(signal);
    }
  }
};
