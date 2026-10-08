/* oxlint-disable no-await-in-loop -- Projection records commit in snapshot order. */
import type { ExecutionContext } from "@cerebro/contracts";
import type { DomainSnapshot } from "@cerebro/contracts/session-service";
import type { Database } from "@cerebro/db";
import {
  channelConversation,
  channelInbox,
  channelItem,
  channelReply,
} from "@cerebro/db/schema/agents";
import type { ChannelItemBody } from "@cerebro/db/schema/agents";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { sessionServiceFor } from "./fixture-session";
import { authorize, authorizeContent, runEffect } from "./security";
import { conversationAddress } from "./service";
import { EFFECT_DEADLINE_MS } from "./types";
import type { ChannelOptions } from "./types";

export const snapshotItems = (
  snapshot: DomainSnapshot
): { itemKey: string; item: ChannelItemBody }[] => {
  const entries: { itemKey: string; item: ChannelItemBody }[] = [];
  for (const message of snapshot.userMessages) {
    entries.push({
      item: {
        eventId: message.eventId,
        mode: message.mode,
        runId: message.runId,
        text: message.text,
        type: "user",
      },
      itemKey: `user:${message.eventId}`,
    });
  }
  for (const tool of snapshot.tools) {
    entries.push({
      item: {
        arguments: tool.arguments,
        dependencies: tool.dependencies,
        name: tool.toolId,
        operationId: tool.operationId,
        output: tool.output,
        runId: tool.runId,
        state: tool.state,
        toolId: tool.toolId,
        type: "tool",
      },
      itemKey: `tool:${tool.operationId}`,
    });
  }
  for (const approval of snapshot.approvals) {
    entries.push({
      item: {
        approvalId: approval.approvalId,
        expiresAt: approval.expiresAt,
        operationId: approval.operationId,
        runId: approval.runId,
        state: approval.state,
        type: "approval",
      },
      itemKey: `approval:${approval.approvalId}`,
    });
  }
  for (const output of snapshot.outputs) {
    entries.push({
      item: {
        answerId: output.answerId,
        dependencies: output.dependencies,
        executionId: output.executionId,
        runId: output.runId,
        runIds: output.runIds,
        text: output.text,
        type: "output",
      },
      itemKey: `answer:${output.answerId}`,
    });
    for (const citation of output.citations) {
      entries.push({
        item: {
          dependencies: output.dependencies,
          href: `/api/product/conversations/${encodeURIComponent(snapshot.address.conversationId)}/sources/${encodeURIComponent(citation.sourceId)}`,
          runId: output.runId,
          sourceId: citation.sourceId,
          sourceVersion: citation.sourceVersion,
          title: citation.sourceUri,
          type: "citation",
        },
        itemKey: `citation:${output.answerId}:${citation.sourceId}:${citation.sourceVersion}`,
      });
    }
  }
  for (const run of snapshot.runs) {
    entries.push({
      item: { run, runId: run.runId, type: "run" },
      itemKey: `run:${run.runId}`,
    });
  }
  return entries;
};

export const projectSession = async (
  database: Database,
  options: ChannelOptions,
  conversation: typeof channelConversation.$inferSelect,
  context: ExecutionContext
): Promise<void> => {
  if (conversation.engine !== "pi-v1" || conversation.retiredAt) {
    return;
  }
  const startedAt = performance.now();
  const snapshot = await runEffect(
    sessionServiceFor(database, options).inspect(
      conversationAddress(conversation),
      context,
      { deadlineAt: (options.now?.() ?? Date.now()) + EFFECT_DEADLINE_MS }
    )
  );
  const items = snapshotItems(snapshot);
  for (const entry of items) {
    await authorize(
      database,
      options,
      context,
      "read",
      "agent",
      conversation.agentId
    );
    await authorizeContent(database, options, context, entry.item);
  }
  await database.transaction(async (tx) => {
    const [claimed] = await tx
      .update(channelConversation)
      .set({
        lastProjectedAt: new Date(options.now?.() ?? Date.now()),
        projectionState: "active",
        streamCursor:
          snapshot.revision === 0 ? null : String(snapshot.revision),
      })
      .where(
        and(
          eq(channelConversation.conversationId, conversation.conversationId),
          eq(channelConversation.engine, "pi-v1"),
          isNull(channelConversation.retiredAt),
          eq(channelConversation.activityVersion, conversation.activityVersion),
          sql`${channelConversation.streamCursor} is not distinct from ${conversation.streamCursor}`
        )
      )
      .returning({ conversationId: channelConversation.conversationId });
    if (!claimed) {
      return;
    }
    for (const entry of items) {
      await tx
        .insert(channelItem)
        .values({
          conversationId: conversation.conversationId,
          item: entry.item,
          itemKey: `runtime:${conversation.sessionId}:${entry.itemKey}`,
          organizationId: conversation.organizationId,
        })
        .onConflictDoUpdate({
          set: { item: entry.item },
          target: channelItem.itemKey,
        });
    }
    const admissions = await tx
      .select({ eventId: channelInbox.envelope })
      .from(channelInbox)
      .where(
        and(
          eq(channelInbox.conversationId, conversation.conversationId),
          inArray(channelInbox.state, ["pending", "accepted"])
        )
      );
    const acceptedIds = new Set(
      snapshot.userMessages.map((message) => message.eventId)
    );
    const complete =
      admissions.every((entry) => acceptedIds.has(entry.eventId.eventId)) &&
      snapshot.runs.every((run) =>
        ["completed", "failed", "cancelled", "unknown-outcome"].includes(
          run.state
        )
      );
    if (complete) {
      await tx
        .update(channelConversation)
        .set({ projectionState: "idle" })
        .where(
          eq(channelConversation.conversationId, conversation.conversationId)
        );
    }
    if (conversation.kind !== "slack") {
      return;
    }
    const states = new Map(snapshot.runs.map((run) => [run.runId, run.state]));
    for (const output of snapshot.outputs) {
      if (
        !output.runIds.every((runId) => states.get(runId) === "completed") ||
        !output.text
      ) {
        continue;
      }
      await tx
        .insert(channelReply)
        .values({
          conversationId: conversation.conversationId,
          organizationId: conversation.organizationId,
          replyId: `reply:${output.answerId}`,
          runId: output.runId,
          state: "ready",
          text: output.text,
        })
        .onConflictDoNothing();
    }
  });
  options.recordAdapterTime?.({
    adapter: "projection",
    durationMs: performance.now() - startedAt,
    resourceId: conversation.conversationId,
  });
};
