import { EventType } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { Unavailable } from "@cerebro/contracts/failures";
import type { ExecutionId } from "@cerebro/contracts/identity";
import {
  DomainSnapshot as DomainSnapshotSchema,
  Observation,
} from "@cerebro/contracts/session-service";
import type {
  DomainSnapshot,
  DomainUpdate,
  ExecutionState,
} from "@cerebro/contracts/session-service";
import { uiMessagesToWire } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { Effect, Schema, Stream } from "effect";
import type { Scope } from "effect";

import { projectObservation, projectionMessages } from "./projection.ts";
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
    if (
      frame.update.type === "provisional-text" ||
      frame.update.type === "provisional-thinking"
    ) {
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
  const thinkingStarted = new Set<ExecutionId>();
  const toolsStarted = new Set<string>();
  const startedExecutions = new Set<ExecutionId>();
  const settledExecutions = new Set<ExecutionId>();
  const snapshotEvents = (): StreamChunk[] => {
    const events: StreamChunk[] = [
      {
        messages: uiMessagesToWire(
          projectionMessages(
            projection
              ? {
                  ...projection,
                  provisional: {},
                  thinking: {},
                }
              : null
          )
        ),
        type: EventType.MESSAGES_SNAPSHOT,
      },
    ];
    for (const execution of projection?.snapshot.executions ?? []) {
      const text = projection?.provisional[execution.executionId];
      const thinking = projection?.thinking[execution.executionId];
      if (text === undefined && !thinking) {
        continue;
      }
      const messageId = `assistant:${execution.executionId}`;
      textStarted.add(execution.executionId);
      events.push({
        messageId,
        role: "assistant",
        type: EventType.TEXT_MESSAGE_START,
      });
      if (thinking) {
        thinkingStarted.add(execution.executionId);
        events.push(
          {
            messageId,
            role: "reasoning",
            type: EventType.REASONING_MESSAGE_START,
          },
          {
            delta: thinking,
            messageId,
            type: EventType.REASONING_MESSAGE_CONTENT,
          }
        );
      }
      if (text) {
        events.push({
          delta: text,
          messageId,
          type: EventType.TEXT_MESSAGE_CONTENT,
        });
      }
    }
    return events;
  };
  const resetSnapshot = (snapshot: DomainSnapshot) => {
    textStarted.clear();
    thinkingStarted.clear();
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
  const provisionalEvents = (
    update: Extract<
      DomainUpdate,
      { type: "provisional-text" | "provisional-thinking" }
    >
  ): StreamChunk[] => {
    const events: StreamChunk[] = [];
    if (
      projection?.snapshot.outputs.some(
        (output) => output.executionId === update.executionId
      )
    ) {
      return [];
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
    if (update.type === "provisional-thinking") {
      if (!thinkingStarted.has(update.executionId)) {
        thinkingStarted.add(update.executionId);
        events.push({
          messageId,
          role: "reasoning",
          type: EventType.REASONING_MESSAGE_START,
        });
      }
      events.push({
        delta: update.text,
        messageId,
        type: EventType.REASONING_MESSAGE_CONTENT,
      });
    } else {
      events.push({
        delta: update.text,
        messageId,
        type: EventType.TEXT_MESSAGE_CONTENT,
      });
    }
    return events;
  };
  return (frame: Observation): StreamChunk[] => {
    projection = projectObservation(projection, frame);
    const events: StreamChunk[] = [observationEvent(frame)];
    if (frame.type === "snapshot") {
      resetSnapshot(frame.snapshot);
      events.push(...snapshotEvents());
      return events;
    }
    if (frame.type !== "update") {
      return events;
    }
    const { update } = frame;
    if (
      update.type === "provisional-text" ||
      update.type === "provisional-thinking"
    ) {
      events.push(...provisionalEvents(update));
    } else if (update.type === "canonical-output") {
      if (thinkingStarted.delete(update.output.executionId)) {
        events.push({
          messageId: `assistant:${update.output.executionId}`,
          type: EventType.REASONING_MESSAGE_END,
        });
      }
      if (textStarted.delete(update.output.executionId)) {
        events.push({
          messageId: `assistant:${update.output.executionId}`,
          type: EventType.TEXT_MESSAGE_END,
        });
      }
      events.push(...snapshotEvents());
    } else if (update.type === "run" || update.type === "execution") {
      if (update.type === "execution") {
        events.push(...snapshotEvents());
      }
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
    } else if (update.type === "user-message") {
      events.push(...snapshotEvents());
    }
    return events;
  };
};

export const CHAT_CONTENT_TYPE = "application/x-ag-ui+ndjson";
export const CHAT_BATCH_CONTENT_TYPE = "application/x-cerebro-ag-ui+ndjson";
export const MAX_DOMAIN_FRAME_BYTES = 1_048_576;
// Mapping can quote tool JSON again and include both domain and UI history.
export const MAX_CHAT_FRAME_BYTES = 4 * MAX_DOMAIN_FRAME_BYTES;
export const MAX_CHAT_BATCH_BYTES = 8 * MAX_DOMAIN_FRAME_BYTES;
export const decodeStreamChunk = (input: unknown): StreamChunk =>
  EventSchemas.parse(input);

const frameEncoder = new TextEncoder();
const encodeFrame = (value: unknown, limit: number): Uint8Array => {
  const bytes = frameEncoder.encode(`${JSON.stringify(value)}\n`);
  if (bytes.byteLength - 1 > limit) {
    throw new Error("Chat observation frame exceeds the transport limit.");
  }
  return bytes;
};

const observationIdentitySchema = Schema.Struct({
  accessGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  address: DomainSnapshotSchema.fields.address,
  epoch: Schema.NonEmptyString,
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ObservationIdentity = typeof observationIdentitySchema.Type;
export const observationIdentity = (
  frame: Observation
): ObservationIdentity => ({
  accessGeneration: frame.accessGeneration,
  address: frame.address,
  epoch: frame.epoch,
  sequence: frame.sequence,
});
export const sameObservation = (
  left: ObservationIdentity,
  right: ObservationIdentity
): boolean =>
  sameAddress(left.address, right.address) &&
  left.accessGeneration === right.accessGeneration &&
  left.epoch === right.epoch &&
  left.sequence === right.sequence;

const protocolBatchSchema = Schema.Struct({
  events: Schema.Array(Schema.Unknown),
});
export interface ProtocolBatch {
  readonly events: readonly StreamChunk[];
  readonly observation: Observation;
}
export const chunkObservation = (chunk: StreamChunk): ObservationIdentity =>
  Schema.decodeUnknownSync(observationIdentitySchema)(chunk.metadata?.cerebro);

export const decodeProtocolBatch = (input: unknown): ProtocolBatch => {
  const batch = Schema.decodeUnknownSync(protocolBatchSchema)(input);
  const events = batch.events.map(decodeStreamChunk);
  const [first] = events;
  if (first?.type !== EventType.CUSTOM) {
    throw new Error("Protocol delivery must start with its observation.");
  }
  const observation = decodeCustomObservation(first);
  encodeFrame(observation, MAX_DOMAIN_FRAME_BYTES);
  for (const event of events) {
    encodeFrame(event, MAX_CHAT_FRAME_BYTES);
  }
  if (
    !events.every((event) =>
      sameObservation(chunkObservation(event), observation)
    )
  ) {
    throw new Error("Protocol chunks do not match their delivery identity.");
  }
  return { events, observation };
};

const encodeNDJSON = <Value>(
  source: Stream.Stream<Value, ContractFailure, Scope.Scope>,
  contentType: string,
  limit: number
): Response =>
  new Response(
    Stream.toReadableStream(
      Stream.scoped(source).pipe(
        Stream.mapEffect((frame) =>
          Effect.try({
            catch: () =>
              new Unavailable({
                reason: "Chat observation frame is too large.",
              }),
            try: () => encodeFrame(frame, limit),
          })
        )
      )
    ),
    { headers: { "Cache-Control": "no-store", "Content-Type": contentType } }
  );

export const protocolBatches = (
  source: Stream.Stream<Observation, ContractFailure, Scope.Scope>
): Stream.Stream<ProtocolBatch, ContractFailure, Scope.Scope> =>
  Stream.suspend(() => {
    const project = createProtocolProjection();
    return source.pipe(
      Stream.mapEffect((observation) =>
        Effect.try({
          catch: () =>
            new Unavailable({ reason: "Chat observation frame is too large." }),
          try: () => {
            encodeFrame(observation, MAX_DOMAIN_FRAME_BYTES);
            const events = project(observation).map((event) => ({
              ...event,
              metadata: {
                ...event.metadata,
                cerebro: observationIdentity(observation),
              },
            }));
            for (const event of events) {
              encodeFrame(event, MAX_CHAT_FRAME_BYTES);
            }
            return { events, observation };
          },
        })
      )
    );
  });

export const protocolBatchResponse = (
  source: Stream.Stream<Observation, ContractFailure, Scope.Scope>
): Response =>
  encodeNDJSON(
    protocolBatches(source).pipe(
      Stream.map((batch) => ({ events: batch.events }))
    ),
    CHAT_BATCH_CONTENT_TYPE,
    MAX_CHAT_BATCH_BYTES
  );

export const protocolResponse = (
  source: Stream.Stream<ProtocolBatch, ContractFailure, Scope.Scope>
): Response =>
  encodeNDJSON(
    source.pipe(Stream.flatMap((batch) => Stream.fromIterable(batch.events))),
    CHAT_CONTENT_TYPE,
    MAX_CHAT_FRAME_BYTES
  );

export const readProtocolBatches = (
  body: ReadableStream<Uint8Array>
): Stream.Stream<ProtocolBatch, ContractFailure> => {
  let frameBytes = 0;
  return Stream.fromReadableStream({
    evaluate: () => body,
    onError: () =>
      new Unavailable({ reason: "Chat observation was interrupted." }),
  }).pipe(
    Stream.mapEffect((chunk) =>
      Effect.try({
        catch: () =>
          new Unavailable({ reason: "Chat observation frame is too large." }),
        try: () => {
          for (const byte of chunk) {
            frameBytes = byte === 0x0a ? 0 : frameBytes + 1;
            if (frameBytes > MAX_CHAT_BATCH_BYTES) {
              throw new Error("Frame limit exceeded.");
            }
          }
          return chunk;
        },
      })
    ),
    Stream.concat(
      Stream.suspend(() =>
        frameBytes === 0
          ? Stream.empty
          : Stream.fail(
              new Unavailable({
                reason: "Chat observation frame is incomplete.",
              })
            )
      )
    ),
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect((line) =>
      Effect.try({
        catch: () =>
          new Unavailable({ reason: "Chat observation frame is invalid." }),
        try: () => decodeProtocolBatch(JSON.parse(line)),
      })
    )
  );
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
