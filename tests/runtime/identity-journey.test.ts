/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Each native observation and crash boundary depends on the preceding result. */
import assert from "node:assert/strict";

import {
  addressFor,
  assertPiFailure,
  compose,
  control,
  evidence,
  lifecycle,
  inputCalls,
  inputCorrelation,
  nativeStorage,
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
  "concurrent agents isolate identical request IDs, provider names, and pins",
  async (stack) => {
    const left = addressFor("identity-concurrent", "chat", "agent-a");
    const right = addressFor("identity-concurrent", "chat", "agent-b-v2");
    const operationId = "same-identity-retry-id";
    const textA = "Explain the policy. Private marker ALPHA.";
    const textB = "Explain the policy. Private marker BETA.";
    const receipts = await Promise.all([
      send(stack, left, operationId, textA),
      send(stack, right, operationId, textB),
    ]);
    assert.ok(receipts.every((receipt) => receipt.accepted));
    assert.deepEqual(
      receipts.map((receipt) => receipt.operationId),
      [operationId, operationId]
    );
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
    const [nativeA, nativeB, evidenceA, evidenceB, relationA, relationB] =
      await Promise.all([
        nativeStorage(stack, left),
        nativeStorage(stack, right),
        runtimeEvidence(stack, left),
        runtimeEvidence(stack, right),
        inputCorrelation(stack, left, operationId, textA),
        inputCorrelation(stack, right, operationId, textB),
      ]);
    assert.notEqual(relationA.nativeRequestId, relationB.nativeRequestId);
    assert.equal(nativeA.submissions[0]?.request_id, relationA.nativeRequestId);
    assert.equal(nativeB.submissions[0]?.request_id, relationB.nativeRequestId);
    assert.equal(nativeA.submissions.length, 1);
    assert.equal(nativeB.submissions.length, 1);
    assert.notEqual(
      nativeA.submissions[0]?.conversation_id,
      nativeB.submissions[0]?.conversation_id
    );
    for (const [scope, relation, own, other, agent] of [
      [evidenceA, relationA, "ALPHA", "BETA", "agent-a"],
      [evidenceB, relationB, "BETA", "ALPHA", "agent-b-v2"],
    ] as const) {
      assert.equal(scope.modelRequests.length, 1);
      const [call] = scope.modelRequests;
      assert.equal(call?.operationId, relation.nativeRequestId);
      assert.equal(call?.body.model, "slice-1");
      const messages = JSON.stringify(call?.body.messages);
      assert.ok(messages.includes(own));
      assert.ok(!messages.includes(other));
      assert.ok(messages.includes(`Agent scope ${agent}.`));
    }
    await evidence(stack, "identity-concurrent-scopes", {
      a,
      b,
      evidenceA,
      evidenceB,
      retries,
      nativeA,
      nativeB,
      relationA,
      relationB,
    });
  }
);

journey(
  "one conversation's provider limits do not change a sibling's configuration",
  async (stack) => {
    const restricted = addressFor(
      "identity-limits",
      "restricted",
      "agent-small-input"
    );
    const healthy = addressFor("identity-limits", "healthy", "agent-healthy");
    await Promise.all([
      send(
        stack,
        restricted,
        "restricted-input",
        `Explain the bounded policy. ${"bounded ".repeat(150)}`
      ),
      send(stack, healthy, "healthy-input", "Explain the healthy policy."),
    ]);
    const denied = await waitFor(
      () => read(stack, restricted),
      (snapshot) => !snapshot.busy
    );
    assert.ok(!completed(denied));
    assert.equal(
      (await runtimeEvidence(stack, restricted)).modelRequests.length,
      0
    );
    const healthyFirst = await waitFor(() => read(stack, healthy), completed);
    assert.deepEqual(userTexts(healthyFirst), ["Explain the healthy policy."]);
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
      shortFinal,
      healthyFirst,
      healthyFinal,
    });
  }
);

