/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Each native observation and crash boundary depends on the preceding result. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { Schema } from "effect";

import {
  addressFor,
  control,
  decide,
  dependencyCheckpoint,
  evidence,
  lifecycle,
  nativeStorage,
  observe,
  pending,
  provider,
  rawRequest,
  read,
  request,
  runtimeEvidence,
  send,
  stop,
  waitFor,
} from "./helpers.ts";
import {
  runtimeJourney,
  answer,
  completed,
  writeCount,
  restart,
  waitForQuiet,
} from "./runtime-journey.ts";
import { storageConformanceCases } from "./storage-conformance.ts";

const journey = runtimeJourney("native-journey");
journey(
  "the PiHarness SQLite adapter passes upstream storage conformance",
  async (stack) => {
    const response = await fetch(
      `http://127.0.0.1:${stack.apiPort}/conformance/storage`,
      { method: "POST", signal: AbortSignal.timeout(60_000) }
    );
    assert.equal(response.status, 200, await response.clone().text());
    const result = Schema.decodeUnknownSync(
      Schema.Struct({ passed: Schema.Array(Schema.String) })
    )(await response.json());
    const expected = storageConformanceCases(() => {
      throw new Error("Conformance cases execute in the Durable Object");
    }).map((testCase) => testCase.name);
    assert.deepEqual(result.passed, expected);
    await evidence(stack, "storage-conformance", result);
  }
);

