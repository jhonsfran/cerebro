import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import type { AuthorizationSnapshot } from "../../packages/db/src/repositories/identity.ts";

interface HistoricalRow {
  organizationId: string;
  agentId: string;
  conversationId: string;
  sessionId: string;
  ownerPrincipalId: string;
  kind: string;
  engine: string;
  retiredAt: Date | null;
  workspaceId: string;
  channelId: string;
  rootTimestamp: string;
  slackUserId: string;
}

export const legacySlackTimerBoundary = {
  row: undefined as HistoricalRow | undefined,
  linked: true,
  readable: true,
  policyReads: 0,
  reset(address: EventAddress, ownerPrincipalId: string) {
    this.row = {
      ...address,
      ownerPrincipalId,
      kind: "slack",
      engine: "pi-identity-v1",
      retiredAt: null,
      workspaceId: "workspace-old",
      channelId: "D-old",
      rootTimestamp: "1800000000.000001",
      slackUserId: "slack-old",
    };
    this.linked = true;
    this.readable = true;
    this.policyReads = 0;
  },
  database: {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          const { params } = new PgDialect().sqlToQuery(condition);
          const { row } = legacySlackTimerBoundary;
          return Promise.resolve(
            row?.conversationId === params[0] ? [{ ...row }] : []
          );
        },
      }),
    }),
  },
  identity: {
    resolveSlackLink: (workspaceId: string, userId: string) => {
      const { row, linked } = legacySlackTimerBoundary;
      return Promise.resolve(
        linked && row?.workspaceId === workspaceId && row.slackUserId === userId
          ? {
              organizationId: row.organizationId,
              principalId: row.ownerPrincipalId,
            }
          : undefined
      );
    },
    readSnapshot: (): Promise<AuthorizationSnapshot> => {
      const state = legacySlackTimerBoundary;
      state.policyReads += 1;
      const { row } = state;
      if (!row) {
        throw new Error("The historical source boundary is missing.");
      }
      return Promise.resolve({
        actor: {
          id: row.ownerPrincipalId,
          organizationId: row.organizationId,
          kind: "human",
          state: "active",
          betterAuthUserId: null,
          createdAt: new Date(0),
          directoryManaged: false,
        },
        actorDirectoryActive: true,
        represented: undefined,
        delegation: undefined,
        representedDirectoryActive: false,
        representedGrants: [],
        scopes: [],
        actorGrants: state.readable
          ? [
              {
                organizationId: row.organizationId,
                principalId: row.ownerPrincipalId,
                action: "read",
                resourceKind: "agent",
                resourceId: row.agentId,
                source: "manual",
              },
            ]
          : [],
        policyVersion: state.readable ? "current-read" : "revoked-read",
      });
    },
  },
};
