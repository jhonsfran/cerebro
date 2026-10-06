import { Effect, Layer, Stream } from "effect";

import { classifyEventDelivery } from "../events.ts";
import { ExecutionEngine, SessionStore } from "../execution.ts";
import type {
  DurableHandoff,
  EngineConversation,
  EngineSubmission,
} from "../execution.ts";
import { Conflict, Denied, NotFound, Unavailable } from "../failures.ts";
import type { ContractFailure } from "../failures.ts";
import { id, isExecutionContextActiveAt } from "../identity.ts";
import type { RunId } from "../identity.ts";
import type { ReadOptions } from "../port.ts";
import { SessionService } from "../session-service.ts";
import type { DomainSnapshot, Observation } from "../session-service.ts";
import type { RunState } from "../session.ts";
import { canonicalToolArguments } from "../tools.ts";

const attempt = <A>(run: () => A): Effect.Effect<A, ContractFailure> =>
  Effect.try({
    catch: (cause) =>
      cause instanceof Conflict ||
      cause instanceof Denied ||
      cause instanceof NotFound ||
      cause instanceof Unavailable
        ? cause
        : new Unavailable({ reason: String(cause) }),
    try: run,
  });
const deadline = (options: ReadOptions) => {
  if (
    !Number.isFinite(options.deadlineAt) ||
    options.deadlineAt <= Date.now() ||
    options.signal?.aborted
  ) {
    throw new Unavailable({ reason: "Deadline or interruption" });
  }
};
export const createEngineFake = () => {
  const submissions = new Map<string, EngineSubmission>();
  const runs = new Map<RunId, RunState>();
  const counts = { cancel: 0, open: 0, release: 0, submit: 0 };
  const conversation: EngineConversation = {
    approve: (approval, options) =>
      attempt(() => {
        deadline(options);
        const run = runs.get(approval.runId);
        if (!run) {
          throw new NotFound({ resource: "run" });
        }
        return structuredClone(run);
      }),
    cancel: (runId, options) =>
      attempt(() => {
        deadline(options);
        if (!runs.has(runId)) {
          throw new NotFound({ resource: "run" });
        }
        const cancelled = {
          endedAt: Date.now(),
          runId,
          state: "cancelled",
        } as const;
        runs.set(runId, cancelled);
        counts.cancel += 1;
        return cancelled;
      }),
    inspect: (options) =>
      attempt(() => {
        deadline(options);
        return structuredClone([...runs.values()]);
      }),
    observe: () => Stream.empty,
    release: Effect.sync(() => {
      counts.release += 1;
    }),
    submit: (submission, options) =>
      attempt(() => {
        deadline(options);
        const prior = submissions.get(submission.requestId);
        if (
          prior &&
          canonicalToolArguments(prior) !== canonicalToolArguments(submission)
        ) {
          throw new Conflict({
            code: "digest-mismatch",
            reason: "Submission changed",
          });
        }
        if (!prior) {
          submissions.set(submission.requestId, structuredClone(submission));
          runs.set(submission.runId, {
            runId: submission.runId,
            state: runs.size === 0 ? "running" : "queued",
          });
          counts.submit += 1;
        }
        return { replayed: !!prior, runId: submission.runId };
      }),
  };
  const service: ExecutionEngine = {
    open: (_address, _agent, options) =>
      Effect.acquireRelease(
        attempt(() => {
          deadline(options);
          counts.open += 1;
          return conversation;
        }),
        () => conversation.release
      ),
  };
  return {
    conversation,
    counts,
    layer: Layer.succeed(ExecutionEngine, service),
    service,
  };
};
const sameAddress = (
  first: DomainSnapshot["address"],
  second: DomainSnapshot["address"]
) =>
  first.organizationId === second.organizationId &&
  first.conversationId === second.conversationId &&
  first.agentId === second.agentId &&
  first.sessionId === second.sessionId;
