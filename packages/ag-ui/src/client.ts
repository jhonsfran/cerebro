/* oxlint-disable no-await-in-loop -- Observer frames and reconnects must be processed in order. */
import type { Observation } from "@cerebro/contracts/session-service";
import type { StreamChunk } from "@tanstack/ai";
import { ChatClient, stream } from "@tanstack/ai-client";
import type { UIMessage } from "@tanstack/ai-client";

import { projectObservation } from "./projection.ts";
import type { ConversationProjection } from "./projection.ts";
import {
  createObservationGuard,
  chunkObservation,
  decodeCustomObservation,
  decodeStreamChunk,
  sameObservation,
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
  readonly onMessages?: (messages: UIMessage[]) => void;
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
  interface Attachment {
    readonly controller: AbortController;
    readonly generation: number;
  }
  let client: ChatClient | null = null;
  let projection: ConversationProjection | null = null;
  let guard: ReturnType<typeof createObservationGuard> | undefined;
  let acceptedFrame: Observation | undefined;
  let attached = false;
  let denied = false;
  let disposed = false;
  let attachment: Attachment = {
    controller: new AbortController(),
    generation: options.generation(),
  };
  let observer:
    | {
        controller: AbortController;
        iterator: AsyncIterator<unknown>;
        lifecycle: Attachment;
      }
    | undefined;
  let initialFrame: StreamChunk | undefined;
  const current = (lifecycle: Attachment) =>
    attachment === lifecycle &&
    attached &&
    !denied &&
    !disposed &&
    !lifecycle.controller.signal.aborted &&
    lifecycle.generation === options.generation();
  const notify = (frame: Observation) => {
    projection = projectObservation(projection, frame);
    options.onProjection(projection);
  };
  const closeObserver = async (lifecycle: Attachment) => {
    if (observer?.lifecycle !== lifecycle) {
      return;
    }
    const closing = observer;
    observer = undefined;
    closing?.controller.abort();
    await closing?.iterator.return?.();
  };
  const deny = (lifecycle: Attachment) => {
    if (!current(lifecycle)) {
      return;
    }
    denied = true;
    attached = false;
    lifecycle.controller.abort();
    observer?.controller.abort();
    projection = null;
    client?.setMessagesManually([]);
    options.onMessages?.([]);
    options.onProjection(null);
    options.onStatus?.("denied");
    options.onDenied();
  };
  const reportError = (error: unknown, lifecycle: Attachment) => {
    if (!current(lifecycle)) {
      return;
    }
    if (accessDenied(error)) {
      deny(lifecycle);
    } else {
      options.onError?.(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  };
  const releaseObserver = async (lifecycle: Attachment) => {
    try {
      await closeObserver(lifecycle);
    } catch (error) {
      reportError(error, lifecycle);
    }
  };
  const accept = (
    input: unknown,
    lifecycle: Attachment
  ): StreamChunk | undefined => {
    if (!current(lifecycle)) {
      return;
    }
    const chunk = decodeStreamChunk(input);
    if (chunk.type !== "CUSTOM" || !chunk.name.startsWith("cerebro.")) {
      return acceptedFrame &&
        sameObservation(chunkObservation(chunk), acceptedFrame)
        ? chunk
        : undefined;
    }
    const decoded = decodeCustomObservation(chunk);
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
      guard = createObservationGuard(decoded.address, lifecycle.generation);
    }
    const frame = guard(decoded);
    acceptedFrame = frame;
    if (frame?.type === "access-denied") {
      deny(lifecycle);
      return;
    }
    if (frame) {
      notify(frame);
      return chunk;
    }
  };
  const openSnapshot = async (lifecycle: Attachment): Promise<StreamChunk> => {
    if (!current(lifecycle)) {
      throw new DOMException("Observation detached.", "AbortError");
    }
    await closeObserver(lifecycle);
    if (!current(lifecycle)) {
      throw new DOMException("Observation detached.", "AbortError");
    }
    const controller = new AbortController();
    const source = options.open(lifecycle.generation, controller.signal);
    const iterator = source[Symbol.asyncIterator]();
    observer = { controller, iterator, lifecycle };
    const next = await iterator.next();
    if (!current(lifecycle) || controller.signal.aborted) {
      throw new DOMException("Observation detached.", "AbortError");
    }
    const chunk = next.done ? undefined : accept(next.value, lifecycle);
    if (!current(lifecycle)) {
      throw new DOMException("Observation detached.", "AbortError");
    }
    if (!chunk || acceptedFrame?.type !== "snapshot") {
      throw new ResnapshotRequiredError(
        "Attachment did not return an authorized snapshot."
      );
    }
    options.onStatus?.("connected");
    if (!current(lifecycle)) {
      throw new DOMException("Observation detached.", "AbortError");
    }
    return chunk;
  };
  const restore = async (lifecycle: Attachment) => {
    const keepOpen = () => current(lifecycle);
    while (keepOpen()) {
      try {
        return await openSnapshot(lifecycle);
      } catch (error) {
        reportError(error, lifecycle);
        await releaseObserver(lifecycle);
        if (keepOpen()) {
          await pause(options.retryDelayMs ?? 500, lifecycle.controller.signal);
        }
      }
    }
  };
  const events = function* events(chunk: StreamChunk, lifecycle: Attachment) {
    if (!current(lifecycle)) {
      return;
    }
    if (chunk.type === "RUN_ERROR") {
      reportError(new Error(chunk.message), lifecycle);
      if (!current(lifecycle)) {
        return;
      }
    }
    yield chunk;
  };
  const connection = stream(
    () => {
      throw new Error("Send messages through Cerebro commands.");
    },
    {
      hydrate: async (threadId) => {
        const lifecycle = attachment;
        if (threadId !== options.address.conversationId) {
          throw new Error("Cannot hydrate a different conversation.");
        }
        const snapshotFrame = await restore(lifecycle);
        if (!snapshotFrame || !current(lifecycle)) {
          // Settle retired hydration without a TanStack error or a run to rejoin.
          return { activeRun: null, interrupts: null, messages: [] };
        }
        initialFrame = snapshotFrame;
        const execution = projection?.snapshot.executions.find((value) =>
          value.runIds.some((runId) =>
            projection?.snapshot.runs.some(
              (run) =>
                run.runId === runId &&
                (run.state === "running" ||
                  run.state === "waiting-for-approval")
            )
          )
        );
        return {
          // An idle observation cursor keeps access revalidation and new runs observable.
          activeRun: {
            runId:
              execution?.executionId ??
              `observation:${options.address.sessionId}`,
          },
          interrupts: null,
          messages: [],
        };
      },
      async *joinRun(_runId, signal): AsyncIterable<StreamChunk> {
        const lifecycle = attachment;
        const keepOpen = () => current(lifecycle);
        const abortObserver = () => {
          lifecycle.controller.abort();
          if (observer?.lifecycle === lifecycle) {
            observer.controller.abort();
          }
        };
        signal?.addEventListener("abort", abortObserver, { once: true });
        if (signal?.aborted) {
          abortObserver();
        }
        try {
          if (!keepOpen()) {
            return;
          }
          const firstFrame = initialFrame;
          initialFrame = undefined;
          if (firstFrame) {
            yield* events(firstFrame, lifecycle);
          }
          while (keepOpen()) {
            try {
              const observing = observer;
              if (observing?.lifecycle === lifecycle) {
                const next = await observing.iterator.next();
                if (next.done) {
                  await closeObserver(lifecycle);
                } else {
                  const frame = observing.controller.signal.aborted
                    ? undefined
                    : accept(next.value, lifecycle);
                  if (frame && keepOpen()) {
                    yield* events(frame, lifecycle);
                  }
                  continue;
                }
              } else {
                const snapshotFrame = await openSnapshot(lifecycle);
                if (keepOpen()) {
                  yield* events(snapshotFrame, lifecycle);
                }
                continue;
              }
            } catch (error) {
              reportError(error, lifecycle);
              await releaseObserver(lifecycle);
            }
            if (keepOpen()) {
              options.onStatus?.("connecting");
              await pause(
                options.retryDelayMs ?? 500,
                lifecycle.controller.signal
              );
            }
          }
        } finally {
          signal?.removeEventListener("abort", abortObserver);
          await releaseObserver(lifecycle);
        }
      },
    }
  );
  client = new ChatClient({
    connection,
    onMessagesChange: (messages) => {
      if (current(attachment)) {
        options.onMessages?.(messages);
      }
    },
    persistence: true,
    threadId: options.address.conversationId,
  });
  return {
    attach: () => {
      if (attached || disposed) {
        return;
      }
      denied = false;
      attached = true;
      attachment = {
        controller: new AbortController(),
        generation: options.generation(),
      };
      guard = undefined;
      initialFrame = undefined;
      acceptedFrame = undefined;
      // Invalidate TanStack's in-flight hydration before starting a fresh attachment.
      client.clear();
      options.onStatus?.("connecting");
      client.attach();
    },
    client,
    connection,
    detach: () => {
      attached = false;
      attachment.controller.abort();
      observer?.controller.abort();
      client.detach();
      void releaseObserver(attachment);
      options.onStatus?.("disconnected");
    },
    dispose: () => {
      disposed = true;
      attached = false;
      attachment.controller.abort();
      observer?.controller.abort();
      client.dispose();
      void releaseObserver(attachment);
    },
    getProjection: () => projection,
  };
};
