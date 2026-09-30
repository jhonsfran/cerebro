import { classifyEventDelivery } from "@cerebro/contracts/events";
import type { EventAddress, EventEnvelope } from "@cerebro/contracts/events";
import { id } from "@cerebro/contracts/identity";
import type {
  Digest,
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
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type {
  Approval,
  ToolExecution,
  ToolInvocation,
} from "@cerebro/contracts/tools";

import type {
  OutboxEvent,
  StoredApprovalRequest,
  StoredInvocation,
  StoredRun,
} from "./ledger-records.ts";
import type { PinnedAgentConfig } from "./pinned-agent.ts";
import { LedgerStore } from "./storage/ledger-store.ts";
import { migrateLedger } from "./storage/migrate.ts";

export type {
  OutboxEvent,
  StoredApprovalRequest,
  StoredInvocation,
  StoredRun,
} from "./ledger-records.ts";

type NewStreamItem = SessionStreamItem extends infer Item
  ? Item extends SessionStreamItem
    ? Omit<Item, "cursor">
    : never
  : never;

const auditPayload = (item: NewStreamItem): unknown => {
  if (item.type === "output") {
    return {
      dependencies: item.dependencies,
      runId: item.runId,
      type: item.type,
    };
  }
  if (item.type === "tool") {
    return {
      dependencies: item.dependencies,
      operationId: item.operationId,
      runId: item.runId,
      toolId: item.toolId,
      type: item.type,
    };
  }
  if (item.type === "citation") {
    return {
      dependencies: item.dependencies,
      runId: item.runId,
      sourceId: item.citation.sourceId,
      sourceVersion: item.citation.sourceVersion,
      type: item.type,
    };
  }
  return item;
};

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
  private readonly store: LedgerStore;
  private readonly storage: DurableObjectStorage;

  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    migrateLedger(storage);
    this.store = new LedgerStore(storage);
  }

  private claimOperation(
    operationId: OperationId,
    kind: string,
    digest: Digest
  ): boolean {
    const current = this.store.read("identity", operationId);
    if (current) {
      return current.kind === kind && current.digest === digest;
    }
    this.store.write("identity", operationId, { digest, kind });
    return true;
  }

  private row(key: string): string | undefined {
    return this.store.readSession(key);
  }

  private setRow(key: string, value: string): void {
    this.store.writeSession(key, value);
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

  append(runId: RunId, item: NewStreamItem): string {
    const cursor = this.nextSequence();
    const sequence = Number(cursor);
    this.store.write("stream", sequence.toString().padStart(16, "0"), {
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
      payload: structuredClone(auditPayload(item)),
      runId,
      sessionId: address.sessionId,
    };
    this.store.write("outbox", sequence.toString().padStart(16, "0"), outbox);
    return cursor;
  }

  recordToolOutput(item: Extract<NewStreamItem, { type: "tool" }>): string {
    return this.storage.transactionSync(() => {
      const previous =
        this.store.read("tool-output", item.operationId) ??
        this.existingToolOutput(item.operationId);
      if (previous) {
        const { cursor, ...recorded } = previous;
        if (canonicalToolArguments(recorded) !== canonicalToolArguments(item)) {
          throw new Error("Tool output operation identity changed.");
        }
        this.store.write("tool-output", item.operationId, previous);
        return cursor;
      }
      const cursor = this.append(item.runId, item);
      this.store.write("tool-output", item.operationId, { ...item, cursor });
      return cursor;
    });
  }

  private existingToolOutput(
    operationId: OperationId
  ): Extract<SessionStreamItem, { type: "tool" }> | undefined {
    const [row] = this.storage.sql
      .exec<{ result: string }>(
        "SELECT result FROM cerebro_operation WHERE kind='stream' AND json_valid(result) AND json_extract(result,'$.type')='tool' AND json_extract(result,'$.operationId')=? ORDER BY id LIMIT 1",
        operationId
      )
      .toArray();
    return row
      ? (JSON.parse(row.result) as Extract<SessionStreamItem, { type: "tool" }>)
      : undefined;
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
    this.store.write("outbox", sequence.padStart(16, "0"), event);
  }

  admit(
    event: EventEnvelope,
    options: EffectOptions,
    agent: PinnedAgentConfig
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
      const prior = this.store.read("inbox", event.eventId);
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
      const operation = this.store.read("submission", options.operationId);
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
        agent: structuredClone(agent),
        context: structuredClone(event.context),
        createdAt: Date.now(),
        eventId: event.eventId,
        operationId: options.operationId,
        prompt,
        requestDigest: options.requestDigest,
        runId,
        state: "queued",
      };
      this.store.write("inbox", event.eventId, {
        event,
        operationId: options.operationId,
        receipt,
        requestDigest: options.requestDigest,
      });
      this.store.write("submission", options.operationId, {
        receipt,
        requestDigest: options.requestDigest,
      });
      this.store.write("decision", options.operationId, {
        choice: "run",
        inputDigest: event.payloadDigest,
        modelVersion: "direct-run-v1",
        usage: { unit: "decision-units", units: 0 },
      });
      this.store.write("run", runId, run);
      this.append(runId, { run: toRunState(run), type: "run" });
      return { status: "ok", value: receipt };
    });
  }

  run(runId: RunId): StoredRun | undefined {
    return this.store.read("run", runId);
  }

  runs(): StoredRun[] {
    return this.store.list("run");
  }

  updateRun(runId: RunId, update: (run: StoredRun) => StoredRun): StoredRun {
    return this.storage.transactionSync(() => {
      const current = this.run(runId);
      if (!current) {
        throw new Error("Run does not exist");
      }
      const next = update(current);
      this.store.write("run", runId, next);
      this.append(runId, { run: toRunState(next), type: "run" });
      if (next.output && next.output !== current.output) {
        this.append(runId, {
          dependencies: next.dependencies,
          runId,
          text: next.output,
          type: "output",
        });
      }
      return next;
    });
  }

  claimInvocation(
    invocation: ToolInvocation,
    runId: RunId,
    idempotent: boolean,
    sdkCallId: string,
    modelAttemptId: string,
    approval: StoredApprovalRequest | undefined
  ): {
    kind: "claimed" | "running" | "result" | "unknown" | "conflict";
    record?: StoredInvocation;
  } {
    return this.storage.transactionSync(() => {
      const run = this.run(runId);
      if (
        !run ||
        run.state === "completed" ||
        run.state === "failed" ||
        run.state === "cancelled" ||
        run.state === "unknown-outcome"
      ) {
        return { kind: "conflict" };
      }
      const current = this.store.read("invocation", invocation.operationId);
      if (current) {
        if (
          current.argumentDigest !== invocation.argumentDigest ||
          current.invocation.tool.version !== invocation.tool.version ||
          current.runId !== runId ||
          current.idempotent !== idempotent
        ) {
          return { kind: "conflict" };
        }
        if (
          !current.sdkCallIds.includes(sdkCallId) &&
          current.boundModelAttemptId === modelAttemptId
        ) {
          return { kind: "conflict" };
        }
        const bound = current.sdkCallIds.includes(sdkCallId)
          ? current
          : {
              ...current,
              boundModelAttemptId: modelAttemptId,
              sdkCallIds: [...current.sdkCallIds, sdkCallId],
            };
        if (bound !== current) {
          this.store.write("invocation", invocation.operationId, bound);
        }
        if (bound.state === "succeeded") {
          return { kind: "result", record: bound };
        }
        return {
          kind: bound.state === "unknown-outcome" ? "unknown" : "running",
          record: bound,
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
        boundModelAttemptId: modelAttemptId,
        idempotent,
        invocation: structuredClone(invocation),
        operationId: invocation.operationId,
        originModelAttemptId: modelAttemptId,
        runId,
        sdkCallIds: [sdkCallId],
        state: approval ? "waiting-for-approval" : "requested",
      };
      this.store.write("invocation", invocation.operationId, record);
      if (approval) {
        this.store.write("approval", approval.id, approval);
        this.append(runId, {
          approvalId: approval.id,
          runId,
          type: "approval",
        });
        this.store.write("run", runId, {
          ...run,
          state: "waiting-for-approval",
        });
        this.append(runId, {
          run: toRunState({ ...run, state: "waiting-for-approval" }),
          type: "run",
        });
      }
      this.audit(runId, "tool.requested", {
        operationId: invocation.operationId,
        toolId: invocation.tool.id,
        toolVersion: invocation.tool.version,
      });
      return { kind: "claimed", record };
    });
  }

  invocation(operationId: OperationId): StoredInvocation | undefined {
    return this.store.read("invocation", operationId);
  }

  invocations(): StoredInvocation[] {
    return this.store.list("invocation");
  }

  hasRetryableInvocation(runId: RunId): boolean {
    return this.invocations().some(
      (invocation) =>
        invocation.runId === runId &&
        invocation.state === "running" &&
        invocation.idempotent
    );
  }

  approval(approvalId: string): StoredApprovalRequest | undefined {
    return this.store.read("approval", approvalId);
  }

  grant(operationId: OperationId): Approval | undefined {
    return this.store.read("approval-grant", `approval:${operationId}`);
  }

  startInvocation(operationId: OperationId): StoredInvocation | undefined {
    return this.storage.transactionSync(() => {
      const current = this.invocation(operationId);
      const grant = this.grant(operationId);
      const run = current ? this.run(current.runId) : undefined;
      if (
        !current ||
        current.state !== "requested" ||
        !run ||
        (run.state !== "queued" && run.state !== "running") ||
        (current.invocation.tool.effect === "write" && !grant) ||
        (grant &&
          (grant.operationId !== operationId ||
            grant.argumentDigest !== current.argumentDigest ||
            grant.toolId !== current.invocation.tool.id ||
            grant.toolVersion !== current.invocation.tool.version ||
            grant.expiresAt <= Date.now()))
      ) {
        return;
      }
      const next: StoredInvocation = {
        ...current,
        attemptId: crypto.randomUUID(),
        state: "running",
      };
      this.store.write("invocation", operationId, next);
      return next;
    });
  }

  finishInvocation(operationId: OperationId, result: ToolExecution): void {
    this.storage.transactionSync(() => {
      const current = this.invocation(operationId);
      if (!current || current.state !== "running") {
        throw new Error("Invocation is not running");
      }
      this.store.write("invocation", operationId, {
        ...current,
        providerReceipt: result.providerReceipt,
        result: structuredClone(result),
        state: "succeeded",
      } satisfies StoredInvocation);
      this.audit(current.runId, "tool.succeeded", {
        operationId,
        providerReceipt: result.providerReceipt,
      });
    });
  }

  markUnknownOutcome(operationId: OperationId): void {
    this.storage.transactionSync(() => {
      const current = this.invocation(operationId);
      if (!current || current.state !== "running") {
        return;
      }
      const run = this.run(current.runId);
      if (!run) {
        throw new Error("Invocation run is missing");
      }
      this.store.write("invocation", operationId, {
        ...current,
        state: "unknown-outcome",
      } satisfies StoredInvocation);
      const next: StoredRun = {
        ...run,
        state: run.state === "cancelled" ? "cancelled" : "unknown-outcome",
      };
      this.store.write("run", run.runId, next);
      this.append(run.runId, { run: toRunState(next), type: "run" });
    });
  }

  approve(
    approvalId: string,
    approverId: PrincipalId,
    options: EffectOptions
  ): PortResult<RunState> {
    return this.storage.transactionSync(() => {
      const existing = this.store.read("control", options.operationId);
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
      this.store.write("approval-event", options.operationId, {
        approvalId,
        grantedAt: Date.now(),
        operationId: approval.operationId,
      });
      this.store.write("approval-grant", approvalId, {
        ...approval,
        approverId,
      } satisfies Approval);
      this.store.write("invocation", approval.operationId, {
        ...invocation,
        state: "requested",
      });
      const next = { ...run, state: "queued" as const };
      this.store.write("run", run.runId, next);
      const state = toRunState(next);
      this.append(run.runId, { run: state, type: "run" });
      this.audit(run.runId, "approval.granted", { approvalId, approverId });
      this.store.write("control", options.operationId, {
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
      const existing = this.store.read("control", options.operationId);
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
      const cancelledAt = Date.now();
      const next: StoredRun = {
        ...run,
        endedAt: cancelledAt,
        state: "cancelled",
      };
      this.store.write("cancellation", options.operationId, {
        cancelledAt,
        runId,
      });
      this.store.write("run", runId, next);
      const state = toRunState(next);
      this.append(runId, { run: state, type: "run" });
      this.store.write("control", options.operationId, {
        digest: options.requestDigest,
        kind: "cancel",
        runId,
        state,
      });
      return { status: "ok", value: state };
    });
  }

  recordFailure(
    runId: RunId,
    stage: string,
    result: PortResult<unknown>
  ): void {
    this.storage.transactionSync(() => {
      const run = this.run(runId);
      if (!run || result.status === "ok") {
        return;
      }
      const operationId =
        "operationId" in result ? result.operationId : run.operationId;
      const code = "code" in result ? result.code : undefined;
      const key = `diagnostic:${runId}:${stage}:${operationId}:${result.status}:${code ?? ""}`;
      if (this.row(key)) {
        return;
      }
      this.setRow(key, "true");
      this.audit(runId, "runtime.failed", {
        code,
        operationId,
        runId,
        stage,
        status: result.status,
      });
    });
  }

  recordUsage(
    runId: RunId,
    operationId: OperationId,
    units: number,
    unit: string
  ): void {
    this.storage.transactionSync(() => {
      if (this.store.read("usage", operationId)) {
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
      this.store.write("usage", operationId, event);
      this.store.write("outbox", `usage:${operationId}`, event);
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
      agentVersion: runs.at(-1)?.agent.version ?? 0,
      cursor: this.row("sequence") ?? "0",
      runs: runs.map(toRunState),
    };
  }

  stream(cursor: string | undefined): SessionStreamItem[] {
    const after = Number(cursor ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new Error("Invalid stream cursor");
    }
    return this.store.streamAfter(String(after));
  }

  pendingOutbox(): OutboxEvent[] {
    return this.store.list("outbox");
  }

  acknowledgeOutbox(eventId: string): void {
    this.storage.transactionSync(() => {
      this.store.deleteOutbox(eventId);
    });
  }
}
