import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";

const emptyValues = new Map();
export class Qualification extends DurableObject {
  faux = fauxProvider({ tokensPerSecond: 5 });
  harness = new PiHarness({
    defaults: { model: this.faux.getModel() },
    harness: ({ storage, context }) => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS cerebro_probe (name TEXT PRIMARY KEY, value INTEGER)"
      );
      this.faux.setResponses(
        Array.from({ length: 20 }, () => async () => {
          this.ctx.storage.sql.exec(
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
      return Harness.open(
        storage,
        { models, registry: createRegistry() },
        context
      );
    },
  });
  lifecycle = Lifecycle.install(this).use(this.harness);
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/submit") {
      const { text, requestId } = await request.json();
      return Response.json(
        await this.harness.submit(text, { operationId: requestId })
      );
    }
    if (path === "/pending") {
      return Response.json(await this.harness.pending());
    }
    if (path === "/cancel") {
      const { requestId } = await request.json();
      return Response.json({
        cancelled: await this.harness.abort({ operationId: requestId }),
      });
    }
    if (path === "/wait") {
      return Response.json(
        await this.harness.wait(
          new URL(request.url).searchParams.get("requestId")
        )
      );
    }
    if (path === "/inspect") {
      const pi = await this.harness.pi();
      return Response.json(
        await pi.inspect({
          abortSignal: undefined,
          toString: () => "qualification",
          value: (key) => emptyValues.get(key),
        })
      );
    }
    if (path === "/snapshot") {
      const stream = await this.harness.session().events();
      const { snapshot } = stream;
      await stream.stop();
      return Response.json(snapshot);
    }
    const pi = await this.harness.pi();
    return Response.json({
      counters: this.ctx.storage.sql
        .exec("SELECT * FROM cerebro_probe")
        .toArray(),
      ready: Boolean(pi),
      tables: this.ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type = ?", "table")
        .toArray(),
    });
  }
}
export default {
  fetch(request, env) {
    return env.QUALIFICATION.getByName("proof-run").fetch(request);
  },
};
