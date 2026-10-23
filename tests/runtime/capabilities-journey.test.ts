/* oxlint-disable unicorn/no-await-expression-member, no-await-in-loop -- Each persisted observation and crash boundary depends on its preceding result. */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import type {
  ChatActivity,
  ChatSnapshot,
} from "../../packages/contracts/src/session-service.ts";
import {
  addressFor,
  boot,
  capabilityProvider,
  capabilityStorage,
  chatControl,
  compose,
  control,
  decide,
  evidence,
  fork,
  lifecycle,
  newStack,
  pending,
  provider,
  rawRequest,
  read,
  request,
  reserveFork,
  runtimeEvidence,
  send,
  stop,
  waitFor,
} from "./helpers.ts";
import type { Stack } from "./helpers.ts";

let stack: Stack;
let failed = false;
const activity = (snapshot: ChatSnapshot): ChatActivity => {
  assert.ok(snapshot.activity);
  return snapshot.activity;
};
const settled = (snapshot: ChatSnapshot): boolean =>
  !snapshot.busy &&
  snapshot.messages.some((message) => message.role === "assistant");
const userTexts = (snapshot: ChatSnapshot): readonly string[] =>
  snapshot.messages
    .filter((message) => message.role === "user")
    .map((message) => message.text);
const note = async (
  address: EventAddress,
  operationId: string,
  text: string
) => {
  await send(stack, address, operationId, text);
  return waitFor(
    () => read(stack, address),
    (snapshot) => settled(snapshot) && userTexts(snapshot).includes(text)
  );
};
const restart = () => {
  compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
  compose(stack, ["up", "-d", "--wait", "celld"]);
};
before(
  async () => {
    stack = await newStack("capabilities");
    boot(stack);
  },
  { timeout: 600_000 }
);
after(
  async () => {
    if (failed) {
      await evidence(stack, "capabilities-failure", {
        logs: compose(stack, [
          "logs",
          "--no-color",
          "--tail=150",
          "celld",
          "bootstrap",
        ]),
        model: await capabilityProvider(stack),
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
  "a reserved fork inherits one selected entry range, retries, pins and copied content gates",
  async () => {
    const source = addressFor("cap-fork", "original", "cap-agent-v2");
    const destination = addressFor("cap-fork", "branch", "cap-agent-v2");
    const first = await note(
      source,
      "fork-first",
      "CAP_NOTE FIRST_BRANCH_MARKER"
    );
    const entry = first.messages.find(
      (message) => message.role === "assistant" && message.entryId
    );
    assert.ok(entry?.entryId);
    await note(source, "fork-second", "CAP_NOTE LATER_ONLY_MARKER");
    await reserveFork(
      stack,
      destination,
      source,
      entry.entryId,
      first.agentVersion
    );
    const created = await fork(
      stack,
      source,
      destination,
      entry.entryId,
      "fork-operation"
    );
    assert.deepEqual(created.address, destination);
    const branch = await read(stack, destination);
    assert.deepEqual(userTexts(branch), ["CAP_NOTE FIRST_BRANCH_MARKER"]);
    assert.equal(branch.agentVersion, 2);
    assert.deepEqual(activity(branch).origin, {
      conversationId: source.conversationId,
      entryId: entry.entryId,
    });
    assert.deepEqual(
      await fork(stack, source, destination, entry.entryId, "fork-operation"),
      created
    );
    const sourceNative = await runtimeEvidence(stack, source);
    const stored = await capabilityStorage(stack, destination);
    assert.equal(stored.conversations.length, 1);
    assert.equal(
      stored.conversations[0]?.parentConversationId,
      Number(sourceNative.nativeSessionId)
    );
    assert.equal(stored.conversations[0]?.parentEntryId, Number(entry.entryId));
    const mismatched = await rawRequest(stack, "/runtime/fork", {
      address: source,
      destination,
      entryId: "999999999",
      operationId: "fork-operation",
    });
    assert.equal(mismatched.status, 400);
    const foreign = await rawRequest(stack, "/runtime/fork", {
      address: source,
      destination: addressFor("other-identity", "branch", "cap-agent-v2"),
      entryId: entry.entryId,
      operationId: "foreign-fork",
    });
    assert.equal(foreign.status, 400);
    restart();
    const recovered = await read(stack, destination);
    assert.deepEqual(userTexts(recovered), ["CAP_NOTE FIRST_BRANCH_MARKER"]);
    assert.equal(
      (await capabilityStorage(stack, destination)).conversations[0]?.id,
      stored.conversations[0]?.id
    );
    await request(stack, "/runtime/fixture/content-access", {
      address: source,
      enabled: false,
    });
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: destination }))
        .status,
      403
    );
    await request(stack, "/runtime/fixture/content-access", {
      address: source,
      enabled: true,
    });
    await evidence(stack, "capability-fork", {
      branch,
      recovered,
      stored,
      sourceNative,
    });
  }
);

