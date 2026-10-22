/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Each native observation and crash boundary depends on the preceding result. */
import assert from "node:assert/strict";

import {
  addressFor,
  control,
  decide,
  evidence,
  lifecycle,
  nativeStorage,
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
  completed,
  writeCount,
  restart,
  waitForQuiet,
  userTexts,
} from "./runtime-journey.ts";

const journey = runtimeJourney("identity-journey");
journey(
  "one identity hosts different agents while organizations and owners remain separate",
  async (stack) => {
    const left = addressFor("identity-placement", "chat", "agent-a");
    const right = addressFor("identity-placement", "chat", "agent-b-v2");
    const otherOrganization = addressFor(
      "identity-placement-other",
      "chat",
      "agent-a"
    );
    const [a, b, organization, owner] = await Promise.all([
      runtimeEvidence(stack, left),
      runtimeEvidence(stack, right),
      runtimeEvidence(stack, otherOrganization),
      runtimeEvidence(stack, left, "service:identity-placement"),
    ]);
    assert.equal(a.instanceId, b.instanceId);
    assert.notEqual(a.nativeSessionId, b.nativeSessionId);
    assert.notEqual(a.instanceId, organization.instanceId);
    assert.notEqual(a.instanceId, owner.instanceId);
    const wrongCaller = await rawRequest(
      stack,
      "/runtime/read",
      { address: left, ownerPrincipalId: "service:identity-placement" },
      "user:identity-placement"
    );
    assert.equal(wrongCaller.status, 403);
    const leftSnapshot = await read(stack, left);
    const rightSnapshot = await read(stack, right);
    assert.equal(leftSnapshot.agentVersion, 1);
    assert.equal(rightSnapshot.agentVersion, 2);
    await evidence(stack, "identity-placement", {
      a,
      b,
      organization,
      owner,
      leftSnapshot,
      rightSnapshot,
    });
  }
);

journey(
  "concurrent agents isolate identical request IDs, provider names, tool names, pins, and approvals",
  async (stack) => {
    const left = addressFor("identity-concurrent", "chat", "agent-a");
    const right = addressFor("identity-concurrent", "chat", "agent-b-v2");
    const operationId = "same-identity-retry-id";
    const textA = "Apply fixture_effect once. Private marker ALPHA.";
    const textB = "Apply fixture_effect once. Private marker BETA.";
    const receipts = await Promise.all([
      send(stack, left, operationId, textA),
      send(stack, right, operationId, textB),
    ]);
    assert.ok(receipts.every((receipt) => receipt.accepted));
    const [approvalA, approvalB] = await Promise.all([
      pending(stack, left),
      pending(stack, right),
    ]);
    assert.notEqual(approvalA.operationId, approvalB.operationId);
    assert.notEqual(approvalA.approvalId, approvalB.approvalId);
    const foreign = await rawRequest(stack, "/runtime/decide", {
      address: right,
      approvalId: approvalA.approvalId,
      decision: "allow",
    });
    assert.notEqual(foreign.status, 200);
    assert.equal(await writeCount(stack, approvalA.operationId), 0);
    assert.equal(await writeCount(stack, approvalB.operationId), 0);
    await Promise.all([
      decide(stack, left, approvalA),
      decide(stack, right, approvalB),
    ]);
    const [a, b] = await Promise.all([
      waitFor(() => read(stack, left), completed),
      waitFor(() => read(stack, right), completed),
    ]);
    assert.deepEqual(userTexts(a), [textA]);
    assert.deepEqual(userTexts(b), [textB]);
    assert.equal(a.agentVersion, 1);
    assert.equal(b.agentVersion, 2);
    const retries = await Promise.all([
      send(stack, left, operationId, textA),
      send(stack, right, operationId, textB),
    ]);
    assert.ok(retries.every((receipt) => !receipt.accepted));
    assert.equal(await writeCount(stack, approvalA.operationId), 1);
    assert.equal(await writeCount(stack, approvalB.operationId), 1);
    const [nativeA, nativeB, evidenceA, evidenceB] = await Promise.all([
      nativeStorage(stack, left),
      nativeStorage(stack, right),
      runtimeEvidence(stack, left),
      runtimeEvidence(stack, right),
    ]);
    assert.equal(nativeA.submissions.length, 1);
    assert.equal(nativeB.submissions.length, 1);
    assert.notEqual(
      nativeA.submissions[0]?.conversation_id,
      nativeB.submissions[0]?.conversation_id
    );
    for (const [scope, own, other, agent] of [
      [evidenceA, "ALPHA", "BETA", "agent-a"],
      [evidenceB, "BETA", "ALPHA", "agent-b-v2"],
    ] as const) {
      assert.ok(scope.modelRequests.length >= 2);
      for (const call of scope.modelRequests) {
        assert.equal(call.operationId, operationId);
        assert.equal(call.body.model, "slice-1");
        const messages = JSON.stringify(call.body.messages);
        assert.ok(messages.includes(own));
        assert.ok(!messages.includes(other));
        assert.ok(messages.includes(`Agent scope ${agent}.`));
        const tool = call.body.tools?.find(
          (item) => item.function.name === "fixture_effect"
        );
        assert.ok(tool?.function.description.includes(agent));
      }
    }
    await evidence(stack, "identity-concurrent-scopes", {
      a,
      b,
      approvalA,
      approvalB,
      evidenceA,
      evidenceB,
      retries,
      nativeA,
      nativeB,
    });
  }
);

