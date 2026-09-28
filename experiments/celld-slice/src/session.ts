import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";
import { Agent } from "agents";

import { Ledger } from "./ledger";

interface SessionEnvironment {
  FIXTURE_URL: string;
}
const expectedReply = "Cerebro fixture completed.";
const operationPattern = /^[A-Za-z0-9_-]{1,128}$/u;

export class Session extends Agent<SessionEnvironment> {
  private ledger: Ledger | undefined;
  private embedded:
    | Promise<{ client: OpenCodeWorkerd.Interface; sessionId: string }>
    | undefined;

  private storage(): Ledger {
    this.ledger ??= new Ledger(this.ctx.storage);
    return this.ledger;
  }

  private async initialize() {
    const client = await OpenCodeWorkerd.create({
      config: {
        model: "fixture/deterministic",
        permissions: [
          { action: "*", effect: "deny", resource: "*" },
          { action: "fixture_probe", effect: "allow", resource: "*" },
        ],
        providers: {
          fixture: {
            models: {
              deterministic: {
                capabilities: {
                  input: ["text"],
                  output: ["text"],
                  tools: true,
                },
                limit: { context: 8192, output: 1024 },
                name: "Deterministic fixture",
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
          id: "cerebro-fixture",
          async setup(context) {
            await context.tool.hook("execute.before", (event) => {
              if (event.tool !== "fixture_probe") {
                throw new Error("Fixture permits only fixture_probe");
              }
              return Promise.resolve();
            });
            await context.tool.transform((draft) => {
              for (const tool of draft.list()) {
                draft.remove(tool.id);
              }
              draft.add({
                description:
                  "Return the deterministic compatibility probe value.",
                execute() {
                  return Promise.resolve({ content: "fixture-probe-ok" });
                },
                input: {
                  additionalProperties: false,
                  properties: {},
                  type: "object",
                },
                name: "fixture_probe",
                options: { codemode: false },
              });
            });
          },
        },
      ],
      storage: this.ctx.storage,
    });
    const ledger = this.storage();
    let sessionId = ledger.sessionId();
    if (!sessionId) {
      const session = await client.session.create();
      sessionId = session.id;
      ledger.saveSession(sessionId);
    }
    await client.session.get({ sessionID: sessionId });
    return { client, sessionId };
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname.endsWith("/storage")) {
        const tables = this.ctx.storage.sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
          )
          .toArray();
        return Response.json({ ok: true, tables });
      }
      this.embedded ??= this.initialize();
      const { client, sessionId } = await this.embedded;
      if (request.method === "GET") {
        const health = await client.health.get();
        const model = await client.model.default();
        const messages = await client.message.list({ sessionID: sessionId });
        return Response.json({
          health,
          messages: messages.data,
          model,
          ok: true,
          sessionId,
        });
      }
      if (
        request.method !== "POST" ||
        !new URL(request.url).pathname.endsWith("/prompt")
      ) {
        return Response.json(
          { error: "Unknown session route", ok: false },
          { status: 404 }
        );
      }
      const body: unknown = await request.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("operationId" in body) ||
        typeof body.operationId !== "string" ||
        !operationPattern.test(body.operationId)
      ) {
        return Response.json(
          { error: "A valid operationId is required", ok: false },
          { status: 400 }
        );
      }
      const { operationId } = body;
      const ledger = this.storage();
      const previous = ledger.operation(operationId);
      if (previous?.result) {
        return new Response(previous.result, {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (previous) {
        return Response.json(
          { ok: false, operationId, status: "incomplete" },
          { status: 409 }
        );
      }
      ledger.start(operationId);
      const existingMessages = await client.message.list({
        sessionID: sessionId,
      });
      const existingIds = new Set(
        existingMessages.data.map((message) => message.id)
      );
      await client.session.prompt({
        sessionID: sessionId,
        text: "Call fixture_probe once, then reply Cerebro fixture completed.",
      });
      await client.session.wait({ sessionID: sessionId });
      const messages = await client.message.list({ sessionID: sessionId });
      const assistants = messages.data
        .filter((message) => message.type === "assistant")
        .filter((message) => !existingIds.has(message.id));
      const toolCalls = assistants
        .flatMap((message) => message.content)
        .filter(
          (part) =>
            part.type === "tool" &&
            part.name === "fixture_probe" &&
            part.state.status === "completed"
        );
      const reply = assistants
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim();
      const model = await client.model.default();
      const ok = toolCalls.length === 1 && reply === expectedReply;
      const result = JSON.stringify({
        coverage: "loop-only",
        model,
        ok,
        operationId,
        reply,
        sessionId,
        toolCalls: toolCalls.length,
      });
      if (ok) {
        ledger.complete(operationId, result);
      }
      return new Response(result, {
        headers: { "Content-Type": "application/json" },
        status: ok ? 200 : 502,
      });
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error &&
            error.message === "Database is not empty and has no session table"
              ? "Database is not empty and has no session table"
              : "Session probe failed",
          ok: false,
        },
        { status: 500 }
      );
    }
  }
}
