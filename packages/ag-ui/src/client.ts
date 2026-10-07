/* oxlint-disable no-await-in-loop -- Observer frames and reconnects must be processed in order. */
import type { Observation } from "@cerebro/contracts/session-service";
import type { StreamChunk } from "@tanstack/ai";
import { ChatClient, stream } from "@tanstack/ai-client";

import { projectObservation, projectionMessages } from "./projection.ts";
import type { ConversationProjection } from "./projection.ts";
import {
  createObservationGuard,
  createProtocolProjection,
  decodeObservation,
  observationEvent,
  ResnapshotRequiredError,
} from "./protocol.ts";

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

const accessDenied = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (("_tag" in error && error._tag === "Denied") ||
    ("status" in error && (error.status === 401 || error.status === 403)));

const pause = async (
  milliseconds: number,
  signal: AbortSignal
): Promise<void> => {
  let complete: (() => void) | undefined;
  // oxlint-disable-next-line promise/avoid-new -- Adapt the browser timer and abort signal without changing the shared ES2022 target.
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
  let client: ChatClient | null = null;
  let projection: ConversationProjection | null = null;
  let guard: ReturnType<typeof createObservationGuard> | undefined;
  let protocol = createProtocolProjection();
  let generation = options.generation();
  let attached = false;
  let denied = false;
  let attachment = new AbortController();
  let observer:
    | {
        controller: AbortController;
        iterator: AsyncIterator<unknown>;
        lifecycle: AbortController;
      }
    | undefined;
  let initialFrame: Observation | undefined;
  const current = () =>
    attached &&
    !denied &&
    !attachment.signal.aborted &&
    generation === options.generation();
  const notify = (frame: Observation) => {
    projection = projectObservation(projection, frame);
    options.onProjection(projection);
    if (
      frame.type === "snapshot" ||
      (frame.type === "update" &&
        ["canonical-output", "user-message"].includes(frame.update.type))
    ) {
      client?.setMessagesManually(projectionMessages(projection));
    }
  };
  const closeObserver = async (lifecycle?: AbortController) => {
    if (lifecycle && observer?.lifecycle !== lifecycle) {
      return;
    }
    const closing = observer;
    observer = undefined;
    closing?.controller.abort();
    await closing?.iterator.return?.();
  };
  const releaseObserver = async () => {
    try {
      await closeObserver(attachment);
    } catch (error) {
      options.onError?.(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  };
  const deny = () => {
    if (denied) {
      return;
    }
    denied = true;
    attached = false;
    attachment.abort();
    observer?.controller.abort();
    projection = null;
    client?.setMessagesManually([]);
    options.onProjection(null);
    options.onStatus?.("denied");
    void releaseObserver();
    options.onDenied();
  };
  const accept = (input: unknown): Observation | undefined => {
    if (!current()) {
      return;
    }
    const decoded = decodeObservation(input);
    if (!guard) {
      if (
        decoded.address.conversationId !== options.address.conversationId ||
        decoded.address.agentId !== options.address.agentId ||
        decoded.address.sessionId !== options.address.sessionId ||
        (options.address.organizationId &&
          decoded.address.organizationId !== options.address.organizationId)
      ) {
        throw new Error("Observation belongs to a different conversation.");
      }
      guard = createObservationGuard(decoded.address, generation);
    }
    const frame = guard(decoded);
    if (frame?.type === "access-denied") {
      deny();
      return;
    }
    if (frame) {
      notify(frame);
    }
    return frame;
  };
  const openSnapshot = async (): Promise<Observation> => {
    const lifecycle = attachment;
    await closeObserver();
    if (!current() || attachment !== lifecycle) {
      throw new DOMException("Observation detached.", "AbortError");
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    attachment.signal.addEventListener("abort", abort, { once: true });
    const source = options.open(generation, controller.signal);
    const iterator = source[Symbol.asyncIterator]();
    observer = { controller, iterator, lifecycle };
    try {
      const next = await iterator.next();
      if (!current() || controller.signal.aborted || attachment !== lifecycle) {
        throw new DOMException("Observation detached.", "AbortError");
      }
      const frame = next.done ? undefined : accept(next.value);
      if (!frame || frame.type !== "snapshot") {
        throw new ResnapshotRequiredError(
          "Attachment did not return an authorized snapshot."
        );
      }
      options.onStatus?.("connected");
      protocol = createProtocolProjection();
      return frame;
    } finally {
      lifecycle.signal.removeEventListener("abort", abort);
    }
  };
  const abortObserver = () => {
    attachment.abort();
    observer?.controller.abort();
  };
  const reportError = (error: unknown) => {
    if (accessDenied(error)) {
      deny();
    } else if (current()) {
      options.onError?.(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  };
  const restore = async () => {
    const lifecycle = attachment;
    const keepOpen = () => current() && attachment === lifecycle;
    while (keepOpen()) {
      try {
        return await openSnapshot();
      } catch (error) {
        reportError(error);
        await closeObserver(lifecycle);
        if (current() && attachment === lifecycle) {
          await pause(options.retryDelayMs ?? 500, lifecycle.signal);
        }
      }
    }
    throw new DOMException("Observation detached.", "AbortError");
  };
  const connection = stream(
    () => {
      throw new Error("Send messages through Cerebro commands.");
    },
    {
      hydrate: async (threadId) => {
        if (threadId !== options.address.conversationId) {
          throw new Error("Cannot hydrate a different conversation.");
        }
        try {
          initialFrame = await restore();
          const run = projection?.snapshot.runs.find(
            (value) =>
              value.state === "running" ||
              value.state === "waiting-for-approval"
          );
          return {
            // An idle observation cursor keeps access revalidation and new runs observable.
            activeRun: {
              runId: run?.runId ?? `observation:${options.address.sessionId}`,
            },
            interrupts: null,
            messages: projectionMessages(projection),
          };
        } catch (error) {
          if (accessDenied(error)) {
            deny();
          }
          throw error;
        }
      },
      async *joinRun(_runId, signal): AsyncIterable<StreamChunk> {
        const lifecycle = attachment;
        const keepOpen = () => current() && attachment === lifecycle;
        signal?.addEventListener("abort", abortObserver, { once: true });
        try {
          if (initialFrame && current()) {
            yield observationEvent(initialFrame);
          }
          initialFrame = undefined;
          while (keepOpen()) {
            try {
              const observing = observer;
              if (observing) {
                const next = await observing.iterator.next();
                if (next.done) {
                  await closeObserver(lifecycle);
                } else {
                  const frame = observing.controller.signal.aborted
                    ? undefined
                    : accept(next.value);
                  if (frame) {
                    yield* protocol(frame);
                  }
                  continue;
                }
              } else {
                yield* protocol(await openSnapshot());
                continue;
              }
            } catch (error) {
              reportError(error);
              await closeObserver(lifecycle);
            }
            if (keepOpen()) {
              options.onStatus?.("connecting");
              await pause(options.retryDelayMs ?? 500, attachment.signal);
            }
          }
        } finally {
          signal?.removeEventListener("abort", abortObserver);
          await closeObserver(lifecycle);
        }
      },
    }
  );
  client = new ChatClient({
    connection,
    onError: (error) => {
      if (current()) {
        options.onError?.(error);
      }
    },
    persistence: true,
    threadId: options.address.conversationId,
  });
  return {
    attach: () => {
      if (attached) {
        return;
      }
      generation = options.generation();
      denied = false;
      attached = true;
      attachment = new AbortController();
      guard = undefined;
      options.onStatus?.("connecting");
      client.attach();
    },
    client,
    connection,
    detach: () => {
      attached = false;
      attachment.abort();
      observer?.controller.abort();
      client.detach();
      void releaseObserver();
      options.onStatus?.("disconnected");
    },
    dispose: () => {
      attached = false;
      attachment.abort();
      observer?.controller.abort();
      client.dispose();
      void releaseObserver();
    },
    getProjection: () => projection,
  };
};
