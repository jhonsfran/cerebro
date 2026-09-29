import { Unprice } from "@unprice/api";
import type { ApiResult } from "@unprice/api";

import { id } from "../../contracts/src/identity.ts";
import type {
  OrganizationId,
  ReservationId,
} from "../../contracts/src/identity.ts";
import type {
  BudgetAmount,
  BudgetAuthority,
  BudgetReservation,
  EntitlementPolicy,
} from "../../contracts/src/policy.ts";
import { preflightEffect } from "../../contracts/src/port.ts";
import type {
  EffectOptions,
  PortResult,
  ReadOptions,
} from "../../contracts/src/port.ts";
import {
  canonicalInput,
  immutable,
  validAmount,
} from "../../db/src/repositories/usage.ts";
import type { UsageRepository } from "../../db/src/repositories/usage.ts";

type Run = NonNullable<Awaited<ReturnType<Unprice["runs"]["start"]>>["result"]>;
type Settlement = NonNullable<
  Awaited<ReturnType<Unprice["runs"]["settle"]>>["result"]
>;
type SettlementInput = Parameters<Unprice["runs"]["settle"]>[0];
interface ReserveIntent {
  readonly organizationId: OrganizationId;
  readonly maximum: BudgetAmount;
  readonly operationId: string;
  readonly digest: string;
  readonly customerId: string;
  readonly currency: "USD" | "EUR";
  readonly maximumMinor: number;
  readonly mapping: {
    readonly unit: string;
    readonly minorPerUnit: number;
    readonly featureSlug: string;
    readonly eventSlug: string;
    readonly version: string;
  };
}
interface Command {
  readonly kind: "settle" | "release";
  readonly operationId: string;
  readonly digest: string;
  readonly incurred: BudgetAmount;
  readonly outcome: "completed" | "failed";
  readonly input: unknown;
  readonly wire: SettlementInput;
}
type RemoteState =
  | { readonly phase: "start-intent"; readonly intent: ReserveIntent }
  | { readonly phase: "start-unknown"; readonly intent: ReserveIntent }
  | {
      readonly phase: "start-denied";
      readonly intent: ReserveIntent;
      readonly result: PortResult<BudgetReservation>;
    }
  | {
      readonly phase: "reserved";
      readonly intent: ReserveIntent;
      readonly run: Run;
    }
  | {
      readonly phase: "settlement-intent";
      readonly intent: ReserveIntent;
      readonly run: Run;
      readonly command: Command;
    }
  | {
      readonly phase: "settlement-recorded";
      readonly intent: ReserveIntent;
      readonly run: Run;
      readonly command: Command;
      readonly receipt: Settlement | null;
    }
  | {
      readonly phase: "end-intent";
      readonly intent: ReserveIntent;
      readonly run: Run;
      readonly command: Command;
      readonly receipt: Settlement | null;
    }
  | {
      readonly phase: "settled";
      readonly intent: ReserveIntent;
      readonly run: Run;
      readonly command: Command;
      readonly result: PortResult<BudgetReservation>;
    }
  | {
      readonly phase: "released";
      readonly intent: ReserveIntent;
      readonly run: Run;
      readonly command: Command;
      readonly result: PortResult<BudgetReservation>;
    };

export interface UnpriceCompanyMapping {
  readonly customerId: string;
  readonly currency: "USD" | "EUR";
  readonly unit: string;
  readonly minorPerUnit: number;
  readonly featureSlugs: Readonly<Record<string, string>>;
  readonly meter: {
    readonly featureSlug: string;
    readonly version: string;
    readonly eventSlug: string;
    readonly verified: true;
    readonly properties: (
      incurred: BudgetAmount
    ) => Readonly<Record<string, unknown>>;
  };
}
export interface UnpriceConfiguration {
  readonly token: string;
  readonly companies: Readonly<Record<string, UnpriceCompanyMapping>>;
  readonly fetch?: (input: Request) => Promise<Response>;
}
const unpack = <Value>(response: ApiResult<Value>): Value => {
  if (response.error || response.result === undefined) {
    throw new Error("Unprice did not return an authoritative receipt.");
  }
  return response.result;
};
const mappingValid = (
  mapping: UnpriceCompanyMapping | undefined
): mapping is UnpriceCompanyMapping =>
  Boolean(
    mapping &&
    mapping.customerId &&
    ["USD", "EUR"].includes(mapping.currency) &&
    mapping.unit &&
    Number.isSafeInteger(mapping.minorPerUnit) &&
    mapping.minorPerUnit > 0 &&
    mapping.meter.verified === true &&
    mapping.meter.featureSlug &&
    mapping.meter.eventSlug &&
    mapping.meter.version
  );
