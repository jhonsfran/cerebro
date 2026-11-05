import assert from "node:assert/strict";
import { test } from "node:test";

import { Schema } from "effect";

import {
  BotEventSchema,
  botEventId,
} from "../../packages/contracts/src/bot-events.ts";
import { id } from "../../packages/contracts/src/identity.ts";
import { ChatReceipt } from "../../packages/contracts/src/session-service.ts";
import type { StorageWrite } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import { parseInputCorrelation } from "../slice-1/provider.mjs";
import { context, setup } from "./coordinator-fixture.ts";
import { actor, setupWeb } from "./coordinator-web-fixture.ts";
import {
  matchCommittedInput,
  physicalInput,
  readInputCorrelation,
} from "./fixture-input.ts";

test("real web admissions join identical public operations to distinct exact source inputs and physical calls", async () => {
  const fixture = await setup();
  const storage = fixture.storage();
  const commit = storage.commit.bind(storage);
  const batches: (readonly StorageWrite[])[] = [];
  storage.commit = async (writes, commitContext) => {
    batches.push(structuredClone(writes));
    return await commit(writes, commitContext);
  };
  try {
    const operationId = "same-public-operation";
    const relations = await Promise.all(
      ["a", "b"].map(async (name) => {
        const current = fixture.source(name);
        const source = {
          address: current.address,
          ownerPrincipalId: actor.actor.id,
          nativeSessionId: String(current.native.id),
        };
        const origin = {
          kind: "web" as const,
          operationId: id.operation(operationId),
        };
        const text = `Original evidence for ${name}.`;
        const event = Schema.decodeUnknownSync(BotEventSchema)({
          version: 1,
          id: await botEventId(current.address, origin),
          coordinator: current.address,
          ownerPrincipalId: actor.actor.id,
          source: origin,
          replyTo: null,
          content: { text, reference: null },
          dependencies: { sourceIds: [], toolIds: [] },
        });
        await fixture.events().admit(event, actor);
        const receipt = await fixture
          .pi()
          .snapshot(BotEventReceipts, event.id, context);
        assert.equal(receipt?.receipt?.delivery.kind, "coordinator");
        if (receipt?.receipt?.delivery.kind !== "coordinator") {
          throw new Error(
            "The real event was not admitted to the coordinator."
          );
        }
        await fixture
          .pi()
          .waitForTask(receipt.receipt.delivery.taskId, context);
        const relation = await readInputCorrelation(
          fixture.pi(),
          source,
          operationId,
          text
        );
        const acceptedInput = await fixture
          .pi()
          .commit(
            (tx) => tx.submissionByRequest(current.native.id, event.id),
            context
          );
        assert.ok(
          acceptedInput?.type === "input" && acceptedInput.entry !== undefined
        );
        assert.equal(relation.entryId, String(acceptedInput.entry));
        assert.equal(relation.submissionId, String(acceptedInput.id));
        assert.deepEqual(relation, {
          address: current.address,
          operationId,
          eventId: event.id,
          nativeRequestId: event.id,
          nativeSessionId: String(current.native.id),
          entryId: relation.entryId,
          submissionId: relation.submissionId,
        });
        const batch = batches.find((writes) =>
          matchCommittedInput(
            writes,
            source.nativeSessionId,
            operationId,
            "submission"
          )
        );
        assert.ok(batch);
        assert.deepEqual(
          matchCommittedInput(
            batch,
            source.nativeSessionId,
            operationId,
            "submission"
          ),
          {
            kind: "submission",
            nativeRequestId: relation.nativeRequestId,
            entryId: relation.entryId,
            submissionId: relation.submissionId,
          }
        );
        const physical = await physicalInput(
          fixture.pi(),
          source,
          event.id,
          "old-instance"
        );
        assert.deepEqual(physical, {
          kind: "web",
          ...relation,
          instanceId: "old-instance",
        });
        assert.deepEqual(
          parseInputCorrelation(
            JSON.stringify({
              ...physical,
              prompt: "This field must not be persisted.",
            }),
            event.id
          ),
          physical
        );
        assert.throws(
          () =>
            parseInputCorrelation(JSON.stringify(physical), "another-request"),
          /another physical request/u
        );
        assert.throws(
          () =>
            parseInputCorrelation(
              JSON.stringify({ ...physical, eventId: "another-event" }),
              event.id
            ),
          /another native request/u
        );
        await assert.rejects(
          readInputCorrelation(
            fixture.pi(),
            source,
            operationId,
            "Changed original text."
          ),
          /original text/u
        );
        await assert.rejects(
          readInputCorrelation(
            fixture.pi(),
            { ...source, ownerPrincipalId: id.principal("another-owner") },
            operationId,
            text
          ),
          /do not agree/u
        );
        await assert.rejects(
          readInputCorrelation(
            fixture.pi(),
            {
              ...source,
              address: {
                ...source.address,
                agentId: id.agent("another-agent"),
              },
            },
            operationId,
            text
          ),
          /do not agree/u
        );
        const changed = batch.map((write) =>
          write.type === "entry" && String(write.value.id) === relation.entryId
            ? {
                ...write,
                value: {
                  ...write.value,
                  data: {
                    eventId: "another-event",
                    source: "web",
                    operationId,
                  },
                },
              }
            : write
        );
        assert.equal(
          matchCommittedInput(
            changed,
            source.nativeSessionId,
            operationId,
            "submission"
          ),
          undefined
        );
        assert.equal(
          matchCommittedInput(
            batch,
            source.nativeSessionId,
            "another-operation",
            "submission"
          ),
          undefined
        );
        assert.equal(
          matchCommittedInput(
            batch,
            source.nativeSessionId,
            operationId,
            "compaction"
          ),
          undefined
        );
        return relation;
      })
    );
    assert.deepEqual(
      relations.map((relation) => relation.operationId),
      [operationId, operationId]
    );
    assert.notEqual(
      relations[0]?.nativeRequestId,
      relations[1]?.nativeRequestId
    );
    assert.notEqual(
      relations[0]?.nativeSessionId,
      relations[1]?.nativeSessionId
    );
    assert.notEqual(relations[0]?.entryId, relations[1]?.entryId);
    for (const relation of relations) {
      const other = relations.find((candidate) => candidate !== relation);
      assert.ok(other);
      const own = batches.find((batch) =>
        matchCommittedInput(
          batch,
          relation.nativeSessionId,
          operationId,
          "submission"
        )
      );
      assert.ok(own);
      assert.equal(
        matchCommittedInput(
          own,
          other.nativeSessionId,
          operationId,
          "submission"
        ),
        undefined
      );
    }
  } finally {
    await fixture.close();
  }
});

