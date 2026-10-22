import { LiveDoc } from "@earendil-works/pi-durable";
import type { PiHarness } from "agents/harness/pi";
import type { LifecycleJobs } from "agents/lifecycle";
import { z } from "zod";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import { InvalidInput } from "../../packages/contracts/src/failures.ts";
import { piContext } from "../../packages/runtime/src/pi-harness.ts";
import type { MetadataTransaction } from "../../packages/runtime/src/session-agent.ts";
import { forkOrigin } from "./fixture-contracts.ts";

export const capabilityFixture = async (
  request: Request,
  path: string,
  address: EventAddress,
  services: {
    readonly transaction: MetadataTransaction;
    readonly storage: DurableObjectStorage;
    readonly nativeSession: (address: EventAddress) => Promise<string>;
    readonly harness: PiHarness;
    readonly jobs: LifecycleJobs;
  }
): Promise<Response> => {
  if (path === "/fixture/capabilities/reserve-fork") {
    const { origin } = z
      .object({ origin: forkOrigin })
      .parse(await request.json());
    if (
      origin.address.organizationId !== address.organizationId ||
      origin.address.agentId !== address.agentId
    ) {
      throw new InvalidInput({
        reason: "Fixture fork origin crosses an identity or agent.",
      });
    }
    const serialized = JSON.stringify(origin);
    await services.transaction(() => {
      services.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS fixture_fork_origin (session_id TEXT PRIMARY KEY, origin TEXT NOT NULL)"
      );
      const [prior] = services.storage.sql
        .exec<{ origin: string }>(
          "SELECT origin FROM fixture_fork_origin WHERE session_id=?",
          address.sessionId
        )
        .toArray();
      if (prior && prior.origin !== serialized) {
        throw new InvalidInput({
          reason: "The fixture fork reservation changed.",
        });
      }
      services.storage.sql.exec(
        "INSERT OR IGNORE INTO fixture_fork_origin VALUES (?, ?)",
        address.sessionId,
        serialized
      );
    });
    await services.storage.sync();
    return Response.json({ status: "ok", value: { reserved: true } });
  }
  const nativeId = await services.nativeSession(address);
  if (path === "/fixture/capabilities/compaction-state") {
    const pi = await services.harness.pi();
    const native = await services.harness.conversation(nativeId);
    const inspection = await pi.inspect(piContext());
    return Response.json({
      status: "ok",
      value: {
        live: await pi.snapshot(LiveDoc, native.id, piContext()),
        tasks: inspection.tasks
          .filter(({ record }) => record.conversationId === native.id)
          .map(({ record }) => record),
      },
    });
  }
  if (path === "/fixture/capabilities/expire-child") {
    const { childId } = z
      .object({ childId: z.string().min(1) })
      .parse(await request.json());
    const job = services.jobs.list().find((candidate) => {
      const parsed = z
        .object({ childId: z.string(), sessionId: z.string() })
        .safeParse(candidate.payload);
      return (
        parsed.success &&
        parsed.data.childId === childId &&
        parsed.data.sessionId === address.sessionId
      );
    });
    if (!job) {
      throw new InvalidInput({
        reason: "The child has no durable deadline job.",
      });
    }
    await services.transaction(() =>
      services.jobs.reschedule(job.id, Date.now())
    );
    await services.storage.sync();
    return Response.json({
      status: "ok",
      value: { previousDeadline: job.time, rescheduled: true },
    });
  }
  if (path === "/fixture/capabilities/storage") {
    const value = await services.transaction(() => ({
      conversations: services.storage.sql
        .exec<{
          id: number;
          ownerConversationId: number | null;
          ownerTaskId: number | null;
          parentConversationId: number | null;
          parentEntryId: number | null;
        }>(
          "SELECT id, owner_conversation_id AS ownerConversationId, owner_task_id AS ownerTaskId, json_extract(record, '$.parent.conversationId') AS parentConversationId, json_extract(record, '$.parent.at') AS parentEntryId FROM pi_conversations WHERE id=? OR owner_conversation_id=? ORDER BY id",
          nativeId,
          nativeId
        )
        .toArray(),
      submissions: services.storage.sql
        .exec<{
          id: number;
          conversationId: number;
          requestId: string | null;
          status: string;
        }>(
          "SELECT id, conversation_id AS conversationId, json_extract(record, '$.requestId') AS requestId, status FROM pi_submissions WHERE conversation_id IN (SELECT id FROM pi_conversations WHERE id=? OR owner_conversation_id=?) ORDER BY id",
          nativeId,
          nativeId
        )
        .toArray(),
      tasks: services.storage.sql
        .exec<{
          id: number;
          conversationId: number;
          kind: string;
          status: string;
        }>(
          "SELECT id, conversation_id AS conversationId, json_extract(record, '$.kind') AS kind, status FROM pi_tasks WHERE conversation_id IN (SELECT id FROM pi_conversations WHERE id=? OR owner_conversation_id=?) ORDER BY id",
          nativeId,
          nativeId
        )
        .toArray(),
    }));
    return Response.json({ status: "ok", value });
  }
  throw new InvalidInput({ reason: "Unknown capability fixture route." });
};
