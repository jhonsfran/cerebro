/* oxlint-disable no-await-in-loop -- Sequential inserts preserve provider stream order in the durable cursor. */
import type { ExecutionContext } from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import {
  channelConversation,
  channelFixtureRun,
  channelInbox,
  channelItem,
  channelReply,
} from "@cerebro/db/schema/agents";
import type { ChannelItemBody } from "@cerebro/db/schema/agents";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { sessionServiceFor } from "./fixture-session";
import { authorize, unwrap } from "./security";
import { conversationAddress } from "./service";
import type { ChannelOptions } from "./types";
import { EFFECT_DEADLINE_MS } from "./types";

export const projectSession = async (
  database: Database,
  options: ChannelOptions,
  conversation: typeof channelConversation.$inferSelect,
  context: ExecutionContext
): Promise<void> => {
  if (!options.sessions) {
    const runs = await database
      .select()
      .from(channelFixtureRun)
      .where(eq(channelFixtureRun.conversationId, conversation.conversationId));
    const complete =
      runs.length > 0 &&
      runs.every((run) =>
        ["completed", "failed", "cancelled", "unknown-outcome"].includes(
          run.state.state
        )
      );
    await database
      .update(channelConversation)
      .set({
        lastProjectedAt: new Date(options.now?.() ?? Date.now()),
        projectionState: complete ? "idle" : "active",
      })
      .where(
        and(
          eq(channelConversation.conversationId, conversation.conversationId),
          eq(channelConversation.activityVersion, conversation.activityVersion)
        )
      );
    return;
  }
  const prefix = `runtime:${conversation.sessionId}:`;
  const cursor = conversation.streamCursor ?? undefined;
  const service = sessionServiceFor(database, options);
  const read = {
    deadlineAt: (options.now?.() ?? Date.now()) + EFFECT_DEADLINE_MS,
  };
  const items: { itemKey: string; item: ChannelItemBody }[] = [];
  let truncated = false;
  for await (const result of service.stream(
    conversationAddress(conversation),
    context,
    cursor,
    read
  )) {
    await authorize(
      database,
      options,
      context,
      "read",
      "agent",
      conversation.agentId
    );
    const item = unwrap(result);
    let body: ChannelItemBody;
    if (item.type === "run") {
      body = { run: item.run, runId: item.run.runId, type: "run" };
    } else if (item.type === "output") {
      body = {
        dependencies: item.dependencies,
        runId: item.runId,
        text: item.text,
        type: "output",
      };
    } else if (item.type === "citation") {
      body = {
        dependencies: item.dependencies,
        href: `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}/sources/${encodeURIComponent(item.citation.sourceId)}`,
        runId: item.runId,
        sourceId: item.citation.sourceId,
        sourceVersion: item.citation.sourceVersion,
        title: item.citation.sourceUri,
        type: "citation",
      };
    } else if (item.type === "tool") {
      body = {
        dependencies: item.dependencies,
        name: item.toolId,
        operationId: item.operationId,
        output: item.output,
        runId: item.runId,
        state: "succeeded",
        toolId: item.toolId,
        type: "tool",
      };
    } else {
      body = {
        approvalId: item.approvalId,
        runId: item.runId,
        type: "approval",
      };
    }
    items.push({ item: body, itemKey: `${prefix}${item.cursor}` });
    if (items.length >= 100) {
      truncated = true;
      break;
    }
  }
  const snapshot = unwrap(
    await service.inspect(conversationAddress(conversation), context, read)
  );
  await database.transaction(async (tx) => {
    const [claimed] = await tx
      .update(channelConversation)
      .set({
        lastProjectedAt: new Date(options.now?.() ?? Date.now()),
        projectionState: "active",
        streamCursor:
          items.at(-1)?.itemKey.slice(prefix.length) ??
          conversation.streamCursor,
      })
      .where(
        and(
          eq(channelConversation.conversationId, conversation.conversationId),
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
          ...entry,
          conversationId: conversation.conversationId,
          organizationId: conversation.organizationId,
        })
        .onConflictDoNothing();
    }
    const outputs = await tx
      .select()
      .from(channelItem)
      .where(eq(channelItem.conversationId, conversation.conversationId))
      .orderBy(asc(channelItem.cursor));
    const terminalRunIds = new Set(
      outputs.flatMap((row) =>
        row.item.type === "run" &&
        ["completed", "failed", "cancelled", "unknown-outcome"].includes(
          row.item.run.state
        )
          ? [row.item.run.runId]
          : []
      )
    );
    const projectedCursor =
      items.at(-1)?.itemKey.slice(prefix.length) ??
      conversation.streamCursor ??
      "0";
    const unprojectedAdmissions =
      snapshot.runs.length === 0
        ? await tx
            .select({ eventKey: channelInbox.eventKey })
            .from(channelInbox)
            .where(
              and(
                eq(channelInbox.conversationId, conversation.conversationId),
                inArray(channelInbox.state, ["pending", "accepted"])
              )
            )
            .limit(1)
        : [];
    const projectionComplete =
      !truncated &&
      projectedCursor === snapshot.cursor &&
      unprojectedAdmissions.length === 0 &&
      snapshot.runs.every((run) => terminalRunIds.has(run.runId));
    if (projectionComplete) {
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
    const completedRunIds = new Set(
      outputs.flatMap((row) =>
        row.item.type === "run" && row.item.run.state === "completed"
          ? [row.item.run.runId]
          : []
      )
    );
    for (const run of snapshot.runs) {
      if (run.state !== "completed" || !completedRunIds.has(run.runId)) {
        continue;
      }
      const text = outputs
        .flatMap((row) =>
          row.item.type === "output" && row.item.runId === run.runId
            ? [row.item.text]
            : []
        )
        .join("");
      if (!text) {
        continue;
      }
      await tx
        .insert(channelReply)
        .values({
          conversationId: conversation.conversationId,
          organizationId: conversation.organizationId,
          replyId: `reply:${run.runId}`,
          runId: run.runId,
          state: "ready",
          text,
        })
        .onConflictDoNothing();
    }
  });
};