export const createStoreFake = (initial: DomainSnapshot) => {
  const handoffs = new Map<string, DurableHandoff>();
  let { revision } = initial;
  const access = (
    address: DomainSnapshot["address"],
    context: Parameters<SessionStore["snapshot"]>[1]
  ) => {
    if (
      !sameAddress(initial.address, address) ||
      !isExecutionContextActiveAt(
        context,
        initial.address.organizationId,
        Date.now()
      )
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "Current access denied",
      });
    }
  };
  const service: SessionStore = {
    admit: (event, agent, options) =>
      attempt(() => {
        deadline(options);
        access(event, event.context);
        const prior = handoffs.get(event.eventId);
        if (prior) {
          if (
            classifyEventDelivery(prior.submission.event, event) !== "duplicate"
          ) {
            throw new Conflict({
              code: "digest-mismatch",
              reason: "Event changed",
            });
          }
          return structuredClone(prior);
        }
        revision += 1;
        const handoff: DurableHandoff = {
          acknowledged: false,
          address: initial.address,
          admittedRevision: revision,
          agentVersion: agent.version,
          approvals: [],
          engineAccepted: false,
          projectedRevision: 0,
          revision,
          run: { runId: id.run(`run:${event.eventId}`), state: "queued" },
          submission: {
            event: structuredClone(event),
            inputDigest: options.requestDigest,
            requestId: event.eventId,
            runId: id.run(`run:${event.eventId}`),
          },
          wakeRegistered: false,
        };
        handoffs.set(event.eventId, handoff);
        return structuredClone(handoff);
      }),
    attach: (address, context, request, options) =>
      Stream.unwrap(
        attempt(() => {
          deadline(options);
          access(address, context);
          return Stream.succeed({
            accessGeneration: request.accessGeneration,
            address: initial.address,
            epoch: "fixture-store",
            reason: "attach",
            schemaVersion: 1,
            sequence: 0,
            snapshot: { ...structuredClone(initial), revision },
            type: "snapshot",
          } as const);
        })
      ),
    commit: (address, expected, transition, options) =>
      attempt(() => {
        deadline(options);
        if (
          canonicalToolArguments(address) !==
          canonicalToolArguments(initial.address)
        ) {
          throw new Denied({
            code: "unauthorized",
            reason: "Wrong conversation",
          });
        }
        if (expected !== revision) {
          throw new Conflict({
            code: "version-mismatch",
            reason: "Revision changed",
          });
        }
        const prior = [...handoffs.values()].find(
          (value) => value.submission.runId === transition.runId
        );
        if (!prior) {
          throw new NotFound({ resource: "handoff" });
        }
        if (
          transition.type === "acknowledged" &&
          (!prior.wakeRegistered ||
            (prior.run.state !== "queued" && !prior.engineAccepted))
        ) {
          throw new Conflict({
            code: "version-mismatch",
            reason:
              "Durable wake required; active runs also need engine acceptance",
          });
        }
        const next = {
          ...prior,
          acknowledged:
            prior.acknowledged || transition.type === "acknowledged",
          approvals:
            transition.type === "approval"
              ? [...prior.approvals, transition.approval]
              : prior.approvals,
          engineAccepted:
            prior.engineAccepted || transition.type === "engine-accepted",
          projectedRevision:
            transition.type === "projected"
              ? revision + 1
              : prior.projectedRevision,
          revision: revision + 1,
          run: transition.type === "run-state" ? transition.run : prior.run,
          wakeAt:
            transition.type === "wake-registered"
              ? transition.wakeAt
              : prior.wakeAt,
          wakeRegistered:
            prior.wakeRegistered || transition.type === "wake-registered",
        };
        revision += 1;
        handoffs.set(next.submission.requestId, next);
        return structuredClone(next);
      }),
    receipt: (address, requestId, context, options) =>
      attempt(() => {
        deadline(options);
        access(address, context);
        const handoff = handoffs.get(requestId);
        if (!handoff) {
          throw new NotFound({ resource: "receipt" });
        }
        if (!handoff.acknowledged) {
          throw new Unavailable({ reason: "Not yet acknowledged" });
        }
        return {
          acceptedEventId: requestId,
          replayed: true,
          runId: handoff.submission.runId,
          sessionId: initial.address.sessionId,
        };
      }),
    recover: (_address, options) =>
      attempt(() => {
        deadline(options);
        return structuredClone([...handoffs.values()]);
      }),
    snapshot: (address, context, options) =>
      attempt(() => {
        deadline(options);
        access(address, context);
        return { ...structuredClone(initial), revision };
      }),
  };
  return {
    getRevision: () => revision,
    layer: Layer.succeed(SessionStore, service),
    service,
  };
};
export const createSessionFake = (
  initial: DomainSnapshot,
  frames: readonly Observation[] = []
) => {
  const receipts = new Map<
    string,
    {
      event: Parameters<SessionService["submit"]>[0]["event"];
      receipt: Effect.Success<ReturnType<SessionService["submit"]>>;
    }
  >();
  let snapshot = structuredClone(initial);
  let allowed = true;
  const authorize = (
    options: ReadOptions,
    context: Parameters<SessionService["inspect"]>[1]
  ) => {
    deadline(options);
    if (
      !allowed ||
      !isExecutionContextActiveAt(
        context,
        initial.address.organizationId,
        Date.now()
      )
    ) {
      throw new Denied({ code: "revoked", reason: "Current access denied" });
    }
  };
  const service: SessionService = {
    approve: (command, options) =>
      attempt(() => {
        authorize(options, command.context);
        const run = snapshot.runs.find(
          (value) => value.runId === command.runId
        );
        if (!run) {
          throw new NotFound({ resource: "run" });
        }
        return run;
      }),
    cancel: (command, options) =>
      attempt(() => {
        authorize(options, command.context);
        if (!snapshot.runs.some((value) => value.runId === command.runId)) {
          throw new NotFound({ resource: "run" });
        }
        const run = {
          endedAt: Date.now(),
          runId: command.runId,
          state: "cancelled",
        } as const;
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          runs: snapshot.runs.map((value) =>
            value.runId === command.runId ? run : value
          ),
        };
        return run;
      }),
    inspect: (_address, context, options) =>
      attempt(() => {
        authorize(options, context);
        return structuredClone(snapshot);
      }),
    stream: (_address, context, request, options) =>
      Stream.unwrap(
        attempt(() => {
          authorize(options, context);
          return Stream.fromIterable([
            {
              accessGeneration: request.accessGeneration,
              address: initial.address,
              epoch: "fixture-epoch",
              reason: "attach",
              schemaVersion: 1,
              sequence: 0,
              snapshot: structuredClone(snapshot),
              type: "snapshot",
            } as const,
            ...frames,
          ]);
        })
      ),
    submit: (command, options) =>
      attempt(() => {
        authorize(options, command.event.context);
        const prior = receipts.get(command.event.eventId);
        if (prior) {
          if (
            classifyEventDelivery(prior.event, command.event) !== "duplicate"
          ) {
            throw new Conflict({
              code: "digest-mismatch",
              reason: "Event changed",
            });
          }
          return { ...prior.receipt, replayed: true };
        }
        const runId = id.run(`run:${command.event.eventId}`);
        const receipt = {
          acceptedEventId: command.event.eventId,
          replayed: false,
          runId,
          sessionId: command.event.sessionId,
        };
        receipts.set(command.event.eventId, {
          event: structuredClone(command.event),
          receipt,
        });
        snapshot = {
          ...snapshot,
          revision: snapshot.revision + 1,
          runs: [...snapshot.runs, { runId, state: "queued" }],
        };
        return receipt;
      }),
  };
  return {
    layer: Layer.succeed(SessionService, service),
    service,
    setAllowed: (value: boolean) => {
      allowed = value;
    },
  };
};