journey(
  "owned child approvals survive restart, reject a sibling decision and remain scoped on Stop",
  async () => {
    const address = addressFor("cap-child", "parent", "cap-delegate");
    const sibling = addressFor("cap-child", "sibling", "cap-sibling");
    await send(stack, address, "child-first", "CAP_DELEGATE FIRST");
    const approval = await pending(stack, address);
    const beforeRestart = await read(stack, address);
    const [child] = activity(beforeRestart).children;
    assert.ok(child);
    assert.equal(child.purpose, "delegate");
    assert.equal(child.state, "running");
    assert.ok(child.tools.some((tool) => tool.toolName === "fixture_effect"));
    const { tasks } = activity(beforeRestart);
    const delegationTask = tasks.find((task) => task.id === child.ownerTaskId);
    assert.equal(delegationTask?.conversationId, address.conversationId);
    assert.equal(delegationTask?.kind, "pi.tool");
    const childGeneration = tasks.find(
      (task) =>
        task.conversationId === child.id && task.kind === "pi.generation"
    );
    assert.ok(childGeneration);
    assert.equal(childGeneration.ownerTaskId, child.ownerTaskId);
    const approvalTask = tasks.find((task) => task.id === approval.taskId);
    assert.equal(approvalTask?.conversationId, child.id);
    assert.equal(approvalTask?.ownerTaskId, childGeneration.id);
    assert.equal(approvalTask?.kind, "pi.tool");
    assert.notEqual(approval.taskId, child.ownerTaskId);
    const saved = await capabilityStorage(stack, address);
    assert.equal(saved.conversations.length, 2);
    const owned = saved.conversations.find(
      (conversation) => conversation.ownerTaskId !== null
    );
    assert.equal(String(owned?.ownerTaskId), child.ownerTaskId);
    restart();
    const recoveredApproval = await pending(stack, address);
    assert.equal(recoveredApproval.approvalId, approval.approvalId);
    assert.equal(recoveredApproval.operationId, approval.operationId);
    assert.equal(recoveredApproval.taskId, approval.taskId);
    const recoveredActivity = activity(await read(stack, address));
    assert.equal(recoveredActivity.children[0]?.id, child.id);
    assert.equal(
      recoveredActivity.tasks.find((task) => task.id === approval.taskId)
        ?.conversationId,
      child.id
    );
    assert.equal(
      recoveredActivity.tasks.find((task) => task.id === childGeneration.id)
        ?.ownerTaskId,
      child.ownerTaskId
    );
    const recoveredStorage = await capabilityStorage(stack, address);
    assert.deepEqual(recoveredStorage.conversations, saved.conversations);
    assert.deepEqual(
      recoveredStorage.submissions.map((submission) => submission.id),
      saved.submissions.map((submission) => submission.id)
    );
    const foreign = await rawRequest(stack, "/runtime/decide", {
      address: sibling,
      approvalId: approval.approvalId,
      decision: "allow",
    });
    assert.equal(foreign.status, 404);
    await chatControl(stack, address, {
      childId: child.id,
      kind: "stop-child",
    });
    const stopped = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).children[0]?.state === "interrupted"
    );
    assert.ok(
      stopped.approvals.some(
        (value) =>
          value.approvalId === approval.approvalId &&
          value.state === "cancelled"
      )
    );
    assert.equal(
      (await provider(stack)).tools.filter(
        (tool) => tool.operationId === approval.operationId && tool.write
      ).length,
      0
    );
    await note(
      sibling,
      "sibling-still-works",
      "CAP_NOTE SIBLING_STILL_ALLOWED"
    );
    await send(stack, address, "child-second", "CAP_DELEGATE SECOND");
    const nextApproval = await pending(stack, address);
    assert.notEqual(nextApproval.approvalId, approval.approvalId);
    await decide(stack, address, nextApproval);
    const completed = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).children.some((value) => value.state === "succeeded")
    );
    assert.equal(
      (await provider(stack)).tools.filter(
        (tool) => tool.operationId === nextApproval.operationId && tool.write
      ).length,
      1
    );
    assert.ok(
      activity(completed).children.some(
        (value) => value.id === child.id && value.state === "interrupted"
      )
    );
    const calls = (await capabilityProvider(stack)).model.filter(
      (call) =>
        call.scope === address.sessionId &&
        call.prompt.startsWith("CAP_CHILD_APPLY")
    );
    assert.ok(calls.length >= 2);
    assert.ok(
      calls.every(
        (call) =>
          !call.toolNames.includes("subagent") &&
          !call.toolNames.includes("schedule")
      )
    );
    await evidence(stack, "capability-child-restart", {
      approval,
      beforeRestart,
      completed,
      recoveredStorage,
      saved,
    });
  }
);

