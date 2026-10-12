/* oxlint-disable no-await-in-loop -- A response reader delivers frames in wire order. */
import type { ChatSnapshot } from "@cerebro/contracts/session-service";
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
import {
  createObservationClient,
  MAX_OBSERVATION_FRAME_BYTES,
  OBSERVATION_CONTENT_TYPE,
} from "./observation";
import type { ObservationConnectionStatus } from "./observation";
import {
  approvalReceiptSchema,
  messageReceiptSchema,
  stopReceiptSchema,
} from "./types";
import type { Conversation } from "./types";

export const readObservations = async function* readObservations(
  path: string,
  generation: number,
  signal: AbortSignal
): AsyncIterable<unknown> {
  const response = await fetch(apiUrl(`${path}/observations`), {
    credentials: "include",
    headers: { Accept: OBSERVATION_CONTENT_TYPE },
    signal,
  });
  if (generation !== currentAccessGeneration() || signal.aborted) {
    await response.body?.cancel();
    assertCurrentAccess(generation);
    signal.throwIfAborted();
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProductError(
      response.status,
      "Conversation observation is unavailable."
    );
  }
  if (
    !response.body ||
    !response.headers.get("Content-Type")?.startsWith(OBSERVATION_CONTENT_TYPE)
  ) {
    await response.body?.cancel();
    throw new Error("The observation endpoint must return NDJSON frames.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frameBytes = 0;
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      assertCurrentAccess(generation);
      for (const byte of next.value ?? []) {
        frameBytes = byte === 0x0a ? 0 : frameBytes + 1;
        if (frameBytes > MAX_OBSERVATION_FRAME_BYTES) {
          throw new Error("Observation frame exceeds the transport limit.");
        }
      }
      buffer += decoder.decode(next.value, { stream: !next.done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          assertCurrentAccess(generation);
          yield JSON.parse(line) as unknown;
        }
        newline = buffer.indexOf("\n");
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
  mutate(`${path}/messages`, message, messageReceiptSchema);

export const stopConversation = (path: string) =>
  mutate(`${path}/stop`, {}, stopReceiptSchema);

export const decideApproval = (
  path: string,
  approvalId: string,
  decision: "allow" | "deny"
) =>
  mutate(
    `${path}/approvals/${encodeURIComponent(approvalId)}`,
    { decision },
    approvalReceiptSchema
  );

export const useConversationConnection = (
  conversation: Conversation | null,
  path: string,
  connected: boolean
) => {
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null);
  const [connection, setConnection] =
    useState<ObservationConnectionStatus>("disconnected");
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
      onSnapshot: (value) => {
        setSnapshot(value);
        setError("");
      },
      onStatus: setConnection,
      open: (generation, signal) => readObservations(path, generation, signal),
    });
    const clear = () => {
      observer.detach();
      setSnapshot(null);
      setConnection("denied");
    };
    window.addEventListener("cerebro:access-cleared", clear);
    observer.attach();
    return () => {
      window.removeEventListener("cerebro:access-cleared", clear);
      observer.dispose();
    };
  }, [agentId, conversationId, sessionId, connected, path]);
  return {
    connection: connected ? connection : ("disconnected" as const),
    error,
    snapshot,
  };
};
