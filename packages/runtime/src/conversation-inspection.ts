import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, NotFound, Unavailable } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type {
  InspectionFrame,
  InspectionQuery,
  TeamInspectionFrame,
  TeamInspectionQuery,
} from "@cerebro/contracts/inspection";
import type { ContentDependencies } from "@cerebro/contracts/session";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { WorkAdmission } from "@cerebro/contracts/work";
import type { Harness } from "@earendil-works/pi-durable";

import { readRecordedContent } from "./content-dependency-store.ts";
import {
  Bindings,
  ProfileChanged,
  requireProfileIn,
} from "./conversation-bindings.ts";
import type { ScanWorkKeys } from "./coordinator-history.ts";
import {
  sameWorkSource,
  retainedWorkDependencies,
} from "./coordinator-ledger.ts";
import type { CoordinatorWorkRecord } from "./coordinator-ledger.ts";
import { readImportedContent } from "./imported-content.ts";
import { readInspectionEvents } from "./inspection-events.ts";
import {
  boundedInspectionFrame,
  inspectionCursor,
  nextInspectionCursor,
} from "./inspection-page.ts";
import {
  projectInspectionWork,
  readInspectionWorkPage,
  readOwnedWork,
} from "./inspection-work.ts";
import { piContext } from "./pi-harness.ts";

