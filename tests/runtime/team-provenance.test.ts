import assert from "node:assert/strict";
import { test } from "node:test";

import { Effect, Result } from "effect";

import {
  Denied,
  InvalidInput,
  Unavailable,
} from "../../packages/contracts/src/failures.ts";
import { workStartOperationId } from "../../packages/contracts/src/work.ts";
import {
  importContentIn,
  readImportedContent,
  reconcileImportedContent,
} from "../../packages/runtime/src/imported-content.ts";
import { readTeamRoleImports } from "../../packages/runtime/src/team-content.ts";
import {
  TeamCommandReceipts,
  TeamState,
} from "../../packages/runtime/src/team-state.ts";
import {
  context,
  dependencies,
  empty,
  teamProvenanceFixture,
} from "./team-provenance-fixture.ts";

type Fixture = Awaited<ReturnType<typeof teamProvenanceFixture>>;
const start = (f: Fixture) => ({
  id: "start",
  kind: "start" as const,
  work: f.work,
});
const input = (f: Fixture, name: string) => ({
  id: name,
  kind: "input" as const,
  work: f.work,
  text: "A private follow-up.",
  contentDependencies: dependencies(name),
});
const settle = async (f: Fixture) => {
  const { state } = await f.read();
  await Promise.all(
    Object.values(state?.pending ?? {}).map((taskId) =>
      f.pi().waitForTask(taskId, context)
    )
  );
  if (state?.lead) {
    const native = await f.pi().conversation(state.lead, context);
    await native?.waitForIdle(context);
  }
};

test("the role reader resolves accepted native IDs and retained imports after reopen", async () => {
  const f = await teamProvenanceFixture();
  try {
    assert.deepEqual(await readTeamRoleImports(f.pi(), f.work, 0), empty());
    assert.deepEqual(await readTeamRoleImports(f.pi(), f.work, 1), empty());
    await assert.rejects(
      readTeamRoleImports(f.pi(), f.work, 2),
      (error: unknown) => error instanceof InvalidInput
    );
    const command = input(f, "initial");
    const receipt = await f.runtime().receive(command);
    assert.equal(receipt.kind, "accepted");
    await settle(f);
    const before = await f.read();
    assert.deepEqual(before.canonical, [command.contentDependencies, empty()]);
    assert.deepEqual(before.raw, before.canonical);
    assert.ok(before.state?.lead);
    await assert.rejects(
      readTeamRoleImports(
        f.pi(),
        { ...f.work, goal: "Another work admission." },
        0
      )
    );
    await f.reopen();
    const after = await f.read();
    assert.equal(after.state?.lead, before.state.lead);
    assert.deepEqual(after.canonical, before.canonical);
    assert.deepEqual(after.raw, before.raw);
  } finally {
    await f.close();
  }
});

test("failed command acceptance leaves no raw imports, canonical imports, or receipt on the same SQLite connection", async () => {
  const f = await teamProvenanceFixture();
  try {
    await f.runtime().receive(start(f));
    await settle(f);
    const before = await f.read();
    const command = input(f, "rejected");
    f.failAdmission();
    await assert.rejects(
      f.runtime().receive(command),
      /Injected admission callback failure/u
    );
    const after = await f.read();
    assert.deepEqual(after, before);
    assert.equal(
      await f.pi().snapshot(TeamCommandReceipts, command.id, context),
      undefined
    );
    f.denySource(command.contentDependencies.sourceIds[0]);
    const clean = { ...command, id: "clean", contentDependencies: empty() };
    const cleanReceipt = await f.runtime().receive(clean);
    assert.equal(cleanReceipt.kind, "accepted");
    await settle(f);
    await f.reopen();
    const reopened = await f.read();
    assert.deepEqual(reopened.raw, [empty(), empty()]);
    assert.deepEqual(reopened.canonical, [empty(), empty()]);
    assert.equal(reopened.state?.inputCount, 2);
  } finally {
    await f.close();
  }
});

