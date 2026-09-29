import { classifyEventDelivery } from "@cerebro/contracts/events";
import type { EventAddress, EventEnvelope } from "@cerebro/contracts/events";
import { id } from "@cerebro/contracts/identity";
import type {
  Digest,
  ExecutionContext,
  OperationId,
  PrincipalId,
  RunId,
} from "@cerebro/contracts/identity";
import type { EffectOptions, PortResult } from "@cerebro/contracts/port";
import type {
  RunState,
  SessionReceipt,
  SessionSnapshot,
  SessionStreamItem,
} from "@cerebro/contracts/session";
import type {
  Approval,
  ToolExecution,
  ToolInvocation,
} from "@cerebro/contracts/tools";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";

import { migrateLedger } from "./storage/migrate.ts";
import { operationRows, sessionRows } from "./storage/schema.ts";

export interface StoredRun {
  readonly runId: RunId;
  readonly eventId: EventEnvelope["eventId"];
  readonly operationId: OperationId;
  readonly requestDigest: Digest;
  readonly agentVersion: number;
  readonly context: ExecutionContext;
  readonly prompt: string;
  readonly state: RunState["state"];
  readonly createdAt: number;
  readonly endedAt?: number;
  readonly output?: string;
  readonly opencodeSessionId?: string;
  readonly messageId?: string;
}

export interface StoredInvocation {
  readonly operationId: OperationId;
  readonly runId: RunId;
  readonly argumentDigest: Digest;
  readonly invocation: ToolInvocation;
  readonly idempotent: boolean;
  readonly state: ToolInvocation["state"];
  readonly result?: ToolExecution;
  readonly providerReceipt?: string;
  readonly attemptId?: string;
  readonly sdkCallIds: readonly string[];
}

export interface OutboxEvent {
  readonly eventId: string;
  readonly organizationId: EventAddress["organizationId"];
  readonly agentId: EventAddress["agentId"];
  readonly sessionId: EventAddress["sessionId"];
  readonly runId: RunId;
  readonly kind: "audit" | "usage";
  readonly name: string;
  readonly occurredAt: number;
  readonly payload: unknown;
}

export type StoredApprovalRequest = Omit<Approval, "approverId">;

interface InboxRecord {
  readonly event: EventEnvelope;
  readonly operationId: OperationId;
  readonly requestDigest: Digest;
  readonly receipt: SessionReceipt;
}

type NewStreamItem = SessionStreamItem extends infer Item
  ? Item extends SessionStreamItem
    ? Omit<Item, "cursor">
    : never
  : never;

const addressMatches = (a: EventAddress, b: EventAddress): boolean =>
  a.organizationId === b.organizationId &&
  a.agentId === b.agentId &&
  a.conversationId === b.conversationId &&
  a.sessionId === b.sessionId;

const toRunState = (run: StoredRun): RunState => {
  if (run.state === "completed") {
    return {
      completedAt: run.endedAt ?? run.createdAt,
      runId: run.runId,
      state: "completed",
    };
  }
  if (run.state === "failed" || run.state === "cancelled") {
    return {
      endedAt: run.endedAt ?? run.createdAt,
      runId: run.runId,
      state: run.state,
    };
  }
  if (run.state === "unknown-outcome") {
    return {
      operationId: run.operationId,
      runId: run.runId,
      state: "unknown-outcome",
    };
  }
  return { runId: run.runId, state: run.state };
};

