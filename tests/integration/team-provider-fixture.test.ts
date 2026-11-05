/* oxlint-disable no-await-in-loop -- Each transcript turn consumes the preceding model or tool result. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { z } from "zod";

import { openAICompletionsApi } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js";
import {
  Type,
  createModels,
  createProvider,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import type {
  AssistantMessage,
  Context,
  Model,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import { waitForFixture } from "../slice-1/application.ts";
import { createFixture } from "../slice-1/provider.mjs";

const roleModels = {
  coordinator: "wire-coordinator-alpha",
  lead: "wire-lead-beta",
  worker: "wire-worker-gamma",
};
const startTool = {
  name: "start_team",
  description: "Start bounded background work.",
  parameters: Type.Object({ goal: Type.String() }),
};
const workerTool = {
  name: "delegate_worker",
  description: "Delegate one question.",
  parameters: Type.Object({ text: Type.String() }),
};
const workTools = [
  startTool,
  ...["get_work", "stop_work", "recall_work"].map((name) => ({
    name,
    description: "Read or control the selected work.",
    parameters: Type.Object({
      workId: Type.String(),
      offset: Type.Optional(Type.Integer()),
    }),
  })),
  {
    name: "list_work",
    description: "List a bounded page.",
    parameters: Type.Object({ cursor: Type.Optional(Type.String()) }),
  },
  {
    name: "message_team",
    description: "Update selected work.",
    parameters: Type.Object({ workId: Type.String(), text: Type.String() }),
  },
  ...["subscribe_work", "unsubscribe_work"].map((name) => ({
    name,
    description: "Bind the admitted Slack thread.",
    parameters: Type.Object({ workId: Type.String(), eventId: Type.String() }),
  })),
];
const returnTool = {
  name: "return_event",
  description: "Return an unrelated admitted event.",
  parameters: Type.Object({ eventId: Type.String(), reason: Type.String() }),
};
const user = (content: string): UserMessage => ({
  content,
  role: "user",
  timestamp: Date.now(),
});
const textOf = (message: AssistantMessage): string =>
  message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
const toolResult = (call: ToolCall, text: string): ToolResultMessage => ({
  content: [{ text, type: "text" }],
  isError: false,
  role: "toolResult",
  timestamp: Date.now(),
  toolCallId: call.id,
  toolName: call.name,
});
const onlyCall = (message: AssistantMessage, name: string): ToolCall => {
  const found = message.content.filter((block) => block.type === "toolCall");
  assert.deepEqual(
    found.map((call) => call.name),
    [name]
  );
  const [call] = found;
  assert.ok(call);
  return call;
};
const savedWork = (workId: string, kind = "accepted") => ({
  workId,
  status: { kind },
  deadlineAt: 1_900_000_000_000,
  canCancel: true,
});
const observationsSchema = z.object({
  held: z.number(),
  model: z.array(
    z.object({
      completedAt: z.number().optional(),
      firstTokenAt: z.number().optional(),
      model: z.string(),
      startedAt: z.number(),
    })
  ),
});
const setup = async (context: TestContext) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-team-fixture-"));
  const fixture = await createFixture({
    directory,
    fixtureId: "team-provider-fixture",
    sha: "team-provider-fixture-source",
  });
  context.after(async () => {
    if (fixture.server.listening) {
      const closed = once(fixture.server, "close");
      fixture.server.close();
      fixture.server.closeAllConnections();
      await closed;
    }
    await fixture.flush();
    await rm(directory, { force: true, recursive: true });
  });
  fixture.server.listen(0, "127.0.0.1");
  await once(fixture.server, "listening");
  const address = fixture.server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const configured = Object.values(roleModels).map(
    (id): Model<"openai-completions"> => ({
      api: "openai-completions",
      baseUrl: `${baseUrl}/v1`,
      contextWindow: 16_384,
      cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
      id,
      input: ["text"],
      maxTokens: 2048,
      name: id,
      provider: "fixture",
      reasoning: false,
    })
  );
  const models = createModels();
  models.setProvider(
    createProvider({
      api: openAICompletionsApi(),
      auth: {
        apiKey: {
          name: "fixture",
          resolve: () =>
            Promise.resolve({ auth: { apiKey: "fixture-model-key" } }),
        },
      },
      baseUrl: `${baseUrl}/v1`,
      id: "fixture",
      models: configured,
    })
  );
  const controls = async (input: unknown) => {
    const response = await fetch(`${baseUrl}/control`, {
      body: JSON.stringify(input),
      headers: {
        "Content-Type": "application/json",
        "X-Fixture-Control": "slice-1-control",
      },
      method: "POST",
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  };
  await controls({ delayMs: 0 });
  return {
    complete: async (modelId: string, transcript: Context) => {
      const model = configured.find((value) => value.id === modelId);
      assert.ok(model);
      const result = await models.completeSimple(model, transcript);
      assert.notEqual(
        result.stopReason,
        "error",
        result.errorMessage ?? "Fixture model failed."
      );
      return result;
    },
    controls,
    observed: async () => {
      const response = await fetch(`${baseUrl}/observations`);
      assert.equal(response.status, 200);
      return observationsSchema.parse(await response.json());
    },
  };
};

test(
  "Pi AI receives one coordinator call, two distinct worker calls, and a summary of the real tool results",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await setup(context);
    const request = user("SLACK_TEAM_FIXTURE run the two worker checks.");
    const coordinator = await fixture.complete(roleModels.coordinator, {
      messages: [request],
      tools: [startTool],
    });
    const starts = coordinator.content.filter(
      (block) => block.type === "toolCall"
    );
    assert.deepEqual(
      starts.map((call) => ({ name: call.name, arguments: call.arguments })),
      [
        {
          name: "start_team",
          arguments: {
            goal: "SLACK_TEAM_FIXTURE Analyze both worker checks and return a bounded summary.",
          },
        },
      ]
    );
    const start = starts.at(0);
    assert.ok(start);
    const acknowledged = await fixture.complete(roleModels.coordinator, {
      messages: [
        request,
        coordinator,
        toolResult(start, "Accepted fixture-work."),
      ],
      tools: [startTool],
    });
    assert.equal(
      textOf(acknowledged),
      "SLACK_TEAM_FIXTURE coordinator accepted background work."
    );
    const goal = user(
      z.object({ goal: z.string() }).parse(start.arguments).goal
    );
    const lead = await fixture.complete(roleModels.lead, {
      messages: [goal],
      tools: [workerTool],
    });
    const workers = lead.content.filter((block) => block.type === "toolCall");
    assert.deepEqual(
      workers.map((call) => ({ name: call.name, arguments: call.arguments })),
      [
        {
          name: "delegate_worker",
          arguments: {
            text: "SLACK_TEAM_FIXTURE worker:one. Return one bounded result.",
          },
        },
        {
          name: "delegate_worker",
          arguments: {
            text: "SLACK_TEAM_FIXTURE worker:two. Return one bounded result.",
          },
        },
      ]
    );
    assert.equal(new Set(workers.map((call) => call.id)).size, 2);
    const results = await Promise.all(
      workers.map(async (call) => {
        const input = z.object({ text: z.string() }).parse(call.arguments);
        const answer = await fixture.complete(roleModels.worker, {
          messages: [user(input.text)],
        });
        return toolResult(call, textOf(answer));
      })
    );
    const summary = await fixture.complete(roleModels.lead, {
      messages: [goal, lead, ...results],
      tools: [workerTool],
    });
    assert.equal(
      textOf(summary),
      "SLACK_TEAM_FIXTURE lead summary: SLACK_TEAM_FIXTURE worker one complete. SLACK_TEAM_FIXTURE worker two complete."
    );
    const ordinary = await fixture.complete(roleModels.coordinator, {
      messages: [user("Give an ordinary answer with no fixture marker.")],
      tools: [startTool, workerTool],
    });
    assert.equal(textOf(ordinary), "Cerebro slice 1 completed.");
    const observed = await fixture.observed();
    assert.deepEqual(
      observed.model.map((call) => call.model),
      [
        roleModels.coordinator,
        roleModels.coordinator,
        roleModels.lead,
        roleModels.worker,
        roleModels.worker,
        roleModels.lead,
        roleModels.coordinator,
      ]
    );
  }
);

test(
  "a per-model hold keeps the lead pending while the coordinator answers, and targeted delay applies on release",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await setup(context);
    await fixture.controls({
      models: { [roleModels.lead]: { delayMs: 0, hold: true } },
    });
    const pending = fixture.complete(roleModels.lead, {
      messages: [user("SLACK_TEAM_FIXTURE run the held lead.")],
      tools: [workerTool],
    });
    const held = await waitForFixture(
      fixture.observed,
      (value) => value.held === 1,
      5000
    );
    assert.equal(held.held, 1);
    assert.equal(held.model.at(0)?.model, roleModels.lead);
    const coordinator = await fixture.complete(roleModels.coordinator, {
      messages: [user("Keep the conversation responsive.")],
    });
    assert.equal(textOf(coordinator), "Cerebro slice 1 completed.");
    const beforeRelease = await fixture.observed();
    assert.equal(beforeRelease.held, 1);
    assert.equal(
      beforeRelease.model.find((call) => call.model === roleModels.lead)
        ?.completedAt,
      undefined
    );
    assert.ok(
      beforeRelease.model.find((call) => call.model === roleModels.coordinator)
        ?.completedAt
    );
    const releasedAt = Date.now();
    await fixture.controls({
      models: { [roleModels.lead]: { delayMs: 100, hold: false } },
    });
    const lead = await pending;
    assert.equal(
      lead.content.filter((block) => block.type === "toolCall").length,
      2
    );
    const afterRelease = await fixture.observed();
    assert.equal(afterRelease.held, 0);
    const leadCall = afterRelease.model.find(
      (call) => call.model === roleModels.lead
    );
    assert.ok(leadCall?.completedAt);
    assert.ok(
      leadCall.firstTokenAt && leadCall.firstTokenAt - releasedAt >= 75
    );
  }
);

for (const scenario of [
  {
    key: "storage:alpha",
    goal: "Compare SQLite with sync and IndexedDB with sync for an offline five-person task tracker.",
    workId: "actual-storage-work-29",
    status: "accepted",
    questions: [
      "PERSISTENT_AGENT_FIXTURE storage:alpha worker:correctness. Compare SQLite with sync and IndexedDB with sync for offline correctness, concurrent task edits, and recovery in a five-person task tracker. Return one bounded conclusion.",
      "PERSISTENT_AGENT_FIXTURE storage:alpha worker:effort. Compare implementation effort for SQLite with sync and IndexedDB with sync in an offline five-person task tracker. Include packaging, migrations, and sync maintenance. Return one bounded conclusion.",
    ],
    workerCheck: /SQLite|IndexedDB/u,
    contributions: [
      "Observed storage correctness A17: replayed outbox edits retain the task version.",
      "Observed storage effort B29: native packaging requires a separate migration check.",
    ],
    recommendation:
      "For the offline five-person tracker, prefer SQLite with sync when a native client can own the database. Use IndexedDB with sync for a browser-only client. Both need an explicit conflict policy.",
  },
  {
    key: "slack:beta",
    goal: "Review Slack event admission and uncertain reply delivery.",
    workId: "actual-slack-work-73",
    status: "queued",
    questions: [
      "PERSISTENT_AGENT_FIXTURE slack:beta worker:filtering. Review Slack event filtering and deduplication before durable admission. Cover signed replay, changed payloads, bot messages, and thread identity. Return one bounded conclusion.",
      "PERSISTENT_AGENT_FIXTURE slack:beta worker:delivery. Review Slack reply authority and uncertain physical posts. Cover the original thread, current access, accepted-before-503, and safe retry policy. Return one bounded conclusion.",
    ],
    workerCheck: /signed callback|original channel/u,
    contributions: [
      "Observed Slack filtering C31: the changed callback digest was rejected.",
      "Observed Slack delivery D43: the accepted post remained unknown without a resend.",
    ],
    recommendation:
      "For Slack event admission, filter before admission, bind replies to the admitted original thread, and keep delivery state. An accepted post with an unknown response must not be resent automatically.",
  },
]) {
  test(
    `the ${scenario.key} goal uses its returned ID, status, and independent worker contributions`,
    { timeout: 15_000 },
    async (context) => {
      const fixture = await setup(context);
      const request = user(
        `PERSISTENT_AGENT_FIXTURE ${scenario.key}. ${scenario.goal}`
      );
      const start = await fixture.complete(roleModels.coordinator, {
        messages: [request],
        tools: workTools,
      });
      const call = onlyCall(start, "start_team");
      assert.deepEqual(call.arguments, { goal: request.content });
      const acknowledgement = await fixture.complete(roleModels.coordinator, {
        messages: [
          request,
          start,
          toolResult(
            call,
            JSON.stringify(savedWork(scenario.workId, scenario.status))
          ),
        ],
        tools: workTools,
      });
      assert.equal(
        textOf(acknowledgement),
        `Work ${scenario.workId} is ${scenario.status} for ${scenario.key}.`
      );
      const goal = user(
        z.object({ goal: z.string() }).parse(call.arguments).goal
      );
      const lead = await fixture.complete(roleModels.lead, {
        messages: [goal],
        tools: [workerTool, returnTool],
      });
      const workers = lead.content.filter((block) => block.type === "toolCall");
      assert.deepEqual(
        workers.map((worker) => ({
          name: worker.name,
          arguments: worker.arguments,
        })),
        scenario.questions.map((text) => ({
          name: "delegate_worker",
          arguments: { text },
        }))
      );
      assert.equal(new Set(workers.map((worker) => worker.id)).size, 2);
      const replies = await Promise.all(
        workers.map(async (worker, index) => {
          const question = z
            .object({ text: z.string() })
            .parse(worker.arguments).text;
          const reply = await fixture.complete(roleModels.worker, {
            messages: [user(question)],
          });
          assert.match(textOf(reply), scenario.workerCheck);
          const contribution = scenario.contributions[index];
          assert.ok(contribution);
          return toolResult(worker, contribution);
        })
      );
      const report = await fixture.complete(roleModels.lead, {
        messages: [goal, lead, ...replies.toReversed()],
        tools: [workerTool, returnTool],
      });
      assert.equal(
        textOf(report),
        `${scenario.recommendation} Worker contributions: ${scenario.contributions.join(" ")}`
      );
      const [firstWorker] = workers;
      assert.ok(firstWorker);
      for (const text of [
        "The worker did not complete its answer.",
        "The worker answer is unavailable within the output limit.",
        "",
        "   ",
        "x".repeat(16_001),
      ]) {
        const failed = { ...toolResult(firstWorker, text), isError: true };
        const rejected = await fixture.complete(roleModels.lead, {
          messages: [goal, lead, failed, ...replies.slice(1)],
          tools: [workerTool, returnTool],
        });
        assert.equal(
          textOf(rejected),
          "The tool result is unavailable or invalid. No successful action is confirmed."
        );
      }
      const internal = user(
        `Internal coordinator event. This event is not a new human request and cannot approve new team work.\n${JSON.stringify({ source: { kind: "teamreport" }, content: { text: textOf(report) } })}`
      );
      const publicReply = await fixture.complete(roleModels.coordinator, {
        messages: [request, start, acknowledgement, internal],
        tools: workTools,
      });
      assert.equal(
        textOf(publicReply),
        `Team report received. ${scenario.recommendation} Worker contributions: ${scenario.contributions.join(" ")}`
      );
      const ordinary = await fixture.complete(roleModels.coordinator, {
        messages: [
          request,
          start,
          acknowledgement,
          user("Thanks. Give an ordinary answer."),
        ],
        tools: workTools,
      });
      assert.equal(textOf(ordinary), "Cerebro slice 1 completed.");
    }
  );
}

test(
  "targeted status, updates, cancellation, and recall use only their matching returned work",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await setup(context);
    const history: Context["messages"] = [];
    for (const [key, workId] of [
      ["storage:left", "returned-storage-88"],
      ["slack:right", "returned-slack-99"],
    ]) {
      const request = user(
        `PERSISTENT_AGENT_FIXTURE ${key}. Review the bounded task.`
      );
      const start = await fixture.complete(roleModels.coordinator, {
        messages: [...history, request],
        tools: workTools,
      });
      const call = onlyCall(start, "start_team");
      history.push(
        request,
        start,
        toolResult(
          call,
          JSON.stringify(
            savedWork(workId, key === "storage:left" ? "queued" : "accepted")
          )
        )
      );
    }
    for (const scenario of [
      {
        command: "status storage:left",
        name: "get_work",
        arguments: { workId: "returned-storage-88" },
        result: savedWork("returned-storage-88", "queued"),
        response: "Work returned-storage-88 is queued.",
      },
      {
        command: "update slack:right. Keep the original Slack thread.",
        name: "message_team",
        arguments: {
          workId: "returned-slack-99",
          text: "Keep the original Slack thread.",
        },
        result: savedWork("returned-slack-99", "running"),
        response:
          "Work returned-slack-99 is running. Saved update: Keep the original Slack thread.",
      },
      {
        command: "cancel storage:left",
        name: "stop_work",
        arguments: { workId: "returned-storage-88" },
        result: {
          ...savedWork("returned-storage-88"),
          status: { kind: "cancelled", commandId: "actual-cancel-task-4" },
        },
        response: "Work returned-storage-88 is cancelled.",
      },
    ]) {
      const request = user(`PERSISTENT_AGENT_FIXTURE ${scenario.command}`);
      const response = await fixture.complete(roleModels.coordinator, {
        messages: [...history, request],
        tools: workTools,
      });
      const call = onlyCall(response, scenario.name);
      assert.deepEqual(call.arguments, scenario.arguments);
      const receipt = toolResult(call, JSON.stringify(scenario.result));
      const done = await fixture.complete(roleModels.coordinator, {
        messages: [...history, request, response, receipt],
        tools: workTools,
      });
      assert.equal(textOf(done), scenario.response);
      history.push(request, response, receipt, done);
    }
    const ambiguous = await fixture.complete(roleModels.coordinator, {
      messages: [...history, user("PERSISTENT_AGENT_FIXTURE stop")],
      tools: workTools,
    });
    assert.equal(
      textOf(ambiguous),
      "Choose the task to cancel. No work was cancelled."
    );
    const request = user("PERSISTENT_AGENT_FIXTURE recall slack:right");
    const recall = await fixture.complete(roleModels.coordinator, {
      messages: [...history, request],
      tools: workTools,
    });
    const call = onlyCall(recall, "recall_work");
    assert.deepEqual(call.arguments, { workId: "returned-slack-99" });
    const first = {
      workId: "returned-slack-99",
      goal: "PERSISTENT_AGENT_FIXTURE slack:right. Review the bounded task.",
      status: { kind: "completed", reportId: "actual-report-9" },
      deadlineAt: 1_900_000_000_000,
      report: {
        id: "actual-report-9",
        key: {
          organizationId: "fixture-org",
          ownerPrincipalId: "fixture-owner",
          workId: "returned-slack-99",
        },
        contentDependencies: { sourceIds: [], toolIds: [] },
        kind: "completed",
        text: "Filtering evidence from the real report.",
      },
      reportOffset: 0,
      reportTruncated: true,
      nextReportOffset: 4000,
    };
    const transcript = [
      ...history,
      request,
      recall,
      toolResult(call, JSON.stringify(first)),
    ];
    const continuation = await fixture.complete(roleModels.coordinator, {
      messages: transcript,
      tools: workTools,
    });
    const next = onlyCall(continuation, "recall_work");
    assert.notEqual(next.id, call.id);
    assert.deepEqual(next.arguments, {
      workId: "returned-slack-99",
      offset: 4000,
    });
    const done = await fixture.complete(roleModels.coordinator, {
      messages: [
        ...transcript,
        continuation,
        toolResult(
          next,
          JSON.stringify({
            ...first,
            report: {
              ...first.report,
              text: "Delivery evidence from the next report chunk.",
            },
            reportOffset: 4000,
            reportTruncated: false,
            nextReportOffset: undefined,
          })
        ),
      ],
      tools: workTools,
    });
    assert.equal(
      textOf(done),
      "Work returned-slack-99 is completed. Filtering evidence from the real report. Delivery evidence from the next report chunk."
    );
  }
);

test(
  "a filtered empty list page continues before exact task lookup",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await setup(context);
    const request = user("PERSISTENT_AGENT_FIXTURE status storage:retained");
    const first = await fixture.complete(roleModels.coordinator, {
      messages: [request],
      tools: workTools,
    });
    const list = onlyCall(first, "list_work");
    assert.deepEqual(list.arguments, {});
    const messages: Context["messages"] = [
      request,
      first,
      toolResult(
        list,
        JSON.stringify({ items: [], next: "actual-next-cursor" })
      ),
    ];
    const second = await fixture.complete(roleModels.coordinator, {
      messages,
      tools: workTools,
    });
    const next = onlyCall(second, "list_work");
    assert.notEqual(next.id, list.id);
    assert.deepEqual(next.arguments, { cursor: "actual-next-cursor" });
    const row = {
      workId: "retained-real-work",
      goal: "PERSISTENT_AGENT_FIXTURE storage:retained. Compare local storage.",
      status: { kind: "running" },
      deadlineAt: 1_900_000_000_000,
    };
    messages.push(second, toolResult(next, JSON.stringify({ items: [row] })));
    const status = await fixture.complete(roleModels.coordinator, {
      messages,
      tools: workTools,
    });
    const get = onlyCall(status, "get_work");
    assert.deepEqual(get.arguments, { workId: "retained-real-work" });
    const done = await fixture.complete(roleModels.coordinator, {
      messages: [
        ...messages,
        status,
        toolResult(
          get,
          JSON.stringify(savedWork("retained-real-work", "running"))
        ),
      ],
      tools: workTools,
    });
    assert.equal(textOf(done), "Work retained-real-work is running.");
    const query = user("PERSISTENT_AGENT_FIXTURE list");
    const listing = await fixture.complete(roleModels.coordinator, {
      messages: [query],
      tools: workTools,
    });
    const listed = onlyCall(listing, "list_work");
    const summary = await fixture.complete(roleModels.coordinator, {
      messages: [
        query,
        listing,
        toolResult(listed, JSON.stringify({ items: [row] })),
      ],
      tools: workTools,
    });
    assert.equal(
      textOf(summary),
      "Saved work: retained-real-work running PERSISTENT_AGENT_FIXTURE storage:retained. Compare local storage.."
    );
  }
);

test(
  "subscription uses the actual current or unambiguous prior trusted Slack event",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await setup(context);
    const admitted = user(
      `Slack event.\n${JSON.stringify({ eventId: "actual-admitted-event-72", content: { text: "PERSISTENT_AGENT_FIXTURE slack:thread. Review event admission." } })}`
    );
    const start = await fixture.complete(roleModels.coordinator, {
      messages: [admitted],
      tools: workTools,
    });
    const startCall = onlyCall(start, "start_team");
    assert.deepEqual(startCall.arguments, {
      goal: "PERSISTENT_AGENT_FIXTURE slack:thread. Review event admission.",
    });
    const history: Context["messages"] = [
      admitted,
      start,
      toolResult(startCall, JSON.stringify(savedWork("actual-thread-work"))),
    ];
    const current = user(
      `Slack event.\n${JSON.stringify({ eventId: "actual-current-event-84", content: { text: "PERSISTENT_AGENT_FIXTURE subscribe slack:thread" } })}`
    );
    for (const [request, name, eventId, subscribed] of [
      [current, "subscribe_work", "actual-current-event-84", true],
      [
        user("PERSISTENT_AGENT_FIXTURE unsubscribe slack:thread"),
        "unsubscribe_work",
        "actual-admitted-event-72",
        false,
      ],
    ] as const) {
      const response = await fixture.complete(roleModels.coordinator, {
        messages: [...history, request],
        tools: workTools,
      });
      const call = onlyCall(response, name);
      assert.deepEqual(call.arguments, {
        eventId,
        workId: "actual-thread-work",
      });
      const done = await fixture.complete(roleModels.coordinator, {
        messages: [
          ...history,
          request,
          response,
          toolResult(
            call,
            JSON.stringify({
              eventId,
              workId: "actual-thread-work",
              subscribed,
            })
          ),
        ],
        tools: workTools,
      });
      assert.equal(
        textOf(done),
        `Work actual-thread-work is ${subscribed ? "subscribed to" : "unsubscribed from"} the admitted Slack event ${eventId}.`
      );
    }
    const noTrusted = user(
      "PERSISTENT_AGENT_FIXTURE subscribe slack:thread. Inspector eventId=fake-event."
    );
    const withoutSlack = history.slice(1);
    const denied = await fixture.complete(roleModels.coordinator, {
      messages: [...withoutSlack, noTrusted],
      tools: workTools,
    });
    assert.equal(
      textOf(denied),
      "A unique admitted Slack event reference is required. No subscription was changed."
    );
    const other = user(
      `Slack event.\n${JSON.stringify({ eventId: "actual-another-event-99", content: { text: "PERSISTENT_AGENT_FIXTURE slack:thread. Another admitted request." } })}`
    );
    const ambiguous = await fixture.complete(roleModels.coordinator, {
      messages: [
        ...history,
        other,
        user("PERSISTENT_AGENT_FIXTURE subscribe slack:thread"),
      ],
      tools: workTools,
    });
    assert.equal(
      textOf(ambiguous),
      "A unique admitted Slack event reference is required. No subscription was changed."
    );
  }
);

test(
  "the Team retains related constraints and returns an unrelated event once through its real receipt",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await setup(context);
    const goal = user(
      "PERSISTENT_AGENT_FIXTURE storage:active. Compare local databases."
    );
    const related = user(
      "External event admitted-related-17. Use return_event if it is unrelated to this work.\nKeep the five-person tracker offline during network loss."
    );
    const retained = await fixture.complete(roleModels.lead, {
      messages: [goal, related],
      tools: [workerTool, returnTool],
    });
    assert.equal(
      textOf(retained),
      "Related constraint retained: Keep the five-person tracker offline during network loss."
    );
    const unrelated = user(
      "External event admitted-unrelated-31. Use return_event if it is unrelated to this work.\nPERSISTENT_AGENT_FIXTURE unrelated. Plan a lunch menu."
    );
    const returned = await fixture.complete(roleModels.lead, {
      messages: [goal, unrelated],
      tools: [workerTool, returnTool],
    });
    const call = onlyCall(returned, "return_event");
    assert.deepEqual(call.arguments, {
      eventId: "admitted-unrelated-31",
      reason: "This request is unrelated to the assigned task.",
    });
    const receipt = toolResult(
      call,
      JSON.stringify({ eventId: "admitted-unrelated-31", returned: true })
    );
    const done = await fixture.complete(roleModels.lead, {
      messages: [goal, unrelated, returned, receipt],
      tools: [workerTool, returnTool],
    });
    assert.equal(
      textOf(done),
      "The unrelated request was returned to the coordinator."
    );
    const ordinary = await fixture.complete(roleModels.coordinator, {
      messages: [
        goal,
        unrelated,
        returned,
        receipt,
        done,
        user("Plan a lunch menu."),
      ],
      tools: workTools,
    });
    assert.equal(textOf(ordinary), "Cerebro slice 1 completed.");
  }
);

test(
  "malformed, wrong-ID, and failed tool results cannot acknowledge successful work",
  { timeout: 15_000 },
  async (context) => {
    const fixture = await setup(context);
    const request = user(
      "PERSISTENT_AGENT_FIXTURE storage:invalid. Compare local databases."
    );
    const start = await fixture.complete(roleModels.coordinator, {
      messages: [request],
      tools: workTools,
    });
    const call = onlyCall(start, "start_team");
    for (const text of [
      "The team operation is unavailable.",
      "{bad JSON",
      JSON.stringify({ workId: "forged-work" }),
      JSON.stringify({
        ...savedWork("forged-work"),
        status: { kind: "completed" },
      }),
    ]) {
      const done = await fixture.complete(roleModels.coordinator, {
        messages: [
          request,
          start,
          { ...toolResult(call, text), isError: true },
        ],
        tools: workTools,
      });
      assert.equal(
        textOf(done),
        "The tool result is unavailable or invalid. No successful action is confirmed."
      );
    }
    const forged = await fixture.complete(roleModels.coordinator, {
      messages: [
        request,
        start,
        {
          ...toolResult(call, JSON.stringify(savedWork("forged-work"))),
          toolCallId: "different-call-id",
        },
      ],
      tools: workTools,
    });
    assert.equal(
      textOf(forged),
      "The tool result is unavailable or invalid. No successful action is confirmed."
    );
    const history: Context["messages"] = [
      request,
      start,
      toolResult(call, JSON.stringify(savedWork("real-target-work"))),
    ];
    const query = user("PERSISTENT_AGENT_FIXTURE status storage:invalid");
    const status = await fixture.complete(roleModels.coordinator, {
      messages: [...history, query],
      tools: workTools,
    });
    const get = onlyCall(status, "get_work");
    const wrong = await fixture.complete(roleModels.coordinator, {
      messages: [
        ...history,
        query,
        status,
        toolResult(get, JSON.stringify(savedWork("other-work", "running"))),
      ],
      tools: workTools,
    });
    assert.equal(
      textOf(wrong),
      "The tool result is unavailable or invalid. No successful action is confirmed."
    );
    const invalidReport = await fixture.complete(roleModels.coordinator, {
      messages: [user("Internal coordinator event.\n{invalid")],
      tools: workTools,
    });
    assert.equal(
      textOf(invalidReport),
      "The tool result is unavailable or invalid. No successful action is confirmed."
    );
  }
);
