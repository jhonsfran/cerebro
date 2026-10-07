import { Conflict, InvalidInput } from "@cerebro/contracts/failures";
import type { RunState } from "@cerebro/contracts/session";
import { DomainUpdate } from "@cerebro/contracts/session-service";
import type { DomainSnapshot } from "@cerebro/contracts/session-service";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { Schema } from "effect";

export const updateRunId = (update: DomainUpdate) => {
  switch (update.type) {
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

export const projectUpdate = (
  snapshot: DomainSnapshot,
  update: DomainUpdate
): DomainSnapshot => {
  Schema.decodeUnknownSync(DomainUpdate)(update);
  switch (update.type) {
    case "run": {
      const previous = snapshot.runs.find(
        (run) => run.runId === update.run.runId
      );
      if (
        previous &&
        !pendingRun(previous) &&
        canonicalToolArguments(previous) !== canonicalToolArguments(update.run)
      ) {
        throw new Conflict({
          code: "already-final",
          reason: "Run is terminal",
        });
      }
      if (update.run.state === "completed") {
        const hasOutput = snapshot.outputs.some(
          (output) => output.runId === update.run.runId
        );
        const unresolved = snapshot.tools.some(
          (tool) =>
            tool.runId === update.run.runId &&
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
      const { type: _type, ...tool } = update;
      return {
        ...snapshot,
        tools: upsert(snapshot.tools, tool, (item) => item.operationId),
      };
    }
    case "canonical-output": {
      const prior = snapshot.outputs.find(
        (output) => output.runId === update.output.runId
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
          (output) => output.runId
        ),
      };
    }
    case "citation":
    case "provisional-text": {
      return snapshot;
    }
    default: {
      throw new InvalidInput({ reason: "Invalid domain projection" });
    }
  }
};
