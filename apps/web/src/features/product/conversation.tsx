import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import type { ChatStatus, DataUIPart } from "ai";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  apiUrl,
  cacheKey,
  clearProductCache,
  assertCurrentAccess,
  currentAccessGeneration,
  encoded,
  mutate,
  productPath,
  request,
} from "./api";
import {
  conversationDataSchemas,
  conversationItems,
  loadChatMessages,
  messageText,
} from "./chat";
import type { ConversationMessage } from "./chat";
import type {
  Audit,
  Conversation,
  ConversationItem,
  History,
  PendingMessage,
  Source,
} from "./types";
import {
  auditSchema,
  conversationSchema,
  historySchema,
  pendingSchema,
  sourceSchema,
  stateMutationSchema,
} from "./types";

type Connection = "connecting" | "connected" | "disconnected";
type Detail =
  | { type: "source"; value: Source }
  | { type: "audit"; value: Audit };
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

const EvidenceDialog = ({
  detail,
  onClose,
}: {
  detail: Detail;
  onClose: () => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="detail-dialog"
      aria-labelledby="detail-title"
      onCancel={onClose}
    >
      <div className="panel-heading">
        <h2 id="detail-title">
          {detail.type === "source" ? detail.value.title : "Execution audit"}
        </h2>
        <button className="quiet-button" type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="fixture-note">
        {detail.value.mode === "fixture"
          ? "Local fixture evidence"
          : "Company evidence"}
      </p>
      {detail.type === "source" ? (
        <>
          <p className="muted-text">Version {detail.value.sourceVersion}</p>
          <p className="source-text">{detail.value.text}</p>
        </>
      ) : (
        <>
          <p className="muted-text">
            Run {detail.value.runId} · {detail.value.state}
          </p>
          <ol className="audit-list">
            {detail.value.entries.map((entry, index) => (
              <li key={`${entry.type}-${entry.at}-${index}`}>
                <strong>{entry.type}</strong>
                <p>{entry.description}</p>
                <small>{new Date(entry.at).toLocaleString()}</small>
              </li>
            ))}
          </ol>
        </>
      )}
    </dialog>
  );
};

const ConversationHeader = ({
  agentName,
  sessionId,
  connected,
  connection,
  fixture,
  toggle,
}: {
  agentName: string;
  sessionId: string | undefined;
  connected: boolean;
  connection: Connection;
  fixture: boolean;
  toggle: () => void;
}) => (
  <>
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Conversation</p>
        <h2>{agentName}</h2>
      </div>
      <button className="quiet-button" type="button" onClick={toggle}>
        {connected ? "Disconnect" : "Resume conversation"}
      </button>
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
    {fixture ? (
      <p className="fixture-note">
        Local fixture. Answers, tools, and sources use test data.
      </p>
    ) : null}
  </>
);

