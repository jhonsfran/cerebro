import type { BudgetAuthority } from "../../contracts/src/policy.ts";
import { preflightEffect } from "../../contracts/src/port.ts";
import type { UsageRepository } from "../../db/src/repositories/usage.ts";

export const createLocalBudget = (
  repository: UsageRepository,
  unit: string
): BudgetAuthority => ({
  async inspect(organizationId, options) {
    const ready = preflightEffect(options, Date.now());
    if (ready.status !== "ok") {
      return ready;
    }
    return await repository.inspect(organizationId, unit);
  },
  async release(reservationId, options) {
    const ready = preflightEffect(options, Date.now());
    if (ready.status !== "ok") {
      return ready;
    }
    return await repository.release(reservationId, options);
  },
  async reserve(organizationId, maximum, options) {
    const ready = preflightEffect(options, Date.now());
    if (ready.status !== "ok") {
      return ready;
    }
    if (maximum.unit !== unit) {
      return {
        reason: "The account unit does not match.",
        status: "invalid-input",
      };
    }
    return await repository.reserve(organizationId, maximum, options);
  },
  async settle(reservationId, incurred, options) {
    const ready = preflightEffect(options, Date.now());
    if (ready.status !== "ok") {
      return ready;
    }
    return await repository.settle(reservationId, incurred, options);
  },
});
