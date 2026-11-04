import { InvalidInput } from "@cerebro/contracts/failures";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import type { LifecycleJobs } from "agents/lifecycle";

import {
  CoordinatorAdmissions,
  coordinatorOperationKey,
} from "./coordinator-ledger.ts";
import { piContext } from "./pi-harness.ts";
import type { MetadataTransaction } from "./session-agent.ts";

type NativeCommit = <A>(change: (tx: Tx) => A | Promise<A>) => Promise<A>;
const MAX_ADMISSIONS = 16;

export const createCoordinatorAdmissions = (options: {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly sessionId: string;
  readonly jobs: LifecycleJobs;
  readonly metadata: MetadataTransaction;
  readonly persist: () => Promise<void>;
  readonly now: () => number;
  readonly timeoutMs: number;
}) => {
  const nativeCommit: NativeCommit = (change) =>
    options.pi.commit(change, piContext());
  const ensureWake = (): Promise<void> =>
    options.metadata(async () => {
      await options.jobs.push({
        id: `cerebro-coordination:${options.sessionId}`,
        fn: "cerebro-coordination",
        payload: { sessionId: options.sessionId },
        recoveryLoop: true,
        singleflight: true,
        time: options.now(),
      });
    });
  const pending = async (): Promise<boolean> => {
    const document = await options.pi.snapshot(
      CoordinatorAdmissions,
      options.nativeId,
      piContext()
    );
    return Object.values(document?.leases ?? {}).some(
      (until) => until > options.now()
    );
  };
  const finishIn = async (tx: Tx, lease: string): Promise<void> => {
    const document = await tx.doc(CoordinatorAdmissions, options.nativeId);
    Reflect.deleteProperty(document.leases, lease);
  };
  const requireLease = async (tx: Tx, lease: string): Promise<void> => {
    const document = await tx.doc(CoordinatorAdmissions, options.nativeId);
    const until = document.leases[lease];
    if (until === undefined || until <= options.now()) {
      throw new InvalidInput({
        reason: "The team admission lease expired. Retry the request.",
      });
    }
  };
  const arm = async (operationId: string): Promise<string> => {
    const lease = await coordinatorOperationKey(
      JSON.stringify([operationId, crypto.randomUUID()])
    );
    await nativeCommit(async (tx) => {
      const document = await tx.doc(CoordinatorAdmissions, options.nativeId);
      for (const [key, until] of Object.entries(document.leases)) {
        if (until <= options.now()) {
          Reflect.deleteProperty(document.leases, key);
        }
      }
      if (
        document.leases[lease] === undefined &&
        Object.keys(document.leases).length >= MAX_ADMISSIONS
      ) {
        throw new InvalidInput({
          reason:
            "This source already has its maximum pending control operations.",
        });
      }
      document.leases[lease] = options.now() + options.timeoutMs;
    });
    await ensureWake();
    return lease;
  };
  return {
    arm,
    ensureWake,
    finishIn,
    pending,
    commit: async <A>(
      operationId: string,
      change: (tx: Tx) => Promise<A>,
      write: NativeCommit = nativeCommit
    ): Promise<A> => {
      const lease = await arm(operationId);
      try {
        const result = await write(async (tx) => {
          await requireLease(tx, lease);
          const value = await change(tx);
          await requireLease(tx, lease);
          await finishIn(tx, lease);
          return value;
        });
        await options.persist();
        options.pi.resume();
        return result;
      } catch (error) {
        await nativeCommit((tx) => finishIn(tx, lease));
        throw error;
      }
    },
  };
};
