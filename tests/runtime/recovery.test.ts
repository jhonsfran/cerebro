import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import type { ToolReceipt } from "../../packages/contracts/src/receipt-service.ts";
import type { DomainSnapshot } from "../../packages/contracts/src/session-service.ts";
import {
  addressFor,
  approve,
  boot,
  compose,
  control,
  effectOptions,
  evidence,
  getFixture,
  inspect,
  messageEvent,
  newStack,
  pending,
  rawRequest,
  reconcile,
  request,
  submit,
  waitFor,
} from "./helpers.ts";
import type { ProviderEvidence, Stack } from "./helpers.ts";

interface ProjectionDiagnostic {
  readonly tag: string;
  readonly code: string | null;
  readonly reasonSHA256: string;
}

interface LifecycleEvidence {
  readonly alarms: readonly { readonly at: number }[];
  readonly alarmAt: number | null;
  readonly jobs: readonly unknown[];
  readonly pending: readonly unknown[];
  readonly projectionFailure: ProjectionDiagnostic | null;
  readonly firstProjectionFailure: ProjectionDiagnostic | null;
}

interface PhysicalProjection {
  readonly scope: string;
  readonly epoch: string;
  readonly authorityEnabled: boolean;
  readonly snapshotSHA256: string;
  readonly runs: readonly { readonly runId: string; readonly state: string }[];
  readonly executions: DomainSnapshot["executions"];
  readonly outputs: readonly {
    readonly answerId: string;
    readonly executionId: string;
    readonly runIds: readonly string[];
    readonly textSHA256: string;
  }[];
  readonly handoffs: readonly {
    readonly runId: string;
    readonly engineAccepted: boolean;
    readonly acknowledged: boolean;
    readonly replaceStopped: boolean;
    readonly requestId: string;
  }[];
  readonly submissions: readonly {
    readonly id: number;
    readonly requestId: string | null;
    readonly status: string;
    readonly answer: number | null;
    readonly answerEntrySHA256: string | null;
  }[];
  readonly nativeSubmissionsSHA256: string;
  readonly jobs: readonly {
    readonly id: string;
    readonly fn: string;
    readonly running: number;
    readonly recovery_loop: number;
    readonly singleflight: number;
  }[];
  readonly alarms: readonly { readonly at: number }[];
  readonly checkpoints: readonly {
    readonly boundary: string;
    readonly operation_id: string;
    readonly status: string;
  }[];
  readonly traces: readonly {
    readonly phase: string;
    readonly status: string;
    readonly count: number;
  }[];
}

// This read-only process never opens the Durable Object or calls its HTTP port.
// Only identifiers, status, membership, counts, and hashes leave the container.
const physicalProjectionScript = String.raw`
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const root = "/var/lib/celld/state";
const sessionId = process.argv[1];
const values = [];
for (const scope of existsSync(root) ? readdirSync(root) : []) {
  if (!scope.startsWith("SessionAgent:")) continue;
  const ltx = join(root, scope, "ltx");
  if (!existsSync(ltx)) continue;
  for (const epoch of readdirSync(ltx)) {
    const file = join(ltx, epoch, "db.sqlite");
    if (!existsSync(file)) continue;
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      const table = (name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
      if (!table("cerebro_pi_session")) continue;
      const row = database.prepare("SELECT state FROM cerebro_pi_session WHERE id=1 AND json_extract(state, '$.snapshot.address.sessionId')=?").get(sessionId);
      if (!row) continue;
      const { snapshot, handoffs } = JSON.parse(row.state);
      const native = table("pi_submissions") ? database.prepare("SELECT id, request_id, status, record FROM pi_submissions ORDER BY id").all() : [];
      const submissions = native.filter((value) => JSON.parse(value.record).type === "input").map((value) => {
        const { answer, requestId } = JSON.parse(value.record);
        const entry = answer === undefined ? undefined : database.prepare("SELECT record FROM pi_entries WHERE id=?").get(answer);
        return { id: value.id, requestId: requestId ?? null, status: value.status, answer: answer ?? null, answerEntrySHA256: entry ? hash(entry.record) : null };
      });
      values.push({
        scope, epoch, snapshotSHA256: hash(JSON.stringify(snapshot)),
        authorityEnabled: Boolean(database.prepare("SELECT enabled FROM fixture_authority WHERE id=1").get()?.enabled),
        runs: snapshot.runs.map(({ runId, state }) => ({ runId, state })),
        executions: snapshot.executions,
        outputs: snapshot.outputs.map(({ answerId, executionId, runIds, text }) => ({ answerId, executionId, runIds, textSHA256: hash(text) })),
        handoffs: handoffs.map(({ submission, engineAccepted, acknowledged, replaceStopped }) => ({ runId: submission.runId, requestId: submission.requestId, engineAccepted, acknowledged, replaceStopped })),
        submissions, nativeSubmissionsSHA256: hash(JSON.stringify(native)),
        jobs: table("cf_agents_jobs") ? database.prepare("SELECT id, fn, running, recovery_loop, singleflight FROM cf_agents_jobs ORDER BY id").all() : [],
        alarms: table("fixture_alarm_evidence") ? database.prepare("SELECT at FROM fixture_alarm_evidence ORDER BY at").all() : [],
        checkpoints: table("fixture_checkpoint_observation") ? database.prepare("SELECT boundary, operation_id, status FROM fixture_checkpoint_observation ORDER BY seq").all() : [],
        traces: table("fixture_native_trace") ? database.prepare("SELECT phase, status, count(*) AS count FROM fixture_native_trace GROUP BY phase, status ORDER BY phase, status").all() : []
      });
    } finally { database.close(); }
  }
}
process.stdout.write(JSON.stringify(values));
`;

