import type {
  ChatControl,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { useEffect, useRef, useState } from "react";

import { cacheKey, encoded, productPath, request } from "./api";
import type { PendingChatMessage } from "./chat";
import { CHAT_MESSAGE_LENGTH_ERROR, MAX_CHAT_MESSAGE_LENGTH } from "./chat";
import {
  controlConversation,
  decideApproval,
  forkConversation,
  stopConversation,
  useConversationConnection,
} from "./chat-connection";
import { useMessageDelivery } from "./chat-delivery";
import { ConversationActivity } from "./conversation-activity";
import { ConversationTranscript } from "./conversation-transcript";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";
import { usePendingChat } from "./pending-chat";
import { conversationSchema } from "./types";
import type { Conversation } from "./types";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

const ConversationComposer = ({
  text,
  setText,
  sending,
  connected,
  pending,
  reject,
  send,
}: {
  text: string;
  setText: (value: string) => void;
  sending: boolean;
  connected: boolean;
  pending: PendingChatMessage | null;
  reject: (message: string) => void;
  send: (message: PendingChatMessage) => void;
}) => (
  <form
    className="message-composer"
    onSubmit={(event) => {
      event.preventDefault();
      if (text.trim().length > MAX_CHAT_MESSAGE_LENGTH) {
        reject(CHAT_MESSAGE_LENGTH_ERROR);
        return;
      }
      if (text.trim() && !pending && !sending && connected) {
        send({ operationId: crypto.randomUUID(), text: text.trim() });
      }
    }}
  >
    <label className="sr-only" htmlFor="message">
      Message
    </label>
    <textarea
      id="message"
      value={text}
      onChange={(event) => setText(event.target.value)}
      placeholder="Ask your company assistant..."
      rows={2}
      maxLength={MAX_CHAT_MESSAGE_LENGTH}
      disabled={sending || !connected || Boolean(pending)}
    />
    <div className="composer-footer">
      <span>Your conversation is private.</span>
      <button
        className="primary-button"
        type="submit"
        disabled={sending || !connected || !text.trim() || Boolean(pending)}
      >
        {sending ? "Sending..." : "Send message"}
      </button>
    </div>
  </form>
);

const ConversationHeader = ({
  agentName,
  sessionId,
  connection,
  connected,
  busy,
  disabled,
  toggle,
  reconnect,
  stop,
}: {
  agentName: string;
  sessionId: string | undefined;
  connection: string;
  connected: boolean;
  busy: boolean;
  disabled: boolean;
  toggle: () => void;
  reconnect: () => void;
  stop: () => Promise<void>;
}) => (
  <>
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Conversation</p>
        <h2>{agentName}</h2>
      </div>
      <div className="button-row">
        {busy ? (
          <button
            className="quiet-button"
            type="button"
            disabled={disabled}
            onClick={stop}
          >
            Stop
          </button>
        ) : null}
        <button
          className="quiet-button"
          type="button"
          onClick={connection === "failed" ? reconnect : toggle}
        >
          {connected && connection !== "failed" ? "Disconnect" : "Reconnect"}
        </button>
      </div>
    </div>
    <div className="session-line">
      <span
        className={`connection-dot ${connection === "disconnected" ? "offline" : ""}`}
      />
      <span>{connection}</span>
      <span title={sessionId}>
        Session {sessionId?.slice(0, 12) ?? "loading"}
      </span>
    </div>
  </>
);

const EMPTY_CHAT: Pick<
  ChatSnapshot,
  "messages" | "approvals" | "busy" | "queuedInputs" | "tools" | "activity"
> = {
  approvals: [],
  busy: false,
  messages: [],
  queuedInputs: [],
  tools: [],
};

const ConversationSession = ({
  conversationId,
  userId,
  agentId,
  agentName,
  onStartConversation,
  onConversation,
}: {
  conversationId: string;
  userId: string;
  agentId: string;
  agentName: string;
  onStartConversation?: () => void;
  onConversation?: (conversationId: string) => void;
}) => {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [text, setText] = useState("");
  const [acting, setActing] = useState(false);
  const [connected, setConnected] = useState(true);
  const [accessValid, setAccessValid] = useState(true);
  const forkIntent = useRef<OperationIntent | null>(null);
  const path = productPath(`conversations/${encoded(conversationId)}`);
  const pendingKey = cacheKey(userId, conversationId, "pending");
  const pending = usePendingChat(pendingKey);
  const {
    connection,
    error: chatError,
    reconnect,
    snapshot: observedSnapshot,
  } = useConversationConnection(conversation, path, connected && accessValid);
  const snapshot = observedSnapshot ?? conversation?.snapshot ?? EMPTY_CHAT;
  const online = connected && connection === "connected" && accessValid;
  const controlsDisabled = !online || acting;
  const delivery = useMessageDelivery(path, pendingKey, online, (message) => {
    setText((current) => (current.trim() === message.text ? "" : current));
  });
  const displayedError = [errorMessage, delivery.error, chatError].find(
    Boolean
  );

  useEffect(() => {
    const clear = () => {
      setAccessValid(false);
      setConversation(null);
      setText("");
      setConnected(false);
    };
    window.addEventListener("cerebro:access-cleared", clear);
    return () => window.removeEventListener("cerebro:access-cleared", clear);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const value = await request(path, conversationSchema, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        if (
          value.conversationId !== conversationId ||
          value.agentId !== agentId ||
          value.snapshot.address.conversationId !== conversationId ||
          value.snapshot.address.agentId !== agentId ||
          value.snapshot.address.sessionId !== value.sessionId
        ) {
          setErrorMessage("The conversation does not belong to this agent.");
          setConnected(false);
          return;
        }
        setConversation(value);
      } catch (error) {
        if (!controller.signal.aborted) {
          setErrorMessage(messageOf(error));
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [agentId, conversationId, path]);

  const send = (message: PendingChatMessage) => {
    setErrorMessage("");
    delivery.send(message);
  };
  const act = async (command: () => Promise<unknown>) => {
    if (!online || acting) {
      return false;
    }
    setActing(true);
    setErrorMessage("");
    let accepted = true;
    try {
      await command();
    } catch (error) {
      setErrorMessage(messageOf(error));
      accepted = false;
    }
    setActing(false);
    return accepted;
  };
  const control = (command: ChatControl) =>
    act(() => controlConversation(path, command));
  const fork = async (entryId: string) => {
    await act(async () => {
      const value = await forkConversation(
        path,
        entryId,
        operationFor(forkIntent, { entryId })
      );
      forkIntent.current = null;
      onConversation?.(value.conversationId);
    });
  };

  if (!accessValid) {
    return (
      <p className="error-banner" role="alert">
        Conversation access is no longer available.
      </p>
    );
  }

  return (
    <section className="conversation-panel" aria-label="Conversation">
      <ConversationHeader
        agentName={agentName}
        sessionId={conversation?.sessionId}
        connection={connection}
        connected={connected}
        busy={snapshot.busy}
        disabled={controlsDisabled}
        toggle={() => setConnected((value) => !value)}
        reconnect={reconnect}
        stop={async () => {
          await act(() => stopConversation(path));
        }}
      />
      {displayedError ? (
        <p className="error-banner" role="alert">
          {displayedError}
        </p>
      ) : null}
      {!conversation && displayedError && onStartConversation ? (
        <button
          className="quiet-button"
          type="button"
          onClick={onStartConversation}
        >
          Start new conversation
        </button>
      ) : null}
      <ConversationTranscript
        snapshot={snapshot}
        agentName={agentName}
        connecting={connected && connection === "connecting"}
        disabled={controlsDisabled}
        decide={async (approvalId, decision) => {
          await act(() => decideApproval(path, approvalId, decision));
        }}
        fork={onConversation ? fork : undefined}
      />
      <ConversationActivity
        activity={snapshot.activity}
        disabled={controlsDisabled}
        control={control}
        onConversation={onConversation}
      />
      {pending ? (
        <div className="pending-message">
          <p>
            {delivery.sending
              ? "Confirming your message..."
              : "Your message awaits confirmation."}
          </p>
          <button
            className="quiet-button"
            disabled={!online || delivery.sending}
            type="button"
            onClick={() => delivery.retry()}
          >
            Retry message
          </button>
        </div>
      ) : null}
      <ConversationComposer
        text={text}
        setText={setText}
        sending={delivery.sending}
        connected={online}
        pending={pending}
        reject={setErrorMessage}
        send={send}
      />
    </section>
  );
};

export const ConversationPanel = (
  props: Parameters<typeof ConversationSession>[0]
) => (
  <ConversationSession
    key={`${props.userId}:${props.conversationId}`}
    {...props}
  />
);
