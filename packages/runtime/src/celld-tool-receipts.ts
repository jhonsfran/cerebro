import type { EventAddress } from "@cerebro/contracts/events";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import {
  isExecutionContextActiveAt,
  sameExecutionContext,
} from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { EffectOptions, ReadOptions } from "@cerebro/contracts/port";
import { ToolReceiptStore } from "@cerebro/contracts/receipt-service";
import type {
  EffectIntent,
  ReceiptKey,
  ReceiptOutcome,
  ToolReceipt,
} from "@cerebro/contracts/receipt-service";
import { boundApprovalMatches } from "@cerebro/contracts/tool-service";
import {
  canonicalToolArguments,
  digestToolArguments,
} from "@cerebro/contracts/tools";
import { Effect, Layer, Schema } from "effect";

import { attempt, waitForCaller } from "./runtime-ports.ts";
import type { HostCheckpoint } from "./runtime-ports.ts";

type SqlValue = string | number | null;
export interface ToolReceiptSqliteStorage {
  readonly sql: {
    readonly exec: <Row extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ) => { readonly toArray: () => Row[] };
  };
  readonly transactionSync: <A>(run: () => A) => A;
  readonly sync?: () => Promise<void>;
}
export interface ToolReceiptStoreConfiguration {
  readonly address: EventAddress;
  readonly authorize: (
    receipt: ToolReceipt,
    context: ExecutionContext,
    options: ReadOptions
  ) => Effect.Effect<void, ContractFailure>;
  readonly now?: () => number;
  readonly checkpoint?: HostCheckpoint;
}

const identifier = <Name extends string>() =>
  Schema.declare<string & { readonly __brand: Name }>(
    (value): value is string & { readonly __brand: Name } =>
      typeof value === "string" && value.length > 0 && value.trim() === value
  );
const principal = Schema.Struct({
  id: identifier<"PrincipalId">(),
  kind: Schema.Literals(["human", "service", "agent"]),
  organizationId: identifier<"OrganizationId">(),
  state: Schema.Literals(["active", "disabled"]),
});
const contextSchema = Schema.Union([
  Schema.Struct({ actor: principal }),
  Schema.Struct({
    actor: principal,
    delegation: Schema.Struct({
      actorId: identifier<"PrincipalId">(),
      expiresAt: Schema.Number.check(Schema.isFinite()),
      id: identifier<"DelegationId">(),
      organizationId: identifier<"OrganizationId">(),
      representedId: identifier<"PrincipalId">(),
    }),
    represented: principal,
  }),
]);
const jsonValue = Schema.Unknown.check(
  Schema.makeFilter((value) => {
    try {
      canonicalToolArguments(value);
      return true;
    } catch {
      return false;
    }
  })
);
const intentSchema = Schema.Struct({
  invocation: Schema.Struct({
    agentId: identifier<"AgentId">(),
    argumentDigest: identifier<"Digest">(),
    arguments: jsonValue,
    context: contextSchema,
    operationId: identifier<"OperationId">(),
    organizationId: identifier<"OrganizationId">(),
    runId: identifier<"RunId">(),
    state: Schema.Literal("requested"),
    tool: Schema.Struct({
      connectorFingerprint: identifier<"Digest">(),
      connectorId: Schema.NonEmptyString,
      effect: Schema.Literals(["read", "write"]),
      id: identifier<"ToolId">(),
      version: Schema.NonEmptyString,
    }),
  }),
  policyVersion: Schema.NonEmptyString,
});
const outcomeSchema = Schema.Union([
  Schema.Struct({
    execution: Schema.Struct({
      output: jsonValue,
      providerReceipt: Schema.optional(Schema.String),
    }),
    state: Schema.Literal("succeeded"),
  }),
  Schema.Struct({
    providerReceipt: Schema.optional(Schema.String),
    reason: Schema.NonEmptyString,
    state: Schema.Literal("failed"),
  }),
]);
const receiptFields = {
  intent: intentSchema,
  key: Schema.Struct({
    operationId: identifier<"OperationId">(),
    organizationId: identifier<"OrganizationId">(),
  }),
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
};
const receiptSchema = Schema.Union([
  Schema.Struct({ ...receiptFields, state: Schema.Literal("claimed") }),
  Schema.Struct({
    ...receiptFields,
    dispatchedAt: Schema.Number.check(Schema.isFinite()),
    state: Schema.Literal("dispatched"),
  }),
  Schema.Struct({
    ...receiptFields,
    outcome: outcomeSchema,
    state: Schema.Literals(["outcome", "completed"]),
  }),
  Schema.Struct({
    ...receiptFields,
    providerReceipt: Schema.optional(Schema.String),
    reason: Schema.NonEmptyString,
    state: Schema.Literal("unknown"),
  }),
]);
const parseInput = <A>(parse: () => A): Effect.Effect<A, InvalidInput> =>
  Effect.try({
    catch: () => new InvalidInput({ reason: "Invalid tool receipt data" }),
    try: parse,
  });
