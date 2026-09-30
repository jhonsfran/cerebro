import { id } from "@cerebro/contracts";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { withDatabase } from "@cerebro/db";
import { createIdentityRepository } from "@cerebro/db/repositories/identity";
import { createMemoryRepository } from "@cerebro/db/repositories/memory";
import { createMemoryStore, createS3ObjectStorage } from "@cerebro/memory";

export const seedFixtureSource = async (
  databaseUrl: string,
  organization: string,
  artifacts: Parameters<typeof createS3ObjectStorage>[0]
): Promise<void> => {
  await withDatabase({ DATABASE_URL: databaseUrl }, async (database) => {
    const sourceId = id.source("pilot-source");
    const repository = createMemoryRepository(database);
    if (await repository.source(organization, sourceId)) {
      return;
    }
    const principalId = id.principal(`pilot-source-seeder:${organization}`);
    const context = {
      actor: {
        id: principalId,
        kind: "service" as const,
        organizationId: id.organization(organization),
        state: "active" as const,
      },
    };
    const document =
      "Cerebro pilot runs use current company grants before each model request and tool dispatch. The local pilot source is stored in PostgreSQL and MinIO. Source revocation removes its content from later answers and source views.";
    const source = {
      chunks: [{ id: "pilot-source:1:policy", text: document }],
      document,
      expectedGeneration: null,
      observedAt: 1_790_720_000_000,
      sourceId,
      uri: "cerebro://pilot/source",
      version: "1",
      visibility: { kind: "organization" as const },
    };
    const result = await createMemoryStore({
      identity: createIdentityRepository(database),
      objects: createS3ObjectStorage(artifacts),
      repository,
      retrievalMode: "full-text",
    }).ingest(
      { context, organizationId: id.organization(organization) },
      source,
      {
        deadlineAt: Date.now() + 30_000,
        operationId: id.operation(`seed:${organization}:pilot-source:1`),
        requestDigest: await digestToolArguments(source),
      }
    );
    if (result.status !== "ok") {
      throw new Error("Pilot source initialization failed.");
    }
  });
};
