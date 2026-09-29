import { setTimeout as delay } from "node:timers/promises";

import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";
import { Agent } from "agents";

import { executeFixtureEffect } from "./effect-tool";
import { RecoveryLedger, recoveryView } from "./recovery-ledger";
import type {
  EffectMode,
  RecoveryRun,
  SDKAttempt,
  ToolDiagnostic,
} from "./recovery-ledger";
import type { ToolBindings } from "./tool";

interface RecoveryEnvironment extends ToolBindings {
  EFFECT_GATEWAY: ToolBindings["GATEWAY"];
  FIXTURE_URL: string;
}
interface Submission {
  operationId: string;
  mode: EffectMode;
  holdAfterEffect: boolean;
  startDelayMs: number;
}
const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/u;
const expectedReply = "Cerebro fixture completed.";
const fixtureValue = "approved-fixture";
const registrationDeadline = async (): Promise<never> => {
  await delay(5000);
  throw new Error("Fixture broker registration timed out");
};
type SDKMessage = Awaited<
  ReturnType<OpenCodeWorkerd.Interface["message"]["list"]>
>["data"][number];
const diagnosticTool = (name: string): ToolDiagnostic["tool"] | null => {
  switch (name) {
    case "fixture_effect":
    case "shell":
    case "webfetch":
    case "execute":
    case "mcp_unregistered": {
      return name;
    }
    default: {
      return null;
    }
  }
};
const diagnosticError = (
  tool: ToolDiagnostic["tool"],
  message: string
): ToolDiagnostic["errorKind"] => {
  if (message === `Unknown tool: ${tool}`) {
    return "unknown-tool";
  }
  if (
    message === `Tool is not available for this request: ${tool}` ||
    (tool !== "fixture_effect" &&
      message === "Only fixture_effect is permitted")
  ) {
    return "denied";
  }
  return "other";
};
const matchesReceipt = (text: string, run: RecoveryRun): boolean => {
  if (text.length > 4096 || run.invocation?.state !== "completed") {
    return false;
  }
  try {
    const value: unknown = JSON.parse(text);
    const { result } = run.invocation;
    return (
      !!value &&
      typeof value === "object" &&
      "receipt" in value &&
      value.receipt === result.receipt &&
      "value" in value &&
      value.value === result.value &&
      "invocationId" in value &&
      value.invocationId === result.invocationId
    );
  } catch {
    return false;
  }
};
const summarizeMessages = (
  messages: readonly SDKMessage[],
  run: RecoveryRun
) => {
  const diagnostics: ToolDiagnostic[] = [];
  for (const message of messages) {
    if (message.type !== "assistant") {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== "tool") {
        continue;
      }
      const tool = diagnosticTool(part.name);
      if (!tool) {
        continue;
      }
      diagnostics.push({
        callId: part.id,
        errorKind:
          part.state.status === "error"
            ? diagnosticError(tool, part.state.error.message)
            : null,
        messageId: message.id,
        resultMatchesLedger:
          part.state.status === "completed" &&
          part.state.content.some(
            (content) =>
              content.type === "text" && matchesReceipt(content.text, run)
          ),
        status: part.state.status,
        tool,
      });
    }
  }
  const assistant = messages.findLast(
    (message) => message.type === "assistant"
  );
  const reply =
    assistant?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim() ?? "";
  const ended =
    (assistant?.finish !== undefined && assistant.finish !== "tool-calls") ||
    assistant?.error !== undefined;
  const latestEffect = diagnostics.findLast(
    (item) => item.tool === "fixture_effect"
  );
  const completedEffectMatchesLedger =
    latestEffect?.status === "completed" && latestEffect.resultMatchesLedger;
  return {
    completedEffectMatchesLedger,
    diagnostics: diagnostics.slice(-20),
    ended,
    reply,
  };
};
const digest = async (value: string): Promise<string> => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};
const parseSubmission = (value: unknown): Submission | null => {
  if (
    !value ||
    typeof value !== "object" ||
    !("operationId" in value) ||
    typeof value.operationId !== "string" ||
    !identifierPattern.test(value.operationId) ||
    !("mode" in value) ||
    (value.mode !== "idempotent" && value.mode !== "non-idempotent") ||
    !("holdAfterEffect" in value) ||
    typeof value.holdAfterEffect !== "boolean"
  ) {
    return null;
  }
  const startDelayMs = "startDelayMs" in value ? value.startDelayMs : 0;
  if (
    typeof startDelayMs !== "number" ||
    !Number.isInteger(startDelayMs) ||
    startDelayMs < 0 ||
    startDelayMs > 60_000
  ) {
    return null;
  }
  return {
    holdAfterEffect: value.holdAfterEffect,
    mode: value.mode,
    operationId: value.operationId,
    startDelayMs,
  };
};

