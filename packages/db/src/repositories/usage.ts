import { and, eq, sql } from "drizzle-orm";

import { id } from "../../../contracts/src/identity.ts";
import type {
  OrganizationId,
  ReservationId,
} from "../../../contracts/src/identity.ts";
import type {
  BudgetAmount,
  BudgetReservation,
} from "../../../contracts/src/policy.ts";
import type { EffectOptions, PortResult } from "../../../contracts/src/port.ts";
import { canonicalToolArguments } from "../../../contracts/src/tools.ts";
import type { Database } from "../index.ts";
import {
  usageAccount,
  usageOperation,
  usageRemoteOperation,
  usageReservation,
} from "../schema/usage.ts";

export const canonicalInput = canonicalToolArguments;
const freeze = (entry: unknown): void => {
  if (entry !== null && typeof entry === "object") {
    for (const child of Object.values(entry)) {
      freeze(child);
    }
    Object.freeze(entry);
  }
};

export const immutable = <Value>(value: Value): Value => {
  const copy: Value = structuredClone(value);
  freeze(copy);
  return copy;
};
export const validAmount = (amount: BudgetAmount): boolean =>
  Number.isSafeInteger(amount.units) &&
  amount.units >= 0 &&
  amount.unit.trim().length > 0 &&
  amount.unit === amount.unit.trim();
const amountFits = (
  amount: BudgetAmount | undefined,
  row: typeof usageReservation.$inferSelect
): boolean =>
  !amount || (amount.unit === row.unit && amount.units <= row.maximum);
