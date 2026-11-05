import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createModels } from "../../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js";
import {
  Harness,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  createRegistry,
} from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import type { Harness as PiHarness } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/index.js";
import { openNodeSqliteStorage } from "../../packages/runtime/node_modules/@earendil-works/pi-durable/dist/storage/sqlite/node.js";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import { createTeamAdmission } from "../../packages/runtime/src/team-admission.ts";
import { TeamState } from "../../packages/runtime/src/team-state.ts";
import { drainTerminalTeam } from "../../packages/runtime/src/team-terminal.ts";
import { waitFor } from "./helpers.ts";

const context = piContext();
const open = async (file: string) => {
  const registry = createRegistry();
  const pi = await Harness.open(
    await openNodeSqliteStorage(file),
    { models: createModels(), registry, settings: { extensions: [] } },
    context
  );
  const state = await pi.snapshot(TeamState, context);
  assert.ok(state?.admission);
  registry.install({
    name: "cerebro-team-admission",
    tasks: [
      createTeamAdmission({
        pi,
        work: state.admission,
        now: Date.now,
        deliver: () =>
          Promise.reject(
            new Error("Terminal admission delivery must not execute.")
          ),
      }),
    ],
  });
  return pi;
};
const retained = async (pi: PiHarness) => {
  const state = await pi.snapshot(TeamState, context);
  assert.ok(state?.lead);
  const native = await pi.conversation(state.lead, context);
  assert.ok(native);
  const entries = await native.entries(
    { order: "ascending" },
    128,
    undefined,
    context
  );
  assert.equal(entries.next, undefined);
  const tasks = await pi.commit((tx) => tx.scanTasks({}, 128), context);
  assert.equal(tasks.next, undefined);
  return {
    state,
    entries: entries.items,
    tasks: tasks.items,
    usage: await pi.snapshot(UsageDoc, state.lead, context),
    inbox: await pi.snapshot(InboxDoc, state.lead, context),
    live: await pi.snapshot(LiveDoc, state.lead, context),
  };
};

for (const scenario of ["generation", "tool", "admission"] as const) {
  test(
    `terminal ${scenario} drains after SIGKILL without its model or tool definitions`,
    { timeout: 20_000 },
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "team-terminal-"));
      const fixture = path.resolve("tests/runtime/team-terminal-fixture.ts");
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", fixture, directory, scenario],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      let errors = "";
      child.stderr.on("data", (bytes: Buffer) => {
        errors += bytes.toString();
      });
      let pi: PiHarness | undefined;
      try {
        await waitFor(
          () => {
            assert.equal(child.exitCode, null, errors);
            return existsSync(path.join(directory, "ready.json"));
          },
          (ready) => ready,
          10_000
        );
        const exited = once(child, "exit");
        assert.equal(child.kill("SIGKILL"), true);
        await exited;
        assert.equal(child.signalCode, "SIGKILL");
        const physical = readFileSync(
          path.join(directory, "physical.log"),
          "utf-8"
        );
        pi = await open(path.join(directory, "state.sqlite"));
        const inspection = await pi.inspect(context);
        assert.equal(inspection.scheduling, "paused");
        const before = await retained(pi);
        assert.ok(
          before.tasks.some((task) => task.state.status !== "terminal")
        );
        assert.equal(
          before.inbox?.items.length,
          scenario === "admission" ? 0 : 2
        );
        await drainTerminalTeam(pi);
        const drained = await retained(pi);
        const pending = new Set(
          before.tasks
            .filter((task) => task.state.status !== "terminal")
            .map((task) => task.id)
        );
        assert.ok(
          drained.tasks.every((task) => task.state.status === "terminal")
        );
        assert.ok(
          drained.tasks
            .filter((task) => pending.has(task.id))
            .every(
              (task) =>
                task.state.status === "terminal" &&
                task.state.outcome.status === "aborted"
            )
        );
        assert.deepEqual(
          drained.tasks.map((task) => task.id),
          before.tasks.map((task) => task.id)
        );
        assert.deepEqual(drained.state.report, before.state.report);
        assert.equal(drained.state.modelCalls, before.state.modelCalls);
        assert.deepEqual(drained.state.pending, {});
        assert.equal(drained.inbox?.items.length ?? 0, 0);
        assert.equal(drained.live?.run, undefined);
        assert.equal(
          JSON.stringify(drained.entries).includes(
            "Queued steer must not execute"
          ),
          false
        );
        assert.equal(
          JSON.stringify(drained.entries).includes(
            "Queued follow-up must not execute"
          ),
          false
        );
        assert.deepEqual(
          drained.entries.slice(0, before.entries.length),
          before.entries
        );
        assert.equal(
          readFileSync(path.join(directory, "physical.log"), "utf-8"),
          physical
        );
        await drainTerminalTeam(pi);
        assert.deepEqual(await retained(pi), drained);
        await pi.close(context);
        pi = await open(path.join(directory, "state.sqlite"));
        await drainTerminalTeam(pi);
        assert.deepEqual(await retained(pi), drained);
        assert.equal(
          readFileSync(path.join(directory, "physical.log"), "utf-8"),
          physical
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
        await pi?.close(context);
        await rm(directory, { recursive: true });
      }
    }
  );
}