export interface InspectionAccess {
  readonly authorize: (input: {
    readonly address: EventAddress;
    readonly context: ExecutionContext;
    readonly dependencies: ContentDependencies;
    readonly history: readonly EventAddress[];
    readonly signal?: AbortSignal;
  }) => Promise<void>;
  readonly team: (input: {
    readonly work: WorkAdmission;
    readonly context: ExecutionContext;
    readonly query: TeamInspectionQuery;
    readonly signal?: AbortSignal;
  }) => Promise<TeamInspectionFrame>;
}
const combined = (
  values: readonly ContentDependencies[]
): ContentDependencies => ({
  sourceIds: [...new Set(values.flatMap((value) => value.sourceIds))],
  toolIds: [...new Set(values.flatMap((value) => value.toolIds))],
});
interface InspectionInput {
  readonly pi: Harness;
  readonly storage: DurableObjectStorage;
  readonly address: EventAddress;
  readonly context: ExecutionContext;
  readonly query: InspectionQuery;
  readonly access: InspectionAccess;
  readonly scanWorkKeys: ScanWorkKeys;
  readonly scanEventKeys: ScanWorkKeys;
  readonly signal?: AbortSignal;
}
const readSelectedInspection = async (
  input: InspectionInput & {
    readonly query: TeamInspectionQuery;
  },
  record: CoordinatorWorkRecord,
  common: Pick<InspectionFrame, "address" | "profile">
): Promise<InspectionFrame> => {
  const { pi, query, context, access, signal } = input;
  if (record.dispatched) {
    let result: TeamInspectionFrame;
    try {
      result = await access.team({
        work: record.admission,
        context,
        query,
        signal,
      });
    } catch (error) {
      if (!(error instanceof Unavailable) || query.kind !== "team") {
        throw error;
      }
      result = {
        kind: "team",
        workId: record.admission.key.workId,
        team: { kind: "unavailable", reason: "execution-unavailable" },
      };
    }
    if (
      result.kind !== query.kind ||
      result.workId !== query.workId ||
      ("role" in query && (!("role" in result) || result.role !== query.role))
    ) {
      throw new Unavailable({
        reason: "The private inspection response changed its target.",
      });
    }
    return result.kind === "team"
      ? {
          ...common,
          kind: "team",
          work: await projectInspectionWork(pi, record, signal),
          team: result.team,
        }
      : { ...common, ...result };
  }
  if (query.kind !== "team") {
    throw new NotFound({ resource: "Unstarted private role" });
  }
  return {
    ...common,
    kind: "team",
    work: await projectInspectionWork(pi, record, signal),
    team: { kind: "not-started" },
  };
};
export const readConversationInspection = async (
  input: InspectionInput
): Promise<InspectionFrame> => {
  const { pi, address, context, query, access, signal } = input;
  if (
    context.actor.organizationId !== address.organizationId ||
    "delegation" in context
  ) {
    throw new Denied({
      code: "unauthorized",
      reason: "Inspection requires the source owner.",
    });
  }
  const ownerPrincipalId = context.actor.id;
  const bindings = await pi.snapshot(Bindings, piContext(signal));
  const binding = bindings?.conversations[address.sessionId];
  if (!binding || !sameWorkSource(binding.address, address)) {
    throw new NotFound({ resource: "Saved source binding" });
  }
  const profile = { agentVersion: binding.agentVersion };
  const additional: ContentDependencies[] = [];
  let observed: readonly CoordinatorWorkRecord[] = [];
  let eventKeys: readonly string[] | undefined;
  const authorize = async () => {
    const [raw, canonical] = await Promise.all([
      pi.commit(
        () => readRecordedContent(input.storage, address.sessionId),
        piContext(signal)
      ),
      readImportedContent(pi, binding.nativeId),
    ]);
    await access.authorize({
      address,
      context,
      dependencies: combined([raw, canonical, ...additional]),
      history: raw.history,
      signal,
    });
  };
  const owned = (workId: string) =>
    readOwnedWork({ pi, address, ownerPrincipalId, workId, signal });
  const common = { address, profile };
  await authorize();
  let frame: InspectionFrame;
  if (query.kind === "events") {
    const page = await input.scanEventKeys(inspectionCursor(address, query));
    eventKeys = page.keys;
    const events = await readInspectionEvents({
      pi,
      keys: page.keys,
      address,
      nativeId: binding.nativeId,
      ownerPrincipalId,
      signal,
    });
    additional.push(...events.dependencies);
    frame = {
      ...common,
      kind: "events",
      events: events.items,
      next: nextInspectionCursor(address, query, page.next),
    };
  } else if (query.kind === "overview" || query.kind === "history") {
    const { records, next } = await readInspectionWorkPage({
      ...input,
      nativeId: binding.nativeId,
      ownerPrincipalId,
      query,
    });
    additional.push(retainedWorkDependencies(records));
    observed = records;
    const work = await Promise.all(
      records.map((record) => projectInspectionWork(pi, record, signal))
    );
    frame =
      query.kind === "history"
        ? { ...common, kind: "history", work, next }
        : {
            ...common,
            kind: "overview",
            work,
            refresh: work.some(
              (item) =>
                item.reservationHeld ||
                (item.status === "queued" && item.deadlineAt > Date.now())
            ),
          };
  } else {
    const record = await owned(query.workId);
    observed = [record];
    additional.push(retainedWorkDependencies([record]));
    await authorize();
    frame = await readSelectedInspection({ ...input, query }, record, common);
  }

  const currentRecords = await Promise.all(
    observed.map((record) => owned(record.admission.key.workId))
  );
  for (const [index, current] of currentRecords.entries()) {
    if (
      canonicalToolArguments(current.admission) !==
      canonicalToolArguments(observed[index]?.admission)
    ) {
      throw new Denied({
        code: "revoked",
        reason: "The retained work admission changed.",
      });
    }
  }
  additional.push(retainedWorkDependencies(currentRecords));
  if (eventKeys) {
    const current = await readInspectionEvents({
      pi,
      keys: eventKeys,
      address,
      nativeId: binding.nativeId,
      ownerPrincipalId,
      signal,
    });
    additional.push(...current.dependencies);
  }
  await authorize();
  await pi.commit(async (tx) => {
    const current = await requireProfileIn(tx, address.sessionId, profile);
    if (
      current.nativeId !== binding.nativeId ||
      !sameWorkSource(current.address, address)
    ) {
      throw new ProfileChanged();
    }
  }, piContext(signal));
  return boundedInspectionFrame(frame);
};
