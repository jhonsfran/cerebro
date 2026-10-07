import { EventType } from "@ag-ui/core";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ExecutionId } from "@cerebro/contracts/identity";
import { Observation } from "@cerebro/contracts/session-service";
import type {
  DomainSnapshot,
  DomainUpdate,
  ExecutionState,
} from "@cerebro/contracts/session-service";
import type { StreamChunk } from "@tanstack/ai";
import { Schema, Stream } from "effect";
import type { Scope } from "effect";

import { projectObservation } from "./projection.ts";
import type { ConversationProjection } from "./projection.ts";

export const decodeObservation = Schema.decodeUnknownSync(Observation);

export const sameAddress = (
  left: Observation["address"],
  right: Observation["address"]
): boolean =>
  left.organizationId === right.organizationId &&
  left.conversationId === right.conversationId &&
  left.agentId === right.agentId &&
  left.sessionId === right.sessionId;

export class ResnapshotRequiredError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ResnapshotRequiredError";
  }
}

export const createObservationGuard = (
  address: Observation["address"],
  accessGeneration: number
) => {
  let epoch: string | undefined;
  let sequence = -1;
  let revision = -1;
  const retiredEpochs = new Set<string>();
  let denied = false;
  const acceptSnapshot = (
    frame: Extract<Observation, { type: "snapshot" }>
  ) => {
    if (!sameAddress(frame.address, frame.snapshot.address)) {
      throw new ResnapshotRequiredError("Snapshot address changed.");
    }
    if (frame.epoch === epoch && frame.sequence <= sequence) {
      return;
    }
    if (
      frame.sequence !== 0 ||
      frame.snapshot.revision < revision ||
      frame.epoch === epoch
    ) {
      throw new ResnapshotRequiredError(
        "A fresh canonical snapshot is required."
      );
    }
    if (epoch) {
      retiredEpochs.add(epoch);
    }
    ({ epoch } = frame);
    sequence = 0;
    ({ revision } = frame.snapshot);
    return frame;
  };
  return (input: unknown): Observation | undefined => {
    if (denied) {
      return;
    }
    const frame = decodeObservation(input);
    if (
      !sameAddress(frame.address, address) ||
      frame.accessGeneration !== accessGeneration ||
      retiredEpochs.has(frame.epoch)
    ) {
      return;
    }
    if (frame.type === "snapshot") {
      return acceptSnapshot(frame);
    }
    if (epoch && frame.epoch !== epoch) {
      return;
    }
    // Denial may be the first frame when access changes after HTTP headers.
    if (frame.type === "access-denied") {
      denied = true;
      return frame;
    }
    if (!epoch) {
      throw new ResnapshotRequiredError(
        "The observation must start with a snapshot."
      );
    }
    if (frame.sequence <= sequence) {
      return;
    }
    if (frame.sequence !== sequence + 1) {
      throw new ResnapshotRequiredError("Observation sequence gap.");
    }
    ({ sequence } = frame);
    if (frame.update.type === "provisional-text") {
      if (frame.revision !== revision) {
        throw new ResnapshotRequiredError(
          "Provisional text has a stale revision."
        );
      }
    } else if (frame.revision !== revision + 1) {
      throw new ResnapshotRequiredError("Committed observation revision gap.");
    }
    ({ revision } = frame);
    return frame;
  };
};

export const observationEvent = (frame: Observation): StreamChunk => ({
  name: `cerebro.${frame.type === "update" ? frame.update.type : frame.type}`,
  type: EventType.CUSTOM,
  value: decodeObservation(frame),
});

export const decodeCustomObservation = (event: {
  readonly name: string;
  readonly value: unknown;
}): Observation => {
  const frame = decodeObservation(event.value);
  if (
    event.name !==
    `cerebro.${frame.type === "update" ? frame.update.type : frame.type}`
  ) {
    throw new Error("Cerebro custom event name does not match its payload.");
  }
  return frame;
};

