/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Each native observation and crash boundary depends on the preceding result. */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import {
  addressFor,
  control,
  decide,
  evidence,
  nativeStorage,
  observe,
  pending,
  provider,
  rawRequest,
  read,
  request,
  send,
  waitFor,
} from "./helpers.ts";
import {
  runtimeJourney,
  completed,
  writeCount,
  authorityCalls,
  restart,
} from "./runtime-journey.ts";

const journey = runtimeJourney("approval-journey");
journey(
  "pending approval survives SIGKILL with its native task binding; repeated Allow makes one physical write",
  async (stack) => {
    const address = addressFor("company-journey", "approval-crash");
    await send(stack, address, "approval-input", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    assert.equal(await writeCount(stack, approval.operationId), 0);
    restart(stack);
    const recovered = await pending(stack, address);
    assert.deepEqual(recovered, approval);
    assert.equal(await writeCount(stack, approval.operationId), 0);
    const allowed = await decide(stack, address, recovered);
    assert.equal(allowed.state, "allowed");
    assert.deepEqual(await decide(stack, address, recovered), allowed);
    const final = await waitFor(() => read(stack, address), completed);
    assert.equal(await writeCount(stack, approval.operationId), 1);
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
  "a waiting approval makes no authority calls until Allow wakes it",
  async (stack) => {
    const address = addressFor("company-journey", "approval-wake");
    await send(stack, address, "wake-input", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    const callsBefore = await authorityCalls(stack, address);
    await delay(2000);
    assert.equal(await authorityCalls(stack, address), callsBefore);
    const decidedAt = Date.now();
    await decide(stack, address, approval);
    await waitFor(
      () => writeCount(stack, approval.operationId),
      (count) => count === 1,
      5000
    );
    assert.ok(Date.now() - decidedAt < 5000);
    await evidence(stack, "approval-wake", {
      approval,
      authorityCallsWhileWaiting: 0,
    });
  }
);

journey(
  "a transient authority failure keeps the approval pending",
  async (stack) => {
    const address = addressFor("company-journey", "approval-transient");
    await send(stack, address, "transient-input", "Apply fixture_effect once.");
    const approval = await pending(stack, address);
    await authorityCalls(stack, address, true);
    const outsider = await rawRequest(
      stack,
      "/runtime/read",
      { address },
      "user:company-other"
    );
    assert.equal(outsider.status, 403);
    const untouched = await request(stack, "/runtime/fixture/authority", {
      address,
    });
    assert.ok(
      untouched &&
        typeof untouched === "object" &&
        "failNextToolCheck" in untouched &&
        untouched.failNextToolCheck === true
    );
    await request(stack, "/runtime/fixture/content-access", {
      address,
      enabled: false,
    });
    const rechecked = await waitFor(
      async () => {
        const denied = await rawRequest(stack, "/runtime/read", { address });
        assert.equal(denied.status, 403);
        return await request(stack, "/runtime/fixture/authority", { address });
      },
      (value) =>
        Boolean(
          value &&
          typeof value === "object" &&
          "failNextToolCheck" in value &&
          value.failNextToolCheck === false
        )
    );
    await request(stack, "/runtime/fixture/content-access", {
      address,
      enabled: true,
    });
    assert.equal(
      (await pending(stack, address)).approvalId,
      approval.approvalId
    );
    assert.equal(await writeCount(stack, approval.operationId), 0);
    await decide(stack, address, approval);
    await waitFor(
      () => writeCount(stack, approval.operationId),
      (count) => count === 1
    );
    await evidence(stack, "transient-authority-revalidation", {
      approval,
      outsiderStatus: outsider.status,
      untouched,
      rechecked,
      trigger:
        "Owner read denied by revoked conversation content; foreign identity rejected before scope selection.",
    });
  }
);

journey(
  "Deny, wrong owner, and current access revocation prevent tool dispatch",
  async (stack) => {
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
    assert.equal(await writeCount(stack, denied.operationId), 0);
    assert.equal(finalDenied.approvals[0]?.state, "denied");
    assert.ok(
      finalDenied.tools.some(
        (tool) =>
          tool.state === "failed" &&
          tool.output.includes(
            "The tool approval was denied, cancelled, or expired."
          )
      )
    );

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
    assert.equal(await writeCount(stack, approval.operationId), 0);
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
  "access revoked while a write runs reports an unknown outcome after one dispatch",
  async (stack) => {
    const address = addressFor("company-journey", "revoked-during-write");
    await control(stack, { arm: { boundary: "after-tool-dispatch" } });
    await send(
      stack,
      address,
      "revoked-during-input",
      "Apply fixture_effect once."
    );
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
    await request(stack, "/runtime/fixture/access", {
      address,
      enabled: false,
    });
    await control(stack, { arm: null, release: true });
    // Reads are denied while access is off; the check after dispatch runs within milliseconds.
    await delay(1000);
    await request(stack, "/runtime/fixture/access", { address, enabled: true });
    const final = await waitFor(
      () => read(stack, address),
      (value) => !value.busy
    );
    assert.equal(await writeCount(stack, approval.operationId), 1);
    assert.ok(
      final.messages.some(
        (message) =>
          message.role === "tool" && /outcome is unknown/u.test(message.text)
      )
    );
  }
);

journey(
  "a process crash after physical write retains the Pi dispatch memo and reports an unknown result",
  async (stack) => {
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
    assert.equal(await writeCount(stack, approval.operationId), 1);
    const dispatched = await nativeStorage(stack, address);
    assert.ok(
      dispatched.tasks.some((task) => task.memos?.includes("cerebro-dispatch"))
    );
    restart(stack);
    await control(stack, { arm: null, release: true });
    const final = await waitFor(() => read(stack, address), completed);
    assert.equal(await writeCount(stack, approval.operationId), 1);
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
  async (stack) => {
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
    assert.equal(await writeCount(stack, first.operationId), 1);
    assert.equal(await writeCount(stack, second.operationId), 1);
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
