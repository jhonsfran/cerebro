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
import { id } from "@cerebro/contracts/identity";
import type { ReadOptions } from "@cerebro/contracts/port";
import type { AgentDefinition, RunState } from "@cerebro/contracts/session";
import type {
  DomainSnapshot,
  DomainUpdate,
  ExecutionState,
} from "@cerebro/contracts/session-service";
import { LiveDoc } from "@earendil-works/pi-durable";
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
import { createProvisionalTextProjection } from "./pi-provisional-text.ts";
import {
  attempt,
  contractFailure,
  vendorEffect,
  waitForCaller,
} from "./runtime-ports.ts";

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
  readonly snapshot: () => DomainSnapshot;
  readonly storage: () => Pick<Storage, "submissionByRequest">;
  readonly handoffs: () => Effect.Effect<
    readonly DurableHandoff[],
    ContractFailure
  >;
  readonly prepareInput?: (
    handoff: DurableHandoff
  ) => Effect.Effect<string, ContractFailure>;
  readonly content: (
    handoff: DurableHandoff
  ) => Effect.Effect<
    Pick<DomainSnapshot["outputs"][number], "dependencies" | "citations">,
    ContractFailure
  >;
}

interface NativeInput {
  readonly handoff: DurableHandoff;
  readonly record: SubmissionRecord;
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
  const answerId = (answer: number) =>
    id.answer(
      JSON.stringify([
        configuration.address.organizationId,
        configuration.address.sessionId,
        answer,
      ])
    );
  const executions = new Map(
    configuration
      .snapshot()
      .executions.map((value) => [value.executionId, value])
  );
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
      const results: NativeInput[] = [];
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
  const resolve = (runId: RunState["runId"]) =>
    Effect.gen(function* resolveRun() {
      const handoffs = yield* configuration.handoffs();
      const handoff = handoffs.find((item) => item.submission.runId === runId);
      return (
        handoff ?? (yield* Effect.fail(new NotFound({ resource: "Pi run" })))
      );
    });
  const remember = (members: readonly NativeInput[]) => {
    const [primary, ...rest] = members;
    if (!primary) {
      return;
    }
    const runIds: ExecutionState["runIds"] = [
      primary.handoff.submission.runId,
      ...rest.map((value) => value.handoff.submission.runId),
    ];
    const executionId = id.execution(`execution:${runIds[0]}`);
    const previous = executions.get(executionId);
    if (
      previous &&
      previous.runIds.length > runIds.length &&
      runIds.every((member, index) => member === previous.runIds[index])
    ) {
      return previous;
    }
    const execution = { executionId, runIds };
    executions.set(executionId, execution);
    return execution;
  };
  const captureMembership = (options: ReadOptions) =>
    Effect.gen(function* readExecutions() {
      const inputs = yield* vendorEffect(options, async (signal) => {
        const context = piContext(signal);
        const pi = await configuration.harness.pi();
        const root = await pi.root(context);
        const snapshot = await pi.snapshot(LiveDoc, root.id, context);
        return snapshot?.run?.inputs ?? [];
      });
      const values = yield* records(options);
      for (const execution of configuration.snapshot().executions) {
        const remembered = executions.get(execution.executionId);
        if (
          !remembered ||
          remembered.runIds.length <= execution.runIds.length
        ) {
          executions.set(execution.executionId, execution);
        }
      }
      const active = inputs.flatMap((input) =>
        values.filter((value) => value.record.id === input)
      );
      if (active.length !== inputs.length) {
        return yield* Effect.fail(
          new Unavailable({
            reason:
              "Native execution contains an input without a Cerebro admission",
          })
        );
      }
      remember(active);
      const answers = new Set(
        values.flatMap(({ record }) =>
          record.type === "input" && record.status === "done"
            ? [record.answer]
            : []
        )
      );
      for (const answer of answers) {
        const members = values
          .filter(
            ({ record }) =>
              record.type === "input" &&
              record.status === "done" &&
              record.answer === answer
          )
          .toSorted(
            (left, right) =>
              (left.record.entry ?? 0) - (right.record.entry ?? 0)
          );
        remember(members);
      }
      return values;
    });
  const executionBlocked = (
    execution: ExecutionState,
    members: readonly NativeInput[]
  ) =>
    members.some(({ handoff }) => handoff.run.state === "unknown-outcome") ||
    configuration
      .snapshot()
      .tools.some(
        (tool) =>
          execution.runIds.includes(tool.runId) &&
          tool.state !== "succeeded" &&
          tool.state !== "failed" &&
          tool.state !== "cancelled"
      );
  const inspect = (options: ReadOptions) =>
    Effect.map(captureMembership(options), (values) => {
      const blocked = new Set(
        [...executions.values()]
          .filter((execution) =>
            executionBlocked(
              execution,
              values.filter(({ handoff }) =>
                execution.runIds.includes(handoff.submission.runId)
              )
            )
          )
          .flatMap((execution) => execution.runIds)
      );
      return values.map(({ record, handoff }) =>
        record.status === "done" && blocked.has(handoff.submission.runId)
          ? handoff.run
          : runState(record, handoff)
      );
    });
  const projectedAlready = (
    execution: ExecutionState,
    members: readonly NativeInput[]
  ) => {
    if (!members.every(({ handoff }) => handoff.run.state === "completed")) {
      return false;
    }
    const frozen = configuration
      .snapshot()
      .outputs.find((output) => output.executionId === execution.executionId);
    const [primary] = members;
    if (
      !frozen ||
      !primary ||
      primary.record.type !== "input" ||
      primary.record.status !== "done" ||
      frozen.answerId !== answerId(primary.record.answer) ||
      JSON.stringify(frozen.runIds) !== JSON.stringify(execution.runIds)
    ) {
      throw new Conflict({
        code: "already-final",
        reason: "Native final answer identity or membership changed",
      });
    }
    return true;
  };
  const updates = (options: ReadOptions) =>
    Effect.gen(function* canonicalProjection() {
      const values = yield* captureMembership(options);
      const projected: DomainUpdate[] = [];
      const grouped = new Set<string>();
      for (const execution of executions.values()) {
        const members = execution.runIds.flatMap((runId) =>
          values.filter((value) => value.handoff.submission.runId === runId)
        );
        if (!members.length) {
          continue;
        }
        if (members.length !== execution.runIds.length) {
          return yield* Effect.fail(
            new Unavailable({
              reason: "Native execution membership is incomplete",
            })
          );
        }
        for (const member of members) {
          grouped.add(member.handoff.submission.runId);
        }
        if (yield* attempt(() => projectedAlready(execution, members))) {
          continue;
        }
        projected.push({ execution, type: "execution" });
        const done = members.every(
          ({ record }) => record.type === "input" && record.status === "done"
        );
        const blocked = executionBlocked(execution, members);
        if (done && !blocked) {
          const [primary] = members;
          if (
            primary &&
            primary.record.type === "input" &&
            primary.record.status === "done"
          ) {
            const result = yield* vendorEffect(options, (signal) =>
              session.wait(primary.handoff.submission.requestId, signal)
            );
            const contents = [];
            for (const { handoff } of members) {
              contents.push(yield* configuration.content(handoff));
            }
            projected.push({
              output: {
                answerId: answerId(primary.record.answer),
                citations: [
                  ...new Map(
                    contents
                      .flatMap((content) => content.citations)
                      .map((citation) => [JSON.stringify(citation), citation])
                  ).values(),
                ],
                dependencies: {
                  sourceIds: [
                    ...new Set(
                      contents.flatMap(
                        (content) => content.dependencies.sourceIds
                      )
                    ),
                  ],
                  toolIds: [
                    ...new Set(
                      contents.flatMap(
                        (content) => content.dependencies.toolIds
                      )
                    ),
                  ],
                },
                executionId: execution.executionId,
                runId: execution.runIds[0],
                runIds: execution.runIds,
                text: result.text ?? "",
              },
              type: "canonical-output",
            });
          }
        }
        for (const { handoff, record } of members) {
          if (
            blocked &&
            record.status === "done" &&
            handoff.run.state !== "unknown-outcome"
          ) {
            projected.push({ run: handoff.run, type: "run" });
            continue;
          }
          projected.push({ run: runState(record, handoff), type: "run" });
        }
      }
      for (const { handoff, record } of values) {
        if (!grouped.has(handoff.submission.runId)) {
          projected.push({ run: runState(record, handoff), type: "run" });
        }
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
        yield* captureMembership(options);
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
          const provisionalText = createProvisionalTextProjection();
          const sendCanonical = async () => {
            const values = await Effect.runPromise(updates(options));
            Queue.offerAllUnsafe(queue, values);
          };
          const sendMembership = async () => {
            const current = await Effect.runPromise(records(options));
            const members = activeInputs.flatMap((input) =>
              current.filter((value) => value.record.id === input)
            );
            if (members.length !== activeInputs.length) {
              return;
            }
            const execution = remember(members);
            if (execution) {
              Queue.offerUnsafe(queue, { execution, type: "execution" });
            }
            return execution;
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
              const placed =
                event.type === "submission" && event.record.status === "placed";
              if (placed && !activeInputs.includes(event.record.id)) {
                activeInputs = [...activeInputs, event.record.id];
              }
              if (
                placed ||
                event.type === "run_start" ||
                event.type === "snapshot"
              ) {
                await sendMembership();
              }
              const text = provisionalText(event);
              if (text) {
                // A fast first text batch can precede the authoritative snapshot read.
                const execution = await sendMembership();
                if (execution) {
                  Queue.offerUnsafe(queue, {
                    executionId: execution.executionId,
                    runId: execution.runIds[0],
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
            await sendBatch([stream.snapshot]);
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
        yield* captureMembership(options);
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
        const originalText =
          event.type === "user.message"
            ? event.payload.text
            : event.payload.task;
        const text = configuration.prepareInput
          ? yield* waitForCaller(configuration.prepareInput(prior), options)
          : originalText;
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
