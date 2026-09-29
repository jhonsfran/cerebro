import type {
  OrganizationId,
  OperationId,
} from "../../../packages/contracts/src/identity.ts";
import type {
  OperationClaim,
  OperationIntent,
  OperationJournal,
  OperationRecord,
} from "../../../packages/contracts/src/operation-journal.ts";
import type { BudgetAmount } from "../../../packages/contracts/src/policy.ts";
import { preflightEffect } from "../../../packages/contracts/src/port.ts";
import type {
  EffectOptions,
  PortResult,
  ReadOptions,
} from "../../../packages/contracts/src/port.ts";
import { canonicalToolArguments } from "../../../packages/contracts/src/tools.ts";
import type { Approval } from "../../../packages/contracts/src/tools.ts";

export interface JournalDatabase {
  readonly exec: (sql: string, ...parameters: string[]) => void;
  readonly row: (
    sql: string,
    ...parameters: string[]
  ) => { payload: string } | undefined;
  readonly transaction: <Value>(body: () => Value) => Value;
}

const conflict = (reason: string): PortResult<never> => ({
  code: "already-final",
  reason,
  status: "conflict",
});
const digestConflict = (): PortResult<never> => ({
  code: "digest-mismatch",
  reason: "The operation ID is bound to another request.",
  status: "conflict",
});

export class DurableOperationJournal<Value> implements OperationJournal<Value> {
  protected readonly database: JournalDatabase;
  protected readonly namespace: string;

  constructor(database: JournalDatabase, namespace: string) {
    this.database = database;
    this.namespace = namespace;
    database.exec(
      "CREATE TABLE IF NOT EXISTS _s4_fixture_operations (namespace TEXT NOT NULL, organization_id TEXT NOT NULL, operation_id TEXT NOT NULL, claim_token TEXT NOT NULL UNIQUE, payload TEXT NOT NULL, PRIMARY KEY(namespace, organization_id, operation_id))"
    );
    database.exec(
      "CREATE TABLE IF NOT EXISTS _s4_fixture_approvals (namespace TEXT NOT NULL, organization_id TEXT NOT NULL, operation_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace, organization_id, operation_id))"
    );
  }

  private record(
    organizationId: OrganizationId,
    operationId: OperationId
  ): OperationRecord<Value> | undefined {
    const row = this.database.row(
      "SELECT payload FROM _s4_fixture_operations WHERE namespace=? AND organization_id=? AND operation_id=?",
      this.namespace,
      organizationId,
      operationId
    );
    return row
      ? (JSON.parse(row.payload) as OperationRecord<Value>)
      : undefined;
  }

  private save(record: OperationRecord<Value>): void {
    this.database.exec(
      "UPDATE _s4_fixture_operations SET payload=? WHERE namespace=? AND organization_id=? AND operation_id=? AND claim_token=?",
      JSON.stringify(record),
      this.namespace,
      record.intent.organizationId,
      record.intent.operationId,
      record.claimToken
    );
  }

  claim(
    intent: OperationIntent,
    options: EffectOptions
  ): Promise<PortResult<OperationClaim<Value>>> {
    const preflight = preflightEffect(options, Date.now());
    if (preflight.status !== "ok") {
      return Promise.resolve(preflight);
    }
    if (
      intent.operationId !== options.operationId ||
      intent.requestDigest !== options.requestDigest
    ) {
      return Promise.resolve(digestConflict());
    }
    let canonical: string;
    try {
      canonical = canonicalToolArguments(intent.request);
    } catch {
      return Promise.resolve({
        reason: "The intent request must be JSON data.",
        status: "invalid-input",
      });
    }
    return Promise.resolve(
      this.database.transaction(() => {
        const prior = this.record(intent.organizationId, intent.operationId);
        if (prior) {
          if (
            prior.intent.requestDigest !== intent.requestDigest ||
            canonicalToolArguments(prior.intent.request) !== canonical
          ) {
            return digestConflict();
          }
          if (prior.state === "completed") {
            return {
              status: "ok",
              value: { result: prior.result, state: "completed" },
            };
          }
          return { status: "ok", value: { record: prior, state: "pending" } };
        }
        const claimToken = crypto.randomUUID();
        const record: OperationRecord<Value> = {
          claimToken,
          intent: { ...intent, request: JSON.parse(canonical) },
          state: "claimed",
        };
        this.database.exec(
          "INSERT INTO _s4_fixture_operations(namespace, organization_id, operation_id, claim_token, payload) VALUES(?,?,?,?,?)",
          this.namespace,
          intent.organizationId,
          intent.operationId,
          claimToken,
          JSON.stringify(record)
        );
        return { status: "ok", value: { claimToken, state: "claimed" } };
      })
    );
  }