journey(
  "a lost native commit response resets the host and retains one accepted input",
  async (stack) => {
    const address = addressFor("company-journey", "commit-failure");
    const operationId = "commit-failure-input";
    const beforeFailure = await runtimeEvidence(stack, address);
    await request(stack, "/runtime/fixture/fail-commit", {
      address,
      operationId,
    });
    let interruptedStatus: number | undefined;
    try {
      const response = await fetch(
        `http://127.0.0.1:${stack.apiPort}/runtime/send`,
        {
          body: JSON.stringify({
            address,
            operationId,
            text: "Explain the committed recovery policy.",
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(30_000),
        }
      );
      interruptedStatus = response.status;
    } catch (error) {
      assert.ok(error instanceof TypeError);
    }
    assert.notEqual(interruptedStatus, 200);
    const retry = await waitFor(
      () =>
        send(
          stack,
          address,
          operationId,
          "Explain the committed recovery policy."
        ),
      (value) => value.operationId === operationId
    );
    assert.equal(retry.accepted, false);
    const final = await waitFor(() => read(stack, address), completed);
    const recovered = await runtimeEvidence(stack, address);
    assert.notEqual(recovered.instanceId, beforeFailure.instanceId);
    assert.equal(recovered.failures.length, 1);
    assert.equal(recovered.failures[0]?.instanceId, beforeFailure.instanceId);
    assert.equal(recovered.failures[0]?.operationId, operationId);
    assert.ok((recovered.failures[0]?.committedSeq ?? 0) > 0);
    assert.deepEqual(
      final.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["Explain the committed recovery policy."]
    );
    assert.equal(final.messages.at(-1)?.text, answer);
    assert.equal((await nativeStorage(stack, address)).submissions.length, 1);
    assert.equal(
      (await provider(stack)).model.filter(
        (call) =>
          call.operationId === operationId && call.completedAt !== undefined
      ).length,
      1
    );
    await send(
      stack,
      address,
      "after-commit-failure",
      "Explain normal operation."
    );
    const subsequent = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        completed(snapshot) &&
        snapshot.messages.filter((message) => message.role === "user")
          .length === 2
    );
    const quiet = await waitForQuiet(stack, address);
    await evidence(stack, "commit-failure-recovery", {
      beforeFailure,
      final,
      interruptedStatus,
      quiet,
      recovered,
      retry,
      subsequent,
    });
  }
);

journey(
  "completion and Stop drain wake jobs, notifications, and the platform alarm",
  async (stack) => {
    const address = addressFor("company-journey", "notify-lifecycle");
    await control(stack, { delayMs: 5000 });
    await send(
      stack,
      address,
      "notify-complete",
      "Explain notification delivery."
    );
    const active = await waitFor(
      () => lifecycle(stack, address),
      (value) => value.jobs.length > 0 && value.pending.length > 0
    );
    assert.notEqual(active.alarmAt, null);
    const busy = await waitFor(
      () => runtimeEvidence(stack, address),
      (value) => value.notifications.some((snapshot) => snapshot.busy)
    );
    assert.ok(busy.notifications.some((snapshot) => snapshot.busy));
    const delivered = await waitFor(
      () => runtimeEvidence(stack, address),
      (value) => value.notifications.some(completed)
    );
    assert.equal(delivered.notifications.at(-1)?.messages.at(-1)?.text, answer);
    const completedQuiet = await waitForQuiet(stack, address);
    const completedCount = (await runtimeEvidence(stack, address)).notifications
      .length;
    await delay(1500);
    assert.equal(
      (await runtimeEvidence(stack, address)).notifications.length,
      completedCount
    );
    await send(stack, address, "notify-stop", "Stop this notification run.");
    await waitFor(
      () => runtimeEvidence(stack, address),
      (value) => value.notifications.at(-1)?.busy === true
    );
    assert.deepEqual(await stop(stack, address), { stopped: true });
    const stopped = await waitFor(
      () => runtimeEvidence(stack, address),
      (value) => {
        const snapshot = value.notifications.at(-1);
        return (
          snapshot?.busy === false &&
          snapshot.messages.some(
            (message) => message.text === "Stop this notification run."
          )
        );
      }
    );
    const stoppedQuiet = await waitForQuiet(stack, address);
    const stoppedCount = stopped.notifications.length;
    await delay(1500);
    assert.equal(
      (await runtimeEvidence(stack, address)).notifications.length,
      stoppedCount
    );
    await evidence(stack, "lifecycle-drain", {
      active,
      completedQuiet,
      delivered,
      stopped,
      stoppedQuiet,
    });
  }
);

journey(
  "Send retries retain one native user message; reconnect presents current partial and final text",
  async (stack) => {
    const address = addressFor("company-journey", "stream");
    await control(stack, { delayMs: 300 });
    const attached = await observe(stack, address);
    const initial = await attached.next();
    assert.equal(initial.type, "snapshot");
    const first = await send(
      stack,
      address,
      "stream-input",
      "Explain the current policy."
    );
    const retry = await send(
      stack,
      address,
      "stream-input",
      "Explain the current policy."
    );
    assert.equal(first.accepted, true);
    assert.deepEqual(retry, { ...first, accepted: false });
    let partial;
    try {
      partial = await waitFor(
        () => attached.next(),
        (frame) =>
          frame.type === "snapshot" &&
          frame.snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.state === "streaming" &&
              message.text.length > 0
          )
      );
      assert.equal(partial.type, "snapshot");
    } finally {
      await attached.close();
    }
    const reconnected = await observe(stack, address);
    const fresh = await reconnected.next();
    try {
      assert.equal(fresh.type, "snapshot");
      if (fresh.type === "snapshot") {
        assert.equal(
          fresh.snapshot.messages.filter((message) => message.role === "user")
            .length,
          1
        );
        assert.equal(
          fresh.snapshot.messages[0]?.text,
          "Explain the current policy."
        );
        assert.ok(
          fresh.snapshot.messages.some(
            (message) => message.role === "assistant" && message.text.length > 0
          )
        );
      }
    } finally {
      await reconnected.close();
    }
    const final = await waitFor(() => read(stack, address), completed);
    assert.equal(
      final.messages.filter((message) => message.role === "user").length,
      1
    );
    assert.equal(final.messages.at(-1)?.text, answer);
    await evidence(stack, "send-reconnect", {
      final,
      first,
      fresh,
      partial,
      retry,
    });
  }
);