const conflict = (): PortResult<never> => ({
  code: "digest-mismatch",
  reason: "Operation identity does not match its saved intent.",
  status: "conflict",
});
const snapshot = (
  row: typeof usageReservation.$inferSelect
): BudgetReservation => ({
  id: id.reservation(row.id),
  maximum: { unit: row.unit, units: row.maximum },
  operationId: id.operation(row.operationId),
  organizationId: id.organization(row.organizationId),
  state: row.state,
});

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const lock = async (tx: Transaction, key: string): Promise<void> => {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`
  );
};
interface OperationIdentity {
  readonly operationId: string;
  readonly kind: string;
  readonly digest: string;
  readonly input: unknown;
}
export type RemoteClaim =
  | {
      readonly state: "claimed";
      readonly token: string;
      readonly value: unknown;
    }
  | { readonly state: "pending" }
  | { readonly state: "conflict" };

export const createUsageRepository = (database: Database) => {
  const mutate = async (
    kind: "reserve" | "settle" | "release",
    suppliedInput: {
      readonly organizationId?: OrganizationId;
      readonly reservationId?: ReservationId;
      readonly amount?: BudgetAmount;
    },
    suppliedOptions: EffectOptions
  ): Promise<PortResult<BudgetReservation>> => {
    const input = immutable(suppliedInput);
    const options = Object.freeze({ ...suppliedOptions });
    if (input.amount && !validAmount(input.amount)) {
      return {
        reason: "Budget amounts require nonnegative safe integer units.",
        status: "invalid-input",
      };
    }
    const canonical = canonicalInput(input);
    return await database.transaction(async (tx) => {
      await lock(tx, options.operationId);
      const [prior] = await tx
        .select()
        .from(usageOperation)
        .where(eq(usageOperation.id, options.operationId));
      if (prior) {
        if (
          prior.kind !== kind ||
          prior.digest !== options.requestDigest ||
          prior.canonicalInput !== canonical
        ) {
          return conflict();
        }
        return immutable(prior.result as PortResult<BudgetReservation>);
      }
      let result: PortResult<BudgetReservation>;
      if (kind === "reserve" && input.organizationId && input.amount) {
        const [account] = await tx
          .select()
          .from(usageAccount)
          .where(
            and(
              eq(usageAccount.organizationId, input.organizationId),
              eq(usageAccount.unit, input.amount.unit)
            )
          )
          .for("update");
        if (!account || account.available < input.amount.units) {
          result = {
            code: "budget-exhausted",
            reason: "The shared account has insufficient available capacity.",
            status: "denied",
          };
        } else {
          await tx
            .update(usageAccount)
            .set({
              available: account.available - input.amount.units,
              held: account.held + input.amount.units,
            })
            .where(
              and(
                eq(usageAccount.organizationId, account.organizationId),
                eq(usageAccount.unit, account.unit)
              )
            );
          const [row] = await tx
            .insert(usageReservation)
            .values({
              id: crypto.randomUUID(),
              maximum: input.amount.units,
              operationId: options.operationId,
              organizationId: input.organizationId,
              state: "reserved",
              unit: input.amount.unit,
            })
            .returning();
          if (!row) {
            throw new Error("Reservation insert returned no row.");
          }
          result = { status: "ok", value: snapshot(row) };
        }
      } else {
        const [row] = await tx
          .select()
          .from(usageReservation)
          .where(eq(usageReservation.id, input.reservationId ?? ""))
          .for("update");
        if (!row) {
          result = { resource: "reservation", status: "not-found" };
        } else if (row.state !== "reserved") {
          result = {
            code: "already-final",
            reason: "Reservation is already final.",
            status: "conflict",
          };
        } else if (amountFits(input.amount, row)) {
          const incurred = kind === "settle" ? (input.amount?.units ?? 0) : 0;
          const [account] = await tx
            .select()
            .from(usageAccount)
            .where(
              and(
                eq(usageAccount.organizationId, row.organizationId),
                eq(usageAccount.unit, row.unit)
              )
            )
            .for("update");
          if (!account) {
            throw new Error("Reservation account is missing.");
          }
          await tx
            .update(usageAccount)
            .set({
              available: account.available + row.maximum - incurred,
              held: account.held - row.maximum,
              spent: account.spent + incurred,
            })
            .where(
              and(
                eq(usageAccount.organizationId, row.organizationId),
                eq(usageAccount.unit, row.unit)
              )
            );
          const state = kind === "settle" ? "settled" : "released";
          await tx
            .update(usageReservation)
            .set({ incurred, state })
            .where(eq(usageReservation.id, row.id));
          result = {
            status: "ok",
            value: snapshot({ ...row, incurred, state }),
          };
        } else {
          result = {
            reason:
              "Incurred usage exceeds the reservation or uses another unit.",
            status: "invalid-input",
          };
        }
      }
      await tx.insert(usageOperation).values({
        canonicalInput: canonical,
        digest: options.requestDigest,
        id: options.operationId,
        kind,
        result,
      });
      return immutable(result);
    });
  };
  return {
    async bindRemoteCommand(
      kind: string,
      input: unknown,
      options: EffectOptions
    ): Promise<PortResult<void>> {
      let canonical: string;
      try {
        canonical = canonicalInput(input);
      } catch {
        return {
          reason: "Operation intent must contain finite plain JSON data.",
          status: "invalid-input",
        };
      }
      return await database.transaction(async (tx) => {
        await lock(tx, options.operationId);
        const [prior] = await tx
          .select()
          .from(usageOperation)
          .where(eq(usageOperation.id, options.operationId));
        if (prior) {
          return prior.kind === kind &&
            prior.digest === options.requestDigest &&
            prior.canonicalInput === canonical
            ? { status: "ok", value: undefined }
            : conflict();
        }
        await tx.insert(usageOperation).values({
          canonicalInput: canonical,
          digest: options.requestDigest,
          id: options.operationId,
          kind,
          result: { status: "ok", value: null },
        });
        return { status: "ok", value: undefined };
      });
    },
    async claimRemote(
      suppliedIntent: OperationIdentity,
      suppliedInitialState: unknown,
      deadlineAt: number
    ): Promise<RemoteClaim> {
      const intent = immutable(suppliedIntent);
      const initialState = immutable(suppliedInitialState);
      const canonical = canonicalInput(intent.input);
      return await database.transaction(async (tx) => {
        await lock(tx, intent.operationId);
        await tx
          .insert(usageRemoteOperation)
          .values({
            canonicalInput: canonical,
            digest: intent.digest,
            id: intent.operationId,
            kind: intent.kind,
            state: initialState,
          })
          .onConflictDoNothing();
        const [row] = await tx
          .select()
          .from(usageRemoteOperation)
          .where(eq(usageRemoteOperation.id, intent.operationId))
          .for("update");
        if (!row) {
          throw new Error("Remote intent is missing.");
        }
        if (
          row.kind !== intent.kind ||
          row.digest !== intent.digest ||
          row.canonicalInput !== canonical
        ) {
          return { state: "conflict" };
        }
        if (
          row.claimToken &&
          row.claimUntil &&
          row.claimUntil.getTime() > Date.now()
        ) {
          return { state: "pending" };
        }
        const token = crypto.randomUUID();
        await tx
          .update(usageRemoteOperation)
          .set({
            claimToken: token,
            claimUntil: new Date(
              Math.max(Date.now() + 1000, deadlineAt + 1000)
            ),
          })
          .where(eq(usageRemoteOperation.id, row.id));
        return immutable({ state: "claimed", token, value: row.state });
      });
    },
    async configureAccount(
      organizationId: OrganizationId,
      amount: BudgetAmount
    ): Promise<void> {
      if (!validAmount(amount)) {
        throw new Error("Invalid account capacity.");
      }
      await database
        .insert(usageAccount)
        .values({
          available: amount.units,
          organizationId,
          total: amount.units,
          unit: amount.unit,
        })
        .onConflictDoNothing();
    },
    async inspect(
      organizationId: OrganizationId,
      unit: string
    ): Promise<PortResult<BudgetAmount>> {
      const [row] = await database
        .select()
        .from(usageAccount)
        .where(
          and(
            eq(usageAccount.organizationId, organizationId),
            eq(usageAccount.unit, unit)
          )
        );
      if (!row) {
        return {
          code: "budget-exhausted",
          reason: "No account is configured for this unit.",
          status: "denied",
        };
      }
      return immutable({ status: "ok", value: { unit, units: row.available } });
    },
    async readRemote(operationId: string): Promise<unknown> {
      const [row] = await database
        .select({ state: usageRemoteOperation.state })
        .from(usageRemoteOperation)
        .where(eq(usageRemoteOperation.id, operationId));
      return row ? immutable(row.state) : undefined;
    },
    release: (reservationId: ReservationId, options: EffectOptions) =>
      mutate("release", { reservationId }, options),
    async releaseRemote(operationId: string, token: string): Promise<void> {
      const rows = await database
        .update(usageRemoteOperation)
        .set({ claimToken: null, claimUntil: null })
        .where(
          and(
            eq(usageRemoteOperation.id, operationId),
            eq(usageRemoteOperation.claimToken, token)
          )
        )
        .returning({ id: usageRemoteOperation.id });
      if (rows.length !== 1) {
        throw new Error("Remote operation claim is no longer owned.");
      }
    },
    reserve: (
      organizationId: OrganizationId,
      amount: BudgetAmount,
      options: EffectOptions
    ) => mutate("reserve", { amount, organizationId }, options),
    settle: (
      reservationId: ReservationId,
      amount: BudgetAmount,
      options: EffectOptions
    ) => mutate("settle", { amount, reservationId }, options),
    async writeRemote(
      operationId: string,
      token: string,
      state: unknown,
      release = false
    ): Promise<void> {
      const rows = await database
        .update(usageRemoteOperation)
        .set({
          state,
          ...(release ? { claimToken: null, claimUntil: null } : {}),
        })
        .where(
          and(
            eq(usageRemoteOperation.id, operationId),
            eq(usageRemoteOperation.claimToken, token)
          )
        )
        .returning({ id: usageRemoteOperation.id });
      if (rows.length !== 1) {
        throw new Error("Remote operation claim is no longer owned.");
      }
    },
  };
};
export type UsageRepository = ReturnType<typeof createUsageRepository>;