journey(
  "one conversation's tool set and provider limits do not change a sibling's configuration",
  async (stack) => {
    const restricted = addressFor(
      "identity-limits",
      "restricted",
      "agent-no-tools-small-input"
    );
    const healthy = addressFor("identity-limits", "healthy", "agent-healthy");
    await Promise.all([
      send(
        stack,
        restricted,
        "restricted-input",
        `Apply fixture_effect once. ${"bounded ".repeat(150)}`
      ),
      send(stack, healthy, "healthy-input", "Apply fixture_effect once."),
    ]);
    const healthyApproval = await pending(stack, healthy);
    const denied = await waitFor(
      () => read(stack, restricted),
      (snapshot) => !snapshot.busy
    );
    assert.equal(denied.approvals.length, 0);
    assert.ok(!completed(denied));
    assert.equal(
      (await runtimeEvidence(stack, restricted)).modelRequests.length,
      0
    );
    await decide(stack, healthy, healthyApproval);
    await waitFor(() => read(stack, healthy), completed);
    assert.equal(await writeCount(stack, healthyApproval.operationId), 1);
    const noTools = addressFor("identity-limits", "no-tools", "agent-no-tools");
    await send(stack, noTools, "no-tools-input", "Apply fixture_effect once.");
    const noToolsFinal = await waitFor(() => read(stack, noTools), completed);
    assert.equal(noToolsFinal.approvals.length, 0);
    const noToolsRequests = await runtimeEvidence(stack, noTools);
    assert.ok(noToolsRequests.modelRequests.length > 0);
    assert.ok(
      noToolsRequests.modelRequests.every(
        (call) =>
          !call.body.tools?.some(
            (tool) => tool.function.name === "fixture_effect"
          )
      )
    );
    await control(stack, { delayMs: 500 });
    const short = addressFor(
      "identity-limits",
      "deadline",
      "agent-short-deadline"
    );
    await Promise.all([
      send(stack, short, "short-deadline-input", "Explain the short deadline."),
      send(
        stack,
        healthy,
        "normal-deadline-input",
        "Explain the normal deadline."
      ),
    ]);
    const shortFinal = await waitFor(
      () => read(stack, short),
      (snapshot) => !snapshot.busy
    );
    assert.ok(!completed(shortFinal));
    const healthyFinal = await waitFor(
      () => read(stack, healthy),
      (snapshot) => completed(snapshot) && userTexts(snapshot).length === 2
    );
    await evidence(stack, "identity-provider-limits", {
      denied,
      noToolsFinal,
      noToolsRequests,
      shortFinal,
      healthyFinal,
    });
  }
);

journey(
  "Deny and content or agent revocation in one conversation leave a sibling's approval valid",
  async (stack) => {
    const left = addressFor("identity-revocation", "left", "agent-left");
    const right = addressFor("identity-revocation", "right", "agent-right");
    await Promise.all([
      send(stack, left, "deny-left", "Apply fixture_effect once."),
      send(stack, right, "allow-right", "Apply fixture_effect once."),
    ]);
    const [approvalA, approvalB] = await Promise.all([
      pending(stack, left),
      pending(stack, right),
    ]);
    await decide(stack, left, approvalA, "deny");
    await request(stack, "/runtime/fixture/content-access", {
      address: left,
      enabled: false,
    });
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: left })).status,
      403
    );
    const sibling = await read(stack, right);
    assert.ok(
      sibling.approvals.some(
        (approval) =>
          approval.approvalId === approvalB.approvalId &&
          approval.state === "pending"
      )
    );
    await request(stack, "/runtime/fixture/access", {
      address: left,
      enabled: false,
    });
    await decide(stack, right, approvalB);
    const final = await waitFor(() => read(stack, right), completed);
    assert.equal(await writeCount(stack, approvalA.operationId), 0);
    assert.equal(await writeCount(stack, approvalB.operationId), 1);
    await request(stack, "/runtime/fixture/access", {
      address: left,
      enabled: true,
    });
    await request(stack, "/runtime/fixture/content-access", {
      address: left,
      enabled: true,
    });
    const denied = await waitFor(
      () => read(stack, left),
      (snapshot) => !snapshot.busy
    );
    assert.ok(denied.approvals.some((approval) => approval.state === "denied"));
    await evidence(stack, "identity-revocation-isolation", {
      final,
      denied,
      approvalA,
      approvalB,
    });
  }
);