journey(
  "content or agent revocation in one conversation leaves a sibling readable and accepting input",
  async (stack) => {
    const left = addressFor("identity-revocation", "left", "agent-left");
    const right = addressFor("identity-revocation", "right", "agent-right");
    await Promise.all([
      send(stack, left, "revoke-left", "Explain the left policy."),
      send(stack, right, "keep-right", "Explain the right policy."),
    ]);
    await Promise.all([
      waitFor(() => read(stack, left), completed),
      waitFor(() => read(stack, right), completed),
    ]);
    await request(stack, "/runtime/fixture/content-access", {
      address: left,
      enabled: false,
    });
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: left })).status,
      403
    );
    const sibling = await read(stack, right);
    assert.deepEqual(userTexts(sibling), ["Explain the right policy."]);
    await request(stack, "/runtime/fixture/access", {
      address: left,
      enabled: false,
    });
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: left })).status,
      403
    );
    await send(
      stack,
      right,
      "keep-right-again",
      "Explain the right follow-up."
    );
    const final = await waitFor(
      () => read(stack, right),
      (snapshot) => completed(snapshot) && userTexts(snapshot).length === 2
    );
    assert.deepEqual(userTexts(final), [
      "Explain the right policy.",
      "Explain the right follow-up.",
    ]);
    await request(stack, "/runtime/fixture/access", {
      address: left,
      enabled: true,
    });
    await request(stack, "/runtime/fixture/content-access", {
      address: left,
      enabled: true,
    });
    const restored = await read(stack, left);
    assert.ok(completed(restored));
    assert.deepEqual(userTexts(restored), ["Explain the left policy."]);
    await evidence(stack, "identity-revocation-isolation", {
      final,
      restored,
      sibling,
    });
  }
);

