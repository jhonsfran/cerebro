import type {
  ChatApproval,
  ChatMessage,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  assertCurrentAccess,
  cacheKey,
  currentAccessGeneration,
  encoded,
  productPath,
  request,
} from "./api";
import type { PendingChatMessage } from "./chat";
import {
  decideApproval,
  stopConversation,
  submitMessage,
  useConversationConnection,
} from "./chat-connection";
import {
  readPendingChat,
  storePendingChat,
  usePendingChat,
} from "./pending-chat";
import { conversationSchema } from "./types";
import type { Conversation } from "./types";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

const messageLabel = (message: ChatMessage, agentName: string): string => {
  if (message.role === "user") {
    return "You";
  }
  return message.role === "tool"
    ? `Tool: ${message.toolName ?? "Result"}`
    : agentName;
};

const TranscriptMessage = ({
  message,
  agentName,
}: {
  message: ChatMessage;
  agentName: string;
}) => (
  <article
    className={`chat-message ${message.role === "user" ? "user-message" : "answer-message"}`}
  >
    <p className="message-label">{messageLabel(message, agentName)}</p>
    {message.thinking ? (
      <details>
        <summary>Thinking</summary>
        <p>{message.thinking}</p>
      </details>
    ) : null}
    {message.role === "tool" ? (
      <details>
        <summary>Tool result</summary>
        <pre>{message.text}</pre>
      </details>
    ) : null}
    {message.role !== "tool" && message.text ? <p>{message.text}</p> : null}
  </article>
);

const ConversationComposer = ({
  text,
  setText,
  sending,
  connected,
  pending,
  send,
}: {
  text: string;
  setText: (value: string) => void;
  sending: boolean;
  connected: boolean;
  pending: PendingChatMessage | null;
  send: (message: PendingChatMessage) => Promise<void>;
}) => (
  <form
    className="message-composer"
    onSubmit={(event) => {
      event.preventDefault();
      if (text.trim() && !pending && !sending && connected) {
        void send({ operationId: crypto.randomUUID(), text: text.trim() });
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

const ApprovalRequest = ({
  approval,
  disabled,
  decide,
}: {
  approval: ChatApproval;
  disabled: boolean;
  decide: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
}) => (
  <section className="approval-card" aria-label="Approval required">
    <p className="eyebrow">Approval required</p>
    <h3>{approval.toolId}</h3>
    <pre>{JSON.stringify(approval.arguments, null, 2)}</pre>
    <div className="button-row">
      <button
        className="primary-button"
        disabled={disabled}
        type="button"
        onClick={() => decide(approval.approvalId, "allow")}
      >
        Approve request
      </button>
      <button
        className="quiet-button"
        disabled={disabled}
        type="button"
        onClick={() => decide(approval.approvalId, "deny")}
      >
        Deny request
      </button>
    </div>
  </section>
);

const ConversationHeader = ({
  agentName,
  sessionId,
  connection,
  connected,
  busy,
  disabled,
  toggle,
  stop,
}: {
  agentName: string;
  sessionId: string | undefined;
  connection: string;
  connected: boolean;
  busy: boolean;
  disabled: boolean;
  toggle: () => void;
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
        <button className="quiet-button" type="button" onClick={toggle}>
          {connected ? "Disconnect" : "Reconnect"}
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

const ConversationTranscript = ({
  snapshot,
  agentName,
  connecting,
  disabled,
  decide,
  transcript,
}: {
  snapshot: Pick<ChatSnapshot, "messages" | "approvals">;
  agentName: string;
  connecting: boolean;
  disabled: boolean;
  decide: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  transcript: RefObject<HTMLDivElement | null>;
}) => (
  <div
    className="transcript"
    ref={transcript}
    aria-live="polite"
    aria-relevant="additions text"
  >
    {snapshot.messages.length === 0 ? (
      <div className="conversation-empty">
        <span className="empty-mark">c</span>
        <h3>Start with a question.</h3>
        <p>Send a message to your company assistant.</p>
      </div>
    ) : null}
    {snapshot.messages.map((message) => (
      <TranscriptMessage
        agentName={agentName}
        key={message.id}
        message={message}
      />
    ))}
    {connecting ? <output className="tool-status">Connecting...</output> : null}
    {snapshot.approvals
      .filter((approval) => approval.state === "pending")
      .map((approval) => (
        <ApprovalRequest
          key={approval.approvalId}
          approval={approval}
          disabled={disabled}
          decide={decide}
        />
      ))}
  </div>
);

const EMPTY_CHAT: Pick<ChatSnapshot, "messages" | "approvals" | "busy"> = {
  approvals: [],
  busy: false,
  messages: [],
};

const ConversationSession = ({
  conversationId,
  userId,
  agentId,
  agentName,
  onStartConversation,
}: {
  conversationId: string;
  userId: string;
  agentId: string;
  agentName: string;
  onStartConversation?: () => void;
}) => {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const [connected, setConnected] = useState(true);
  const [accessValid, setAccessValid] = useState(true);
  const transcript = useRef<HTMLDivElement>(null);
  const path = productPath(`conversations/${encoded(conversationId)}`);
  const pendingKey = cacheKey(userId, conversationId, "pending");
  const pending = usePendingChat(pendingKey);
  const {
    connection,
    error: chatError,
    snapshot: observedSnapshot,
  } = useConversationConnection(conversation, path, connected && accessValid);
  const snapshot = observedSnapshot ?? conversation?.snapshot ?? EMPTY_CHAT;
  const online = connected && connection === "connected" && accessValid;
  const displayedError = errorMessage || chatError;

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

  useEffect(() => {
    if (snapshot.messages.length || snapshot.approvals.length) {
      transcript.current?.scrollTo({
        behavior: "smooth",
        top: transcript.current.scrollHeight,
      });
    }
  }, [snapshot]);

  const send = async (message: PendingChatMessage) => {
    const currentPending = readPendingChat(pendingKey);
    if (
      !online ||
      (currentPending && currentPending.operationId !== message.operationId)
    ) {
      return;
    }
    setSending(true);
    setErrorMessage("");
    storePendingChat(pendingKey, message);
    const generation = currentAccessGeneration();
    try {
      const result = await submitMessage(path, message);
      assertCurrentAccess(generation);
      if (result.receipt.operationId === message.operationId) {
        storePendingChat(pendingKey, null);
        setText("");
      } else {
        setErrorMessage("The message receipt belongs to another operation.");
      }
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setSending(false);
  };
  const act = async (command: () => Promise<unknown>) => {
    if (!online || acting) {
      return;
    }
    setActing(true);
    setErrorMessage("");
    try {
      await command();
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setActing(false);
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
        disabled={!online || acting}
        toggle={() => setConnected((value) => !value)}
        stop={() => act(() => stopConversation(path))}
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
        disabled={!online || acting}
        decide={(approvalId, decision) =>
          act(() => decideApproval(path, approvalId, decision))
        }
        transcript={transcript}
      />
      {pending ? (
        <div className="pending-message">
          <p>
            A message awaits confirmation. Retry with the same operation ID.
          </p>
          <button
            className="quiet-button"
            disabled={!online || sending}
            type="button"
            onClick={() => send(pending)}
          >
            Retry message
          </button>
        </div>
      ) : null}
      <ConversationComposer
        text={text}
        setText={setText}
        sending={sending}
        connected={online}
        pending={pending}
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
