import { useEffect, useMemo, useRef, useState } from "react";

import {
  cacheKey,
  assertCurrentAccess,
  currentAccessGeneration,
  encoded,
  productPath,
  request,
} from "./api";
import { conversationItems, messageText, pendingChatSchema } from "./chat";
import type {
  ConversationMessage,
  ConversationViewItem,
  PendingChatMessage,
} from "./chat";
import {
  reconcileRunCommand,
  sendRunCommand,
  submitMessage,
  useConversationConnection,
} from "./chat-connection";
import type { Audit, Conversation, History, Source } from "./types";
import {
  auditSchema,
  conversationSchema,
  historySchema,
  sourceSchema,
} from "./types";

type Connection = "connecting" | "connected" | "disconnected" | "denied";
const visibleConnection = (
  connected: boolean,
  retired: boolean,
  connection: Connection
): Connection => (retired || !connected ? "disconnected" : connection);
type Detail =
  | { type: "source"; value: Source }
  | { type: "audit"; value: Audit };
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "The request failed.";

const historicalMessages = (
  conversation: Conversation | null
): ConversationMessage[] =>
  (conversation?.items ?? []).flatMap<ConversationMessage>((item) => {
    if (item.type === "user") {
      return [
        {
          id: item.eventId ?? `user:${item.cursor}`,
          parts: [{ content: item.text, type: "text" as const }],
          role: "user" as const,
        },
      ];
    }
    if (item.type === "output") {
      return [
        {
          id: `assistant:${item.answerId ?? item.cursor}`,
          parts: [{ content: item.text, type: "text" as const }],
          role: "assistant" as const,
        },
      ];
    }
    return [];
  });
const historicalItems = (
  conversation: Conversation | null
): ConversationViewItem[] =>
  (conversation?.items ?? []).map((item) =>
    item.type === "approval" ? { ...item, approvalState: item.state } : item
  );
