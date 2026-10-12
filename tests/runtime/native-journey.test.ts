/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Each native observation and crash boundary depends on the preceding result. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";
import {
  addressFor,
  boot,
  compose,
  control,
  decide,
  dependencyCheckpoint,
  evidence,
  lifecycle,
  nativeStorage,
  newStack,
  observe,
  pending,
  provider,
  rawRequest,
  read,
  request,
  send,
  stop,
  waitFor,
} from "./helpers.ts";
import type { Stack } from "./helpers.ts";

let stack: Stack;
let failed = false;
const answer = "Cerebro slice 1 completed.";
const completed = (snapshot: ChatSnapshot): boolean =>
  !snapshot.busy &&
  snapshot.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.state === "complete" &&
      message.text === answer
  );
const writeCount = async (operationId: string): Promise<number> =>
  (await provider(stack)).tools.filter(
    (tool) => tool.operationId === operationId && tool.write
  ).length;
const restart = (): void => {
  compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
  compose(stack, ["up", "-d", "--wait", "celld"]);
};
before(
  async () => {
    stack = await newStack("journey");
    boot(stack);
  },
  { timeout: 600_000 }
);
after(
  async () => {
    if (failed) {
      await evidence(stack, "failure", {
        logs: compose(stack, [
          "logs",
          "--no-color",
          "--tail=150",
          "celld",
          "bootstrap",
        ]),
        provider: await provider(stack),
      });
    }
    compose(stack, ["down", "-v"]);
  },
  { timeout: 120_000 }
);
const journey = (name: string, run: () => Promise<void>) =>
  test(name, { timeout: 180_000 }, async () => {
    try {
      await control(stack, {
        arm: null,
        delayMs: 0,
        failFirst: false,
        release: true,
      });
      await run();
    } catch (error) {
      failed = true;
      throw error;
    }
  });