journey(
  "the durable child deadline aborts only its owned execution after a process restart",
  async () => {
    const address = addressFor("cap-deadline", "parent", "cap-deadline-agent");
    const sibling = addressFor(
      "cap-deadline",
      "sibling",
      "cap-deadline-sibling"
    );
    await Promise.all([
      send(stack, address, "deadline-child", "CAP_DELEGATE DEADLINE"),
      send(stack, sibling, "deadline-sibling", "CAP_DELEGATE SIBLING"),
    ]);
    const [approval, siblingApproval] = await Promise.all([
      pending(stack, address),
      pending(stack, sibling),
    ]);
    const [child] = activity(await read(stack, address)).children;
    assert.ok(child);
    const jobs = await lifecycle(stack, address);
    assert.ok(
      jobs.jobs.some(
        (job) => job.fn === "cerebro-child" && job.time > Date.now() + 500_000
      )
    );
    const expired = await request(
      stack,
      "/runtime/fixture/capabilities/expire-child",
      {
        address,
        childId: child.id,
      }
    );
    assert.ok(
      expired &&
        typeof expired === "object" &&
        "rescheduled" in expired &&
        expired.rescheduled === true
    );
    restart();
    const ended = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).children[0]?.state === "interrupted"
    );
    const unaffected = await read(stack, sibling);
    assert.ok(
      unaffected.approvals.some(
        (value) =>
          value.approvalId === siblingApproval.approvalId &&
          value.state === "pending"
      )
    );
    assert.equal(activity(unaffected).children[0]?.state, "running");
    await decide(stack, sibling, siblingApproval, "deny");
    await waitFor(() => read(stack, sibling), settled);
    assert.equal(
      (await provider(stack)).tools.filter(
        (tool) => tool.operationId === approval.operationId && tool.write
      ).length,
      0
    );
    await evidence(stack, "capability-child-deadline", {
      ended,
      jobs,
      unaffected,
    });
  }
);

