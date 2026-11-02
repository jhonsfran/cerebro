import type {
  ChatApproval,
  ChatMessage,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import { Bubble, BubbleContent } from "@cerebro/ui/components/bubble";
import { Button } from "@cerebro/ui/components/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@cerebro/ui/components/empty";
import {
  Message,
  MessageContent,
  MessageFooter,
} from "@cerebro/ui/components/message";
import { Spinner } from "@cerebro/ui/components/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cerebro/ui/components/tooltip";
import { cn } from "@cerebro/ui/lib/utils";
import { GitBranch, MessageSquare, ShieldCheck } from "lucide-react";
import { useEffect, useRef } from "react";

import { Disclosure } from "./disclosure";
import { MessageText } from "./message-text";
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

const MessageDetails = ({ message }: { message: ChatMessage }) => (
  <>
    {message.thinking ? (
      <Disclosure summary="Thinking" className="message-disclosure">
        <p className="text-muted-foreground whitespace-pre-wrap">
          {message.thinking}
        </p>
      </Disclosure>
    ) : null}
    {message.role === "tool" ? (
      <Disclosure summary="Tool result" className="message-disclosure">
        <pre>{message.text}</pre>
      </Disclosure>
    ) : null}
    {message.kind === "summary" ? (
      <Disclosure summary="Context summary" className="message-disclosure">
        <p className="text-muted-foreground whitespace-pre-wrap">
          {message.text}
        </p>
      </Disclosure>
    ) : null}
  </>
);

// The article's last paragraph is the message text; the label stays first.
const TranscriptMessage = ({
  message,
  agentName,
}: {
  message: ChatMessage;
  agentName: string;
}) => {
  const showText =
    message.kind !== "summary" && message.role !== "tool" && message.text;
  if (message.role === "user") {
    return (
      <Bubble variant="secondary" align="end">
        <BubbleContent
          className="text-sm"
          render={<article className="chat-message user-message" />}
        >
          <p className="sr-only">{messageLabel(message, agentName)}</p>
          {showText ? (
            <p className="whitespace-pre-wrap">{message.text}</p>
          ) : null}
        </BubbleContent>
      </Bubble>
    );
  }
  return (
    <article className="chat-message answer-message flex min-w-0 flex-col gap-3 text-sm/relaxed">
      <p className="text-muted-foreground text-xs font-medium">
        {messageLabel(message, agentName)}
      </p>
      <MessageDetails message={message} />
      {showText ? <MessageText text={message.text} /> : null}
    </article>
  );
};

// Inside its tool call the request drops the tool name the call already shows.
const ApprovalRequest = ({
  approval,
  attached = false,
  disabled,
  decide,
}: {
  approval: ChatApproval;
  attached?: boolean;
  disabled: boolean;
  decide: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
}) => (
  <section
    className={cn(
      "approval-card border-warning-border bg-warning flex flex-col gap-3 text-xs",
      attached ? "border-t px-3 py-3" : "border p-3"
    )}
    aria-label="Approval required"
  >
    {attached ? (
      <p className="text-warning-foreground flex items-center gap-2 font-medium">
        <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
        This tool waits for your approval before it runs.
      </p>
    ) : (
      <div className="flex flex-col gap-1">
        <h3 className="text-warning-foreground flex items-center gap-2 font-mono font-medium">
          <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
          {approval.toolId}
        </h3>
        <p className="text-warning-foreground">
          This tool waits for your approval before it runs.
        </p>
      </div>
    )}
    <Disclosure summary="Arguments" className="message-disclosure" open>
      <pre className="bg-background">
        {JSON.stringify(approval.arguments, null, 2)}
      </pre>
    </Disclosure>
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        disabled={disabled}
        type="button"
        onClick={() => decide(approval.approvalId, "allow")}
      >
        Approve request
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        type="button"
        onClick={() => decide(approval.approvalId, "deny")}
      >
        Deny request
      </Button>
    </div>
  </section>
);

// One message with the tool calls it made and their pending approvals.
const TranscriptEntry = ({
  message,
  agentName,
  tools,
  approvals,
  disabled,
  decide,
  fork,
}: {
  message: ChatMessage;
  agentName: string;
  tools: readonly ChatSnapshot["tools"][number][];
  approvals: ReadonlyMap<string, readonly ChatApproval[]>;
  disabled: boolean;
  decide: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  fork?: (entryId: string) => Promise<void>;
}) => {
  const { entryId } = message;
  const forkable =
    fork && entryId && message.state === "complete" && message.role !== "tool";
  return (
    <Message align={message.role === "user" ? "end" : "start"}>
      <MessageContent>
        {tools.length === 0 || message.text || message.thinking ? (
          <TranscriptMessage agentName={agentName} message={message} />
        ) : null}
        {tools.map((tool) => (
          <ToolExecution
            awaitingApproval={approvals.has(tool.id)}
            key={tool.id}
            tool={tool}
          >
            {(approvals.get(tool.id) ?? []).map((approval) => (
              <ApprovalRequest
                approval={approval}
                attached
                decide={decide}
                disabled={disabled}
                key={approval.approvalId}
              />
            ))}
          </ToolExecution>
        ))}
        {forkable ? (
          <MessageFooter className="px-0">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground"
                    aria-label="Fork from this message"
                    type="button"
                    disabled={disabled}
                    onClick={() => fork(entryId)}
                  />
                }
              >
                <GitBranch data-icon="inline-start" aria-hidden="true" />
                Fork
              </TooltipTrigger>
              <TooltipContent>
                Start a new conversation from this point
              </TooltipContent>
            </Tooltip>
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
};

type TranscriptSnapshot = Pick<
  ChatSnapshot,
  "messages" | "approvals" | "queuedInputs" | "tools" | "activity"
>;

// Groups tool calls under the message that made them and attaches each pending
// approval to its running call. A subagent's approvals stay unattached.
const placeApprovals = (snapshot: TranscriptSnapshot) => {
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
  return { activeApprovals, results, toolsByMessage, unassignedApprovals };
};

export const ConversationTranscript = ({
  snapshot,
  agentName,
  connecting,
  disabled,
  decide,
  fork,
  label = "Conversation messages",
  nested = false,
}: {
  snapshot: TranscriptSnapshot;
  agentName: string;
  connecting: boolean;
  disabled: boolean;
  decide: (approvalId: string, decision: "allow" | "deny") => Promise<void>;
  fork?: (entryId: string) => Promise<void>;
  label?: string;
  // A subagent's transcript inside the activity panel.
  nested?: boolean;
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
  const { results, toolsByMessage, activeApprovals, unassignedApprovals } =
    placeApprovals(snapshot);
  const empty =
    snapshot.messages.length === 0 && snapshot.queuedInputs.length === 0;
  return (
    <div
      className={cn(
        "transcript overflow-y-auto",
        nested ? "bg-background max-h-80 border" : "min-h-0 flex-1"
      )}
      ref={transcript}
      role="log"
      aria-label={label}
      aria-live="polite"
      aria-relevant="additions text"
      onScroll={trackPosition}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-(--measure-chat) flex-col",
          nested ? "gap-4 p-3" : "gap-6 px-4 py-6",
          empty && !nested && "h-full"
        )}
      >
        {empty ? (
          <Empty className={nested ? "p-4 md:p-4" : undefined}>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MessageSquare aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle className="font-display text-xl font-normal">
                Start with a question.
              </EmptyTitle>
              <EmptyDescription>
                Send a message to your company assistant.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {snapshot.messages.map((message) =>
          results.has(message.id) ? null : (
            <TranscriptEntry
              agentName={agentName}
              approvals={activeApprovals}
              decide={decide}
              disabled={disabled}
              fork={fork}
              key={message.id}
              message={message}
              tools={toolsByMessage.get(message.id) ?? []}
            />
          )
        )}
        {snapshot.queuedInputs.map((input) => (
          <Message align="end" key={input.submissionId}>
            <MessageContent>
              <Bubble variant="outline" align="end">
                <BubbleContent
                  className="border-dashed text-sm"
                  render={
                    <article className="chat-message user-message queued-message" />
                  }
                >
                  <p className="text-muted-foreground text-xs">Queued</p>
                  <p className="whitespace-pre-wrap">{input.text}</p>
                </BubbleContent>
              </Bubble>
            </MessageContent>
          </Message>
        ))}
        {connecting ? (
          <output className="text-muted-foreground flex items-center gap-2 text-xs">
            <Spinner />
            Connecting…
          </output>
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
    </div>
  );
};