test("durable web admission with a disabled model retains the exact failed native input without a provider call", async () => {
  const subject = await setupWeb(true);
  try {
    subject.setModelEnabled(false);
    const operationId = "denied-model-input";
    const text = "Continue with this update.";
    const response = await subject.send(operationId, text);
    assert.equal(response.status, 200);
    const accepted = Schema.decodeUnknownSync(
      Schema.Struct({ status: Schema.Literal("ok"), value: ChatReceipt })
    )(await response.json());
    assert.equal(accepted.value.accepted, true);
    const stored = await subject.fixture.pi().snapshot(
      BotEventReceipts,
      await botEventId(subject.source.address, {
        kind: "web",
        operationId: id.operation(operationId),
      }),
      context
    );
    assert.ok(stored?.receipt?.delivery.kind === "coordinator");
    await subject.fixture
      .pi()
      .waitForTask(stored.receipt.delivery.taskId, context);
    const relation = await readInputCorrelation(
      subject.fixture.pi(),
      {
        address: subject.source.address,
        ownerPrincipalId: actor.actor.id,
        nativeSessionId: String(subject.source.native.id),
      },
      operationId,
      text
    );
    const native = await subject.fixture
      .pi()
      .commit(
        (tx) =>
          tx.submissionByRequest(
            subject.source.native.id,
            relation.nativeRequestId
          ),
        context
      );
    assert.equal(native?.status, "unanswered");
    assert.equal(String(native?.entry), relation.entryId);
    const history = await subject.source.native.context(context);
    const error = history.entries
      .flatMap((entry) => entry.model ?? [])
      .find(
        (message) =>
          message.role === "assistant" && message.stopReason === "error"
      );
    assert.ok(error?.role === "assistant");
    assert.equal(
      error.errorMessage,
      "Controlled model request failed or was denied"
    );
    assert.equal(subject.source.faux.state.callCount, 0);
    assert.equal(subject.fixture.calls.length, 0);
  } finally {
    await subject.close();
  }
});