const ConversationComposer = ({
  text,
  setText,
  sending,
  connected,
  pending,
  fixture,
  send,
}: {
  text: string;
  setText: (value: string) => void;
  sending: boolean;
  connected: boolean;
  pending: PendingMessage | null;
  fixture: boolean;
  send: (message: PendingMessage) => Promise<void>;
}) => (
  <form
    className="message-composer"
    onSubmit={(event) => {
      event.preventDefault();
      if (text.trim() && !pending) {
        send({ eventId: crypto.randomUUID(), text: text.trim() });
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
      <span>
        {fixture
          ? 'Try "Run the approval fixture" to review an approval.'
          : "Your conversation is private."}
      </span>
      <button
        className="primary-button"
        type="submit"
        disabled={sending || !connected || !text.trim() || Boolean(pending)}
      >
        {sending ? "Responding..." : "Send message"}
      </button>
    </div>
  </form>
);

const ConversationSession = ({
  conversationId,
  userId,
  agentId,
  agentName,
  fixture,
}: {
  conversationId: string;
  userId: string;
  agentId: string;
  agentName: string;
  fixture: boolean;
}) => {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [initialItems, setInitialItems] = useState<ConversationItem[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [connected, setConnected] = useState(true);
  const [accessValid, setAccessValid] = useState(true);
  const accessGeneration = useRef(currentAccessGeneration());
  const [revision, setRevision] = useState(0);
  const transcript = useRef<HTMLDivElement>(null);
  const path = productPath(`conversations/${encoded(conversationId)}`);
  const pendingKey = cacheKey(userId, conversationId, "pending");
  const [pending, setPending] = useState<PendingMessage | null>(() => {
    try {
      const raw = sessionStorage.getItem(pendingKey);
      return raw ? pendingSchema.parse(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  });
  const pendingRef = useRef(pending);
  const chatState = useRef<{
    isRecovering: boolean;
    isStreaming: boolean;
    messages: ConversationMessage[];
    status: ChatStatus;
  }>({
    isRecovering: false,
    isStreaming: false,
    messages: [],
    status: "ready",
  });
  const acknowledge = useCallback(
    (item: ConversationItem) => {
      if (
        item.type === "user" &&
        item.eventId === pendingRef.current?.eventId
      ) {
        sessionStorage.removeItem(pendingKey);
        pendingRef.current = null;
        setPending(null);
        setText("");
      }
    },
    [pendingKey, setPending, setText]
  );
  const agent = useAgent({
    agent: "session-agent",
    basePath: `${path.slice(1)}/chat`,
    host: new URL(apiUrl(path)).host,
    name: conversationId,
    onClose: (event) => {
      setConnection("disconnected");
      if ([1008, 4401, 4403].includes(event.code)) {
        clearProductCache();
        setErrorMessage("Conversation access is no longer available.");
      }
    },
    onOpen: () => {
      setConnection("connected");
      setRevision((current) => current + 1);
    },
    startClosed: !connected,
  });
  const {
    messages,
    sendMessage,
    setMessages,
    status,
    isStreaming,
    isRecovering,
    error: chatError,
  } = useAgentChat<unknown, ConversationMessage>({
    agent,
    credentials: "include",
    dataPartSchemas: conversationDataSchemas,
    getInitialMessages: loadChatMessages,
    onData: (part: DataUIPart<{ "conversation-item": ConversationItem }>) => {
      if (accessGeneration.current !== currentAccessGeneration()) {
        return;
      }
      if (part.type === "data-conversation-item") {
        acknowledge(part.data);
        setInitialItems((current) =>
          current.some((item) => item.cursor === part.data.cursor)
            ? current
            : [...current, part.data]
        );
      }
    },
    onError: (error) => {
      setErrorMessage(messageOf(error));
      if (error.message === "Conversation access is no longer available.") {
        clearProductCache();
      }
    },
    syncMessagesToServer: false,
  });
  const replaceMessages = useEffectEvent((value: ConversationMessage[]) => {
    setMessages(value);
  });
  useLayoutEffect(() => {
    chatState.current = { isRecovering, isStreaming, messages, status };
  }, [isRecovering, isStreaming, messages, status]);
  const items = useMemo(
    () => conversationItems(messages, initialItems),
    [messages, initialItems]
  );
  const runs = useMemo(() => {
    const result = new Map(
      (conversation?.snapshot.runs ?? []).map((run) => [run.runId, run])
    );
    for (const item of items) {
      if (item.type === "run") {
        result.set(item.run.runId, item.run);
      }
    }
    return result;
  }, [conversation, items]);
  const historyRuns = useMemo(() => {
    const result = new Map(
      (history?.runs ?? []).map((run) => [run.runId, run])
    );
    for (const run of runs.values()) {
      result.set(run.runId, {
        auditHref: `${path}/audit/${encoded(run.runId)}`,
        runId: run.runId,
        state: run.state,
      });
    }
    return [...result.values()];
  }, [history, path, runs]);
  const sending = busy || status === "submitted" || isStreaming || isRecovering;

  useEffect(() => {
    if (!connected) {
      agent.close();
    } else if (agent.readyState === 3) {
      agent.reconnect();
    }
  }, [agent, connected]);

  useEffect(() => {
    const clear = () => {
      replaceMessages([]);
      setAccessValid(false);
      setInitialItems([]);
      setConversation(null);
      setHistory(null);
      setDetail(null);
      pendingRef.current = null;
      setPending(null);
      setText("");
      setConnected(false);
    };
    window.addEventListener("cerebro:access-cleared", clear);
    return () => window.removeEventListener("cerebro:access-cleared", clear);
  }, []);

  useEffect(() => {
    const generation = currentAccessGeneration();
    const controller = new AbortController();
    const load = async () => {
      try {
        const [value, executionHistory] = await Promise.all([
          request(path, conversationSchema, { signal: controller.signal }),
          request(`${path}/history`, historySchema, {
            signal: controller.signal,
          }),
        ]);
        if (controller.signal.aborted) {
          return;
        }
        assertCurrentAccess(generation);
        if (
          value.conversationId !== conversationId ||
          value.agentId !== agentId
        ) {
          setErrorMessage("The conversation does not belong to this agent.");
          setConnected(false);
          replaceMessages([]);
          return;
        }
        for (const item of value.items) {
          acknowledge(item);
        }
        setConversation(value);
        setHistory(executionHistory);
        setInitialItems((current) =>
          conversationItems([], [...value.items, ...current])
        );
        const idle = () =>
          ["ready", "error"].includes(chatState.current.status) &&
          !chatState.current.isStreaming &&
          !chatState.current.isRecovering;
        if (idle()) {
          const before = chatState.current;
          const refreshed = await loadChatMessages({
            url: apiUrl(`${path}/chat`),
          });
          assertCurrentAccess(generation);
          if (
            !controller.signal.aborted &&
            idle() &&
            chatState.current === before
          ) {
            replaceMessages(refreshed);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setErrorMessage(messageOf(error));
        }
      }
    };
    if (revision >= 0) {
      load();
    }
    return () => controller.abort();
  }, [acknowledge, agentId, conversationId, path, revision]);

  useEffect(() => {
    if (items.length || messages.length) {
      transcript.current?.scrollTo({
        behavior: "smooth",
        top: transcript.current.scrollHeight,
      });
    }
  }, [items, messages]);

  const send = async (message: PendingMessage) => {
    setErrorMessage("");
    sessionStorage.setItem(pendingKey, JSON.stringify(message));
    pendingRef.current = message;
    setPending(message);
    try {
      const existing = messages.some((item) => item.id === message.eventId);
      await sendMessage({
        id: message.eventId,
        ...(existing ? { messageId: message.eventId } : {}),
        parts: [{ text: message.text, type: "text" }],
        role: "user",
      });
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
  };
  const act = async (suffix: string) => {
    setBusy(true);
    setErrorMessage("");
    try {
      await mutate(
        `${path}/${suffix}`,
        { operationId: crypto.randomUUID() },
        stateMutationSchema
      );
      setRevision((current) => current + 1);
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  const openSource = async (sourceId: string, sourceVersion: string) => {
    const generation = currentAccessGeneration();
    setDetail(null);
    try {
      const value = await request(
        `${path}/sources/${encoded(sourceId)}`,
        sourceSchema
      );
      assertCurrentAccess(generation);
      if (value.sourceVersion !== sourceVersion) {
        setErrorMessage("The cited source version is no longer available.");
        return;
      }
      setDetail({ type: "source", value });
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
  };
  const openAudit = async (runId: string) => {
    const generation = currentAccessGeneration();
    try {
      const value = await request(
        `${path}/audit/${encoded(runId)}`,
        auditSchema
      );
      assertCurrentAccess(generation);
      setDetail({ type: "audit", value });
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
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
        connected={connected}
        connection={connected ? connection : "disconnected"}
        fixture={fixture}
        toggle={() => setConnected((value) => !value)}
      />
      {errorMessage || chatError ? (
        <p className="error-banner" role="alert">
          {errorMessage || chatError?.message}
        </p>
      ) : null}
      <div
        className="transcript"
        ref={transcript}
        aria-live="polite"
        aria-relevant="additions"
      >
        {messages.length === 0 ? (
          <div className="conversation-empty">
            <span className="empty-mark">c</span>
            <h3>Start with a question.</h3>
            <p>Responses include their sources and execution status.</p>
            {fixture ? (
              <button
                className="quiet-button"
                type="button"
                onClick={() => setText("Run the approval fixture")}
              >
                Try the approval fixture
              </button>
            ) : null}
          </div>
        ) : null}
        {messages.map((message) => {
          const value = messageText(message);
          return value ? (
            <article
              className={`chat-message ${message.role === "user" ? "user-message" : "answer-message"}`}
              key={message.id}
            >
              <p className="message-label">
                {message.role === "user" ? "You" : agentName}
              </p>
              <p>{value}</p>
            </article>
          ) : null;
        })}
        {isRecovering || status === "submitted" ? (
          <output className="tool-status">
            {isRecovering ? "Recovering response..." : "Preparing response..."}
          </output>
        ) : null}
        {items.map((item) => {
          switch (item.type) {
            case "citation": {
              return (
                <button
                  className="citation-button"
                  key={item.cursor}
                  type="button"
                  onClick={() => openSource(item.sourceId, item.sourceVersion)}
                >
                  <span aria-hidden="true">↗</span> {item.title}
                  <small>Source version {item.sourceVersion}</small>
                </button>
              );
            }
            case "tool": {
              return (
                <p className="tool-status" key={item.cursor}>
                  <span aria-hidden="true">◇</span> {item.name}
                  <span className="status-pill">{item.state}</span>
                </p>
              );
            }
            case "approval": {
              return runs.get(item.runId)?.state === "waiting-for-approval" ? (
                <section
                  className="approval-card"
                  key={item.cursor}
                  aria-label="Approval required"
                >
                  <p className="eyebrow">Approval required</p>
                  <h3>Review before execution.</h3>
                  <p>
                    {fixture
                      ? "This permits one local test action. The fixture does not change an external system."
                      : "Approve this request to continue the run."}
                  </p>
                  <div className="button-row">
                    <button
                      className="primary-button"
                      disabled={busy}
                      type="button"
                      onClick={() =>
                        act(`approvals/${encoded(item.approvalId)}`)
                      }
                    >
                      Approve request
                    </button>
                    <button
                      className="quiet-button"
                      disabled={busy}
                      type="button"
                      onClick={() => act(`runs/${encoded(item.runId)}/cancel`)}
                    >
                      Cancel run
                    </button>
                  </div>
                </section>
              ) : null;
            }
            case "run": {
              return (
                <div className="run-status" key={item.cursor}>
                  <span className="status-pill">
                    {item.run.state.replaceAll("-", " ")}
                  </span>
                  {["queued", "running"].includes(item.run.state) &&
                  runs.get(item.run.runId)?.state === item.run.state ? (
                    <button
                      className="text-button"
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        act(`runs/${encoded(item.run.runId)}/cancel`)
                      }
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
              );
            }
            default: {
              return null;
            }
          }
        })}
      </div>
      {pending ? (
        <div className="pending-message">
          <p>A message awaits confirmation. Retry with the same event ID.</p>
          <button
            className="quiet-button"
            disabled={sending}
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
        connected={connected}
        pending={pending}
        fixture={fixture}
        send={send}
      />
      <details className="execution-history">
        <summary>
          Execution history <span>{historyRuns.length} runs</span>
        </summary>
        {historyRuns.map((run) => (
          <div className="history-row" key={run.runId}>
            <span>{run.runId.slice(0, 18)}</span>
            <span className="status-pill">
              {run.state.replaceAll("-", " ")}
            </span>
            <button
              className="text-button"
              type="button"
              onClick={() => openAudit(run.runId)}
            >
              View audit
            </button>
          </div>
        ))}
        <p className="muted-text">
          {history?.projectionStatus === "fixture"
            ? "Local fixture audit entries."
            : "The audit projection can update after execution."}
        </p>
      </details>
      {detail ? (
        <EvidenceDialog detail={detail} onClose={() => setDetail(null)} />
      ) : null}
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