journey(
  "Stop affects one native conversation and retains a sibling's shared wake alarm",
  async (stack) => {
    const left = addressFor("identity-stop", "stop-left", "agent-left");
    const right = addressFor("identity-stop", "stop-right", "agent-right");
    await control(stack, { delayMs: 5000 });
    await Promise.all([
      send(stack, left, "stop-only-left", "Explain the left policy."),
      send(stack, right, "keep-right-running", "Explain the right policy."),
    ]);
    const relations = await Promise.all([
      waitFor(
        () =>
          inputCorrelation(
            stack,
            left,
            "stop-only-left",
            "Explain the left policy."
          ),
        () => true
      ),
      waitFor(
        () =>
          inputCorrelation(
            stack,
            right,
            "keep-right-running",
            "Explain the right policy."
          ),
        () => true
      ),
    ]);
    await waitFor(
      () => provider(stack),
      (value) =>
        relations.every((relation) =>
          inputCalls(value, relation.address, relation.operationId).some(
            (call) =>
              call.operationId === relation.nativeRequestId &&
              call.completedAt === undefined
          )
        )
    );
    const beforeStop = await waitFor(
      () => read(stack, left),
      (snapshot) =>
        snapshot.busy &&
        snapshot.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.state === "streaming" &&
            message.text.length > 0
        )
    );
    const stopped = await stop(stack, left);
    assert.equal(stopped.stopped, true);
    const leftStopped = await waitFor(
      () => read(stack, left),
      (snapshot) => !snapshot.busy
    );
    assert.ok(
      leftStopped.messages.some(
        (message) =>
          message.role === "assistant" && message.outcome === "interrupted"
      )
    );
    const sibling = await read(stack, right);
    assert.equal(sibling.busy, true);
    const active = await lifecycle(stack, right);
    assert.notEqual(active.alarmAt, null);
    assert.ok(
      active.pending.some(
        (operation) => operation.operationId === relations[1]?.nativeRequestId
      )
    );
    assert.ok(active.jobs.length > 0);
    await control(stack, { delayMs: 0 });
    const final = await waitFor(() => read(stack, right), completed);
    await waitForQuiet(stack, right);
    await evidence(stack, "identity-stop-and-shared-alarm", {
      sibling,
      active,
      final,
      relations,
      beforeStop,
      leftStopped,
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
    const relations = await Promise.all([
      waitFor(
        () =>
          inputCorrelation(
            stack,
            left,
            "identity-crash-left",
            "Recover the left policy."
          ),
        () => true
      ),
      waitFor(
        () =>
          inputCorrelation(
            stack,
            right,
            "identity-crash-right",
            "Recover the right policy."
          ),
        () => true
      ),
    ]);
    await waitFor(
      () => provider(stack),
      (value) =>
        relations.every((relation) =>
          inputCalls(value, relation.address, relation.operationId).some(
            (call) =>
              call.operationId === relation.nativeRequestId &&
              call.completedAt === undefined
          )
        )
    );
    const killedAt = Date.now();
    restart(stack);
    await control(stack, { delayMs: 0 });
    const automaticRecovery = await waitFor(
      () => provider(stack),
      (value) =>
        relations.every((relation) =>
          inputCalls(value, relation.address, relation.operationId).some(
            (call) =>
              call.operationId === relation.nativeRequestId &&
              call.startedAt > killedAt &&
              call.completedAt !== undefined &&
              call.status === 200 &&
              call.input?.instanceId !== beforeCrash.instanceId
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
    assert.notEqual(reopenedA.nativeSessionId, reopenedB.nativeSessionId);
    for (const relation of relations) {
      assert.deepEqual(
        await inputCorrelation(
          stack,
          relation.address,
          relation.operationId,
          relation.address.sessionId === left.sessionId
            ? "Recover the left policy."
            : "Recover the right policy."
        ),
        relation
      );
    }
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
      relations,
      killedAt,
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
    const siblingRelation = await waitFor(
      () =>
        inputCorrelation(
          stack,
          right,
          "identity-commit-sibling",
          "Keep the sibling input after reset."
        ),
      () => true
    );
    await waitFor(
      () => provider(stack),
      (value) =>
        inputCalls(value, right, "identity-commit-sibling").some(
          (call) =>
            call.operationId === siblingRelation.nativeRequestId &&
            call.completedAt === undefined
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
    await control(stack, { delayMs: 0 });
    const recoveredBeforeRead = await waitFor(
      () => provider(stack),
      (value) =>
        (
          [
            [right, "identity-commit-sibling"],
            [left, "identity-commit-failure"],
          ] as const
        ).every(([address, operationId]) =>
          inputCalls(value, address, operationId).some(
            (call) =>
              call.input?.instanceId !== beforeFailure.instanceId &&
              call.completedAt !== undefined &&
              call.status === 200
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
    assert.notEqual(hostA.nativeSessionId, hostB.nativeSessionId);
    assert.equal(hostA.failures.length, 1);
    assert.equal(hostA.failures[0]?.instanceId, beforeFailure.instanceId);
    assert.equal(hostB.failures.length, 0);
    const relation = await inputCorrelation(
      stack,
      left,
      "identity-commit-failure",
      "Keep the committed input after reset."
    );
    assert.deepEqual(
      await inputCorrelation(
        stack,
        right,
        "identity-commit-sibling",
        "Keep the sibling input after reset."
      ),
      siblingRelation
    );
    const [failure] = hostA.failures;
    assert.equal(failure?.operationId, "identity-commit-failure");
    assert.ok(
      failure &&
        failure.committedSeq > 0 &&
        failure.witness?.kind === "submission"
    );
    assert.deepEqual(failure.witness, {
      kind: "submission",
      address: left,
      nativeSessionId: relation.nativeSessionId,
      nativeRequestId: relation.nativeRequestId,
      entryId: relation.entryId,
      submissionId: relation.submissionId,
      at: failure.witness.at,
    });
    assert.ok(failure.witness.at > 0);
    for (const captured of [relation, siblingRelation]) {
      const calls = inputCalls(
        recoveredBeforeRead,
        captured.address,
        captured.operationId
      ).filter(
        (call) =>
          call.completedAt !== undefined &&
          call.status === 200 &&
          call.input?.instanceId === hostA.instanceId
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]?.input, {
        kind: "web",
        ...captured,
        instanceId: hostA.instanceId,
      });
    }
    const resetLogs = compose(stack, ["logs", "--no-color", "celld"]);
    const resetWitness = assertPiFailure(resetLogs, left, failure.witness.at);
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
    const replayedPhysical = await provider(stack);
    for (const captured of [relation, siblingRelation]) {
      assert.equal(
        inputCalls(
          replayedPhysical,
          captured.address,
          captured.operationId
        ).filter(
          (call) => call.completedAt !== undefined && call.status === 200
        ).length,
        1
      );
    }
    assert.equal((await runtimeEvidence(stack, left)).failures.length, 1);
    assert.equal((await runtimeEvidence(stack, right)).failures.length, 0);
    await evidence(stack, "identity-shared-commit-failure", {
      beforeFailure,
      interruptedStatus,
      recoveredBeforeRead,
      a,
      b,
      hostA,
      hostB,
      siblingRelation,
      relation,
      resetWitness,
      replayedPhysical,
    });
  }
);