  read(
    organizationId: OrganizationId,
    operationId: OperationId,
    options: ReadOptions
  ): Promise<PortResult<OperationRecord<Value>>> {
    const preflight = preflightEffect(options, Date.now());
    if (preflight.status !== "ok") {
      return Promise.resolve(preflight);
    }
    const record = this.record(organizationId, operationId);
    return Promise.resolve(
      record
        ? { status: "ok", value: record }
        : { resource: "operation", status: "not-found" }
    );
  }

  private transition(
    claimToken: string,
    options: EffectOptions,
    update: (
      record: OperationRecord<Value>
    ) => PortResult<OperationRecord<Value>>
  ): PortResult<void> {
    const preflight = preflightEffect(options, Date.now());
    if (preflight.status !== "ok") {
      return preflight;
    }
    return this.database.transaction(() => {
      const row = this.database.row(
        "SELECT payload FROM _s4_fixture_operations WHERE namespace=? AND claim_token=?",
        this.namespace,
        claimToken
      );
      if (!row) {
        return { resource: "claim", status: "not-found" };
      }
      const record = JSON.parse(row.payload) as OperationRecord<Value>;
      if (
        record.intent.operationId !== options.operationId ||
        record.intent.requestDigest !== options.requestDigest
      ) {
        return digestConflict();
      }
      const next = update(record);
      if (next.status !== "ok") {
        return next;
      }
      this.save(next.value);
      return { status: "ok", value: undefined };
    });
  }

  recordReservationIntent(
    claimToken: string,
    metadata: Readonly<Record<string, unknown>>,
    options: EffectOptions
  ): Promise<PortResult<void>> {
    const snapshot = JSON.parse(canonicalToolArguments(metadata)) as Readonly<
      Record<string, unknown>
    >;
    return Promise.resolve(
      this.transition(claimToken, options, (record) => {
        if (record.state === "claimed") {
          return {
            status: "ok",
            value: { ...record, metadata: snapshot, state: "reserve-intent" },
          };
        }
        if (
          record.state === "reserve-intent" &&
          canonicalToolArguments(record.metadata) ===
            canonicalToolArguments(snapshot)
        ) {
          return { status: "ok", value: record };
        }
        return conflict(
          "A reservation intent cannot change after it is recorded."
        );
      })
    );
  }

  dispatch(
    claimToken: string,
    metadata: Readonly<Record<string, unknown>>,
    options: EffectOptions
  ): Promise<PortResult<void>> {
    const snapshot = JSON.parse(canonicalToolArguments(metadata)) as Readonly<
      Record<string, unknown>
    >;
    return Promise.resolve(
      this.transition(claimToken, options, (record) =>
        record.state === "claimed" || record.state === "reserve-intent"
          ? {
              status: "ok",
              value: { ...record, metadata: snapshot, state: "dispatched" },
            }
          : conflict("Only a claimed operation can be dispatched.")
      )
    );
  }

  recordOutcome(
    claimToken: string,
    result: PortResult<Value>,
    incurred: BudgetAmount,
    options: EffectOptions
  ): Promise<PortResult<void>> {
    const snapshot = structuredClone(result);
    const usage = JSON.parse(canonicalToolArguments(incurred)) as BudgetAmount;
    return Promise.resolve(
      this.transition(claimToken, options, (record) => {
        if (record.state === "dispatched") {
          return {
            status: "ok",
            value: {
              ...record,
              incurred: usage,
              result: snapshot,
              state: "outcome-recorded",
            },
          };
        }
        if (
          record.state === "outcome-recorded" &&
          JSON.stringify(record.result) === JSON.stringify(snapshot) &&
          canonicalToolArguments(record.incurred) ===
            canonicalToolArguments(usage)
        ) {
          return { status: "ok", value: record };
        }
        return conflict(
          "An outcome receipt cannot change or be written before dispatch."
        );
      })
    );
  }