journey(
  "concurrent Send retries place one native input and make one physical model request",
  async (stack) => {
    const address = addressFor("company-journey", "concurrent-send");
    const receipts = await Promise.all([
      send(stack, address, "concurrent-input", "Explain concurrent admission."),
      send(stack, address, "concurrent-input", "Explain concurrent admission."),
    ]);
    assert.deepEqual(
      receipts.map((receipt) => receipt.operationId),
      ["concurrent-input", "concurrent-input"]
    );
    assert.equal(receipts[0]?.session, receipts[1]?.session);
    const final = await waitFor(() => read(stack, address), completed);
    assert.deepEqual(
      final.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["Explain concurrent admission."]
    );
    const storage = await nativeStorage(stack, address);
    assert.equal(storage.submissions.length, 1);
    const observed = await provider(stack);
    assert.equal(
      observed.model.filter((call) => call.operationId === "concurrent-input")
        .length,
      1
    );
    await evidence(stack, "concurrent-send", {
      final,
      observed,
      receipts,
      storage,
    });
  }
);

journey(
  "Stop interrupts a delayed native generation and the same session accepts another input",
  async (stack) => {
    const address = addressFor("company-journey", "stop");
    await control(stack, { delayMs: 5000 });
    await send(stack, address, "stopped-input", "Explain the current policy.");
    await waitFor(
      () => provider(stack),
      (value) =>
        value.model.some((call) => call.operationId === "stopped-input")
    );
    assert.deepEqual(await stop(stack, address), { stopped: true });
    const stopped = await waitFor(
      () => read(stack, address),
      (value) => !value.busy
    );
    assert.equal(
      stopped.messages.filter((message) => message.role === "user").length,
      1
    );
    await control(stack, { delayMs: 0 });
    await send(
      stack,
      address,
      "after-stop-input",
      "Explain the policy after Stop."
    );
    const final = await waitFor(() => read(stack, address), completed);
    assert.equal(
      final.messages.filter((message) => message.role === "user").length,
      2
    );
    assert.equal(final.messages.at(-1)?.text, answer);
    await evidence(stack, "stop", { final, stopped });
  }
);

journey(
  "content access revocation blocks reads and Allow while Stop and Deny remain available",
  async (stack) => {
    const stoppedAddress = addressFor("company-journey", "content-stop");
    await control(stack, { delayMs: 5000 });
    await send(
      stack,
      stoppedAddress,
      "content-stop-input",
      "Explain the private policy."
    );
    await waitFor(
      () => provider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.operationId === "content-stop-input" &&
            call.completedAt === undefined
        )
    );
    await request(stack, "/runtime/fixture/content-access", {
      address: stoppedAddress,
      enabled: false,
    });
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: stoppedAddress }))
        .status,
      403
    );
    assert.deepEqual(await stop(stack, stoppedAddress), { stopped: true });
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: stoppedAddress }))
        .status,
      403
    );
    await request(stack, "/runtime/fixture/content-access", {
      address: stoppedAddress,
      enabled: true,
    });
    const stopped = await waitFor(
      () => read(stack, stoppedAddress),
      (value) => !value.busy
    );
    assert.deepEqual(
      stopped.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["Explain the private policy."]
    );

    await control(stack, { delayMs: 0 });
    const deniedAddress = addressFor("company-journey", "content-deny");
    await send(
      stack,
      deniedAddress,
      "content-deny-input",
      "Apply fixture_effect once."
    );
    const approval = await pending(stack, deniedAddress);
    await request(stack, "/runtime/fixture/content-access", {
      address: deniedAddress,
      enabled: false,
    });
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: deniedAddress }))
        .status,
      403
    );
    assert.equal(
      (await rawRequest(stack, "/runtime/observe", { address: deniedAddress }))
        .status,
      403
    );
    assert.equal(
      (
        await rawRequest(stack, "/runtime/decide", {
          address: deniedAddress,
          approvalId: approval.approvalId,
          decision: "allow",
        })
      ).status,
      403
    );
    const denied = await rawRequest(stack, "/runtime/decide", {
      address: deniedAddress,
      approvalId: approval.approvalId,
      decision: "deny",
    });
    assert.equal(denied.status, 200);
    const deniedReceipt: unknown = await denied.json();
    assert.deepEqual(deniedReceipt, {
      status: "ok",
      value: { approvalId: approval.approvalId, state: "denied" },
    });
    assert.equal(await writeCount(stack, approval.operationId), 0);
    await request(stack, "/runtime/fixture/content-access", {
      address: deniedAddress,
      enabled: true,
    });
    const final = await waitFor(
      () => read(stack, deniedAddress),
      (value) => !value.busy
    );
    assert.equal(final.approvals[0]?.state, "denied");
    assert.equal(await writeCount(stack, approval.operationId), 0);
    await evidence(stack, "source-control", {
      deniedReceipt,
      final,
      provider: await provider(stack),
      stopped,
    });
  }
);

