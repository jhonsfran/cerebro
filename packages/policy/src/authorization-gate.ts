import {
  id,
  isExecutionContextActiveAt,
} from "../../contracts/src/identity.ts";
import type { ExecutionContext } from "../../contracts/src/identity.ts";
import type {
  OperationJournal,
  OperationRecord,
} from "../../contracts/src/operation-journal.ts";
import type {
  Action,
  AuthorizationPolicy,
  BudgetAmount,
  BudgetAuthority,
  BudgetReservation,
  EntitlementPolicy,
  EntitlementRequest,
  Resource,
} from "../../contracts/src/policy.ts";
import { preflightEffect } from "../../contracts/src/port.ts";
import type {
  EffectOptions,
  PortResult,
  ReadOptions,
} from "../../contracts/src/port.ts";
import { digestToolArguments } from "../../contracts/src/tools.ts";
import {
  canonicalInput,
  immutable,
  validAmount,
} from "../../db/src/repositories/usage.ts";

export interface PaidWorkRequest {
  readonly context: ExecutionContext;
  readonly action: Action;
  readonly resource: Resource;
  readonly entitlement: EntitlementRequest;
  readonly maximum: BudgetAmount;
  readonly input: unknown;
}
export interface WorkOutcome<Value> {
  readonly result: PortResult<Value>;
  readonly usage:
    | { readonly state: "known"; readonly incurred: BudgetAmount }
    | { readonly state: "unknown" };
}
type Work<Value> = (
  reservation: BudgetReservation,
  options: ReadOptions
) => Promise<WorkOutcome<Value>>;
export interface PaidWork<Value> {
  readonly run: (
    request: PaidWorkRequest,
    options: EffectOptions,
    work: Work<Value>
  ) => Promise<PortResult<Value>>;
  readonly check: (
    request: PaidWorkRequest,
    options: ReadOptions
  ) => Promise<PortResult<void>>;
}
export const digestInput = digestToolArguments;
const maintenance = (options: EffectOptions): EffectOptions => ({
  ...options,
  deadlineAt: Date.now() + 15_000,
  signal: undefined,
});
const budgetOptions = async (
  options: EffectOptions,
  kind: string,
  input: unknown,
  cleanup = false
): Promise<EffectOptions> => ({
  ...(cleanup ? maintenance(options) : options),
  operationId: id.operation(`${options.operationId}:budget:${kind}`),
  requestDigest: await digestInput({
    input,
    parentDigest: options.requestDigest,
  }),
});
const pending = (
  options: EffectOptions,
  reason: string
): PortResult<never> => ({
  operationId: options.operationId,
  reason,
  status: "unknown-outcome",
});
interface PaidCall {
  readonly request: PaidWorkRequest;
  readonly options: EffectOptions;
  readonly token: string;
}
interface KnownOutcome<Value> {
  readonly reservationId: string;
  readonly incurred: BudgetAmount;
  readonly result: PortResult<Value>;
  readonly accounting: "settle" | "release";
}
const usageValid = (incurred: BudgetAmount, maximum: BudgetAmount): boolean =>
  validAmount(incurred) &&
  incurred.unit === maximum.unit &&
  incurred.units <= maximum.units;