journey(
  "Stop affects one native conversation and retains a sibling's shared wake alarm and notification work",
  async (stack) => {
    const left = addressFor("identity-stop", "notify-left", "agent-left");
    const right = addressFor("identity-stop", "notify-right", "agent-right");
    await control(stack, { delayMs: 5000 });
    await Promise.all([
      send(stack, left, "stop-only-left", "Explain the left policy."),
      send(stack, right, "keep-right-running", "Explain the right policy."),
    ]);
    await waitFor(
      () => provider(stack),
      (value) =>
        ["stop-only-left", "keep-right-running"].every((operationId) =>
          value.model.some((call) => call.operationId === operationId)
        )
    );
    const stopped = await stop(stack, left);
    assert.equal(stopped.stopped, true);
    await waitFor(
      () => read(stack, left),
      (snapshot) => !snapshot.busy
    );
    const sibling = await read(stack, right);
    assert.equal(sibling.busy, true);
    const active = await lifecycle(stack, right);
    assert.notEqual(active.alarmAt, null);
    assert.ok(
      active.pending.some(
        (operation) => operation.operationId === "keep-right-running"
      )
    );
    assert.ok(active.jobs.length > 0);
    await control(stack, { delayMs: 0 });
    const final = await waitFor(() => read(stack, right), completed);
    const [notificationsA, notificationsB] = await Promise.all([
      waitFor(
        () => runtimeEvidence(stack, left),
        (value) => value.notifications.length > 0
      ),
      waitFor(
        () => runtimeEvidence(stack, right),
        (value) => value.notifications.some(completed)
      ),
    ]);
    assert.ok(notificationsA.notifications.length > 0);
    assert.ok(notificationsB.notifications.some(completed));
    assert.ok(
      notificationsA.notifications.every(
        (snapshot) => snapshot.address.sessionId === left.sessionId
      )
    );
    assert.ok(
      notificationsB.notifications.every(
        (snapshot) => snapshot.address.sessionId === right.sessionId
      )
    );
    await waitForQuiet(stack, right);
    await evidence(stack, "identity-stop-and-shared-alarm", {
      sibling,
      active,
      final,
      notificationsA,
      notificationsB,
    });
  }
);

journey(
  "an identity recovers two interrupted conversations after SIGKILL before a reader wakes either one",
  async (stack) => {
    const left = addressFor("identity-crash", "left", "agent-left");
    const right = addressFor("identity-crash", "right", "agent-right");
    await control(stack, { delayMs: 5000 });
    const beforeCrash = await runtimeEvidence(stack, left);
    await Promise.all([
      send(stack, left, "identity-crash-left", "Recover the left policy."),
      send(stack, right, "identity-crash-right", "Recover the right policy."),
    ]);
    await waitFor(
      () => provider(stack),
      (value) =>
        ["identity-crash-left", "identity-crash-right"].every((operationId) =>
          value.model.some((call) => call.operationId === operationId)
        )
    );
    restart(stack);
    await control(stack, { delayMs: 0 });
    const automaticRecovery = await waitFor(
      () => provider(stack),
      (value) =>
        ["identity-crash-left", "identity-crash-right"].every((operationId) =>
          value.model.some(
            (call) =>
              call.operationId === operationId && call.completedAt !== undefined
          )
        )
    );
    const [a, b, reopenedA, reopenedB] = await Promise.all([
      waitFor(() => read(stack, left), completed),
      waitFor(() => read(stack, right), completed),
      runtimeEvidence(stack, left),
      runtimeEvidence(stack, right),
    ]);
    assert.notEqual(beforeCrash.instanceId, reopenedA.instanceId);
    assert.equal(reopenedA.instanceId, reopenedB.instanceId);
    assert.deepEqual(userTexts(a), ["Recover the left policy."]);
    assert.deepEqual(userTexts(b), ["Recover the right policy."]);
    assert.equal((await nativeStorage(stack, left)).submissions.length, 1);
    assert.equal((await nativeStorage(stack, right)).submissions.length, 1);
    await evidence(stack, "identity-two-conversation-crash", {
      beforeCrash,
      automaticRecovery,
      a,
      b,
      reopenedA,
      reopenedB,
    });
  }
);

