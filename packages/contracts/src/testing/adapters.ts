// oxlint-disable eslint/require-await -- Fixture ports keep state changes synchronous and expose the asynchronous port signatures.
import { classifyEventDelivery } from "../events.ts";
import type { EventAddress, EventEnvelope } from "../events.ts";
import { id, isExecutionContextActiveAt } from "../identity.ts";
import type {
  Digest,
  ExecutionContext,
  OperationId,
  PrincipalId,
  ReservationId,
} from "../identity.ts";
import type {
  ArtifactRef,
  ArtifactStore,
  MemoryRecord,
  MemoryStore,
  Visibility,
} from "../memory.ts";
import type {
  AuthorizationDecision,
  AuthorizationPolicy,
  BudgetAmount,
  BudgetAuthority,
  BudgetReservation,
  DecisionMaker,
  DecisionProposal,
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
import { canonicalToolArguments, toolCapabilityMatches } from "../tools.ts";
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
  readonly grantIdsByPrincipal?: ReadonlyMap<PrincipalId, ReadonlySet<string>>;
  readonly pauseOnSubmit?: boolean;
}

export interface FixtureAdapters {
  readonly agentRepository: AgentRepository;
  readonly artifactStore: ArtifactStore;
  readonly authorizationPolicy: AuthorizationPolicy;
  readonly entitlementPolicy: EntitlementPolicy;
  readonly budgetAuthority: BudgetAuthority;
  readonly decisionMaker: DecisionMaker;
  readonly toolExecutor: ToolExecutor;
  readonly sessionService: SessionService;
  readonly memoryStore: MemoryStore;
}

const requestKey = (...fields: readonly unknown[]): string =>
  canonicalToolArguments(fields);

const copyFixture = <T>(value: T): T => structuredClone(value);

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