export const createProtocolProjection = () => {
  let projection: ConversationProjection | null = null;
  const textStarted = new Set<ExecutionId>();
  const toolsStarted = new Set<string>();
  const startedExecutions = new Set<ExecutionId>();
  const settledExecutions = new Set<ExecutionId>();
  const resetSnapshot = (snapshot: DomainSnapshot) => {
    textStarted.clear();
    toolsStarted.clear();
    startedExecutions.clear();
    settledExecutions.clear();
    for (const execution of snapshot.executions) {
      const runs = execution.runIds.map((runId) =>
        snapshot.runs.find((run) => run.runId === runId)
      );
      if (
        runs.some(
          (run) =>
            run?.state === "running" || run?.state === "waiting-for-approval"
        )
      ) {
        startedExecutions.add(execution.executionId);
      }
      if (
        runs.every(
          (run) =>
            run &&
            ["completed", "cancelled", "failed", "unknown-outcome"].includes(
              run.state
            )
        )
      ) {
        settledExecutions.add(execution.executionId);
      }
    }
  };
  const lifecycleEvents = (execution: ExecutionState): StreamChunk[] => {
    if (!projection || settledExecutions.has(execution.executionId)) {
      return [];
    }
    const { snapshot } = projection;
    const runs = execution.runIds.map((runId) =>
      snapshot.runs.find((run) => run.runId === runId)
    );
    const failure = runs.find(
      (run) => run?.state === "failed" || run?.state === "unknown-outcome"
    );
    if (failure) {
      settledExecutions.add(execution.executionId);
      return [
        {
          message:
            failure.state === "unknown-outcome"
              ? "The remote outcome is unknown. Reconciliation is required."
              : "Execution failed.",
          type: EventType.RUN_ERROR,
        },
      ];
    }
    if (
      runs.every((run) => run?.state === "completed") &&
      snapshot.outputs.some(
        (output) => output.executionId === execution.executionId
      )
    ) {
      settledExecutions.add(execution.executionId);
      return [
        {
          runId: execution.executionId,
          threadId: snapshot.address.conversationId,
          type: EventType.RUN_FINISHED,
        },
      ];
    }
    if (
      runs.every((run) => run && ["completed", "cancelled"].includes(run.state))
    ) {
      settledExecutions.add(execution.executionId);
      return [];
    }
    if (
      runs.some((run) => run?.state === "running") &&
      !startedExecutions.has(execution.executionId)
    ) {
      startedExecutions.add(execution.executionId);
      return [
        {
          runId: execution.executionId,
          threadId: snapshot.address.conversationId,
          type: EventType.RUN_STARTED,
        },
      ];
    }
    return [];
  };
  const toolEvents = (
    update: Extract<DomainUpdate, { type: "tool" }>
  ): StreamChunk[] => {
    const events: StreamChunk[] = [];
    const toolCallId = update.operationId;
    const execution = projection?.snapshot.executions.find((value) =>
      value.runIds.includes(update.runId)
    );
    const output = projection?.snapshot.outputs.find(
      (value) => value.executionId === execution?.executionId
    );
    if (!toolsStarted.has(toolCallId)) {
      toolsStarted.add(toolCallId);
      events.push(
        {
          ...(execution
            ? {
                parentMessageId: `assistant:${output?.answerId ?? execution.executionId}`,
              }
            : {}),
          toolCallId,
          toolCallName: update.toolId,
          type: EventType.TOOL_CALL_START,
        },
        {
          delta: JSON.stringify(update.arguments),
          toolCallId,
          type: EventType.TOOL_CALL_ARGS,
        },
        { toolCallId, type: EventType.TOOL_CALL_END }
      );
    }
    if (update.state === "succeeded" || update.state === "failed") {
      events.push({
        content: JSON.stringify(update.output),
        messageId: `tool:${toolCallId}`,
        role: "tool",
        toolCallId,
        type: EventType.TOOL_CALL_RESULT,
      });
    }
    return events;
  };
  return (frame: Observation): StreamChunk[] => {
    projection = projectObservation(projection, frame);
    const events: StreamChunk[] = [observationEvent(frame)];
    if (frame.type === "snapshot") {
      resetSnapshot(frame.snapshot);
      return events;
    }
    if (frame.type !== "update") {
      return events;
    }
    const { update } = frame;
    if (update.type === "provisional-text") {
      if (
        projection?.snapshot.outputs.some(
          (output) => output.executionId === update.executionId
        )
      ) {
        return events;
      }
      const messageId = `assistant:${update.executionId}`;
      if (!textStarted.has(update.executionId)) {
        textStarted.add(update.executionId);
        events.push({
          messageId,
          role: "assistant",
          type: EventType.TEXT_MESSAGE_START,
        });
      }
      events.push({
        delta: update.text,
        messageId,
        type: EventType.TEXT_MESSAGE_CONTENT,
      });
    } else if (update.type === "canonical-output") {
      if (textStarted.delete(update.output.executionId)) {
        events.push({
          messageId: `assistant:${update.output.executionId}`,
          type: EventType.TEXT_MESSAGE_END,
        });
      }
    } else if (update.type === "run" || update.type === "execution") {
      const execution =
        update.type === "execution"
          ? update.execution
          : projection?.snapshot.executions.find((value) =>
              value.runIds.includes(update.run.runId)
            );
      if (execution) {
        events.push(...lifecycleEvents(execution));
      }
    } else if (update.type === "tool") {
      events.push(...toolEvents(update));
    }
    return events;
  };
};

// The iterator owns only the observer scope. Returning it cannot stop durable work.
export const observationIterable = (
  source: Stream.Stream<Observation, ContractFailure, Scope.Scope>
): AsyncIterable<Observation> => Stream.toAsyncIterable(Stream.scoped(source));

export const observationResponse = (
  source: Stream.Stream<Observation, ContractFailure, Scope.Scope>
): Response => {
  const encoder = new TextEncoder();
  const body = Stream.map(Stream.scoped(source), (frame) =>
    encoder.encode(`${JSON.stringify(decodeObservation(frame))}\n`)
  );
  return new Response(Stream.toReadableStream(body), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson",
    },
  });
};