for (const stage of [2, 3]) {
  test(`failed worker callback ${stage} leaves the receiving raw and canonical imports unchanged`, async () => {
    const f = await teamProvenanceFixture();
    try {
      await f.runtime().receive(start(f));
      await settle(f);
      const provenance = dependencies(
        stage === 2 ? "worker-input" : "worker-result"
      );
      await f.store(stage === 2 ? 0 : 1).add(provenance.sourceIds);
      await f.store(stage === 2 ? 0 : 1).addTool(provenance.toolIds[0]);
      await assert.rejects(
        f.invokeWorker(stage),
        new RegExp(`Injected worker callback failure ${stage}`, "u")
      );
      const before = await f.read();
      const receiver = stage === 2 ? 1 : 0;
      assert.deepEqual(before.raw[receiver], empty());
      assert.deepEqual(before.canonical[receiver], empty());
      assert.ok(before.state);
      const [savedWorker] = before.state.workers;
      assert.ok(savedWorker?.requestId);
      const { requestId, nativeId: workerId } = savedWorker;
      const submission = await f
        .pi()
        .commit((tx) => tx.submissionByRequest(workerId, requestId), context);
      assert.equal(submission?.status, stage === 2 ? undefined : "done");
      await f.reopen();
      const reopened = await f.read();
      assert.deepEqual(reopened.raw[receiver], empty());
      assert.deepEqual(reopened.canonical[receiver], empty());
      const result = await f.invokeWorker();
      assert.deepEqual(result.output, [
        { type: "text", text: "Answer from role 1." },
      ]);
      const repaired = await f.read();
      assert.deepEqual(repaired.canonical[receiver], provenance);
      assert.deepEqual(repaired.raw[receiver], provenance);
      assert.equal(f.calls.filter((role) => role === 1).length, 1);
    } finally {
      await f.close();
    }
  });
}

test("an accepted command repairs a partial mirror failure on duplicate and reopen with one input and native submission", async () => {
  const f = await teamProvenanceFixture();
  try {
    const command = input(f, "accepted");
    f.failMirror(0);
    await assert.rejects(
      f.runtime().receive(command),
      /Injected raw mirror failure/u
    );
    const accepted = await f.read();
    assert.deepEqual(accepted.canonical[0], command.contentDependencies);
    assert.deepEqual(accepted.raw[0], {
      sourceIds: command.contentDependencies.sourceIds,
      toolIds: [],
    });
    const receipt = await f
      .pi()
      .snapshot(TeamCommandReceipts, command.id, context);
    assert.equal(receipt?.receipt?.accepted, true);
    assert.equal(accepted.state?.inputCount, 1);
    assert.equal(f.calls.length, 0);
    f.failMirror(null);
    const replay = await f.runtime().receive(command);
    assert.equal(replay.kind, "accepted");
    await settle(f);
    await f.reopen();
    const reopenedReplay = await f.runtime().receive(command);
    assert.equal(reopenedReplay.kind, "accepted");
    await settle(f);
    const repaired = await f.read();
    assert.equal(repaired.state?.inputCount, 1);
    assert.deepEqual(repaired.raw[0], command.contentDependencies);
    const repairedReceipt = await f
      .pi()
      .snapshot(TeamCommandReceipts, command.id, context);
    assert.equal(repairedReceipt?.receipt?.taskId, receipt?.receipt?.taskId);
    assert.ok(repaired.state?.lead);
    const submissions = await f
      .pi()
      .commit(
        (tx) =>
          Promise.all([
            tx.submissionByRequest(
              repaired.state.lead,
              workStartOperationId(f.work.key)
            ),
            tx.submissionByRequest(repaired.state.lead, command.id),
          ]),
        context
      );
    assert.deepEqual(
      submissions.map((submission) => submission?.status),
      ["done", "done"]
    );
    assert.equal(f.calls.filter((role) => role === 0).length, 2);
  } finally {
    await f.close();
  }
});

for (const receiver of [0, 1]) {
  test(`a partial ${receiver === 0 ? "worker result" : "worker input"} mirror repairs on reopen and preserves the worker request`, async () => {
    const f = await teamProvenanceFixture();
    try {
      await f.runtime().receive(start(f));
      await settle(f);
      const sender = receiver === 0 ? 1 : 0;
      const provenance = dependencies(`partial-${receiver}`);
      await f.store(sender).add(provenance.sourceIds);
      await f.store(sender).addTool(provenance.toolIds[0]);
      f.failMirror(receiver);
      await assert.rejects(f.invokeWorker(), /Injected raw mirror failure/u);
      const accepted = await f.read();
      assert.deepEqual(accepted.canonical[receiver], provenance);
      assert.deepEqual(accepted.raw[receiver], {
        sourceIds: provenance.sourceIds,
        toolIds: [],
      });
      const callsBeforeReopen = [...f.calls];
      f.failMirror(null);
      await f.reopen();
      const reopened = await f.read();
      assert.deepEqual(reopened.raw[receiver], provenance);
      assert.deepEqual(reopened.canonical[receiver], provenance);
      assert.equal(reopened.state?.inputCount, 1);
      assert.deepEqual(reopened.state?.workers, accepted.state?.workers);
      assert.deepEqual(f.calls, callsBeforeReopen);
      const result = await f.invokeWorker();
      assert.deepEqual(result.output, [
        { type: "text", text: "Answer from role 1." },
      ]);
      assert.equal(f.calls.filter((role) => role === 1).length, 1);
    } finally {
      await f.close();
    }
  });
}

