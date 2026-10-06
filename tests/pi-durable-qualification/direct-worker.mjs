import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { DurableObject } from "cloudflare:workers";

import { openStorage } from "./sqlite.mjs";

const emptyValues = new Map();
const background = {
  abortSignal: undefined,
  toString: () => "qualification",
  value: (key) => emptyValues.get(key),
};
export class Qualification extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.start = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS cerebro_probe (name TEXT PRIMARY KEY, value INTEGER)"
      );
      this.storage = await openStorage(ctx.storage);
      this.faux = fauxProvider({ tokensPerSecond: 5 });
      this.faux.setResponses(
        Array.from({ length: 30 }, () => async () => {
          ctx.storage.sql.exec(
            "INSERT INTO cerebro_probe VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value=value+1",
            "model_calls"
          );
          // oxlint-disable-next-line promise/avoid-new -- Controlled provider delay uses the worker timer API.
          await new Promise((resolve) => {
            setTimeout(resolve, 10_000);
          });
          return fauxAssistantMessage("qualified answer");
        })
      );
      const models = createModels();
      models.setProvider(this.faux.provider);
      this.pi = await Harness.open(
        this.storage,
        { models, registry: createRegistry() },
        background
      );
      this.root = await this.pi.root(background, {
        agent: {
          model: {
            modelId: this.faux.getModel().id,
            provider: this.faux.getModel().provider,
          },
        },
      });
      this.pi.resume();
    });
  }
  async alarm() {
    await this.start;
    this.pi.resume();
    await this.ctx.storage.setAlarm(Date.now() + 2000);
    await this.pi.waitForIdle(background);
    await this.ctx.storage.deleteAlarm();
  }
  async fetch(request) {
    await this.start;
    const url = new URL(request.url);
    if (url.pathname === "/submit") {
      const { text, requestId } = await request.json();
      await this.ctx.storage.setAlarm(Date.now() + 2000);
      const submission = await this.root.submit(
        { content: text, requestId, type: "input", whenBusy: "followUp" },
        background
      );
      return Response.json({ id: submission.id, requestId });
    }
    if (url.pathname === "/inspect") {
      return Response.json(await this.pi.inspect(background));
    }
    if (url.pathname === "/cancel") {
      const { requestId } = await request.json();
      const submission = await this.storage.submissionByRequest(
        this.root.id,
        requestId,
        background
      );
      if (!submission) {
        return new Response("not found", { status: 404 });
      }
      const result = await this.pi.abortSubmission(
        submission.id,
        background,
        this.root.id
      );
      if (result === "already_placed") {
        const inspection = await this.pi.inspect(background);
        const task = inspection.tasks
          .map((item) => item.record)
          .find(
            (item) =>
              item.conversationId === this.root.id &&
              item.kind === "pi.generation"
          );
        if (!task) {
          return new Response("no identifiable run task", { status: 409 });
        }
        await this.pi.abortTask(task.id, background);
      }
      return Response.json({ result });
    }
    if (url.pathname === "/receipt") {
      return Response.json(
        await this.storage.submissionByRequest(
          this.root.id,
          url.searchParams.get("requestId"),
          background
        )
      );
    }
    return Response.json({
      alarm: await this.ctx.storage.getAlarm(),
      counters: this.ctx.storage.sql
        .exec("SELECT * FROM cerebro_probe")
        .toArray(),
      ready: true,
      tables: this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray(),
    });
  }
}
export default {
  fetch(request, env) {
    return env.QUALIFICATION.getByName(
      new URL(request.url).searchParams.get("conversation") ?? "direct-proof"
    ).fetch(request);
  },
};
