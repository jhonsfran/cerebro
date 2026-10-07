/* oxlint-disable no-await-in-loop -- Observation and durable revisions are delivered in order. */
import { classifyEventDelivery } from "@cerebro/contracts/events";
import type { EventAddress } from "@cerebro/contracts/events";
import { SessionStore } from "@cerebro/contracts/execution";
import type {
  DurableHandoff,
  HandoffTransition,
} from "@cerebro/contracts/execution";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id, isExecutionContextActiveAt } from "@cerebro/contracts/identity";
import type { ExecutionContext, RunId } from "@cerebro/contracts/identity";
import type { EffectOptions, ReadOptions } from "@cerebro/contracts/port";
import type {
  AgentDefinition,
  ContentDependencies,
} from "@cerebro/contracts/session";
import {
  DomainSnapshot,
  DomainUpdate,
} from "@cerebro/contracts/session-service";
import type {
  Observation,
  ObservationRequest,
} from "@cerebro/contracts/session-service";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import { Effect, Layer, Schema, Stream } from "effect";

import { sameAddress } from "./event-handler.ts";
import {
  pendingRun,
  projectUpdate,
  updateRunId,
  updateRunIds,
} from "./pi-projection.ts";
import { attempt, checkOptions, contractFailure } from "./runtime-ports.ts";

