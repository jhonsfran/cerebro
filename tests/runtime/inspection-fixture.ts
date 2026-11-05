import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";

import { Denied, Unavailable } from "../../packages/contracts/src/failures.ts";
import type {
  InspectionQuery,
  TeamInspectionFrame,
} from "../../packages/contracts/src/inspection.ts";
import { createSourceDependencyStore } from "../../packages/runtime/src/content-dependency-store.ts";
import { Bindings } from "../../packages/runtime/src/conversation-bindings.ts";
import { readConversationInspection } from "../../packages/runtime/src/conversation-inspection.ts";
import type { InspectionAccess } from "../../packages/runtime/src/conversation-inspection.ts";
import { BotEventReceipts } from "../../packages/runtime/src/coordinator-event-state.ts";
import { WorkDocuments } from "../../packages/runtime/src/coordinator-ledger.ts";
import { scanInspectionKeys } from "../../packages/runtime/src/inspection-page.ts";
import { context, setup } from "./coordinator-fixture.ts";

const unavailableTeam = () =>
  Promise.reject(new Unavailable({ reason: "Execution is unavailable." }));

export const inspectionFixture = async () => {
  const fixture = await setup();
  const source = fixture.source("a");
  const actor = {
    actor: {
      id: source.ownerPrincipalId,
      kind: "human" as const,
      organizationId: source.address.organizationId,
      state: "active" as const,
    },
  };
  const platform = {
    sql: {
      exec: (query: string, ...bindings: SQLInputValue[]) => {
        const rows = fixture
          .database()
          .prepare(query)
          .all(...bindings);
        return { toArray: () => rows };
      },
    },
  };
  const storage = platform as unknown as DurableObjectStorage;
  const pi = fixture.pi();
  const raw = await pi.commit(async (tx) => {
    const bindings = await tx.doc(Bindings);
    bindings.conversations[source.address.sessionId] = {
      address: source.address,
      agentVersion: 7,
      policyVersion: 1,
      nativeId: source.native.id,
      origin: null,
      legacyVersion: null,
      refresh: null,
      releaseEvent: null,
    };
    return createSourceDependencyStore(
      storage,
      source.address.sessionId,
      (run) => pi.commit(run, context)
    );
  }, context);
  const denied = new Set<string>();
  const checks: Parameters<InspectionAccess["authorize"]>[0][] = [];
  const calls: Parameters<InspectionAccess["team"]>[0][] = [];
  let project: InspectionAccess["team"] = unavailableTeam;
  let checked: (() => Promise<void>) | undefined;
  const access: InspectionAccess = {
    authorize: async (input) => {
      checks.push(input);
      assert.equal(input.context, actor);
      input.signal?.throwIfAborted();
      if (
        denied.has("source") ||
        input.dependencies.sourceIds.some((value) => denied.has(value)) ||
        input.dependencies.toolIds.some((value) => denied.has(value))
      ) {
        throw new Denied({
          code: "revoked",
          reason: "Current read access denied.",
        });
      }
      await checked?.();
    },
    team: async (input) => {
      calls.push(input);
      return await project(input);
    },
  };
  let scanner: Parameters<
    typeof readConversationInspection
  >[0]["scanWorkKeys"] = (cursor) =>
    scanInspectionKeys(
      pi,
      fixture.storage(),
      WorkDocuments.definition.kind,
      cursor
    );
  let eventScanner: Parameters<
    typeof readConversationInspection
  >[0]["scanEventKeys"] = (cursor) =>
    scanInspectionKeys(
      pi,
      fixture.storage(),
      BotEventReceipts.definition.kind,
      cursor
    );
  return {
    fixture,
    source,
    actor,
    storage,
    raw,
    denied,
    checks,
    calls,
    setScanner: (value: typeof scanner) => {
      scanner = value;
    },
    setEventScanner: (value: typeof eventScanner) => {
      eventScanner = value;
    },
    setProject: (
      value: (
        input: Parameters<InspectionAccess["team"]>[0]
      ) => Promise<TeamInspectionFrame>
    ) => {
      project = value;
    },
    onCheck: (value: () => Promise<void>) => {
      checked = value;
    },
    read: (query: InspectionQuery, signal?: AbortSignal) =>
      readConversationInspection({
        pi,
        storage,
        address: source.address,
        context: actor,
        query,
        access,
        scanWorkKeys: scanner,
        scanEventKeys: eventScanner,
        signal,
      }),
    close: fixture.close,
  };
};