const unresolvedKey = (intent: EffectIntent): string => {
  const { invocation } = intent;
  return canonicalToolArguments({
    actorId: invocation.context.actor.id,
    agentId: invocation.agentId,
    argumentDigest: invocation.argumentDigest,
    connectorFingerprint: invocation.tool.connectorFingerprint,
    delegationId: invocation.context.delegation?.id ?? null,
    effect: invocation.tool.effect,
    organizationId: invocation.organizationId,
    principalId:
      invocation.context.represented?.id ?? invocation.context.actor.id,
    runId: invocation.runId,
    toolId: invocation.tool.id,
    toolVersion: invocation.tool.version,
  });
};

export const createCelldToolReceiptStore = (
  storage: ToolReceiptSqliteStorage,
  configuration: ToolReceiptStoreConfiguration
) => {
  const address = structuredClone(configuration.address);
  const now = configuration.now ?? Date.now;
  const flush = () =>
    Effect.tryPromise({
      catch: () => new Unavailable({ reason: "Tool receipt flush failed" }),
      try: () => storage.sync?.() ?? Promise.resolve(),
    });
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_pi_tool_receipts (company TEXT NOT NULL, operation TEXT NOT NULL, session TEXT NOT NULL, unresolved_key TEXT NOT NULL, state TEXT NOT NULL, revision INTEGER NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY (company, operation))"
  );
  storage.sql.exec(
    "CREATE INDEX IF NOT EXISTS cerebro_pi_tool_receipts_unresolved ON cerebro_pi_tool_receipts (company, unresolved_key, state)"
  );
  const check = (options: ReadOptions): void => {
    if (
      !Number.isFinite(options.deadlineAt) ||
      options.deadlineAt <= now() ||
      options.signal?.aborted
    ) {
      throw new Unavailable({ reason: "Deadline or caller interruption" });
    }
  };
  const company = (key: ReceiptKey): void => {
    if (key.organizationId !== address.organizationId) {
      throw new Denied({
        code: "unauthorized",
        reason: "Receipt belongs to another company",
      });
    }
  };
  const load = (key: ReceiptKey): ToolReceipt => {
    company(key);
    const [row] = storage.sql
      .exec<{ receipt: string; session: string }>(
        "SELECT receipt, session FROM cerebro_pi_tool_receipts WHERE company=? AND operation=?",
        key.organizationId,
        key.operationId
      )
      .toArray();
    if (!row) {
      throw new NotFound({ resource: "Tool receipt" });
    }
    if (row.session !== address.sessionId) {
      throw new Denied({
        code: "unauthorized",
        reason: "Receipt belongs to another session",
      });
    }
    const receipt: ToolReceipt = Schema.decodeUnknownSync(receiptSchema)(
      JSON.parse(row.receipt),
      { onExcessProperty: "error" }
    );
    if (
      receipt.key.organizationId !== key.organizationId ||
      receipt.key.operationId !== key.operationId ||
      receipt.intent.invocation.agentId !== address.agentId
    ) {
      throw new Unavailable({
        reason: "Stored tool receipt identity is invalid",
      });
    }
    return receipt;
  };
  const save = (receipt: ToolReceipt): ToolReceipt => {
    storage.sql.exec(
      "INSERT INTO cerebro_pi_tool_receipts VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(company, operation) DO UPDATE SET state=excluded.state, revision=excluded.revision, receipt=excluded.receipt",
      receipt.key.organizationId,
      receipt.key.operationId,
      address.sessionId,
      unresolvedKey(receipt.intent),
      receipt.state,
      receipt.revision,
      JSON.stringify(receipt)
    );
    return structuredClone(receipt);
  };
  const checkIntent = (receipt: ToolReceipt, options: EffectOptions): void => {
    check(options);
    if (
      options.operationId !== receipt.key.operationId ||
      options.requestDigest !== receipt.intent.invocation.argumentDigest
    ) {
      throw new Conflict({
        code: "digest-mismatch",
        reason: "Receipt mutation identity changed",
      });
    }
  };
  const fence = (receipt: ToolReceipt): void => {
    if (receipt.intent.invocation.tool.effect !== "write") {
      return;
    }
    const [blocked] = storage.sql
      .exec<{ operation: string }>(
        "SELECT operation FROM cerebro_pi_tool_receipts WHERE company=? AND unresolved_key=? AND state IN ('dispatched', 'unknown') AND operation<>? LIMIT 1",
        receipt.key.organizationId,
        unresolvedKey(receipt.intent),
        receipt.key.operationId
      )
      .toArray();
    if (blocked) {
      throw new UnknownOutcome({
        operationId: receipt.intent.invocation.operationId,
        reason: "Unresolved effect intent blocks another occurrence",
      });
    }
  };
  const authorize = (
    receipt: ToolReceipt,
    context: ExecutionContext,
    options: ReadOptions
  ) =>
    waitForCaller(
      Effect.gen(function* authorizeReceipt() {
        yield* attempt(() => {
          check(options);
          company(receipt.key);
          if (
            !sameExecutionContext(receipt.intent.invocation.context, context) ||
            !isExecutionContextActiveAt(context, address.organizationId, now())
          ) {
            throw new Denied({
              code: "unauthorized",
              reason: "Caller does not own this receipt",
            });
          }
        });
        yield* configuration.authorize(receipt, context, options);
        yield* attempt(() => check(options));
      }),
      options
    );
  const mutate = <A>(
    key: ReceiptKey,
    options: EffectOptions,
    change: (receipt: ToolReceipt) => A
  ) =>
    attempt(() =>
      storage.transactionSync(() => {
        const receipt = load(key);
        checkIntent(receipt, options);
        return change(receipt);
      })
    ).pipe(Effect.tap(flush));
  const service: ToolReceiptStore = {
    claim: (input, options) =>
      Effect.gen(function* claim() {
        const intent: EffectIntent = yield* parseInput(() =>
          Schema.decodeUnknownSync(intentSchema)(structuredClone(input), {
            onExcessProperty: "error",
          })
        );
        const key = {
          operationId: intent.invocation.operationId,
          organizationId: intent.invocation.organizationId,
        };
        const claimed: ToolReceipt = {
          intent,
          key,
          revision: 1,
          state: "claimed",
        };
        yield* attempt(() => {
          checkIntent(claimed, options);
          company(key);
          if (intent.invocation.agentId !== address.agentId) {
            throw new Denied({
              code: "unauthorized",
              reason: "Receipt belongs to another agent",
            });
          }
        });
        const digest = yield* Effect.tryPromise({
          catch: () =>
            new InvalidInput({ reason: "Invalid receipt arguments" }),
          try: () => digestToolArguments(intent.invocation.arguments),
        });
        if (digest !== intent.invocation.argumentDigest) {
          return yield* Effect.fail(
            new Conflict({
              code: "digest-mismatch",
              reason: "Receipt argument digest does not match",
            })
          );
        }
        const existing = yield* attempt(() => {
          const [row] = storage.sql
            .exec<{ receipt: string }>(
              "SELECT receipt FROM cerebro_pi_tool_receipts WHERE company=? AND operation=?",
              key.organizationId,
              key.operationId
            )
            .toArray();
          return row ? load(key) : undefined;
        });
        yield* authorize(
          existing ?? claimed,
          intent.invocation.context,
          options
        );
        const result = yield* attempt(() =>
          storage.transactionSync(() => {
            check(options);
            const [row] = storage.sql
              .exec<{ receipt: string }>(
                "SELECT receipt FROM cerebro_pi_tool_receipts WHERE company=? AND operation=?",
                key.organizationId,
                key.operationId
              )
              .toArray();
            if (row) {
              const prior = load(key);
              if (
                canonicalToolArguments(prior.intent) !==
                canonicalToolArguments(intent)
              ) {
                throw new Conflict({
                  code: "digest-mismatch",
                  reason: "Full receipt intent changed",
                });
              }
              return { receipt: prior, replayed: true };
            }
            fence(claimed);
            return { receipt: save(claimed), replayed: false };
          })
        );
        yield* flush();
        yield* authorize(result.receipt, intent.invocation.context, options);
        return result;
      }),
    complete: (key, options) =>
      mutate(key, options, (receipt) => {
        if (receipt.state === "completed") {
          return receipt;
        }
        if (receipt.state !== "outcome") {
          throw new Conflict({
            code: "version-mismatch",
            reason: "Completion requires a confirmed outcome",
          });
        }
        return save({
          intent: receipt.intent,
          key: receipt.key,
          outcome: receipt.outcome,
          revision: receipt.revision + 1,
          state: "completed",
        });
      }),
    dispatch: (key, expectedRevision, approval, options) =>
      Effect.gen(function* dispatch() {
        const receipt = yield* attempt(() => load(key));
        yield* attempt(() => checkIntent(receipt, options));
        yield* authorize(receipt, receipt.intent.invocation.context, options);
        if (receipt.state === "unknown") {
          return yield* Effect.fail(
            new UnknownOutcome({
              operationId: key.operationId,
              reason: receipt.reason,
            })
          );
        }
        if (receipt.state !== "claimed") {
          return { dispatch: false, receipt };
        }
        if (receipt.intent.invocation.tool.effect === "write" || approval) {
          const matches =
            approval &&
            (yield* boundApprovalMatches(
              approval,
              receipt.intent.invocation,
              receipt.intent.policyVersion,
              now()
            ).pipe(
              Effect.mapError(
                () => new InvalidInput({ reason: "Invalid bound approval" })
              )
            ));
          if (!matches) {
            return yield* Effect.fail(
              new Denied({
                code: "approval-required",
                reason: "A matching current approval is required",
              })
            );
          }
        }
        const result = yield* mutate(key, options, (current) => {
          if (current.state === "unknown") {
            throw new UnknownOutcome({
              operationId: key.operationId,
              reason: current.reason,
            });
          }
          if (current.state !== "claimed") {
            return { dispatch: false, receipt: current };
          }
          if (current.revision !== expectedRevision) {
            throw new Conflict({
              code: "version-mismatch",
              reason: "Receipt revision changed",
            });
          }
          if (approval && approval.expiresAt <= now()) {
            throw new Denied({
              code: "revoked",
              reason: "Approval expired before dispatch",
            });
          }
          fence(current);
          return {
            dispatch: true,
            receipt: save({
              dispatchedAt: now(),
              intent: current.intent,
              key: current.key,
              revision: current.revision + 1,
              state: "dispatched",
            }),
          };
        });
        yield* flush();
        return result;
      }),
    read: (key, context, options) =>
      Effect.gen(function* read() {
        const receipt = yield* attempt(() => load(key));
        yield* authorize(receipt, context, options);
        return structuredClone(receipt);
      }),
    recordOutcome: (key, input, options) =>
      Effect.gen(function* recordOutcome() {
        const outcome: ReceiptOutcome = yield* parseInput(() =>
          Schema.decodeUnknownSync(outcomeSchema)(structuredClone(input), {
            onExcessProperty: "error",
          })
        );
        yield* (
          configuration.checkpoint?.(
            "before-result-persistence",
            key.operationId
          ) ?? Effect.void
        );
        const result = yield* mutate(key, options, (receipt) => {
          if (receipt.state === "outcome" || receipt.state === "completed") {
            if (
              canonicalToolArguments(receipt.outcome) !==
              canonicalToolArguments(outcome)
            ) {
              throw new Conflict({
                code: "already-final",
                reason: "Confirmed outcome is immutable",
              });
            }
            return receipt;
          }
          if (receipt.state !== "dispatched" && receipt.state !== "unknown") {
            throw new Conflict({
              code: "version-mismatch",
              reason: "Effect has not been dispatched",
            });
          }
          return save({
            intent: receipt.intent,
            key: receipt.key,
            outcome,
            revision: receipt.revision + 1,
            state: "outcome",
          });
        });
        yield* (
          configuration.checkpoint?.(
            "after-result-persistence",
            key.operationId
          ) ?? Effect.void
        );
        return result;
      }),
    unknown: (key, reason, providerReceipt, options) =>
      mutate(key, options, (receipt) => {
        if (receipt.state === "unknown") {
          return receipt;
        }
        if (receipt.state !== "dispatched") {
          throw new Conflict({
            code: "already-final",
            reason: "Only dispatched effects can be uncertain",
          });
        }
        if (!reason.trim()) {
          throw new InvalidInput({
            reason: "Unknown outcome requires a reason",
          });
        }
        return save({
          intent: receipt.intent,
          key: receipt.key,
          ...(providerReceipt === undefined ? {} : { providerReceipt }),
          reason,
          revision: receipt.revision + 1,
          state: "unknown",
        });
      }),
  };
  return { layer: Layer.succeed(ToolReceiptStore, service), service };
};