const physicalProjections = (
  stack: Stack,
  address: EventAddress
): readonly PhysicalProjection[] =>
  JSON.parse(
    compose(stack, [
      "exec",
      "-T",
      "celld",
      "node",
      "--no-warnings",
      "--input-type=module",
      "-e",
      physicalProjectionScript,
      address.sessionId,
    ])
  ) as readonly PhysicalProjection[];

const traceCount = (
  value: PhysicalProjection,
  phase: string,
  status = "start"
): number =>
  value.traces.find((trace) => trace.phase === phase && trace.status === status)
    ?.count ?? 0;

const projectionJob = (value: PhysicalProjection) =>
  value.jobs.find((job) => job.fn === "cerebro-projection");

const failureEvidence = async (
  stack: Stack,
  address: EventAddress
): Promise<void> => {
  const reads = await Promise.allSettled([
    Promise.resolve().then(() => physicalProjections(stack, address)),
    getFixture<ProviderEvidence>(stack),
  ]);
  await evidence(stack, "projection-failure", {
    physical: reads[0]?.status === "fulfilled" ? reads[0].value : null,
    provider: reads[1]?.status === "fulfilled" ? reads[1].value : null,
  });
};

test(
  "official alarm projects native DONE after SIGKILL before the first session HTTP request",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("projection-done", false, true);
    const address = addressFor("company-projection-done", "conversation-1");
    let passed = false;
    try {
      boot(stack);
      const receipt = await submit(
        stack,
        messageEvent(address, "projection-done-event")
      );
      const approval = await pending(stack, address);
      await request(stack, "/runtime/fixture/checkpoint", {
        address,
        checkpoint: {
          action: "delay",
          boundary: "before-projection",
          delayMs: 10_000,
        },
      });
      await approve(stack, address, approval);
      const before = await waitFor(
        () => physicalProjections(stack, address),
        (values) =>
          values.length > 0 &&
          values.every(
            (value) =>
              value.outputs.length === 0 &&
              value.submissions.length === 1 &&
              value.submissions[0]?.status === "done" &&
              value.checkpoints.some(
                (item) =>
                  item.boundary === "before-projection" &&
                  item.operation_id === receipt.runId &&
                  item.status === "entered"
              ) &&
              !value.checkpoints.some(
                (item) =>
                  item.boundary === "before-projection" &&
                  item.operation_id === receipt.runId &&
                  item.status === "returned"
              )
          )
      );
      const killedAt = Date.now();
      compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
      const [warm] = before;
      assert.ok(warm);
      const warmCheckpoint = warm.checkpoints.filter(
        (item) =>
          item.boundary === "before-projection" &&
          item.operation_id === receipt.runId
      );
      assert.ok(warmCheckpoint.some((item) => item.status === "entered"));
      assert.ok(warmCheckpoint.every((item) => item.status !== "returned"));
      assert.equal(warm.handoffs[0]?.engineAccepted, true);
      assert.equal(warm.handoffs[0]?.acknowledged, true);
      assert.equal(warm.submissions[0]?.requestId, "projection-done-event");
      assert.ok(warm.submissions[0]?.answer);
      assert.match(
        warm.submissions[0]?.answerEntrySHA256 ?? "",
        /^[a-f0-9]{64}$/u
      );
      assert.deepEqual(warm.executions, [
        { executionId: `execution:${receipt.runId}`, runIds: [receipt.runId] },
      ]);
      const job = projectionJob(warm);
      assert.ok(
        job,
        "Projection intent must be durable before native completion"
      );
      assert.equal(job.singleflight, 1);
      assert.equal(job.recovery_loop, 1);
      const providerBefore = await getFixture<ProviderEvidence>(stack);
      assert.equal(providerBefore.model.length, 2);
      assert.equal(providerBefore.tools.length, 1);
      assert.equal(providerBefore.tools[0]?.operationId, approval.operationId);
      assert.equal(providerBefore.tools[0]?.write, true);
      await evidence(stack, "projection-done-before-kill", {
        physical: before,
        provider: providerBefore,
        receipt,
      });
      const restartedAt = Date.now();
      compose(stack, ["up", "-d", "--wait", "celld"]);
      // The provider and physical SQLite are read without a session host request.
      const restored = await waitFor(
        () => physicalProjections(stack, address),
        (values) =>
          values.some(
            (value) =>
              value.outputs.length === 1 &&
              value.runs.every((run) => run.state === "completed") &&
              value.alarms.some((alarm) => alarm.at >= restartedAt)
          ),
        120_000
      );
      const cold = restored.find(
        (value) =>
          value.outputs.length === 1 &&
          value.alarms.some((alarm) => alarm.at >= restartedAt)
      );
      assert.ok(cold);
      const coldCheckpoint = cold.checkpoints.filter(
        (item) =>
          item.boundary === "before-projection" &&
          item.operation_id === receipt.runId
      );
      assert.deepEqual(coldCheckpoint, warmCheckpoint);
      assert.ok(coldCheckpoint.every((item) => item.status !== "returned"));
      const firstReadAt = Date.now();
      assert.ok(
        cold.alarms.some(
          (alarm) => alarm.at >= restartedAt && alarm.at < firstReadAt
        )
      );
      assert.deepEqual(cold.submissions, warm.submissions);
      assert.equal(cold.nativeSubmissionsSHA256, warm.nativeSubmissionsSHA256);
      assert.equal(
        traceCount(cold, "native.abort"),
        traceCount(warm, "native.abort")
      );
      assert.equal(
        traceCount(cold, "native.abortTask"),
        traceCount(warm, "native.abortTask")
      );
      assert.deepEqual(cold.executions, warm.executions);
      assert.equal(
        cold.outputs[0]?.answerId,
        JSON.stringify([
          address.organizationId,
          address.sessionId,
          warm.submissions[0]?.answer,
        ])
      );
      assert.deepEqual(cold.outputs[0]?.runIds, [receipt.runId]);
      assert.equal(cold.outputs[0]?.executionId, `execution:${receipt.runId}`);
      assert.equal(
        cold.outputs[0]?.textSHA256,
        createHash("sha256").update("Cerebro slice 1 completed.").digest("hex")
      );
      const providerAfter = await getFixture<ProviderEvidence>(stack);
      assert.deepEqual(providerAfter.model, providerBefore.model);
      assert.deepEqual(providerAfter.tools, providerBefore.tools);
      await evidence(stack, "projection-done-alarm-before-http", {
        firstReadAt,
        killedAt,
        physical: restored,
        provider: providerAfter,
        restartedAt,
      });
      const native = await request<{
        submissions: readonly {
          id: number;
          request_id: string;
          status: string;
        }[];
      }>(stack, "/runtime/fixture/native-storage", { address });
      assert.equal(native.submissions.length, 1);
      assert.equal(native.submissions[0]?.status, "done");
      assert.equal(native.submissions[0]?.id, warm.submissions[0]?.id);
      const lifecycle = await request<LifecycleEvidence>(
        stack,
        "/runtime/fixture/lifecycle",
        { address }
      );
      assert.equal(lifecycle.projectionFailure, null);
      assert.equal(lifecycle.firstProjectionFailure, null);
      const snapshot = await inspect(stack, address);
      assert.equal(
        createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
        cold.snapshotSHA256
      );
      assert.deepEqual(snapshot.executions, warm.executions);
      assert.equal(snapshot.outputs.length, 1);
      assert.ok(snapshot.runs.every((run) => run.state === "completed"));
      passed = true;
    } finally {
      if (passed) {
        compose(stack, ["down", "-v"]);
      } else {
        await failureEvidence(stack, address);
      }
    }
  }
);

