import { Conflict, Denied, NotFound } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import { ChatApproval } from "@cerebro/contracts/session-service";
import type {
  BoundApproval,
  BoundInvocation,
} from "@cerebro/contracts/tool-service";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import { Schema } from "effect";

const permitSchema = Schema.Struct({
  actorPrincipalId: Schema.NonEmptyString,
  agentId: Schema.NonEmptyString,
  approverId: Schema.NonEmptyString,
  argumentDigest: Schema.NonEmptyString,
  connectorFingerprint: Schema.NonEmptyString,
  connectorId: Schema.NonEmptyString,
  delegationId: Schema.optional(Schema.NonEmptyString),
  effect: Schema.Literals(["read", "write"]),
  expiresAt: Schema.Number,
  id: Schema.NonEmptyString,
  operationId: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
  policyVersion: Schema.NonEmptyString,
  principalId: Schema.NonEmptyString,
  runId: Schema.NonEmptyString,
  toolId: Schema.NonEmptyString,
  toolVersion: Schema.NonEmptyString,
});

const decodePermit = (json: string): BoundApproval => {
  const value = Schema.decodeUnknownSync(permitSchema)(JSON.parse(json));
  const { delegationId, ...fields } = value;
  return {
    ...fields,
    actorPrincipalId: id.principal(value.actorPrincipalId),
    agentId: id.agent(value.agentId),
    approverId: id.principal(value.approverId),
    argumentDigest: id.digest(value.argumentDigest),
    connectorFingerprint: id.digest(value.connectorFingerprint),
    ...(delegationId ? { delegationId: id.delegation(delegationId) } : {}),
    operationId: id.operation(value.operationId),
    organizationId: id.organization(value.organizationId),
    principalId: id.principal(value.principalId),
    runId: id.run(value.runId),
    toolId: id.tool(value.toolId),
  };
};
interface ApprovalRow {
  [column: string]: string;
  approval_id: string;
  arguments: string;
  call_id: string;
  permit: string;
  state: string;
  task_id: string;
}

const publicValue = (row: ApprovalRow): ChatApproval => {
  const permit = decodePermit(row.permit);
  return Schema.decodeUnknownSync(ChatApproval)({
    approvalId: row.approval_id,
    arguments: JSON.parse(row.arguments),
    callId: row.call_id,
    expiresAt: permit.expiresAt,
    operationId: permit.operationId,
    state:
      row.state === "pending" && permit.expiresAt <= Date.now()
        ? "expired"
        : row.state,
    taskId: row.task_id,
    toolId: permit.toolId,
  });
};
export const createApprovalStore = (storage: DurableObjectStorage) => {
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS cerebro_approval (approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, call_id TEXT NOT NULL, arguments TEXT NOT NULL, permit TEXT NOT NULL, state TEXT NOT NULL)"
  );
  const readRow = (approvalId: string): ApprovalRow => {
    const [row] = storage.sql
      .exec<ApprovalRow>(
        "SELECT * FROM cerebro_approval WHERE approval_id=?",
        approvalId
      )
      .toArray();
    if (!row) {
      throw new NotFound({ resource: "Tool approval" });
    }
    return row;
  };
  const read = (approvalId: string) => publicValue(readRow(approvalId));
  return {
    all: () =>
      storage.sql
        .exec<ApprovalRow>("SELECT * FROM cerebro_approval ORDER BY rowid")
        .toArray()
        .map(publicValue),
    cancel: (approvalId: string) => {
      storage.sql.exec(
        "UPDATE cerebro_approval SET state='cancelled' WHERE approval_id=? AND state='pending'",
        approvalId
      );
    },
    decide: (approvalId: string, decision: "allow" | "deny") => {
      const current = read(approvalId);
      const state = decision === "allow" ? "allowed" : "denied";
      if (current.state === state) {
        return current;
      }
      if (current.state !== "pending") {
        throw new Conflict({
          code: "already-final",
          reason: "The approval already has a final decision.",
        });
      }
      storage.sql.exec(
        "UPDATE cerebro_approval SET state=? WHERE approval_id=? AND state='pending'",
        state,
        approvalId
      );
      return read(approvalId);
    },
    permit: (operationId: string): BoundApproval | undefined => {
      const [row] = storage.sql
        .exec<ApprovalRow>(
          "SELECT * FROM cerebro_approval WHERE approval_id=? AND state='allowed'",
          `approval:${operationId}`
        )
        .toArray();
      if (!row) {
        return undefined;
      }
      const permit = decodePermit(row.permit);
      return permit.operationId === operationId && permit.expiresAt > Date.now()
        ? permit
        : undefined;
    },
    read,
    request: (
      invocation: BoundInvocation,
      candidate: BoundApproval,
      callId: string
    ): BoundApproval => {
      storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_approval VALUES (?, ?, ?, ?, ?, 'pending')",
        candidate.id,
        invocation.runId,
        callId,
        canonicalToolArguments(invocation.arguments),
        JSON.stringify(candidate)
      );
      const row = readRow(candidate.id);
      const permit = decodePermit(row.permit);
      if (
        permit.argumentDigest !== invocation.argumentDigest ||
        row.task_id !== invocation.runId ||
        row.call_id !== callId
      ) {
        throw new Conflict({
          code: "digest-mismatch",
          reason: "The native tool approval identity changed.",
        });
      }
      return permit;
    },
    requireAllowed: (approvalId: string): BoundApproval | undefined => {
      const row = readRow(approvalId);
      const current = publicValue(row);
      if (current.state === "allowed") {
        const permit = decodePermit(row.permit);
        if (permit.expiresAt <= Date.now()) {
          throw new Denied({
            code: "revoked",
            reason: "The tool approval expired.",
          });
        }
        return permit;
      }
      if (current.state !== "pending") {
        throw new Denied({
          code: "revoked",
          reason: "The tool approval was denied, cancelled, or expired.",
        });
      }
      return undefined;
    },
  };
};
