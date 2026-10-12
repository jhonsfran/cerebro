import { ChannelError } from "@cerebro/channels/types";
import { Denied } from "@cerebro/contracts/failures";

export const OBSERVATION_CONTENT_TYPE = "application/x-ndjson";
export const ACCESS_RECHECK_MS = 2000;
const ACCESS_CHECK_TIMEOUT_MS = 1000;
const ACCESS_DENIED = new TextEncoder().encode(
  `${JSON.stringify({ reason: "revoked", type: "access-denied" })}\n`
);

export interface GuardedObservation {
  readonly authorize: () => Promise<void>;
  readonly body: ReadableStream<Uint8Array>;
  readonly recheckMs?: number;
}

const isDenial = (error: unknown): boolean =>
  error instanceof Denied ||
  (error instanceof ChannelError && [401, 403].includes(error.status));

const withTimeout = async (
  work: () => Promise<void>,
  milliseconds: number
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // oxlint-disable-next-line promise/avoid-new -- A timer races the access read.
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Current access could not be verified.")),
      milliseconds
    );
  });
  try {
    await Promise.race([work(), expiry]);
  } finally {
    clearTimeout(timer);
  }
};

export const guardedObservation = (
  input: GuardedObservation
): ReadableStream<Uint8Array> => {
  const reader = input.body.getReader();
  let settled = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const release = async () => {
    settled = true;
    clearInterval(timer);
    try {
      await reader.cancel();
    } catch {
      // The upstream body is already closed.
    }
  };
  const finish = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    outcome: "denied" | "end" | Error
  ) => {
    if (settled) {
      return;
    }
    await release();
    if (outcome === "denied") {
      controller.enqueue(ACCESS_DENIED);
      controller.close();
    } else if (outcome === "end") {
      controller.close();
    } else {
      controller.error(outcome);
    }
  };
  const recheck = async (
    controller: ReadableStreamDefaultController<Uint8Array>
  ) => {
    try {
      await withTimeout(input.authorize, ACCESS_CHECK_TIMEOUT_MS);
    } catch (error) {
      await finish(
        controller,
        isDenial(error)
          ? "denied"
          : new Error("Current access could not be verified.")
      );
    }
  };
  return new ReadableStream<Uint8Array>({
    cancel: () => release(),
    pull: async (controller) => {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch {
        await finish(
          controller,
          new Error("Session observation was interrupted.")
        );
        return;
      }
      if (settled) {
        return;
      }
      if (next.done) {
        await finish(controller, "end");
        return;
      }
      controller.enqueue(next.value);
    },
    start: (controller) => {
      timer = setInterval(
        () => recheck(controller),
        input.recheckMs ?? ACCESS_RECHECK_MS
      );
    },
  });
};