test(
  "injected Unavailable then Denied preserves first and active diagnostics and blocks cold automatic projection",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("projection-block", false, true);
    const address = addressFor("company-projection-block", "conversation-1");
    let passed = false;
    try {
      boot(stack);
      await submit(stack, messageEvent(address, "projection-block-event"));
      const approval = await pending(stack, address);
      await request(stack, "/runtime/fixture/checkpoint", {
        address,
        checkpoint: { action: "fail", boundary: "before-projection" },
      });
      await approve(stack, address, approval);
      const transient = await waitFor(
        () =>
          request<LifecycleEvidence>(stack, "/runtime/fixture/lifecycle", {
            address,
          }),
        (value) => value.firstProjectionFailure?.tag === "Unavailable"
      );
      assert.ok(transient.firstProjectionFailure);
      assert.equal(transient.firstProjectionFailure?.code, null);
      const reasonSHA256 = createHash("sha256")
        .update("Injected fixture checkpoint failure at before-projection")
        .digest("hex");
      assert.equal(transient.firstProjectionFailure.reasonSHA256, reasonSHA256);
      await request(stack, "/runtime/fixture/checkpoint", {
        address,
        checkpoint: {
          action: "fail",
          boundary: "before-projection",
          failureTag: "Denied",
        },
      });
      const blocked = await waitFor(
        () =>
          request<LifecycleEvidence>(stack, "/runtime/fixture/lifecycle", {
            address,
          }),
        (value) => value.projectionFailure?.tag === "Denied"
      );
      assert.deepEqual(
        blocked.firstProjectionFailure,
        transient.firstProjectionFailure
      );
      assert.deepEqual(blocked.projectionFailure, {
        code: "revoked",
        reasonSHA256,
        tag: "Denied",
      });
      const terminal = await waitFor(
        () => physicalProjections(stack, address),
        (values) =>
          values.length > 0 &&
          values.every(
            (value) =>
              value.outputs.length === 0 &&
              value.submissions[0]?.status === "done" &&
              value.checkpoints.filter((item) => item.status === "failed")
                .length === 2 &&
              !projectionJob(value)
          )
      );
      const [warm] = terminal;
      assert.ok(warm);
      assert.equal(warm.submissions.length, 1);
      const providerBefore = await getFixture<ProviderEvidence>(stack);
      assert.equal(providerBefore.model.length, 2);
      assert.equal(providerBefore.tools.length, 1);
      await evidence(stack, "projection-block-before-kill", {
        firstProjectionFailure: blocked.firstProjectionFailure,
        physical: terminal,
        projectionFailure: blocked.projectionFailure,
        provider: providerBefore,
      });
      compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
      const restartedAt = Date.now();
      compose(stack, ["up", "-d", "--wait", "celld"]);
      // A blocked actor need not have an alarm. The first read below forces cold
      // initialization without an explicit recovery command.
      await delay(6000);
      const beforeFirstRead = physicalProjections(stack, address);
      assert.ok(beforeFirstRead.length);
      assert.ok(beforeFirstRead.every((value) => value.outputs.length === 0));
      const firstReadAt = Date.now();
      const cold = await request<LifecycleEvidence>(
        stack,
        "/runtime/fixture/lifecycle",
        { address }
      );
      assert.deepEqual(
        cold.firstProjectionFailure,
        transient.firstProjectionFailure
      );
      assert.deepEqual(cold.projectionFailure, blocked.projectionFailure);
      await delay(6000);
      const afterColdRead = physicalProjections(stack, address);
      for (const value of afterColdRead) {
        assert.equal(value.outputs.length, 0);
        assert.equal(value.snapshotSHA256, warm.snapshotSHA256);
        assert.deepEqual(value.submissions, warm.submissions);
        assert.equal(
          value.nativeSubmissionsSHA256,
          warm.nativeSubmissionsSHA256
        );
        assert.deepEqual(value.checkpoints, warm.checkpoints);
        assert.equal(
          traceCount(value, "native.events"),
          traceCount(warm, "native.events")
        );
        assert.equal(
          traceCount(value, "native.abort"),
          traceCount(warm, "native.abort")
        );
        assert.equal(
          traceCount(value, "native.abortTask"),
          traceCount(warm, "native.abortTask")
        );
        assert.equal(projectionJob(value), undefined);
      }
      const providerAfter = await getFixture<ProviderEvidence>(stack);
      assert.deepEqual(providerAfter.model, providerBefore.model);
      assert.deepEqual(providerAfter.tools, providerBefore.tools);
      await evidence(stack, "projection-block-cold", {
        afterColdRead,
        beforeFirstRead,
        firstProjectionFailure: cold.firstProjectionFailure,
        firstReadAt,
        projectionFailure: cold.projectionFailure,
        provider: providerAfter,
        restartedAt,
      });
      passed = true;
    } finally {
      if (passed) {
        compose(stack, ["down", "-v"]);
      } else {
        await failureEvidence(stack, address);
      }
    }
  }
);

