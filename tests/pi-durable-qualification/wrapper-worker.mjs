import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";

export class Qualification extends DurableObject {
  faux = fauxProvider({ tokensPerSecond: 5 });
  harness = new PiHarness({
    defaults: { model: this.faux.getModel() },
    harness: ({ storage, context }) => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS cerebro_probe (name TEXT PRIMARY KEY, value INTEGER)"
      );
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS cerebro_probe_calls (position INTEGER PRIMARY KEY AUTOINCREMENT, messages TEXT NOT NULL)"
      );
      this.faux.setResponses(
        Array.from({ length: 20 }, () => async (transcript) => {
          this.count("model_calls");
          this.ctx.storage.sql.exec(
            "INSERT INTO cerebro_probe_calls (messages) VALUES (?)",
            JSON.stringify(transcript.messages)
          );
          // oxlint-disable-next-line promise/avoid-new -- Controlled delay uses the worker timer API.
          await new Promise((resolve) => {
            setTimeout(resolve, 3000);
          });
          const toolRequested = transcript.messages.some(
            (message) =>
              message.role === "user" && message.content === "tool-before-steer"
          );
          const toolCompleted = transcript.messages.some(
            (message) => message.role === "toolResult"
          );
          return toolRequested && !toolCompleted
            ? fauxAssistantMessage(
                fauxToolCall(
                  "qualification_round",
                  {},
                  { id: "probe-tool-call" }
                ),
                { stopReason: "toolUse" }
              )
            : fauxAssistantMessage("qualified answer");
        })
      );
      const registry = createRegistry();
      registry.install({
        name: "qualification",
        tools: [
          {
            description:
              "Controlled harmless tool round for native steering qualification",
            execute: () => {
              this.count("tool_calls");
              return { content: [{ text: "controlled result", type: "text" }] };
            },
            name: "qualification_round",
            parameters: Type.Object({}),
            replay: "safe",
          },
        ],
      });
      const models = createModels();
      models.setProvider(this.faux.provider);
      return Harness.open(storage, { models, registry }, context);
    },
  });
  lifecycle = Lifecycle.install(this).use(this.harness);
  count(name) {
    this.ctx.storage.sql.exec(
      "INSERT INTO cerebro_probe VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value=value+1",
      name
    );
  }
  async onRequest(request) {
    const url = new URL(request.url);
    const route = url.pathname;
    const session = this.harness.session();
    if (["/submit", "/steer", "/replace"].includes(route)) {
      const { text, requestId } = await request.json();
      if (
        typeof text !== "string" ||
        typeof requestId !== "string" ||
        !requestId.trim()
      ) {
        return Response.json({ error: "InvalidInput" }, { status: 400 });
      }
      if (route === "/steer") {
        return Response.json(
          await session.steer(text, { operationId: requestId })
        );
      }
      // Qualification of the native sequence only. Durable replace retry needs the
      // Cerebro command journal; this route does not claim crash-safe replacement.
      if (route === "/replace") {
        await session.abort();
      }
      return Response.json(
        await session.submit(text, { operationId: requestId })
      );
    }
    if (route === "/cancel") {
      const { requestId } = await request.json();
      return Response.json({ cancelled: await session.abort(requestId) });
    }
    if (route === "/pending") {
      return Response.json(await this.harness.pending());
    }
    if (route === "/wait") {
      return Response.json(
        await session.wait(url.searchParams.get("requestId"))
      );
    }
    if (route === "/snapshot") {
      const stream = await session.events();
      const { snapshot } = stream;
      await stream.stop();
      return Response.json(snapshot);
    }
    if (route === "/messages") {
      return Response.json(await session.messages());
    }
    return Response.json({
      alarm: await this.ctx.storage.getAlarm(),
      calls: this.ctx.storage.sql
        .exec("SELECT * FROM cerebro_probe_calls ORDER BY position")
        .toArray(),
      counters: this.ctx.storage.sql
        .exec("SELECT * FROM cerebro_probe")
        .toArray(),
      ready: true,
      tables: this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = ?", "table")
        .toArray(),
    });
  }
}
export default {
  fetch(request, env) {
    const conversation =
      new URL(request.url).searchParams.get("conversation") ?? "proof-run";
    return env.QUALIFICATION.getByName(conversation).fetch(request);
  },
};
