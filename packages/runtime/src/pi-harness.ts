/* oxlint-disable no-await-in-loop -- Native operations and event batches are translated in commit order. */
import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import { ExecutionEngine } from "@cerebro/contracts/execution";
import type {
  DurableHandoff,
  EngineConversation,
} from "@cerebro/contracts/execution";
import {
  Conflict,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ReadOptions } from "@cerebro/contracts/port";
import type { AgentDefinition, RunState } from "@cerebro/contracts/session";
import type {
  DomainSnapshot,
  DomainUpdate,
} from "@cerebro/contracts/session-service";
import type {
  AgentEvent,
  Harness,
  Storage,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import { Cause, Effect, Layer, Queue, Stream } from "effect";

import { sameAddress } from "./event-handler.ts";
import { pendingRun } from "./pi-projection.ts";
import { attempt, contractFailure, vendorEffect } from "./runtime-ports.ts";

export type PiContext = Parameters<Harness["root"]>[0];
export const piContext = (signal?: AbortSignal): PiContext =>
  Object.freeze({
    abortSignal: signal,
    toString: () => "[Context Cerebro Pi adapter]",
    // oxlint-disable-next-line no-useless-undefined -- A missing Chord context key has an undefined value.
    value: () => undefined,
  });
export interface PiEngineConfiguration {
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly harness: Pick<PiHarness, "session" | "pi" | "pending">;
  readonly storage: () => Pick<Storage, "submissionByRequest">;
  readonly handoffs: () => Effect.Effect<
    readonly DurableHandoff[],
    ContractFailure
  >;
  readonly content: (
    handoff: DurableHandoff
  ) => Effect.Effect<
    Pick<DomainSnapshot["outputs"][number], "dependencies" | "citations">,
    ContractFailure
  >;
}

const stateOf = (
  record: SubmissionRecord,
  handoff: DurableHandoff,
  endedAt: number
): RunState => {
  if (handoff.run.state === "unknown-outcome") {
    return handoff.run;
  }
  const { runId } = handoff.submission;
  switch (record.status) {
    case "queued": {
      return { runId, state: "queued" };
    }
    case "placed": {
      return {
        runId,
        state:
          handoff.run.state === "waiting-for-approval"
            ? "waiting-for-approval"
            : "running",
      };
    }
    case "done": {
      return handoff.run.state === "completed"
        ? handoff.run
        : { completedAt: endedAt, runId, state: "completed" };
    }
    case "unanswered": {
      return pendingRun(handoff.run)
        ? {
            endedAt,
            runId,
            state: /abort|withdraw|cancel/iu.test(record.reason)
              ? "cancelled"
              : "failed",
          }
        : handoff.run;
    }
    default: {
      throw new InvalidInput({ reason: "Unsupported Pi submission state" });
    }
  }
};

export const createPiExecutionEngine = (
  configuration: PiEngineConfiguration
) => {
  const session = configuration.harness.session();
  const terminalTimes = new Map<number, number>();
  const runState = (record: SubmissionRecord, handoff: DurableHandoff) => {
    if (record.status === "done" || record.status === "unanswered") {
      terminalTimes.set(record.id, terminalTimes.get(record.id) ?? Date.now());
    }
    return stateOf(record, handoff, terminalTimes.get(record.id) ?? Date.now());
  };
  const records = (options: ReadOptions) =>
    vendorEffect(options, async (signal) => {
      const context = piContext(signal);
      const pi = await configuration.harness.pi();
      const root = await pi.root(context);
      const handoffs = await Effect.runPromise(configuration.handoffs(), {
        signal,
      });
      const results: { handoff: DurableHandoff; record: SubmissionRecord }[] =
        [];
      for (const handoff of handoffs) {
        const record = await configuration
          .storage()
          .submissionByRequest(root.id, handoff.submission.requestId, context);
        if (record) {
          results.push({ handoff, record });
        }
      }
      return results;
    });
  const inspect = (options: ReadOptions) =>
    Effect.map(records(options), (values) =>
      values.map(({ record, handoff }) => runState(record, handoff))
    );
  const resolve = (runId: RunState["runId"]) =>
    Effect.gen(function* resolveRun() {
      const handoffs = yield* configuration.handoffs();
      const handoff = handoffs.find((item) => item.submission.runId === runId);
      return (
        handoff ?? (yield* Effect.fail(new NotFound({ resource: "Pi run" })))
      );
    });
  const updates = (options: ReadOptions) =>
    Effect.gen(function* canonicalProjection() {
      const values = yield* records(options);
      const projected: DomainUpdate[] = [];
      const answers = new Set<number>();
      for (const { handoff, record } of values) {
        if (handoff.run.state === "completed") {
          continue;
        }
        if (
          record.status === "done" &&
          record.type === "input" &&
          handoff.run.state !== "unknown-outcome"
        ) {
          if (answers.has(record.answer)) {
            return yield* Effect.fail(
              new Unavailable({
                reason:
                  "Shared Pi answer identity requires the coordinator's joined-run contract",
              })
            );
          }
          answers.add(record.answer);
          const result = yield* vendorEffect(options, (signal) =>
            session.wait(handoff.submission.requestId, signal)
          );
          const content = yield* configuration.content(handoff);
          projected.push({
            output: {
              runId: handoff.submission.runId,
              text: result.text ?? "",
              ...content,
            },
            type: "canonical-output",
          });
        }
        projected.push({ run: runState(record, handoff), type: "run" });
      }
      return projected;
    });
  const conversation: EngineConversation = {
    approve: (approval, options) =>
      Effect.gen(function* continueApproval() {
        const handoff = yield* resolve(approval.runId);
        if (
          !handoff.approvals.some(
            (item) =>
              item.id === approval.id &&
              item.operationId === approval.operationId
          )
        ) {
          return yield* Effect.fail(
            new NotFound({ resource: "Pi bound approval" })
          );
        }
        const state = (yield* inspect(options)).find(
          (run) => run.runId === approval.runId
        );
        return state ?? handoff.run;
      }),
    cancel: (runId, options) =>
      Effect.gen(function* withdrawNative() {
        const handoff = yield* resolve(runId);
        yield* vendorEffect(options, () =>
          session.abort(handoff.submission.requestId)
        );
        const states = yield* inspect(options);
        const state = states.find((run) => run.runId === runId);
        return state ?? handoff.run;
      }),
    inspect,
    observe: (options) =>
      Stream.callback<DomainUpdate, ContractFailure>((queue) =>
        Effect.gen(function* observeNative() {
          const stream = yield* Effect.acquireRelease(
            vendorEffect(options, (signal) =>
              session.events(piContext(signal))
            ),
            (value) =>
              Effect.promise(async () => {
                await value.stop();
              })
          );
          let activeInputs = stream.snapshot.run?.inputs ?? [];
          const sendCanonical = async () => {
            const values = await Effect.runPromise(updates(options));
            Queue.offerAllUnsafe(queue, values);
          };
          const sendBatch = async (events: readonly AgentEvent[]) => {
            for (const event of events) {
              if (event.type === "snapshot") {
                activeInputs = event.run?.inputs ?? [];
              }
              if (event.type === "run_start") {
                activeInputs = event.inputs;
              }
              if (event.type === "run_end") {
                activeInputs = [];
              }
              if (event.type === "message_update") {
                const text = event.changes
                  .filter((change) => change.type === "text_delta")
                  .map((change) => ("delta" in change ? change.delta : ""))
                  .join("");
                const current = await Effect.runPromise(records(options));
                const inputs = activeInputs;
                const running = current.find((value) =>
                  inputs.includes(value.record.id)
                );
                if (text && running) {
                  Queue.offerUnsafe(queue, {
                    runId: running.handoff.submission.runId,
                    text,
                    type: "provisional-text",
                  });
                }
              }
            }
            await sendCanonical();
          };
          yield* vendorEffect(options, async () => {
            // Pi's attachment atomically captures its snapshot and future event batches.
            await sendCanonical();
            stream.start(async (events) => {
              try {
                await sendBatch(events);
              } catch (error) {
                Queue.failCauseUnsafe(
                  queue,
                  Cause.fail(contractFailure(error))
                );
              }
            });
          });
          yield* Effect.forkScoped(
            Effect.promise(async () => {
              await stream.closed;
              Queue.endUnsafe(queue);
            })
          );
        })
      ),
    release: Effect.void,
    stop: (options) =>
      Effect.gen(function* stopNative() {
        yield* vendorEffect(options, () => session.abort());
        return yield* inspect(options);
      }),
    submit: (submission, options) =>
      Effect.gen(function* submitNative() {
        const prior = yield* resolve(submission.runId);
        if (
          prior.submission.inputDigest !== submission.inputDigest ||
          prior.submission.requestId !== submission.requestId
        ) {
          return yield* Effect.fail(
            new Conflict({
              code: "digest-mismatch",
              reason: "Pi command does not match admission",
            })
          );
        }
        const { event } = submission.event;
        if (event.type !== "user.message" && event.type !== "scheduled.run") {
          return yield* Effect.fail(
            new InvalidInput({ reason: "Event cannot submit Pi input" })
          );
        }
        const text =
          event.type === "user.message"
            ? event.payload.text
            : event.payload.task;
        const receipt = yield* vendorEffect(options, () =>
          submission.mode === "steer"
            ? session.steer(text, { operationId: submission.requestId })
            : session.submit(text, { operationId: submission.requestId })
        );
        return { replayed: !receipt.accepted, runId: submission.runId };
      }),
  };
  const service: ExecutionEngine = {
    open: (address, agent, options) =>
      Effect.acquireRelease(
        attempt(() => {
          if (
            !sameAddress(address, configuration.address) ||
            agent.version !== configuration.agent.version ||
            agent.model !== configuration.agent.model
          ) {
            throw new Conflict({
              code: "version-mismatch",
              reason: "Pi conversation configuration changed",
            });
          }
          if (options.signal?.aborted || options.deadlineAt <= Date.now()) {
            throw new Unavailable({ reason: "Pi open interrupted" });
          }
          return conversation;
        }),
        (value) => value.release
      ),
  };
  return { layer: Layer.succeed(ExecutionEngine, service), records, service };
};

export const modelAuthority = (
  authority: AuthorityService,
  address: EventAddress,
  agent: AgentDefinition,
  handoffs: readonly DurableHandoff[],
  options: ReadOptions
) =>
  Effect.gen(function* authorizeModel() {
    if (!handoffs.length) {
      return yield* Effect.fail(
        new NotFound({ resource: "Active Pi input authority" })
      );
    }
    for (const handoff of handoffs) {
      yield* authority.require(
        {
          action: "execute",
          address,
          context: handoff.submission.event.context,
          model: agent.model,
          pinnedAgent: agent,
          resource: {
            id: address.agentId,
            kind: "agent",
            organizationId: address.organizationId,
          },
        },
        options
      );
    }
  });