const minor = (
  amount: BudgetAmount,
  mapping: UnpriceCompanyMapping
): number | undefined => {
  const converted = amount.units * mapping.minorPerUnit;
  return validAmount(amount) &&
    amount.unit === mapping.unit &&
    Number.isSafeInteger(converted)
    ? converted
    : undefined;
};
const mappingIdentity = (mapping: UnpriceCompanyMapping) => ({
  eventSlug: mapping.meter.eventSlug,
  featureSlug: mapping.meter.featureSlug,
  minorPerUnit: mapping.minorPerUnit,
  unit: mapping.unit,
  version: mapping.meter.version,
});
const mappingMatches = (
  mapping: UnpriceCompanyMapping,
  intent: ReserveIntent
): boolean =>
  mapping.customerId === intent.customerId &&
  mapping.currency === intent.currency &&
  canonicalInput(intent.mapping) === canonicalInput(mappingIdentity(mapping));
const runValid = (run: Run, intent: ReserveIntent): boolean =>
  typeof run.runId === "string" &&
  run.runId.length > 0 &&
  run.customerId === intent.customerId &&
  run.currency === intent.currency &&
  run.budgetAmountMinor === intent.maximumMinor &&
  Number.isSafeInteger(run.consumedAmountMinor) &&
  run.consumedAmountMinor >= 0 &&
  Number.isSafeInteger(run.remainingAmountMinor) &&
  run.remainingAmountMinor >= 0 &&
  run.consumedAmountMinor + run.remainingAmountMinor === intent.maximumMinor;
const startRunValid = (run: Run, intent: ReserveIntent): boolean =>
  runValid(run, intent) &&
  run.status === "running" &&
  run.consumedAmountMinor === 0 &&
  run.remainingAmountMinor === intent.maximumMinor;
const startBudgetDenied = (run: Run, intent: ReserveIntent): boolean =>
  runValid(run, intent) && run.status === "budget_exceeded";
const projection = (
  state: RemoteState,
  status: BudgetReservation["state"]
): BudgetReservation =>
  immutable({
    id: id.reservation(`unprice:${state.intent.operationId}`),
    maximum: state.intent.maximum,
    operationId: id.operation(state.intent.operationId),
    organizationId: state.intent.organizationId,
    state: status,
  });
