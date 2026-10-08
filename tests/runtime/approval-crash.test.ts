/* oxlint-disable unicorn/no-await-expression-member -- Assertions use the preceding native response. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addressFor,
  approve,
  boot,
  compose,
  effectOptions,
  evidence,
  getFixture,
  inspect,
  messageEvent,
  newStack,
  observe,
  pending,
  request,
  rawRequest,
  submit,
  waitFor,
} from "./helpers.ts";
import type { ProviderEvidence } from "./helpers.ts";

interface NativeWork {
  readonly submissions: readonly {
    readonly request_id: string | null;
    readonly status: string;
  }[];
  readonly tasks: readonly { readonly status: string }[];
}

interface CheckpointEvidence {
  readonly control: unknown;
  readonly observations: readonly {
    readonly at: number;
    readonly boundary: string;
    readonly operation_id: string;
    readonly status: string;
  }[];
}

test(
  "pending native approval and acknowledgement survive SIGKILL",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("approval");
    const address = addressFor("company-approval", "conversation-1");
    let passed = false;
    try {
      boot(stack);
      const event = messageEvent(address, "approval-event");
      const accepted = await submit(stack, event);
      const approval = await pending(stack, address);
      assert.equal((await getFixture<ProviderEvidence>(stack)).tools.length, 0);
      const before = await inspect(stack, address);
      await evidence(stack, "before-kill", { accepted, approval, before });
      compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
      compose(stack, ["up", "-d", "--wait", "celld"]);
      const reopened = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "waiting-for-approval",
        60_000
      );
      assert.deepEqual(reopened.approvals, before.approvals);
      assert.equal(reopened.runs[0]?.state, "waiting-for-approval");
      const replay = await submit(stack, event);
      assert.equal(replay.runId, accepted.runId);
      assert.equal(replay.replayed, true);
      assert.equal((await getFixture<ProviderEvidence>(stack)).tools.length, 0);
      const allowed = await approve(stack, address, approval);
      assert.deepEqual(await approve(stack, address, approval), allowed);
      const final = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "completed",
        120_000
      );
      assert.equal(final.outputs.length, 1);
      assert.equal(
        (await getFixture<ProviderEvidence>(stack)).tools.filter(
          (value) => value.operationId === approval.operationId
        ).length,
        1
      );
      await evidence(stack, "approval-restart", {
        accepted,
        before,
        final,
        reopened,
        replay,
      });
      passed = true;
    } finally {
      if (passed) {
        compose(stack, ["down", "-v"]);
      } else {
        await evidence(stack, "failure", {
          containers: compose(stack, ["ps", "--all", "--format", "json"]),
          logs: compose(stack, [
            "logs",
            "--no-color",
            "--tail=100",
            "celld",
            "bootstrap",
          ]),
        });
      }
    }
  }
);

test(
  "native denial completes with a failed tool and no write",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("denial", false, true);
    const address = addressFor("company-denied", "conversation-1");
    let passed = false;
    try {
      boot(stack);
      const accepted = await submit(
        stack,
        messageEvent(address, "denied-event")
      );
      const approval = await pending(stack, address);
      await evidence(stack, "before-denial", { accepted, approval });
      const denied = await approve(stack, address, approval, "deny");
      const terminal = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "completed",
        60_000
      );
      assert.equal(terminal.approvals[0]?.state, "denied");
      assert.equal(terminal.tools[0]?.state, "failed");
      assert.equal(terminal.outputs.length, 1);
      const provider = await getFixture<ProviderEvidence>(stack);
      assert.equal(
        provider.tools.filter(
          (value) => value.operationId === approval.operationId
        ).length,
        0
      );
      const trace = await request(stack, "/runtime/fixture/trace", { address });
      await evidence(stack, "denial", {
        accepted,
        approval,
        denied,
        provider,
        terminal,
        trace,
      });
      passed = true;
    } finally {
      if (passed) {
        compose(stack, ["down", "-v"]);
      } else {
        const trace = await request(stack, "/runtime/fixture/trace", {
          address,
        });
        const snapshot = await inspect(stack, address);
        await evidence(stack, "failure", {
          containers: compose(stack, ["ps", "--all", "--format", "json"]),
          logs: compose(stack, [
            "logs",
            "--no-color",
            "--tail=100",
            "celld",
            "bootstrap",
          ]),
          snapshot,
          trace,
        });
      }
    }
  }
);

test(
  "explicit Stop replay and cancelled native work survive SIGKILL",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("stop-approval", false, true);
    const address = addressFor("company-stop-approval", "conversation-1");
    let passed = false;
    try {
      boot(stack);
      const accepted = await submit(stack, messageEvent(address, "stop-event"));
      const approval = await pending(stack, address);
      await evidence(stack, "before-stop", { accepted, approval });
      const cancel = {
        address,
        command: { runId: accepted.runId, type: "cancel" },
        options: effectOptions("stop-command"),
      };
      const stopped = await request(stack, "/runtime/cancel", cancel);
      assert.deepEqual(
        await request(stack, "/runtime/cancel", cancel),
        stopped
      );
      const terminal = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "cancelled",
        60_000
      );
      assert.equal(terminal.outputs.length, 0);
      assert.equal(terminal.approvals[0]?.state, "cancelled");
      const provider = await getFixture<ProviderEvidence>(stack);
      assert.equal(provider.tools.length, 0);
      const trace = await request(stack, "/runtime/fixture/trace", { address });
      const native = await request<NativeWork>(
        stack,
        "/runtime/fixture/native-storage",
        { address }
      );
      assert.ok(native.tasks.length > 0);
      assert.ok(native.tasks.every((task) => task.status === "terminal"));
      assert.ok(
        native.submissions.every(
          (submission) =>
            submission.status !== "queued" && submission.status !== "placed"
        )
      );
      await evidence(stack, "before-stop-restart", {
        native,
        provider,
        stopped,
        terminal,
      });
      compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
      compose(stack, ["up", "-d", "--wait", "celld"]);
      const reopened = await inspect(stack, address);
      assert.equal(reopened.runs[0]?.state, "cancelled");
      assert.equal(reopened.approvals[0]?.state, "cancelled");
      assert.equal(reopened.outputs.length, 0);
      assert.deepEqual(
        await request(stack, "/runtime/cancel", cancel),
        stopped
      );
      const reopenedNative = await request<NativeWork>(
        stack,
        "/runtime/fixture/native-storage",
        { address }
      );
      assert.deepEqual(reopenedNative, native);
      const observer = await observe(stack, address);
      const observed = await observer.next();
      await observer.close();
      assert.equal(observed.type, "snapshot");
      if (observed.type === "snapshot") {
        assert.equal(observed.snapshot.runs[0]?.state, "cancelled");
        assert.equal(observed.snapshot.approvals[0]?.state, "cancelled");
        assert.equal(observed.snapshot.outputs.length, 0);
      }
      const outsider = await rawRequest(
        stack,
        "/runtime/stream",
        { address, options: effectOptions("outsider-stop-observation") },
        "user:another-company"
      );
      assert.equal(outsider.status, 403);
      const reopenedProvider = await getFixture<ProviderEvidence>(stack);
      assert.deepEqual(reopenedProvider.model, provider.model);
      assert.equal(reopenedProvider.tools.length, 0);
      await evidence(stack, "stop-approval", {
        accepted,
        approval,
        native,
        observed,
        provider,
        reopened,
        reopenedNative,
        reopenedProvider,
        stopped,
        terminal,
        trace,
      });
      passed = true;
    } finally {
      if (passed) {
        compose(stack, ["down", "-v"]);
      } else {
        const trace = await request(stack, "/runtime/fixture/trace", {
          address,
        });
        const native = await request(stack, "/runtime/fixture/native-storage", {
          address,
        }).catch((error: unknown) => ({ diagnosticError: String(error) }));
        const snapshot = await inspect(stack, address);
        await evidence(stack, "failure", {
          containers: compose(stack, ["ps", "--all", "--format", "json"]),
          logs: compose(stack, [
            "logs",
            "--no-color",
            "--tail=100",
            "celld",
            "bootstrap",
          ]),
          native,
          snapshot,
          trace,
        });
      }
    }
  }
);

for (const action of ["fail", "delay"] as const) {
  test(
    action === "fail"
      ? "native admission survives an after-admission checkpoint error"
      : "native admission continues after the caller deadline",
    { timeout: 360_000 },
    async () => {
      const stack = await newStack(`admission-${action}`);
      const address = addressFor(
        `company-admission-${action}`,
        "conversation-1"
      );
      let passed = false;
      try {
        boot(stack);
        await inspect(stack, address);
        await request(stack, "/runtime/fixture/checkpoint", {
          address,
          checkpoint: {
            action,
            boundary: "after-admission",
            delayMs: action === "delay" ? 5000 : 0,
          },
        });
        const event = messageEvent(address, `admission-${action}-event`);
        const startedAt = Date.now();
        const response = await rawRequest(stack, "/runtime/submit", {
          address,
          command: { event, mode: "follow-up", type: "submit" },
          options: {
            ...effectOptions(`admission-${action}-command`),
            deadlineAt: startedAt + (action === "delay" ? 1500 : 60_000),
          },
        });
        const respondedAt = Date.now();
        const failure: unknown = await response.json();
        assert.equal(response.status, 503);
        assert.ok(failure && typeof failure === "object");
        assert.ok("error" in failure && failure.error === "Unavailable");
        assert.ok("message" in failure && typeof failure.message === "string");
        assert.equal(
          failure.message,
          action === "fail"
            ? "Injected fixture checkpoint failure at after-admission"
            : "Caller deadline exceeded"
        );
        const checkpoint = await waitFor(
          () =>
            request<CheckpointEvidence>(stack, "/runtime/fixture/checkpoint", {
              address,
            }),
          (value) =>
            value.observations.some(
              (entry) =>
                entry.status === (action === "fail" ? "failed" : "returned")
            )
        );
        const entered = checkpoint.observations.find(
          (entry) => entry.status === "entered"
        );
        const settled = checkpoint.observations.find(
          (entry) =>
            entry.status === (action === "fail" ? "failed" : "returned")
        );
        assert.ok(entered);
        assert.ok(settled);
        assert.equal(entered.operation_id, `run:${event.eventId}`);
        assert.equal(checkpoint.control, null);
        if (action === "delay") {
          assert.ok(entered.at < respondedAt);
          assert.ok(respondedAt < settled.at);
        }
        const before = await waitFor(
          () => getFixture<ProviderEvidence>(stack),
          (value) => value.model.length === 1
        );
        assert.equal(before.tools.length, 0);
        const approval = await pending(stack, address);
        const native = await request<NativeWork>(
          stack,
          "/runtime/fixture/native-storage",
          { address }
        );
        assert.equal(native.submissions.length, 1);
        const nativeRequestId = native.submissions[0]?.request_id;
        assert.ok(nativeRequestId);
        assert.equal(JSON.parse(nativeRequestId), event.eventId);
        const replay = await submit(stack, event);
        assert.equal(replay.runId, approval.runId);
        assert.equal(replay.replayed, true);
        await approve(stack, address, approval);
        const completed = await waitFor(
          () => inspect(stack, address),
          (value) => value.runs[0]?.state === "completed",
          120_000
        );
        const provider = await getFixture<ProviderEvidence>(stack);
        assert.equal(completed.userMessages.length, 1);
        assert.equal(completed.outputs.length, 1);
        assert.equal(completed.tools[0]?.state, "succeeded");
        assert.equal(provider.tools.length, 1);
        await evidence(stack, `admission-${action}`, {
          before,
          checkpoint,
          completed,
          failure,
          native,
          provider,
          replay,
          respondedAt,
          startedAt,
        });
        passed = true;
      } finally {
        if (passed) {
          compose(stack, ["down", "-v"]);
        } else {
          await evidence(stack, "failure", {
            checkpoint: await request(stack, "/runtime/fixture/checkpoint", {
              address,
            }).catch((error: unknown) => ({ diagnosticError: String(error) })),
            containers: compose(stack, ["ps", "--all", "--format", "json"]),
            logs: compose(stack, ["logs", "--no-color", "--tail=100", "celld"]),
          });
        }
      }
    }
  );
}
