import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import type {
  DurableHandoff,
  EngineConversation,
  ExecutionEngine,
  HandoffTransition,
  SessionStore,
} from "@cerebro/contracts/execution";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { ExecutionContext, RunId } from "@cerebro/contracts/identity";
import type { EffectOptions, ReadOptions } from "@cerebro/contracts/port";
import type { AgentDefinition, RunState } from "@cerebro/contracts/session";
import {
  DomainUpdate,
  SessionService,
} from "@cerebro/contracts/session-service";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { Effect, Fiber, Layer, Scope, Schema, Semaphore, Stream } from "effect";

import { sameAddress, validateEvent } from "./event-handler.ts";
import { pendingRun, updateRunId } from "./pi-projection.ts";
import { attempt, checkOptions, waitForCaller } from "./runtime-ports.ts";

export interface SessionServiceDependencies {
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly authority: AuthorityService;
  readonly engine: ExecutionEngine;
  readonly store: SessionStore;
}

const hostOptions = (): ReadOptions => ({
  deadlineAt: Date.now() + 30_000,
});
const optionsFor = (handoff: DurableHandoff): EffectOptions => ({
  ...hostOptions(),
  operationId: id.operation(handoff.submission.requestId),
  requestDigest: handoff.submission.inputDigest,
});

const handoffs = (dependencies: SessionServiceDependencies) =>
  dependencies.store.recover(dependencies.address, hostOptions());

const authorizeCommand = (
  dependencies: SessionServiceDependencies,
  address: EventAddress,
  context: ExecutionContext,
  action: "read" | "execute" | "approve",
  options: ReadOptions
) =>
  Effect.gen(function* enforceCurrentAuthority() {
    yield* attempt(() => {
      checkOptions(options);
      if (!sameAddress(address, dependencies.address)) {
        throw new Denied({
          code: "unauthorized",
          reason: "Wrong conversation",
        });
      }
    });
    return yield* dependencies.authority.require(
      {
        action,
        address,
        context,
        pinnedAgent: dependencies.agent,
        resource: {
          id: address.agentId,
          kind: "agent",
          organizationId: address.organizationId,
        },
      },
      options
    );
  });