journey(
  "Send retries retain one native user message; reconnect presents current partial and final text",
  async () => {
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
  async () => {
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
  async () => {
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
  async () => {
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
    assert.equal(await writeCount(approval.operationId), 0);
    await request(stack, "/runtime/fixture/content-access", {
      address: deniedAddress,
      enabled: true,
    });
    const final = await waitFor(
      () => read(stack, deniedAddress),
      (value) => !value.busy
    );
    assert.equal(final.approvals[0]?.state, "denied");
    assert.equal(await writeCount(approval.operationId), 0);
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
  async () => {
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
    assert.equal(await writeCount(approval.operationId), 0);
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
    assert.equal(await writeCount(approval.operationId), 0);
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
  async () => {
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
    restart();
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

journey(
  "pending approval survives SIGKILL with its native task binding; repeated Allow makes one physical write",
  async () => {
    const address = addressFor("company-journey", "approval-crash");
    await send(stack, address, "approval-input", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    assert.equal(await writeCount(approval.operationId), 0);
    restart();
    const recovered = await pending(stack, address);
    assert.deepEqual(recovered, approval);
    assert.equal(await writeCount(approval.operationId), 0);
    const allowed = await decide(stack, address, recovered);
    assert.equal(allowed.state, "allowed");
    assert.deepEqual(await decide(stack, address, recovered), allowed);
    const final = await waitFor(() => read(stack, address), completed);
    assert.equal(await writeCount(approval.operationId), 1);
    assert.equal(
      final.approvals.find((item) => item.approvalId === approval.approvalId)
        ?.state,
      "allowed"
    );
    const changed = await rawRequest(stack, "/runtime/decide", {
      address,
      approvalId: approval.approvalId,
      decision: "deny",
    });
    assert.equal(changed.status, 409);
    await evidence(stack, "approval-recovery", {
      allowed,
      approval,
      final,
      provider: await provider(stack),
      recovered,
    });
  }
);

journey(
  "Deny, wrong owner, and current access revocation prevent tool dispatch",
  async () => {
    const deniedAddress = addressFor("company-journey", "deny");
    await send(
      stack,
      deniedAddress,
      "denied-input",
      "Apply fixture_effect once."
    );
    const denied = await pending(stack, deniedAddress);
    assert.equal(
      (await decide(stack, deniedAddress, denied, "deny")).state,
      "denied"
    );
    const finalDenied = await waitFor(
      () => read(stack, deniedAddress),
      completed
    );
    assert.equal(await writeCount(denied.operationId), 0);
    assert.equal(finalDenied.approvals[0]?.state, "denied");

    const address = addressFor("company-journey", "revoked-approval");
    await send(stack, address, "revoked-input", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    const outsider = await rawRequest(
      stack,
      "/runtime/decide",
      { address, approvalId: approval.approvalId, decision: "allow" },
      "user:company-other"
    );
    assert.equal(outsider.status, 403);
    const attached = await observe(stack, address);
    assert.equal((await attached.next()).type, "snapshot");
    await request(stack, "/runtime/fixture/access", {
      address,
      enabled: false,
    });
    const denial = await waitFor(
      () => attached.next(),
      (frame) => frame.type === "access-denied"
    );
    assert.deepEqual(denial, { reason: "unauthorized", type: "access-denied" });
    await attached.close();
    assert.equal(
      (
        await rawRequest(stack, "/runtime/decide", {
          address,
          approvalId: approval.approvalId,
          decision: "allow",
        })
      ).status,
      403
    );
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address })).status,
      403
    );
    assert.equal(await writeCount(approval.operationId), 0);
    await request(stack, "/runtime/fixture/access", { address, enabled: true });
    const reopened = await waitFor(
      () => read(stack, address),
      (value) => !value.busy
    );
    assert.equal(reopened.messages[0]?.text, "Apply fixture_effect once.");
    await evidence(stack, "denial", {
      denial,
      finalDenied,
      provider: await provider(stack),
      reopened,
    });
  }
);

journey(
  "a process crash after physical write retains the Pi dispatch memo and reports an unknown result",
  async () => {
    const address = addressFor("company-journey", "dispatch-crash");
    await control(stack, { arm: { boundary: "after-tool-dispatch" } });
    await send(stack, address, "dispatch-input", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    await decide(stack, address, approval);
    await waitFor(
      () => provider(stack),
      (value) =>
        value.held === 1 &&
        value.tools.some(
          (tool) => tool.operationId === approval.operationId && tool.write
        )
    );
    assert.equal(await writeCount(approval.operationId), 1);
    const dispatched = await nativeStorage(stack, address);
    assert.ok(
      dispatched.tasks.some((task) => task.memos?.includes("cerebro-dispatch"))
    );
    restart();
    await control(stack, { arm: null, release: true });
    const final = await waitFor(() => read(stack, address), completed);
    assert.equal(await writeCount(approval.operationId), 1);
    assert.ok(
      final.messages.some(
        (message) =>
          message.role === "tool" && /outcome is unknown/u.test(message.text)
      )
    );
    const storage = await nativeStorage(stack, address);
    await evidence(stack, "dispatch-recovery", {
      approval,
      dispatched,
      final,
      provider: await provider(stack),
      storage,
    });
  }
);

journey(
  "two intentional native tool calls with equal arguments retain distinct occurrence identities",
  async () => {
    const address = addressFor("company-journey", "occurrence");
    await send(
      stack,
      address,
      "first-occurrence",
      "Apply fixture_effect once."
    );
    const first = await pending(stack, address);
    await decide(stack, address, first);
    await waitFor(() => read(stack, address), completed);
    await send(
      stack,
      address,
      "second-occurrence",
      "Apply fixture_effect once."
    );
    const second = await pending(stack, address);
    assert.notEqual(second.operationId, first.operationId);
    assert.notEqual(second.taskId, first.taskId);
    assert.deepEqual(second.arguments, first.arguments);
    await decide(stack, address, second);
    const final = await waitFor(
      () => read(stack, address),
      (value) =>
        !value.busy &&
        value.messages.filter((message) => message.role === "tool").length === 2
    );
    assert.equal(await writeCount(first.operationId), 1);
    assert.equal(await writeCount(second.operationId), 1);
    assert.equal(
      (
        await send(
          stack,
          address,
          "first-occurrence",
          "Apply fixture_effect once."
        )
      ).accepted,
      false
    );
    assert.equal(
      final.messages.filter((message) => message.role === "user").length,
      2
    );
    await evidence(stack, "equal-occurrences", {
      final,
      first,
      provider: await provider(stack),
      second,
    });
  }
);
