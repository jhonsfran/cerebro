import type { SessionReceipt } from "@cerebro/contracts";
import { withReservedDatabase } from "@cerebro/db";
import { channelInbox } from "@cerebro/db/schema/agents";
import { eq, sql } from "drizzle-orm";

import { ChannelError, EFFECT_DEADLINE_MS } from "./types";
import type { ChannelOptions } from "./types";

type InboxEntry = typeof channelInbox.$inferSelect;

export const submitInbox = async (
  options: ChannelOptions,
  eventKey: string,
  submit: (entry: InboxEntry) => Promise<SessionReceipt>
): Promise<{ receipt: SessionReceipt; submitted: boolean }> => {
  const result = await options.withDatabase((database) =>
    withReservedDatabase(database, async (connection) => {
      await connection.execute(
        sql`select set_config('lock_timeout', ${`${EFFECT_DEADLINE_MS}ms`}, false)`
      );
      await connection.execute(
        sql`select pg_advisory_lock(hashtext(${eventKey}))`
      );
      try {
        const [entry] = await connection
          .select()
          .from(channelInbox)
          .where(eq(channelInbox.eventKey, eventKey));
        if (!entry) {
          return {
            error: new ChannelError(
              404,
              "not-found",
              "The inbox event was not found."
            ),
          };
        }
        if (entry.state === "denied" || entry.state === "quarantined") {
          return {
            error: new ChannelError(
              403,
              "forbidden",
              "The event was denied or retired. Submit a new event after access is restored."
            ),
          };
        }
        if (entry.receipt) {
          return {
            receipt: { ...entry.receipt, replayed: true },
            submitted: false,
          };
        }
        await connection
          .update(channelInbox)
          .set({ lastAttemptAt: new Date((options.now ?? Date.now)()) })
          .where(eq(channelInbox.eventKey, eventKey));
        try {
          const receipt = await submit(entry);
          await connection
            .update(channelInbox)
            .set({ receipt, state: "accepted" })
            .where(eq(channelInbox.eventKey, eventKey));
          return { receipt, submitted: true };
        } catch (error) {
          if (
            error instanceof ChannelError &&
            (error.status === 403 ||
              (error.status === 409 && error.code === "UnknownOutcome"))
          ) {
            await connection
              .update(channelInbox)
              .set({ state: "denied" })
              .where(eq(channelInbox.eventKey, eventKey));
          }
          return { error };
        }
      } finally {
        await connection.execute(
          sql`select pg_advisory_unlock(hashtext(${eventKey}))`
        );
      }
    })
  );
  if ("error" in result) {
    throw result.error;
  }
  return result;
};
