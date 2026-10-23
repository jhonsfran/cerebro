import type { ChatReceipt } from "@cerebro/contracts/session-service";
import { useEffect, useRef, useState } from "react";

import { currentAccessGeneration, ProductError } from "./api";
import type { PendingChatMessage } from "./chat";
import { pendingChatSchema } from "./chat";
import { submitMessage } from "./chat-connection";
import { readPendingChat, storePendingChat } from "./pending-chat";

export type DeliveryState =
  | { readonly status: "idle" }
  | { readonly status: "sending"; readonly operationId: string }
  | {
      readonly status: "waiting" | "blocked";
      readonly operationId: string;
      readonly error: string;
    };

interface DeliveryOptions {
  readonly generation: () => number;
  readonly read: () => PendingChatMessage | null;
  readonly store: (message: PendingChatMessage | null) => void;
  readonly submit: (
    message: PendingChatMessage,
    signal: AbortSignal
  ) => Promise<ChatReceipt>;
  readonly onState: (state: DeliveryState) => void;
  readonly onConfirmed: (message: PendingChatMessage) => void;
  readonly retryDelayMs?: number;
}

const retryable = (error: unknown): boolean =>
  error instanceof TypeError ||
  (error instanceof ProductError &&
    (error.status >= 500 || [408, 425, 429].includes(error.status)));

export const createMessageDelivery = (options: DeliveryOptions) => {
  let online = false;
  let disposed = false;
  let active: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let operationId: string | undefined;
  let attempts = 0;
  let blocked = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    const previous = active;
    active = null;
    previous?.abort();
  };
  const deliver = async (message: PendingChatMessage): Promise<void> => {
    if (!online || disposed || active || blocked) {
      return;
    }
    if (attempts >= 3) {
      blocked = true;
      options.onState({
        error: "Your message still awaits confirmation. Retry when ready.",
        operationId: message.operationId,
        status: "blocked",
      });
      return;
    }
    const controller = new AbortController();
    active = controller;
    const generation = options.generation();
    const current = () =>
      active === controller &&
      !controller.signal.aborted &&
      online &&
      !disposed &&
      generation === options.generation() &&
      options.read()?.operationId === message.operationId;
    attempts += 1;
    options.onState({ operationId: message.operationId, status: "sending" });
    try {
      const receipt = await options.submit(message, controller.signal);
      if (!current()) {
        return;
      }
      if (receipt.operationId !== message.operationId) {
        throw new Error("The message receipt belongs to another operation.");
      }
      options.store(null);
      options.onState({ status: "idle" });
      options.onConfirmed(message);
    } catch (error) {
      if (!current()) {
        return;
      }
      const canRetry = retryable(error) && attempts < 3;
      blocked = !canRetry;
      options.onState({
        error:
          error instanceof Error
            ? error.message
            : "The message was not confirmed.",
        operationId: message.operationId,
        status: canRetry ? "waiting" : "blocked",
      });
      if (canRetry) {
        timer = setTimeout(
          () => {
            timer = undefined;
            void deliver(message);
          },
          (options.retryDelayMs ?? 500) * 2 ** (attempts - 1)
        );
      }
    } finally {
      if (active === controller) {
        active = null;
      }
    }
  };
  const recover = () => {
    const message = options.read();
    if (!message) {
      return;
    }
    if (operationId !== message.operationId) {
      ({ operationId } = message);
      attempts = 0;
      blocked = false;
    }
    void deliver(message);
  };
  return {
    connect: () => {
      if (online || disposed) {
        return;
      }
      online = true;
      recover();
    },
    disconnect: () => {
      online = false;
      cancel();
      const pending = options.read();
      if (pending && !blocked) {
        options.onState({
          error: "Waiting for a connection.",
          operationId: pending.operationId,
          status: "waiting",
        });
      }
    },
    dispose: () => {
      disposed = true;
      online = false;
      cancel();
    },
    send: (message: PendingChatMessage) => {
      if (!online || disposed || options.read()) {
        return;
      }
      const parsed = pendingChatSchema.safeParse(message);
      if (!parsed.success) {
        options.onState({
          error: parsed.error.issues[0]?.message ?? "The message is invalid.",
          operationId: message.operationId,
          status: "blocked",
        });
        return;
      }
      options.store(message);
      recover();
    },
    retry: () => {
      if (!online || disposed || active) {
        return;
      }
      clearTimeout(timer);
      timer = undefined;
      attempts = 0;
      blocked = false;
      recover();
    },
  };
};

export const useMessageDelivery = (
  path: string,
  key: string,
  online: boolean,
  onConfirmed: (message: PendingChatMessage) => void
) => {
  const [state, setState] = useState<DeliveryState>({ status: "idle" });
  const delivery = useRef<ReturnType<typeof createMessageDelivery> | null>(
    null
  );
  const confirmed = useRef(onConfirmed);
  useEffect(() => {
    confirmed.current = onConfirmed;
  }, [onConfirmed]);
  useEffect(() => {
    const current = createMessageDelivery({
      generation: currentAccessGeneration,
      onConfirmed: (message) => confirmed.current(message),
      onState: setState,
      read: () => readPendingChat(key),
      store: (message) => storePendingChat(key, message),
      submit: async (message, signal) => {
        const result = await submitMessage(path, message, signal);
        return result.receipt;
      },
    });
    delivery.current = current;
    const clear = () => {
      current.dispose();
      setState({ status: "idle" });
    };
    window.addEventListener("cerebro:access-cleared", clear);
    return () => {
      window.removeEventListener("cerebro:access-cleared", clear);
      current.dispose();
    };
  }, [key, path]);
  useEffect(() => {
    if (online) {
      delivery.current?.connect();
    } else {
      delivery.current?.disconnect();
    }
  }, [online]);
  return {
    error:
      state.status === "waiting" || state.status === "blocked"
        ? state.error
        : "",
    retry: () => delivery.current?.retry(),
    send: (message: PendingChatMessage) => delivery.current?.send(message),
    sending: state.status === "sending" || state.status === "waiting",
  };
};
