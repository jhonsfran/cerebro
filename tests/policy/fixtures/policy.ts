import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import { id } from "../../../packages/contracts/src/identity.ts";
import type { ExecutionContext } from "../../../packages/contracts/src/identity.ts";
import type { EffectOptions } from "../../../packages/contracts/src/port.ts";
import { withDatabase } from "../../../packages/db/src/index.ts";
import type { Database } from "../../../packages/db/src/index.ts";
import { createUsageRepository } from "../../../packages/db/src/repositories/usage.ts";
import { organization } from "../../../packages/db/src/schema/core.ts";
import { createLocalBudget } from "../../../packages/policy/src/local-budget.ts";
import { SqliteOperationJournal } from "./journal.ts";

export const effect = (name: string, digest = name): EffectOptions => ({
  deadlineAt: Date.now() + 30_000,
  operationId: id.operation(`${name}-${crypto.randomUUID()}`),
  requestDigest: id.digest(digest),
});
export const databaseUrl = (): string => {
  const value = process.env.POLICY_TEST_DATABASE_URL;
  if (!value) {
    throw new Error(
      "POLICY_TEST_DATABASE_URL is required. Run node tests/policy/run.mjs to create an isolated PostgreSQL fixture."
    );
  }
  return value;
};
export const withPolicyFixture = async <Value>(
  run: (fixture: {
    database: Database;
    organizationId: ReturnType<typeof id.organization>;
    context: ExecutionContext;
    agentId: ReturnType<typeof id.agent>;
    repository: ReturnType<typeof createUsageRepository>;
    budget: ReturnType<typeof createLocalBudget>;
  }) => Promise<Value>
): Promise<Value> =>
  await withDatabase({ DATABASE_URL: databaseUrl() }, async (database) => {
    const organizationId = id.organization(`policy-${crypto.randomUUID()}`);
    await database
      .insert(organization)
      .values({ id: organizationId, name: "Policy fixture" });
    const repository = createUsageRepository(database);
    await repository.configureAccount(organizationId, {
      unit: "fixture-units",
      units: 10,
    });
    const context: ExecutionContext = {
      actor: {
        id: id.principal("fixture-principal"),
        kind: "service",
        organizationId,
        state: "active",
      },
    };
    return await run({
      agentId: id.agent("fixture-agent"),
      budget: createLocalBudget(repository, "fixture-units"),
      context,
      database,
      organizationId,
      repository,
    });
  });
export const withJournal = async <Value>(
  run: (path: string, journal: SqliteOperationJournal<Value>) => Promise<void>
): Promise<void> => {
  const directory = await mkdtemp(nodePath.join(tmpdir(), "cerebro-policy-"));
  const path = nodePath.join(directory, "journal.sqlite");
  const journal = new SqliteOperationJournal<Value>(path, "paid-work");
  try {
    return await run(path, journal);
  } finally {
    journal.close();
    await rm(directory, { force: true, recursive: true });
  }
};