export interface SessionPersistence {
  readonly load: () => string | undefined;
  readonly save: (json: string) => void;
  readonly transaction: <A>(run: () => A) => A;
}
interface ProjectionRecord {
  readonly id: string;
  readonly revision: number;
  readonly update: DomainUpdate;
}
interface StoreState {
  readonly agent: AgentDefinition;
  readonly snapshot: DomainSnapshot;
  readonly handoffs: readonly DurableHandoff[];
  readonly outbox: readonly ProjectionRecord[];
}
export interface SessionStoreConfiguration {
  readonly address: EventAddress;
  readonly agent: AgentDefinition;
  readonly authorize: (
    context: ExecutionContext,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
  readonly observerCapacity?: number;
  readonly accessIntervalMs?: number;
}
interface Observer {
  buffer: ProjectionRecord[];
  overflow: boolean;
  closed: boolean;
  wake: () => void;
}

const dependenciesOf = (snapshot: DomainSnapshot): ContentDependencies => ({
  sourceIds: [
    ...new Set([
      ...snapshot.outputs.flatMap((output) => [
        ...output.dependencies.sourceIds,
        ...output.citations.map((citation) => citation.sourceId),
      ]),
      ...snapshot.tools.flatMap((tool) => tool.dependencies.sourceIds),
    ]),
  ],
  toolIds: [
    ...new Set([
      ...snapshot.outputs.flatMap((output) => output.dependencies.toolIds),
      ...snapshot.tools.flatMap((tool) => tool.dependencies.toolIds),
    ]),
  ],
});

const updateDependencies = (update: DomainUpdate): ContentDependencies => {
  if (update.type === "canonical-output") {
    return {
      ...update.output.dependencies,
      sourceIds: [
        ...new Set([
          ...update.output.dependencies.sourceIds,
          ...update.output.citations.map((citation) => citation.sourceId),
        ]),
      ],
    };
  }
  if (update.type === "citation") {
    return {
      ...update.dependencies,
      sourceIds: [
        ...new Set([
          ...update.dependencies.sourceIds,
          update.citation.sourceId,
        ]),
      ],
    };
  }
  if (update.type === "tool") {
    return update.dependencies;
  }
  return { sourceIds: [], toolIds: [] };
};

const optionsFor = (handoff: DurableHandoff): EffectOptions => ({
  deadlineAt: Date.now() + 30_000,
  operationId: id.operation(handoff.submission.requestId),
  requestDigest: handoff.submission.inputDigest,
});

const validateTransition = (
  prior: DurableHandoff,
  transition: HandoffTransition
) => {
  if (
    transition.type === "replace-stopped" &&
    (prior.mode !== "replace" || prior.engineAccepted)
  ) {
    throw new Conflict({
      code: "version-mismatch",
      reason: "Replacement Stop must precede acceptance",
    });
  }
  if (
    transition.type === "engine-accepted" &&
    prior.mode === "replace" &&
    !prior.replaceStopped
  ) {
    throw new Conflict({
      code: "version-mismatch",
      reason: "Replacement Stop is incomplete",
    });
  }
  if (transition.type === "acknowledged" && !prior.engineAccepted) {
    throw new Conflict({
      code: "version-mismatch",
      reason: "Pi acceptance is required before acknowledgment",
    });
  }
  if (
    transition.type === "approval" &&
    (transition.approval.runId !== transition.runId ||
      transition.approval.organizationId !== prior.address.organizationId ||
      transition.approval.agentId !== prior.address.agentId)
  ) {
    throw new Conflict({
      code: "digest-mismatch",
      reason: "Approval belongs to another run or agent",
    });
  }
};

const transitionUpdate = (
  prior: DurableHandoff,
  transition: HandoffTransition
): DomainUpdate | undefined => {
  if (transition.type === "run-state") {
    if (transition.run.runId !== transition.runId) {
      throw new Conflict({
        code: "digest-mismatch",
        reason: "Run identity changed",
      });
    }
    return { run: transition.run, type: "run" };
  }
  if (transition.type === "projected") {
    if (updateRunId(transition.update) !== transition.runId) {
      throw new Conflict({
        code: "digest-mismatch",
        reason: "Projection run changed",
      });
    }
    return transition.update;
  }
  if (
    transition.type === "engine-accepted" &&
    prior.submission.event.event.type === "user.message"
  ) {
    return {
      message: {
        eventId: prior.submission.requestId,
        mode: prior.mode,
        occurredAt: prior.submission.event.occurredAt,
        runId: prior.submission.runId,
        text: prior.submission.event.event.payload.text,
      },
      type: "user-message",
    };
  }
};

const transitionHandoff = (
  prior: DurableHandoff,
  transition: HandoffTransition,
  revision: number,
  update: DomainUpdate | undefined
): DurableHandoff => ({
  ...prior,
  acknowledged: prior.acknowledged || transition.type === "acknowledged",
  approvals:
    transition.type === "approval"
      ? [
          ...prior.approvals.filter(
            (approval) => approval.id !== transition.approval.id
          ),
          transition.approval,
        ]
      : prior.approvals,
  engineAccepted: prior.engineAccepted || transition.type === "engine-accepted",
  projectedRevision: update ? revision : prior.projectedRevision,
  replaceStopped: prior.replaceStopped || transition.type === "replace-stopped",
  revision,
  run: update?.type === "run" ? update.run : prior.run,
});

export const createSessionStore = (
  persistence: SessionPersistence,
  configuration: SessionStoreConfiguration
) => {
  const observers = new Set<Observer>();
  const capacity = configuration.observerCapacity ?? 64;
  const interval = configuration.accessIntervalMs ?? 250;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || interval < 1) {
    throw new Error("Invalid observation configuration");
  }
  const initial: StoreState = {
    agent: structuredClone(configuration.agent),
    handoffs: [],
    outbox: [],
    snapshot: {
      address: configuration.address,
      agentVersion: configuration.agent.version,
      approvals: [],
      executions: [],
      outputs: [],
      revision: 0,
      runs: [],
      tools: [],
      userMessages: [],
    },
  };
  const load = (): StoreState => {
    const json = persistence.load();
    const state: StoreState = json
      ? JSON.parse(json)
      : structuredClone(initial);
    Schema.decodeUnknownSync(DomainSnapshot)(state.snapshot);
    if (!sameAddress(state.snapshot.address, configuration.address)) {
      throw new Denied({
        code: "unauthorized",
        reason: "Store belongs to another session",
      });
    }
    return state;
  };
  const access = (address: EventAddress, context?: ExecutionContext) => {
    if (
      !sameAddress(configuration.address, address) ||
      (context &&
        !isExecutionContextActiveAt(
          context,
          address.organizationId,
          Date.now()
        ))
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "Session access denied",
      });
    }
  };
  const notify = (record: ProjectionRecord) => {
    for (const observer of observers) {
      if (observer.buffer.length >= capacity) {
        observer.buffer = [];
        observer.overflow = true;
      }
      if (!observer.overflow) {
        observer.buffer.push(record);
      }
      observer.wake();
    }
  };
  const save = (state: StoreState, update?: DomainUpdate) => {
    const record = update && {
      id: `${configuration.address.sessionId}:${state.snapshot.revision}`,
      revision: state.snapshot.revision,
      update,
    };
    persistence.save(
      JSON.stringify({
        ...state,
        outbox: record ? [...state.outbox, record] : state.outbox,
      })
    );
    return record;
  };
  const commitBatch = (
    state: StoreState,
    prior: DurableHandoff,
    updates: readonly [DomainUpdate, ...DomainUpdate[]]
  ) => {
    if (updates.length === 0) {
      throw new InvalidInput({ reason: "Empty projection batch" });
    }
    const affected = new Set<RunId>();
    let projected = state.snapshot;
    for (const update of updates) {
      Schema.decodeUnknownSync(DomainUpdate)(update);
      if (update.type === "provisional-text" || update.type === "citation") {
        throw new InvalidInput({
          reason: "Projection batches require durable updates",
        });
      }
      for (const runId of updateRunIds(update)) {
        if (!state.handoffs.some((value) => value.submission.runId === runId)) {
          throw new NotFound({ resource: "Projection member admission" });
        }
        affected.add(runId);
      }
      projected = projectUpdate(projected, update);
    }
    // A final answer cannot escape independently of any linked terminal transition.
    for (const output of projected.outputs) {
      if (
        projected.tools.some(
          (tool) =>
            output.runIds.includes(tool.runId) &&
            tool.state !== "succeeded" &&
            tool.state !== "failed" &&
            tool.state !== "cancelled"
        ) ||
        output.runIds.some(
          (runId) =>
            !projected.runs.some(
              (run) => run.runId === runId && run.state === "completed"
            )
        )
      ) {
        throw new Conflict({
          code: "version-mismatch",
          reason:
            "Every answer member and required tool must complete in the same transaction",
        });
      }
    }
    if (
      canonicalToolArguments(projected) ===
      canonicalToolArguments(state.snapshot)
    ) {
      return { next: prior, records: [] };
    }
    const revision = state.snapshot.revision + updates.length;
    const records = updates.map((update, index) => ({
      id: `${configuration.address.sessionId}:${state.snapshot.revision + index + 1}`,
      revision: state.snapshot.revision + index + 1,
      update,
    }));
    const handoffs = state.handoffs.map((handoff) =>
      affected.has(handoff.submission.runId)
        ? {
            ...handoff,
            projectedRevision: revision,
            revision,
            run:
              projected.runs.find(
                (run) => run.runId === handoff.submission.runId
              ) ?? handoff.run,
          }
        : handoff
    );
    const next =
      handoffs.find(
        (handoff) => handoff.submission.runId === prior.submission.runId
      ) ?? prior;
    save({
      ...state,
      handoffs,
      outbox: [...state.outbox, ...records],
      snapshot: { ...projected, revision },
    });
    return { next, records };
  };
  const snapshotRead = (
    address: EventAddress,
    context: ExecutionContext,
    options: ReadOptions
  ) =>
    Effect.gen(function* readProjection() {
      const projection = yield* attempt(() => {
        checkOptions(options);
        access(address, context);
        return structuredClone(load().snapshot);
      });
      yield* configuration.authorize(
        context,
        dependenciesOf(projection),
        options
      );
      return projection;
    });
  const observe = async function* observe(
    observer: Observer,
    address: EventAddress,
    context: ExecutionContext,
    request: ObservationRequest,
    options: ReadOptions
  ): AsyncIterable<Observation> {
    let epoch = crypto.randomUUID();
    let sequence = 0;
    let revision = -1;
    let reason: "attach" | "overflow" | "reconnect" =
      request.afterRevision === undefined ? "attach" : "reconnect";
    const metadata = () => {
      const frameSequence = sequence;
      sequence += 1;
      return {
        accessGeneration: request.accessGeneration,
        address,
        epoch,
        schemaVersion: 1 as const,
        sequence: frameSequence,
      };
    };
    while (!observer.closed) {
      let snapshot: DomainSnapshot;
      let record: ProjectionRecord | undefined;
      try {
        snapshot = await Effect.runPromise(
          snapshotRead(address, context, options)
        );
        if (revision >= 0 && !observer.overflow) {
          record = observer.buffer.shift();
          if (record) {
            await Effect.runPromise(
              configuration.authorize(
                context,
                updateDependencies(record.update),
                options
              )
            );
          }
        }
      } catch (error) {
        const failure = contractFailure(
          error instanceof Error && "cause" in error ? error.cause : error
        );
        if (failure instanceof Denied) {
          yield {
            ...metadata(),
            reason: failure.code === "revoked" ? "revoked" : "unauthorized",
            type: "access-denied",
          };
          return;
        }
        throw failure;
      }
      if (revision < 0 || observer.overflow) {
        if (observer.overflow) {
          epoch = crypto.randomUUID();
          sequence = 0;
          reason = "overflow";
        }
        observer.overflow = false;
        observer.buffer = observer.buffer.filter(
          (item) => item.revision > snapshot.revision
        );
        ({ revision } = snapshot);
        yield { ...metadata(), reason, snapshot, type: "snapshot" };
      }
      if (record) {
        if (record.revision > revision + 1) {
          observer.overflow = true;
          continue;
        }
        if (
          record.revision > revision ||
          (record.revision === revision &&
            record.update.type === "provisional-text")
        ) {
          ({ revision } = record);
          yield {
            ...metadata(),
            revision,
            type: "update",
            update: record.update,
          };
        }
        continue;
      }
      // Storage scopes own this timer and subscription; detaching never sends Stop.
      // oxlint-disable-next-line promise/avoid-new -- This adapter bridges a scoped storage notification and worker timer.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval);
        observer.wake = () => {
          clearTimeout(timer);
          resolve();
        };
        if (observer.closed || observer.buffer.length || observer.overflow) {
          observer.wake();
        }
      });
    }
  };
  const service: SessionStore = {
    admit: (command, agent, options) =>
      Effect.gen(function* admit() {
        yield* attempt(() => {
          checkOptions(options);
          access(command.event, command.event.context);
        });
        const mode = command.mode ?? "follow-up";
        const digest = yield* Effect.tryPromise({
          catch: contractFailure,
          try: () => digestToolArguments({ event: command.event, mode }),
        });
        return yield* attempt(() => {
          const handoff = persistence.transaction(() => {
            const state = load();
            const prior = state.handoffs.find(
              (item) => item.submission.requestId === command.event.eventId
            );
            if (prior) {
              if (
                classifyEventDelivery(prior.submission.event, command.event) !==
                  "duplicate" ||
                prior.mode !== mode ||
                prior.submission.inputDigest !== digest
              ) {
                throw new Conflict({
                  code: "digest-mismatch",
                  reason: "Command input or mode changed",
                });
              }
              return prior;
            }
            if (
              state.handoffs.some(
                (item) => item.mode === "replace" && !item.engineAccepted
              )
            ) {
              throw new Unavailable({
                reason: "Repair the pending replacement before another command",
              });
            }
            if (
              agent.version !== state.snapshot.agentVersion ||
              agent.agentId !== configuration.address.agentId ||
              agent.organizationId !== configuration.address.organizationId
            ) {
              throw new Conflict({
                code: "version-mismatch",
                reason: "Pinned agent changed",
              });
            }
            const revision = state.snapshot.revision + 1;
            const runId = id.run(`run:${command.event.eventId}`);
            const next: DurableHandoff = {
              acknowledged: false,
              address: configuration.address,
              admittedRevision: revision,
              agentVersion: agent.version,
              approvals: [],
              engineAccepted: false,
              mode,
              projectedRevision: 0,
              replaceStopped: false,
              revision,
              run: { runId, state: "queued" },
              submission: {
                event: structuredClone(command.event),
                inputDigest: digest,
                mode: mode === "steer" ? "steer" : "follow-up",
                requestId: command.event.eventId,
                runId,
              },
            };
            const record = save({
              ...state,
              handoffs: [...state.handoffs, next],
              snapshot: { ...state.snapshot, revision },
            });
            return { next, records: record ? [record] : [] };
          });
          return "next" in handoff
            ? structuredClone(handoff.next)
            : structuredClone(handoff);
        });
      }),
    attach: (address, context, request, options) =>
      Stream.unwrap(
        Effect.gen(function* attach() {
          yield* attempt(() => {
            if (
              !Number.isSafeInteger(request.accessGeneration) ||
              request.accessGeneration < 0 ||
              (request.afterRevision !== undefined &&
                (!Number.isSafeInteger(request.afterRevision) ||
                  request.afterRevision < 0))
            ) {
              throw new InvalidInput({ reason: "Invalid observation cursor" });
            }
          });
          yield* service.snapshot(address, context, options);
          const observer = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const value: Observer = {
                buffer: [],
                closed: false,
                overflow: false,
                wake: () => {
                  /* No pending wait before the first frame. */
                },
              };
              observers.add(value);
              return value;
            }),
            (value) =>
              Effect.sync(() => {
                value.closed = true;
                value.wake();
                observers.delete(value);
              })
          );
          return Stream.fromAsyncIterable(
            observe(observer, address, context, request, options),
            contractFailure
          );
        })
      ),
    commit: (address, expectedRevision, transition, options) =>
      attempt(() => {
        checkOptions(options);
        access(address);
        const result = persistence.transaction(() => {
          const state = load();
          if (expectedRevision !== state.snapshot.revision) {
            throw new Conflict({
              code: "version-mismatch",
              reason: "Domain revision changed",
            });
          }
          const prior = state.handoffs.find(
            (item) => item.submission.runId === transition.runId
          );
          if (!prior) {
            throw new NotFound({ resource: "handoff" });
          }
          if (transition.type === "projected-batch") {
            return commitBatch(state, prior, transition.updates);
          }
          validateTransition(prior, transition);
          const update = transitionUpdate(prior, transition);
          if (update?.type === "provisional-text") {
            projectUpdate(state.snapshot, update);
            return {
              next: prior,
              records: pendingRun(prior.run)
                ? [
                    {
                      id: `provisional:${transition.runId}`,
                      revision: expectedRevision,
                      update,
                    },
                  ]
                : [],
            };
          }
          if (transition.type === "projected" && update) {
            return commitBatch(state, prior, [update]);
          }
          const projected = update
            ? projectUpdate(state.snapshot, update)
            : state.snapshot;
          if (
            (transition.type === "projected" ||
              transition.type === "run-state") &&
            canonicalToolArguments(projected) ===
              canonicalToolArguments(state.snapshot)
          ) {
            return { next: prior, records: [] };
          }
          const revision = expectedRevision + 1;
          const snapshot = { ...projected, revision };
          const next = transitionHandoff(prior, transition, revision, update);
          const record = save(
            {
              ...state,
              handoffs: state.handoffs.map((item) =>
                item.submission.runId === next.submission.runId ? next : item
              ),
              snapshot,
            },
            update
          );
          return { next, records: record ? [record] : [] };
        });
        for (const record of result.records) {
          notify(record);
        }
        return structuredClone(result.next);
      }),
    receipt: (address, requestId, context, options) =>
      Effect.gen(function* receipt() {
        yield* service.snapshot(address, context, options);
        return yield* attempt(() => {
          const handoff = load().handoffs.find(
            (item) => item.submission.requestId === requestId
          );
          if (!handoff) {
            throw new NotFound({ resource: "receipt" });
          }
          if (!handoff.acknowledged) {
            throw new Unavailable({ reason: "Pi handoff is not acknowledged" });
          }
          return {
            acceptedEventId: requestId,
            replayed: true,
            runId: handoff.submission.runId,
            sessionId: address.sessionId,
          };
        });
      }),
    recover: (address, options) =>
      attempt(() => {
        checkOptions(options);
        access(address);
        return structuredClone(load().handoffs);
      }),
    snapshot: snapshotRead,
  };

  return {
    acknowledgeOutbox: (recordId: string) =>
      attempt(() =>
        persistence.transaction(() => {
          const state = load();
          save({
            ...state,
            outbox: state.outbox.filter((record) => record.id !== recordId),
          });
        })
      ),
    domain: () => structuredClone(load().snapshot),
    layer: Layer.succeed(SessionStore, service),
    observerCount: () => observers.size,
    outbox: () => structuredClone(load().outbox),
    pending: () => load().handoffs.filter((item) => pendingRun(item.run)),
    pinnedAgent: () => structuredClone(load().agent),
    publish: (runId: RunId, update: DomainUpdate) =>
      Effect.gen(function* publish() {
        const state = yield* attempt(load);
        const handoff = state.handoffs.find(
          (item) => item.submission.runId === runId
        );
        if (!handoff) {
          return yield* Effect.fail(new NotFound({ resource: "handoff" }));
        }
        if (update.type === "provisional-text") {
          yield* attempt(() => {
            projectUpdate(state.snapshot, update);
            notify({
              id: `provisional:${runId}`,
              revision: state.snapshot.revision,
              update,
            });
          });
          return;
        }
        yield* service.commit(
          configuration.address,
          state.snapshot.revision,
          { runId, type: "projected", update },
          optionsFor(handoff)
        );
      }),
    service,
  };
};

export const createCelldSessionStore = (
  storage: DurableObjectStorage,
  configuration: SessionStoreConfiguration
) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_pi_session (id INTEGER PRIMARY KEY CHECK (id=1), state TEXT NOT NULL)"
  );
  return createSessionStore(
    {
      load: () =>
        storage.sql
          .exec<{ state: string }>(
            "SELECT state FROM cerebro_pi_session WHERE id=1"
          )
          .toArray()[0]?.state,
      save: (json) => {
        storage.sql.exec(
          "INSERT INTO cerebro_pi_session VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
          json
        );
      },
      transaction: (run) => storage.transactionSync(run),
    },
    configuration
  );
};
