/* oxlint-disable no-await-in-loop -- Each stream item requires its own current permission check before emission. */
import { classifyEventDelivery, id, preflightEffect } from "@cerebro/contracts";
import type {
  EventAddress,
  EventEnvelope,
  RunState,
  SessionService,
} from "@cerebro/contracts";
import type { Database } from "@cerebro/db";
import { createAgentRepository } from "@cerebro/db/repositories/agents";
import {
  channelConversation,
  channelEffect,
  channelFixtureRun,
  channelItem,
  channelReply,
} from "@cerebro/db/schema/agents";
import type { ChannelItemBody } from "@cerebro/db/schema/agents";
import { and, asc, eq, gt, sql } from "drizzle-orm";

import { authorize, digest, unwrap } from "./security";
import { ChannelError, FIXTURE_SOURCE_ID, FIXTURE_TOOL_ID } from "./types";
import type { ChannelOptions } from "./types";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const addressMatches = (event: EventEnvelope, address: EventAddress): boolean =>
  event.organizationId === address.organizationId &&
  event.agentId === address.agentId &&
  event.conversationId === address.conversationId &&
  event.sessionId === address.sessionId;
const item = (
  tx: Transaction,
  envelope: EventEnvelope,
  key: string,
  value: ChannelItemBody
) =>
  tx
    .insert(channelItem)
    .values({
      conversationId: envelope.conversationId,
      item: value,
      itemKey: `${envelope.sessionId}:${key}`,
      organizationId: envelope.organizationId,
    })
    .onConflictDoNothing();
const complete = async (
  tx: Transaction,
  envelope: EventEnvelope,
  runId: string,
  now: number
): Promise<RunState> => {
  const text =
    envelope.event.type === "user.message"
      ? envelope.event.payload.text
      : "Scheduled fixture request";
  const answer = `Fixture answer for "${text}". The local pilot source describes durable conversation admission.`;
  await item(tx, envelope, `${runId}:tool:complete`, {
    name: "Read pilot source",
    runId,
    state: "succeeded",
    toolId: FIXTURE_TOOL_ID,
    type: "tool",
  });
  await item(tx, envelope, `${runId}:output`, {
    runId,
    text: answer,
    type: "output",
  });
  await item(tx, envelope, `${runId}:citation`, {
    href: `/api/product/conversations/${envelope.conversationId}/sources/${FIXTURE_SOURCE_ID}`,
    runId,
    sourceId: FIXTURE_SOURCE_ID,
    sourceVersion: "1",
    title: "Local pilot source",
    type: "citation",
  });
  const state: RunState = {
    completedAt: now,
    runId: id.run(runId),
    state: "completed",
  };
  await item(tx, envelope, `${runId}:completed`, {
    run: state,
    runId,
    type: "run",
  });
  const [conversation] = await tx
    .select()
    .from(channelConversation)
    .where(eq(channelConversation.conversationId, envelope.conversationId));
  if (conversation?.kind === "slack") {
    await tx
      .insert(channelReply)
      .values({
        conversationId: envelope.conversationId,
        organizationId: envelope.organizationId,
        replyId: `reply:${runId}`,
        runId,
        state: "ready",
        text: answer,
      })
      .onConflictDoNothing();
  }
  return state;
};