journey(
  "one-shot reminders survive Stop and SIGKILL and admit one input before any reader",
  async () => {
    const address = addressFor("cap-reminder", "once", "cap-reminder-agent");
    const runAt = Date.now() + 6000;
    const command = {
      instruction: "CAP_REMINDER_DUE ONCE_MARKER",
      kind: "schedule" as const,
      operationId: "reminder-once",
      runAt,
    };
    const receipt = await chatControl(stack, address, command);
    assert.deepEqual(await chatControl(stack, address, command), receipt);
    const changed = await rawRequest(stack, "/runtime/control", {
      address,
      command: { ...command, instruction: "Changed reminder" },
    });
    assert.equal(changed.status, 409);
    await stop(stack, address);
    assert.ok(
      activity(await read(stack, address)).reminders.some(
        (value) => value.id === receipt.id && value.state === "scheduled"
      )
    );
    const armed = await lifecycle(stack, address);
    assert.ok(armed.jobs.some((job) => job.fn === "cerebro-reminder"));
    restart();
    const automatic = await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId &&
            call.prompt.includes("ONCE_MARKER") &&
            call.completedAt !== undefined
        )
    );
    const final = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).reminders.some(
          (value) => value.id === receipt.id && value.state === "completed"
        )
    );
    const stored = await capabilityStorage(stack, address);
    assert.equal(
      stored.submissions.filter(
        (submission) => submission.requestId === `${receipt.id}:${runAt}`
      ).length,
      1
    );
    assert.equal(
      userTexts(final).filter((value) => value.includes("ONCE_MARKER")).length,
      1
    );
    assert.deepEqual(await chatControl(stack, address, command), receipt);
    assert.equal(
      activity(await read(stack, address)).reminders.find(
        (value) => value.id === receipt.id
      )?.state,
      "completed"
    );
    await evidence(stack, "capability-reminder-recovery", {
      armed,
      automatic,
      final,
      receipt,
      stored,
    });
  }
);

journey(
  "recurring reminders advance without model rescheduling and cancellation survives restart",
  async () => {
    const address = addressFor(
      "cap-recurring",
      "recurring",
      "cap-recurring-agent"
    );
    const runAt = Date.now() + 2000;
    const receipt = await chatControl(stack, address, {
      instruction: "CAP_REMINDER_DUE RECURRING_MARKER",
      kind: "schedule",
      operationId: "recurring",
      recurrence: { interval: 1, timezone: "America/Bogota", unit: "minute" },
      runAt,
    });
    await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId && call.completedAt !== undefined
        )
    );
    const first = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).reminders.some(
          (value) => value.id === receipt.id && value.runAt === runAt + 60_000
        )
    );
    restart();
    const automatic = await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.filter(
          (call) =>
            call.scope === address.sessionId && call.completedAt !== undefined
        ).length === 2,
      90_000
    );
    const second = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).reminders.some(
          (value) => value.id === receipt.id && value.runAt === runAt + 120_000
        )
    );
    const stored = await capabilityStorage(stack, address);
    assert.equal(
      stored.submissions.filter(
        (value) => value.requestId === `${receipt.id}:${runAt}`
      ).length,
      1
    );
    assert.equal(
      stored.submissions.filter(
        (value) => value.requestId === `${receipt.id}:${runAt + 60_000}`
      ).length,
      1
    );
    await chatControl(stack, address, {
      kind: "cancel-schedule",
      scheduleId: receipt.id,
    });
    await chatControl(stack, address, {
      kind: "cancel-schedule",
      scheduleId: receipt.id,
    });
    restart();
    const cancelled = await read(stack, address);
    assert.equal(
      activity(cancelled).reminders.find((value) => value.id === receipt.id)
        ?.state,
      "cancelled"
    );
    assert.equal(
      (await lifecycle(stack, address)).jobs.some(
        (job) => job.fn === "cerebro-reminder"
      ),
      false
    );
    await evidence(stack, "capability-recurring-reminder", {
      automatic,
      cancelled,
      first,
      receipt,
      second,
      stored,
    });
  }
);

journey(
  "model tools register durable reminders that can be cancelled through the chat control",
  async () => {
    const address = addressFor(
      "cap-model-schedule",
      "scheduled",
      "cap-schedule-agent"
    );
    await send(stack, address, "model-schedule", "CAP_SCHEDULE a follow-up");
    const snapshot = await waitFor(
      () => read(stack, address),
      (value) => settled(value) && activity(value).reminders.length === 1
    );
    const [reminder] = activity(snapshot).reminders;
    assert.ok(reminder);
    assert.equal(reminder.instruction, "CAP_REMINDER_TOOL_DUE");
    assert.ok(
      snapshot.tools.some(
        (tool) => tool.toolName === "schedule" && tool.state === "succeeded"
      )
    );
    await chatControl(stack, address, {
      kind: "cancel-schedule",
      scheduleId: reminder.id,
    });
    assert.equal(
      activity(await read(stack, address)).reminders[0]?.state,
      "cancelled"
    );
  }
);

