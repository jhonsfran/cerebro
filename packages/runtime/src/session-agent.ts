/* oxlint-disable no-await-in-loop -- Recovery and tool transitions use the state from the preceding durable operation. */
import { setTimeout as delay } from "node:timers/promises";

import type { EventAddress, EventEnvelope } from "@cerebro/contracts/events";
import { id, isExecutionContextActiveAt } from "@cerebro/contracts/identity";
import type { ExecutionContext, SourceId } from "@cerebro/contracts/identity";
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
import type { PaidWorkRequest } from "@cerebro/policy/authorization-gate";
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
import { createModelHttpPlugin } from "./model-http-plugin.ts";
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
import type { RuntimePorts, ModelHttpReceipt } from "./runtime-ports.ts";
import { priorInvocationForCall, sdkCallKey } from "./tool-call-identity.ts";

export interface SessionEnvironment {
  readonly DEPLOY_MODE: "local" | "fixture" | "production";
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
  private runtimePorts: RuntimePorts | undefined;
  private ledger: SessionLedger | undefined;
  private client: Promise<OpenCodeWorkerd.Interface> | undefined;
  private closingClient: Promise<void> | undefined;
  private clientRunId: StoredRun["runId"] | undefined;
  private modelTask: Promise<void> | undefined;
  private driveTask: Promise<void> | undefined;
  private activeRunId: StoredRun["runId"] | undefined;
  private modelAttemptId: string | undefined;

  protected storage(): SessionLedger {
    this.ledger ??= new SessionLedger(this.ctx.storage);
    return this.ledger;
  }

  protected createRuntime(_run: StoredRun): Promise<RuntimePorts | undefined> {
    if (this.env.DEPLOY_MODE !== "fixture") {
      throw new Error("Production runtime composition is missing.");
    }
    return Promise.resolve(this.runtimePorts);
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
      return await this.readSession(path, body);
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

  private async readSession(
    path: string,
    body: Record<string, unknown>
  ): Promise<Response> {
    const { address, cursor } = body;
    if (!isAddress(address) || !this.storage().bind(address)) {
      return Response.json({
        resource: "session",
        status: "not-found",
      } satisfies PortResult<never>);
    }
    await this.ctx.storage.sync();
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

  private async authorizeApproval(
    approvalId: string,
    deadlineAt: number
  ): Promise<PortResult<void>> {
    const approval = this.storage().approval(approvalId);
    const invocation = approval
      ? this.storage().invocation(approval.operationId)
      : undefined;
    const run = invocation ? this.storage().run(invocation.runId) : undefined;
    if (invocation && run) {
      const ports = await this.createRuntime(run);
      if (ports) {
        const decision = await ports.authorization.evaluate(
          invocation.invocation.context,
          "execute",
          {
            id: invocation.invocation.tool.id,
            kind: "tool",
            organizationId: run.agent.organizationId,
          },
          { deadlineAt }
        );
        if (decision.status !== "ok") {
          return decision;
        }
        if (decision.value.decision !== "allow") {
          return {
            code: "unauthorized",
            reason: "Current policy denies the approved tool.",
            status: "denied",
          } satisfies PortResult<never>;
        }
        const dependencies = await ports.checkDependencies(
          run,
          run.dependencies ?? { sourceIds: [], toolIds: [] },
          { deadlineAt }
        );
        if (dependencies.status !== "ok") {
          return dependencies;
        }
      }
    }
    return { status: "ok", value: undefined };
  }

  private async approve(body: Record<string, unknown>): Promise<Response> {
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
    const permitted = await this.authorizeApproval(
      command.approvalId,
      options.deadlineAt
    );
    if (permitted.status !== "ok") {
      return Response.json(permitted);
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
      if (this.clientRunId === command.runId) {
        this.ctx.waitUntil(
          (async () => {
            await this.interruptModel();
            if (!this.modelTask) {
              await this.closeClient();
            }
            await this.reconcile();
          })()
        );
      } else {
        this.ctx.waitUntil(this.reconcile());
      }
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
    if (this.closingClient) {
      await this.closingClient;
    }
    const ledger = this.storage();
    if (!this.modelTask) {
      await this.resumeRequestedInvocations();
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
        // Durable state remains pending for recovery.
      }
    }
    const [run] = ledger
      .runs()
      .filter((candidate) => !terminal(candidate.state))
      .toSorted((first, second) => first.createdAt - second.createdAt);
    const effectPending = ledger
      .invocations()
      .some((invocation) => invocation.state === "running");
    if (
      run &&
      run.state !== "waiting-for-approval" &&
      !this.modelTask &&
      !effectPending
    ) {
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
          // oxlint-disable-next-line no-await-in-loop
          await this.cancelSchedule(schedule.id);
        }
      }
    }
  }