export class SessionLedger {
  private readonly db;
  private readonly storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    migrateLedger(storage);
    this.db = drizzle(storage);
  }

  private read<T>(key: string): T | undefined {
    return this.db
      .select()
      .from(operationRows)
      .where(eq(operationRows.id, key))
      .get()?.result as T | undefined;
  }

  private put(key: string, value: unknown): void {
    this.db
      .insert(operationRows)
      .values({ id: key, result: structuredClone(value) })
      .onConflictDoUpdate({
        set: { result: structuredClone(value) },
        target: operationRows.id,
      })
      .run();
  }

  private claimOperation(
    operationId: OperationId,
    kind: string,
    digest: Digest
  ): boolean {
    const key = `identity:${operationId}`;
    const current = this.read<{ kind: string; digest: Digest }>(key);
    if (current) {
      return current.kind === kind && current.digest === digest;
    }
    this.put(key, { digest, kind });
    return true;
  }

  private row(key: string): string | undefined {
    return this.db
      .select()
      .from(sessionRows)
      .where(eq(sessionRows.key, key))
      .get()?.sessionId;
  }

  private setRow(key: string, value: string): void {
    this.db
      .insert(sessionRows)
      .values({ key, sessionId: value })
      .onConflictDoUpdate({
        set: { sessionId: value },
        target: sessionRows.key,
      })
      .run();
  }

  address(): EventAddress | undefined {
    const value = this.row("address");
    return value ? (JSON.parse(value) as EventAddress) : undefined;
  }

  openCodeSessionId(): string | undefined {
    return this.row("opencode");
  }

  saveOpenCodeSessionId(sessionId: string): void {
    this.storage.transactionSync(() => {
      const current = this.openCodeSessionId();
      if (current && current !== sessionId) {
        throw new Error("OpenCode session identity changed");
      }
      this.setRow("opencode", sessionId);
    });
  }

  bind(address: EventAddress): boolean {
    return this.storage.transactionSync(() => {
      const current = this.address();
      if (current) {
        return addressMatches(current, address);
      }
      this.setRow("address", JSON.stringify(address));
      this.setRow("sequence", "0");
      return true;
    });
  }

  private append(runId: RunId, item: NewStreamItem): string {
    const cursor = this.nextSequence();
    const sequence = Number(cursor);
    this.put(`stream:${sequence.toString().padStart(16, "0")}`, {
      ...item,
      cursor,
    });
    const address = this.address();
    if (!address) {
      throw new Error("Session address is missing");
    }
    const outbox: OutboxEvent = {
      agentId: address.agentId,
      eventId: `${address.sessionId}:${cursor}`,
      kind: "audit",
      name: item.type,
      occurredAt: Date.now(),
      organizationId: address.organizationId,
      payload: structuredClone(item),
      runId,
      sessionId: address.sessionId,
    };
    this.put(`outbox:${sequence.toString().padStart(16, "0")}`, outbox);
    return cursor;
  }

  private nextSequence(): string {
    const sequence = Number(this.row("sequence") ?? "0") + 1;
    if (!Number.isSafeInteger(sequence)) {
      throw new TypeError("Session event sequence is exhausted");
    }
    const cursor = String(sequence);
    this.setRow("sequence", cursor);
    return cursor;
  }

  private audit(runId: RunId, name: string, payload: unknown): void {
    const address = this.address();
    if (!address) {
      throw new Error("Session address is missing");
    }
    const sequence = this.nextSequence();
    const event: OutboxEvent = {
      agentId: address.agentId,
      eventId: `${address.sessionId}:${sequence}`,
      kind: "audit",
      name,
      occurredAt: Date.now(),
      organizationId: address.organizationId,
      payload: structuredClone(payload),
      runId,
      sessionId: address.sessionId,
    };
    this.put(`outbox:${sequence.padStart(16, "0")}`, event);
  }

  admit(
    event: EventEnvelope,
    options: EffectOptions,
    agentVersion: number
  ): PortResult<SessionReceipt> {
    if (!this.bind(event)) {
      return {
        code: "version-mismatch",
        reason: "Session address differs",
        status: "conflict",
      };
    }
    if (
      event.event.type !== "user.message" &&
      event.event.type !== "scheduled.run"
    ) {
      return {
        reason: "This event cannot create a run",
        status: "invalid-input",
      };
    }
    const prompt =
      event.event.type === "user.message"
        ? event.event.payload.text
        : event.event.payload.task;
    return this.storage.transactionSync(() => {
      const prior = this.read<InboxRecord>(`inbox:${event.eventId}`);
      if (prior) {
        if (
          classifyEventDelivery(prior.event, event) !== "duplicate" ||
          prior.operationId !== options.operationId ||
          prior.requestDigest !== options.requestDigest
        ) {
          return {
            code: "digest-mismatch",
            reason: "Event replay differs",
            status: "conflict",
          };
        }
        return { status: "ok", value: { ...prior.receipt, replayed: true } };
      }
      const operation = this.read<{
        requestDigest: Digest;
        receipt: SessionReceipt;
      }>(`submission:${options.operationId}`);
      if (operation) {
        return {
          code: "digest-mismatch",
          reason: "Operation ID was already used",
          status: "conflict",
        };
      }
      if (
        !this.claimOperation(
          options.operationId,
          "submit",
          options.requestDigest
        )
      ) {
        return {
          code: "digest-mismatch",
          reason: "Operation ID belongs to another intent",
          status: "conflict",
        };
      }
      const runId = id.run(`run:${event.eventId}`);
      const receipt: SessionReceipt = {
        acceptedEventId: event.eventId,
        replayed: false,
        runId,
        sessionId: event.sessionId,
      };
      const run: StoredRun = {
        agentVersion,
        context: structuredClone(event.context),
        createdAt: Date.now(),
        eventId: event.eventId,
        operationId: options.operationId,
        prompt,
        requestDigest: options.requestDigest,
        runId,
        state: "queued",
      };
      this.put(`inbox:${event.eventId}`, {
        event,
        operationId: options.operationId,
        receipt,
        requestDigest: options.requestDigest,
      });
      this.put(`submission:${options.operationId}`, {
        receipt,
        requestDigest: options.requestDigest,
      });
      this.put(`decision:${options.operationId}`, {
        choice: "run",
        inputDigest: event.payloadDigest,
        modelVersion: "fixture-decision-v1",
        usage: { unit: "fixture-credits", units: 0 },
      });
      this.put(`run:${runId}`, run);
      this.append(runId, { run: toRunState(run), type: "run" });
      return { status: "ok", value: receipt };
    });
  }

  run(runId: RunId): StoredRun | undefined {
    return this.read<StoredRun>(`run:${runId}`);
  }

  runs(): StoredRun[] {
    return this.db
      .select()
      .from(operationRows)
      .where(like(operationRows.id, "run:%"))
      .all()
      .map((row) => row.result as StoredRun);
  }

  updateRun(runId: RunId, update: (run: StoredRun) => StoredRun): StoredRun {
    return this.storage.transactionSync(() => {
      const current = this.run(runId);
      if (!current) {
        throw new Error("Run does not exist");
      }
      const next = update(current);
      this.put(`run:${runId}`, next);
      this.append(runId, { run: toRunState(next), type: "run" });
      if (next.output && next.output !== current.output) {
        this.append(runId, { runId, text: next.output, type: "output" });
      }
      return next;
    });
  }

  claimInvocation(
    invocation: ToolInvocation,
    runId: RunId,
    idempotent: boolean
  ): {
    kind: "claimed" | "running" | "result" | "unknown" | "conflict";
    record?: StoredInvocation;
  } {
    return this.storage.transactionSync(() => {
      const key = `invocation:${invocation.operationId}`;
      const current = this.read<StoredInvocation>(key);
      if (current) {
        if (
          current.argumentDigest !== invocation.argumentDigest ||
          current.invocation.tool.version !== invocation.tool.version ||
          current.runId !== runId ||
          current.idempotent !== idempotent
        ) {
          return { kind: "conflict" };
        }
        if (current.state === "succeeded") {
          return { kind: "result", record: current };
        }
        return {
          kind: current.state === "unknown-outcome" ? "unknown" : "running",
          record: current,
        };
      }
      if (
        !this.claimOperation(
          invocation.operationId,
          "tool",
          invocation.argumentDigest
        )
      ) {
        return { kind: "conflict" };
      }
      const record: StoredInvocation = {
        argumentDigest: invocation.argumentDigest,
        idempotent,
        invocation: structuredClone(invocation),
        operationId: invocation.operationId,
        runId,
        sdkCallIds: [],
        state: "requested",
      };
      this.put(key, record);
      this.audit(runId, "tool.requested", {
        operationId: invocation.operationId,
        toolId: invocation.tool.id,
        toolVersion: invocation.tool.version,
      });
      return { kind: "claimed", record };
    });
  }

  invocation(operationId: OperationId): StoredInvocation | undefined {
    return this.read<StoredInvocation>(`invocation:${operationId}`);
  }

  invocations(): StoredInvocation[] {
    return this.db
      .select()
      .from(operationRows)
      .where(like(operationRows.id, "invocation:%"))
      .all()
      .map((row) => row.result as StoredInvocation);
  }

  updateInvocation(
    operationId: OperationId,
    update: (record: StoredInvocation) => StoredInvocation
  ): StoredInvocation {
    return this.storage.transactionSync(() => {
      const current = this.invocation(operationId);
      if (!current) {
        throw new Error("Invocation does not exist");
      }
      const next = update(current);
      this.put(`invocation:${operationId}`, next);
      this.audit(current.runId, `tool.${next.state}`, {
        operationId,
        providerReceipt: next.providerReceipt,
        toolId: next.invocation.tool.id,
        toolVersion: next.invocation.tool.version,
      });
      return next;
    });
  }

  putApproval(approval: StoredApprovalRequest, runId: RunId): boolean {
    return this.storage.transactionSync(() => {
      if (this.read<StoredApprovalRequest>(`approval:${approval.id}`)) {
        return false;
      }
      this.put(`approval:${approval.id}`, approval);
      this.append(runId, { approvalId: approval.id, runId, type: "approval" });
      return true;
    });
  }

  approval(approvalId: string): StoredApprovalRequest | undefined {
    return this.read<StoredApprovalRequest>(`approval:${approvalId}`);
  }

  approve(
    approvalId: string,
    approverId: PrincipalId,
    options: EffectOptions
  ): PortResult<RunState> {
    return this.storage.transactionSync(() => {
      const existing = this.read<{
        kind: string;
        digest: Digest;
        approvalId?: string;
        approverId?: PrincipalId;
        state: RunState;
      }>(`control:${options.operationId}`);
      if (existing) {
        return existing.kind === "approve" &&
          existing.approvalId === approvalId &&
          existing.approverId === approverId &&
          existing.digest === options.requestDigest
          ? { status: "ok", value: existing.state }
          : {
              code: "digest-mismatch",
              reason: "Approval operation differs",
              status: "conflict",
            };
      }
      const approval = this.approval(approvalId);
      if (!approval) {
        return { resource: "approval", status: "not-found" };
      }
      const invocation = this.invocation(approval.operationId);
      if (!invocation || invocation.state !== "waiting-for-approval") {
        return {
          code: "already-final",
          reason: "Invocation is not waiting for approval",
          status: "conflict",
        };
      }
      if (approval.expiresAt <= Date.now()) {
        return {
          code: "approval-required",
          reason: "Approval expired",
          status: "denied",
        };
      }
      if (
        approval.organizationId !== invocation.invocation.organizationId ||
        approval.operationId !== invocation.operationId ||
        approval.toolId !== invocation.invocation.tool.id ||
        approval.toolVersion !== invocation.invocation.tool.version ||
        approval.argumentDigest !== invocation.argumentDigest
      ) {
        return {
          code: "digest-mismatch",
          reason: "Approval request changed",
          status: "conflict",
        };
      }
      const run = this.run(invocation.runId);
      if (!run || run.state !== "waiting-for-approval") {
        return {
          code: "already-final",
          reason: "Run is not waiting for approval",
          status: "conflict",
        };
      }
      if (
        !this.claimOperation(
          options.operationId,
          "approve",
          options.requestDigest
        )
      ) {
        return {
          code: "digest-mismatch",
          reason: "Operation ID belongs to another intent",
          status: "conflict",
        };
      }
      this.put(`approval-event:${options.operationId}`, {
        approvalId,
        grantedAt: Date.now(),
        operationId: approval.operationId,
      });
      this.put(`approval-grant:${approvalId}`, {
        ...approval,
        approverId,
      } satisfies Approval);
      this.put(`invocation:${approval.operationId}`, {
        ...invocation,
        state: "requested",
      });
      const next = { ...run, state: "queued" as const };
      this.put(`run:${run.runId}`, next);
      const state = toRunState(next);
      this.append(run.runId, { run: state, type: "run" });
      this.audit(run.runId, "approval.granted", { approvalId, approverId });
      this.put(`control:${options.operationId}`, {
        approvalId,
        approverId,
        digest: options.requestDigest,
        kind: "approve",
        state,
      });
      return { status: "ok", value: state };
    });
  }

  cancel(runId: RunId, options: EffectOptions): PortResult<RunState> {
    return this.storage.transactionSync(() => {
      const existing = this.read<{
        kind: string;
        digest: Digest;
        runId: RunId;
        state: RunState;
      }>(`control:${options.operationId}`);
      if (existing) {
        return existing.kind === "cancel" &&
          existing.runId === runId &&
          existing.digest === options.requestDigest
          ? { status: "ok", value: existing.state }
          : {
              code: "digest-mismatch",
              reason: "Cancellation operation differs",
              status: "conflict",
            };
      }
      const run = this.run(runId);
      if (!run) {
        return { resource: "run", status: "not-found" };
      }
      if (
        run.state === "completed" ||
        run.state === "failed" ||
        run.state === "cancelled" ||
        run.state === "unknown-outcome"
      ) {
        return {
          code: "already-final",
          reason: "Run is final",
          status: "conflict",
        };
      }
      if (
        !this.claimOperation(
          options.operationId,
          "cancel",
          options.requestDigest
        )
      ) {
        return {
          code: "digest-mismatch",
          reason: "Operation ID belongs to another intent",
          status: "conflict",
        };
      }
      const next: StoredRun = {
        ...run,
        endedAt: Date.now(),
        state: "cancelled",
      };
      this.put(`cancellation:${options.operationId}`, {
        cancelledAt: next.endedAt,
        runId,
      });
      this.put(`run:${runId}`, next);
      const state = toRunState(next);
      this.append(runId, { run: state, type: "run" });
      this.put(`control:${options.operationId}`, {
        digest: options.requestDigest,
        kind: "cancel",
        runId,
        state,
      });
      return { status: "ok", value: state };
    });
  }

  recordDecision(operationId: OperationId, decision: unknown): unknown {
    return this.storage.transactionSync(() => {
      const key = `decision:${operationId}`;
      const current = this.read<unknown>(key);
      if (current !== undefined) {
        return current;
      }
      this.put(key, decision);
      return structuredClone(decision);
    });
  }

  recordUsage(
    runId: RunId,
    operationId: OperationId,
    units: number,
    unit: string
  ): void {
    this.storage.transactionSync(() => {
      if (this.read(`usage:${operationId}`)) {
        return;
      }
      const address = this.address();
      if (!address) {
        throw new Error("Session address is missing");
      }
      const event: OutboxEvent = {
        agentId: address.agentId,
        eventId: `${address.sessionId}:usage:${operationId}`,
        kind: "usage",
        name: "usage.recorded",
        occurredAt: Date.now(),
        organizationId: address.organizationId,
        payload: { operationId, unit, units },
        runId,
        sessionId: address.sessionId,
      };
      this.put(`usage:${operationId}`, event);
      this.put(`outbox:usage:${operationId}`, event);
    });
  }

  snapshot(): SessionSnapshot | undefined {
    const address = this.address();
    if (!address) {
      return undefined;
    }
    const runs = this.runs();
    return {
      address,
      agentVersion: runs.at(-1)?.agentVersion ?? 0,
      cursor: this.row("sequence") ?? "0",
      runs: runs.map(toRunState),
    };
  }

  stream(cursor: string | undefined): SessionStreamItem[] {
    const after = Number(cursor ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("Invalid stream cursor");
    }
    return this.db
      .select()
      .from(operationRows)
      .where(like(operationRows.id, "stream:%"))
      .all()
      .filter((row) => Number(row.id.slice(7)) > after)
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map((row) => row.result as SessionStreamItem);
  }

  pendingOutbox(): OutboxEvent[] {
    return this.db
      .select()
      .from(operationRows)
      .where(like(operationRows.id, "outbox:%"))
      .all()
      .toSorted((a, b) => a.id.localeCompare(b.id))
      .map((row) => row.result as OutboxEvent);
  }

  acknowledgeOutbox(eventId: string): void {
    this.storage.transactionSync(() => {
      const event = this.db
        .select()
        .from(operationRows)
        .where(like(operationRows.id, "outbox:%"))
        .all()
        .find((row) => (row.result as OutboxEvent).eventId === eventId);
      if (event) {
        this.db
          .delete(operationRows)
          .where(eq(operationRows.id, event.id))
          .run();
      }
    });
  }
}
