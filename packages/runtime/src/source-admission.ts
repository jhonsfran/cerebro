import { botEventId } from "@cerebro/contracts/bot-events";
import type { EventAddress } from "@cerebro/contracts/events";
import { Conflict, Denied } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import { InboxDoc, defineDoc } from "@earendil-works/pi-durable";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import type { LifecycleJobOutcome, LifecycleJobs } from "agents/lifecycle";

import { nativeDrainIn } from "./conversation-drain.ts";
import {
  BotEventQueue,
  BotEventReceipts,
  eventOf,
} from "./coordinator-event-state.ts";
import {
  SourceOperations,
  coordinatorOperationKey,
  sameWorkSource,
} from "./coordinator-ledger.ts";
import { piContext } from "./pi-harness.ts";

export type SourceAdmissionState =
  | { kind: "open" }
  | {
      kind: "paused" | "forwarding" | "archived";
      primary: { [Key in keyof EventAddress]: EventAddress[Key] };
    };
export const SourceAdmission = defineDoc({
  kind: "cerebro.source-admission",
  scope: "conversation",
  history: "latest",
  fork: "initial",
  version: 1,
  initial: (): { state: SourceAdmissionState } => ({ state: { kind: "open" } }),
});

const rejectFresh = (): never => {
  throw new Denied({
    code: "revoked",
    reason:
      "This historical conversation no longer accepts new messages. Open the agent's primary conversation.",
  });
};
export const requireFreshSourceIn = async (
  tx: Tx,
  nativeId: ConversationId
): Promise<void> => {
  const document = await tx.doc(SourceAdmission, nativeId);
  if (document.state.kind !== "open") {
    rejectFresh();
  }
};

export const acceptedNativeInputIn = async (
  tx: Tx,
  nativeId: ConversationId,
  operationId: string,
  text: string,
  digest: string | null = null
): Promise<boolean> => {
  const submission = await tx.submissionByRequest(nativeId, operationId);
  if (submission) {
    if (submission.type !== "input") {
      throw new Conflict({
        code: "digest-mismatch",
        reason: "The operation identifies a native write.",
      });
    }
    let original: unknown;
    if (submission.status === "queued") {
      const inbox = await tx.doc(InboxDoc, nativeId);
      const item = inbox.items.find(
        (candidate) => candidate.id === submission.id
      );
      original = item && item.mode !== "write" ? item.content : undefined;
    } else if (submission.entry !== undefined) {
      const entry = await tx.entry(submission.entry);
      const message = entry?.model?.[0];
      original = message?.role === "user" ? message.content : undefined;
    }
    if (original !== undefined && original !== text) {
      throw new Conflict({
        code: "digest-mismatch",
        reason: "The source operation payload changed.",
      });
    }
    if (original === undefined && digest === null) {
      throw new Conflict({
        code: "digest-mismatch",
        reason: "The accepted input's original payload is unavailable.",
      });
    }
    return true;
  }
  return false;
};

export const acceptedInputIn = async (
  tx: Tx,
  nativeId: ConversationId,
  address: EventAddress,
  operationId: string,
  text: string
): Promise<boolean> => {
  const key = await coordinatorOperationKey(operationId);
  const operation = await tx.doc(SourceOperations, nativeId, key, operationId);
  const digest = await coordinatorOperationKey(text);
  if (operation.digest && operation.digest !== digest) {
    throw new Conflict({
      code: "digest-mismatch",
      reason: "The source operation payload changed.",
    });
  }
  if (
    await acceptedNativeInputIn(
      tx,
      nativeId,
      operationId,
      text,
      operation.digest
    )
  ) {
    return true;
  }
  if (
    operation.digest === digest &&
    operation.route &&
    operation.route.kind !== "coordinator"
  ) {
    return true;
  }
  const eventId = await botEventId(address, {
    kind: "web",
    operationId: id.operation(operationId),
  });
  const saved = await tx.doc(BotEventReceipts, eventId, null);
  if (!saved.receipt) {
    return false;
  }
  const event = eventOf(saved.receipt);
  if (
    !sameWorkSource(event.coordinator, address) ||
    event.source.kind !== "web" ||
    event.source.operationId !== operationId ||
    event.content.text !== text
  ) {
    throw new Conflict({
      code: "digest-mismatch",
      reason: "The source operation payload changed.",
    });
  }
  return true;
};

