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
            setTimeout(resolve, 3000);
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
  async onStart() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cerebro_admissions (position INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT UNIQUE NOT NULL, input TEXT NOT NULL, input_digest TEXT NOT NULL, state TEXT NOT NULL, engine_accepted INTEGER NOT NULL DEFAULT 0, result TEXT)"
    );
    if (this.outstanding().length) {
      await this.wake();
    }
  }
  admission(requestId) {
    return this.ctx.storage.sql
      .exec("SELECT * FROM cerebro_admissions WHERE request_id = ?", requestId)
      .toArray()[0];
  }
  outstanding() {
    return this.ctx.storage.sql
      .exec(
        "SELECT * FROM cerebro_admissions WHERE state IN ('queued', 'dispatching', 'running', 'cancelling') ORDER BY position"
      )
      .toArray();
  }
  async wake() {
    await this.lifecycle.jobs.push({
      fn: "admissions",
      id: "cerebro-admissions",
      singleflight: true,
      time: Date.now() + 500,
    });
  }
  async onJob({ job }) {
    if (job.fn !== "admissions") {
      throw new Error("Unexpected host job");
    }
    await this.pump();
    return this.outstanding().length
      ? { rescheduleAt: Date.now() + 500 }
      : undefined;
  }
  async pump() {
    if (this.pumping) {
      await this.pumping;
      return this.pump();
    }
    this.pumping = this.drive();
    try {
      await this.pumping;
    } finally {
      this.pumping = undefined;
    }
  }
  async drive() {
    const current = this.outstanding().find((row) => row.state !== "queued");
    if (current) {
      // Retry only an ambiguous handoff, with its original id and stored input.
      if (!current.engine_accepted) {
        await this.harness.submit(current.input, {
          operationId: current.request_id,
        });
        this.ctx.storage.sql.exec(
          "UPDATE cerebro_admissions SET engine_accepted = 1 WHERE request_id = ?",
          current.request_id
        );
      }
      if (this.admission(current.request_id).state === "cancelling") {
        await this.harness.abort({ operationId: current.request_id });
      }
      const pending = await this.harness.pending();
      if (pending.some((row) => row.operationId === current.request_id)) {
        return;
      }
      const result = await this.harness.wait(current.request_id);
      const cancelled =
        this.admission(current.request_id).state === "cancelling";
      let state = "failed";
      if (result.status === "done") {
        state = "completed";
      } else if (cancelled) {
        state = "cancelled";
      }
      this.ctx.storage.sql.exec(
        "UPDATE cerebro_admissions SET state = ?, result = ? WHERE request_id = ?",
        state,
        JSON.stringify(result),
        current.request_id
      );
    }
    const next = this.outstanding().find((row) => row.state === "queued");
    if (!next) {
      return;
    }
    // Cerebro retains later admissions; Pi owns only the handed-off run.
    this.ctx.storage.sql.exec(
      "UPDATE cerebro_admissions SET state = 'dispatching' WHERE request_id = ? AND state = 'queued'",
      next.request_id
    );
    await this.harness.submit(next.input, { operationId: next.request_id });
    this.ctx.storage.sql.exec(
      "UPDATE cerebro_admissions SET engine_accepted = 1, state = CASE WHEN state = 'dispatching' THEN 'running' ELSE state END WHERE request_id = ?",
      next.request_id
    );
  }
  async admit(text, requestId) {
    if (
      typeof text !== "string" ||
      typeof requestId !== "string" ||
      !requestId.trim()
    ) {
      return Response.json({ error: "InvalidInput" }, { status: 400 });
    }
    const bytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    );
    const digest = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    const prior = this.admission(requestId);
    if (prior && prior.input_digest !== digest) {
      return Response.json({ error: "Conflict" }, { status: 409 });
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO cerebro_admissions (request_id, input, input_digest, state) VALUES (?, ?, ?, 'queued') ON CONFLICT(request_id) DO NOTHING",
      requestId,
      text,
      digest
    );
    // A queued receipt acknowledges durable host admission plus a Lifecycle wake.
    await this.wake();
    await this.pump();
    return Response.json({
      accepted: !prior,
      operationId: requestId,
      state: this.admission(requestId).state,
    });
  }
  async cancel(requestId) {
    const prior = this.admission(requestId);
    if (!prior) {
      return Response.json({ error: "NotFound" }, { status: 404 });
    }
    this.ctx.storage.sql.exec(
      "UPDATE cerebro_admissions SET state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE 'cancelling' END WHERE request_id = ? AND state IN ('queued', 'dispatching', 'running')",
      requestId
    );
    await this.wake();
    await this.pump();
    return Response.json(this.admission(requestId));
  }
  async onRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/submit") {
      const { text, requestId } = await request.json();
      return this.admit(text, requestId);
    }
    if (path === "/cancel") {
      const { requestId } = await request.json();
      return this.cancel(requestId);
    }
    if (path === "/admissions") {
      return Response.json(
        this.ctx.storage.sql
          .exec("SELECT * FROM cerebro_admissions ORDER BY position")
          .toArray()
      );
    }
    if (path === "/receipt") {
      return Response.json(this.admission(url.searchParams.get("requestId")));
    }
    if (path === "/raw/submit") {
      const { text, requestId } = await request.json();
      return Response.json(
        await this.harness.submit(text, { operationId: requestId })
      );
    }
    if (path === "/pending") {
      return Response.json(await this.harness.pending());
    }
    if (path === "/raw/cancel") {
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
      alarm: await this.ctx.storage.getAlarm(),
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
    const conversation =
      new URL(request.url).searchParams.get("conversation") ?? "proof-run";
    return env.QUALIFICATION.getByName(conversation).fetch(request);
  },
};
