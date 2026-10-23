import type {
  ChatApproval,
  ChatMessage,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { useEffect, useRef } from "react";

import { ToolExecution } from "./tool-execution";

const messageLabel = (message: ChatMessage, agentName: string): string => {
  if (message.kind === "summary") {
    return "Context";
  }
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
    {message.kind === "summary" ? (
      <details>
        <summary>Context summary</summary>
        <p>{message.text}</p>
      </details>
    ) : null}
    {message.kind !== "summary" && message.role !== "tool" && message.text ? (
      <p>{message.text}</p>
    ) : null}
  </article>
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

export const ConversationTranscript = ({
  snapshot,
  agentName,
  connecting,
  disabled,
  decide,
  fork,
  label = "Conversation messages",
}: {
  snapshot: Pick<
    ChatSnapshot,
    "messages" | "approvals" | "queuedInputs" | "tools" | "activity"
  >;
  agentName: string;
  connecting: boolean;
  disabled: boolean;
  decide: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  fork?: (entryId: string) => Promise<void>;
  label?: string;
}) => {
  const transcript = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => {
    if (
      snapshot.messages.length === 0 &&
      snapshot.queuedInputs.length === 0 &&
      snapshot.approvals.length === 0
    ) {
      return;
    }
    const element = transcript.current;
    if (element && following.current) {
      element.scrollTo({ behavior: "instant", top: element.scrollHeight });
    }
  }, [snapshot]);
  const trackPosition = () => {
    const element = transcript.current;
    if (element) {
      following.current =
        element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
    }
  };
  const results = new Set(
    snapshot.tools.flatMap((tool) =>
      tool.resultMessageId ? [tool.resultMessageId] : []
    )
  );
  const approvals = snapshot.approvals.filter(
    (approval) => approval.state === "pending"
  );
  const activeApprovals = new Map<string, ChatApproval[]>();
  const activeCalls = new Map<string, ChatSnapshot["tools"][number]>();
  const toolsByMessage = new Map<string, ChatSnapshot["tools"][number][]>();
  for (const tool of snapshot.tools) {
    const tools = toolsByMessage.get(tool.messageId) ?? [];
    tools.push(tool);
    toolsByMessage.set(tool.messageId, tools);
    if (tool.state === "pending" || tool.state === "running") {
      activeCalls.set(JSON.stringify([tool.callId, tool.toolName]), tool);
    }
  }
  const unassignedApprovals: ChatApproval[] = [];
  const childConversations = new Set(
    snapshot.activity?.children.map((child) => child.id)
  );
  const childTasks = new Set(
    snapshot.activity?.tasks
      .filter((task) => childConversations.has(task.conversationId))
      .map((task) => task.id)
  );
  for (const approval of approvals) {
    const tool = childTasks.has(approval.taskId)
      ? undefined
      : activeCalls.get(JSON.stringify([approval.callId, approval.toolId]));
    if (tool) {
      const assigned = activeApprovals.get(tool.id) ?? [];
      assigned.push(approval);
      activeApprovals.set(tool.id, assigned);
    } else {
      unassignedApprovals.push(approval);
    }
  }
  return (
    <div
      className="transcript"
      ref={transcript}
      role="log"
      aria-label={label}
      aria-live="polite"
      aria-relevant="additions text"
      onScroll={trackPosition}
    >
      {snapshot.messages.length === 0 && snapshot.queuedInputs.length === 0 ? (
        <div className="conversation-empty">
          <span className="empty-mark">c</span>
          <h3>Start with a question.</h3>
          <p>Send a message to your company assistant.</p>
        </div>
      ) : null}
      {snapshot.messages.map((message) => {
        if (results.has(message.id)) {
          return null;
        }
        const tools = toolsByMessage.get(message.id) ?? [];
        const { entryId } = message;
        return (
          <div
            className={`transcript-entry ${message.role === "user" ? "transcript-entry-user" : ""}`}
            key={message.id}
          >
            {tools.length === 0 || message.text || message.thinking ? (
              <TranscriptMessage agentName={agentName} message={message} />
            ) : null}
            {tools.map((tool) => (
              <ToolExecution key={tool.id} tool={tool}>
                {(activeApprovals.get(tool.id) ?? []).map((approval) => (
                  <ApprovalRequest
                    approval={approval}
                    decide={decide}
                    disabled={disabled}
                    key={approval.approvalId}
                  />
                ))}
              </ToolExecution>
            ))}
            {fork &&
            entryId &&
            message.state === "complete" &&
            message.role !== "tool" ? (
              <button
                className="quiet-button message-fork"
                type="button"
                disabled={disabled}
                onClick={() => fork(entryId)}
              >
                Fork from this message
              </button>
            ) : null}
          </div>
        );
      })}
      {snapshot.queuedInputs.map((input) => (
        <article
          className="chat-message user-message queued-message"
          key={input.submissionId}
        >
          <p className="message-label">Queued</p>
          <p>{input.text}</p>
        </article>
      ))}
      {connecting ? (
        <output className="tool-status">Connecting...</output>
      ) : null}
      {unassignedApprovals.map((approval) => (
        <ApprovalRequest
          approval={approval}
          decide={decide}
          disabled={disabled}
          key={approval.approvalId}
        />
      ))}
    </div>
  );
};
