import { Schema } from "effect";

import type { EventAddress } from "../../packages/contracts/src/events";
import type { PrincipalId } from "../../packages/contracts/src/identity";
import { WorkAdmissionSchema } from "../../packages/contracts/src/work";

export const inspectionSecret = "private-inspection-test-signing-key-0000001";
export const inspectionConfiguration = JSON.stringify({
  mode: "local",
  gatewaySigningKey: inspectionSecret,
  bootstrapToken: "private-bootstrap-test-value-with-32-characters",
  artifacts: {
    accessKeyId: "fixture",
    secretAccessKey: "fixture",
    bucket: "fixture",
    endpoint: "http://fixture.invalid:9000",
    region: "test",
  },
  models: [
    {
      id: "fixture/model",
      provider: "fixture",
      model: "model",
      apiKey: "fixture",
      baseUrl: "http://fixture.invalid:8090/v1",
      deadlineMs: 1000,
      maxInputBytes: 4096,
      maxOutputTokens: 128,
      maxResponseBytes: 4096,
    },
  ],
  retrievalMode: "full-text",
  tools: [],
});
export const inspectionWork = (
  sourceEventAddress: EventAddress,
  ownerPrincipalId: PrincipalId
) => {
  const now = Date.now();
  return Schema.decodeUnknownSync(WorkAdmissionSchema)({
    version: 3,
    admittedAt: now,
    deadlineAt: now + 60_000,
    goal: "Read retained private work.",
    key: {
      organizationId: sourceEventAddress.organizationId,
      ownerPrincipalId,
      workId: "private-inspection-work",
    },
    agent: { agentId: sourceEventAddress.agentId, agentVersion: 3 },
    limits: { maxTeams: 2, maxWorkers: 1, maxTurns: 8, timeoutMs: 60_000 },
    sourceEventAddress,
    contentDependencies: { sourceIds: [], toolIds: [] },
  });
};