journey(
  "an uncertain external write is not repeated when its identity also recovers a sibling conversation",
  async (stack) => {
    const left = addressFor("identity-write-crash", "write", "agent-write");
    const right = addressFor(
      "identity-write-crash",
      "sibling",
      "agent-sibling"
    );
    await control(stack, { arm: { boundary: "after-tool-dispatch" } });
    await send(
      stack,
      left,
      "identity-uncertain-write",
      "Apply fixture_effect once."
    );
    const approval = await pending(stack, left);
    await decide(stack, left, approval);
    await waitFor(
      () => provider(stack),
      (value) =>
        value.held > 0 &&
        value.tools.some(
          (tool) => tool.operationId === approval.operationId && tool.write
        )
    );
    await control(stack, { delayMs: 5000 });
    await send(
      stack,
      right,
      "identity-write-sibling",
      "Recover a separate sibling input."
    );
    await waitFor(
      () => provider(stack),
      (value) =>
        value.model.some(
          (call) => call.operationId === "identity-write-sibling"
        )
    );
    restart(stack);
    await control(stack, { arm: null, delayMs: 0, release: true });
    const recoveredBeforeRead = await waitFor(
      () => provider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.operationId === "identity-write-sibling" &&
            call.completedAt !== undefined
        )
    );
    const [uncertain, sibling] = await Promise.all([
      waitFor(
        () => read(stack, left),
        (snapshot) =>
          !snapshot.busy &&
          snapshot.messages.some(
            (message) =>
              message.role === "tool" &&
              /outcome is unknown/u.test(message.text)
          )
      ),
      waitFor(() => read(stack, right), completed),
    ]);
    assert.equal(await writeCount(stack, approval.operationId), 1);
    assert.deepEqual(userTexts(uncertain), ["Apply fixture_effect once."]);
    assert.deepEqual(userTexts(sibling), ["Recover a separate sibling input."]);
    assert.equal(
      (
        await send(
          stack,
          left,
          "identity-uncertain-write",
          "Apply fixture_effect once."
        )
      ).accepted,
      false
    );
    assert.equal(await writeCount(stack, approval.operationId), 1);
    await evidence(stack, "identity-uncertain-write-with-sibling", {
      approval,
      recoveredBeforeRead,
      uncertain,
      sibling,
    });
  }
);

journey(
  "a lost native commit response resets one identity and recovers both original conversation inputs",
  async (stack) => {
    const left = addressFor("identity-commit-loss", "left", "agent-left");
    const right = addressFor("identity-commit-loss", "right", "agent-right");
    const beforeFailure = await runtimeEvidence(stack, left);
    await control(stack, { delayMs: 5000 });
    await send(
      stack,
      right,
      "identity-commit-sibling",
      "Keep the sibling input after reset."
    );
    await waitFor(
      () => provider(stack),
      (value) =>
        value.model.some(
          (call) => call.operationId === "identity-commit-sibling"
        )
    );
    await request(stack, "/runtime/fixture/fail-commit", {
      address: left,
      operationId: "identity-commit-failure",
    });
    let interruptedStatus: number | undefined;
    try {
      const response = await fetch(
        `http://127.0.0.1:${stack.apiPort}/runtime/send`,
        {
          body: JSON.stringify({
            address: left,
            operationId: "identity-commit-failure",
            text: "Keep the committed input after reset.",
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
    await control(stack, { delayMs: 0 });
    const recoveredBeforeRead = await waitFor(
      () => provider(stack),
      (value) =>
        ["identity-commit-sibling", "identity-commit-failure"].every(
          (operationId) =>
            value.model.some(
              (call) =>
                call.operationId === operationId &&
                call.completedAt !== undefined
            )
        )
    );
    const [a, b, hostA, hostB] = await Promise.all([
      waitFor(() => read(stack, left), completed),
      waitFor(() => read(stack, right), completed),
      runtimeEvidence(stack, left),
      runtimeEvidence(stack, right),
    ]);
    assert.notEqual(hostA.instanceId, beforeFailure.instanceId);
    assert.equal(hostA.instanceId, hostB.instanceId);
    assert.equal(hostA.failures.length, 1);
    assert.equal(hostA.failures[0]?.instanceId, beforeFailure.instanceId);
    assert.equal(hostB.failures.length, 0);
    assert.deepEqual(userTexts(a), ["Keep the committed input after reset."]);
    assert.deepEqual(userTexts(b), ["Keep the sibling input after reset."]);
    assert.equal(
      (
        await send(
          stack,
          left,
          "identity-commit-failure",
          "Keep the committed input after reset."
        )
      ).accepted,
      false
    );
    assert.equal(
      (
        await send(
          stack,
          right,
          "identity-commit-sibling",
          "Keep the sibling input after reset."
        )
      ).accepted,
      false
    );
    assert.equal((await nativeStorage(stack, left)).submissions.length, 1);
    assert.equal((await nativeStorage(stack, right)).submissions.length, 1);
    await evidence(stack, "identity-shared-commit-failure", {
      beforeFailure,
      interruptedStatus,
      recoveredBeforeRead,
      a,
      b,
      hostA,
      hostB,
    });
  }
);
