import { setTimeout as delay } from "node:timers/promises";

import type { EventAddress, EventEnvelope } from "@cerebro/contracts/events";
import { id, isExecutionContextActiveAt } from "@cerebro/contracts/identity";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { EffectOptions, PortResult } from "@cerebro/contracts/port";
import { preflightEffect } from "@cerebro/contracts/port";
import type {
  RunState,
  SessionReceipt,
  SessionSnapshot,
  SessionStreamItem,
} from "@cerebro/contracts/session";
import { approvalMatches, digestToolArguments } from "@cerebro/contracts/tools";
import type { ToolExecution, ToolInvocation } from "@cerebro/contracts/tools";
import type { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";
import { Agent } from "agents";

import { sameAddress, validateEvent } from "./event-handler.ts";
import {
  createFixtureToolExecutor,
  fixturePolicyVersion,
  fixtureTool,
  isFixtureInput,
} from "./fixture-tool.ts";
import { SessionLedger } from "./ledger.ts";
import type {
  StoredApprovalRequest,
  StoredInvocation,
  StoredRun,
} from "./ledger.ts";
import {
  createOpenCodeClient,
  fixturePrompt,
  fixtureReplyMatches,
  readFinalReply,
} from "./opencode-adapter.ts";
import type { ModelToolCall } from "./opencode-adapter.ts";
import { drainOutbox } from "./outbox.ts";
import { isPinnedAgent } from "./pinned-agent.ts";
import {
  recoverInterruptedInvocation,
  recoverInterruptedInvocations,
} from "./recovery.ts";
import { priorInvocationForCall, sdkCallKey } from "./tool-call-identity.ts";

export interface SessionEnvironment {
  readonly DEPLOY_MODE: "fixture" | "production";
  readonly FIXTURE_URL: string;
  readonly TOOL_GATEWAY: Fetcher;
  readonly AUDIT_SINK?: Fetcher;
  readonly POLICY_GATEWAY?: Fetcher;
  readonly TOOL_EFFECT_MODE: "idempotent" | "non-idempotent";
  readonly HOLD_AFTER_EFFECT?: "0" | "1";
}

const terminal = (state: RunState["state"]): boolean =>
  state === "completed" ||
  state === "failed" ||
  state === "cancelled" ||
  state === "unknown-outcome";

const parseBody = async (
  request: Request
): Promise<Record<string, unknown> | undefined> => {
  try {
    const value: unknown = await request.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const isAddress = (value: unknown): value is EventAddress =>
  !!value &&
  typeof value === "object" &&
  "organizationId" in value &&
  typeof value.organizationId === "string" &&
  "agentId" in value &&
  typeof value.agentId === "string" &&
  "conversationId" in value &&
  typeof value.conversationId === "string" &&
  "sessionId" in value &&
  typeof value.sessionId === "string";

const isEffectOptions = (value: unknown): value is EffectOptions =>
  !!value &&
  typeof value === "object" &&
  "operationId" in value &&
  typeof value.operationId === "string" &&
  "requestDigest" in value &&
  typeof value.requestDigest === "string" &&
  "deadlineAt" in value &&
  typeof value.deadlineAt === "number";

export class SessionAgent extends Agent<SessionEnvironment> {
  private ledger: SessionLedger | undefined;
  private client: Promise<OpenCodeWorkerd.Interface> | undefined;
  private modelTask: Promise<void> | undefined;
  private driveTask: Promise<void> | undefined;
  private activeRunId: StoredRun["runId"] | undefined;
  private modelAttemptId: string | undefined;

  private storage(): SessionLedger {
    this.ledger ??= new SessionLedger(this.ctx.storage);
    return this.ledger;
  }

  private matches(address: EventAddress): boolean {
    const current = this.storage().address();
    return !!current && sameAddress(current, address);
  }

  private async ensureWake(): Promise<void> {
    const schedules = await this.listSchedules();
    if (!schedules.some((schedule) => schedule.callback === "reconcile")) {
      await this.scheduleEvery(1, "reconcile", undefined, {
        retry: { maxAttempts: 1 },
      });
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const body = await parseBody(request);
    if (!body || request.method !== "POST") {
      return Response.json({
        reason: "Invalid session request",
        status: "invalid-input",
      } satisfies PortResult<never>);
    }
    const path = new URL(request.url).pathname;
    if (path === "/submit") {
      return await this.submit(body);
    }
    if (path === "/inspect" || path === "/stream") {
      return this.readSession(path, body);
    }
    if (path === "/approve" || path === "/cancel") {
      return path === "/approve" ? this.approve(body) : this.cancel(body);
    }
    return Response.json({
      resource: "session route",
      status: "not-found",
    } satisfies PortResult<never>);
  }

  private async submit(body: Record<string, unknown>): Promise<Response> {
    const { event, options, agent } = body;
    if (
      !isAddress(event) ||
      !isEffectOptions(options) ||
      !isPinnedAgent(agent) ||
      agent.organizationId !== event.organizationId ||
      agent.agentId !== event.agentId ||
      !("eventId" in event) ||
      typeof event.eventId !== "string" ||
      !("event" in event) ||
      !event.event ||
      typeof event.event !== "object"
    ) {
      return Response.json({
        reason: "Invalid event",
        status: "invalid-input",
      } satisfies PortResult<never>);
    }
    const preflight = preflightEffect(options, Date.now());
    if (preflight.status !== "ok") {
      return Response.json(preflight);
    }
    const validated = validateEvent(event as EventEnvelope, Date.now());
    if (validated.status !== "ok") {
      return Response.json(validated);
    }
    await this.ensureWake();
    const result = this.storage().admit(event as EventEnvelope, options, agent);
    if (result.status === "ok") {
      this.ctx.waitUntil(this.reconcile());
    }
    return Response.json(result satisfies PortResult<SessionReceipt>);
  }

  private readSession(path: string, body: Record<string, unknown>): Response {
    const { address, cursor } = body;
    if (!isAddress(address) || !this.matches(address)) {
      return Response.json({
        resource: "session",
        status: "not-found",
      } satisfies PortResult<never>);
    }
    if (path === "/inspect") {
      const snapshot = this.storage().snapshot();
      if (!snapshot) {
        return Response.json({
          resource: "session",
          status: "not-found",
        } satisfies PortResult<never>);
      }
      return Response.json({
        status: "ok",
        value: snapshot,
      } satisfies PortResult<SessionSnapshot>);
    }
    try {
      const items = this.storage().stream(
        typeof cursor === "string" ? cursor : undefined
      );
      return Response.json({ status: "ok", value: items } satisfies PortResult<
        SessionStreamItem[]
      >);
    } catch {
      return Response.json({
        reason: "Invalid cursor",
        status: "invalid-input",
      } satisfies PortResult<never>);
    }
  }

  private command(body: Record<string, unknown>):
    | {
        command: Record<string, unknown> & { address: EventAddress };
        options: EffectOptions;
      }
    | undefined {
    const { command, options } = body;
    if (
      !command ||
      typeof command !== "object" ||
      !("address" in command) ||
      !isAddress(command.address) ||
      !this.matches(command.address) ||
      !isEffectOptions(options)
    ) {
      return undefined;
    }
    return {
      command: command as Record<string, unknown> & { address: EventAddress },
      options,
    };
  }

  private approve(body: Record<string, unknown>): Response {
    const parsed = this.command(body);
    if (!parsed) {
      return Response.json({
        reason: "Invalid command",
        status: "invalid-input",
      } satisfies PortResult<never>);
    }
    const { command, options } = parsed;
    if (
      typeof command.approvalId !== "string" ||
      !command.context ||
      typeof command.context !== "object" ||
      !("actor" in command.context) ||
      !command.context.actor ||
      typeof command.context.actor !== "object" ||
      !("id" in command.context.actor) ||
      typeof command.context.actor.id !== "string"
    ) {
      return Response.json({
        reason: "Invalid approval",
        status: "invalid-input",
      } satisfies PortResult<never>);
    }
    if (
      !isExecutionContextActiveAt(
        command.context as ExecutionContext,
        command.address.organizationId,
        Date.now()
      )
    ) {
      return Response.json({
        code: "unauthorized",
        reason: "Approver context is inactive",
        status: "denied",
      } satisfies PortResult<never>);
    }
    const result = this.storage().approve(
      command.approvalId,
      id.principal(command.context.actor.id),
      options
    );
    if (result.status === "ok") {
      this.ctx.waitUntil(this.reconcile());
    }
    return Response.json(result satisfies PortResult<RunState>);
  }

  private cancel(body: Record<string, unknown>): Response {
    const parsed = this.command(body);
    if (!parsed) {
      return Response.json({
        reason: "Invalid command",
        status: "invalid-input",
      } satisfies PortResult<never>);
    }
    const { command, options } = parsed;
    if (typeof command.runId !== "string") {
      return Response.json({
        reason: "Invalid cancellation",
        status: "invalid-input",
      } satisfies PortResult<never>);
    }
    if (
      !command.context ||
      typeof command.context !== "object" ||
      !("actor" in command.context) ||
      !command.context.actor ||
      !isExecutionContextActiveAt(
        command.context as ExecutionContext,
        command.address.organizationId,
        Date.now()
      )
    ) {
      return Response.json({
        code: "unauthorized",
        reason: "Canceller context is inactive",
        status: "denied",
      } satisfies PortResult<never>);
    }
    const result = this.storage().cancel(id.run(command.runId), options);
    if (result.status === "ok") {
      this.ctx.waitUntil(this.interruptModel());
    }
    return Response.json(result satisfies PortResult<RunState>);
  }

  async reconcile(): Promise<void> {
    if (this.driveTask) {
      await this.driveTask;
      return;
    }
    this.driveTask = this.drive();
    try {
      await this.driveTask;
    } finally {
      this.driveTask = undefined;
    }
  }

  private async drive(): Promise<void> {
    const ledger = this.storage();
    if (!this.modelTask) {
      await recoverInterruptedInvocations(ledger, {
        authorize: async (invocation) =>
          await this.authorizeInvocation(invocation),
        execute: async (invocation) => await this.performEffect(invocation),
      });
    }
    const auditSink = this.env.AUDIT_SINK;
    if (auditSink) {
      try {
        await drainOutbox(ledger, {
          project: async (event) => {
            const response = await auditSink.fetch(
              new Request("https://audit.internal/project", {
                body: JSON.stringify(event),
                headers: { "Content-Type": "application/json" },
                method: "POST",
              })
            );
            if (!response.ok) {
              throw new Error("Audit projection failed");
            }
          },
        });
      } catch {
        // The outbox keeps events until the next scheduled callback.
      }
    }
    const run = ledger
      .runs()
      .find(
        (candidate) =>
          candidate.state === "queued" || candidate.state === "running"
      );
    const effectPending = ledger
      .invocations()
      .some((invocation) => invocation.state === "running");
    if (run && !this.modelTask && !effectPending) {
      this.modelTask = this.runModel(run);
      this.ctx.waitUntil(this.modelTask);
    }
    if (
      ledger.runs().every((candidate) => terminal(candidate.state)) &&
      ledger.pendingOutbox().length === 0
    ) {
      const schedules = await this.listSchedules();
      for (const schedule of schedules) {
        if (schedule.callback === "reconcile") {
          // Schedule cancellation is serial to avoid changing the active list mid-iteration.
          // oxlint-disable-next-line no-await-in-loop
          await this.cancelSchedule(schedule.id);
        }
      }
    }
  }

  private async authorizeInvocation(
    invocation: StoredInvocation
  ): Promise<boolean> {
    const grant = this.storage().grant(invocation.operationId);
    if (
      !grant ||
      !(await approvalMatches(
        grant,
        invocation.invocation,
        fixturePolicyVersion,
        Date.now()
      ))
    ) {
      return false;
    }
    if (
      !isExecutionContextActiveAt(
        invocation.invocation.context,
        invocation.invocation.organizationId,
        Date.now()
      )
    ) {
      return false;
    }
    if (!this.env.POLICY_GATEWAY) {
      return this.env.DEPLOY_MODE === "fixture";
    }
    const response = await this.env.POLICY_GATEWAY.fetch(
      new Request("https://policy.internal/authorize", {
        body: JSON.stringify({
          action: "execute",
          context: invocation.invocation.context,
          resource: {
            id: invocation.invocation.tool.id,
            kind: "tool",
            organizationId: invocation.invocation.organizationId,
          },
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );
    if (!response.ok) {
      return false;
    }
    const result: unknown = await response.json();
    return (
      !!result &&
      typeof result === "object" &&
      "decision" in result &&
      result.decision === "allow"
    );
  }

  private async performEffect(
    invocation: StoredInvocation
  ): Promise<ToolExecution> {
    const grant = this.storage().grant(invocation.operationId);
    if (!grant) {
      throw new Error("Fixture effect has no approval grant");
    }
    const executor = createFixtureToolExecutor({
      ...this.env,
      TOOL_EFFECT_MODE: invocation.idempotent ? "idempotent" : "non-idempotent",
    });
    const result = await executor.execute(invocation.invocation, grant, {
      deadlineAt: grant.expiresAt,
      operationId: invocation.operationId,
      requestDigest: invocation.argumentDigest,
    });
    if (result.status !== "ok") {
      throw new Error(`Fixture effect returned ${result.status}`);
    }
    return result.value;
  }

  private async completedToolCalls(): Promise<ReadonlySet<string>> {
    const sessionId = this.storage().openCodeSessionId();
    if (!sessionId || !this.client) {
      return new Set();
    }
    const client = await this.client;
    const messages = await client.message.list({ sessionID: sessionId });
    const completed = new Set<string>();
    for (const message of messages.data) {
      if (message.type !== "assistant") {
        continue;
      }
      for (const part of message.content) {
        if (part.type === "tool" && part.state.status === "completed") {
          completed.add(sdkCallKey({ callId: part.id, messageId: message.id }));
        }
      }
    }
    return completed;
  }

  // This method owns the fixture invocation state machine and its durable transitions.
  // oxlint-disable-next-line complexity
  private async executeTool(call: ModelToolCall): Promise<{ content: string }> {
    if (
      !this.activeRunId ||
      !this.modelAttemptId ||
      !isFixtureInput(call.input)
    ) {
      throw new Error("Invalid fixture tool call");
    }
    const ledger = this.storage();
    const run = ledger.run(this.activeRunId);
    const address = ledger.address();
    if (
      !run ||
      !address ||
      terminal(run.state) ||
      !run.agent.enabledToolIds.includes(fixtureTool.id)
    ) {
      throw new Error("Run is not active");
    }
    if (ledger.hasRetryableInvocation(run.runId)) {
      throw new Error("Previous fixture effect is pending retry");
    }
    const digest = await digestToolArguments(call.input);
    const callKey = sdkCallKey(call);
    const encoded = new TextEncoder().encode(
      `${run.runId}:${call.messageId}:${call.callId}`
    );
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
    const suffix = [...hash]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
    const candidates = ledger
      .invocations()
      .filter(
        (record) =>
          record.runId === run.runId && record.argumentDigest === digest
      );
    const prior = priorInvocationForCall(
      candidates,
      callKey,
      this.modelAttemptId,
      await this.completedToolCalls()
    );
    const operationId =
      prior?.operationId ?? id.operation(`${run.operationId}:${suffix}`);
    const invocation: ToolInvocation = {
      agentId: address.agentId,
      argumentDigest: digest,
      arguments: structuredClone(call.input),
      context: structuredClone(run.context),
      operationId,
      organizationId: address.organizationId,
      state: "requested",
      tool: fixtureTool,
    };
    const approval: StoredApprovalRequest = {
      actorPrincipalId: run.context.actor.id,
      agentId: address.agentId,
      argumentDigest: digest,
      connectorId: invocation.tool.connectorId,
      delegationId: run.context.delegation?.id,
      effect: invocation.tool.effect,
      expiresAt: Date.now() + 300_000,
      id: `approval:${operationId}`,
      operationId,
      organizationId: address.organizationId,
      policyVersion: fixturePolicyVersion,
      principalId: run.context.represented?.id ?? run.context.actor.id,
      toolId: invocation.tool.id,
      toolVersion: invocation.tool.version,
    };
    const claim = ledger.claimInvocation(
      invocation,
      run.runId,
      this.env.TOOL_EFFECT_MODE === "idempotent",
      callKey,
      this.modelAttemptId,
      approval
    );
    if (claim.kind === "conflict") {
      throw new Error("Tool operation ID has different arguments");
    }
    if (claim.kind === "result" && claim.record?.result) {
      if (!(await this.authorizeInvocation(claim.record))) {
        throw new Error("Current grant denies cached tool result");
      }
      return { content: JSON.stringify(claim.record.result.output) };
    }
    if (claim.kind === "unknown") {
      throw new Error("Tool outcome needs reconciliation");
    }
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const current = ledger.invocation(operationId);
      const latestRun = ledger.run(run.runId);
      if (!current || !latestRun || terminal(latestRun.state)) {
        throw new Error("Run ended before fixture tool completion");
      }
      if (current.state === "succeeded" && current.result) {
        return { content: JSON.stringify(current.result.output) };
      }
      if (current.state === "unknown-outcome") {
        throw new Error("Tool outcome needs reconciliation");
      }
      if (current.state === "requested") {
        // Authorization is checked after each durable state read.
        // oxlint-disable-next-line no-await-in-loop
        if (!(await this.authorizeInvocation(current))) {
          throw new Error("Current grant denies fixture effect");
        }
        const started = ledger.startInvocation(operationId);
        if (!started) {
          throw new Error("Approved invocation is no longer ready");
        }
        // Persist the in-flight marker before the provider call.
        // oxlint-disable-next-line no-await-in-loop
        await this.ctx.storage.sync();
        try {
          // One attempt is in flight for this invocation.
          // oxlint-disable-next-line no-await-in-loop
          const result = await this.performEffect(started);
          ledger.finishInvocation(operationId, result);
          // Persist the receipt before returning it to the model.
          // oxlint-disable-next-line no-await-in-loop
          await this.ctx.storage.sync();
          return { content: JSON.stringify(result.output) };
        } catch (error) {
          if (!started.idempotent) {
            ledger.markUnknownOutcome(operationId);
            throw error;
          }
          // The retry must use the same invocation before the model continues.
          // oxlint-disable-next-line no-await-in-loop
          await recoverInterruptedInvocation(ledger, started, {
            authorize: async (record) => await this.authorizeInvocation(record),
            execute: async (record) => await this.performEffect(record),
          });
          const recovered = ledger.invocation(operationId);
          if (recovered?.state === "succeeded" && recovered.result) {
            // The receipt must be durable before it returns to the model.
            // oxlint-disable-next-line no-await-in-loop
            await this.ctx.storage.sync();
            return { content: JSON.stringify(recovered.result.output) };
          }
          throw error;
        }
      }
      // Polling depends on the latest durable invocation state.
      // oxlint-disable-next-line no-await-in-loop
      await delay(200);
    }
    throw new Error("Fixture approval timed out");
  }

  private async interruptModel(): Promise<void> {
    if (!this.client) {
      return;
    }
    const sessionId = this.storage().openCodeSessionId();
    if (!sessionId) {
      return;
    }
    try {
      const client = await this.client;
      await client.session.interrupt(
        { continue: false, sessionID: sessionId },
        { signal: AbortSignal.timeout(5000) }
      );
    } catch {
      // Cancellation is durable even if the model cannot be interrupted.
    }
  }

  private async closeClient(): Promise<void> {
    const pending = this.client;
    this.client = undefined;
    if (pending) {
      try {
        const client = await pending;
        await this.ctx.storage.sync();
        await client.close();
      } catch {
        // The next wake opens a new client from Durable SQLite.
      }
    }
  }

  // The model lifecycle needs one error boundary for durable failure recording.
  // oxlint-disable-next-line complexity
  private async runModel(initial: StoredRun): Promise<void> {
    const ledger = this.storage();
    this.activeRunId = initial.runId;
    this.modelAttemptId = crypto.randomUUID();
    let stage = "initialize";
    try {
      let run = ledger.run(initial.runId);
      if (!run || terminal(run.state)) {
        return;
      }
      this.client ??= createOpenCodeClient(
        this.ctx.storage,
        this.env,
        run.agent,
        async (call) => await this.executeTool(call)
      );
      const client = await this.client;
      if (run.state === "queued") {
        run = ledger.updateRun(run.runId, (current) => ({
          ...current,
          state: "running",
        }));
      }
      let sessionId = ledger.openCodeSessionId();
      if (!sessionId) {
        stage = "session-create";
        const session = await client.session.create();
        sessionId = session.id;
        ledger.saveOpenCodeSessionId(sessionId);
      }
      const messageId = run.messageId ?? `msg_${run.eventId}`;
      if (!run.messageId) {
        run = ledger.updateRun(run.runId, (current) => ({
          ...current,
          messageId,
          opencodeSessionId: sessionId,
        }));
      }
      stage = "message-list";
      const messages = await client.message.list({ sessionID: sessionId });
      const inbox = await client.session.inbox.list({ sessionID: sessionId });
      if (
        !messages.data.some((message) => message.id === messageId) &&
        !inbox.some((message) => message.id === messageId)
      ) {
        stage = "prompt";
        await client.session.prompt({
          id: messageId,
          sessionID: sessionId,
          text: fixturePrompt(run),
        });
      } else {
        const active = await client.session.active();
        if (!active[sessionId]) {
          stage = "resume";
          await client.session.prompt({
            id: messageId,
            sessionID: sessionId,
            text: fixturePrompt(run),
          });
        }
      }
      stage = "wait";
      try {
        await client.session.wait(
          { sessionID: sessionId },
          { signal: AbortSignal.timeout(60_000) }
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError")
        ) {
          return;
        }
        throw error;
      }
      stage = "final-messages";
      const reply = await readFinalReply(client, sessionId);
      const latest = ledger.run(run.runId);
      const effectNeedsRetry = ledger.hasRetryableInvocation(run.runId);
      if (
        !latest ||
        terminal(latest.state) ||
        latest.state === "waiting-for-approval" ||
        effectNeedsRetry ||
        reply === undefined
      ) {
        return;
      }
      const confirmedEffect = ledger
        .invocations()
        .some(
          (invocation) =>
            invocation.runId === run.runId && invocation.state === "succeeded"
        );
      if (!confirmedEffect || !fixtureReplyMatches(reply)) {
        ledger.updateRun(run.runId, (current) => ({
          ...current,
          endedAt: Date.now(),
          state: "failed",
        }));
        return;
      }
      ledger.updateRun(run.runId, (current) => ({
        ...current,
        endedAt: Date.now(),
        output: reply,
        state: "completed",
      }));
      ledger.recordUsage(run.runId, run.operationId, 0, "fixture-credits");
    } catch {
      const current = ledger.run(initial.runId);
      const effectNeedsRetry = ledger.hasRetryableInvocation(initial.runId);
      if (
        current &&
        !terminal(current.state) &&
        current.state !== "waiting-for-approval" &&
        !effectNeedsRetry
      ) {
        ledger.updateRun(current.runId, (run) => ({
          ...run,
          endedAt: Date.now(),
          output: `Model failed at ${stage}`,
          state: "failed",
        }));
      }
    } finally {
      this.activeRunId = undefined;
      this.modelAttemptId = undefined;
      this.modelTask = undefined;
      const latest = ledger.run(initial.runId);
      const effectNeedsRetry = ledger.hasRetryableInvocation(initial.runId);
      if ((latest && terminal(latest.state)) || effectNeedsRetry) {
        await this.closeClient();
      }
    }
  }
}
