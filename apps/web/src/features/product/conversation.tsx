import type {
  ChatControl,
  ChatSnapshot,
} from "@cerebro/contracts/session-service";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@cerebro/ui/components/alert";
import { Badge } from "@cerebro/ui/components/badge";
import { Button } from "@cerebro/ui/components/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@cerebro/ui/components/input-group";
import { Kbd } from "@cerebro/ui/components/kbd";
import { Label } from "@cerebro/ui/components/label";
import { Spinner } from "@cerebro/ui/components/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@cerebro/ui/components/tooltip";
import { ArrowUp, Clock, RotateCw, Square } from "lucide-react";
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
import { ErrorAlert } from "./feedback";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";
import type { ObservationConnectionStatus } from "./observation";
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
    className="bg-background sticky bottom-0 mx-auto w-full max-w-(--measure-chat) px-4 pt-2 pb-4"
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
    <Label className="sr-only" htmlFor="message">
      Message
    </Label>
    <InputGroup className="bg-card">
      <InputGroupTextarea
        id="message"
        aria-describedby="message-help"
        className="max-h-60 min-h-16 text-sm"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder="Ask your company assistant…"
        rows={2}
        maxLength={MAX_CHAT_MESSAGE_LENGTH}
        disabled={sending || !connected || Boolean(pending)}
      />
      <InputGroupAddon align="block-end">
        <InputGroupText id="message-help" className="hidden sm:flex">
          <span>
            <Kbd>Enter</Kbd> sends, <Kbd>Shift</Kbd> + <Kbd>Enter</Kbd> adds a
            line. Your conversation is private.
          </span>
        </InputGroupText>
        <InputGroupButton
          type="submit"
          variant="default"
          size="sm"
          className="ml-auto"
          disabled={sending || !connected || !text.trim() || Boolean(pending)}
        >
          {sending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ArrowUp data-icon="inline-start" aria-hidden="true" />
          )}
          {sending ? "Sending…" : "Send message"}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  </form>
);

const SESSION_PREFIX = /^session:/u;

const connectionLabels = {
  connected: "Connected",
  connecting: "Connecting…",
  denied: "Access denied",
  disconnected: "Disconnected",
  failed: "Connection failed",
} satisfies Record<ObservationConnectionStatus, string>;

const connectionVariant = (
  connection: ObservationConnectionStatus
): "secondary" | "outline" | "destructive" => {
  if (connection === "connected") {
    return "secondary";
  }
  return connection === "failed" || connection === "denied"
    ? "destructive"
    : "outline";
};

const ConversationToolbar = ({
  sessionId,
  connection,
  connected,
  busy,
  disabled,
  toggle,
  reconnect,
  stop,
}: {
  sessionId: string | undefined;
  connection: ObservationConnectionStatus;
  connected: boolean;
  busy: boolean;
  disabled: boolean;
  toggle: () => void;
  reconnect: () => void;
  stop: () => Promise<void>;
}) => (
  <div className="flex min-h-11 flex-wrap items-center gap-2 border-b px-4 py-1.5">
    <Badge
      variant={connectionVariant(connection)}
      render={<output data-state={connection} />}
    >
      {connection === "connecting" ? (
        <Spinner data-icon="inline-start" />
      ) : null}
      {connectionLabels[connection]}
    </Badge>
    <Tooltip>
      <TooltipTrigger
        render={
          <p className="text-muted-foreground min-w-0 truncate text-xs tabular-nums" />
        }
      >
        Session{" "}
        {sessionId?.replace(SESSION_PREFIX, "").slice(0, 12) ?? "loading"}
      </TooltipTrigger>
      <TooltipContent>{sessionId ?? "Loading the session"}</TooltipContent>
    </Tooltip>
    <div className="ml-auto flex items-center gap-1">
      {busy ? (
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={disabled}
          onClick={stop}
        >
          <Square data-icon="inline-start" aria-hidden="true" />
          Stop
        </Button>
      ) : null}
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={connection === "failed" ? reconnect : toggle}
      >
        {connected && connection !== "failed" ? "Disconnect" : "Reconnect"}
      </Button>
    </div>
  </div>
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
      <ErrorAlert className="m-4 w-auto">
        Conversation access is no longer available.
      </ErrorAlert>
    );
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Conversation">
      <ConversationToolbar
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
        <div className="mx-auto flex w-full max-w-(--measure-chat) flex-col items-start gap-2 px-4 pt-4">
          <ErrorAlert>{displayedError}</ErrorAlert>
          {!conversation && onStartConversation ? (
            <Button
              variant="outline"
              type="button"
              onClick={onStartConversation}
            >
              Start new conversation
            </Button>
          ) : null}
        </div>
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
        <div className="mx-auto w-full max-w-(--measure-chat) px-4">
          <Alert
            role="note"
            className="border-warning-border bg-warning text-warning-foreground"
          >
            {delivery.sending ? <Spinner /> : <Clock aria-hidden="true" />}
            <AlertDescription className="text-warning-foreground">
              {delivery.sending
                ? "Confirming your message…"
                : "Your message awaits confirmation."}
            </AlertDescription>
            <AlertAction>
              <Button
                variant="outline"
                size="sm"
                disabled={!online || delivery.sending}
                type="button"
                onClick={() => delivery.retry()}
              >
                <RotateCw data-icon="inline-start" aria-hidden="true" />
                Retry message
              </Button>
            </AlertAction>
          </Alert>
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