export const createPaidWork = <Value>(dependencies: {
  readonly authorization: AuthorizationPolicy;
  readonly entitlements: EntitlementPolicy;
  readonly budget: BudgetAuthority;
  readonly journal: OperationJournal<Value>;
}): PaidWork<Value> => {
  const check: PaidWork<Value>["check"] = async (request, options) => {
    if (
      !isExecutionContextActiveAt(
        request.context,
        request.resource.organizationId,
        Date.now()
      ) ||
      request.entitlement.organizationId !== request.resource.organizationId
    ) {
      return {
        code: "unauthorized",
        reason: "The current identity or company does not match.",
        status: "denied",
      };
    }
    const authorized = await dependencies.authorization.evaluate(
      request.context,
      request.action,
      request.resource,
      options
    );
    if (authorized.status !== "ok") {
      return authorized;
    }
    if (authorized.value.decision === "deny") {
      return {
        code: "unauthorized",
        reason: authorized.value.reason,
        status: "denied",
      };
    }
    const entitled = await dependencies.entitlements.check(
      request.entitlement,
      options
    );
    if (entitled.status !== "ok") {
      return entitled;
    }
    if (entitled.value.decision === "deny") {
      return {
        code: "entitlement",
        reason: entitled.value.reason,
        status: "denied",
      };
    }
    return { status: "ok", value: undefined };
  };
  const complete = async (
    call: PaidCall,
    result: PortResult<Value>
  ): Promise<PortResult<Value>> => {
    const saved = await dependencies.journal.complete(
      call.token,
      result,
      maintenance(call.options)
    );
    return saved.status === "ok" ? immutable(result) : saved;
  };
  const unknown = async (
    call: PaidCall,
    reason: string
  ): Promise<PortResult<Value>> => {
    const saved = await dependencies.journal.unknown(
      call.token,
      reason,
      maintenance(call.options)
    );
    return saved.status === "ok" ? pending(call.options, reason) : saved;
  };
  const accountKnown = async (
    call: PaidCall,
    known: KnownOutcome<Value>
  ): Promise<PortResult<Value>> => {
    const reservationId = id.reservation(known.reservationId);
    const outcome = known.result.status === "ok" ? "completed" : "failed";
    const options = await budgetOptions(
      call.options,
      known.accounting,
      { incurred: known.incurred, outcome, reservationId },
      true
    );
    const accounted =
      known.accounting === "release"
        ? await dependencies.budget.release(reservationId, options)
        : await dependencies.budget.settle(
            reservationId,
            known.incurred,
            options,
            outcome
          );
    if (accounted.status !== "ok") {
      return pending(
        call.options,
        "Known usage and its result are durable. Accounting requires reconciliation."
      );
    }
    const saved = await dependencies.journal.complete(
      call.token,
      known.result,
      maintenance(call.options)
    );
    if (saved.status !== "ok") {
      return saved;
    }
    const current = await check(call.request, call.options);
    return current.status === "ok" ? immutable(known.result) : current;
  };
  const recordKnown = async (
    call: PaidCall,
    known: KnownOutcome<Value>
  ): Promise<PortResult<Value>> => {
    const saved = await dependencies.journal.recordOutcome(
      call.token,
      known.result,
      known.incurred,
      maintenance(call.options)
    );
    if (saved.status !== "ok") {
      return await unknown(
        call,
        "Provider outcome could not be saved. Capacity remains held."
      );
    }
    return await accountKnown(call, known);
  };
  const dispatchReserved = async (
    call: PaidCall,
    reservation: BudgetReservation,
    work: Work<Value>
  ): Promise<PortResult<Value>> => {
    const ready = preflightEffect(call.options, Date.now());
    const current =
      ready.status === "ok" ? await check(call.request, call.options) : ready;
    const metadata = {
      input: call.request.input,
      maximum: call.request.maximum,
      reservationId: reservation.id,
      ...(call.request.entitlement.model
        ? { model: call.request.entitlement.model }
        : {}),
    };
    if (current.status !== "ok") {
      const releasing = await dependencies.journal.recordReleaseIntent(
        call.token,
        metadata,
        current,
        maintenance(call.options)
      );
      if (releasing.status !== "ok") {
        return pending(
          call.options,
          "Another owner won the dispatch or release claim."
        );
      }
      return await accountKnown(call, {
        accounting: "release",
        incurred: { ...call.request.maximum, units: 0 },
        reservationId: reservation.id,
        result: current,
      });
    }
    const dispatched = await dependencies.journal.dispatch(
      call.token,
      { ...metadata, accounting: "settle" },
      call.options
    );
    if (dispatched.status !== "ok") {
      return pending(
        call.options,
        "Another owner dispatched this work or its durable receipt is pending."
      );
    }
    let outcome: WorkOutcome<Value>;
    try {
      outcome = await work(reservation, call.options);
    } catch {
      return await unknown(
        call,
        "Paid work failed without authoritative usage. Its maximum remains held."
      );
    }
    if (outcome.usage.state === "unknown") {
      return await unknown(
        call,
        "Paid usage is unknown. Its maximum remains held."
      );
    }
    if (!usageValid(outcome.usage.incurred, call.request.maximum)) {
      return await unknown(
        call,
        "Provider usage exceeds its verified bound or uses another unit. Capacity remains held."
      );
    }
    return await recordKnown(call, {
      accounting: "settle",
      incurred: outcome.usage.incurred,
      reservationId: reservation.id,
      result: outcome.result,
    });
  };
  const reserveAndDispatch = async (
    call: PaidCall,
    work: Work<Value>,
    resumed: boolean
  ): Promise<PortResult<Value>> => {
    const reservation = await dependencies.budget.reserve(
      call.request.resource.organizationId,
      call.request.maximum,
      await budgetOptions(
        call.options,
        "reserve",
        { request: call.request },
        resumed
      )
    );
    if (
      reservation.status === "unknown-outcome" ||
      reservation.status === "unavailable"
    ) {
      return pending(
        call.options,
        "Reservation intent is durable. Retry its original operation to reconcile capacity."
      );
    }
    if (reservation.status !== "ok") {
      if (
        reservation.status === "denied" &&
        reservation.code === "budget-exhausted"
      ) {
        return await complete(call, reservation);
      }
      return reservation;
    }
    if (reservation.value.state !== "reserved") {
      return pending(
        call.options,
        "The reservation is already final and requires its accounting receipt."
      );
    }
    return await dispatchReserved(call, reservation.value, work);
  };
  const resumeRecorded = async (
    call: PaidCall,
    record: Extract<
      OperationRecord<Value>,
      { readonly state: "outcome-recorded" }
    >
  ): Promise<PortResult<Value>> => {
    if (
      typeof record.metadata.reservationId !== "string" ||
      !usageValid(record.incurred, call.request.maximum)
    ) {
      return {
        reason: "Recorded usage or reservation identity is invalid.",
        status: "invalid-input",
      };
    }
    return await accountKnown(call, {
      accounting:
        record.metadata.accounting === "release" ? "release" : "settle",
      incurred: record.incurred,
      reservationId: record.metadata.reservationId,
      result: record.result,
    });
  };
  return {
    check,
    async run(suppliedRequest, suppliedOptions, work) {
      const options = Object.freeze({ ...suppliedOptions });
      let request: PaidWorkRequest;
      try {
        canonicalInput(suppliedRequest);
        request = immutable(suppliedRequest);
      } catch {
        return {
          reason: "Paid work requires an immutable JSON request.",
          status: "invalid-input",
        };
      }
      const ready = preflightEffect(options, Date.now());
      if (ready.status !== "ok") {
        return ready;
      }
      if (!validAmount(request.maximum)) {
        return {
          reason: "Paid work needs a finite safe integer maximum.",
          status: "invalid-input",
        };
      }
      const claimed = await dependencies.journal.claim(
        {
          operationId: options.operationId,
          organizationId: request.resource.organizationId,
          request,
          requestDigest: options.requestDigest,
        },
        options
      );
      if (claimed.status !== "ok") {
        return claimed;
      }
      if (claimed.value.state === "completed") {
        const current = await check(request, options);
        return current.status === "ok"
          ? immutable(claimed.value.result)
          : current;
      }
      const token =
        claimed.value.state === "claimed"
          ? claimed.value.claimToken
          : claimed.value.record.claimToken;
      const call: PaidCall = { options, request, token };
      if (claimed.value.state === "pending") {
        const { record } = claimed.value;
        if (record.state === "outcome-recorded") {
          return await resumeRecorded(call, record);
        }
        if (record.state === "release-intent") {
          if (typeof record.metadata.reservationId !== "string") {
            return {
              reason: "Release intent has no reservation identity.",
              status: "invalid-input",
            };
          }
          return await accountKnown(call, {
            accounting: "release",
            incurred: { ...request.maximum, units: 0 },
            reservationId: record.metadata.reservationId,
            result: record.result,
          });
        }
        if (record.state === "reserve-intent") {
          return await reserveAndDispatch(call, work, true);
        }
        return pending(
          options,
          "Paid work already has a durable pending owner."
        );
      }
      const allowed = await check(request, options);
      if (allowed.status !== "ok") {
        return await complete(call, allowed);
      }
      const prepared = await dependencies.journal.recordReservationIntent(
        token,
        { input: request.input, maximum: request.maximum },
        options
      );
      if (prepared.status !== "ok") {
        return prepared;
      }
      return await reserveAndDispatch(call, work, false);
    },
  };
};
