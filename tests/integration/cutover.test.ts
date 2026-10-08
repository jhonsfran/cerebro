// oxlint-disable require-await -- In-memory control adapters expose the asynchronous command boundary.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  prepareCutover,
  restoreRetirementFence,
} from "../../deploy/cutover-core.mjs";
import { loadRecord, saveRecord } from "../../deploy/durable-record.mjs";

const fixture = () => {
  const events: string[] = [];
  let stopped = false;
  let phase: string | undefined;
  const retired = { engine: "pi-v1", phase: "retired" };
  const operations = {
    assertExecutionStopped: async () => {
      events.push("assert-stopped");
      assert.ok(stopped);
    },
    commitFence: async () => {
      events.push("fence");
      phase = "fenced";
      return { engine: "pi-v1", phase };
    },
    readFence: async () => (phase === "retired" ? retired : undefined),
    retireAndQuarantine: async () => {
      events.push("retire-and-quarantine");
      phase = "retired";
      return retired;
    },
    saveRetirement: async () => {
      events.push("save-retirement");
    },
    saveSnapshot: async () => {
      events.push("save-unresolved");
    },
    snapshotStores: async () => {
      events.push("snapshot-stores");
      assert.ok(stopped);
    },
    snapshotUnresolved: async () => {
      events.push("snapshot-unresolved");
      assert.equal(phase, "fenced");
      return [];
    },
    stopExecution: async () => {
      events.push("stop-execution");
      stopped = true;
    },
    verifyRetirement: async () => {
      events.push("verify-retirement");
      assert.equal(phase, "retired");
      assert.ok(stopped);
    },
  };
  return { events, operations, retired };
};

test("cutover fences all execution before snapshots and retires queues before it returns", async () => {
  const value = fixture();
  assert.deepEqual(await prepareCutover(value.operations), value.retired);
  assert.deepEqual(value.events, [
    "stop-execution",
    "assert-stopped",
    "fence",
    "snapshot-unresolved",
    "save-unresolved",
    "snapshot-stores",
    "assert-stopped",
    "retire-and-quarantine",
    "save-retirement",
  ]);
});
test("a failed execution fence prevents all snapshots and retirement", async () => {
  const value = fixture();
  value.operations.assertExecutionStopped = async () => {
    throw new Error("Old worker remains active");
  };
  await assert.rejects(prepareCutover(value.operations), /Old worker/u);
  assert.deepEqual(value.events, ["stop-execution"]);
});
test("a failed store snapshot leaves the fence in place and does not enable Pi", async () => {
  const value = fixture();
  value.operations.snapshotStores = async () => {
    throw new Error("Snapshot failed");
  };
  await assert.rejects(prepareCutover(value.operations), /Snapshot failed/u);
  assert.equal(value.events.includes("fence"), true);
  assert.equal(value.events.includes("retire-and-quarantine"), false);
});
test("a completed one-time cutover is not repeated", async () => {
  const value = fixture();
  await prepareCutover(value.operations);
  const count = value.events.length;
  await prepareCutover(value.operations);
  assert.deepEqual(value.events.slice(count), [
    "stop-execution",
    "assert-stopped",
    "verify-retirement",
  ]);
});
test("restored old stores must keep execution stopped while retirement is reapplied", async () => {
  const value = fixture();
  await value.operations.stopExecution();
  value.events.length = 0;
  await restoreRetirementFence(value.operations, value.retired);
  assert.deepEqual(value.events, [
    "assert-stopped",
    "retire-and-quarantine",
    "assert-stopped",
  ]);
});
test("an incomplete retirement record cannot enable restored work", async () => {
  const value = fixture();
  await assert.rejects(
    restoreRetirementFence(value.operations, {
      engine: "pi-v1",
      phase: "fenced",
    }),
    /completed Pi retirement/u
  );
  assert.deepEqual(value.events, []);
});

test("a completed record cannot bypass the restored-store execution fence", async () => {
  const value = fixture();
  await prepareCutover(value.operations);
  value.operations.verifyRetirement = async () => {
    throw new Error("Stores were restored before retirement");
  };
  await assert.rejects(
    prepareCutover(value.operations),
    /Stores were restored/u
  );
});

test("a completed retirement record is one durable checksum envelope and detects tampering", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cerebro-retirement-")
  );
  const filename = path.join(directory, "retirement.json");
  try {
    const record = {
      engine: "pi-v1",
      phase: "retired",
      project: "local-fixture",
    };
    await saveRecord(filename, record);
    assert.deepEqual(await loadRecord(filename), record);
    const envelope = JSON.parse(await readFile(filename, "utf-8"));
    envelope.record.phase = "fenced";
    await writeFile(filename, JSON.stringify(envelope));
    await assert.rejects(loadRecord(filename), /checksum mismatch/u);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
