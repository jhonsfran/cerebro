import assert from "node:assert/strict";

import { Schema } from "effect";

import { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";
import {
  TeamCommandSchema,
  TeamReportDeliverySchema,
} from "../../packages/contracts/src/work.ts";
import { addressFor, evidence, waitFor } from "./helpers.ts";
import type { Stack } from "./helpers.ts";
import { runtimeJourney } from "./runtime-journey.ts";

const journey = runtimeJourney("team-results");
const call = (stack: Stack, path: string, body: unknown) =>
  fetch(`http://127.0.0.1:${stack.apiPort}/coord/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const inspection = Schema.Struct({
  receipt: Schema.NullOr(
    Schema.Struct({ status: Schema.Number, body: Schema.String })
  ),
  models: Schema.Array(Schema.Struct({ at: Schema.Number })),
  transport: Schema.Array(
    Schema.Struct({ at: Schema.Number, command: Schema.String })
  ),
  notifications: Schema.Array(Schema.Struct({ snapshot: Schema.String })),
});
journey(
  "team reports finish through the real private host and existing notifier without another coordinator call",
  async (stack) => {
    const address = addressFor("result-company", "notify-report-flow");
    const sentAt = Date.now();
    const sent = await call(stack, "send", {
      address,
      operationId: "original-human",
      text: "Start bounded work.",
    });
    assert.equal(sent.status, 200, await sent.clone().text());
    const inspected = await waitFor(
      async () => {
        const response = await call(stack, "inspect", { address });
        assert.equal(response.status, 200, await response.clone().text());
        return Schema.decodeUnknownSync(inspection)(await response.json());
      },
      (value) =>
        value.notifications.some((notification) =>
          notification.snapshot.includes("Answer from lead.")
        ),
      30_000
    );
    assert.equal(inspected.models.length, 2);
    const started = inspected.transport
      .map((row) =>
        Schema.decodeUnknownSync(TeamCommandSchema)(JSON.parse(row.command))
      )
      .find((command) => command.kind === "start");
    assert.ok(started);
    const read = await call(stack, "read", { address });
    assert.equal(read.status, 200);
    const parsed = Schema.decodeUnknownSync(
      Schema.Struct({ status: Schema.Literal("ok"), value: ChatSnapshot })
    )(await read.json());
    assert.equal(
      parsed.value.messages.filter(
        (message) =>
          message.role === "assistant" && message.text === "Answer from lead."
      ).length,
      1
    );
    const controls = await Promise.all([
      call(stack, "send", {
        address,
        operationId: "status-human",
        text: "status",
      }),
      call(stack, "send", { address, operationId: "stop-human", text: "stop" }),
    ]);
    assert.deepEqual(
      controls.map((response) => response.status),
      [200, 200]
    );
    const last = await call(stack, "inspect", { address });
    const observed = Schema.decodeUnknownSync(inspection)(await last.json());
    assert.equal(observed.models.length, 2);
    const teamResponse = await fetch(
      `http://127.0.0.1:${stack.apiPort}/team/published`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-team-name": JSON.stringify([
            "team-v1",
            started.work.key.organizationId,
            started.work.key.ownerPrincipalId,
            started.work.key.workId,
          ]),
        },
        body: "{}",
      }
    );
    assert.equal(teamResponse.status, 200);
    const published = Schema.decodeUnknownSync(
      Schema.Struct({ delivery: TeamReportDeliverySchema, at: Schema.Number })
    )(await teamResponse.json());
    assert.ok(published.at >= sentAt);
    await evidence(stack, "team-report-publication", {
      observed,
      published,
      snapshot: parsed.value,
    });
  }
);

journey(
  "status, direct updates and durable stop do not require an available coordinator model",
  async (stack) => {
    const address = addressFor("passive-company", "notify-report-flow-held");
    const send = (operationId: string, text: string) =>
      call(stack, "send", { address, operationId, text });
    const started = await send("initial-human", "Start bounded work.");
    assert.equal(started.status, 200, await started.clone().text());
    const inspected = await waitFor(
      async () => {
        const response = await call(stack, "inspect", { address });
        return Schema.decodeUnknownSync(inspection)(await response.json());
      },
      (value) => value.models.length === 2 && value.transport.length >= 2
    );
    const row = inspected.transport.at(-1);
    assert.ok(row);
    const input = Schema.decodeUnknownSync(TeamCommandSchema)(
      JSON.parse(row.command)
    );
    const disabled = await call(stack, "model-access", { address });
    assert.equal(disabled.status, 200);
    const status = await send("status-human", "status");
    const update = await send("update-human", "Continue with this update.");
    assert.deepEqual([status.status, update.status], [200, 200]);
    await waitFor(
      async () => {
        const response = await call(stack, "inspect", { address });
        return Schema.decodeUnknownSync(inspection)(await response.json());
      },
      (value) =>
        value.transport.some(
          (command) =>
            Schema.decodeUnknownSync(TeamCommandSchema)(
              JSON.parse(command.command)
            ).kind === "input"
        )
    );
    const stopped = await send("stop-human", "stop");
    assert.equal(stopped.status, 200, await stopped.clone().text());
    const teamName = JSON.stringify([
      "team-v1",
      input.work.key.organizationId,
      input.work.key.ownerPrincipalId,
      input.work.key.workId,
    ]);
    const terminal = await waitFor(
      async () => {
        const response = await fetch(
          `http://127.0.0.1:${stack.apiPort}/team/inspect`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-team-name": teamName,
            },
            body: "{}",
          }
        );
        return Schema.decodeUnknownSync(
          Schema.Struct({ state: Schema.Struct({ phase: Schema.String }) })
        )(await response.json());
      },
      (value) => value.state.phase === "cancelled"
    );
    const source = await call(stack, "inspect", { address });
    const observed = Schema.decodeUnknownSync(inspection)(await source.json());
    assert.equal(observed.models.length, 2);
    assert.equal(
      observed.transport.filter(
        (command) =>
          Schema.decodeUnknownSync(TeamCommandSchema)(
            JSON.parse(command.command)
          ).kind === "cancel"
      ).length,
      1
    );
    await evidence(stack, "passive-model-unavailable", { observed, terminal });
  }
);