const unknown = (
  options: EffectOptions,
  reason: string
): PortResult<never> => ({
  operationId: options.operationId,
  reason,
  status: "unknown-outcome",
});
const mismatch = (): PortResult<never> => ({
  code: "digest-mismatch",
  reason: "Remote operation intent differs from its saved command.",
  status: "conflict",
});
const notConfigured = (): PortResult<never> => ({
  code: "entitlement",
  reason:
    "Verified company, customer, currency, and meter configuration is required.",
  status: "denied",
});
const decodeState = (value: unknown): RemoteState => {
  if (
    value === null ||
    typeof value !== "object" ||
    !("phase" in value) ||
    !("intent" in value) ||
    ![
      "start-intent",
      "start-unknown",
      "start-denied",
      "reserved",
      "settlement-intent",
      "settlement-recorded",
      "end-intent",
      "settled",
      "released",
    ].includes(String(value.phase))
  ) {
    throw new Error("Stored remote operation state is invalid.");
  }
  return value as RemoteState;
};
export const createUnpriceAdapter = (
  repository: UsageRepository,
  configuration?: UnpriceConfiguration
): {
  readonly budget: BudgetAuthority;
  readonly entitlements: EntitlementPolicy;
  readonly exportUsage: (
    organizationId: OrganizationId,
    eventSlug: string,
    properties: Readonly<Record<string, unknown>>,
    options: EffectOptions
  ) => Promise<PortResult<void>>;
} => {
  const client = (options: ReadOptions): Unprice => {
    if (!configuration?.token) {
      throw new Error("Unprice configuration is missing.");
    }
    const signal = options.signal
      ? AbortSignal.any([
          options.signal,
          AbortSignal.timeout(Math.max(1, options.deadlineAt - Date.now())),
        ])
      : AbortSignal.timeout(Math.max(1, options.deadlineAt - Date.now()));
    return new Unprice({
      disableTelemetry: true,
      fetch: async (request) =>
        await (configuration.fetch ?? fetch)(new Request(request, { signal })),
      retry: { attempts: 0 },
      token: configuration.token,
    });
  };
  const claim = async (state: RemoteState, options: EffectOptions) =>
    await repository.claimRemote(
      {
        digest: state.intent.digest,
        input: state.intent,
        kind: "unprice-reserve",
        operationId: state.intent.operationId,
      },
      state,
      options.deadlineAt
    );
  const reserve: BudgetAuthority["reserve"] = async (
    organizationId,
    suppliedMaximum,
    suppliedOptions
  ) => {
    const maximum = immutable(suppliedMaximum);
    const options = Object.freeze({ ...suppliedOptions });
    const ready = preflightEffect(options, Date.now());
    if (ready.status !== "ok") {
      return ready;
    }
    const mapping = configuration?.companies[organizationId];
    if (!configuration?.token || !mappingValid(mapping)) {
      return notConfigured();
    }
    const maximumMinor = minor(maximum, mapping);
    if (maximumMinor === undefined || maximumMinor <= 0) {
      return {
        reason: "Unprice requires a positive exact currency minor amount.",
        status: "invalid-input",
      };
    }
    const initial: RemoteState = {
      intent: {
        currency: mapping.currency,
        customerId: mapping.customerId,
        digest: options.requestDigest,
        mapping: mappingIdentity(mapping),
        maximum,
        maximumMinor,
        operationId: options.operationId,
        organizationId,
      },
      phase: "start-intent",
    };
    const bound = await repository.bindRemoteCommand(
      "unprice-reserve",
      initial.intent,
      options
    );
    if (bound.status !== "ok") {
      return bound;
    }
    const ownership = await claim(initial, options);
    if (ownership.state === "conflict") {
      return mismatch();
    }
    if (ownership.state === "pending") {
      return unknown(
        options,
        "Another owner is reconciling this remote operation."
      );
    }
    let state = decodeState(ownership.value);
    try {
      if (state.phase === "start-intent" || state.phase === "start-unknown") {
        const run = unpack(
          await client(options).runs.start({
            budgetAmountMinor: state.intent.maximumMinor,
            customerId: state.intent.customerId,
            idempotencyKey: state.intent.operationId,
          })
        );
        if (startBudgetDenied(run, state.intent)) {
          const result: PortResult<BudgetReservation> = {
            code: "budget-exhausted",
            reason: "Unprice denied the requested capacity.",
            status: "denied",
          };
          state = { intent: state.intent, phase: "start-denied", result };
          await repository.writeRemote(
            state.intent.operationId,
            ownership.token,
            state,
            true
          );
          return result;
        }
        if (!startRunValid(run, state.intent)) {
          throw new Error(
            "Unprice start receipt does not match its reserved capacity."
          );
        }
        state = { intent: state.intent, phase: "reserved", run };
        await repository.writeRemote(
          state.intent.operationId,
          ownership.token,
          state,
          true
        );
        return { status: "ok", value: projection(state, "reserved") };
      }
      await repository.writeRemote(
        state.intent.operationId,
        ownership.token,
        state,
        true
      );
      if (state.phase === "start-denied") {
        return immutable(state.result);
      }
      return { status: "ok", value: projection(state, "reserved") };
    } catch {
      if (state.phase === "start-intent") {
        state = { ...state, phase: "start-unknown" };
      }
      await repository.writeRemote(
        state.intent.operationId,
        ownership.token,
        state,
        true
      );
      return unknown(
        options,
        "Remote start remains unresolved. Retry its original key and payload."
      );
    }
  };
  type SettlementState = Extract<
    RemoteState,
    {
      readonly phase:
        | "settlement-intent"
        | "settlement-recorded"
        | "end-intent";
    }
  >;
  type EndState = Extract<RemoteState, { readonly phase: "end-intent" }>;
  const settlementValid = (
    receipt: Settlement,
    state: SettlementState,
    incurredMinor: number
  ): boolean =>
    receipt.accepted &&
    ["accepted", "duplicate"].includes(receipt.reason) &&
    runValid(receipt.run, state.intent) &&
    receipt.run.runId === state.run.runId &&
    receipt.run.consumedAmountMinor === incurredMinor &&
    receipt.fundingStatus === "fully_funded" &&
    receipt.fundedAmountMinor === incurredMinor &&
    receipt.unfundedAmountMinor === 0;
  const endReservation = async (
    state: EndState,
    token: string,
    options: EffectOptions,
    incurredMinor: number
  ): Promise<PortResult<BudgetReservation>> => {
    const sdk = client(options);
    let run = unpack(await sdk.runs.get({ runId: state.run.runId }));
    if (!runValid(run, state.intent) || run.runId !== state.run.runId) {
      throw new Error(
        "Unprice reconciliation receipt differs from its intent."
      );
    }
    const endStatus =
      state.command.kind === "release" ? "canceled" : state.command.outcome;
    if (run.status === "running") {
      run = unpack(
        await sdk.runs.end({ runId: state.run.runId, status: endStatus })
      );
    }
    if (
      !runValid(run, state.intent) ||
      run.runId !== state.run.runId ||
      run.status !== endStatus ||
      !Number.isSafeInteger(run.endedAt) ||
      run.consumedAmountMinor !== incurredMinor
    ) {
      throw new Error(
        "Unprice end receipt does not confirm the requested terminal state."
      );
    }
    const terminal = state.command.kind === "release" ? "released" : "settled";
    const result: PortResult<BudgetReservation> = {
      status: "ok",
      value: projection(state, terminal),
    };
    await repository.writeRemote(
      state.intent.operationId,
      token,
      {
        command: state.command,
        intent: state.intent,
        phase: terminal,
        result,
        run,
      },
      true
    );
    return immutable(result);
  };
  const settleAndEnd = async (
    initial: SettlementState,
    token: string,
    options: EffectOptions,
    incurredMinor: number
  ): Promise<PortResult<BudgetReservation>> => {
    let state = initial;
    if (state.phase === "settlement-intent") {
      const receipt =
        incurredMinor > 0
          ? unpack(await client(options).runs.settle(state.command.wire))
          : null;
      if (receipt && !settlementValid(receipt, state, incurredMinor)) {
        throw new Error(
          "Unprice settlement is not fully funded or does not match incurred usage."
        );
      }
      state = {
        ...state,
        phase: "settlement-recorded",
        receipt,
        run: receipt?.run ?? state.run,
      };
      await repository.writeRemote(state.intent.operationId, token, state);
    }
    if (state.phase === "settlement-recorded") {
      state = { ...state, phase: "end-intent" };
      await repository.writeRemote(state.intent.operationId, token, state);
    }
    if (state.phase !== "end-intent") {
      throw new Error("Unexpected remote finish state.");
    }
    return await endReservation(state, token, options, incurredMinor);
  };
  const resumeFinish = async (
    initial: RemoteState,
    command: Command,
    token: string,
    options: EffectOptions,
    incurredMinor: number
  ): Promise<PortResult<BudgetReservation>> => {
    let state = initial;
    if (state.phase === "start-denied") {
      await repository.releaseRemote(state.intent.operationId, token);
      return immutable(state.result);
    }
    if (state.phase === "start-intent" || state.phase === "start-unknown") {
      await repository.releaseRemote(state.intent.operationId, token);
      return unknown(
        options,
        "Original reserve must reconcile before settlement."
      );
    }
    if (state.phase === "reserved") {
      state = {
        command: {
          ...command,
          wire: { ...command.wire, runId: state.run.runId },
        },
        intent: state.intent,
        phase: "settlement-intent",
        run: state.run,
      };
      await repository.writeRemote(state.intent.operationId, token, state);
    } else {
      if (
        state.command.operationId !== command.operationId ||
        state.command.digest !== command.digest ||
        canonicalInput(state.command.input) !== canonicalInput(command.input)
      ) {
        await repository.releaseRemote(state.intent.operationId, token);
        return state.phase === "settled" || state.phase === "released"
          ? {
              code: "already-final",
              reason: "Reservation already has a terminal command.",
              status: "conflict",
            }
          : mismatch();
      }
      if (state.phase === "settled" || state.phase === "released") {
        await repository.releaseRemote(state.intent.operationId, token);
        return immutable(state.result);
      }
    }
    return await settleAndEnd(state, token, options, incurredMinor);
  };
  const finish = async (
    reservationId: ReservationId,
    suppliedIncurred: BudgetAmount | undefined,
    suppliedOptions: EffectOptions,
    outcome: "completed" | "failed" = "completed"
  ): Promise<PortResult<BudgetReservation>> => {
    const incurred = immutable(suppliedIncurred);
    const options = Object.freeze({ ...suppliedOptions });
    const ready = preflightEffect(options, Date.now());
    if (ready.status !== "ok") {
      return ready;
    }
    if (!reservationId.startsWith("unprice:")) {
      return { resource: "remote reservation", status: "not-found" };
    }
    const operationId = reservationId.slice("unprice:".length);
    const saved = await repository.readRemote(operationId);
    if (!saved) {
      return { resource: "remote reservation", status: "not-found" };
    }
    const state = decodeState(saved);
    const mapping = configuration?.companies[state.intent.organizationId];
    if (
      !configuration?.token ||
      !mappingValid(mapping) ||
      !mappingMatches(mapping, state.intent)
    ) {
      return notConfigured();
    }
    const amount = incurred ?? { unit: mapping.unit, units: 0 };
    const incurredMinor = minor(amount, mapping);
    if (
      incurredMinor === undefined ||
      incurredMinor > state.intent.maximumMinor
    ) {
      return {
        reason:
          "Usage exceeds reserved capacity or has an unsupported conversion.",
        status: "invalid-input",
      };
    }
    const kind = incurred === undefined ? "release" : "settle";
    const properties = immutable(mapping.meter.properties(amount));
    const commandInput = {
      incurred: amount,
      kind,
      mapping: {
        currency: mapping.currency,
        customerId: mapping.customerId,
        eventSlug: mapping.meter.eventSlug,
        featureSlug: mapping.meter.featureSlug,
        minorPerUnit: mapping.minorPerUnit,
        version: mapping.meter.version,
      },
      outcome,
      properties,
      reservationId,
    };
    const bound = await repository.bindRemoteCommand(
      `unprice-${kind}`,
      commandInput,
      options
    );
    if (bound.status !== "ok") {
      return bound;
    }
    const ownership = await claim(state, options);
    if (ownership.state === "conflict") {
      return mismatch();
    }
    if (ownership.state === "pending") {
      return unknown(options, "Another owner is finishing this reservation.");
    }
    const ownedState = decodeState(ownership.value);
    const command: Command = {
      digest: options.requestDigest,
      incurred: amount,
      input: commandInput,
      kind,
      operationId: options.operationId,
      outcome,
      wire: {
        eventSlug: mapping.meter.eventSlug,
        featureSlug: mapping.meter.featureSlug,
        idempotencyKey: options.operationId,
        properties,
        runId: "pending",
      },
    };
    try {
      return await resumeFinish(
        ownedState,
        command,
        ownership.token,
        options,
        incurredMinor
      );
    } catch {
      await repository.releaseRemote(operationId, ownership.token);
      return unknown(
        options,
        "Remote settlement or end remains unresolved. Capacity remains held until its receipt is confirmed."
      );
    }
  };
  return {
    budget: {
      async inspect(organizationId, options) {
        const mapping = configuration?.companies[organizationId];
        if (!configuration?.token || !mappingValid(mapping)) {
          return notConfigured();
        }
        const ready = preflightEffect(options, Date.now());
        if (ready.status !== "ok") {
          return ready;
        }
        try {
          const balance = unpack(
            await client(options).wallet.balance({
              customerId: mapping.customerId,
            })
          );
          if (
            balance.currency !== mapping.currency ||
            balance.available.currency !== mapping.currency ||
            !Number.isSafeInteger(balance.available.ledger_amount) ||
            balance.available.ledger_amount < 0
          ) {
            throw new Error("Wallet currency or ledger amount is invalid.");
          }
          return {
            status: "ok",
            value: immutable({
              unit: mapping.unit,
              units: Math.floor(
                balance.available.ledger_amount /
                  (1_000_000 * mapping.minorPerUnit)
              ),
            }),
          };
        } catch {
          return {
            code: "provider-unavailable",
            reason: "Wallet balance was not authoritative.",
            status: "unavailable",
          };
        }
      },
      release: async (reservationId, options) =>
        await finish(reservationId, undefined, options),
      reserve,
      settle: async (reservationId, incurred, options, outcome) =>
        await finish(reservationId, incurred, options, outcome),
    },
    entitlements: {
      async check(request, options) {
        const mapping = configuration?.companies[request.organizationId];
        const featureSlug = mapping?.featureSlugs[request.capability];
        if (!configuration?.token || !mappingValid(mapping) || !featureSlug) {
          return notConfigured();
        }
        const ready = preflightEffect(options, Date.now());
        if (ready.status !== "ok") {
          return ready;
        }
        try {
          const access = unpack(
            await client(options).access.check({
              customerId: mapping.customerId,
              featureSlug,
            })
          );
          if (
            typeof access.allowed !== "boolean" ||
            access.featureSlug !== featureSlug
          ) {
            throw new Error(
              "Entitlement receipt does not match the requested feature."
            );
          }
          return {
            status: "ok",
            value: access.allowed
              ? { decision: "allow", policyVersion: `unprice:${featureSlug}` }
              : {
                  decision: "deny",
                  policyVersion: `unprice:${featureSlug}`,
                  reason: access.rejectionReason ?? "Feature is not available.",
                },
          };
        } catch {
          return {
            code: "provider-unavailable",
            reason: "Entitlement receipt was not authoritative.",
            status: "unavailable",
          };
        }
      },
    },
    async exportUsage(organizationId, eventSlug, properties, options) {
      const ready = preflightEffect(options, Date.now());
      if (ready.status !== "ok") {
        return ready;
      }
      const mapping = configuration?.companies[organizationId];
      if (!configuration?.token || !mappingValid(mapping)) {
        return notConfigured();
      }
      if (eventSlug === mapping.meter.eventSlug) {
        return {
          reason:
            "The reservation meter is accounted by runs.settle and cannot be exported again.",
          status: "invalid-input",
        };
      }
      const bound = await repository.bindRemoteCommand(
        "unprice-export",
        {
          customerId: mapping.customerId,
          eventSlug,
          organizationId,
          properties,
        },
        options
      );
      if (bound.status !== "ok") {
        return bound;
      }
      try {
        const receipt = unpack(
          await client(options).usage.record({
            customerId: mapping.customerId,
            eventSlug,
            idempotencyKey: options.operationId,
            properties,
          })
        );
        return receipt.accepted
          ? { status: "ok", value: undefined }
          : unknown(options, "Usage export was not accepted.");
      } catch {
        return unknown(options, "Usage export acceptance is unknown.");
      }
    },
  };
};
