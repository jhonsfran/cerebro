import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";

import { id } from "../../../packages/contracts/src/identity.ts";
import { digestToolArguments } from "../../../packages/contracts/src/tools.ts";
import { SqliteOperationJournal } from "./journal.ts";

test("SQLite claims, snapshots, namespace separation and reconciliation survive reopen", async () => {
  const directory = await mkdtemp(nodePath.join(tmpdir(), "cerebro-journal-"));
  const path = nodePath.join(directory, "journal.sqlite");
  const first = new SqliteOperationJournal<{
    count: number;
  }>(path, "broker");
  const second = new SqliteOperationJournal<{
    count: number;
  }>(path, "broker");
  const gateway = new SqliteOperationJournal<{
    count: number;
  }>(path, "gateway");
  const organizationId = id.organization("company-a");
  const operationId = id.operation("operation-a");
  const request = { value: "accepted" };
  const requestDigest = await digestToolArguments(request);
  const options = {
    deadlineAt: Date.now() + 60_000,
    operationId,
    requestDigest,
  };
  const intent = { operationId, organizationId, request, requestDigest };
  let reopened:
    | SqliteOperationJournal<{
        count: number;
      }>
    | undefined;
  try {
    const claims = await Promise.all([
      first.claim(intent, options),
      second.claim(intent, options),
    ]);
    assert.deepEqual(
      claims
        .map((result) => result.status === "ok" && result.value.state)
        .toSorted(),
      ["claimed", "pending"]
    );
    const owner = claims.find(
      (result) => result.status === "ok" && result.value.state === "claimed"
    );
    assert.ok(
      owner && owner.status === "ok" && owner.value.state === "claimed"
    );
    const token = owner.value.claimToken;
    request.value = "changed";
    const resultSnapshot1 = await first.claim(intent, options);
    assert.equal(resultSnapshot1.status, "conflict");
    const metadata = { attempt: "first" };
    const resultSnapshot2 = await first.dispatch(token, metadata, options);
    assert.equal(resultSnapshot2.status, "ok");
    metadata.attempt = "mutated";
    const resultSnapshot3 = await second.dispatch("wrong-token", {}, options);
    assert.equal(resultSnapshot3.status, "not-found");
    const resultSnapshot4 = await first.unknown(token, "Lost reply", options);
    assert.equal(resultSnapshot4.status, "ok");
    const resultSnapshot5 = await first.unknown(token, "Lost reply", options);
    assert.equal(resultSnapshot5.status, "ok");
    const snapshot = await second.read(organizationId, operationId, options);
    assert.ok(
      snapshot.status === "ok" && snapshot.value.state === "unknown-outcome"
    );
    assert.deepEqual(snapshot.value.metadata, { attempt: "first" });
    assert.deepEqual(snapshot.value.intent.request, { value: "accepted" });
    const resultSnapshot6 = await gateway.claim(
      { ...intent, request: { value: "accepted" } },
      options
    );
    assert.equal(resultSnapshot6.status, "ok");
    first.close();
    second.close();
    reopened = new SqliteOperationJournal(path, "broker");
    const pending = await reopened.claim(
      { ...intent, request: { value: "accepted" } },
      options
    );
    assert.ok(
      pending.status === "ok" &&
        pending.value.state === "pending" &&
        pending.value.record.state === "unknown-outcome"
    );
    const result = { status: "ok" as const, value: { count: 1 } };
    const resultSnapshot7 = await reopened.complete(token, result, options);
    assert.equal(resultSnapshot7.status, "ok");
    const resultSnapshot8 = await reopened.complete(token, result, options);
    assert.equal(resultSnapshot8.status, "ok");
    result.value.count = 2;
    const resultSnapshot9 = await reopened.complete(token, result, options);
    assert.equal(resultSnapshot9.status, "conflict");
    reopened.close();
    reopened = new SqliteOperationJournal(path, "broker");
    assert.deepEqual(
      await reopened.claim(
        { ...intent, request: { value: "accepted" } },
        options
      ),
      {
        status: "ok",
        value: {
          result: { status: "ok", value: { count: 1 } },
          state: "completed",
        },
      }
    );
    const resultSnapshot10 = await reopened.read(
      id.organization("company-b"),
      operationId,
      options
    );
    assert.equal(resultSnapshot10.status, "not-found");
  } finally {
    reopened?.close();
    gateway.close();
    await rm(directory, { force: true, recursive: true });
  }
});
test("SQLite paid outcome receipt survives reopen and completion cannot change it", async () => {
  const directory = await mkdtemp(nodePath.join(tmpdir(), "cerebro-receipt-"));
  const path = nodePath.join(directory, "journal.sqlite");
  let journal = new SqliteOperationJournal<{
    choice: string;
  }>(path, "policy");
  const organizationId = id.organization("company-paid");
  const operationId = id.operation("operation-paid");
  const requestDigest = await digestToolArguments({ input: "paid" });
  const options = {
    deadlineAt: Date.now() + 60_000,
    operationId,
    requestDigest,
  };
  const intent = {
    operationId,
    organizationId,
    request: { input: "paid" },
    requestDigest,
  };
  const result = { status: "ok" as const, value: { choice: "run" } };
  const incurred = { unit: "tokens", units: 2 };
  try {
    const claim = await journal.claim(intent, options);
    assert.ok(claim.status === "ok" && claim.value.state === "claimed");
    const token = claim.value.claimToken;
    const resultSnapshot11 = await journal.recordOutcome(
      token,
      result,
      incurred,
      options
    );
    assert.equal(resultSnapshot11.status, "conflict");
    const resultSnapshot12 = await journal.dispatch(
      token,
      { provider: "fixture" },
      options
    );
    assert.equal(resultSnapshot12.status, "ok");
    const resultSnapshot13 = await journal.recordOutcome(
      token,
      result,
      incurred,
      options
    );
    assert.equal(resultSnapshot13.status, "ok");
    const resultSnapshot14 = await journal.recordOutcome(
      token,
      result,
      incurred,
      options
    );
    assert.equal(resultSnapshot14.status, "ok");
    incurred.units = 3;
    const resultSnapshot15 = await journal.recordOutcome(
      token,
      result,
      incurred,
      options
    );
    assert.equal(resultSnapshot15.status, "conflict");
    const resultSnapshot16 = await journal.unknown(
      token,
      "Billing timeout",
      options
    );
    assert.equal(resultSnapshot16.status, "conflict");
    journal.close();
    journal = new SqliteOperationJournal(path, "policy");
    const pending = await journal.claim(intent, options);
    assert.ok(
      pending.status === "ok" &&
        pending.value.state === "pending" &&
        pending.value.record.state === "outcome-recorded"
    );
    assert.deepEqual(pending.value.record.result, {
      status: "ok",
      value: { choice: "run" },
    });
    assert.deepEqual(pending.value.record.incurred, {
      unit: "tokens",
      units: 2,
    });
    result.value.choice = "defer";
    const resultSnapshot17 = await journal.complete(token, result, options);
    assert.equal(resultSnapshot17.status, "conflict");
    const resultSnapshot18 = await journal.complete(
      token,
      { status: "ok", value: { choice: "run" } },
      options
    );
    assert.equal(resultSnapshot18.status, "ok");
  } finally {
    journal.close();
    await rm(directory, { force: true, recursive: true });
  }
});
test("SQLite reservation intent survives reopen and only one dispatcher succeeds", async () => {
  const directory = await mkdtemp(
    nodePath.join(tmpdir(), "cerebro-reservation-")
  );
  const path = nodePath.join(directory, "journal.sqlite");
  let journal = new SqliteOperationJournal<null>(path, "policy");
  let competitor: SqliteOperationJournal<null> | undefined;
  const organizationId = id.organization("company-reservation");
  const operationId = id.operation("operation-reservation");
  const requestDigest = await digestToolArguments({ input: "reserve" });
  const options = {
    deadlineAt: Date.now() + 60_000,
    operationId,
    requestDigest,
  };
  const intent = {
    operationId,
    organizationId,
    request: { input: "reserve" },
    requestDigest,
  };
  const metadata = {
    maximum: { unit: "tokens", units: 4 },
    reservationId: "reservation-1",
  };
  try {
    const claim = await journal.claim(intent, options);
    assert.ok(claim.status === "ok" && claim.value.state === "claimed");
    const token = claim.value.claimToken;
    const resultSnapshot19 = await journal.recordReservationIntent(
      token,
      metadata,
      options
    );
    assert.equal(resultSnapshot19.status, "ok");
    const resultSnapshot20 = await journal.recordReservationIntent(
      token,
      metadata,
      options
    );
    assert.equal(resultSnapshot20.status, "ok");
    metadata.maximum.units = 5;
    const resultSnapshot21 = await journal.recordReservationIntent(
      token,
      metadata,
      options
    );
    assert.equal(resultSnapshot21.status, "conflict");
    const resultSnapshot22 = await journal.unknown(
      token,
      "Reservation timeout",
      options
    );
    assert.equal(resultSnapshot22.status, "conflict");
    journal.close();
    journal = new SqliteOperationJournal(path, "policy");
    competitor = new SqliteOperationJournal(path, "policy");
    const pending = await journal.claim(intent, options);
    assert.ok(
      pending.status === "ok" &&
        pending.value.state === "pending" &&
        pending.value.record.state === "reserve-intent"
    );
    assert.deepEqual(pending.value.record.metadata, {
      maximum: { unit: "tokens", units: 4 },
      reservationId: "reservation-1",
    });
    const results = await Promise.all([
      journal.dispatch(token, { reservationId: "reservation-1" }, options),
      competitor.dispatch(token, { reservationId: "reservation-1" }, options),
    ]);
    assert.deepEqual(results.map((result) => result.status).toSorted(), [
      "conflict",
      "ok",
    ]);
  } finally {
    journal.close();
    competitor?.close();
    await rm(directory, { force: true, recursive: true });
  }
});
for (const winner of ["release", "dispatch"] as const) {
  test(`SQLite ${winner} wins the release and dispatch race and survives reopen`, async () => {
    const directory = await mkdtemp(
      nodePath.join(tmpdir(), "cerebro-release-")
    );
    const path = nodePath.join(directory, "journal.sqlite");
    let first = new SqliteOperationJournal<null>(path, "policy");
    const second = new SqliteOperationJournal<null>(path, "policy");
    const organizationId = id.organization("company-release");
    const operationId = id.operation("operation-release");
    const requestDigest = await digestToolArguments({ input: "release" });
    const options = {
      deadlineAt: Date.now() + 60_000,
      operationId,
      requestDigest,
    };
    const intent = {
      operationId,
      organizationId,
      request: { input: "release" },
      requestDigest,
    };
    const metadata = { reservationId: "reservation-release" };
    const result = {
      code: "unauthorized" as const,
      reason: "Grant revoked",
      status: "denied" as const,
    };
    try {
      const claim = await first.claim(intent, options);
      assert.ok(claim.status === "ok" && claim.value.state === "claimed");
      const token = claim.value.claimToken;
      await first.recordReservationIntent(token, metadata, options);
      const release = () =>
        first.recordReleaseIntent(token, metadata, result, options);
      const dispatch = () => second.dispatch(token, metadata, options);
      const transitions =
        winner === "release"
          ? [release(), dispatch()]
          : [dispatch(), release()];
      const resultSnapshot23 = await Promise.all(transitions);
      assert.deepEqual(
        resultSnapshot23.map((value) => value.status),
        ["ok", "conflict"]
      );
      first.close();
      first = new SqliteOperationJournal(path, "policy");
      const recovered = await first.claim(intent, options);
      assert.ok(
        recovered.status === "ok" && recovered.value.state === "pending"
      );
      assert.equal(
        recovered.value.record.state,
        winner === "release" ? "release-intent" : "dispatched"
      );
      if (winner === "release") {
        assert.ok(recovered.value.record.state === "release-intent");
        assert.deepEqual(recovered.value.record.result, result);
        assert.deepEqual(recovered.value.record.metadata, metadata);
        const repeated = await first.recordReleaseIntent(
          token,
          metadata,
          result,
          options
        );
        assert.equal(repeated.status, "ok");
        result.reason = "Changed rejection";
        const changed = await first.recordReleaseIntent(
          token,
          metadata,
          result,
          options
        );
        assert.equal(changed.status, "conflict");
      }
    } finally {
      first.close();
      second.close();
      await rm(directory, { force: true, recursive: true });
    }
  });
}