// Build this Layer in the DO's lifetime scope, independently of HTTP observers.
export const createSessionService = (
  dependencies: SessionServiceDependencies
) => {
  const findHandoff = (runId: RunId) =>
    Effect.gen(function* find() {
      const values = yield* handoffs(dependencies);
      const found = values.find(
        (handoff) => handoff.submission.runId === runId
      );
      return found ?? (yield* Effect.fail(new NotFound({ resource: "run" })));
    });
  const commit = (
    handoff: DurableHandoff,
    transition: HandoffTransition,
    attempts = 5
  ): Effect.Effect<DurableHandoff, ContractFailure> =>
    Effect.gen(function* commitTransition() {
      const values = yield* handoffs(dependencies);
      const revision = Math.max(0, ...values.map((value) => value.revision));
      return yield* dependencies.store
        .commit(dependencies.address, revision, transition, optionsFor(handoff))
        .pipe(
          Effect.catchTag("Conflict", (failure) =>
            failure.code === "version-mismatch" && attempts > 1
              ? commit(handoff, transition, attempts - 1)
              : Effect.fail(failure)
          )
        );
    });
  // This only assembles durable projection frames from Pi's sole execution loop.
  // A crash discards the buffer; native done records reconstruct the same batch.
  const answers = new Map<
    RunId,
    Extract<DomainUpdate, { type: "canonical-output" }>
  >();
  const terminals = new Map<RunId, Extract<DomainUpdate, { type: "run" }>>();
  const project = (update: DomainUpdate) =>
    Effect.gen(function* projectDomain() {
      yield* attempt(() => Schema.decodeUnknownSync(DomainUpdate)(update));
      const runId = updateRunId(update);
      const handoff = yield* findHandoff(runId);
      if (update.type === "canonical-output") {
        const prior = answers.get(runId);
        if (
          prior &&
          canonicalToolArguments(prior) !== canonicalToolArguments(update)
        ) {
          return yield* Effect.fail(
            new Conflict({
              code: "already-final",
              reason: "Pending canonical answer changed",
            })
          );
        }
        answers.set(runId, update);
        return;
      }
      if (update.type === "run" && update.run.state === "completed") {
        const answer = [...answers.values()].find((value) =>
          value.output.runIds.includes(runId)
        );
        if (answer) {
          terminals.set(runId, update);
          const completed = answer.output.runIds.map((member) =>
            terminals.get(member)
          );
          if (completed.some((value) => !value)) {
            return;
          }
          const runs: DomainUpdate[] = [];
          for (const value of completed) {
            if (value) {
              runs.push(value);
            }
          }
          const primary = yield* findHandoff(answer.output.runId);
          yield* commit(primary, {
            runId: answer.output.runId,
            type: "projected-batch",
            updates: [
              {
                execution: {
                  executionId: answer.output.executionId,
                  runIds: answer.output.runIds,
                },
                type: "execution",
              },
              answer,
              ...runs,
            ],
          });
          answers.delete(answer.output.runId);
          for (const member of answer.output.runIds) {
            terminals.delete(member);
          }
          return;
        }
      }
      yield* commit(handoff, { runId, type: "projected", update });
    });
  const projectStates = (states: readonly RunState[]) =>
    Effect.gen(function* projectAffected() {
      for (const run of states) {
        const handoff = yield* findHandoff(run.runId);
        if (
          handoff.run.state === "unknown-outcome" ||
          run.state === "completed"
        ) {
          continue;
        }
        yield* commit(handoff, {
          run,
          runId: run.runId,
          type: "run-state",
        });
      }
    });
  const projectBeforeStop = (engine: EngineConversation, runId: RunId) =>
    Effect.scoped(
      Stream.runForEach(
        Stream.takeUntil(
          engine.observe(hostOptions()),
          (update) => update.type === "run" && update.run.runId === runId
        ),
        project
      )
    );
  const repair = (original: DurableHandoff, engine: EngineConversation) =>
    Effect.gen(function* repairHandoff() {
      let handoff = original;
      if (!handoff.engineAccepted) {
        const states = yield* engine.inspect(hostOptions());
        const accepted = states.some(
          (run) => run.runId === handoff.submission.runId
        );
        if (handoff.mode === "replace" && !handoff.replaceStopped) {
          if (!accepted) {
            const unknown = (yield* handoffs(dependencies)).find(
              (item) => item.run.state === "unknown-outcome"
            );
            if (unknown?.run.state === "unknown-outcome") {
              return yield* Effect.fail(
                new UnknownOutcome({
                  operationId: unknown.run.operationId,
                  reason: "Reconcile the uncertain effect before replacement",
                })
              );
            }
            const pending = states.find(pendingRun);
            if (pending) {
              yield* projectBeforeStop(engine, pending.runId);
            }
            yield* projectStates(yield* engine.stop(hostOptions()));
          }
          // The original accepted operation proves Stop preceded its submission.
          handoff = yield* commit(handoff, {
            runId: handoff.submission.runId,
            type: "replace-stopped",
          });
        }
        if (!accepted) {
          yield* authorizeCommand(
            dependencies,
            handoff.address,
            handoff.submission.event.context,
            "execute",
            hostOptions()
          );
          yield* engine.submit(handoff.submission, hostOptions());
        }
        handoff = yield* commit(handoff, {
          runId: handoff.submission.runId,
          type: "engine-accepted",
        });
      }
      if (!handoff.acknowledged) {
        handoff = yield* commit(handoff, {
          runId: handoff.submission.runId,
          type: "acknowledged",
        });
      }
      return handoff;
    });

  return Effect.gen(function* createCoordinator() {
    const scope = yield* Effect.scope;
    const mutations = yield* Semaphore.make(1);
    let conversation: EngineConversation | undefined;
    let observationFailure: ContractFailure | undefined;
    const open = (): Effect.Effect<EngineConversation, ContractFailure> =>
      Effect.gen(function* openConversation() {
        if (conversation) {
          return conversation;
        }
        const opened = yield* Scope.provide(scope)(
          dependencies.engine.open(
            dependencies.address,
            dependencies.agent,
            hostOptions()
          )
        );
        conversation = opened;
        yield* Effect.forkIn(scope)(
          Effect.scoped(
            Stream.runForEach(
              opened.observe({ deadlineAt: Number.MAX_SAFE_INTEGER }),
              (update) => Semaphore.withPermits(mutations, 1)(project(update))
            )
          ).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                observationFailure = error;
              })
            )
          )
        );
        return opened;
      });
    const recover = () =>
      Semaphore.withPermits(
        mutations,
        1
      )(
        Effect.gen(function* recoverHandoffs() {
          const values = yield* handoffs(dependencies);
          if (!values.length) {
            return;
          }
          const engine = yield* open();
          for (const handoff of values) {
            if (!handoff.engineAccepted || !handoff.acknowledged) {
              yield* repair(handoff, engine);
            }
          }
          yield* projectStates(yield* engine.inspect(hostOptions()));
        })
      );
    const durableCommand = <A>(
      program: Effect.Effect<A, ContractFailure>,
      options: ReadOptions
    ) =>
      Effect.gen(function* runCommand() {
        yield* attempt(() => checkOptions(options));
        const fiber = yield* Effect.forkIn(scope)(
          Semaphore.withPermits(mutations, 1)(program)
        );
        return yield* waitForCaller(Fiber.join(fiber), options);
      });
    const service: SessionService = {
      approve: (command, options) =>
        Effect.gen(function* approve() {
          yield* authorizeCommand(
            dependencies,
            command.address,
            command.context,
            "approve",
            options
          );
          return yield* durableCommand(
            Effect.gen(function* decideApproval() {
              const permit = yield* authorizeCommand(
                dependencies,
                command.address,
                command.context,
                "approve",
                hostOptions()
              );
              const handoff = yield* findHandoff(command.runId);
              const snapshot = yield* dependencies.store.snapshot(
                command.address,
                command.context,
                hostOptions()
              );
              const state = snapshot.approvals.find(
                (item) =>
                  item.approvalId === command.approvalId &&
                  item.runId === command.runId
              );
              const bound = handoff.approvals.find(
                (item) =>
                  item.id === command.approvalId && item.runId === command.runId
              );
              if (!state || !bound) {
                return yield* Effect.fail(
                  new NotFound({ resource: "bound approval" })
                );
              }
              if (state.state !== "pending") {
                if (
                  (state.state === "allowed") !==
                  (command.decision === "allow")
                ) {
                  return yield* Effect.fail(
                    new Conflict({
                      code: "already-final",
                      reason: "Approval decision is immutable",
                    })
                  );
                }
                return handoff.run;
              }
              if (
                state.expiresAt <= Date.now() ||
                bound.policyVersion !== permit.policyVersion
              ) {
                return yield* Effect.fail(
                  new Denied({
                    code: "revoked",
                    reason: "Approval expired or policy changed",
                  })
                );
              }
              if (command.decision === "allow") {
                yield* commit(handoff, {
                  approval: { ...bound, approverId: command.context.actor.id },
                  runId: command.runId,
                  type: "approval",
                });
              }
              yield* commit(handoff, {
                runId: command.runId,
                type: "projected",
                update: {
                  ...state,
                  state: command.decision === "allow" ? "allowed" : "denied",
                  type: "approval",
                },
              });
              const engine = yield* open();
              if (command.decision !== "allow") {
                yield* projectBeforeStop(engine, command.runId);
              }
              const run =
                command.decision === "allow"
                  ? yield* engine.approve(bound, hostOptions())
                  : yield* engine.cancel(command.runId, hostOptions());
              yield* projectStates(yield* engine.inspect(hostOptions()));
              return run;
            }),
            options
          );
        }),
      cancel: (command, options) =>
        Effect.gen(function* cancel() {
          yield* authorizeCommand(
            dependencies,
            command.address,
            command.context,
            "execute",
            options
          );
          return yield* durableCommand(
            Effect.gen(function* cancelRun() {
              yield* authorizeCommand(
                dependencies,
                command.address,
                command.context,
                "execute",
                hostOptions()
              );
              const handoff = yield* findHandoff(command.runId);
              if (handoff.run.state === "unknown-outcome") {
                return yield* Effect.fail(
                  new UnknownOutcome({
                    operationId: handoff.run.operationId,
                    reason: "Stop cannot confirm an uncertain write",
                  })
                );
              }
              if (!pendingRun(handoff.run)) {
                return handoff.run;
              }
              const engine = yield* open();
              // Stop removes Pi's live membership; persist a fresh observation first.
              yield* projectBeforeStop(engine, command.runId);
              const run = yield* engine.cancel(command.runId, hostOptions());
              yield* projectStates(yield* engine.inspect(hostOptions()));
              return run;
            }),
            options
          );
        }),
      inspect: (address, context, options) =>
        Effect.gen(function* inspect() {
          yield* authorizeCommand(
            dependencies,
            address,
            context,
            "read",
            options
          );
          return yield* dependencies.store.snapshot(address, context, options);
        }),
      stream: (address, context, request, options) =>
        Stream.unwrap(
          Effect.gen(function* observeDomain() {
            yield* authorizeCommand(
              dependencies,
              address,
              context,
              "read",
              options
            );
            if (observationFailure) {
              return yield* Effect.fail(
                new Unavailable({
                  reason: "Engine projection needs host recovery",
                })
              );
            }
            return dependencies.store.attach(
              address,
              context,
              request,
              options
            );
          })
        ),
      submit: (command, options) =>
        Effect.gen(function* submit() {
          yield* authorizeCommand(
            dependencies,
            command.event,
            command.event.context,
            "execute",
            options
          );
          yield* attempt(() => {
            if (
              command.mode !== undefined &&
              command.mode !== "follow-up" &&
              command.mode !== "steer" &&
              command.mode !== "replace"
            ) {
              throw new InvalidInput({ reason: "Unsupported submission mode" });
            }
            const valid = validateEvent(command.event, Date.now());
            if (valid.status !== "ok") {
              throw new InvalidInput({
                reason: "reason" in valid ? valid.reason : "Invalid event",
              });
            }
          });
          return yield* durableCommand(
            Effect.gen(function* handoffSubmission() {
              const engine = yield* open();
              for (const value of yield* handoffs(dependencies)) {
                if (
                  value.mode === "replace" &&
                  !value.engineAccepted &&
                  value.submission.requestId !== command.event.eventId
                ) {
                  yield* repair(value, engine);
                }
              }
              const admitted = yield* dependencies.store.admit(
                command,
                dependencies.agent,
                { ...options, signal: undefined }
              );
              const replayed = admitted.acknowledged;
              const accepted = yield* repair(admitted, engine);
              yield* projectStates(yield* engine.inspect(hostOptions()));
              const receipt = yield* dependencies.store.receipt(
                accepted.address,
                accepted.submission.requestId,
                command.event.context,
                hostOptions()
              );
              return { ...receipt, replayed };
            }),
            options
          );
        }),
    };
    return {
      backgroundFailure: () => observationFailure,
      project,
      recover,
      service,
    };
  });
};

export const sessionServiceLayer = (dependencies: SessionServiceDependencies) =>
  Layer.effect(
    SessionService,
    Effect.map(createSessionService(dependencies), (runtime) => runtime.service)
  );