journey(
  "manual compaction has one durable receipt and completes after SIGKILL before a reader",
  async () => {
    const address = addressFor(
      "cap-compaction",
      "long-history",
      "cap-compact-agent"
    );
    for (let index = 0; index < 4; index += 1) {
      await note(
        address,
        `long-${index}`,
        `CAP_COMPACT turn-${index} ${"archive ".repeat(4500)}`
      );
    }
    await control(stack, { delayMs: 5000 });
    const command = {
      instructions: "Preserve the archive decisions.",
      kind: "compact" as const,
      operationId: "manual-compaction",
    };
    const receipt = await chatControl(stack, address, command);
    await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId && call.purpose === "compaction"
        )
    );
    restart();
    await control(stack, { delayMs: 0 });
    const automatic = await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId &&
            call.purpose === "compaction" &&
            call.completedAt !== undefined
        )
    );
    const final = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        !snapshot.busy &&
        activity(snapshot).compactions.length === 0 &&
        snapshot.messages.some((message) =>
          message.text.includes("Fixture compacted capability history.")
        )
    );
    assert.deepEqual(await chatControl(stack, address, command), receipt);
    const stored = await capabilityStorage(stack, address);
    assert.equal(
      stored.tasks.filter((task) => task.kind === "pi.compaction").length,
      1
    );
    const wakeId = `cerebro-compact:${address.sessionId}:${command.operationId}`;
    await waitFor(
      () => lifecycle(stack, address),
      (value) => !value.jobs.some((job) => job.id === wakeId)
    );
    const changed = await rawRequest(stack, "/runtime/control", {
      address,
      command: { ...command, instructions: "Changed compaction" },
    });
    assert.equal(changed.status, 409);
    assert.equal(
      (await lifecycle(stack, address)).jobs.some((job) => job.id === wakeId),
      false
    );
    await evidence(stack, "capability-compaction-recovery", {
      automatic,
      final,
      receipt,
      stored,
    });
  }
);

journey(
  "Stop aborts manual compaction and an operation retry cannot restart it",
  async () => {
    const address = addressFor(
      "cap-compaction-stop",
      "history",
      "cap-compact-stop-agent"
    );
    for (let index = 0; index < 4; index += 1) {
      await note(
        address,
        `stop-history-${index}`,
        `CAP_COMPACT stop-turn-${index} ${"archive ".repeat(4500)}`
      );
    }
    await control(stack, { delayMs: 5000 });
    const command = {
      instructions: "Preserve the decisions.",
      kind: "compact" as const,
      operationId: "stopped-compaction",
    };
    const receipt = await chatControl(stack, address, command);
    await waitFor(
      () => capabilityProvider(stack),
      (value) =>
        value.model.some(
          (call) =>
            call.scope === address.sessionId &&
            call.purpose === "compaction" &&
            call.completedAt === undefined
        )
    );
    const running = await read(stack, address);
    await evidence(stack, "capability-compaction-stop-running", {
      live: await request(
        stack,
        "/runtime/fixture/capabilities/compaction-state",
        {
          address,
        }
      ),
      model: await capabilityProvider(stack),
      running,
      stored: await capabilityStorage(stack, address),
    });
    assert.equal(running.busy, true);
    assert.ok(
      activity(running).compactions.some(
        (compaction) =>
          compaction.id === receipt.id && compaction.reason === "manual"
      )
    );
    assert.equal((await stop(stack, address)).stopped, true);
    const stopped = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        !snapshot.busy && activity(snapshot).compactions.length === 0
    );
    assert.equal(
      stopped.messages.some((message) => message.kind === "summary"),
      false
    );
    const stored = await capabilityStorage(stack, address);
    const tasks = stored.tasks.filter((task) => task.kind === "pi.compaction");
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.status, "terminal");
    await control(stack, { delayMs: 0 });
    assert.deepEqual(await chatControl(stack, address, command), receipt);
    const wakeId = `cerebro-compact:${address.sessionId}:${command.operationId}`;
    await waitFor(
      () => lifecycle(stack, address),
      (value) => !value.jobs.some((job) => job.id === wakeId)
    );
    restart();
    const restored = await read(stack, address);
    assert.equal(restored.busy, false);
    assert.equal(activity(restored).compactions.length, 0);
    assert.equal(
      restored.messages.some((message) => message.kind === "summary"),
      false
    );
    assert.equal(
      (await capabilityStorage(stack, address)).tasks.filter(
        (task) => task.kind === "pi.compaction"
      ).length,
      1
    );
    const nextReceipt = await chatControl(stack, address, {
      ...command,
      operationId: "fresh-compaction",
    });
    assert.notEqual(nextReceipt.id, receipt.id);
    const completed = await waitFor(
      () => read(stack, address),
      (snapshot) =>
        !snapshot.busy &&
        activity(snapshot).compactions.length === 0 &&
        snapshot.messages.some((message) => message.kind === "summary")
    );
    assert.equal(
      (await capabilityStorage(stack, address)).tasks.filter(
        (task) => task.kind === "pi.compaction"
      ).length,
      2
    );
    await evidence(stack, "capability-compaction-stop", {
      completed,
      nextReceipt,
      receipt,
      restored,
      running,
      stopped,
      stored,
    });
  }
);

