import type { ExecutionId } from "@cerebro/contracts/identity";
import { DomainSnapshot } from "@cerebro/contracts/session-service";
import type {
  CanonicalOutput,
  DomainUpdate,
  ExecutionState,
  Observation,
} from "@cerebro/contracts/session-service";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { UIMessage } from "@tanstack/ai-client";
import { Schema } from "effect";

export interface ConversationProjection {
  readonly snapshot: DomainSnapshot;
  readonly provisional: Readonly<Partial<Record<ExecutionId, string>>>;
  readonly thinking: Readonly<Partial<Record<ExecutionId, string>>>;
  readonly citations: readonly Extract<DomainUpdate, { type: "citation" }>[];
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

const mergeExecution = (snapshot: DomainSnapshot, next: ExecutionState) => {
  const previous = snapshot.executions.find(
    (value) => value.executionId === next.executionId
  );
  if (
    previous &&
    !previous.runIds.every((runId, index) => runId === next.runIds[index])
  ) {
    throw new Error("Execution membership must preserve its ordered prefix.");
  }
  return upsert(snapshot.executions, next, (value) => value.executionId);
};

const mergeAnswer = (snapshot: DomainSnapshot, next: CanonicalOutput) => {
  const previous = snapshot.outputs.find(
    (value) => value.answerId === next.answerId
  );
  if (
    previous &&
    canonicalToolArguments(previous) !== canonicalToolArguments(next)
  ) {
    throw new Error("Canonical answers are immutable.");
  }
  return upsert(snapshot.outputs, next, (value) => value.answerId);
};

const requirePrimaryExecution = (
  snapshot: DomainSnapshot,
  update: Extract<
    DomainUpdate,
    { type: "citation" | "provisional-text" | "provisional-thinking" }
  >
) => {
  const execution = snapshot.executions.find(
    (value) => value.executionId === update.executionId
  );
  if (execution?.runIds[0] !== update.runId) {
    throw new Error(
      "Provisional observations must belong to the execution's primary run."
    );
  }
};

export const projectObservation = (
  prior: ConversationProjection | null,
  frame: Observation
): ConversationProjection | null => {
  if (frame.type === "access-denied") {
    return null;
  }
  if (frame.type === "snapshot") {
    return {
      citations: [],
      provisional: Object.fromEntries(
        (frame.partial ?? []).map((message) => [
          message.executionId,
          message.text,
        ])
      ),
      snapshot: frame.snapshot,
      thinking: Object.fromEntries(
        (frame.partial ?? []).map((message) => [
          message.executionId,
          message.thinking,
        ])
      ),
    };
  }
  if (!prior) {
    throw new Error("Cannot project an update before its snapshot.");
  }
  const { update } = frame;
  const snapshot = { ...prior.snapshot, revision: frame.revision };
  let { provisional, citations, thinking } = prior;
  switch (update.type) {
    case "execution": {
      snapshot.executions = mergeExecution(snapshot, update.execution);
      Schema.decodeUnknownSync(DomainSnapshot)(snapshot);
      break;
    }
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
      requirePrimaryExecution(snapshot, update);
      if (
        !snapshot.outputs.some(
          (output) => output.executionId === update.executionId
        )
      ) {
        provisional = {
          ...provisional,
          [update.executionId]:
            (provisional[update.executionId] ?? "") + update.text,
        };
      }
      break;
    }
    case "provisional-thinking": {
      requirePrimaryExecution(snapshot, update);
      if (
        !snapshot.outputs.some(
          (output) => output.executionId === update.executionId
        )
      ) {
        thinking = {
          ...thinking,
          [update.executionId]:
            (thinking[update.executionId] ?? "") + update.text,
        };
      }
      break;
    }
    case "canonical-output": {
      snapshot.outputs = mergeAnswer(snapshot, update.output);
      Schema.decodeUnknownSync(DomainSnapshot)(snapshot);
      provisional = Object.fromEntries(
        Object.entries(provisional).filter(
          ([executionId]) => executionId !== update.output.executionId
        )
      );
      thinking = Object.fromEntries(
        Object.entries(thinking).filter(
          ([executionId]) => executionId !== update.output.executionId
        )
      );
      citations = citations.filter(
        (value) => value.executionId !== update.output.executionId
      );
      break;
    }
    case "citation": {
      requirePrimaryExecution(snapshot, update);
      if (
        snapshot.outputs.some(
          (value) => value.executionId === update.executionId
        )
      ) {
        break;
      }
      citations = upsert(
        citations,
        update,
        (value) =>
          `${value.executionId}:${value.citation.sourceId}:${value.citation.sourceVersion}`
      );
      break;
    }
    default: {
      update satisfies never;
    }
  }
  return { citations, provisional, snapshot, thinking };
};

export const projectionMessages = (
  projection: ConversationProjection | null
): UIMessage[] => {
  if (!projection) {
    return [];
  }
  const { snapshot, provisional, thinking } = projection;
  const messages: UIMessage[] = [];
  const outputs = new Map(
    snapshot.outputs.map((output) => [output.executionId, output])
  );
  const answered = new Set<ExecutionId>();
  const executionsByRun = new Map(
    snapshot.executions.flatMap((execution) =>
      execution.runIds.map((runId) => [runId, execution] as const)
    )
  );
  const lastUserMessage = new Map(
    snapshot.userMessages.flatMap((message) => {
      const execution = executionsByRun.get(message.runId);
      return execution
        ? [[execution.executionId, message.eventId] as const]
        : [];
    })
  );
  const addAnswer = (executionId: ExecutionId) => {
    if (answered.has(executionId)) {
      return;
    }
    answered.add(executionId);
    const output = outputs.get(executionId);
    const text = output?.text ?? provisional[executionId];
    const visibleThinking = thinking[executionId];
    const thinkingParts = visibleThinking
      ? [
          {
            content: visibleThinking,
            stepId: `assistant:${executionId}`,
            type: "thinking" as const,
          },
        ]
      : [];
    const toolParts: UIMessage["parts"] = snapshot.tools
      .filter(
        (tool) => executionsByRun.get(tool.runId)?.executionId === executionId
      )
      .flatMap((tool): UIMessage["parts"] => [
        {
          arguments: JSON.stringify(tool.arguments),
          id: tool.operationId,
          name: tool.toolId,
          state: "input-complete",
          type: "tool-call",
        },
        ...(tool.state === "succeeded" || tool.state === "failed"
          ? [
              {
                content: JSON.stringify(tool.output),
                state:
                  tool.state === "succeeded"
                    ? ("complete" as const)
                    : ("error" as const),
                toolCallId: tool.operationId,
                type: "tool-result" as const,
              },
            ]
          : []),
      ]);
    if (text !== undefined || visibleThinking || toolParts.length) {
      messages.push({
        id: `assistant:${output?.answerId ?? executionId}`,
        parts: [
          ...thinkingParts,
          ...toolParts,
          ...(text === undefined
            ? []
            : [{ content: text, type: "text" as const }]),
        ],
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
    const execution = executionsByRun.get(message.runId);
    if (
      execution &&
      lastUserMessage.get(execution.executionId) === message.eventId
    ) {
      addAnswer(execution.executionId);
    }
  }
  for (const execution of snapshot.executions) {
    addAnswer(execution.executionId);
  }
  for (const output of snapshot.outputs) {
    addAnswer(output.executionId);
  }
  return messages;
};