export class RecoverySession extends Agent<RecoveryEnvironment> {
  private readonly instanceId = crypto.randomUUID();
  private ledger: RecoveryLedger | undefined;
  private client: Promise<OpenCodeWorkerd.Interface> | undefined;
  private modelTask: Promise<void> | undefined;
  private effectTask: Promise<void> | undefined;
  private reconciliation: Promise<void> | undefined;
  private brokerReady = false;
  private readonly brokerRegistration = Promise.withResolvers<boolean>();

  private storage(): RecoveryLedger {
    this.ledger ??= new RecoveryLedger(this.ctx.storage);
    return this.ledger;
  }

  private respond(status = 200): Response {
    const run = this.storage().read();
    return Response.json(
      {
        instanceId: this.instanceId,
        ok: true,
        run: run ? recoveryView(run) : null,
      },
      { status }
    );
  }

  private async checkpoint(phase: string): Promise<void> {
    const run = this.storage().read();
    if (!run) {
      return;
    }
    await this.ctx.storage.sync();
    const response = await fetch(`${this.env.FIXTURE_URL}/checkpoints`, {
      body: JSON.stringify({
        instance: this.instanceId,
        operationId: run.operationId,
        phase,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(5000),
    });
    await response.text();
    if (!response.ok) {
      throw new Error("Fixture checkpoint was not acknowledged");
    }
  }

  private async submit(request: Request): Promise<Response> {
    const submission = parseSubmission(await request.json());
    if (!submission) {
      return Response.json(
        { error: "Invalid submission", ok: false },
        { status: 400 }
      );
    }
    if (
      !new URL(request.url).pathname.startsWith(
        `/recovery/${submission.operationId}/`
      )
    ) {
      return Response.json(
        {
          error:
            "Recovery fixture requires one operation per object; route and operationId must match",
          ok: false,
        },
        { status: 400 }
      );
    }
    const requestDigest = await digest(JSON.stringify(submission));
    const existing = this.storage().read();
    if (existing) {
      if (
        existing.operationId !== submission.operationId ||
        existing.requestDigest !== requestDigest
      ) {
        return Response.json(
          { error: "Operation or request digest conflicts", ok: false },
          { status: 409 }
        );
      }
      return this.respond();
    }
    await this.scheduleEvery(1, "reconcile", undefined, {
      retry: { maxAttempts: 1 },
    });
    const operationDigest = await digest(submission.operationId);
    const messageId = `msg_${operationDigest.slice(0, 32)}`;
    const concurrent = this.storage().read();
    if (concurrent) {
      if (
        concurrent.operationId === submission.operationId &&
        concurrent.requestDigest === requestDigest
      ) {
        return this.respond();
      }
      return Response.json(
        { error: "Another operation was accepted", ok: false },
        { status: 409 }
      );
    }
    this.storage().create({
      approvalEvents: [],
      holdAfterEffect: submission.holdAfterEffect,
      invocation: null,
      messageId,
      mode: submission.mode,
      modelAttemptId: null,
      modelAttempts: [],
      notBefore: Date.now() + submission.startDelayMs,
      operationId: submission.operationId,
      outcome: { state: "active" },
      requestDigest,
      sessionId: null,
      toolDiagnostics: [],
    });
    await this.checkpoint("accepted");
    return this.respond(202);
  }

  private async approve(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    if (
      !body ||
      typeof body !== "object" ||
      !("eventId" in body) ||
      typeof body.eventId !== "string" ||
      !identifierPattern.test(body.eventId) ||
      !("digest" in body) ||
      typeof body.digest !== "string"
    ) {
      return Response.json(
        { error: "Invalid approval", ok: false },
        { status: 400 }
      );
    }
    const run = this.storage().read();
    if (!run?.invocation || run.invocation.digest !== body.digest) {
      return Response.json(
        { error: "Approval digest conflicts", ok: false },
        { status: 409 }
      );
    }
    if (run.approvalEvents.some((event) => event.eventId === body.eventId)) {
      return this.respond();
    }
    if (
      run.outcome.state !== "active" ||
      run.invocation.state !== "waiting-for-approval"
    ) {
      return Response.json(
        { error: "Invocation is not waiting for approval", ok: false },
        { status: 409 }
      );
    }
    const event = { digest: body.digest, eventId: body.eventId };
    this.storage().update((current) => {
      if (
        current.outcome.state !== "active" ||
        current.invocation?.state !== "waiting-for-approval"
      ) {
        return current;
      }
      return {
        ...current,
        approvalEvents: [...current.approvalEvents, event],
        invocation: { ...current.invocation, state: "approved" },
      };
    });
    await this.ctx.storage.sync();
    return this.respond();
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const { pathname: path } = url;
      if (request.method === "GET" && path.endsWith("/state")) {
        return this.respond();
      }
      if (request.method === "GET" && path.endsWith("/result")) {
        if (url.searchParams.get("wait") === "true") {
          await this.checkpoint("result-waiting");
          const deadline = Date.now() + 60_000;
          while (
            this.storage().read()?.outcome.state === "active" &&
            Date.now() < deadline
          ) {
            // oxlint-disable-next-line no-await-in-loop -- Observe the ledger until completion or the bounded deadline.
            await delay(200);
          }
        }
        const outcome = this.storage().read()?.outcome.state;
        if (outcome === "completed") {
          if (url.searchParams.get("hold") === "true") {
            await this.checkpoint("result-held");
            await delay(60_000);
          }
          return this.respond();
        }
        if (outcome === "unknown-outcome") {
          return this.respond(409);
        }
        if (outcome === "failed") {
          return this.respond(500);
        }
        return this.respond(202);
      }
      if (request.method === "POST" && path.endsWith("/submit")) {
        return await this.submit(request);
      }
      if (request.method === "POST" && path.endsWith("/approve")) {
        return await this.approve(request);
      }
      return Response.json(
        { error: "Unknown recovery route", ok: false },
        { status: 404 }
      );
    } catch {
      return Response.json(
        { error: "Recovery request failed", ok: false },
        { status: 500 }
      );
    }
  }

  async reconcile(): Promise<void> {
    if (this.reconciliation) {
      await this.reconciliation;
      return;
    }
    this.reconciliation = this.drive();
    try {
      await this.reconciliation;
    } finally {
      this.reconciliation = undefined;
    }
  }

  private async drive(): Promise<void> {
    let run = this.storage().read();
    if (!run) {
      return;
    }
    await this.checkpoint("wake");
    run = this.storage().read();
    if (!run) {
      return;
    }
    if (run.outcome.state !== "active") {
      if (run.outcome.state !== "completed") {
        await this.tryInterruptModel();
      }
      await this.checkpoint(run.outcome.state);
      await this.closeTerminalClient();
      const schedules = await this.listSchedules();
      await Promise.all(
        schedules
          .filter((schedule) => schedule.callback === "reconcile")
          .map(async (schedule) => await this.cancelSchedule(schedule.id))
      );
      await this.ctx.storage.sync();
      return;
    }
    if (Date.now() < run.notBefore) {
      return;
    }
    if (
      run.invocation?.state === "executing" &&
      !this.effectTask &&
      run.mode === "non-idempotent"
    ) {
      await this.unknown(
        run.invocation.attemptId,
        "Effect outcome was not durably recorded"
      );
      return;
    }
    if (
      !this.effectTask &&
      (run.invocation?.state === "approved" ||
        run.invocation?.state === "executing")
    ) {
      const attemptId = crypto.randomUUID();
      run = this.storage().update((current) => {
        if (
          current.outcome.state !== "active" ||
          (current.invocation?.state !== "approved" &&
            current.invocation?.state !== "executing")
        ) {
          return current;
        }
        return {
          ...current,
          invocation: {
            ...current.invocation,
            attemptId,
            attempts: current.invocation.attempts + 1,
            instanceId: this.instanceId,
            state: "executing",
          },
        };
      });
      this.effectTask = this.performEffect(run, attemptId);
      this.ctx.waitUntil(this.effectTask);
    }
    if (!this.modelTask) {
      const attemptId = crypto.randomUUID();
      this.storage().update((current) => ({
        ...current,
        modelAttemptId: attemptId,
        modelAttempts: [...current.modelAttempts, attemptId],
      }));
      this.modelTask = this.runModel(attemptId);
      this.ctx.waitUntil(this.modelTask);
    }
  }

  private async performEffect(
    run: RecoveryRun,
    attemptId: string
  ): Promise<void> {
    if (!run.invocation) {
      return;
    }
    try {
      await this.checkpoint("executing");
      const dispatch = this.storage().read();
      if (
        dispatch?.outcome.state !== "active" ||
        dispatch.invocation?.state !== "executing" ||
        dispatch.invocation.attemptId !== attemptId
      ) {
        return;
      }
      const result = await executeFixtureEffect(
        { GATEWAY: this.env.EFFECT_GATEWAY, LOADER: this.env.LOADER },
        {
          digest: run.invocation.digest,
          hold: run.holdAfterEffect,
          invocationId: run.invocation.invocationId,
          mode: run.mode,
          value: fixtureValue,
        }
      );
      this.storage().update((current) => {
        if (
          current.outcome.state !== "active" ||
          current.invocation?.state !== "executing" ||
          current.invocation.attemptId !== attemptId
        ) {
          return current;
        }
        return {
          ...current,
          invocation: { ...current.invocation, result, state: "completed" },
        };
      });
      await this.ctx.storage.sync();
    } catch {
      if (run.mode === "non-idempotent") {
        await this.unknown(
          attemptId,
          "Effect request failed after dispatch was recorded"
        );
      }
    } finally {
      this.effectTask = undefined;
    }
  }

  private async unknown(attemptId: string, reason: string): Promise<void> {
    const updated = this.storage().update((current) => {
      if (
        current.outcome.state !== "active" ||
        current.invocation?.state !== "executing" ||
        current.invocation.attemptId !== attemptId
      ) {
        return current;
      }
      return {
        ...current,
        invocation: { ...current.invocation, reason, state: "unknown-outcome" },
        outcome: { error: reason, state: "unknown-outcome" },
      };
    });
    if (updated.outcome.state === "unknown-outcome") {
      await this.checkpoint("unknown-outcome");
      await this.tryInterruptModel();
    }
  }

  private isOperationActive(): boolean {
    return this.storage().read()?.outcome.state === "active";
  }

  private async closeTerminalClient(): Promise<void> {
    if (this.isOperationActive()) {
      return;
    }
    const pending = this.client;
    if (!pending) {
      return;
    }
    let client: OpenCodeWorkerd.Interface;
    try {
      client = await pending;
    } catch {
      if (this.client === pending) {
        this.client = undefined;
      }
      return;
    }
    await client.close();
    if (this.client === pending) {
      this.client = undefined;
      this.brokerReady = false;
    }
  }

  private async tryInterruptModel(): Promise<boolean> {
    const sessionId = this.storage().read()?.sessionId;
    if (!this.client || !sessionId) {
      return false;
    }
    try {
      const client = await this.client;
      await client.session.interrupt(
        { continue: false, sessionID: sessionId },
        { signal: AbortSignal.timeout(5000) }
      );
      return true;
    } catch {
      return false;
    }
  }

  private async executeTool(
    input: unknown,
    sdkAttempt: SDKAttempt
  ): Promise<{ content: string }> {
    if (!this.brokerReady) {
      throw new Error("Fixture broker is not ready");
    }
    if (
      !input ||
      typeof input !== "object" ||
      !("value" in input) ||
      input.value !== fixtureValue ||
      Object.keys(input).length !== 1
    ) {
      throw new Error("Invalid fixture effect input");
    }
    const accepted = this.storage().read();
    if (!accepted) {
      throw new Error("Recovery operation is missing");
    }
    const argumentDigest = await digest(
      JSON.stringify({
        invocationId: `${accepted.operationId}:effect`,
        policyVersion: "fixture-policy-v1",
        requestDigest: accepted.requestDigest,
        toolVersion: "fixture-v1",
        value: fixtureValue,
      })
    );
    const run = this.storage().update((current) => {
      if (current.outcome.state !== "active") {
        throw new Error("Recovery operation is terminal");
      }
      if (current.invocation && current.invocation.digest !== argumentDigest) {
        throw new Error("Tool argument digest conflicts");
      }
      const invocation =
        current.invocation ??
        ({
          attempts: 0,
          digest: argumentDigest,
          invocationId: `${current.operationId}:effect`,
          sdkAttempts: [],
          state: "waiting-for-approval",
        } satisfies NonNullable<RecoveryRun["invocation"]>);
      const duplicate = invocation.sdkAttempts.some(
        (attempt) =>
          attempt.messageId === sdkAttempt.messageId &&
          attempt.callId === sdkAttempt.callId
      );
      return {
        ...current,
        invocation: {
          ...invocation,
          sdkAttempts: duplicate
            ? invocation.sdkAttempts
            : [...invocation.sdkAttempts, sdkAttempt],
        },
      };
    });
    if (run.invocation?.state === "waiting-for-approval") {
      await this.checkpoint("waiting-for-approval");
    }
    return await this.waitForToolResult(Date.now() + 300_000);
  }

  private async waitForToolResult(
    deadline: number
  ): Promise<{ content: string }> {
    const latest = this.storage().read();
    if (latest?.invocation?.state === "completed") {
      return { content: JSON.stringify(latest.invocation.result) };
    }
    if (!latest || latest.outcome.state !== "active") {
      throw new Error("Recovery operation is terminal");
    }
    if (Date.now() >= deadline) {
      throw new Error("Fixture approval or effect result timed out");
    }
    await delay(200);
    return await this.waitForToolResult(deadline);
  }

  private async initialize(): Promise<OpenCodeWorkerd.Interface> {
    return await OpenCodeWorkerd.create({
      config: {
        model: "fixture/controlled",
        permissions: [
          { action: "*", effect: "deny", resource: "*" },
          { action: "fixture_effect", effect: "allow", resource: "*" },
        ],
        providers: {
          fixture: {
            models: {
              controlled: {
                capabilities: {
                  input: ["text"],
                  output: ["text"],
                  tools: true,
                },
                limit: { context: 32_768, output: 1024 },
                name: "Controlled fixture",
              },
            },
            package: "@opencode-ai/ai/providers/openai-compatible",
            settings: {
              apiKey: "fixture",
              baseURL: `${this.env.FIXTURE_URL}/v1`,
            },
          },
        },
      },
      models: { fetch: false },
      plugins: [
        {
          id: "cerebro-recovery",
          setup: async (context) => {
            await context.tool.hook("execute.before", (event) => {
              if (event.tool !== "fixture_effect") {
                throw new Error("Only fixture_effect is permitted");
              }
              return Promise.resolve();
            });
            await context.tool.transform((draft) => {
              for (const tool of draft.list()) {
                draft.remove(tool.id);
              }
              draft.add({
                description: "Apply the approved fixture effect once.",
                execute: async (input, toolContext) =>
                  await this.executeTool(input, {
                    callId: toolContext.id,
                    messageId: toolContext.messageID,
                  }),
                input: {
                  additionalProperties: false,
                  properties: {
                    value: { const: fixtureValue, type: "string" },
                  },
                  required: ["value"],
                  type: "object",
                },
                name: "fixture_effect",
                options: { codemode: false },
              });
            });
            this.brokerReady = true;
            this.brokerRegistration.resolve(true);
          },
        },
      ],
      storage: this.ctx.storage,
    });
  }

  private async markUnconfirmedEffect(
    attemptId: string,
    reason: string
  ): Promise<boolean> {
    const pending = this.storage().read();
    if (
      pending?.outcome.state !== "active" ||
      pending.modelAttemptId !== attemptId ||
      pending.mode !== "non-idempotent" ||
      pending.invocation?.state !== "executing"
    ) {
      return false;
    }
    await this.unknown(pending.invocation.attemptId, reason);
    return true;
  }

  private async runModel(attemptId: string): Promise<void> {
    if (!this.isOperationActive()) {
      return;
    }
    let stage = "initialize";
    try {
      this.client ??= this.initialize();
      const client = await this.client;
      let run = this.storage().read();
      if (run?.outcome.state !== "active") {
        return;
      }
      if (!run.sessionId) {
        stage = "session-create";
        const session = await client.session.create();
        run = this.storage().update((current) => ({
          ...current,
          sessionId: session.id,
        }));
        await this.ctx.storage.sync();
      }
      const { sessionId } = run;
      if (!sessionId) {
        throw new Error("OpenCode session was not recorded");
      }
      stage = "message-list";
      const messages = await client.message.list({ sessionID: sessionId });
      stage = "inbox-list";
      const inbox = await client.session.inbox.list({ sessionID: sessionId });
      if (
        !messages.data.some((message) => message.id === run.messageId) &&
        !inbox.some((message) => message.id === run.messageId)
      ) {
        await this.checkpoint("model-started");
        stage = "prompt";
        await client.session.prompt({
          id: run.messageId,
          sessionID: sessionId,
          text: `operationId=${run.operationId} Call fixture_effect once with value approved-fixture, then reply Cerebro fixture completed.`,
        });
      } else {
        stage = "resume";
        const active = await client.session.active();
        if (!active[sessionId]) {
          await client.session.prompt({
            id: run.messageId,
            sessionID: sessionId,
            text: `operationId=${run.operationId} Call fixture_effect once with value approved-fixture, then reply Cerebro fixture completed.`,
          });
        }
      }
      stage = "broker-readiness";
      await Promise.race([
        this.brokerRegistration.promise,
        registrationDeadline(),
      ]);
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
      const finalMessages = await client.message.list({
        order: "asc",
        sessionID: sessionId,
      });
      const latest = this.storage().read();
      if (!latest) {
        return;
      }
      const { reply, ended, diagnostics, completedEffectMatchesLedger } =
        summarizeMessages(finalMessages.data, latest);
      this.storage().update((current) => ({
        ...current,
        toolDiagnostics: diagnostics,
      }));
      if (!ended) {
        await this.ctx.storage.sync();
        return;
      }
      if (
        await this.markUnconfirmedEffect(
          attemptId,
          "Model stopped before the dispatched effect was confirmed"
        )
      ) {
        return;
      }
      const final = this.storage().update((current) => {
        if (
          current.outcome.state !== "active" ||
          current.modelAttemptId !== attemptId
        ) {
          return current;
        }
        if (
          current.invocation?.state !== "completed" ||
          reply !== expectedReply ||
          !completedEffectMatchesLedger
        ) {
          return {
            ...current,
            outcome: {
              error: "OpenCode did not complete the brokered effect",
              state: "failed",
            },
          };
        }
        return { ...current, outcome: { reply, state: "completed" } };
      });
      if (final.outcome.state !== "active") {
        await this.checkpoint(final.outcome.state);
      }
    } catch {
      if (
        await this.markUnconfirmedEffect(
          attemptId,
          "Model failed before the dispatched effect was confirmed"
        )
      ) {
        return;
      }
      this.storage().update((current) => {
        if (
          current.outcome.state !== "active" ||
          current.modelAttemptId !== attemptId
        ) {
          return current;
        }
        return {
          ...current,
          outcome: {
            error: `OpenCode recovery loop failed at ${stage}`,
            state: "failed",
          },
        };
      });
      await this.ctx.storage.sync();
    } finally {
      this.modelTask = undefined;
    }
  }
}
