import type {
  DomainSnapshot,
  Observation,
} from "@cerebro/contracts/session-service";
import type { UIMessage } from "@tanstack/ai-client";

export interface ConversationProjection {
  readonly snapshot: DomainSnapshot;
  readonly provisional: Readonly<Record<string, string>>;
  readonly citations: readonly Extract<
    Observation,
    { type: "update" }
  >["update"][];
}

const upsert = <Value>(
  values: readonly Value[],
  next: Value,
  key: (value: Value) => string
): Value[] => {
  const index = values.findIndex((value) => key(value) === key(next));
  if (index === -1) {
    return [...values, next];
  }
  return values.map((value, position) => (position === index ? next : value));
};

export const projectObservation = (
  prior: ConversationProjection | null,
  frame: Observation
): ConversationProjection | null => {
  if (frame.type === "access-denied") {
    return null;
  }
  if (frame.type === "snapshot") {
    return { citations: [], provisional: {}, snapshot: frame.snapshot };
  }
  if (!prior) {
    throw new Error("Cannot project an update before its snapshot.");
  }
  const { update } = frame;
  const snapshot = { ...prior.snapshot, revision: frame.revision };
  let { provisional, citations } = prior;
  switch (update.type) {
    case "user-message": {
      snapshot.userMessages = upsert(
        snapshot.userMessages,
        update.message,
        (value) => value.eventId
      );
      break;
    }
    case "run": {
      snapshot.runs = upsert(snapshot.runs, update.run, (value) => value.runId);
      break;
    }
    case "approval": {
      snapshot.approvals = upsert(
        snapshot.approvals,
        update,
        (value) => value.approvalId
      );
      break;
    }
    case "tool": {
      snapshot.tools = upsert(
        snapshot.tools,
        update,
        (value) => value.operationId
      );
      break;
    }
    case "provisional-text": {
      if (!snapshot.outputs.some((output) => output.runId === update.runId)) {
        provisional = {
          ...provisional,
          [update.runId]: (provisional[update.runId] ?? "") + update.text,
        };
      }
      break;
    }
    case "canonical-output": {
      snapshot.outputs = upsert(
        snapshot.outputs,
        update.output,
        (value) => value.runId
      );
      provisional = Object.fromEntries(
        Object.entries(provisional).filter(
          ([runId]) => runId !== update.output.runId
        )
      );
      citations = citations.filter(
        (value) =>
          value.type !== "citation" || value.runId !== update.output.runId
      );
      break;
    }
    case "citation": {
      citations = upsert(citations, update, (value) =>
        value.type === "citation"
          ? `${value.runId}:${value.citation.sourceId}:${value.citation.sourceVersion}`
          : ""
      );
      break;
    }
    default: {
      update satisfies never;
    }
  }
  return { citations, provisional, snapshot };
};

export const projectionMessages = (
  projection: ConversationProjection | null
): UIMessage[] => {
  if (!projection) {
    return [];
  }
  const { snapshot, provisional } = projection;
  const messages: UIMessage[] = [];
  const outputs = new Map<string, string>(
    snapshot.outputs.map((output) => [output.runId, output.text])
  );
  const answered = new Set<string>();
  const lastUserMessage = new Map(
    snapshot.userMessages.map((message) => [message.runId, message.eventId])
  );
  const addAnswer = (runId: string) => {
    if (answered.has(runId)) {
      return;
    }
    answered.add(runId);
    const text = outputs.get(runId) ?? provisional[runId];
    if (text !== undefined) {
      messages.push({
        id: `assistant:${runId}`,
        parts: [{ content: text, type: "text" }],
        role: "assistant",
      });
    }
  };
  for (const message of snapshot.userMessages) {
    messages.push({
      id: message.eventId,
      parts: [{ content: message.text, type: "text" }],
      role: "user",
    });
    // Steering can join several accepted messages to one physical run.
    if (lastUserMessage.get(message.runId) === message.eventId) {
      addAnswer(message.runId);
    }
  }
  for (const run of snapshot.runs) {
    addAnswer(run.runId);
  }
  for (const output of snapshot.outputs) {
    addAnswer(output.runId);
  }
  for (const runId of Object.keys(provisional)) {
    addAnswer(runId);
  }
  return messages;
};
