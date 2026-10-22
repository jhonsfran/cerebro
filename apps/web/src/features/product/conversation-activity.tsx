import type {
  ChatActivity,
  ChatChild,
  ChatControl,
  ChatRecurrence,
} from "@cerebro/contracts/session-service";
import { useId, useRef, useState } from "react";

import { ConversationTranscript } from "./conversation-transcript";
import { operationFor } from "./intent";
import type { OperationIntent } from "./intent";

const childStates = {
  failed: "Failed",
  interrupted: "Interrupted",
  running: "Running",
  succeeded: "Completed",
} satisfies Record<ChatChild["state"], string>;

const recurrenceUnits = ["minute", "hour", "day", "week", "month"] as const;
const isRecurrenceUnit = (value: string): value is ChatRecurrence["unit"] =>
  recurrenceUnits.some((unit) => unit === value);
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
  <details className="child-work">
    <summary>
      <span>{child.purpose === "history" ? "History search" : "Subagent"}</span>
      <strong>{child.title || "Delegated task"}</strong>
      <span className="tool-status">{childStates[child.state]}</span>
    </summary>
    <div className="child-work-body">
      <p className="muted-text">
        Approvals for this task appear in the main conversation.
      </p>
      {child.state === "running" ? (
        <button
          className="quiet-button"
          type="button"
          disabled={disabled}
          onClick={() => control({ childId: child.id, kind: "stop-child" })}
        >
          Stop subagent
        </button>
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
        />
      ) : (
        <p className="muted-text">No messages yet.</p>
      )}
      <p className="task-identity">
        Task {child.ownerTaskId} · Conversation {child.id}
      </p>
    </div>
  </details>
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
    <details className="reminder-create">
      <summary>Schedule a follow-up</summary>
      <form
        className="reminder-form"
        onSubmit={(event) => {
          event.preventDefault();
          void schedule();
        }}
      >
        <label htmlFor={`${id}-instruction`}>Instruction</label>
        <textarea
          id={`${id}-instruction`}
          value={instruction}
          maxLength={16_000}
          rows={2}
          required
          disabled={disabled}
          onChange={(event) => setInstruction(event.target.value)}
        />
        <label htmlFor={`${id}-time`}>First run (your local time)</label>
        <input
          id={`${id}-time`}
          type="datetime-local"
          value={runAt}
          required
          disabled={disabled}
          onChange={(event) => setRunAt(event.target.value)}
        />
        <label htmlFor={`${id}-repeat`}>Repeat</label>
        <select
          id={`${id}-repeat`}
          value={unit}
          disabled={disabled}
          onChange={(event) => {
            const { value } = event.target;
            if (value === "once" || isRecurrenceUnit(value)) {
              setUnit(value);
            }
          }}
        >
          <option value="once">Once</option>
          {recurrenceUnits.map((value) => (
            <option key={value} value={value}>
              Every {value}
            </option>
          ))}
        </select>
        {unit === "once" ? null : (
          <>
            <label htmlFor={`${id}-interval`}>Repeat interval</label>
            <input
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
            <label htmlFor={`${id}-timezone`}>Repeat timezone</label>
            <input
              id={`${id}-timezone`}
              value={timezone}
              required
              disabled={disabled}
              onChange={(event) => setTimezone(event.target.value)}
            />
            <p className="muted-text">
              Calendar repeats keep the scheduled local time in this timezone.
            </p>
          </>
        )}
        {error ? (
          <p className="error-banner" role="alert">
            {error}
          </p>
        ) : null}
        <button
          className="quiet-button"
          type="submit"
          disabled={disabled || !instruction.trim() || !runAt}
        >
          Schedule follow-up
        </button>
      </form>
    </details>
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
      className="conversation-activity"
      aria-label="Conversation activity"
    >
      {origin ? (
        <p className="fork-origin">
          Forked from{" "}
          {onConversation ? (
            <button
              className="quiet-button"
              type="button"
              onClick={() => onConversation(origin.conversationId)}
            >
              parent conversation
            </button>
          ) : (
            "another conversation"
          )}
          .
        </p>
      ) : null}
      <details>
        <summary className="activity-summary">
          Activity{" "}
          <span>
            {runningChildren} active subagents · {scheduled} scheduled
            follow-ups
          </span>
        </summary>
        <div className="activity-body">
          {activity.children.length > 0 ? (
            <section aria-label="Subagents">
              <h3>Subagents</h3>
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
            <details className="task-list">
              <summary>Active tasks ({activity.tasks.length})</summary>
              <ul>
                {activity.tasks.map((task) => (
                  <li key={task.id}>
                    <strong>{task.kind}</strong>{" "}
                    <span>
                      {task.state}
                      {task.background ? " · Background" : ""}
                    </span>
                    <p className="task-identity">
                      Task {task.id} ·{" "}
                      {task.ownerTaskId
                        ? `Owned by task ${task.ownerTaskId}`
                        : `Conversation ${task.conversationId}`}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <section aria-label="Scheduled follow-ups">
            <h3>Follow-ups</h3>
            <p className="muted-text">
              Stop ends current work. Future follow-ups remain scheduled. Cancel
              prevents future runs; an admitted run can continue.
            </p>
            {activity.reminders.length > 0 ? (
              <ul className="reminder-list">
                {activity.reminders.map((reminder) => (
                  <li key={reminder.id}>
                    <p>{reminder.instruction}</p>
                    <p className="muted-text">
                      {reminder.state === "scheduled"
                        ? `Next run ${dateTime.format(reminder.runAt)}`
                        : reminder.state}
                      {reminder.recurrence
                        ? ` · Every ${reminder.recurrence.interval} ${reminder.recurrence.unit}(s) · ${reminder.recurrence.timezone}`
                        : ""}
                    </p>
                    {reminder.state === "scheduled" ? (
                      <button
                        className="quiet-button"
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
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-text">No follow-ups scheduled.</p>
            )}
            <ReminderForm control={control} disabled={disabled} />
          </section>
          <section aria-label="Context compaction">
            <h3>Context</h3>
            {activity.compactions.map((compaction) => (
              <p className="muted-text" key={compaction.id}>
                Compacting ({compaction.reason}) · Attempt {compaction.attempt}
                {compaction.blocking ? " · Generation waits" : ""}
                {compaction.retryAt
                  ? ` · Retry ${dateTime.format(compaction.retryAt)}`
                  : ""}
              </p>
            ))}
            {activity.compactionFailure ? (
              <p className="error-banner" role="alert">
                {activity.compactionFailure}
              </p>
            ) : null}
            <button
              className="quiet-button"
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
            </button>
          </section>
        </div>
      </details>
    </section>
  );
};
