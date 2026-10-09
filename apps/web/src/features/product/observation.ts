/* oxlint-disable no-await-in-loop -- Observation frames are applied in wire order. */
import { Observation } from "@cerebro/contracts/session-service";
import { Schema } from "effect";

import { projectObservation } from "./projection";
import type { ConversationProjection } from "./projection";

export const OBSERVATION_CONTENT_TYPE = "application/x-ndjson";
export const MAX_OBSERVATION_FRAME_BYTES = 1_048_576;
export const decodeObservation = Schema.decodeUnknownSync(Observation);

export type ObservationConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
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
    accessGeneration: number,
    signal: AbortSignal
  ) => AsyncIterable<unknown>;
  readonly onProjection: (projection: ConversationProjection | null) => void;
  readonly onStatus?: (status: ObservationConnectionStatus) => void;
  readonly onDenied: () => void;
  readonly onError?: (error: Error) => void;
  readonly retryDelayMs?: number;
}

export class ResnapshotRequiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ResnapshotRequiredError";
  }
}

const accessDenied = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  (error.status === 401 || error.status === 403);

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

// One attachment reads frames until it is detached, denied or replaced.
// Every reconnect starts from a fresh snapshot; nothing here can submit work.
export const createObservationClient = (options: ObservationClientOptions) => {
  let projection: ConversationProjection | null = null;
  let attachment: AbortController | null = null;
  let disposed = false;
  const sameConversation = (address: Observation["address"]): boolean =>
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
      projection = null;
      options.onProjection(null);
      options.onStatus?.("denied");
      options.onDenied();
    };
    // Returns false only when the attachment must stop.
    const apply = (
      input: unknown,
      cursor: { epoch?: string; sequence: number }
    ): boolean => {
      const frame = decodeObservation(input);
      if (!sameConversation(frame.address)) {
        throw new Error("Observation belongs to a different conversation.");
      }
      if (frame.accessGeneration !== generation) {
        return true;
      }
      if (frame.type === "access-denied") {
        deny();
        return false;
      }
      if (frame.type === "snapshot") {
        if (frame.sequence !== 0) {
          throw new ResnapshotRequiredError("A snapshot starts its epoch.");
        }
        cursor.epoch = frame.epoch;
        cursor.sequence = 0;
        options.onStatus?.("connected");
      } else {
        if (frame.epoch !== cursor.epoch || frame.sequence <= cursor.sequence) {
          return true;
        }
        if (frame.sequence !== cursor.sequence + 1) {
          throw new ResnapshotRequiredError("Observation sequence gap.");
        }
        cursor.sequence = frame.sequence;
      }
      projection = projectObservation(projection, frame);
      options.onProjection(projection);
      return true;
    };
    while (live()) {
      const cursor: { epoch?: string; sequence: number } = { sequence: -1 };
      try {
        options.onStatus?.("connecting");
        for await (const input of options.open(generation, controller.signal)) {
          if (!live() || !apply(input, cursor)) {
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
    getProjection: () => projection,
  };
};
