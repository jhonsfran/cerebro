import { useEffect, useMemo, useRef, useState } from "react";

import {
  cacheKey,
  assertCurrentAccess,
  currentAccessGeneration,
  encoded,
  mutate,
  ProductError,
  productPath,
  request,
} from "./api";
import { readConversationStream } from "./stream";
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
  messageReceiptSchema,
  pendingSchema,
  sourceSchema,
  stateMutationSchema,
} from "./types";

type Connection = "connecting" | "connected" | "disconnected" | "current";
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
      <span>{connection === "current" ? "Up to date" : connection}</span>
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

export const ConversationPanel = ({
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
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [history, setHistory] = useState<History | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [connected, setConnected] = useState(true);
  const [revision, setRevision] = useState(0);
  const cursor = useRef("");
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

  useEffect(() => {
    const clear = () => {
      setItems([]);
      setConversation(null);
      setHistory(null);
      setDetail(null);
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
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const receive = (item: ConversationItem) => {
      assertCurrentAccess(generation);
      cursor.current = item.cursor;
      sessionStorage.setItem(
        cacheKey(userId, conversationId, "cursor"),
        item.cursor
      );
      if (item.type === "run") {
        setHistory((current) => {
          if (!current) {
            return current;
          }
          const existing = current.runs.some(
            (run) => run.runId === item.run.runId
          );
          const updated = {
            auditHref: `${path}/audit/${encoded(item.run.runId)}`,
            runId: item.run.runId,
            state: item.run.state,
          };
          return {
            ...current,
            runs: existing
              ? current.runs.map((run) =>
                  run.runId === item.run.runId ? updated : run
                )
              : [...current.runs, updated],
          };
        });
      }
      setItems((current) =>
        current.some((prior) => prior.cursor === item.cursor)
          ? current
          : [...current, item]
      );
    };
    const load = async () => {
      if (revision < 0) {
        return;
      }
      try {
        setConnection(connected ? "connecting" : "disconnected");
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
          return;
        }
        setConversation(value);
        setHistory(executionHistory);
        setItems((existing) => {
          const merged = new Map(existing.map((item) => [item.cursor, item]));
          for (const item of value.items) {
            merged.set(item.cursor, item);
          }
          const ordered = [...merged.values()];
          // eslint-disable-next-line unicorn/no-array-sort -- The configured browser library predates toSorted; this array is a new copy.
          ordered.sort(
            (first, second) => Number(first.cursor) - Number(second.cursor)
          );
          return ordered;
        });
        if (!cursor.current) {
          cursor.current = value.cursor;
        }
        sessionStorage.setItem(
          cacheKey(userId, conversationId, "cursor"),
          cursor.current
        );
        if (!connected) {
          return;
        }
        await readConversationStream(
          path,
          cursor.current,
          controller.signal,
          receive,
          setConnection
        );
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        setErrorMessage(messageOf(error));
        setConnection("disconnected");
        if (
          !(
            error instanceof ProductError && [401, 403].includes(error.status)
          ) &&
          connected
        ) {
          retryTimer = setTimeout(
            () => setRevision((current) => current + 1),
            2000
          );
        }
      }
    };
    load();
    return () => {
      controller.abort();
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
    };
  }, [agentId, connected, conversationId, path, revision, userId]);

  const itemCount = items.length;
  useEffect(() => {
    if (itemCount === 0) {
      return;
    }
    transcript.current?.scrollTo({
      behavior: "smooth",
      top: transcript.current.scrollHeight,
    });
  }, [itemCount, transcript]);

  const send = async (message: PendingMessage) => {
    setBusy(true);
    setErrorMessage("");
    sessionStorage.setItem(pendingKey, JSON.stringify(message));
    setPending(message);
    try {
      await mutate(`${path}/messages`, message, messageReceiptSchema);
      sessionStorage.removeItem(pendingKey);
      setPending(null);
      setText("");
      setRevision((current) => current + 1);
    } catch (error) {
      setErrorMessage(messageOf(error));
    }
    setBusy(false);
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
  const openSource = async (sourceId: string) => {
    const generation = currentAccessGeneration();
    try {
      const value = await request(
        `${path}/sources/${encoded(sourceId)}`,
        sourceSchema
      );
      assertCurrentAccess(generation);
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

  return (
    <section className="conversation-panel" aria-label="Conversation">
      <ConversationHeader
        agentName={agentName}
        sessionId={conversation?.sessionId}
        connected={connected}
        connection={connection}
        fixture={fixture}
        toggle={() => setConnected((value) => !value)}
      />
      {errorMessage ? (
        <p className="error-banner" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <div
        className="transcript"
        ref={transcript}
        aria-live="polite"
        aria-relevant="additions"
      >
        {items.length === 0 ? (
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
        {items.map((item) => {
          switch (item.type) {
            case "user": {
              return (
                <article
                  className="chat-message user-message"
                  key={item.cursor}
                >
                  <p className="message-label">You</p>
                  <p>{item.text}</p>
                </article>
              );
            }
            case "output": {
              return (
                <article
                  className="chat-message answer-message"
                  key={item.cursor}
                >
                  <p className="message-label">{agentName}</p>
                  <p>{item.text}</p>
                </article>
              );
            }
            case "citation": {
              return (
                <button
                  className="citation-button"
                  key={item.cursor}
                  type="button"
                  onClick={() => openSource(item.sourceId)}
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
            disabled={busy}
            type="button"
            onClick={() => send(pending)}
          >
            Retry message
          </button>
        </div>
      ) : null}
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
          disabled={busy || Boolean(pending)}
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
            disabled={busy || !text.trim() || Boolean(pending)}
          >
            {busy ? "Sending..." : "Send message"}
          </button>
        </div>
      </form>
      <details className="execution-history">
        <summary>
          Execution history <span>{history?.runs.length ?? 0} runs</span>
        </summary>
        {history?.runs.map((run) => (
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
