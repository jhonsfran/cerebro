import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";

import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import {
  CoordinationProfileSchema,
  TeamCommandSchema,
  TeamReportDeliverySchema,
  WorkAdmissionSchema,
} from "../../packages/contracts/src/work.ts";
import type {
  TeamCommand,
  TeamReportDelivery,
} from "../../packages/contracts/src/work.ts";
import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { createCoordinatorDispatch } from "../../packages/runtime/src/coordinator-dispatch.ts";
import {
  CommandReceipts,
  WorkDocuments,
  WorkLedger,
  coordinatorOperationKey,
} from "../../packages/runtime/src/coordinator-ledger.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { createTeamAdmission } from "../../packages/runtime/src/team-admission.ts";
import {
  createTeamReportOutbox,
  TeamReportOutbox,
} from "../../packages/runtime/src/team-report-outbox.ts";
import {
  requireTeamAdmission,
  TeamCommandReceipts,
  TeamState,
} from "../../packages/runtime/src/team-state.ts";

const context = piContext();
const legacyJson =
  '{"admittedAt":1800000000000,"contentDependencies":{"sourceIds":[],"toolIds":[]},"deadlineAt":1800000600000,"goal":"Compare the two deployment reports.","key":{"organizationId":"org-A","ownerPrincipalId":"owner-A","workId":"work-A"},"lead":{"agentId":"lead-A","agentVersion":4},"limits":{"maxTeams":2,"maxTurns":8,"maxWorkers":2,"timeoutMs":600000},"sourceEventAddress":{"agentId":"coordinator-A","conversationId":"conversation-A","organizationId":"org-A","sessionId":"session-A"},"sourceSlackThread":{"channelId":"D123","rootTimestamp":"1800000000.000001","workspaceId":"T123"},"worker":{"agentId":"worker-A","agentVersion":7}}';
const work = Schema.decodeUnknownSync(WorkAdmissionSchema, {
  onExcessProperty: "error",
})(JSON.parse(legacyJson));
const commands = [
  {
    json: `{"id":"start-A","kind":"start","work":${legacyJson}}`,
    digest: "5c01c90edd222791ee32f193200db5d5e2a0c2d3b91572638a97391cdd5eed71",
  },
  {
    json: `{"id":"input-A","kind":"input","contentDependencies":{"sourceIds":[],"toolIds":[]},"text":"Include the outage.","work":${legacyJson}}`,
    digest: "aa1008cc55f03bc0c1e0cc850ec6a6258f3c3acc8e2490c7eeff48c8113ad28d",
  },
  {
    json: `{"id":"cancel-A","kind":"cancel","work":${legacyJson}}`,
    digest: "ce06c5028c5e5d6912c4fce9fcd1438204c2d475b7342721939942b9ab38b399",
  },
];
const decodeCommand = Schema.decodeUnknownSync(TeamCommandSchema, {
  onExcessProperty: "error",
});
const open = async (file: string) => {
  const registry = createRegistry();
  const pi = await Harness.open(
    await openNodeSqliteStorage(file),
    {
      models: createModels(),
      registry,
      settings: { extensions: [] },
    },
    context
  );
  return { pi, registry, root: await pi.root(context) };
};

