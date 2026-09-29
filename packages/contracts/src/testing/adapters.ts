// oxlint-disable eslint/require-await -- Fixture ports keep state changes synchronous and expose the asynchronous port signatures.
import { classifyEventDelivery } from "../events.ts";
import type { EventAddress, EventEnvelope } from "../events.ts";
import { id, isExecutionContextActiveAt } from "../identity.ts";
import type {
  Digest,
  ExecutionContext,
  OperationId,
  ReservationId,
} from "../identity.ts";
import type { MemoryRecord, MemoryStore } from "../memory.ts";
import type {
  AuthorizationDecision,
  AuthorizationPolicy,
  BudgetAmount,
  BudgetAuthority,
  BudgetReservation,
  EntitlementDecision,
  EntitlementPolicy,
} from "../policy.ts";
import { preflightEffect } from "../port.ts";
import type { EffectOptions, PortResult, ReadOptions } from "../port.ts";
import type {
  AgentDefinition,
  AgentRepository,
  RunState,
  SessionReceipt,
  SessionService,
  SessionSnapshot,
} from "../session.ts";
import { toolCapabilityMatches } from "../tools.ts";
import type { ToolExecution, ToolExecutor } from "../tools.ts";
import {
  allowedUser,
  fixtureAgentId,
  fixtureOrganizationId,
  serviceActor,
  unknownToolOutcome,
  unknownOutcomeInvocation,
} from "./fixtures.ts";

type PortFailure = Exclude<PortResult<never>, { readonly status: "ok" }>;

export interface FixtureOptions {
  readonly mode: "fixture" | "production";
  readonly now?: number;
  readonly budgetUnits?: number;
  readonly pauseOnSubmit?: boolean;
}

export interface FixtureAdapters {
  readonly agentRepository: AgentRepository;
  readonly authorizationPolicy: AuthorizationPolicy;
  readonly entitlementPolicy: EntitlementPolicy;
  readonly budgetAuthority: BudgetAuthority;
  readonly toolExecutor: ToolExecutor;
  readonly sessionService: SessionService;
  readonly memoryStore: MemoryStore;
}

const conflict = (reason: string): PortFailure => ({
  code: "digest-mismatch",
  reason,
  status: "conflict",
});

const denied = (reason: string): PortFailure => ({
  code: "unauthorized",
  reason,
  status: "denied",
});

const readFailure = (
  options: ReadOptions,
  now: number
): PortFailure | undefined => {
  if (options.signal?.aborted) {
    return {
      code: "cancelled",
      reason: "The caller cancelled the operation.",
      status: "unavailable",
    };
  }
  if (!Number.isFinite(options.deadlineAt) || options.deadlineAt <= now) {
    return {
      code: "deadline-exceeded",
      reason: "The operation deadline has passed.",
      status: "unavailable",
    };
  }
  return undefined;
};

const effectFailure = (
  options: EffectOptions,
  now: number
): PortFailure | undefined => {
  const result = preflightEffect(options, now);
  return result.status === "ok" ? undefined : result;
};

const sameAddress = (first: EventAddress, second: EventAddress): boolean =>
  first.organizationId === second.organizationId &&
  first.agentId === second.agentId &&
  first.conversationId === second.conversationId &&
  first.sessionId === second.sessionId;