export const requireInputAdmissionIn = async (
  tx: Tx,
  input: {
    nativeId: ConversationId;
    address: EventAddress;
    operationId: string;
    text: string;
  }
): Promise<void> => {
  const document = await tx.doc(SourceAdmission, input.nativeId);
  if (
    document.state.kind === "open" ||
    (await acceptedInputIn(
      tx,
      input.nativeId,
      input.address,
      input.operationId,
      input.text
    ))
  ) {
    return;
  }
  rejectFresh();
};

export const createSourceAdmission = (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly address: EventAddress;
  readonly primary?: EventAddress;
  readonly busy: () => boolean;
  readonly jobs: LifecycleJobs;
  readonly persist: () => Promise<void>;
}) => {
  const read = async (): Promise<SourceAdmissionState> => {
    const saved = await options.pi.snapshot(
      SourceAdmission,
      options.nativeId,
      piContext()
    );
    return saved?.state ?? { kind: "open" };
  };
  const advance = async (): Promise<LifecycleJobOutcome> => {
    const waiting = await options.pi.commit(async (tx) => {
      const document = await tx.doc(SourceAdmission, options.nativeId);
      if (
        document.state.kind === "open" &&
        options.primary &&
        !sameWorkSource(options.primary, options.address)
      ) {
        document.state = { kind: "paused", primary: { ...options.primary } };
      }
      if (document.state.kind !== "paused") {
        return false;
      }
      const queue = await tx.doc(BotEventQueue);
      if (
        options.busy() ||
        Object.values(queue.pending).some(
          (item) => item.nativeId === options.nativeId
        ) ||
        !(await nativeDrainIn(tx, options.nativeId))
      ) {
        return true;
      }
      document.state = { kind: "forwarding", primary: document.state.primary };
      return false;
    }, piContext());
    await options.persist();
    if (waiting) {
      return { rescheduleAt: Date.now() + 1000 };
    }
    await options.pi.commit(async (tx) => {
      const document = await tx.doc(SourceAdmission, options.nativeId);
      if (document.state.kind === "forwarding") {
        document.state = { kind: "archived", primary: document.state.primary };
      }
    }, piContext());
    await options.persist();
  };
  const restore = async (): Promise<void> => {
    const { primary } = options;
    if (!primary || sameWorkSource(primary, options.address)) {
      return;
    }
    if (
      primary.organizationId !== options.address.organizationId ||
      primary.agentId !== options.address.agentId
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The primary conversation belongs to another source.",
      });
    }
    const previous = await read();
    if (
      previous.kind !== "open" &&
      !sameWorkSource(previous.primary, primary)
    ) {
      throw new Denied({
        code: "unauthorized",
        reason: "The primary forwarding address changed.",
      });
    }
    if (previous.kind === "archived") {
      return;
    }
    await options.pi.commit(async (tx) => {
      const document = await tx.doc(SourceAdmission, options.nativeId);
      if (
        document.state.kind !== "open" &&
        !sameWorkSource(document.state.primary, primary)
      ) {
        throw new Denied({
          code: "unauthorized",
          reason: "The primary forwarding address changed.",
        });
      }
      if (document.state.kind === "archived") {
        return;
      }
      await options.jobs.push({
        id: `cerebro-source-cutover:${options.address.sessionId}`,
        fn: "cerebro-source-cutover",
        payload: { sessionId: options.address.sessionId },
        recoveryLoop: true,
        singleflight: true,
        time: Date.now(),
      });
      if (document.state.kind === "open") {
        document.state = { kind: "paused", primary: { ...primary } };
      }
    }, piContext());
    await options.persist();
  };
  return { read, restore, advance };
};