const loadConversation = async (
  path: string,
  signal: AbortSignal,
  generation: number
): Promise<Conversation> => {
  const firstPage = await request(path, conversationSchema, { signal });
  const items = [...firstPage.items];
  let page = firstPage;
  while (
    firstPage.mode === "retired" &&
    page.items.length === 200 &&
    !signal.aborted
  ) {
    // Cursor pages depend on the previous response.
    // oxlint-disable-next-line no-await-in-loop
    page = await request(
      `${path}?cursor=${encoded(page.cursor)}`,
      conversationSchema,
      { signal }
    );
    assertCurrentAccess(generation);
    items.push(...page.items);
  }
  return { ...firstPage, cursor: page.cursor, items };
};

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
  retired,
}: {
  agentName: string;
  sessionId: string | undefined;
  connected: boolean;
  connection: Connection;
  fixture: boolean;
  toggle: () => void;
  retired: boolean;
}) => (
  <>
    <div className="panel-heading">
      <div>
        <p className="eyebrow">Conversation</p>
        <h2>{agentName}</h2>
      </div>
      <button
        className="quiet-button"
        type="button"
        disabled={retired}
        onClick={toggle}
      >
        {connected ? "Disconnect" : "Reconnect"}
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
  mode,
  setMode,
}: {
  text: string;
  setText: (value: string) => void;
  sending: boolean;
  connected: boolean;
  pending: PendingChatMessage | null;
  fixture: boolean;
  send: (message: PendingChatMessage) => Promise<void>;
  mode: PendingChatMessage["mode"];
  setMode: (mode: PendingChatMessage["mode"]) => void;
}) => (
  <form
    className="message-composer"
    onSubmit={(event) => {
      event.preventDefault();
      if (text.trim() && !pending) {
        void send({ eventId: crypto.randomUUID(), mode, text: text.trim() });
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
    <label>
      Send as
      <select
        value={mode}
        disabled={sending || !connected || Boolean(pending)}
        onChange={(event) =>
          setMode(pendingChatSchema.shape.mode.parse(event.target.value))
        }
      >
        <option value="follow-up">Follow-up</option>
        <option value="steer">Steer current work</option>
        <option value="replace">Stop and replace</option>
      </select>
    </label>
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

const ConversationNotice = ({
  retired,
  message,
  onStartConversation,
}: {
  retired: boolean;
  message: string;
  onStartConversation?: () => void;
}) => (
  <>
    {retired ? (
      <p className="error-banner">
        This conversation is retired. Start a new conversation from the agent
        list.
        {onStartConversation ? (
          <button
            type="button"
            className="quiet-button"
            onClick={onStartConversation}
          >
            Start new conversation
          </button>
        ) : null}
      </p>
    ) : null}
    {message ? (
      <p className="error-banner" role="alert">
        {message}
      </p>
    ) : null}
  </>
);
const ConversationProgress = ({
  recovering,
  busy,
}: {
  recovering: boolean;
  busy: boolean;
}) =>
  recovering || busy ? (
    <output className="tool-status">
      {recovering ? "Recovering response..." : "Preparing response..."}
    </output>
  ) : null;

const ConversationSession = ({
  conversationId,
  userId,
  agentId,
  agentName,
  fixture,
  onStartConversation,
}: {
  conversationId: string;
  userId: string;
  agentId: string;
  agentName: string;
  fixture: boolean;
  onStartConversation?: () => void;
}) => {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(true);
  const [accessValid, setAccessValid] = useState(true);
  const [mode, setMode] = useState<PendingChatMessage["mode"]>("follow-up");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const commandIds = useRef(new Map<string, string>());
  const transcript = useRef<HTMLDivElement>(null);
  const path = productPath(`conversations/${encoded(conversationId)}`);
  const pendingKey = cacheKey(userId, conversationId, "pending");
  const [pending, setPending] = useState<PendingChatMessage | null>(() => {
    try {
      const raw = sessionStorage.getItem(pendingKey);
      return raw ? pendingChatSchema.parse(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  });
  const pendingRef = useRef(pending);
  const retired = conversation?.mode === "retired";
  const {
    connection,
    error: chatError,
    messages: observedMessages,
    projection,
  } = useConversationConnection(
    conversation,
    path,
    connected && accessValid && !retired
  );
  const messages = retired
    ? historicalMessages(conversation)
    : observedMessages;
  const items = useMemo(
    () =>
      retired
        ? historicalItems(conversation)
        : conversationItems(projection, path),
    [conversation, retired, projection, path]
  );
  const runs = useMemo(
    () =>
      new Map<string, { runId: string; state: string }>(
        (projection?.snapshot.runs ?? []).map((run) => [run.runId, run])
      ),
    [projection]
  );
  const acknowledge = (eventId: string) => {
    if (eventId === pendingRef.current?.eventId) {
      sessionStorage.removeItem(pendingKey);
      pendingRef.current = null;
      setPending(null);
      setText("");
    }
  };
  useEffect(() => {
    if (
      projection?.snapshot.userMessages.some(
        (message) => message.eventId === pendingRef.current?.eventId
      )
    ) {
      sessionStorage.removeItem(pendingKey);
      pendingRef.current = null;
      setPending(null);
      setText("");
    }
  }, [projection, pendingKey]);
  const historyRuns = useMemo(() => {
    if (retired) {
      return history?.runs ?? [];
    }
    const result = new Map<
      string,
      { auditHref: string; runId: string; state: string }
    >();
    for (const run of runs.values()) {
      result.set(run.runId, {
        auditHref: `${path}/audit/${encoded(run.runId)}`,
        runId: run.runId,
        state: run.state,
      });
    }
    return [...result.values()];
  }, [path, runs, history, retired]);
  const sending = busy;
  const disabled = busy || retired || connection !== "connected";
  const displayedError = errorMessage || chatError;
  const online = connected && connection === "connected" && !retired;
  const displayedConnection = visibleConnection(connected, retired, connection);
  const isRecovering = displayedConnection === "connecting";
  useEffect(() => {
    const clear = () => {
      setAccessValid(false);
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
          loadConversation(path, controller.signal, generation),
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
          return;
        }
        setConversation(value);
        setHistory(executionHistory);
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
    if (items.length || messages.length) {
      transcript.current?.scrollTo({
        behavior: "smooth",
        top: transcript.current.scrollHeight,
      });
    }
  }, [items, messages]);

  const send = async (message: PendingChatMessage) => {
    if (retired || !accessValid || connection !== "connected") {
      return;
    }
    setBusy(true);
    setErrorMessage("");
    sessionStorage.setItem(pendingKey, JSON.stringify(message));
    pendingRef.current = message;
    setPending(message);
    const generation = currentAccessGeneration();
    try {
      const result = await submitMessage(path, message);
      assertCurrentAccess(generation);
      if (result.receipt.sessionId === conversation?.sessionId) {
        acknowledge(message.eventId);
      } else {
        setErrorMessage("The accepted message belongs to another session.");
      }
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
  };
  const act = async (
    suffix: string,
    runId: string,
    decision?: "allow" | "deny",
    toolOperationId?: string
  ) => {
    if (retired || !accessValid || connection !== "connected") {
      return;
    }
    const intent = `${suffix}:${runId}:${decision ?? "stop"}`;
    const commandKey = cacheKey(userId, conversationId, `command:${intent}`);
    const operationId =
      commandIds.current.get(intent) ??
      sessionStorage.getItem(commandKey) ??
      crypto.randomUUID();
    commandIds.current.set(intent, operationId);
    sessionStorage.setItem(commandKey, operationId);
    setBusy(true);
    setErrorMessage("");
    try {
      await (toolOperationId
        ? reconcileRunCommand(path, runId, toolOperationId)
        : sendRunCommand(path, suffix, operationId, {
            runId,
            ...(decision ? { decision } : {}),
          }));
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
        connection={displayedConnection}
        fixture={fixture}
        toggle={() => setConnected((value) => !value)}
        retired={retired}
      />
      <ConversationNotice
        retired={retired}
        message={displayedError}
        onStartConversation={onStartConversation}
      />
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
        <ConversationProgress recovering={isRecovering} busy={busy} />
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
                <div className="tool-status" key={item.cursor}>
                  <span aria-hidden="true">◇</span> {item.name}
                  <span className="status-pill">{item.state}</span>
                  {item.state === "unknown-outcome" && item.operationId ? (
                    <button
                      className="text-button"
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        act(
                          `runs/${encoded(item.runId)}/reconcile`,
                          item.runId,
                          undefined,
                          item.operationId
                        )
                      }
                    >
                      Check outcome
                    </button>
                  ) : null}
                  <details>
                    <summary>Tool details</summary>
                    <pre>
                      {JSON.stringify(
                        { arguments: item.arguments, output: item.output },
                        null,
                        2
                      )}
                    </pre>
                  </details>
                </div>
              );
            }
            case "approval": {
              return item.approvalState === "pending" &&
                (item.expiresAt ?? 0) > now ? (
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
                      disabled={disabled}
                      type="button"
                      onClick={() =>
                        act(
                          `approvals/${encoded(item.approvalId)}`,
                          item.runId,
                          "allow"
                        )
                      }
                    >
                      Approve request
                    </button>
                    <button
                      className="quiet-button"
                      disabled={disabled}
                      type="button"
                      onClick={() =>
                        act(
                          `approvals/${encoded(item.approvalId)}`,
                          item.runId,
                          "deny"
                        )
                      }
                    >
                      Deny request
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
                  {["queued", "running", "waiting-for-approval"].includes(
                    item.run.state
                  ) && runs.get(item.run.runId)?.state === item.run.state ? (
                    <button
                      className="text-button"
                      type="button"
                      disabled={disabled}
                      onClick={() =>
                        act(
                          `runs/${encoded(item.run.runId)}/cancel`,
                          item.run.runId
                        )
                      }
                    >
                      Stop
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
            disabled={disabled}
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
        fixture={fixture}
        send={send}
        mode={mode}
        setMode={setMode}
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