test(
  "replacement interrupted after Stop and before native acceptance resumes the same request once",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("replace-before-accept", false, true);
    const address = addressFor(
      "company-replace-before-accept",
      "conversation-1"
    );
    const replacementEvent = messageEvent(address, "replacement-event");
    let passed = false;
    try {
      boot(stack);
      const active = await submit(stack, messageEvent(address, "active-event"));
      const oldApproval = await pending(stack, address);
      const queued = await submit(stack, messageEvent(address, "queued-event"));
      const beforeProvider = await getFixture<ProviderEvidence>(stack);
      assert.equal(beforeProvider.model.length, 1);
      assert.equal(beforeProvider.tools.length, 0);
      await request(stack, "/runtime/fixture/checkpoint", {
        address,
        checkpoint: {
          action: "delay",
          boundary: "before-engine-submission",
          delayMs: 10_000,
        },
      });
      // One HTTP attempt has a rejection outcome handler from its creation.
      // A transport loss cannot issue another request during the cold proof.
      const interruptedResponse = (async () => {
        try {
          const response = await fetch(
            `http://127.0.0.1:${stack.apiPort}/runtime/submit`,
            {
              body: JSON.stringify({
                address,
                command: {
                  event: replacementEvent,
                  mode: "replace",
                  type: "submit",
                },
                options: effectOptions(replacementEvent.eventId),
              }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
              signal: AbortSignal.timeout(30_000),
            }
          );
          return {
            bodySHA256: createHash("sha256")
              .update(await response.text())
              .digest("hex"),
            kind: "response" as const,
            status: response.status,
          };
        } catch (error) {
          return {
            kind: "transport" as const,
            name: error instanceof Error ? error.name : "unknown",
          };
        }
      })();
      const before = await waitFor(
        () => physicalProjections(stack, address),
        (values) =>
          values.some((value) => {
            const handoff = value.handoffs.find(
              (item) => item.requestId === replacementEvent.eventId
            );
            return Boolean(
              handoff?.replaceStopped &&
              !handoff.engineAccepted &&
              !handoff.acknowledged &&
              value.submissions.length === 2 &&
              value.submissions.every((item) => item.status === "unanswered") &&
              value.checkpoints.some(
                (item) =>
                  item.boundary === "before-engine-submission" &&
                  item.operation_id === handoff.runId &&
                  item.status === "entered"
              ) &&
              !value.checkpoints.some(
                (item) =>
                  item.boundary === "before-engine-submission" &&
                  item.operation_id === handoff.runId &&
                  item.status === "returned"
              )
            );
          })
      );
      compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
      const warm = before.find((value) => {
        const handoff = value.handoffs.find(
          (item) => item.requestId === replacementEvent.eventId
        );
        return Boolean(
          handoff?.replaceStopped &&
          !handoff.engineAccepted &&
          !handoff.acknowledged &&
          value.checkpoints.some(
            (item) =>
              item.boundary === "before-engine-submission" &&
              item.operation_id === handoff.runId &&
              item.status === "entered"
          ) &&
          !value.checkpoints.some(
            (item) =>
              item.boundary === "before-engine-submission" &&
              item.operation_id === handoff.runId &&
              item.status === "returned"
          )
        );
      });
      assert.ok(warm);
      const retained = warm.handoffs.find(
        (item) => item.requestId === replacementEvent.eventId
      );
      assert.ok(retained);
      const warmCheckpoint = warm.checkpoints.filter(
        (item) =>
          item.boundary === "before-engine-submission" &&
          item.operation_id === retained.runId
      );
      assert.ok(warmCheckpoint.some((item) => item.status === "entered"));
      assert.ok(warmCheckpoint.every((item) => item.status !== "returned"));
      assert.equal(warm.authorityEnabled, true);
      assert.equal(traceCount(warm, "native.abort"), 1);
      assert.ok(projectionJob(warm));
      for (const receipt of [active, queued]) {
        assert.equal(
          warm.runs.find((run) => run.runId === receipt.runId)?.state,
          "cancelled"
        );
      }
      assert.equal(warm.outputs.length, 0);
      const stoppedProvider = await getFixture<ProviderEvidence>(stack);
      assert.deepEqual(stoppedProvider.model, beforeProvider.model);
      assert.deepEqual(stoppedProvider.tools, beforeProvider.tools);
      await evidence(stack, "replacement-before-kill", {
        active,
        physical: before,
        provider: stoppedProvider,
        queued,
        retained,
      });
      const responseOutcome = await interruptedResponse;
      assert.ok(
        responseOutcome.kind !== "response" || responseOutcome.status !== 200
      );
      const restartedAt = Date.now();
      compose(stack, ["up", "-d", "--wait", "celld"]);
      const recovered = await waitFor(
        () => physicalProjections(stack, address),
        (values) =>
          values.some((value) => {
            const handoff = value.handoffs.find(
              (item) => item.runId === retained.runId
            );
            return Boolean(
              handoff?.engineAccepted &&
              handoff.acknowledged &&
              value.submissions.filter(
                (item) => item.requestId === retained.requestId
              ).length === 1 &&
              value.runs.some(
                (run) =>
                  run.runId === retained.runId &&
                  run.state === "waiting-for-approval"
              ) &&
              value.alarms.some((alarm) => alarm.at >= restartedAt)
            );
          }),
        120_000
      );
      const cold = recovered.find((value) =>
        value.handoffs.some(
          (item) => item.runId === retained.runId && item.engineAccepted
        )
      );
      assert.ok(cold);
      const coldCheckpoint = cold.checkpoints.filter(
        (item) =>
          item.boundary === "before-engine-submission" &&
          item.operation_id === retained.runId
      );
      assert.deepEqual(coldCheckpoint, warmCheckpoint);
      assert.ok(coldCheckpoint.every((item) => item.status !== "returned"));
      assert.equal(cold.authorityEnabled, true);
      const firstReadAt = Date.now();
      assert.ok(
        cold.alarms.some(
          (alarm) => alarm.at >= restartedAt && alarm.at < firstReadAt
        )
      );
      assert.equal(cold.submissions.length, 3);
      assert.deepEqual(
        cold.submissions.filter(
          (item) => item.requestId !== retained.requestId
        ),
        warm.submissions
      );
      assert.equal(traceCount(cold, "native.abort"), 1);
      assert.equal(
        traceCount(cold, "native.abortTask"),
        traceCount(warm, "native.abortTask")
      );
      const coldProvider = await getFixture<ProviderEvidence>(stack);
      assert.equal(coldProvider.model.length, 2);
      assert.equal(
        coldProvider.model.filter((item) => item.operationId === retained.runId)
          .length,
        1
      );
      assert.equal(coldProvider.tools.length, 0);
      await evidence(stack, "replacement-alarm-before-http", {
        firstReadAt,
        physical: recovered,
        provider: coldProvider,
        responseOutcome,
        restartedAt,
      });
      const snapshot = await inspect(stack, address);
      assert.equal(
        snapshot.approvals.find(
          (item) => item.approvalId === oldApproval.approvalId
        )?.state,
        "cancelled"
      );
      const replay = await submit(
        stack,
        replacementEvent,
        replacementEvent.eventId,
        "replace"
      );
      assert.equal(replay.runId, retained.runId);
      assert.equal(replay.acceptedEventId, retained.requestId);
      assert.equal(replay.replayed, true);
      assert.deepEqual(
        await submit(
          stack,
          replacementEvent,
          replacementEvent.eventId,
          "replace"
        ),
        replay
      );
      const afterReplay = await getFixture<ProviderEvidence>(stack);
      assert.deepEqual(afterReplay.model, coldProvider.model);
      assert.deepEqual(afterReplay.tools, coldProvider.tools);
      const approval = snapshot.approvals.find(
        (item) => item.runId === retained.runId && item.state === "pending"
      );
      assert.ok(approval);
      await approve(stack, address, approval);
      const completed = await waitFor(
        () => inspect(stack, address),
        (value) =>
          value.runs.find((run) => run.runId === retained.runId)?.state ===
          "completed"
      );
      assert.equal(completed.outputs.length, 1);
      assert.deepEqual(completed.outputs[0]?.runIds, [retained.runId]);
      assert.ok(
        completed.executions.some(
          (item) =>
            item.executionId === completed.outputs[0]?.executionId &&
            item.runIds.length === 1 &&
            item.runIds[0] === retained.runId
        )
      );
      const provider = await getFixture<ProviderEvidence>(stack);
      assert.equal(provider.model.length, 3);
      assert.equal(
        provider.model.filter((item) => item.operationId === retained.runId)
          .length,
        2
      );
      assert.equal(provider.tools.length, 1);
      assert.equal(provider.tools[0]?.operationId, approval.operationId);
      assert.equal(provider.tools[0]?.write, true);
      assert.deepEqual(
        await submit(
          stack,
          replacementEvent,
          replacementEvent.eventId,
          "replace"
        ),
        replay
      );
      const finalProvider = await getFixture<ProviderEvidence>(stack);
      assert.deepEqual(finalProvider.model, provider.model);
      assert.deepEqual(finalProvider.tools, provider.tools);
      const finalPhysical = physicalProjections(stack, address).find(
        (value) => value.outputs.length === 1
      );
      assert.ok(finalPhysical);
      assert.equal(traceCount(finalPhysical, "native.abort"), 1);
      assert.equal(
        finalPhysical.submissions.filter(
          (item) => item.requestId === retained.requestId
        ).length,
        1
      );
      await evidence(stack, "replacement-completed", {
        physical: finalPhysical,
        provider: finalProvider,
        replay,
      });
      passed = true;
    } finally {
      if (passed) {
        compose(stack, ["down", "-v"]);
      } else {
        await failureEvidence(stack, address);
      }
    }
  }
);