  private async resumeRequestedInvocations(): Promise<void> {
    const ledger = this.storage();
    for (const invocation of ledger.invocations()) {
      if (invocation.state !== "requested") {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      if (!(await this.authorizeInvocation(invocation))) {
        continue;
      }
      const started = ledger.startInvocation(invocation.operationId);
      if (!started) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop
      await this.ctx.storage.sync();
      try {
        // oxlint-disable-next-line no-await-in-loop
        const result = await this.performEffect(started);
        ledger.finishInvocation(started.operationId, result);
      } catch {
        if (!started.idempotent) {
          ledger.markUnknownOutcome(started.operationId);
        }
      }
      // oxlint-disable-next-line no-await-in-loop
      await this.ctx.storage.sync();
    }
  }

  private async authorizeInvocation(
    invocation: StoredInvocation
  ): Promise<boolean> {
    const run = this.storage().run(invocation.runId);
    if (!run || terminal(run.state)) {
      return false;
    }
    const ports = await this.createRuntime(run);
    if (ports && run) {
      const allowed = await ports.authorization.evaluate(
        invocation.invocation.context,
        "execute",
        {
          id: invocation.invocation.tool.id,
          kind: "tool",
          organizationId: invocation.invocation.organizationId,
        },
        { deadlineAt: Date.now() + 5000 }
      );
      if (allowed.status !== "ok" || allowed.value.decision !== "allow") {
        return false;
      }
      const dependencies = await ports.checkDependencies(
        run,
        run.dependencies ?? { sourceIds: [], toolIds: [] },
        { deadlineAt: Date.now() + 5000 }
      );
      if (dependencies.status !== "ok") {
        return false;
      }
      const entry = ports.registry.get(invocation.invocation.tool.id);
      if (!entry) {
        return false;
      }
      if (!entry.requiresApproval) {
        return true;
      }
      const grant = this.storage().grant(invocation.operationId);
      return (
        !!grant &&
        (await approvalMatches(
          grant,
          invocation.invocation,
          allowed.value.policyVersion,
          Date.now()
        ))
      );
    }
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
    const run = this.storage().run(invocation.runId);
    if (!run || terminal(run.state)) {
      throw new Error("Tool owner run is terminal.");
    }
    const ports = await this.createRuntime(run);
    if (ports) {
      await ports.prepareApproval(invocation.operationId);
      const { invocation: call } = invocation;
      const result = await ports.broker.invoke(
        {
          agentId: call.agentId,
          arguments: call.arguments,
          context: call.context,
          organizationId: call.organizationId,
          tool: call.tool,
        },
        {
          deadlineAt: Date.now() + 60_000,
          operationId: invocation.operationId,
          requestDigest: invocation.argumentDigest,
        }
      );
      if (result.status !== "ok") {
        if (result.status === "unknown-outcome") {
          this.storage().markUnknownOutcome(invocation.operationId);
        }
        throw new Error(`Tool broker returned ${result.status}.`);
      }
      this.storage().recordToolOutput({
        dependencies: {
          sourceIds: run?.dependencies?.sourceIds ?? [],
          toolIds: [call.tool.id],
        },
        operationId: invocation.operationId,
        output: result.value.output,
        runId: invocation.runId,
        toolId: call.tool.id,
        type: "tool",
      });
      return result.value;
    }
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

  private async markModelConsumed(runId: StoredRun["runId"]): Promise<void> {
    const [row] = this.ctx.storage.sql
      .exec<{ result: string }>(
        "SELECT result FROM cerebro_operation WHERE id=?",
        `model-active:${runId}`
      )
      .toArray();
    if (row) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO cerebro_operation(id,result) VALUES(?,?)",
        `model-consumed:${row.result}`,
        "true"
      );
      await this.ctx.storage.sync();
    }
  }

