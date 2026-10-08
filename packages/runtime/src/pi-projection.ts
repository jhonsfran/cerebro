import { Conflict, InvalidInput } from "@cerebro/contracts/failures";
import type { RunState } from "@cerebro/contracts/session";
import {
  DomainSnapshot,
  DomainUpdate,
} from "@cerebro/contracts/session-service";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { Schema } from "effect";

export const updateRunId = (update: DomainUpdate) => {
  switch (update.type) {
    case "execution": {
      return update.execution.runIds[0];
    }
    case "run": {
      return update.run.runId;
    }
    case "user-message": {
      return update.message.runId;
    }
    case "canonical-output": {
      return update.output.runId;
    }
    default: {
      return update.runId;
    }
  }
};

export const pendingRun = (run: RunState): boolean =>
  run.state === "queued" ||
  run.state === "running" ||
  run.state === "waiting-for-approval";

export const updateRunIds = (update: DomainUpdate) => {
  if (update.type === "execution") {
    return update.execution.runIds;
  }
  if (update.type === "canonical-output") {
    return update.output.runIds;
  }
  return [updateRunId(update)];
};

const upsert = <A>(
  values: readonly A[],
  value: A,
  key: (item: A) => string
): readonly A[] => {
  const index = values.findIndex((item) => key(item) === key(value));
  return index === -1
    ? [...values, value]
    : values.map((item, position) => (position === index ? value : item));
};

const projectRun = (
  snapshot: DomainSnapshot,
  update: Extract<DomainUpdate, { type: "run" }>
): DomainSnapshot => {
  const previous = snapshot.runs.find((run) => run.runId === update.run.runId);
  const reconciled =
    previous?.state === "unknown-outcome" &&
    update.run.state === "running" &&
    !snapshot.tools.some(
      (tool) =>
        tool.runId === previous.runId && tool.state === "unknown-outcome"
    ) &&
    snapshot.tools.some(
      (tool) =>
        tool.runId === previous.runId &&
        tool.operationId === previous.operationId &&
        (tool.state === "succeeded" || tool.state === "failed")
    );
  if (
    previous &&
    !pendingRun(previous) &&
    !reconciled &&
    canonicalToolArguments(previous) !== canonicalToolArguments(update.run)
  ) {
    throw new Conflict({
      code: "already-final",
      reason: "Run is terminal",
    });
  }
  if (update.run.state === "completed") {
    const hasOutput = snapshot.outputs.some((output) =>
      output.runIds.includes(update.run.runId)
    );
    const execution = snapshot.executions.find((value) =>
      value.runIds.includes(update.run.runId)
    );
    const unresolved =
      snapshot.runs.some(
        (run) =>
          execution?.runIds.includes(run.runId) &&
          run.state === "unknown-outcome"
      ) ||
      snapshot.tools.some(
        (tool) =>
          execution?.runIds.includes(tool.runId) &&
          tool.state !== "succeeded" &&
          tool.state !== "failed" &&
          tool.state !== "cancelled"
      );
    if (!hasOutput || unresolved) {
      throw new Conflict({
        code: "version-mismatch",
        reason: "Canonical output and confirmed tools must precede success",
      });
    }
  }
  return {
    ...snapshot,
    runs: upsert(snapshot.runs, update.run, (run) => run.runId),
  };
};

const projectTool = (
  snapshot: DomainSnapshot,
  update: Extract<DomainUpdate, { type: "tool" }>
): DomainSnapshot => {
  const { type: _type, ...tool } = update;
  const prior = snapshot.tools.find(
    (value) => value.operationId === tool.operationId
  );
  if (
    prior &&
    (prior.runId !== tool.runId ||
      prior.toolId !== tool.toolId ||
      prior.toolVersion !== tool.toolVersion ||
      prior.effect !== tool.effect ||
      canonicalToolArguments(prior.arguments) !==
        canonicalToolArguments(tool.arguments))
  ) {
    throw new Conflict({
      code: "digest-mismatch",
      reason: "Tool ownership and invocation are immutable",
    });
  }
  if (
    prior &&
    ["succeeded", "failed", "cancelled"].includes(prior.state) &&
    canonicalToolArguments(prior) !== canonicalToolArguments(tool)
  ) {
    throw new Conflict({
      code: "already-final",
      reason: "Confirmed tool outcome is immutable",
    });
  }
  return {
    ...snapshot,
    tools: upsert(snapshot.tools, tool, (item) => item.operationId),
  };
};

const project = (
  snapshot: DomainSnapshot,
  update: DomainUpdate
): DomainSnapshot => {
  Schema.decodeUnknownSync(DomainUpdate)(update);
  switch (update.type) {
    case "execution": {
      const previous = snapshot.executions.find(
        (value) => value.executionId === update.execution.executionId
      );
      const final =
        snapshot.outputs.some(
          (value) => value.executionId === update.execution.executionId
        ) ||
        snapshot.runs.some(
          (run) => previous?.runIds.includes(run.runId) && !pendingRun(run)
        );
      if (
        previous &&
        (!previous.runIds.every(
          (member, index) => member === update.execution.runIds[index]
        ) ||
          (final &&
            canonicalToolArguments(previous) !==
              canonicalToolArguments(update.execution)))
      ) {
        throw new Conflict({
          code: "already-final",
          reason:
            "Execution membership is immutable after completion and otherwise append-only",
        });
      }
      return {
        ...snapshot,
        executions: upsert(
          snapshot.executions,
          update.execution,
          (value) => value.executionId
        ),
      };
    }
    case "run": {
      return projectRun(snapshot, update);
    }
    case "user-message": {
      return {
        ...snapshot,
        userMessages: upsert(
          snapshot.userMessages,
          update.message,
          (message) => message.eventId
        ),
      };
    }
    case "approval": {
      const { type: _type, ...approval } = update;
      return {
        ...snapshot,
        approvals: upsert(
          snapshot.approvals,
          approval,
          (item) => item.approvalId
        ),
      };
    }
    case "tool": {
      return projectTool(snapshot, update);
    }
    case "canonical-output": {
      const prior = snapshot.outputs.find(
        (output) =>
          output.answerId === update.output.answerId ||
          output.executionId === update.output.executionId
      );
      if (
        prior &&
        canonicalToolArguments(prior) !== canonicalToolArguments(update.output)
      ) {
        throw new Conflict({
          code: "already-final",
          reason: "Output is immutable",
        });
      }
      return {
        ...snapshot,
        outputs: upsert(
          snapshot.outputs,
          update.output,
          (output) => output.answerId
        ),
      };
    }
    case "citation":
    case "provisional-text": {
      const execution = snapshot.executions.find(
        (value) => value.executionId === update.executionId
      );
      if (!execution || execution.runIds[0] !== update.runId) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "Progress belongs to another execution or primary run",
        });
      }
      return snapshot;
    }
    default: {
      throw new InvalidInput({ reason: "Invalid domain projection" });
    }
  }
};

export const projectUpdate = (
  snapshot: DomainSnapshot,
  update: DomainUpdate
): DomainSnapshot => {
  const projected = project(snapshot, update);
  try {
    return Schema.decodeUnknownSync(DomainSnapshot)(projected);
  } catch {
    throw new Conflict({
      code: "already-final",
      reason:
        "Projection identity or membership conflicts with the canonical snapshot",
    });
  }
};