journey(
  "history search excludes a revoked agent and preserves source access on later reads and forks",
  async () => {
    const allowed = addressFor(
      "cap-history",
      "permitted-source",
      "cap-allowed-agent"
    );
    const denied = addressFor(
      "cap-history",
      "denied-source",
      "cap-denied-agent"
    );
    const target = addressFor(
      "cap-history",
      "search-target",
      "cap-search-agent"
    );
    await note(
      allowed,
      "permitted-history",
      "CAP_NOTE CAP_SEARCH_TOKEN ALLOW_ONLY_123"
    );
    await note(
      denied,
      "denied-history",
      "CAP_NOTE CAP_SEARCH_TOKEN DENY_SECRET_987"
    );
    await request(stack, "/runtime/fixture/access", {
      address: denied,
      enabled: false,
    });
    await send(
      stack,
      target,
      "history-question",
      "CAP_HISTORY CAP_SEARCH_TOKEN"
    );
    const result = await waitFor(
      () => read(stack, target),
      (snapshot) =>
        settled(snapshot) &&
        activity(snapshot).children.some(
          (child) => child.purpose === "history" && child.state === "succeeded"
        )
    );
    const resultText = JSON.stringify(result);
    assert.match(resultText, /ALLOW_ONLY_123/u);
    assert.ok(resultText.includes(allowed.conversationId));
    assert.equal(resultText.includes("DENY_SECRET_987"), false);
    assert.equal(resultText.includes(denied.conversationId), false);
    const searchCalls = (await capabilityProvider(stack)).model.filter(
      (call) =>
        call.scope === target.sessionId &&
        call.toolNames.includes("search_conversations")
    );
    assert.ok(searchCalls.length > 0);
    assert.ok(searchCalls.every((call) => call.toolNames.length === 1));
    const entry = result.messages.findLast(
      (message) => message.role === "assistant" && message.entryId
    );
    assert.ok(entry?.entryId);
    const branch = addressFor(
      "cap-history",
      "search-branch",
      "cap-search-agent"
    );
    await reserveFork(
      stack,
      branch,
      target,
      entry.entryId,
      result.agentVersion
    );
    await fork(stack, target, branch, entry.entryId, "history-fork");
    await request(stack, "/runtime/fixture/access", {
      address: allowed,
      enabled: false,
    });
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: target })).status,
      403
    );
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: branch })).status,
      403
    );
    restart();
    assert.equal(
      (await rawRequest(stack, "/runtime/read", { address: target })).status,
      403
    );
    await request(stack, "/runtime/fixture/access", {
      address: allowed,
      enabled: true,
    });
    assert.equal(
      (await read(stack, target)).address.sessionId,
      target.sessionId
    );
    await evidence(stack, "capability-history-authority", {
      result,
      searchCalls,
    });
  }
);
