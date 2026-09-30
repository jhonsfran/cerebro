import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { id } from "../../packages/contracts/src/identity.ts";
import { digestToolArguments } from "../../packages/contracts/src/tools.ts";
import { DurableOperationJournal } from "../../packages/runtime/src/operation-journal.ts";

class SqliteOperationJournal<Value> extends DurableOperationJournal<Value> {
  private readonly sqlite: DatabaseSync;
  constructor(path: string, namespace: string) {
    const sqlite = new DatabaseSync(path);
    sqlite.exec(
      "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;"
    );
    super(
      {
        exec: (query, ...parameters) => {
          sqlite.prepare(query).run(...parameters);
        },
        row: (query, ...parameters) => {
          const row = sqlite.prepare(query).get(...parameters);
          return row && typeof row.payload === "string"
            ? { payload: row.payload }
            : undefined;
        },
        sync: () => {
          sqlite.exec("PRAGMA wal_checkpoint(FULL)");
          return Promise.resolve();
        },
        transaction: (body) => {
          sqlite.exec("BEGIN IMMEDIATE");
          try {
            const value = body();
            sqlite.exec("COMMIT");
            return value;
          } catch (error) {
            sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      },
      namespace
    );
    this.sqlite = sqlite;
  }
  close(): void {
    this.sqlite.close();
  }
}

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
    const changedRequest = await first.claim(intent, options);
    assert.equal(changedRequest.status, "conflict");
    const metadata = { attempt: "first" };
    const dispatched = await first.dispatch(token, metadata, options);
    assert.equal(dispatched.status, "ok");
    metadata.attempt = "mutated";
    const missingClaim = await second.dispatch("wrong-token", {}, options);
    assert.equal(missingClaim.status, "not-found");
    const unknown = await first.unknown(token, "Lost reply", options);
    assert.equal(unknown.status, "ok");
    const repeatedUnknown = await first.unknown(token, "Lost reply", options);
    assert.equal(repeatedUnknown.status, "ok");
    const snapshot = await second.read(organizationId, operationId, options);
    assert.ok(
      snapshot.status === "ok" && snapshot.value.state === "unknown-outcome"
    );
    assert.deepEqual(snapshot.value.metadata, { attempt: "first" });
    assert.deepEqual(snapshot.value.intent.request, { value: "accepted" });
    const gatewayClaim = await gateway.claim(
      { ...intent, request: { value: "accepted" } },
      options
    );
    assert.equal(gatewayClaim.status, "ok");
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
    const completed = await reopened.complete(token, result, options);
    assert.equal(completed.status, "ok");
    const repeatedCompletion = await reopened.complete(token, result, options);
    assert.equal(repeatedCompletion.status, "ok");
    result.value.count = 2;
    const changedCompletion = await reopened.complete(token, result, options);
    assert.equal(changedCompletion.status, "conflict");
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
    const otherCompany = await reopened.read(
      id.organization("company-b"),
      operationId,
      options
    );
    assert.equal(otherCompany.status, "not-found");
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
    const beforeDispatch = await journal.recordOutcome(
      token,
      result,
      incurred,
      options
    );
    assert.equal(beforeDispatch.status, "conflict");
    const dispatched = await journal.dispatch(
      token,
      { provider: "fixture" },
      options
    );
    assert.equal(dispatched.status, "ok");
    const recorded = await journal.recordOutcome(
      token,
      result,
      incurred,
      options
    );
    assert.equal(recorded.status, "ok");
    const repeatedReceipt = await journal.recordOutcome(
      token,
      result,
      incurred,
      options
    );
    assert.equal(repeatedReceipt.status, "ok");
    incurred.units = 3;
    const changedUsage = await journal.recordOutcome(
      token,
      result,
      incurred,
      options
    );
    assert.equal(changedUsage.status, "conflict");
    const overwriteKnown = await journal.unknown(
      token,
      "Billing timeout",
      options
    );
    assert.equal(overwriteKnown.status, "conflict");
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
    const changedReceipt = await journal.complete(token, result, options);
    assert.equal(changedReceipt.status, "conflict");
    const completed = await journal.complete(
      token,
      { status: "ok", value: { choice: "run" } },
      options
    );
    assert.equal(completed.status, "ok");
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
    const reserved = await journal.recordReservationIntent(
      token,
      metadata,
      options
    );
    assert.equal(reserved.status, "ok");
    const repeatedReservation = await journal.recordReservationIntent(
      token,
      metadata,
      options
    );
    assert.equal(repeatedReservation.status, "ok");
    metadata.maximum.units = 5;
    const changedReservation = await journal.recordReservationIntent(
      token,
      metadata,
      options
    );
    assert.equal(changedReservation.status, "conflict");
    const beforeDispatchUnknown = await journal.unknown(
      token,
      "Reservation timeout",
      options
    );
    assert.equal(beforeDispatchUnknown.status, "conflict");
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
      const raced = await Promise.all(transitions);
      assert.deepEqual(
        raced.map((value) => value.status),
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
