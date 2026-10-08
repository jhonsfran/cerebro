import { id } from "../../../../packages/contracts/src/identity.ts";

export const organizationId = id.organization("s4-company");
export const agentId = id.agent("s4-agent");
export const principalId = id.principal("s4-human");
export const context = {
  actor: {
    id: principalId,
    kind: "human" as const,
    organizationId,
    state: "active" as const,
  },
};
export const fixtureToken = "s4-local-trusted-fixture-caller";