for (const denied of ["source", "tool", "role", "model"] as const) {
  test(`current ${denied} denial blocks duplicate repair and physical handoff but allows cold completion`, async () => {
    const f = await teamProvenanceFixture();
    try {
      const command = input(f, "private");
      f.failMirror(0);
      await assert.rejects(
        f.runtime().receive(command),
        /Injected raw mirror failure/u
      );
      const accepted = await f.read();
      assert.deepEqual(
        await f.runtime().roles[0]?.dependencies(),
        command.contentDependencies
      );
      if (denied === "source") {
        f.denySource(command.contentDependencies.sourceIds[0]);
      }
      if (denied === "tool") {
        f.denyTool(command.contentDependencies.toolIds[0]);
      }
      if (denied === "role") {
        f.denyRole(0);
      }
      if (denied === "model") {
        f.denyModel(0);
      }
      f.failMirror(null);
      await assert.rejects(
        f.runtime().receive(command),
        (error: unknown) => error instanceof Denied
      );
      await assert.rejects(
        f.runtime().roles[0]?.permit(empty()),
        (error: unknown) => error instanceof Denied
      );
      const deniedState = await f.read();
      assert.deepEqual(deniedState.raw, accepted.raw);
      await f.reopen();
      await settle(f);
      await f.runtime().wake(f.work.deadlineAt);
      const final = await f.read();
      assert.equal(final.state?.report?.kind, "failed");
      assert.equal(final.state.inputCount, 1);
      assert.deepEqual(final.raw, accepted.raw);
      assert.deepEqual(final.canonical, accepted.canonical);
      assert.equal(f.calls.length, 0);
    } finally {
      await f.close();
    }
  });
}

test("an owner ChannelError wrapped as Unavailable does not block a cold completed report or permit another handoff", async () => {
  const f = await teamProvenanceFixture();
  try {
    const command = input(f, "owner-before-revocation");
    const receipt = await f.runtime().receive(command);
    assert.equal(receipt.kind, "accepted");
    await settle(f);
    const before = await f.read();
    assert.equal(before.state?.phase, "running");
    assert.equal(before.state.report, null);
    const callsBefore = [...f.calls];
    f.denyOwner(true);
    const configuration = f.configuration(0);
    assert.ok(configuration);
    const owner = await Effect.runPromise(
      Effect.result(configuration.ownerContext())
    );
    assert.ok(Result.isFailure(owner));
    assert.ok(owner.failure instanceof Unavailable);
    await f.reopen();
    await f.runtime().wake(f.work.deadlineAt);
    const final = await f.read();
    assert.equal(final.state?.report?.kind, "completed");
    assert.equal(final.state.inputCount, 1);
    assert.deepEqual(
      final.state.report.contentDependencies,
      command.contentDependencies
    );
    assert.deepEqual(final.canonical, before.canonical);
    assert.deepEqual(final.raw, before.raw);
    assert.deepEqual(f.calls, callsBefore);
    assert.ok(f.work.deadlineAt - Date.now() > 500_000);
    const [lead] = f.runtime().roles;
    assert.ok(lead);
    await assert.rejects(
      lead.permit(empty()),
      (error: unknown) => error instanceof Unavailable
    );
    assert.deepEqual(f.calls, callsBefore);
  } finally {
    await f.close();
  }
});

test("cold restore propagates a raw SQL mirror failure after successful authorization", async () => {
  const f = await teamProvenanceFixture();
  try {
    const command = input(f, "raw-failure");
    f.failMirror(0);
    await assert.rejects(
      f.runtime().receive(command),
      /Injected raw mirror failure/u
    );
    const before = await f.read();
    await assert.rejects(f.reopen(), /Injected raw mirror failure/u);
    const after = await f.read();
    assert.deepEqual(after.canonical, before.canonical);
    assert.deepEqual(after.raw, before.raw);
    assert.equal(f.calls.length, 0);
  } finally {
    await f.close();
  }
});

