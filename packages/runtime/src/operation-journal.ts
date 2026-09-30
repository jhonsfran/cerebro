import type { OrganizationId, OperationId } from "@cerebro/contracts/identity";
import type {
  OperationClaim,
  OperationIntent,
  OperationJournal,
  OperationRecord,
} from "@cerebro/contracts/operation-journal";
import type { BudgetAmount } from "@cerebro/contracts/policy";
import { preflightEffect } from "@cerebro/contracts/port";
import type {
  EffectOptions,
  PortResult,
  ReadOptions,
} from "@cerebro/contracts/port";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { Approval } from "@cerebro/contracts/tools";

export interface JournalDatabase {
  readonly exec: (sql: string, ...parameters: string[]) => void;
  readonly row: (
    sql: string,
    ...parameters: string[]
  ) => { payload: string } | undefined;
  readonly transaction: <Value>(body: () => Value) => Value;
  readonly sync: () => Promise<void>;
}

export const durableJournalDatabase = (
  storage: DurableObjectStorage
): JournalDatabase => ({
  exec: (query, ...parameters) => {
    storage.sql.exec(query, ...parameters);
  },
  row: (query, ...parameters) =>
    storage.sql.exec<{ payload: string }>(query, ...parameters).toArray()[0],
  sync: async () => {
    await storage.sync();
  },
  transaction: (body) => storage.transactionSync(body),
});

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
      "CREATE TABLE IF NOT EXISTS cerebro_operation (id TEXT PRIMARY KEY, result TEXT)"
    );
  }

  private key(
    organizationId: OrganizationId,
    operationId: OperationId,
    kind = "operation"
  ): string {
    return `journal:${JSON.stringify([this.namespace, kind, organizationId, operationId])}`;
  }

  private async committed<T>(value: T): Promise<T> {
    await this.database.sync();
    return value;
  }

  private record(
    organizationId: OrganizationId,
    operationId: OperationId
  ): OperationRecord<Value> | undefined {
    const row = this.database.row(
      "SELECT result AS payload FROM cerebro_operation WHERE id=?",
      this.key(organizationId, operationId)
    );
    return row
      ? (JSON.parse(row.payload) as OperationRecord<Value>)
      : undefined;
  }

  private save(record: OperationRecord<Value>): void {
    this.database.exec(
      "UPDATE cerebro_operation SET result=? WHERE id=?",
      JSON.stringify({
        ...record,
        kind: "operation",
        namespace: this.namespace,
      }),
      this.key(record.intent.organizationId, record.intent.operationId)
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
    return this.committed(
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
          "INSERT INTO cerebro_operation(id, result) VALUES(?,?)",
          this.key(intent.organizationId, intent.operationId),
          JSON.stringify({
            ...record,
            kind: "operation",
            namespace: this.namespace,
          })
        );
        this.database.exec(
          "INSERT INTO cerebro_operation(id, result) VALUES(?,?)",
          `journal-token:${this.namespace}:${claimToken}`,
          this.key(intent.organizationId, intent.operationId)
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
        "SELECT operation.result AS payload FROM cerebro_operation AS operation JOIN cerebro_operation AS token ON operation.id=token.result WHERE token.id=?",
        `journal-token:${this.namespace}:${claimToken}`
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
    return this.committed(
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
    return this.committed(
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
    return this.committed(
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
    return this.committed(
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
    return this.committed(
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
    return this.committed(
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

  async putApproval(approval: Approval): Promise<void> {
    const payload = JSON.stringify(approval);
    this.database.transaction(() => {
      const existing = this.database.row(
        "SELECT result AS payload FROM cerebro_operation WHERE id=?",
        this.key(approval.organizationId, approval.operationId, "approval")
      );
      if (
        existing &&
        canonicalToolArguments(JSON.parse(existing.payload)) !==
          canonicalToolArguments(approval)
      ) {
        throw new Error("The operation already has another approval.");
      }
      this.database.exec(
        "INSERT OR IGNORE INTO cerebro_operation(id, result) VALUES(?,?)",
        this.key(approval.organizationId, approval.operationId, "approval"),
        payload
      );
    });
    await this.database.sync();
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
      "SELECT result AS payload FROM cerebro_operation WHERE id=?",
      this.key(organizationId, operationId, "approval")
    );
    return Promise.resolve(
      row
        ? { status: "ok", value: JSON.parse(row.payload) as Approval }
        : { resource: "approval", status: "not-found" }
    );
  }
}