const sameVisibility = (first: Visibility, second: Visibility): boolean => {
  if (first.kind === "organization") {
    return second.kind === "organization";
  }
  if (first.kind === "private") {
    return second.kind === "private" && first.ownerId === second.ownerId;
  }
  return second.kind === "grant" && first.grantId === second.grantId;
};

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

  const hasVisibilityGrant = (
    context: ExecutionContext,
    grantId: string
  ): boolean => {
    const grants = options.grantIdsByPrincipal;
    if (!grants?.get(context.actor.id)?.has(grantId)) {
      return false;
    }
    return (
      !context.represented ||
      grants.get(context.represented.id)?.has(grantId) === true
    );
  };

  const canReadVisibility = (
    context: ExecutionContext,
    visibility: Visibility
  ): boolean => {
    if (visibility.kind === "organization") {
      return true;
    }
    if (visibility.kind === "private") {
      return (
        visibility.ownerId === (context.represented?.id ?? context.actor.id)
      );
    }
    return hasVisibilityGrant(context, visibility.grantId);
  };

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
    readonly request: string;
    readonly result: PortResult<BudgetReservation>;
  }
  const budgetEffects = new Map<OperationId, BudgetEffect>();
  const reservations = new Map<ReservationId, BudgetReservation>();
  const budgetReplay = (
    kind: BudgetEffect["kind"],
    effect: EffectOptions,
    request: string
  ): PortResult<BudgetReservation> | undefined => {
    const prior = budgetEffects.get(effect.operationId);
    if (!prior) {
      return undefined;
    }
    return prior.kind === kind &&
      prior.digest === effect.requestDigest &&
      prior.request === request
      ? copyFixture(prior.result)
      : conflict("The operation ID already has a different request.");
  };
  const recordBudget = (
    kind: BudgetEffect["kind"],
    effect: EffectOptions,
    request: string,
    result: PortResult<BudgetReservation>
  ): PortResult<BudgetReservation> => {
    const snapshot = copyFixture(result);
    budgetEffects.set(effect.operationId, {
      digest: effect.requestDigest,
      kind,
      request,
      result: snapshot,
    });
    return copyFixture(snapshot);
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
      const request = requestKey(reservationId);
      const replay = budgetReplay("release", effect, request);
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
      reservations.set(reservationId, copyFixture(value));
      return recordBudget("release", effect, request, { status: "ok", value });
    },
    reserve: async (organizationId, maximum, effect) => {
      if (!Number.isFinite(maximum.units)) {
        return {
          reason:
            "A positive credit amount in the fixture organization is required.",
          status: "invalid-input",
        };
      }
      const request = requestKey(organizationId, maximum);
      const replay = budgetReplay("reserve", effect, request);
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
        return recordBudget("reserve", effect, request, {
          code: "budget-exhausted",
          reason: "No capacity remains for this organization.",
          status: "denied",
        });
      }
      availableUnits -= maximum.units;
      const reservation: BudgetReservation = {
        id: id.reservation(`reservation:${effect.operationId}`),
        maximum: Object.freeze(copyFixture(maximum)),
        operationId: effect.operationId,
        organizationId,
        state: "reserved",
      };
      reservations.set(reservation.id, copyFixture(reservation));
      return recordBudget("reserve", effect, request, {
        status: "ok",
        value: reservation,
      });
    },
    settle: async (reservationId, incurred, effect) => {
      if (!Number.isFinite(incurred.units)) {
        return {
          reason: "The incurred amount must be within the reservation.",
          status: "invalid-input",
        };
      }
      const request = requestKey(reservationId, incurred);
      const replay = budgetReplay("settle", effect, request);
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
      reservations.set(reservationId, copyFixture(value));
      return recordBudget("settle", effect, request, { status: "ok", value });
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
    {
      readonly digest: Digest;
      readonly request: string;
      readonly result: PortResult<AgentDefinition>;
    }
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
        ? { status: "ok", value: copyFixture(value) }
        : { resource: "agent version", status: "not-found" };
    },
    publish: async (definition, expectedVersion, effect) => {
      if (
        !Number.isFinite(definition.version) ||
        (expectedVersion !== undefined && !Number.isFinite(expectedVersion))
      ) {
        return {
          reason: "The agent version must be finite.",
          status: "invalid-input",
        };
      }
      const request = requestKey(definition, expectedVersion ?? null);
      const prior = publishedAgents.get(effect.operationId);
      if (prior) {
        return prior.digest === effect.requestDigest &&
          prior.request === request
          ? copyFixture(prior.result)
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
      const snapshot = copyFixture(definition);
      agentVersions.set(snapshot.version, snapshot);
      const result: PortResult<AgentDefinition> = {
        status: "ok",
        value: copyFixture(snapshot),
      };
      publishedAgents.set(effect.operationId, {
        digest: effect.requestDigest,
        request,
        result: copyFixture(result),
      });
      return result;
    },
  };

  const toolResults = new Map<
    OperationId,
    {
      readonly digest: Digest;
      readonly request: string;
      readonly result: PortResult<ToolExecution>;
    }
  >();
  const toolExecutor: ToolExecutor = {
    execute: async (call, capability, effect) => {
      if (
        !hasGrant(call.context, call.organizationId) ||
        !(await toolCapabilityMatches(capability, call, effect, now))
      ) {
        return denied("The tool capability does not authorize this call.");
      }
      const request = requestKey(call, capability);
      const prior = toolResults.get(effect.operationId);
      if (prior) {
        return prior.digest === effect.requestDigest &&
          prior.request === request
          ? copyFixture(prior.result)
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
                output: {
                  arguments: copyFixture(call.arguments),
                  toolId: call.tool.id,
                },
              },
            };
      toolResults.set(effect.operationId, {
        digest: effect.requestDigest,
        request,
        result: copyFixture(result),
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
        copyFixture(toolResults.get(operationId)?.result) ?? {
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
  type SessionOperationKind = "submit" | "approve" | "cancel";
  const sessionOperations = new Map<
    OperationId,
    {
      readonly kind: SessionOperationKind;
      readonly digest: Digest;
      readonly request: string;
    }
  >();
  const sessionOperationConflict = (
    kind: SessionOperationKind,
    effect: EffectOptions,
    request: string
  ): PortFailure | undefined => {
    const prior = sessionOperations.get(effect.operationId);
    if (
      prior &&
      (prior.kind !== kind ||
        prior.digest !== effect.requestDigest ||
        prior.request !== request)
    ) {
      return conflict(
        "The operation ID already has a different session command."
      );
    }
    return undefined;
  };
  const recordSessionOperation = (
    kind: SessionOperationKind,
    effect: EffectOptions,
    request: string
  ): void => {
    sessionOperations.set(effect.operationId, {
      digest: effect.requestDigest,
      kind,
      request,
    });
  };
  interface SessionStateEffect {
    readonly kind: "approve" | "cancel";
    readonly result: PortResult<RunState>;
  }
  const sessionStateEffects = new Map<OperationId, SessionStateEffect>();
  const stateReplay = (
    kind: SessionStateEffect["kind"],
    effect: EffectOptions,
    request: string
  ): PortResult<RunState> | undefined => {
    const collision = sessionOperationConflict(kind, effect, request);
    if (collision) {
      return collision;
    }
    return copyFixture(sessionStateEffects.get(effect.operationId)?.result);
  };
  const recordState = (
    kind: SessionStateEffect["kind"],
    effect: EffectOptions,
    request: string,
    result: PortResult<RunState>
  ): PortResult<RunState> => {
    recordSessionOperation(kind, effect, request);
    sessionStateEffects.set(effect.operationId, {
      kind,
      result: copyFixture(result),
    });
    return copyFixture(result);
  };
  const sessionService: SessionService = {
    approve: async (command, effect) => {
      const request = requestKey(command);
      if (!hasGrant(command.context, command.address.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const replay = stateReplay("approve", effect, request);
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
      runs.set(runId, copyFixture(state));
      return recordState("approve", effect, request, {
        status: "ok",
        value: state,
      });
    },
    cancel: async (command, effect) => {
      const request = requestKey(command);
      if (!hasGrant(command.context, command.address.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const replay = stateReplay("cancel", effect, request);
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
      runs.set(command.runId, copyFixture(state));
      return recordState("cancel", effect, request, {
        status: "ok",
        value: state,
      });
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
        .filter((run): run is RunState => run !== undefined)
        .map((run) => copyFixture(run));
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
      let request: string;
      try {
        request = requestKey(command);
      } catch (error) {
        if (error instanceof TypeError) {
          return {
            reason: "The session event must contain JSON data.",
            status: "invalid-input",
          };
        }
        throw error;
      }
      if (!hasGrant(event.context, event.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const collision = sessionOperationConflict("submit", effect, request);
      if (collision) {
        return collision;
      }
      const prior = submitted.get(event.eventId);
      const delivery = classifyEventDelivery(prior?.event, event);
      if (
        delivery === "conflict" ||
        (prior &&
          requestKey({ event: prior.event, type: "submit" }) !== request)
      ) {
        return conflict("The event ID already has a different envelope.");
      }
      if (delivery === "duplicate" && prior) {
        recordSessionOperation("submit", effect, request);
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
      runs.set(runId, copyFixture(state));
      submitted.set(event.eventId, {
        event: copyFixture(event),
        receipt: copyFixture(receipt),
      });
      recordSessionOperation("submit", effect, request);
      return { status: "ok", value: receipt };
    },
  };

  const records = new Map<string, MemoryRecord>();
  type MemoryEffect =
    | {
        readonly kind: "remember";
        readonly digest: Digest;
        readonly request: string;
        readonly result: PortResult<MemoryRecord>;
      }
    | {
        readonly kind: "forget";
        readonly digest: Digest;
        readonly request: string;
        readonly result: PortResult<{ readonly removed: number }>;
      };
  const memoryEffects = new Map<OperationId, MemoryEffect>();
  const memoryStore: MemoryStore = {
    forget: async (scope, sourceId, effect) => {
      const request = requestKey(scope, sourceId);
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const prior = memoryEffects.get(effect.operationId);
      if (prior) {
        return prior.kind === "forget" &&
          prior.digest === effect.requestDigest &&
          prior.request === request
          ? copyFixture(prior.result)
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
        request,
        result: copyFixture(result),
      });
      return result;
    },
    remember: async (scope, record, effect) => {
      const request = requestKey(scope, record);
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const prior = memoryEffects.get(effect.operationId);
      if (prior) {
        return prior.kind === "remember" &&
          prior.digest === effect.requestDigest &&
          prior.request === request
          ? copyFixture(prior.result)
          : conflict("The operation ID already has a different memory effect.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const snapshot = copyFixture(record);
      records.set(snapshot.id, snapshot);
      const result: PortResult<MemoryRecord> = {
        status: "ok",
        value: copyFixture(snapshot),
      };
      memoryEffects.set(effect.operationId, {
        digest: effect.requestDigest,
        kind: "remember",
        request,
        result: copyFixture(result),
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
            canReadVisibility(query.context, record.visibility)
        )
        .slice(0, query.limit)
        .map((record) => ({
          citation: copyFixture(record.provenance),
          record: copyFixture(record),
        }));
      return { status: "ok", value: hits };
    },
  };

  interface ArtifactEntry {
    readonly ref: ArtifactRef;
    readonly bytes: Uint8Array;
  }
  const artifacts = new Map<ArtifactRef["artifactId"], ArtifactEntry>();
  const artifactPuts = new Map<
    OperationId,
    {
      readonly digest: Digest;
      readonly request: string;
      readonly entry: ArtifactEntry;
    }
  >();
  const artifactDeletes = new Map<
    OperationId,
    { readonly digest: Digest; readonly request: string }
  >();
  const artifactStore: ArtifactStore = {
    delete: async (scope, ref, effect) => {
      const request = requestKey(scope, ref);
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const prior = artifactDeletes.get(effect.operationId);
      if (prior) {
        return prior.digest === effect.requestDigest &&
          prior.request === request
          ? { status: "ok", value: undefined }
          : conflict(
              "The operation ID already has a different artifact delete."
            );
      }
      if (artifactPuts.has(effect.operationId)) {
        return conflict("The operation ID already identifies a put.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const entry = artifacts.get(ref.artifactId);
      if (!entry || entry.ref.organizationId !== scope.organizationId) {
        return { resource: "artifact", status: "not-found" };
      }
      if (!canReadVisibility(scope.context, entry.ref.visibility)) {
        return denied("The principal cannot delete this artifact.");
      }
      artifacts.delete(ref.artifactId);
      artifactDeletes.set(effect.operationId, {
        digest: effect.requestDigest,
        request,
      });
      return { status: "ok", value: undefined };
    },
    put: async (scope, bytes, metadata, effect) => {
      const request = requestKey(scope, [...bytes], metadata);
      if (
        !hasGrant(scope.context, scope.organizationId) ||
        !canReadVisibility(scope.context, metadata.visibility)
      ) {
        return denied("The principal cannot write this artifact.");
      }
      if (metadata.organizationId !== scope.organizationId) {
        return {
          reason: "Artifact organization does not match scope.",
          status: "invalid-input",
        };
      }
      const prior = artifactPuts.get(effect.operationId);
      if (prior) {
        const sameBytes =
          prior.entry.bytes.length === bytes.length &&
          prior.entry.bytes.every((byte, index) => byte === bytes[index]);
        return prior.digest === effect.requestDigest &&
          prior.request === request &&
          sameBytes &&
          prior.entry.ref.organizationId === metadata.organizationId &&
          prior.entry.ref.provenance.sourceId ===
            metadata.provenance.sourceId &&
          prior.entry.ref.provenance.sourceVersion ===
            metadata.provenance.sourceVersion &&
          prior.entry.ref.provenance.sourceUri ===
            metadata.provenance.sourceUri &&
          prior.entry.ref.provenance.observedAt ===
            metadata.provenance.observedAt &&
          sameVisibility(prior.entry.ref.visibility, metadata.visibility)
          ? { status: "ok", value: copyFixture(prior.entry.ref) }
          : conflict("The operation ID already has a different artifact.");
      }
      if (artifactDeletes.has(effect.operationId)) {
        return conflict("The operation ID already identifies a delete.");
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      const ref: ArtifactRef = copyFixture({
        ...metadata,
        artifactId: id.artifact(`artifact:${effect.operationId}`),
      });
      const entry: ArtifactEntry = { bytes: new Uint8Array(bytes), ref };
      artifacts.set(ref.artifactId, entry);
      artifactPuts.set(effect.operationId, {
        digest: effect.requestDigest,
        entry,
        request,
      });
      return { status: "ok", value: copyFixture(ref) };
    },
    read: async (scope, ref, readOptions) => {
      const failure = readFailure(readOptions, now);
      if (failure) {
        return failure;
      }
      if (!hasGrant(scope.context, scope.organizationId)) {
        return denied("The principal has no current grant.");
      }
      const entry = artifacts.get(ref.artifactId);
      if (!entry || entry.ref.organizationId !== scope.organizationId) {
        return { resource: "artifact", status: "not-found" };
      }
      if (!canReadVisibility(scope.context, entry.ref.visibility)) {
        return denied("The principal cannot read this artifact.");
      }
      return { status: "ok", value: new Uint8Array(entry.bytes) };
    },
  };

  const decisions = new Map<
    OperationId,
    {
      readonly digest: Digest;
      readonly request: string;
      readonly result: PortResult<DecisionProposal>;
    }
  >();
  const decisionMaker: DecisionMaker = {
    propose: async (request, effect) => {
      const decisionRequest = requestKey(request);
      const prior = decisions.get(effect.operationId);
      if (prior) {
        return prior.digest === effect.requestDigest &&
          prior.request === decisionRequest
          ? copyFixture(prior.result)
          : conflict(
              "The operation ID already has a different decision request."
            );
      }
      const failure = effectFailure(effect, now);
      if (failure) {
        return failure;
      }
      if (
        request.organizationId !== fixtureOrganizationId ||
        request.allowedChoices.length === 0
      ) {
        return {
          reason:
            "A fixture organization and at least one choice are required.",
          status: "invalid-input",
        };
      }
      const [choice] = request.allowedChoices;
      if (!choice) {
        return {
          reason: "A decision choice is required.",
          status: "invalid-input",
        };
      }
      const result: PortResult<DecisionProposal> = {
        status: "ok",
        value: {
          choice,
          inputDigest: request.inputDigest,
          modelVersion: request.modelVersion,
          usage: { unit: "credits", units: 0 },
        },
      };
      decisions.set(effect.operationId, {
        digest: effect.requestDigest,
        request: decisionRequest,
        result: copyFixture(result),
      });
      return result;
    },
  };

  return {
    agentRepository,
    artifactStore,
    authorizationPolicy,
    budgetAuthority,
    decisionMaker,
    entitlementPolicy,
    memoryStore,
    sessionService,
    toolExecutor,
  };
};