for (const kind of ["source", "tool"] as const) {
  test(
    `a full raw ${kind} set plus one canonical import retains private provenance and seals an overflow report`,
    { timeout: 30_000 },
    async () => {
      const f = await teamProvenanceFixture();
      try {
        await f.runtime().receive(start(f));
        await settle(f);
        const limit = kind === "source" ? 512 : 256;
        const existing = Array.from(
          { length: limit },
          (_, index) => `accepted-${kind}-${index}`
        ).toSorted();
        await (kind === "source"
          ? f.store(0).add(existing)
          : Promise.all(existing.map((tool) => f.store(0).addTool(tool))));
        const incoming =
          kind === "source"
            ? { sourceIds: dependencies("incoming").sourceIds, toolIds: [] }
            : { sourceIds: [], toolIds: dependencies("incoming").toolIds };
        const command = {
          ...input(f, "overflow"),
          contentDependencies: incoming,
        };
        await assert.rejects(
          f.runtime().receive(command),
          /Expected a value with a length of at most/u
        );
        const receipt = await f
          .pi()
          .snapshot(TeamCommandReceipts, command.id, context);
        assert.equal(receipt?.receipt?.accepted, true);
        const [lead] = f.runtime().roles;
        assert.ok(lead);
        const full = await lead.dependencies();
        const values = kind === "source" ? full.sourceIds : full.toolIds;
        assert.deepEqual(values, [
          ...existing,
          ...(kind === "source" ? incoming.sourceIds : incoming.toolIds),
        ]);
        const rawBefore =
          kind === "source" ? await f.store(0).all() : await f.store(0).tools();
        assert.equal(rawBefore.length, limit);
        await f.reopen();
        const pending = await f.pi().snapshot(TeamState, context);
        assert.equal(pending?.phase, "running");
        const [restoredLead] = f.runtime().roles;
        assert.ok(restoredLead);
        assert.deepEqual(await restoredLead.dependencies(), full);
        await Promise.all(
          Object.values(pending?.pending ?? {}).map((taskId) =>
            f.pi().waitForTask(taskId, context)
          )
        );
        await f.runtime().wake(f.work.deadlineAt);
        const final = await f.pi().snapshot(TeamState, context);
        assert.equal(final?.phase, "failed");
        assert.equal(final.inputCount, 2);
        assert.equal(final.report?.kind, "failed");
        assert.equal(
          final.report.reason,
          "The team could not complete within its execution limits."
        );
        assert.deepEqual(final.report.contentDependencies, empty());
        assert.deepEqual(await restoredLead.dependencies(), full);
        assert.equal(f.calls.length, 1);
        assert.ok(f.work.deadlineAt - Date.now() > 500_000);
        await f.reopen();
        const reopened = await f.pi().snapshot(TeamState, context);
        const [reopenedLead] = f.runtime().roles;
        assert.ok(reopenedLead);
        assert.deepEqual(await reopenedLead.dependencies(), full);
        assert.deepEqual(reopened?.report, final.report);
        assert.equal(f.calls.length, 1);
      } finally {
        await f.close();
      }
    }
  );
}

test("mirror authorization retains exactly its canonical snapshot when another accepted import arrives", async () => {
  const f = await teamProvenanceFixture();
  try {
    await f.runtime().receive(start(f));
    await settle(f);
    const { state } = await f.read();
    assert.ok(state?.lead);
    const original = dependencies("authorized");
    const later = dependencies("later");
    await f
      .pi()
      .commit((tx) => importContentIn(tx, state.lead, original), context);
    const checked = [];
    await reconcileImportedContent(
      f.pi(),
      state.lead,
      f.store(0).importDependencies,
      {
        authorize: async (saved) => {
          checked.push(saved);
          await f
            .pi()
            .commit((tx) => importContentIn(tx, state.lead, later), context);
          return "authorized";
        },
      }
    );
    assert.deepEqual(checked, [original]);
    const mirrored = await f.read();
    assert.deepEqual(mirrored.raw[0], original);
    assert.deepEqual(await readImportedContent(f.pi(), state.lead), {
      sourceIds: [...original.sourceIds, ...later.sourceIds],
      toolIds: [...original.toolIds, ...later.toolIds],
    });
  } finally {
    await f.close();
  }
});
