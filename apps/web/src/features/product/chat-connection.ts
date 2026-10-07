/* oxlint-disable no-await-in-loop -- A response reader delivers frames in wire order. */
import { createObservationClient } from "@cerebro/ag-ui/client";
import type { ObservationConnectionStatus } from "@cerebro/ag-ui/client";
import { projectionMessages } from "@cerebro/ag-ui/projection";
import type { ConversationProjection } from "@cerebro/ag-ui/projection";
import { useEffect, useState } from "react";

import {
  apiUrl,
  assertCurrentAccess,
  clearProductCache,
  currentAccessGeneration,
  mutate,
  ProductError,
} from "./api";
import type { PendingChatMessage } from "./chat";
import { messageReceiptSchema, stateMutationSchema } from "./types";
import type { Conversation } from "./types";

const MAX_FRAME_BYTES = 1_048_576;
export const readObservations = async function* readObservations(
  path: string,
  generation: number,
  signal: AbortSignal
): AsyncIterable<unknown> {
  const response = await fetch(
    apiUrl(`${path}/observations?accessGeneration=${generation}`),
    {
      credentials: "include",
      headers: { Accept: "application/x-ndjson" },
      signal,
    }
  );
  assertCurrentAccess(generation);
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      clearProductCache();
    }
    throw new ProductError(
      response.status,
      "Conversation observation is unavailable."
    );
  }
  if (
    !response.body ||
    !response.headers.get("Content-Type")?.startsWith("application/x-ndjson")
  ) {
    await response.body?.cancel();
    throw new Error(
      "The observation endpoint must return domain NDJSON frames."
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      assertCurrentAccess(generation);
      buffer += decoder.decode(next.value, { stream: !next.done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_FRAME_BYTES) {
          throw new Error("Observation frame exceeds the transport limit.");
        }
        if (line) {
          assertCurrentAccess(generation);
          yield JSON.parse(line) as unknown;
        }
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_FRAME_BYTES) {
        throw new Error("Observation frame exceeds the transport limit.");
      }
      if (next.done) {
        if (buffer.trim()) {
          throw new Error("Observation ended inside a frame.");
        }
        return;
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
};

export const submitMessage = (path: string, message: PendingChatMessage) =>
  mutate(
    `${path}/messages`,
    { ...message, operationId: message.eventId },
    messageReceiptSchema
  );

export const sendRunCommand = (
  path: string,
  suffix: string,
  operationId: string,
  body: { runId: string; decision?: "allow" | "deny" }
) => mutate(`${path}/${suffix}`, { ...body, operationId }, stateMutationSchema);

export const useConversationConnection = (
  conversation: Conversation | null,
  path: string,
  connected: boolean
) => {
  const [projection, setProjection] = useState<ConversationProjection | null>(
    null
  );
  const [connection, setConnection] =
    useState<ObservationConnectionStatus>("connecting");
  const [error, setError] = useState("");
  const agentId = conversation?.agentId;
  const conversationId = conversation?.conversationId;
  const sessionId = conversation?.sessionId;
  useEffect(() => {
    if (!agentId || !conversationId || !sessionId || !connected) {
      return;
    }
    const observer = createObservationClient({
      address: { agentId, conversationId, sessionId },
      generation: currentAccessGeneration,
      onDenied: clearProductCache,
      onError: (failure) => setError(failure.message),
      onProjection: setProjection,
      onStatus: setConnection,
      open: (generation, signal) => readObservations(path, generation, signal),
    });
    const clear = () => {
      observer.detach();
      setProjection(null);
      setConnection("denied");
    };
    window.addEventListener("cerebro:access-cleared", clear);
    observer.attach();
    return () => {
      window.removeEventListener("cerebro:access-cleared", clear);
      observer.detach();
      observer.dispose();
    };
  }, [agentId, conversationId, sessionId, connected, path]);
  return {
    connection,
    error,
    messages: projectionMessages(projection),
    projection,
  };
};