test(
  "a dispatched native write remains unknown across SIGKILL and reconciles without a second write",
  { timeout: 360_000 },
  async () => {
    const stack = await newStack("dispatch");
    const address = addressFor("company-dispatch", "conversation-1");
    let passed = false;
    try {
      boot(stack);
      await control(stack, {
        arm: { boundary: "after-tool-dispatch", id: "native-dispatch" },
      });
      await submit(stack, messageEvent(address, "dispatch-event"));
      const approval = await pending(stack, address);
      await approve(stack, address, approval);
      const dispatched = await waitFor(
        () => getFixture<ProviderEvidence>(stack),
        (value) =>
          value.held === 1 &&
          value.tools.some((tool) => tool.operationId === approval.operationId)
      );
      const durable = await request<ToolReceipt>(
        stack,
        "/runtime/fixture/receipt",
        { address, operationId: approval.operationId }
      );
      assert.equal(durable.state, "dispatched");
      const beforeLifecycle = await request<LifecycleEvidence>(
        stack,
        "/runtime/fixture/lifecycle",
        { address }
      );
      await evidence(stack, "before-kill", {
        approval,
        beforeLifecycle,
        dispatched,
        durable,
      });
      const killedAt = Date.now();
      compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
      await control(stack, { arm: null, release: true });
      const restartedAt = Date.now();
      compose(stack, ["up", "-d", "--wait", "celld"]);
      // No native host request is made during the documented cold-cell discovery window.
      await delay(90_000);
      const firstReadAt = Date.now();
      const lifecycle = await request<LifecycleEvidence>(
        stack,
        "/runtime/fixture/lifecycle",
        { address }
      );
      await evidence(stack, "alarm-observation", {
        beforeLifecycle,
        firstReadAt,
        killedAt,
        lifecycle,
        restartedAt,
      });
      assert.ok(
        lifecycle.alarms.some(
          (alarm) => alarm.at >= restartedAt && alarm.at < firstReadAt
        ),
        "Official Lifecycle must run its alarm while every observer is closed"
      );
      const wakeAt = lifecycle.alarms.find(
        (alarm) => alarm.at >= restartedAt && alarm.at < firstReadAt
      )?.at;
      assert.ok(wakeAt);
      const wakeMs = wakeAt - restartedAt;
      await evidence(stack, "alarm-wake", {
        firstReadAt,
        lifecycle,
        meetsPerformanceBudget: wakeMs <= 60_000,
        restartedAt,
        wakeMs,
      });
      assert.ok(
        wakeMs <= 60_000,
        `Selected celld host must recover within 60 seconds; actual wake ${wakeMs} ms`
      );
      const unknown = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "unknown-outcome",
        120_000
      );
      const blocked = await rawRequest(stack, "/runtime/submit", {
        address,
        command: {
          event: messageEvent(address, "blocked-event"),
          mode: "follow-up",
          type: "submit",
        },
        options: {
          deadlineAt: Date.now() + 60_000,
          operationId: "blocked-command",
          requestDigest: "sha256:blocked",
        },
      });
      assert.equal(blocked.status, 409);
      await request(stack, "/runtime/fixture/evidence", {
        address,
        enabled: false,
      });
      const unavailable = await rawRequest(stack, "/runtime/reconcile", {
        address,
        command: { operationId: approval.operationId, runId: approval.runId },
        options: {
          deadlineAt: Date.now() + 60_000,
          operationId: "unavailable-reconcile",
          requestDigest: "sha256:unavailable-reconcile",
        },
      });
      assert.equal(unavailable.status, 503);
      const repeated = await rawRequest(stack, "/runtime/fixture/occurrence", {
        address,
        operationId: approval.operationId,
        replacementOperationId: "new-uncertain-occurrence",
      });
      assert.equal(repeated.status, 409);
      await request(stack, "/runtime/fixture/evidence", {
        address,
        enabled: true,
      });
      const reconciled = await reconcile(stack, address, approval);
      const confirmed = await request<ToolReceipt>(
        stack,
        "/runtime/fixture/receipt",
        { address, operationId: approval.operationId }
      );
      assert.equal(confirmed.state, "completed");
      const final = await waitFor(
        () => inspect(stack, address),
        (value) => value.runs[0]?.state === "completed",
        120_000
      );
      assert.equal(final.tools[0]?.state, "succeeded");
      assert.equal(final.outputs.length, 1);
      const provider = await getFixture<ProviderEvidence>(stack);
      assert.equal(
        provider.tools.filter(
          (value) => value.operationId === approval.operationId
        ).length,
        1
      );
      await evidence(stack, "dispatch-restart", {
        approval,
        confirmed,
        dispatched,
        durable,
        final,
        firstReadAt,
        lifecycle,
        provider,
        reconciled,
        restartedAt,
        unknown,
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
