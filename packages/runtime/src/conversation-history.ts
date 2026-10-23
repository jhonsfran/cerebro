/* oxlint-disable no-await-in-loop -- History pages have cursor dependencies and share one bounded scan budget. */
import type { EventAddress } from "@cerebro/contracts/events";
import { Denied, InvalidInput, NotFound } from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { ChatSnapshot } from "@cerebro/contracts/session-service";
import { AssistantEntry, UserEntry } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  Cursor,
  EntryRecord,
} from "@earendil-works/pi-durable";
import { Effect, Result } from "effect";

import type { SearchResult } from "./conversation-work.ts";
import { piContext, snapshotToolIds } from "./pi-harness.ts";
import type {
  MetadataTransaction,
  SessionHostConfiguration,
} from "./session-agent.ts";

export interface HistoryScope {
  readonly native: Conversation;
  readonly runtime: {
    readonly configuration: Pick<
      SessionHostConfiguration,
      | "address"
      | "agent"
      | "ownerContext"
      | "authority"
      | "tools"
      | "contentDependencies"
      | "inheritDependencies"
    >;
    readonly authorize: (
      context: ExecutionContext,
      operation: "read" | "send",
      signal?: AbortSignal
    ) => Promise<void>;
  };
  readonly read: (
    context: ExecutionContext,
    signal?: AbortSignal
  ) => Promise<ChatSnapshot>;
}

const permanent = (error: unknown): boolean =>
  error instanceof Denied ||
  error instanceof NotFound ||
  error instanceof InvalidInput;
const run = async <A>(
  program: Effect.Effect<A, ContractFailure>
): Promise<A> => {
  const result = await Effect.runPromise(Effect.result(program));
  if (Result.isFailure(result)) {
    throw result.failure;
  }
  return result.success;
};
type Match = SearchResult["matches"][number];
const turnMatches = (
  turn: readonly EntryRecord[],
  nativeId: ConversationId,
  conversationId: string,
  needle: string
): Match[] => {
  if (
    turn.some((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some(
            (part) => part.type === "toolCall" && part.name === "search_history"
          )
      )
    )
  ) {
    return [];
  }
  const matches: Match[] = [];
  for (const entry of turn) {
    if (
      entry.conversationId !== nativeId ||
      !(UserEntry.is(entry) || AssistantEntry.is(entry))
    ) {
      continue;
    }
    for (const message of entry.model ?? []) {
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("");
      const index = text.toLowerCase().indexOf(needle);
      if (index !== -1) {
        matches.push({
          conversationId,
          entryId: String(entry.id),
          role: message.role,
          snippet: text.slice(
            Math.max(0, index - 120),
            index + needle.length + 300
          ),
        });
      }
    }
  }
  return matches;
};

const scan = async (
  source: HistoryScope,
  needle: string,
  budget: { entries: number; matches: number },
  signal?: AbortSignal
) => {
  const matches: Match[] = [];
  let cursor: Cursor | undefined;
  let turn: EntryRecord[] = [];
  do {
    const page = await source.native.entries(
      {},
      100,
      cursor,
      piContext(signal)
    );
    for (const entry of page.items) {
      budget.entries -= 1;
      turn.push(entry);
      if (UserEntry.is(entry)) {
        const found = turnMatches(
          turn,
          source.native.id,
          source.runtime.configuration.address.conversationId,
          needle
        );
        matches.push(...found.slice(0, budget.matches));
        budget.matches -= Math.min(found.length, budget.matches);
        turn = [];
      }
      if (budget.entries <= 0 || budget.matches <= 0) {
        return { matches, truncated: true };
      }
    }
    cursor = page.next;
  } while (cursor);
  return { matches, truncated: false };
};

export const searchConversationHistory = async (
  services: {
    readonly target: HistoryScope;
    readonly addresses: readonly EventAddress[];
    readonly open: (address: EventAddress) => Promise<HistoryScope>;
    readonly metadata: MetadataTransaction;
    readonly persist: () => Promise<void>;
  },
  term: string,
  signal?: AbortSignal
): Promise<SearchResult> => {
  const needle = term.trim().toLowerCase();
  if (!needle || needle.length > 512) {
    throw new InvalidInput({
      reason: "Use a history search term between 1 and 512 characters.",
    });
  }
  const { target } = services;
  const { address, agent, authority, inheritDependencies } =
    target.runtime.configuration;
  const owner = await run(target.runtime.configuration.ownerContext());
  await target.runtime.authorize(owner, "send", signal);
  const matches: Match[] = [];
  const budget = { entries: 2000, matches: 30 };
  let truncated = services.addresses.length > 100;
  for (const candidate of services.addresses.slice(0, 100)) {
    signal?.throwIfAborted();
    try {
      const source = await services.open(candidate);
      await source.read(owner, signal);
      const found = await scan(source, needle, budget, signal);
      truncated ||= found.truncated;
      if (found.matches.length > 0) {
        const snapshot = await source.read(owner, signal);
        const dependencies =
          await source.runtime.configuration.contentDependencies?.();
        const toolIds = [
          ...new Set([
            ...snapshotToolIds(snapshot),
            ...(dependencies?.toolIds ?? []),
          ]),
        ];
        await Promise.all(
          toolIds.map((toolId) => {
            const registered = target.runtime.configuration.tools.find(
              (tool) => tool.definition.id === toolId
            );
            if (!registered) {
              throw new Denied({
                code: "unauthorized",
                reason: "The receiving agent cannot read a history tool.",
              });
            }
            return run(
              authority.require(
                {
                  action: "read",
                  address,
                  context: owner,
                  pinnedAgent: agent,
                  resource: {
                    id: toolId,
                    kind: "tool",
                    organizationId: address.organizationId,
                  },
                  tool: registered.definition,
                },
                { deadlineAt: Date.now() + 30_000, signal }
              )
            );
          })
        );
        await Promise.all(
          (dependencies?.sourceIds ?? []).map((sourceId) =>
            run(
              authority.require(
                {
                  action: "read",
                  address,
                  context: owner,
                  pinnedAgent: agent,
                  resource: {
                    id: sourceId,
                    kind: "memory",
                    organizationId: address.organizationId,
                  },
                },
                { deadlineAt: Date.now() + 30_000, signal }
              )
            )
          )
        );
        await services.metadata(() =>
          inheritDependencies?.(candidate, toolIds, true)
        );
        await services.persist();
        await target.runtime.authorize(owner, "send", signal);
        matches.push(...found.matches);
      }
    } catch (error) {
      if (!permanent(error)) {
        throw error;
      }
    }
    if (budget.entries <= 0 || budget.matches <= 0) {
      break;
    }
  }
  return { matches, truncated };
};