export const createFixtureSessionService = (
  database: Database,
  options: ChannelOptions
): SessionService => {
  if (options.mode !== "fixture") {
    throw new Error(
      "The channel SessionService fixture is disabled in production."
    );
  }
  const now = options.now ?? Date.now;
  const service: SessionService = {
    async approve(command, effect) {
      const preflight = preflightEffect(effect, now());
      if (preflight.status !== "ok") {
        return preflight;
      }
      await authorize(
        database,
        options,
        command.context,
        "approve",
        "agent",
        command.address.agentId
      );
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${command.address.sessionId}))`
        );
        const requestDigest = await digest({ command, kind: "approve" });
        const [prior] = await tx
          .select()
          .from(channelEffect)
          .where(eq(channelEffect.operationId, effect.operationId));
        if (prior) {
          return prior.digest === requestDigest && "state" in prior.result
            ? { status: "ok", value: prior.result }
            : {
                code: "digest-mismatch",
                reason: "The approval operation changed.",
                status: "conflict",
              };
        }
        const rows = await tx
          .select()
          .from(channelFixtureRun)
          .where(
            eq(channelFixtureRun.conversationId, command.address.conversationId)
          );
        const found = rows.find(
          (row) =>
            `approval:${row.runId}` === command.approvalId &&
            addressMatches(row.envelope, command.address)
        );
        if (!found) {
          return { resource: "approval", status: "not-found" };
        }
        if (found.state.state !== "waiting-for-approval") {
          return {
            code: "already-final",
            reason: "The run is no longer waiting for approval.",
            status: "conflict",
          };
        }
        const result = await complete(tx, found.envelope, found.runId, now());
        await tx
          .update(channelFixtureRun)
          .set({ state: result })
          .where(eq(channelFixtureRun.runId, found.runId));
        await tx.insert(channelEffect).values({
          digest: requestDigest,
          operationId: effect.operationId,
          result,
        });
        return { status: "ok", value: result };
      });
    },
    async cancel(command, effect) {
      const preflight = preflightEffect(effect, now());
      if (preflight.status !== "ok") {
        return preflight;
      }
      await authorize(
        database,
        options,
        command.context,
        "execute",
        "agent",
        command.address.agentId
      );
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${command.address.sessionId}))`
        );
        const requestDigest = await digest({ command, kind: "cancel" });
        const [prior] = await tx
          .select()
          .from(channelEffect)
          .where(eq(channelEffect.operationId, effect.operationId));
        if (prior) {
          return prior.digest === requestDigest && "state" in prior.result
            ? { status: "ok", value: prior.result }
            : {
                code: "digest-mismatch",
                reason: "The cancel operation changed.",
                status: "conflict",
              };
        }
        const [found] = await tx
          .select()
          .from(channelFixtureRun)
          .where(eq(channelFixtureRun.runId, command.runId));
        if (!found || !addressMatches(found.envelope, command.address)) {
          return { resource: "run", status: "not-found" };
        }
        if (["completed", "failed", "cancelled"].includes(found.state.state)) {
          return {
            code: "already-final",
            reason: "The run is already final.",
            status: "conflict",
          };
        }
        const result: RunState = {
          endedAt: now(),
          runId: command.runId,
          state: "cancelled",
        };
        await tx
          .update(channelFixtureRun)
          .set({ state: result })
          .where(eq(channelFixtureRun.runId, found.runId));
        await item(tx, found.envelope, `${found.runId}:cancelled`, {
          run: result,
          runId: found.runId,
          type: "run",
        });
        await tx.insert(channelEffect).values({
          digest: requestDigest,
          operationId: effect.operationId,
          result,
        });
        return { status: "ok", value: result };
      });
    },
    async inspect(address, context, read) {
      if (read.signal?.aborted || read.deadlineAt <= now()) {
        return {
          code: "deadline-exceeded",
          reason: "The fixture read deadline passed.",
          status: "unavailable",
        };
      }
      await authorize(
        database,
        options,
        context,
        "read",
        "agent",
        address.agentId
      );
      const runs = await database
        .select()
        .from(channelFixtureRun)
        .where(
          and(
            eq(channelFixtureRun.organizationId, address.organizationId),
            eq(channelFixtureRun.conversationId, address.conversationId)
          )
        );
      const rows = await database
        .select({ cursor: channelItem.cursor })
        .from(channelItem)
        .where(eq(channelItem.conversationId, address.conversationId))
        .orderBy(asc(channelItem.cursor));
      return {
        status: "ok",
        value: {
          address,
          agentVersion: runs[0]?.agentVersion ?? 1,
          cursor: String(rows.at(-1)?.cursor ?? 0),
          runs: runs
            .filter((run) => addressMatches(run.envelope, address))
            .map((run) => run.state),
        },
      };
    },
    async *stream(address, context, cursor, read) {
      const snapshot = await service.inspect(address, context, read);
      if (snapshot.status !== "ok") {
        yield snapshot;
        return;
      }
      const offset = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        yield {
          reason: "The stream cursor is invalid.",
          status: "invalid-input",
        };
        return;
      }
      const rows = await database
        .select()
        .from(channelItem)
        .where(
          and(
            eq(channelItem.conversationId, address.conversationId),
            gt(channelItem.cursor, offset)
          )
        )
        .orderBy(asc(channelItem.cursor));
      for (const row of rows) {
        await authorize(
          database,
          options,
          context,
          "read",
          "agent",
          address.agentId
        );
        if (row.item.type === "output") {
          yield {
            status: "ok",
            value: {
              cursor: String(row.cursor),
              runId: id.run(row.item.runId),
              text: row.item.text,
              type: "output",
            },
          };
        } else if (row.item.type === "approval") {
          yield {
            status: "ok",
            value: {
              approvalId: row.item.approvalId,
              cursor: String(row.cursor),
              runId: id.run(row.item.runId),
              type: "approval",
            },
          };
        } else if (row.item.type === "run") {
          yield {
            status: "ok",
            value: {
              cursor: String(row.cursor),
              run: row.item.run,
              type: "run",
            },
          };
        }
      }
    },
    async submit(command, effect) {
      const preflight = preflightEffect(effect, now());
      if (preflight.status !== "ok") {
        return preflight;
      }
      const envelope = command.event;
      await authorize(
        database,
        options,
        envelope.context,
        "execute",
        "agent",
        envelope.agentId
      );
      const definition = unwrap(
        await createAgentRepository(database).get(
          envelope.organizationId,
          envelope.agentId,
          "latest",
          effect
        )
      );
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${envelope.sessionId}))`
        );
        const [prior] = await tx
          .select()
          .from(channelFixtureRun)
          .where(eq(channelFixtureRun.eventId, envelope.eventId));
        if (prior) {
          if (
            classifyEventDelivery(prior.envelope, envelope) !== "duplicate" ||
            prior.operationId !== effect.operationId ||
            prior.digest !== effect.requestDigest
          ) {
            return {
              code: "digest-mismatch",
              reason: "The fixture event has different content.",
              status: "conflict",
            };
          }
          return {
            status: "ok",
            value: {
              acceptedEventId: envelope.eventId,
              replayed: true,
              runId: id.run(prior.runId),
              sessionId: envelope.sessionId,
            },
          };
        }
        const runId = id.run(`run:${envelope.eventId}`);
        const requiresApproval =
          envelope.event.type === "user.message" &&
          /\bapproval\b/iu.test(envelope.event.payload.text);
        await item(tx, envelope, `${runId}:user`, {
          eventId: envelope.eventId,
          runId,
          text:
            envelope.event.type === "user.message"
              ? envelope.event.payload.text
              : "Scheduled fixture request",
          type: "user",
        });
        await item(tx, envelope, `${runId}:tool:start`, {
          name: "Read pilot source",
          runId,
          state: "running",
          toolId: FIXTURE_TOOL_ID,
          type: "tool",
        });
        let state: RunState;
        if (requiresApproval) {
          state = { runId, state: "waiting-for-approval" };
          await item(tx, envelope, `${runId}:approval`, {
            approvalId: `approval:${runId}`,
            runId,
            type: "approval",
          });
          await item(tx, envelope, `${runId}:waiting`, {
            run: state,
            runId,
            type: "run",
          });
        } else {
          state = await complete(tx, envelope, runId, now());
        }
        await tx.insert(channelFixtureRun).values({
          agentVersion: definition.version,
          conversationId: envelope.conversationId,
          digest: effect.requestDigest,
          envelope,
          eventId: envelope.eventId,
          operationId: effect.operationId,
          organizationId: envelope.organizationId,
          runId,
          state,
        });
        return {
          status: "ok",
          value: {
            acceptedEventId: envelope.eventId,
            replayed: false,
            runId,
            sessionId: envelope.sessionId,
          },
        };
      });
    },
  };
  return service;
};
export const sessionServiceFor = (
  database: Database,
  options: ChannelOptions
): SessionService => {
  if (options.sessions) {
    return options.sessions(database);
  }
  if (options.mode !== "fixture") {
    throw new ChannelError(
      503,
      "unavailable",
      "The session adapter is not configured."
    );
  }
  return createFixtureSessionService(database, options);
};
