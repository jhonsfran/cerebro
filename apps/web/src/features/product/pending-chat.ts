import { useMemo, useSyncExternalStore } from "react";

import { pendingChatSchema } from "./chat";
import type { PendingChatMessage } from "./chat";

const PENDING_CHANGED = "cerebro:pending-changed";
const subscribe = (notify: () => void): (() => void) => {
  window.addEventListener("storage", notify);
  window.addEventListener(PENDING_CHANGED, notify);
  window.addEventListener("cerebro:access-cleared", notify);
  return () => {
    window.removeEventListener("storage", notify);
    window.removeEventListener(PENDING_CHANGED, notify);
    window.removeEventListener("cerebro:access-cleared", notify);
  };
};
const readStoredValue = (key: string): string | null => {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
};
const parseMessage = (stored: string | null): PendingChatMessage | null => {
  if (!stored) {
    return null;
  }
  try {
    const parsed = pendingChatSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
const serverSnapshot = (): null => null;

export const usePendingChat = (key: string): PendingChatMessage | null => {
  const stored = useSyncExternalStore(
    subscribe,
    () => readStoredValue(key),
    serverSnapshot
  );
  return useMemo(() => parseMessage(stored), [stored]);
};
export const readPendingChat = (key: string): PendingChatMessage | null =>
  parseMessage(readStoredValue(key));
export const storePendingChat = (
  key: string,
  message: PendingChatMessage | null
): void => {
  if (message) {
    sessionStorage.setItem(key, JSON.stringify(message));
  } else {
    sessionStorage.removeItem(key);
  }
  window.dispatchEvent(new Event(PENDING_CHANGED));
};
