import { EventType } from "@ag-ui/core";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { Observation } from "@cerebro/contracts/session-service";
import type { StreamChunk } from "@tanstack/ai";
import { Schema, Stream } from "effect";
import type { Scope } from "effect";

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
  const textStarted = new Set<string>();
  const toolsStarted = new Set<string>();
  const canonicalRuns = new Set<string>();
  return (frame: Observation): StreamChunk[] => {
    const events: StreamChunk[] = [observationEvent(frame)];
    if (frame.type === "snapshot") {
      textStarted.clear();
      toolsStarted.clear();
      canonicalRuns.clear();
      for (const output of frame.snapshot.outputs) {
        canonicalRuns.add(output.runId);
      }
      return events;
    }
    if (frame.type !== "update") {
      return events;
    }
    const { update } = frame;
    const threadId = frame.address.conversationId;
    if (update.type === "provisional-text") {
      if (canonicalRuns.has(update.runId)) {
        return events;
      }
      const messageId = `assistant:${update.runId}`;
      if (!textStarted.has(messageId)) {
        textStarted.add(messageId);
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
      canonicalRuns.add(update.output.runId);
      if (textStarted.delete(`assistant:${update.output.runId}`)) {
        events.push({
          messageId: `assistant:${update.output.runId}`,
          type: EventType.TEXT_MESSAGE_END,
        });
      }
    } else if (update.type === "run") {
      const { run } = update;
      if (run.state === "running") {
        events.push({
          runId: run.runId,
          threadId,
          type: EventType.RUN_STARTED,
        });
      } else if (run.state === "completed") {
        events.push({
          runId: run.runId,
          threadId,
          type: EventType.RUN_FINISHED,
        });
      } else if (["failed", "unknown-outcome"].includes(run.state)) {
        events.push({
          message:
            run.state === "unknown-outcome"
              ? "The remote outcome is unknown. Reconciliation is required."
              : "Execution failed.",
          type: EventType.RUN_ERROR,
        });
      }
    } else if (update.type === "tool") {
      const toolCallId = update.operationId;
      if (!toolsStarted.has(toolCallId)) {
        toolsStarted.add(toolCallId);
        events.push(
          {
            parentMessageId: `assistant:${update.runId}`,
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