test("literal old pending dispatches reopen with their original stringify digests and payloads", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legacy-dispatch-"));
  const file = path.join(directory, "source.sqlite");
  const sent: TeamCommand[] = [];
  const binding = {
    address: work.sourceEventAddress,
    ownerPrincipalId: work.key.ownerPrincipalId,
  };
  const create = async () => {
    const host = await open(file);
    const dispatch = createCoordinatorDispatch({
      address: binding.address,
      nativeId: host.root.id,
      pi: host.pi,
      authorize: () => Promise.resolve(),
      binding: () => binding,
      now: () => 1_800_000_001_000,
      services: {
        ownerPrincipalId: binding.ownerPrincipalId,
        profile: Schema.decodeUnknownSync(CoordinationProfileSchema)({
          leadAgentId: "lead-A",
          workerAgentId: "worker-A",
        }),
        contentDependencies: () => Promise.resolve(work.contentDependencies),
        resolveRolePins: () =>
          Promise.resolve({ lead: work.lead, worker: work.worker }),
        sendCommand: (command) => {
          sent.push(command);
          return Promise.resolve();
        },
      },
    });
    host.registry.install({ name: "legacy-dispatch", tasks: [dispatch] });
    return { ...host, dispatch };
  };
  let host = await create();
  try {
    const tasks = await host.pi.commit(async (tx) => {
      const ledger = await tx.doc(WorkLedger);
      ledger.identity = {
        organizationId: work.key.organizationId,
        ownerPrincipalId: work.key.ownerPrincipalId,
      };
      ledger.active[work.key.workId] = {
        source: work.sourceEventAddress,
        deadlineAt: work.deadlineAt,
      };
      const document = await tx.doc(WorkDocuments, work.key.workId, null);
      document.record = {
        admission: JSON.parse(legacyJson),
        status: { kind: "accepted" },
        pendingCommands: {},
        reportId: null,
      };
      return await Promise.all(
        commands.map(async ({ json, digest }) => {
          const command = decodeCommand(JSON.parse(json));
          assert.equal(await coordinatorOperationKey(json), digest);
          const taskId = await tx.createTask(host.dispatch, command, {
            background: true,
            conversationId: host.root.id,
            ownership: { kind: "conversation" },
          });
          const receipt = { taskId, digest };
          const documentReceipt = await tx.doc(
            CommandReceipts,
            command.id,
            null
          );
          documentReceipt.receipt = receipt;
          document.record.pendingCommands[command.id] = receipt;
          return { taskId, command, json, digest };
        })
      );
    }, context);
    assert.equal(sent.length, 0);
    const pending = await Promise.all(
      tasks.map(({ taskId }) => host.pi.getTask(taskId, context))
    );
    assert.ok(pending.every((task) => task?.state.status === "pending"));
    await host.pi.close(context);
    host = await create();
    host.pi.resume();
    await Promise.all(
      tasks.map(({ taskId }) => host.pi.waitForTask(taskId, context))
    );
    assert.deepEqual(
      sent.map((command) => JSON.stringify(command)).toSorted(),
      commands.map(({ json }) => json).toSorted()
    );
    const retained = await host.pi.snapshot(
      WorkDocuments,
      work.key.workId,
      context
    );
    assert.equal(JSON.stringify(retained?.record?.admission), legacyJson);
    assert.deepEqual(retained?.record?.pendingCommands, {});
    await Promise.all(
      tasks.map(async (item) => {
        const receipt = await host.pi.snapshot(
          CommandReceipts,
          item.command.id,
          context
        );
        const task = await host.pi.getTask(item.taskId, context);
        assert.equal(receipt?.receipt?.digest, item.digest);
        assert.equal(JSON.stringify(task?.input), item.json);
      })
    );
    await host.pi.close(context);
    host = await create();
    host.pi.resume();
    await Promise.all(
      tasks.map(({ taskId }) => host.pi.waitForTask(taskId, context))
    );
    assert.equal(sent.length, 3);
  } finally {
    await host.pi.close(context);
    await rm(directory, { recursive: true });
  }
});