journey(
  "source revocation after durable Allow prevents dispatch at the final dependency check",
  async (stack) => {
    const address = addressFor("company-journey", "post-allow-source");
    await dependencyCheckpoint(stack, address, {
      armed: true,
      released: false,
    });
    await send(
      stack,
      address,
      "post-allow-input",
      "Apply fixture_effect once."
    );
    const approval = await pending(stack, address);
    const allowed = await decide(stack, address, approval);
    assert.deepEqual(allowed, {
      approvalId: approval.approvalId,
      state: "allowed",
    });
    const held = await waitFor(
      () => dependencyCheckpoint(stack, address),
      (value) => value.waiting
    );
    const beforeDispatch = await nativeStorage(stack, address);
    assert.equal(
      beforeDispatch.tasks.some((task) =>
        task.memos?.includes("cerebro-dispatch")
      ),
      false
    );
    assert.equal(await writeCount(stack, approval.operationId), 0);
    await request(stack, "/runtime/fixture/content-access", {
      address,
      enabled: false,
    });
    await dependencyCheckpoint(stack, address, { released: true });
    const settled = await waitFor(
      () => nativeStorage(stack, address),
      (value) =>
        value.tasks.length > 0 &&
        value.tasks.every((task) => task.status === "terminal")
    );
    assert.equal(await writeCount(stack, approval.operationId), 0);
    await request(stack, "/runtime/fixture/content-access", {
      address,
      enabled: true,
    });
    const final = await waitFor(
      () => read(stack, address),
      (value) => !value.busy
    );
    assert.equal(final.approvals[0]?.state, "allowed");
    assert.deepEqual(
      final.messages
        .filter((message) => message.role === "user")
        .map((message) => message.text),
      ["Apply fixture_effect once."]
    );
    await evidence(stack, "post-allow-source", {
      allowed,
      approval,
      beforeDispatch,
      final,
      held,
      provider: await provider(stack),
      settled,
    });
  }
);

journey(
  "SIGKILL recovery resumes native generation before a read or observer wakes the host",
  async (stack) => {
    const address = addressFor("company-journey", "generation-crash");
    await control(stack, { delayMs: 5000 });
    await send(stack, address, "recover-input", "Explain the recovery policy.");
    await waitFor(
      () => provider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.operationId === "recover-input" &&
            call.completedAt === undefined
        )
    );
    const killedAt = Date.now();
    restart(stack);
    await control(stack, { delayMs: 0 });
    const recovered = await waitFor(
      () => provider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.operationId === "recover-input" &&
            call.startedAt > killedAt &&
            call.completedAt !== undefined &&
            call.status === 200
        )
    );
    const final = await waitFor(() => read(stack, address), completed);
    assert.equal(
      final.messages.filter((message) => message.role === "user").length,
      1
    );
    assert.equal(final.messages.at(-1)?.text, answer);
    const storage = await nativeStorage(stack, address);
    assert.equal(storage.submissions.length, 1);
    assert.ok(storage.tasks.some((task) => task.status === "terminal"));
    assert.deepEqual(
      storage.tables.filter((name) =>
        /cerebro.*(?:transcript|run|execution|snapshot|projection|repair|outbox)/iu.test(
          name
        )
      ),
      []
    );
    const scheduled = await lifecycle(stack, address);
    assert.deepEqual(
      scheduled.jobs.filter((job) => /repair|projection/iu.test(job.fn)),
      []
    );
    await evidence(stack, "generation-recovery", {
      final,
      killedAt,
      recovered,
      scheduled,
      storage,
    });
  }
);
