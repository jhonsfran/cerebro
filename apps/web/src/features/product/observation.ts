/* oxlint-disable no-await-in-loop -- Observation frames are applied in wire order. */
import { ChatObservation } from "@cerebro/contracts/session-service";
import type { ChatSnapshot } from "@cerebro/contracts/session-service";
import { Schema } from "effect";

export const OBSERVATION_CONTENT_TYPE = "application/x-ndjson";
export const MAX_OBSERVATION_FRAME_BYTES = 1_048_576;
export const decodeObservation = Schema.decodeUnknownSync(ChatObservation);

export class ObservationProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObservationProtocolError";
  }
}

export type ObservationConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "denied";
export interface ObservationClientOptions {
  readonly address: {
    readonly agentId: string;
    readonly conversationId: string;
    readonly sessionId: string;
    readonly organizationId?: string;
  };
  readonly generation: () => number;
  readonly open: (
    generation: number,
    signal: AbortSignal
  ) => AsyncIterable<unknown>;
  readonly onSnapshot: (snapshot: ChatSnapshot | null) => void;
  readonly onStatus?: (status: ObservationConnectionStatus) => void;
  readonly onDenied: () => void;
  readonly onError?: (error: Error) => void;
  readonly retryDelayMs?: number;
}

const accessDenied = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  (error.status === 401 || error.status === 403);

const terminalFailure = (error: unknown): boolean => {
  if (error instanceof ObservationProtocolError) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  );
};

const pause = async (
  milliseconds: number,
  signal: AbortSignal
): Promise<void> => {
  let complete: (() => void) | undefined;
  // oxlint-disable-next-line promise/avoid-new -- Adapt the browser timer and abort signal.
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const finish = () => complete?.();
  const timer = setTimeout(finish, milliseconds);
  signal.addEventListener("abort", finish, { once: true });
  if (signal.aborted) {
    finish();
  }
  try {
    await pending;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", finish);
  }
};

export const createObservationClient = (options: ObservationClientOptions) => {
  let snapshot: ChatSnapshot | null = null;
  let attachment: AbortController | null = null;
  let disposed = false;
  const sameConversation = (address: ChatSnapshot["address"]): boolean =>
    address.conversationId === options.address.conversationId &&
    address.agentId === options.address.agentId &&
    address.sessionId === options.address.sessionId &&
    (!options.address.organizationId ||
      address.organizationId === options.address.organizationId);
  const run = async (controller: AbortController, generation: number) => {
    const live = () =>
      attachment === controller &&
      !controller.signal.aborted &&
      options.generation() === generation;
    const deny = () => {
      attachment = null;
      controller.abort();
      snapshot = null;
      options.onSnapshot(null);
      options.onStatus?.("denied");
      options.onDenied();
    };
    const apply = (input: unknown): boolean => {
      let frame;
      try {
        frame = decodeObservation(input);
      } catch {
        throw new ObservationProtocolError(
          "The conversation snapshot is invalid."
        );
      }
      if (frame.type === "access-denied") {
        deny();
        return false;
      }
      if (!sameConversation(frame.snapshot.address)) {
        throw new ObservationProtocolError(
          "Observation belongs to a different conversation."
        );
      }
      ({ snapshot } = frame);
      options.onSnapshot(snapshot);
      options.onStatus?.("connected");
      return true;
    };
    while (live()) {
      try {
        options.onStatus?.("connecting");
        for await (const input of options.open(generation, controller.signal)) {
          if (!live() || !apply(input)) {
            return;
          }
        }
      } catch (error) {
        if (!live()) {
          return;
        }
        if (accessDenied(error)) {
          deny();
          return;
        }
        options.onError?.(
          error instanceof Error ? error : new Error(String(error))
        );
        if (terminalFailure(error)) {
          attachment = null;
          controller.abort();
          options.onStatus?.("failed");
          return;
        }
      }
      if (!live()) {
        return;
      }
      options.onStatus?.("connecting");
      await pause(options.retryDelayMs ?? 500, controller.signal);
    }
  };
  return {
    attach: () => {
      if (attachment || disposed) {
        return;
      }
      const controller = new AbortController();
      attachment = controller;
      void run(controller, options.generation());
    },
    detach: () => {
      const current = attachment;
      attachment = null;
      current?.abort();
      options.onStatus?.("disconnected");
    },
    dispose: () => {
      disposed = true;
      const current = attachment;
      attachment = null;
      current?.abort();
    },
    getSnapshot: () => snapshot,
  };
};