test("literal old admission tasks and command receipts resume from the same private team storage", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legacy-admission-"));
  const file = path.join(directory, "team.sqlite");
  const delivered: TeamCommand[] = [];
  const create = async () => {
    const host = await open(file);
    const admission = createTeamAdmission({
      pi: host.pi,
      work,
      now: () => 1_800_000_001_000,
      deliver: (command) => {
        delivered.push(command);
        return Promise.resolve();
      },
    });
    host.registry.install({
      name: "cerebro-team-admission",
      tasks: [admission],
    });
    return { ...host, admission };
  };
  let host = await create();
  try {
    const tasks = await host.pi.commit(async (tx) => {
      const state = await tx.doc(TeamState);
      state.admission = JSON.parse(legacyJson);
      state.phase = "running";
      state.lead = host.root.id;
      return await Promise.all(
        commands.slice(0, 2).map(async ({ json }) => {
          const command = decodeCommand(JSON.parse(json));
          const digest = await digestToolArguments(command);
          const taskId = await tx.createTask(host.admission, command, {
            background: true,
            conversationId: host.root.id,
            ownership: { kind: "conversation" },
          });
          const receipt = await tx.doc(TeamCommandReceipts, command.id, null);
          receipt.receipt = {
            digest,
            taskId,
            accepted: true,
            reason: null,
          };
          state.pending[command.id] = taskId;
          return { taskId, digest, command, json };
        })
      );
    }, context);
    assert.equal(delivered.length, 0);
    await host.pi.close(context);
    host = await create();
    host.pi.resume();
    await Promise.all(
      tasks.map(({ taskId }) => host.pi.waitForTask(taskId, context))
    );
    assert.deepEqual(
      delivered.map((command) => JSON.stringify(command)).toSorted(),
      tasks.map(({ json }) => json).toSorted()
    );
    const state = await host.pi.snapshot(TeamState, context);
    assert.ok(state);
    requireTeamAdmission(state, work);
    assert.equal(JSON.stringify(state.admission), legacyJson);
    assert.deepEqual(state.pending, {});
    await Promise.all(
      tasks.map(async (item) => {
        const receipt = await host.pi.snapshot(
          TeamCommandReceipts,
          item.command.id,
          context
        );
        assert.equal(receipt?.receipt?.digest, item.digest);
      })
    );
    await host.pi.close(context);
    host = await create();
    host.pi.resume();
    await Promise.all(
      tasks.map(({ taskId }) => host.pi.waitForTask(taskId, context))
    );
    assert.equal(delivered.length, 2);
  } finally {
    await host.pi.close(context);
    await rm(directory, { recursive: true });
  }
});

test("an old report outbox retains its payload, digest, task, and completed report across reopen", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "legacy-report-"));
  const file = path.join(directory, "team.sqlite");
  assert.ok("sourceSlackThread" in work);
  const delivery = Schema.decodeUnknownSync(TeamReportDeliverySchema, {
    onExcessProperty: "error",
  })({
    report: {
      contentDependencies: { sourceIds: [], toolIds: [] },
      id: "report-A",
      key: work.key,
      kind: "completed",
      text: "Retained team result.",
    },
    sourceEventAddress: work.sourceEventAddress,
    sourceSlackThread: work.sourceSlackThread,
  });
  const json = JSON.stringify(delivery);
  const digest = await digestToolArguments(delivery);
  const sent: TeamReportDelivery[] = [];
  const create = async () => {
    const host = await open(file);
    const outbox = createTeamReportOutbox({
      ...host,
      nativeId: host.root.id,
      persist: () => Promise.resolve(),
      waitUntil: () => {},
      transport: {
        prepare: () => delivery,
        send: (value) => {
          sent.push(value);
          return Promise.resolve();
        },
      },
    });
    return { ...host, outbox };
  };
  let host = await create();
  try {
    await host.pi.commit(async (tx) => {
      const state = await tx.doc(TeamState);
      state.admission = JSON.parse(legacyJson);
      state.phase = "completed";
      state.report = delivery.report;
      await host.outbox.enqueueIn(tx, delivery.report);
    }, context);
    const saved = await host.pi.snapshot(TeamReportOutbox, context);
    assert.ok(saved?.taskId);
    const { taskId } = saved;
    assert.equal(saved.digest, digest);
    const task = await host.pi.getTask(taskId, context);
    assert.equal(JSON.stringify(task?.input), json);
    assert.equal(sent.length, 0);
    await host.pi.close(context);
    host = await create();
    await host.outbox.wake();
    await host.pi.waitForTask(taskId, context);
    assert.equal(sent.length, 1);
    assert.equal(JSON.stringify(sent[0]), json);
    assert.deepEqual(await host.pi.snapshot(TeamReportOutbox, context), saved);
    const state = await host.pi.snapshot(TeamState, context);
    assert.deepEqual(state?.report, delivery.report);
    await host.pi.close(context);
    host = await create();
    await host.pi.commit(
      (tx) => host.outbox.enqueueIn(tx, delivery.report),
      context
    );
    await host.outbox.wake();
    await host.pi.waitForTask(taskId, context);
    assert.equal(sent.length, 1);
  } finally {
    await host.pi.close(context);
    await rm(directory, { recursive: true });
  }
});