  private async toolReply(
    invocation: StoredInvocation
  ): Promise<{ content: string }> {
    if (!invocation.result || !(await this.authorizeInvocation(invocation))) {
      throw new Error("Current policy denies tool output.");
    }
    return { content: JSON.stringify(invocation.result.output) };
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

  // oxlint-disable-next-line complexity
  private async executeTool(call: ModelToolCall): Promise<{ content: string }> {
    if (
      !this.activeRunId ||
      !this.modelAttemptId ||
      (!this.runtimePorts && !isFixtureInput(call.input))
    ) {
      throw new Error("Invalid fixture tool call");
    }
    const ledger = this.storage();
    const run = ledger.run(this.activeRunId);
    const address = ledger.address();
    const entry = call.toolId
      ? this.runtimePorts?.registry.get(id.tool(call.toolId))
      : undefined;
    const tool = entry?.definition ?? fixtureTool;
    if (
      !run ||
      !address ||
      terminal(run.state) ||
      !run.agent.enabledToolIds.includes(tool.id)
    ) {
      throw new Error("Run is not active");
    }
    if (ledger.hasRetryableInvocation(run.runId)) {
      throw new Error("Previous fixture effect is pending retry");
    }
    if (this.runtimePorts) {
      await this.markModelConsumed(run.runId);
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
          record.runId === run.runId &&
          record.argumentDigest === digest &&
          record.invocation.tool.id === tool.id
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
      tool,
    };
    let policyVersion = fixturePolicyVersion;
    if (this.runtimePorts) {
      const authorized = await this.runtimePorts.authorization.evaluate(
        run.context,
        "execute",
        { id: tool.id, kind: "tool", organizationId: run.agent.organizationId },
        { deadlineAt: Date.now() + 5000 }
      );
      if (authorized.status !== "ok" || authorized.value.decision !== "allow") {
        throw new Error("Current policy denies the tool.");
      }
      ({ policyVersion } = authorized.value);
    }
    const approval: StoredApprovalRequest | undefined =
      entry && !entry.requiresApproval
        ? undefined
        : {
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
            policyVersion,
            principalId: run.context.represented?.id ?? run.context.actor.id,
            toolId: invocation.tool.id,
            toolVersion: invocation.tool.version,
          };
    if (this.runtimePorts) {
      ledger.updateRun(run.runId, (current) => ({
        ...current,
        dependencies: {
          sourceIds: current.dependencies?.sourceIds ?? [],
          toolIds: [
            ...new Set([...(current.dependencies?.toolIds ?? []), tool.id]),
          ],
        },
      }));
    }
    const claim = ledger.claimInvocation(
      invocation,
      run.runId,
      entry
        ? entry.retryMode === "idempotent"
        : this.env.TOOL_EFFECT_MODE === "idempotent",
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
      return await this.toolReply(claim.record);
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
        return await this.toolReply(current);
      }
      if (current.state === "unknown-outcome") {
        throw new Error("Tool outcome needs reconciliation");
      }
      if (current.state === "requested") {
        // oxlint-disable-next-line no-await-in-loop
        if (!(await this.authorizeInvocation(current))) {
          throw new Error("Current grant denies fixture effect");
        }
        const started = ledger.startInvocation(operationId);
        if (!started) {
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop
        await this.ctx.storage.sync();
        try {
          // oxlint-disable-next-line no-await-in-loop
          const result = await this.performEffect(started);
          ledger.finishInvocation(operationId, result);
          // oxlint-disable-next-line no-await-in-loop
          await this.ctx.storage.sync();
          const completed = ledger.invocation(operationId);
          if (!completed) {
            throw new Error("Completed tool record is missing.");
          }
          return await this.toolReply(completed);
        } catch (error) {
          if (!started.idempotent) {
            ledger.markUnknownOutcome(operationId);
            throw error;
          }
          // oxlint-disable-next-line no-await-in-loop
          await recoverInterruptedInvocation(ledger, started, {
            authorize: async (record) => await this.authorizeInvocation(record),
            execute: async (record) => await this.performEffect(record),
          });
          const recovered = ledger.invocation(operationId);
          if (recovered?.state === "succeeded" && recovered.result) {
            // oxlint-disable-next-line no-await-in-loop
            await this.ctx.storage.sync();
            return await this.toolReply(recovered);
          }
          throw error;
        }
      }
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
      // Durable state remains pending for recovery.
    }
  }

  private async closeClient(): Promise<void> {
    if (this.closingClient) {
      await this.closingClient;
      return;
    }
    this.closingClient = this.releaseClient();
    try {
      await this.closingClient;
    } finally {
      this.closingClient = undefined;
    }
  }

  private async releaseClient(): Promise<void> {
    const pending = this.client;
    this.client = undefined;
    this.clientRunId = undefined;
    this.runtimePorts = undefined;
    this.activeRunId = undefined;
    this.modelAttemptId = undefined;
    if (pending) {
      try {
        const client = await pending;
        await this.ctx.storage.sync();
        await client.close();
      } catch {
        // Durable state remains pending for recovery.
      }
    }
  }

  private async recoverModelRequests(
    run: StoredRun,
    ports: RuntimePorts
  ): Promise<void> {
    const key = `model-sequence:${run.runId}`;
    const [row] = this.ctx.storage.sql
      .exec<{ result: string }>(
        "SELECT result FROM cerebro_operation WHERE id=?",
        key
      )
      .toArray();
    const count = Number(row?.result ?? "0");
    for (let ordinal = 1; ordinal <= count; ordinal += 1) {
      const operationId = id.operation(`${run.operationId}:model:${ordinal}`);
      const record = await ports.modelJournal.read(
        run.agent.organizationId,
        operationId,
        { deadlineAt: Date.now() + 5000 }
      );
      if (record.status !== "ok") {
        continue;
      }
      if (record.value.state === "completed") {
        if (record.value.result.status === "ok") {
          const receipt = record.value.result.value;
          this.storage().recordUsage(
            run.runId,
            operationId,
            receipt.units,
            receipt.unit
          );
          const [consumed] = this.ctx.storage.sql
            .exec(
              "SELECT id FROM cerebro_operation WHERE id=?",
              `model-consumed:${operationId}`
            )
            .toArray();
          if (!consumed) {
            this.storage().updateRun(run.runId, (current) => ({
              ...current,
              endedAt: Date.now(),
              state: "unknown-outcome",
            }));
            await this.ctx.storage.sync();
            return;
          }
        }
        continue;
      }
      if (
        record.value.state === "outcome-recorded" ||
        record.value.state === "release-intent"
      ) {
        const request = record.value.intent.request as PaidWorkRequest;
        const result = await ports.paidModel.run(
          request,
          {
            deadlineAt: Date.now() + 15_000,
            operationId,
            requestDigest: record.value.intent.requestDigest,
          },
          () =>
            Promise.reject(
              new Error("A recovered model request cannot dispatch again.")
            )
        );
        if (result.status === "ok") {
          const receipt: ModelHttpReceipt = result.value;
          this.storage().recordUsage(
            run.runId,
            operationId,
            receipt.units,
            receipt.unit
          );
          const [consumed] = this.ctx.storage.sql
            .exec(
              "SELECT id FROM cerebro_operation WHERE id=?",
              `model-consumed:${operationId}`
            )
            .toArray();
          if (consumed) {
            continue;
          }
        }
      }
      this.storage().updateRun(run.runId, (current) => ({
        ...current,
        endedAt: Date.now(),
        state: "unknown-outcome",
      }));
      await this.ctx.storage.sync();
      return;
    }
  }

  // oxlint-disable-next-line complexity
  private async runModel(initial: StoredRun): Promise<void> {
    if (this.closingClient) {
      await this.closingClient;
    }
    const ledger = this.storage();
    if (this.client && this.clientRunId !== initial.runId) {
      await this.closeClient();
    }
    this.activeRunId = initial.runId;
    this.modelAttemptId ??= crypto.randomUUID();
    try {
      let run = ledger.run(initial.runId);
      if (!run || terminal(run.state)) {
        return;
      }
      this.runtimePorts ??= await this.createRuntime(run);
      const ports = this.runtimePorts;
      let modelPlugin;
      if (ports) {
        const current = await ports.authorization.evaluate(
          run.context,
          "execute",
          {
            id: run.agent.agentId,
            kind: "agent",
            organizationId: run.agent.organizationId,
          },
          { deadlineAt: Date.now() + 5000 }
        );
        if (current.status !== "ok" || current.value.decision !== "allow") {
          ledger.recordFailure(
            run.runId,
            "authorization",
            current.status === "ok"
              ? {
                  code: "unauthorized",
                  reason: "Current policy denies the run.",
                  status: "denied",
                }
              : current
          );
          throw new Error("Current policy denies the run.");
        }
        const historical = {
          sourceIds: new Set<SourceId>(),
          toolIds: new Set<string>(),
        };
        for (const previous of ledger.runs()) {
          if (previous.modelPrompt || previous.output) {
            if (!previous.dependencies) {
              throw new Error("Historical model content has no dependencies.");
            }
            const allowed = await ports.checkDependencies(
              run,
              previous.dependencies,
              { deadlineAt: Date.now() + 5000 }
            );
            if (allowed.status !== "ok") {
              ledger.recordFailure(run.runId, "historical-context", allowed);
              throw new Error(
                "Current policy denies historical model context."
              );
            }
            for (const sourceId of previous.dependencies.sourceIds) {
              historical.sourceIds.add(sourceId);
            }
            for (const toolId of previous.dependencies.toolIds) {
              historical.toolIds.add(toolId);
            }
          }
        }
        if (!this.client || this.clientRunId !== run.runId) {
          await this.recoverModelRequests(run, ports);
        }
        const recovered = ledger.run(run.runId);
        if (!recovered || terminal(recovered.state)) {
          return;
        }
        if (!run.modelPrompt) {
          const memory = await ports.retrieve(run, {
            deadlineAt: Date.now() + 10_000,
          });
          if (memory.status !== "ok") {
            ledger.recordFailure(run.runId, "retrieval", memory);
            throw new Error(`Memory retrieval returned ${memory.status}.`);
          }
          const dependencies = {
            sourceIds: [
              ...new Set([
                ...historical.sourceIds,
                ...memory.value.flatMap((hit) => [
                  hit.citation.sourceId,
                  ...(hit.record.kind === "conversation-summary"
                    ? hit.record.dependentSourceIds
                    : []),
                ]),
              ]),
            ],
            toolIds: [...historical.toolIds],
          };
          const sourceText = memory.value
            .map(
              (hit) =>
                `[source ${hit.citation.sourceId} version ${hit.citation.sourceVersion}] ${hit.record.text}`
            )
            .join("\n");
          const modelPrompt = `${run.agent.instructions}\noperationId=${run.operationId}\n${run.prompt}\n${sourceText}`;
          run = ledger.updateRun(run.runId, (currentRun) => ({
            ...currentRun,
            dependencies,
            modelPrompt,
          }));
          for (const hit of memory.value) {
            ledger.append(run.runId, {
              citation: hit.citation,
              dependencies,
              runId: run.runId,
              type: "citation",
            });
          }
          await this.ctx.storage.sync();
        }
        modelPlugin = createModelHttpPlugin({
          failed: (result) => {
            ledger.recordFailure(initial.runId, "model", result);
            const currentRun = ledger.run(initial.runId);
            if (currentRun && !terminal(currentRun.state)) {
              ledger.updateRun(initial.runId, (record) => ({
                ...record,
                endedAt: Date.now(),
                state:
                  result.status === "unknown-outcome"
                    ? "unknown-outcome"
                    : "failed",
              }));
            }
          },
          ports,
          recorded: (operationId, receipt) =>
            ledger.recordUsage(
              initial.runId,
              id.operation(operationId),
              receipt.units,
              receipt.unit
            ),
          run: () => {
            const active = ledger.run(initial.runId);
            if (!active) {
              throw new Error("Model run is missing.");
            }
            return active;
          },
          storage: this.ctx.storage,
        });
      }
      this.clientRunId = run.runId;
      this.client ??= createOpenCodeClient(
        this.ctx.storage,
        this.env,
        run.agent,
        async (call) => await this.executeTool(call),
        ports && modelPlugin ? { modelPlugin, ports } : undefined
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
        const session = await client.session.create(
          this.runtimePorts ? { title: "Cerebro conversation" } : {}
        );
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
      const messages = await client.message.list({ sessionID: sessionId });
      const inbox = await client.session.inbox.list({ sessionID: sessionId });
      if (
        !messages.data.some((message) => message.id === messageId) &&
        !inbox.some((message) => message.id === messageId)
      ) {
        await client.session.prompt({
          id: messageId,
          sessionID: sessionId,
          text: run.modelPrompt ?? fixturePrompt(run),
        });
      } else {
        const active = await client.session.active();
        if (!active[sessionId]) {
          await client.session.prompt({
            id: messageId,
            sessionID: sessionId,
            text: run.modelPrompt ?? fixturePrompt(run),
          });
        }
      }
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
      const reply = await readFinalReply(client, sessionId);
      const latest = ledger.run(run.runId);
      const effectNeedsRetry = ledger.hasRetryableInvocation(run.runId);
      if (
        !latest ||
        terminal(latest.state) ||
        latest.state === "waiting-for-approval" ||
        effectNeedsRetry
      ) {
        return;
      }
      if (reply === undefined) {
        ledger.recordFailure(run.runId, "model-response", {
          reason: "The SDK completed without a final model response.",
          status: "invalid-input",
        });
        ledger.updateRun(run.runId, (current) => ({
          ...current,
          endedAt: Date.now(),
          state: "failed",
        }));
        return;
      }
      const confirmedEffect = ledger
        .invocations()
        .some(
          (invocation) =>
            invocation.runId === run.runId && invocation.state === "succeeded"
        );
      if (
        !this.runtimePorts &&
        (!confirmedEffect || !fixtureReplyMatches(reply))
      ) {
        ledger.updateRun(run.runId, (current) => ({
          ...current,
          endedAt: Date.now(),
          state: "failed",
        }));
        return;
      }
      if (this.runtimePorts) {
        await this.markModelConsumed(run.runId);
        const allowed = await this.runtimePorts.checkDependencies(
          latest,
          latest.dependencies ?? { sourceIds: [], toolIds: [] },
          { deadlineAt: Date.now() + 5000 }
        );
        if (allowed.status !== "ok") {
          throw new Error("Current policy denies completed output.");
        }
      }
      ledger.updateRun(run.runId, (current) => ({
        ...current,
        endedAt: Date.now(),
        output: reply,
        state: "completed",
      }));
      if (!this.runtimePorts) {
        ledger.recordUsage(run.runId, run.operationId, 0, "fixture-credits");
      }
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
          output: run.output,
          state: "failed",
        }));
      }
    } finally {
      const latest = ledger.run(initial.runId);
      const effectNeedsRetry = ledger.hasRetryableInvocation(initial.runId);
      if (
        (latest && terminal(latest.state)) ||
        effectNeedsRetry ||
        !this.client
      ) {
        await this.closeClient();
      }
      this.modelTask = undefined;
    }
  }
}