export const createFixtureAdapters = (
  options: FixtureOptions
): FixtureAdapters => {
  if (options.mode !== "fixture") {
    throw new Error("Fixture adapters cannot run in production mode.");
  }

  const now = options.now ?? 1_800_000_000_000;
  let availableUnits = options.budgetUnits ?? 10;
  if (!Number.isSafeInteger(availableUnits) || availableUnits < 0) {
    throw new Error("Fixture budget units must be a nonnegative integer.");
  }
  const allowedPrincipalIds = new Set([allowedUser.id, serviceActor.id]);
  const hasGrant = (
    context: ExecutionContext,
    organizationId: typeof fixtureOrganizationId
  ): boolean =>
    isExecutionContextActiveAt(context, organizationId, now) &&
    allowedPrincipalIds.has(context.actor.id) &&
    (!context.represented || allowedPrincipalIds.has(context.represented.id));

  const authorizationPolicy: AuthorizationPolicy = {
    evaluate: async (context, _action, resource, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      const value: AuthorizationDecision = hasGrant(
        context,
        resource.organizationId
      )
        ? { decision: "allow", policyVersion: "fixture-v1" }
        : {
            decision: "deny",
            policyVersion: "fixture-v1",
            reason: "The principal has no current grant.",
          };
      return { status: "ok", value };
    },
  };

  const entitlementPolicy: EntitlementPolicy = {
    check: async (request, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      const allowed =
        request.organizationId === fixtureOrganizationId &&
        request.agentId === fixtureAgentId &&
        request.capability === "fixture-capability";
      const value: EntitlementDecision = allowed
        ? { decision: "allow", policyVersion: "fixture-v1" }
        : {
            decision: "deny",
            policyVersion: "fixture-v1",
            reason: "The capability is not enabled.",
          };
      return { status: "ok", value };
    },
  };

  interface BudgetEffect {
    readonly kind: "reserve" | "settle" | "release";
    readonly digest: Digest;
    readonly result: PortResult<BudgetReservation>;
  }
  const budgetEffects = new Map<OperationId, BudgetEffect>();
  const reservations = new Map<ReservationId, BudgetReservation>();
  const budgetReplay = (
    kind: BudgetEffect["kind"],
    effect: EffectOptions
  ): PortResult<BudgetReservation> | undefined => {
    const prior = budgetEffects.get(effect.operationId);
    if (!prior) {
      return undefined;
    }
    return prior.kind === kind && prior.digest === effect.requestDigest
      ? prior.result
      : conflict("The operation ID already has a different request.");
  };
  const recordBudget = (
    kind: BudgetEffect["kind"],
    effect: EffectOptions,
    result: PortResult<BudgetReservation>
  ): PortResult<BudgetReservation> => {
    budgetEffects.set(effect.operationId, {
      digest: effect.requestDigest,
      kind,
      result,
    });
    return result;
  };
  const budgetAuthority: BudgetAuthority = {
    inspect: async (organizationId, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (organizationId !== fixtureOrganizationId) {
        return { resource: "budget", status: "not-found" };
      }
      const value: BudgetAmount = { unit: "credits", units: availableUnits };
      return { status: "ok", value };
    },
    release: async (reservationId, effect) => {
      const replay = budgetReplay("release", effect);
      if (replay) {
        return replay;
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const prior = reservations.get(reservationId);
      if (!prior) {
        return { resource: "reservation", status: "not-found" };
      }
      if (prior.state !== "reserved") {
        return {
          code: "already-final",
          reason: "The reservation is final.",
          status: "conflict",
        };
      }
      availableUnits += prior.maximum.units;
      const value: BudgetReservation = { ...prior, state: "released" };
      reservations.set(reservationId, value);
      return recordBudget("release", effect, { status: "ok", value });
    },
    reserve: async (organizationId, maximum, effect) => {
      const replay = budgetReplay("reserve", effect);
      if (replay) {
        return replay;
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      if (
        organizationId !== fixtureOrganizationId ||
        maximum.unit !== "credits" ||
        !Number.isSafeInteger(maximum.units) ||
        maximum.units <= 0
      ) {
        return {
          reason:
            "A positive credit amount in the fixture organization is required.",
          status: "invalid-input",
        };
      }
      if (maximum.units > availableUnits) {
        return recordBudget("reserve", effect, {
          code: "budget-exhausted",
          reason: "No capacity remains for this organization.",
          status: "denied",
        });
      }
      availableUnits -= maximum.units;
      const reservation: BudgetReservation = {
        id: id.reservation(`reservation:${effect.operationId}`),
        maximum,
        operationId: effect.operationId,
        organizationId,
        state: "reserved",
      };
      reservations.set(reservation.id, reservation);
      return recordBudget("reserve", effect, {
        status: "ok",
        value: reservation,
      });
    },
    settle: async (reservationId, incurred, effect) => {
      const replay = budgetReplay("settle", effect);
      if (replay) {
        return replay;
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const prior = reservations.get(reservationId);
      if (!prior) {
        return { resource: "reservation", status: "not-found" };
      }
      if (prior.state !== "reserved") {
        return {
          code: "already-final",
          reason: "The reservation is final.",
          status: "conflict",
        };
      }
      if (
        incurred.unit !== prior.maximum.unit ||
        !Number.isSafeInteger(incurred.units) ||
        incurred.units < 0 ||
        incurred.units > prior.maximum.units
      ) {
        return {
          reason: "The incurred amount must be within the reservation.",
          status: "invalid-input",
        };
      }
      availableUnits += prior.maximum.units - incurred.units;
      const value: BudgetReservation = { ...prior, state: "settled" };
      reservations.set(reservationId, value);
      return recordBudget("settle", effect, { status: "ok", value });
    },
  };

  const agentVersions = new Map<number, AgentDefinition>([
    [
      1,
      {
        agentId: fixtureAgentId,
        enabledToolIds: ["tool-1"],
        grants: [
          {
            action: "execute",
            resource: {
              id: "tool-1",
              kind: "tool",
              organizationId: fixtureOrganizationId,
            },
          },
        ],
        instructions: "Use the fixture tools.",
        model: "fixture-model",
        organizationId: fixtureOrganizationId,
        version: 1,
      },
    ],
  ]);
  const publishedAgents = new Map<
    OperationId,
    { readonly digest: Digest; readonly result: PortResult<AgentDefinition> }
  >();
  const agentRepository: AgentRepository = {
    get: async (organizationId, agentId, version, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (
        organizationId !== fixtureOrganizationId ||
        agentId !== fixtureAgentId
      ) {
        return { resource: "agent", status: "not-found" };
      }
      const selected =
        version === "latest" ? Math.max(...agentVersions.keys()) : version;
      const value = agentVersions.get(selected);
      return value
        ? { status: "ok", value }
        : { resource: "agent version", status: "not-found" };
    },
    publish: async (definition, expectedVersion, effect) => {
      const prior = publishedAgents.get(effect.operationId);
      if (prior) {
        return prior.digest === effect.requestDigest
          ? prior.result
          : conflict(
              "The operation ID already has a different agent definition."
            );
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      if (
        definition.organizationId !== fixtureOrganizationId ||
        definition.agentId !== fixtureAgentId
      ) {
        return {
          reason: "The agent is outside the fixture organization.",
          status: "invalid-input",
        };
      }
      const latest = Math.max(...agentVersions.keys());
      if (expectedVersion !== latest || definition.version !== latest + 1) {
        return {
          code: "version-mismatch",
          reason: "The expected agent version is stale.",
          status: "conflict",
        };
      }
      agentVersions.set(definition.version, definition);
      const result: PortResult<AgentDefinition> = {
        status: "ok",
        value: definition,
      };
      publishedAgents.set(effect.operationId, {
        digest: effect.requestDigest,
        result,
      });
      return result;
    },
  };

  const toolResults = new Map<
    OperationId,
    { readonly digest: Digest; readonly result: PortResult<ToolExecution> }
  >();
  const toolExecutor: ToolExecutor = {
    execute: async (call, capability, effect) => {
      if (
        !hasGrant(call.context, call.organizationId) ||
        !toolCapabilityMatches(capability, call, effect, now)
      ) {
        return denied("The tool capability does not authorize this call.");
      }
      const prior = toolResults.get(effect.operationId);
      if (prior) {
        return prior.digest === effect.requestDigest
          ? prior.result
          : conflict("The operation ID already has different tool arguments.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const result: PortResult<ToolExecution> =
        effect.operationId === unknownOutcomeInvocation.operationId
          ? unknownToolOutcome
          : {
              status: "ok",
              value: {
                output: { arguments: call.arguments, toolId: call.tool.id },
              },
            };
      toolResults.set(effect.operationId, {
        digest: effect.requestDigest,
        result,
      });
      return result;
    },
    reconcile: async (operationId, context, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (!hasGrant(context, fixtureOrganizationId)) {
        return denied("The principal has no current grant.");
      }
      return (
        toolResults.get(operationId)?.result ?? {
          resource: "tool operation",
          status: "not-found",
        }
      );
    },
  };

  const submitted = new Map<
    EventEnvelope["eventId"],
    { readonly event: EventEnvelope; readonly receipt: SessionReceipt }
  >();
  const runs = new Map<SessionReceipt["runId"], RunState>();
  const submitOperations = new Map<
    OperationId,
    { readonly digest: Digest; readonly eventId: EventEnvelope["eventId"] }
  >();
  interface SessionStateEffect {
    readonly kind: "approve" | "cancel";
    readonly digest: Digest;
    readonly result: PortResult<RunState>;
  }
  const sessionStateEffects = new Map<OperationId, SessionStateEffect>();
  const stateReplay = (
    kind: SessionStateEffect["kind"],
    effect: EffectOptions
  ): PortResult<RunState> | undefined => {
    const prior = sessionStateEffects.get(effect.operationId);
    if (!prior) {
      return undefined;
    }
    return prior.kind === kind && prior.digest === effect.requestDigest
      ? prior.result
      : conflict("The operation ID already has a different session command.");
  };
  const recordState = (
    kind: SessionStateEffect["kind"],
    effect: EffectOptions,
    result: PortResult<RunState>
  ): PortResult<RunState> => {
    sessionStateEffects.set(effect.operationId, {
      digest: effect.requestDigest,
      kind,
      result,
    });
    return result;
  };
  const sessionService: SessionService = {
    approve: async (command, effect) => {
      if (!hasGrant(command.context, command.address.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const replay = stateReplay("approve", effect);
      if (replay) {
        return replay;
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const found = [...submitted.values()].find(
        ({ event }) =>
          sameAddress(event, command.address) &&
          runs.get(id.run(`run:${event.eventId}`))?.state ===
            "waiting-for-approval"
      );
      if (!found) {
        return { resource: "approval", status: "not-found" };
      }
      const { runId } = found.receipt;
      if (command.approvalId !== `approval:${runId}`) {
        return { resource: "approval", status: "not-found" };
      }
      const state: RunState = { completedAt: now, runId, state: "completed" };
      runs.set(runId, state);
      return recordState("approve", effect, { status: "ok", value: state });
    },
    cancel: async (command, effect) => {
      if (!hasGrant(command.context, command.address.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const replay = stateReplay("cancel", effect);
      if (replay) {
        return replay;
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const run = runs.get(command.runId);
      const owned = [...submitted.values()].some(
        ({ event, receipt }) =>
          receipt.runId === command.runId && sameAddress(event, command.address)
      );
      if (!run || !owned) {
        return { resource: "run", status: "not-found" };
      }
      if (
        run.state === "completed" ||
        run.state === "failed" ||
        run.state === "cancelled"
      ) {
        return {
          code: "already-final",
          reason: "The run is final.",
          status: "conflict",
        };
      }
      const state: RunState = {
        endedAt: now,
        runId: command.runId,
        state: "cancelled",
      };
      runs.set(command.runId, state);
      return recordState("cancel", effect, { status: "ok", value: state });
    },
    inspect: async (address, context, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (!hasGrant(context, address.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const found = [...submitted.values()].find(({ event }) =>
        sameAddress(event, address)
      );
      if (!found) {
        return { resource: "session", status: "not-found" };
      }
      const sessionRuns = [...submitted.values()]
        .filter(({ event }) => sameAddress(event, address))
        .map(({ receipt }) => runs.get(receipt.runId))
        .filter((run): run is RunState => run !== undefined);
      const value: SessionSnapshot = {
        address,
        agentVersion: 1,
        cursor: String(sessionRuns.length),
        runs: sessionRuns,
      };
      return { status: "ok", value };
    },
    async *stream(address, context, cursor, readOptions) {
      const inspected = await sessionService.inspect(
        address,
        context,
        readOptions
      );
      if (inspected.status !== "ok") {
        yield inspected;
        return;
      }
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        yield {
          reason: "The stream cursor is invalid.",
          status: "invalid-input",
        };
        return;
      }
      for (const [index, run] of inspected.value.runs.entries()) {
        if (index < offset) {
          continue;
        }
        yield {
          status: "ok",
          value: { cursor: String(index + 1), run, type: "run" },
        };
      }
    },
    submit: async (command, effect) => {
      const { event } = command;
      if (!hasGrant(event.context, event.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const priorOperation = submitOperations.get(effect.operationId);
      if (
        priorOperation &&
        (priorOperation.digest !== effect.requestDigest ||
          priorOperation.eventId !== event.eventId)
      ) {
        return conflict("The operation ID already has a different event.");
      }
      const prior = submitted.get(event.eventId);
      const delivery = classifyEventDelivery(prior?.event, event);
      if (delivery === "conflict") {
        return conflict("The event ID already has a different envelope.");
      }
      if (delivery === "duplicate" && prior) {
        return { status: "ok", value: { ...prior.receipt, replayed: true } };
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const runId = id.run(`run:${event.eventId}`);
      const receipt: SessionReceipt = {
        acceptedEventId: event.eventId,
        replayed: false,
        runId,
        sessionId: event.sessionId,
      };
      const state: RunState = {
        runId,
        state: options.pauseOnSubmit ? "waiting-for-approval" : "queued",
      };
      runs.set(runId, state);
      submitted.set(event.eventId, { event, receipt });
      submitOperations.set(effect.operationId, {
        digest: effect.requestDigest,
        eventId: event.eventId,
      });
      return { status: "ok", value: receipt };
    },
  };

  const records = new Map<string, MemoryRecord>();
  type MemoryEffect =
    | {
        readonly kind: "remember";
        readonly digest: Digest;
        readonly result: PortResult<MemoryRecord>;
      }
    | {
        readonly kind: "forget";
        readonly digest: Digest;
        readonly result: PortResult<{ readonly removed: number }>;
      };
  const memoryEffects = new Map<OperationId, MemoryEffect>();
  const memoryStore: MemoryStore = {
    forget: async (scope, sourceId, effect) => {
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const prior = memoryEffects.get(effect.operationId);
      if (prior) {
        return prior.kind === "forget" && prior.digest === effect.requestDigest
          ? prior.result
          : conflict("The operation ID already has a different memory effect.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      let removed = 0;
      for (const [recordId, record] of records) {
        if (
          record.provenance.sourceId === sourceId ||
          (record.kind === "conversation-summary" &&
            record.dependentSourceIds.includes(sourceId))
        ) {
          records.delete(recordId);
          removed += 1;
        }
      }
      const result: PortResult<{ readonly removed: number }> = {
        status: "ok",
        value: { removed },
      };
      memoryEffects.set(effect.operationId, {
        digest: effect.requestDigest,
        kind: "forget",
        result,
      });
      return result;
    },
    remember: async (scope, record, effect) => {
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const prior = memoryEffects.get(effect.operationId);
      if (prior) {
        return prior.kind === "remember" &&
          prior.digest === effect.requestDigest
          ? prior.result
          : conflict("The operation ID already has a different memory effect.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      records.set(record.id, record);
      const result: PortResult<MemoryRecord> = { status: "ok", value: record };
      memoryEffects.set(effect.operationId, {
        digest: effect.requestDigest,
        kind: "remember",
        result,
      });
      return result;
    },
    retrieve: async (query, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (!hasGrant(query.context, query.organizationId)) {
        return denied("The principal has no current grant.");
      }
      if (!Number.isSafeInteger(query.limit) || query.limit < 0) {
        return {
          reason: "The memory limit must be a nonnegative integer.",
          status: "invalid-input",
        };
      }
      const search = query.text.toLowerCase();
      const hits = [...records.values()]
        .filter(
          (record) =>
            record.text.toLowerCase().includes(search) &&
            (record.visibility.kind === "organization" ||
              (record.visibility.kind === "private" &&
                record.visibility.ownerId ===
                  (query.context.represented?.id ?? query.context.actor.id)))
        )
        .slice(0, query.limit)
        .map((record) => ({ citation: record.provenance, record }));
      return { status: "ok", value: hits };
    },
  };

  return {
    agentRepository,
    authorizationPolicy,
    budgetAuthority,
    entitlementPolicy,
    memoryStore,
    sessionService,
    toolExecutor,
  };
};