test("real retained native user admissions and compaction batches keep their exact conversation boundary", async () => {
  const fixture = await setup();
  const storage = fixture.storage();
  const commit = storage.commit.bind(storage);
  const batches: (readonly StorageWrite[])[] = [];
  storage.commit = async (writes, commitContext) => {
    batches.push(structuredClone(writes));
    return await commit(writes, commitContext);
  };
  try {
    const current = fixture.source("a");
    const sibling = fixture.source("b");
    const input = await current.native.submit(
      {
        type: "input",
        content: "An actual retained native input.",
        requestId: "retained-input",
      },
      context
    );
    const settled = await input.wait(context);
    assert.equal(settled.status, "done");
    const batch = batches.find((writes) =>
      matchCommittedInput(
        writes,
        String(current.native.id),
        "retained-input",
        "submission"
      )
    );
    assert.ok(batch);
    assert.deepEqual(
      matchCommittedInput(
        batch,
        String(current.native.id),
        "retained-input",
        "submission"
      ),
      {
        kind: "submission",
        nativeRequestId: "retained-input",
        submissionId: String(input.id),
        entryId: String(settled.entry),
      }
    );
    const source = {
      address: current.address,
      nativeSessionId: String(current.native.id),
      ownerPrincipalId: actor.actor.id,
    };
    const physical = await physicalInput(
      fixture.pi(),
      source,
      "retained-input",
      "retained-instance"
    );
    assert.deepEqual(
      parseInputCorrelation(JSON.stringify(physical), "retained-input"),
      {
        kind: "native",
        address: current.address,
        nativeSessionId: String(current.native.id),
        instanceId: "retained-instance",
        nativeRequestId: "retained-input",
        submissionId: String(input.id),
        entryId: String(settled.entry),
      }
    );
    assert.deepEqual(
      await physicalInput(fixture.pi(), source, undefined, "retained-instance"),
      {
        kind: "maintenance",
        address: current.address,
        nativeSessionId: String(current.native.id),
        instanceId: "retained-instance",
      }
    );
    const task = await current.native.compact(undefined, context);
    const completed = await fixture.pi().waitForTask(task, context);
    assert.equal(completed.state.outcome.status, "completed");
    const compaction = batches.find((writes) =>
      matchCommittedInput(
        writes,
        String(current.native.id),
        "compact-input",
        "compaction"
      )
    );
    assert.ok(compaction);
    assert.deepEqual(
      matchCommittedInput(
        compaction,
        String(current.native.id),
        "compact-input",
        "compaction"
      ),
      { kind: "compaction", taskId: String(task) }
    );
    assert.equal(
      matchCommittedInput(
        compaction,
        String(sibling.native.id),
        "compact-input",
        "compaction"
      ),
      undefined
    );
    assert.equal(
      matchCommittedInput(
        compaction,
        String(current.native.id),
        "compact-input",
        "submission"
      ),
      undefined
    );
  } finally {
    await fixture.close();
  }
});
