import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

import type { EffectResult } from "./effect-tool";

export type EffectMode = "idempotent" | "non-idempotent";
export interface SDKAttempt {
  messageId: string;
  callId: string;
}
interface InvocationIdentity {
  invocationId: string;
  digest: string;
  sdkAttempts: SDKAttempt[];
  attempts: number;
}
export type RecoveryInvocation = InvocationIdentity &
  (
    | { state: "waiting-for-approval" | "approved" }
    | { state: "executing"; attemptId: string; instanceId: string }
    | {
        state: "completed";
        attemptId: string;
        instanceId: string;
        result: EffectResult;
      }
    | {
        state: "unknown-outcome";
        attemptId: string;
        instanceId: string;
        reason: string;
      }
  );
export type RecoveryOutcome =
  | { state: "active" }
  | { state: "completed"; reply: string }
  | { state: "unknown-outcome" | "failed"; error: string };
export interface ToolDiagnostic {
  tool:
    | "fixture_effect"
    | "shell"
    | "webfetch"
    | "execute"
    | "mcp_unregistered";
  status: "streaming" | "running" | "completed" | "error";
  callId: string;
  messageId: string;
  errorKind: "unknown-tool" | "denied" | "other" | null;
  resultMatchesLedger: boolean;
}
export interface RecoveryRun {
  operationId: string;
  toolDiagnostics: ToolDiagnostic[];
  requestDigest: string;
  mode: EffectMode;
  holdAfterEffect: boolean;
  notBefore: number;
  sessionId: string | null;
  messageId: string;
  modelAttemptId: string | null;
  modelAttempts: string[];
  approvalEvents: { eventId: string; digest: string }[];
  invocation: RecoveryInvocation | null;
  outcome: RecoveryOutcome;
}

const operations = sqliteTable("cerebro_operation", {
  id: text("id").primaryKey(),
  result: text("result", { mode: "json" }).$type<RecoveryRun>().notNull(),
});

export class RecoveryLedger {
  private readonly db;

  constructor(storage: DurableObjectStorage) {
    this.db = drizzle(storage);
    this.db.run(
      sql`CREATE TABLE IF NOT EXISTS cerebro_operation (id TEXT PRIMARY KEY, result TEXT)`
    );
  }

  read(): RecoveryRun | null {
    return (
      this.db
        .select()
        .from(operations)
        .where(eq(operations.id, "recovery"))
        .get()?.result ?? null
    );
  }

  create(run: RecoveryRun): void {
    this.db.insert(operations).values({ id: "recovery", result: run }).run();
  }

  update(change: (run: RecoveryRun) => RecoveryRun): RecoveryRun {
    const current = this.read();
    if (!current) {
      throw new Error("Recovery operation does not exist");
    }
    const next = change(current);
    this.db
      .update(operations)
      .set({ result: next })
      .where(eq(operations.id, "recovery"))
      .run();
    return next;
  }
}

export const recoveryView = (run: RecoveryRun) => {
  let status: string = run.outcome.state;
  if (run.outcome.state === "active") {
    status = run.modelAttemptId ? "running" : "accepted";
    if (run.invocation && run.invocation.state !== "completed") {
      status = run.invocation.state;
    }
  }
  return {
    approvalEvents: run.approvalEvents,
    error: "error" in run.outcome ? run.outcome.error : null,
    holdAfterEffect: run.holdAfterEffect,
    invocation: run.invocation
      ? {
          ...run.invocation,
          attemptId:
            "attemptId" in run.invocation ? run.invocation.attemptId : null,
          instanceId:
            "instanceId" in run.invocation ? run.invocation.instanceId : null,
          result:
            run.invocation.state === "completed" ? run.invocation.result : null,
        }
      : null,
    messageId: run.messageId,
    mode: run.mode,
    modelAttempts: run.modelAttempts,
    notBefore: run.notBefore,
    operationId: run.operationId,
    reply: run.outcome.state === "completed" ? run.outcome.reply : null,
    requestDigest: run.requestDigest,
    sessionId: run.sessionId,
    status,
    toolDiagnostics: run.toolDiagnostics,
  };
};