  complete(
    claimToken: string,
    result: PortResult<Value>,
    options: EffectOptions
  ): Promise<PortResult<void>> {
    const snapshot = structuredClone(result);
    return Promise.resolve(
      this.transition(claimToken, options, (record) => {
        if (
          record.state === "outcome-recorded" &&
          JSON.stringify(record.result) !== JSON.stringify(snapshot)
        ) {
          return conflict("Completion must match the recorded result.");
        }
        if (
          record.state === "release-intent" &&
          JSON.stringify(record.result) !== JSON.stringify(snapshot)
        ) {
          return conflict("Completion must match the recorded release result.");
        }
        if (record.state === "completed") {
          if (JSON.stringify(record.result) === JSON.stringify(snapshot)) {
            return { status: "ok", value: record };
          }
          return conflict("A completed operation cannot change its result.");
        }
        return {
          status: "ok",
          value: {
            claimToken,
            intent: record.intent,
            result: snapshot,
            state: "completed",
          },
        };
      })
    );
  }

  unknown(
    claimToken: string,
    reason: string,
    options: EffectOptions
  ): Promise<PortResult<void>> {
    return Promise.resolve(
      this.transition(claimToken, options, (record) => {
        if (record.state === "dispatched") {
          return {
            status: "ok",
            value: { ...record, reason, state: "unknown-outcome" },
          };
        }
        if (record.state === "unknown-outcome" && record.reason === reason) {
          return { status: "ok", value: record };
        }
        return conflict(
          "Only a dispatched operation can have an unknown outcome."
        );
      })
    );
  }

  recordReleaseIntent(
    claimToken: string,
    metadata: Readonly<Record<string, unknown>>,
    result: PortResult<Value>,
    options: EffectOptions
  ): Promise<PortResult<void>> {
    const snapshot = structuredClone(result);
    const details = JSON.parse(canonicalToolArguments(metadata)) as Readonly<
      Record<string, unknown>
    >;
    return Promise.resolve(
      this.transition(claimToken, options, (record) => {
        if (record.state === "reserve-intent") {
          return {
            status: "ok",
            value: {
              ...record,
              metadata: details,
              result: snapshot,
              state: "release-intent",
            },
          };
        }
        if (
          record.state === "release-intent" &&
          JSON.stringify(record.result) === JSON.stringify(snapshot) &&
          canonicalToolArguments(record.metadata) ===
            canonicalToolArguments(details)
        ) {
          return { status: "ok", value: record };
        }
        return conflict(
          "A release intent cannot change or replace a dispatched operation."
        );
      })
    );
  }

  putApproval(approval: Approval): void {
    const payload = JSON.stringify(approval);
    this.database.transaction(() => {
      const existing = this.database.row(
        "SELECT payload FROM _s4_fixture_approvals WHERE namespace=? AND organization_id=? AND operation_id=?",
        this.namespace,
        approval.organizationId,
        approval.operationId
      );
      if (
        existing &&
        canonicalToolArguments(JSON.parse(existing.payload)) !==
          canonicalToolArguments(approval)
      ) {
        throw new Error("The operation already has another approval.");
      }
      this.database.exec(
        "INSERT OR IGNORE INTO _s4_fixture_approvals(namespace, organization_id, operation_id, payload) VALUES(?,?,?,?)",
        this.namespace,
        approval.organizationId,
        approval.operationId,
        payload
      );
    });
  }

  approval(
    organizationId: OrganizationId,
    operationId: OperationId,
    options: ReadOptions
  ): Promise<PortResult<Approval>> {
    const preflight = preflightEffect(options, Date.now());
    if (preflight.status !== "ok") {
      return Promise.resolve(preflight);
    }
    const row = this.database.row(
      "SELECT payload FROM _s4_fixture_approvals WHERE namespace=? AND organization_id=? AND operation_id=?",
      this.namespace,
      organizationId,
      operationId
    );
    return Promise.resolve(
      row
        ? { status: "ok", value: JSON.parse(row.payload) as Approval }
        : { resource: "approval", status: "not-found" }
    );
  }
}
