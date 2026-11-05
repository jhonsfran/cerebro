import { Denied, toContractFailure } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type {
  ChatObservation,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import type { Conversation, Harness } from "@earendil-works/pi-durable";

import { Bindings } from "./conversation-bindings.ts";
import { piContext } from "./pi-harness.ts";

export const observeConversation = async (
  options: {
    readonly native: Conversation;
    readonly pi: Harness;
    readonly revalidate: () => void;
    readonly readFrame: (
      context: ExecutionContext,
      signal?: AbortSignal,
      emit?: (snapshot: ChatSnapshot) => void
    ) => Promise<ChatSnapshot>;
  },
  context: ExecutionContext,
  signal: AbortSignal
): Promise<Response> => {
  await options.readFrame(context, signal);
  const abort = new AbortController();
  const nativeContext = piContext(AbortSignal.any([signal, abort.signal]));
  const watch = await options.native.watch(nativeContext);

  try {
    await options.readFrame(context, signal);
  } catch (error) {
    await watch.stop();
    throw error;
  }
  const encoder = new TextEncoder();
  let resumeReader: (() => void) | undefined;
  let closed = false;
  let publishing = Promise.resolve();
  let pendingUpdate = false;
  let lastFrame = "";
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  const close = async () => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe?.();
    if (timer) {
      clearInterval(timer);
    }
    resumeReader?.();
    abort.abort();
    await watch.stop();
  };
  const stream = new ReadableStream<Uint8Array>({
    cancel: close,
    pull: () => {
      resumeReader?.();
      resumeReader = undefined;
    },
    start: (controller) => {
      const emit = (frame: ChatObservation) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      const denied = async (error: unknown) => {
        if (closed) {
          return;
        }
        if (error instanceof Denied) {
          options.revalidate();
          emit({
            reason: error.code === "unauthorized" ? "unauthorized" : "revoked",
            type: "access-denied",
          });
          controller.close();
        } else {
          controller.error(toContractFailure(error));
        }
        await close();
      };

      const publish = () => {
        if (pendingUpdate || closed) {
          return publishing;
        }
        pendingUpdate = true;
        const previous = publishing;
        publishing = (async () => {
          await previous;
          pendingUpdate = false;
          try {
            if ((controller.desiredSize ?? 0) <= 0) {
              const pending = Promise.withResolvers<boolean>();
              resumeReader = () => pending.resolve(true);
              await pending.promise;
            }
            if (closed) {
              return;
            }
            await options.readFrame(context, signal, (snapshot) => {
              const frame = JSON.stringify(snapshot);
              if (frame !== lastFrame) {
                emit({ snapshot, type: "snapshot" });
                lastFrame = frame;
              }
            });
          } catch (error) {
            await denied(error);
          }
        })();
        return publishing;
      };
      watch.start(() => publish());
      unsubscribe = options.pi.subscribeCommits((publication) => {
        if (
          publication.changes.some(
            (change) =>
              change.type === "document" &&
              change.record.kind === Bindings.definition.kind
          )
        ) {
          queueMicrotask(() => {
            void publish();
          });
        }
      });
      void publish();
      timer = setInterval(() => {
        void publish();
      }, 1000);
      const waitForClose = async () => {
        await watch.closed;
        if (!closed) {
          controller.close();
          await close();
        }
      };
      void waitForClose();
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson",
    },
  });
};
