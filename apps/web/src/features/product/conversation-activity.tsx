import type {
  ChatActivity,
  ChatChild,
  ChatControl,
  ChatRecurrence,
} from "@cerebro/contracts/session-service";
import { Badge } from "@cerebro/ui/components/badge";
import { Button } from "@cerebro/ui/components/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@cerebro/ui/components/field";
import { Input } from "@cerebro/ui/components/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@cerebro/ui/components/item";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cerebro/ui/components/select";
import { Separator } from "@cerebro/ui/components/separator";
import { Textarea } from "@cerebro/ui/components/textarea";
import { Activity } from "lucide-react";
import { useId, useRef, useState } from "react";

import { BackgroundWork } from "./background-work";
import { ConversationTranscript } from "./conversation-transcript";
import { Disclosure } from "./disclosure";
import { ErrorAlert } from "./feedback";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";

const childStates = {
  failed: "Failed",
  interrupted: "Interrupted",
  running: "Running",
  succeeded: "Completed",
} satisfies Record<ChatChild["state"], string>;

const recurrenceUnits = ["minute", "hour", "day", "week", "month"] as const;
const isRecurrenceUnit = (value: unknown): value is ChatRecurrence["unit"] =>
  recurrenceUnits.some((unit) => unit === value);
const repeatChoices = [
  { label: "Once", value: "once" },
  ...recurrenceUnits.map((unit) => ({ label: `Every ${unit}`, value: unit })),
];
const dateTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

type Control = (command: ChatControl) => Promise<boolean>;

const ChildWork = ({
  child,
  disabled,
  control,
}: {
  child: ChatChild;
  disabled: boolean;
  control: Control;
}) => (
  <Disclosure
    className="bg-card border p-2"
    summaryClassName="text-foreground w-full"
    summary={
      <>
        <span className="text-muted-foreground font-normal">
          {child.purpose === "history" ? "History search" : "Subagent"}
        </span>
        <strong className="min-w-0 truncate font-medium">
          {child.title || "Delegated task"}
        </strong>
        <Badge
          variant={child.state === "failed" ? "destructive" : "outline"}
          className="ml-auto"
        >
          {childStates[child.state]}
        </Badge>
      </>
    }
  >
    <p className="text-muted-foreground">
      Approvals for this task appear in the main conversation.
    </p>
    {child.state === "running" ? (
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        type="button"
        disabled={disabled}
        onClick={() => control({ childId: child.id, kind: "stop-child" })}
      >
        Stop subagent
      </Button>
    ) : null}
    {child.messages.length > 0 || child.tools.length > 0 ? (
      <ConversationTranscript
        snapshot={{
          approvals: [],
          messages: child.messages,
          queuedInputs: [],
          tools: child.tools,
        }}
        agentName="Subagent"
        connecting={false}
        disabled={disabled}
        decide={() => Promise.resolve()}
        label={`Subagent ${child.title || child.id} messages`}
        nested
      />
    ) : (
      <p className="text-muted-foreground">No messages yet.</p>
    )}
    <p className="text-muted-foreground break-all">
      Task {child.ownerTaskId} · Conversation {child.id}
    </p>
  </Disclosure>
);

const ReminderForm = ({
  disabled,
  control,
}: {
  disabled: boolean;
  control: Control;
}) => {
  const id = useId();
  const [instruction, setInstruction] = useState("");
  const [runAt, setRunAt] = useState("");
  const [unit, setUnit] = useState<"once" | ChatRecurrence["unit"]>("once");
  const [repeatInterval, setRepeatInterval] = useState(1);
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone
  );
  const [error, setError] = useState("");
  const intent = useRef<OperationIntent | null>(null);
  const schedule = async () => {
    const time = new Date(runAt).getTime();
    if (!Number.isFinite(time) || time <= Date.now()) {
      setError("Choose a future date and time.");
      return;
    }
    if (unit !== "once") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
      } catch {
        setError("Enter a valid IANA timezone, such as America/Bogota.");
        return;
      }
    }
    setError("");
    const input = {
      instruction: instruction.trim(),
      ...(unit === "once"
        ? {}
        : { recurrence: { interval: repeatInterval, timezone, unit } }),
      runAt: time,
    };
    const accepted = await control({
      ...input,
      kind: "schedule",
      operationId: operationFor(intent, input),
    });
    if (accepted) {
      setInstruction("");
      intent.current = null;
    }
  };
  return (
    <Disclosure summary="Schedule a follow-up">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void schedule();
        }}
      >
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor={`${id}-instruction`}>Instruction</FieldLabel>
            <Textarea
              id={`${id}-instruction`}
              value={instruction}
              maxLength={16_000}
              rows={2}
              required
              disabled={disabled}
              onChange={(event) => setInstruction(event.target.value)}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor={`${id}-time`}>
                First run (your local time)
              </FieldLabel>
              <Input
                id={`${id}-time`}
                type="datetime-local"
                value={runAt}
                required
                disabled={disabled}
                onChange={(event) => setRunAt(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-repeat`}>Repeat</FieldLabel>
              <Select
                items={repeatChoices}
                value={unit}
                disabled={disabled}
                onValueChange={(value) => {
                  if (value === "once" || isRecurrenceUnit(value)) {
                    setUnit(value);
                  }
                }}
              >
                <SelectTrigger id={`${id}-repeat`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {repeatChoices.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {unit === "once" ? null : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-interval`}>
                  Repeat interval
                </FieldLabel>
                <Input
                  id={`${id}-interval`}
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  value={repeatInterval}
                  required
                  disabled={disabled}
                  onChange={(event) =>
                    setRepeatInterval(event.target.valueAsNumber)
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-timezone`}>
                  Repeat timezone
                </FieldLabel>
                <Input
                  id={`${id}-timezone`}
                  value={timezone}
                  required
                  disabled={disabled}
                  onChange={(event) => setTimezone(event.target.value)}
                />
                <FieldDescription>
                  Calendar repeats keep the scheduled local time in this
                  timezone.
                </FieldDescription>
              </Field>
            </div>
          )}
          {error ? <ErrorAlert>{error}</ErrorAlert> : null}
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            type="submit"
            disabled={disabled || !instruction.trim() || !runAt}
          >
            Schedule follow-up
          </Button>
        </FieldGroup>
      </form>
    </Disclosure>
  );
};

export const ConversationActivity = ({
  activity,
  disabled,
  control,
  onConversation,
}: {
  activity: ChatActivity | undefined;
  disabled: boolean;
  control: Control;
  onConversation?: (conversationId: string) => void;
}) => {
  const compactIntent = useRef<OperationIntent | null>(null);
  if (!activity) {
    return null;
  }
  const { origin } = activity;
  const runningChildren = activity.children.filter(
    (child) => child.state === "running"
  ).length;
  const scheduled = activity.reminders.filter(
    (reminder) => reminder.state === "scheduled"
  ).length;
  return (
    <section
      className="conversation-activity mx-auto flex w-full max-w-(--measure-chat) flex-col gap-2 px-4 pb-2"
      aria-label="Conversation activity"
    >
      {activity.backgroundWork ? (
        <BackgroundWork
          key={activity.backgroundWork.workId}
          work={activity.backgroundWork}
          disabled={disabled}
          control={control}
        />
      ) : null}
      {origin ? (
        <p className="text-muted-foreground text-xs">
          Forked from{" "}
          {onConversation ? (
            <Button
              variant="link"
              size="xs"
              className="h-auto px-0"
              type="button"
              onClick={() => onConversation(origin.conversationId)}
            >
              parent conversation
            </Button>
          ) : (
            "another conversation"
          )}
          .
        </p>
      ) : null}
      <Disclosure
        className="bg-card border"
        summaryClassName="text-foreground w-full px-3 py-2"
        summary={
          <>
            <Activity aria-hidden="true" className="size-3.5" />
            Activity
            <span className="text-muted-foreground ml-auto hidden gap-3 font-normal sm:flex">
              <span>{runningChildren} active subagents</span>
              <span>{scheduled} scheduled follow-ups</span>
            </span>
          </>
        }
      >
        <div className="flex max-h-[50svh] flex-col gap-4 overflow-y-auto border-t px-3 py-3">
          {activity.children.length > 0 ? (
            <section aria-label="Subagents" className="flex flex-col gap-2">
              <h3 className="font-medium">Subagents</h3>
              {activity.children.map((child) => (
                <ChildWork
                  child={child}
                  control={control}
                  disabled={disabled}
                  key={child.id}
                />
              ))}
            </section>
          ) : null}
          {activity.tasks.length > 0 ? (
            <Disclosure summary={`Active tasks (${activity.tasks.length})`}>
              <ItemGroup className="gap-1">
                {activity.tasks.map((task) => (
                  <Item variant="muted" size="xs" key={task.id}>
                    <ItemContent>
                      <ItemTitle>
                        {task.kind}
                        <span className="text-muted-foreground font-normal">
                          {task.state}
                          {task.background ? ", background" : ""}
                        </span>
                      </ItemTitle>
                      <ItemDescription className="break-all">
                        Task {task.id} ·{" "}
                        {task.ownerTaskId
                          ? `Owned by task ${task.ownerTaskId}`
                          : `Conversation ${task.conversationId}`}
                      </ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </Disclosure>
          ) : null}
          <section
            aria-label="Scheduled follow-ups"
            className="flex flex-col gap-2"
          >
            <h3 className="font-medium">Follow-ups</h3>
            <p className="text-muted-foreground">
              Stop ends current work. Future follow-ups remain scheduled. Cancel
              prevents future runs; an admitted run can continue.
            </p>
            {activity.reminders.length > 0 ? (
              <ItemGroup className="gap-1">
                {activity.reminders.map((reminder) => (
                  <Item variant="outline" size="xs" key={reminder.id}>
                    <ItemContent>
                      <ItemTitle className="whitespace-pre-wrap">
                        {reminder.instruction}
                      </ItemTitle>
                      <ItemDescription>
                        {reminder.state === "scheduled"
                          ? `Next run ${dateTime.format(reminder.runAt)}`
                          : reminder.state}
                        {reminder.recurrence
                          ? `, every ${reminder.recurrence.interval} ${reminder.recurrence.unit}(s) in ${reminder.recurrence.timezone}`
                          : ""}
                      </ItemDescription>
                    </ItemContent>
                    {reminder.state === "scheduled" ? (
                      <ItemActions>
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            control({
                              kind: "cancel-schedule",
                              scheduleId: reminder.id,
                            })
                          }
                        >
                          Cancel future runs
                        </Button>
                      </ItemActions>
                    ) : null}
                  </Item>
                ))}
              </ItemGroup>
            ) : (
              <p className="text-muted-foreground">No follow-ups scheduled.</p>
            )}
            <ReminderForm control={control} disabled={disabled} />
          </section>
          <Separator />
          <section
            aria-label="Context compaction"
            className="flex flex-col gap-2"
          >
            <h3 className="font-medium">Context</h3>
            {activity.compactions.map((compaction) => (
              <p className="text-muted-foreground" key={compaction.id}>
                Compacting ({compaction.reason}) · Attempt {compaction.attempt}
                {compaction.blocking ? " · Generation waits" : ""}
                {compaction.retryAt
                  ? ` · Retry ${dateTime.format(compaction.retryAt)}`
                  : ""}
              </p>
            ))}
            {activity.compactionFailure ? (
              <ErrorAlert>{activity.compactionFailure}</ErrorAlert>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              type="button"
              disabled={disabled || activity.compactions.length > 0}
              onClick={async () => {
                const accepted = await control({
                  kind: "compact",
                  operationId: operationFor(compactIntent, {}),
                });
                if (accepted) {
                  compactIntent.current = null;
                }
              }}
            >
              Compact context
            </Button>
          </section>
        </div>
      </Disclosure>
    </section>
  );
};
