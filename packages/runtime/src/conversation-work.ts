import type { EventAddress } from "@cerebro/contracts/events";
import { NotFound } from "@cerebro/contracts/failures";
import type { ChatChild } from "@cerebro/contracts/session-service";
import { isInternalToolName } from "@cerebro/tools/tool-names";
import { Type } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  GenerationTask,
  defineDoc,
  defineTool,
  hook,
} from "@earendil-works/pi-durable";
import type {
  ConversationId,
  Cursor,
  Harness,
  JsonObject,
  TaskId,
  ToolExecutionApi,
  ToolRegistration,
} from "@earendil-works/pi-durable";

import { chatPresentation, piContext } from "./pi-harness.ts";

export interface SearchResult {
  readonly matches: readonly {
    readonly conversationId: string;
    readonly entryId: string;
    readonly role: "user" | "assistant";
    readonly snippet: string;
  }[];
  readonly truncated: boolean;
}

interface ChildRecord extends JsonObject {
  nativeId: ConversationId;
  ownerTaskId: TaskId;
  callId: string;
  purpose: "delegate" | "history";
  title: string;
  deadlineAt: number;
}

const Children = defineDoc({
  fork: "initial",
  history: "latest",
  initial: (): { children: ChildRecord[] } => ({ children: [] }),
  kind: "cerebro.children",
  scope: "conversation",
  version: 1,
});

const CHILD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_CHILDREN = 3;
const MAX_RETAINED_CHILDREN = 32;
const MAX_ROUNDS = 8;
const DISPLAY_CHILDREN = 16;
const DISPLAY_ITEMS = 24;
const DISPLAY_TEXT = 2000;
const childId = (child: ChildRecord): string => `child:${child.nativeId}`;
const requestId = (child: ChildRecord): string =>
  `${child.purpose}:${child.ownerTaskId}`;
const removedTools = new Set([
  "subagent",
  "search_history",
  "search_conversations",
  "schedule",
  "cancel_schedule",
]);

export interface ConversationWorkOptions {
  readonly pi: Harness;
  readonly nativeId: ConversationId;
  readonly address: EventAddress;
  readonly authorize: (signal?: AbortSignal) => Promise<void>;
  readonly search: (
    term: string,
    signal?: AbortSignal
  ) => Promise<SearchResult>;
  readonly ensureDeadline: (
    childId: string,
    deadlineAt: number
  ) => Promise<void>;
}

export const createConversationWork = (options: ConversationWorkOptions) => {
  const records = async (): Promise<readonly ChildRecord[]> => {
    const document = await options.pi.snapshot(
      Children,
      options.nativeId,
      piContext()
    );
    return document?.children ?? [];
  };

  const find = async (id: string): Promise<ChildRecord> => {
    const children = await records();
    const child = children.find((record) => childId(record) === id);
    if (!child) {
      throw new NotFound({ resource: "Child conversation" });
    }
    return child;
  };

  const completedRounds = async (
    nativeId: ConversationId,
    context: Parameters<Harness["conversation"]>[1]
  ): Promise<number> => {
    const native = await options.pi.conversation(nativeId, context);
    if (!native) {
      return MAX_ROUNDS;
    }
    let cursor: Cursor | undefined;
    let count = 0;
    do {
      // oxlint-disable-next-line no-await-in-loop -- Count durable responses across resets and compaction, one bounded page at a time.
      const page = await native.entries({}, 64, cursor, context);
      count += page.items.filter(AssistantEntry.is).length;
      cursor = page.next;
    } while (cursor && count < MAX_ROUNDS);
    return count;
  };

  const runChild = async (
    purpose: ChildRecord["purpose"],
    text: string,
    api: ToolExecutionApi,
    context: Parameters<ToolExecutionApi["agent"]>[0]
  ) => {
    await options.authorize(context.abortSignal);
    if (api.conversationId !== options.nativeId) {
      throw new Error("A child cannot delegate work.");
    }
    const child = await api.commit(async (tx) => {
      const document = await tx.doc(Children, options.nativeId);
      const existing = document.children.find(
        (record: ChildRecord) => record.ownerTaskId === api.taskId
      );
      if (existing) {
        return { ...existing };
      }
      if (document.children.length >= MAX_RETAINED_CHILDREN) {
        throw new Error("This conversation has reached its 32-child limit.");
      }
      let active = 0;
      for (const record of document.children) {
        // oxlint-disable-next-line no-await-in-loop -- Count native owners inside the same creation transaction.
        const owner = await tx.task(record.ownerTaskId);
        if (owner && owner.state.status !== "terminal") {
          active += 1;
        }
      }
      if (active >= MAX_CHILDREN) {
        throw new Error("This conversation already has three active children.");
      }
      const created = await tx.createConversation({
        ownership: { kind: "task", taskId: api.taskId },
      });
      const agent = await tx.doc(AgentDoc, created.id);
      if (purpose === "history") {
        agent.tools = ["search_conversations"];
        agent.modelTools = ["search_conversations"];
        agent.instructions =
          "Answer the delegated question using search_conversations. " +
          "Try relevant terms. Use only returned evidence, cite conversation IDs, " +
          "and say when no relevant evidence was found. Reply briefly.";
      } else {
        agent.tools = Array.isArray(agent.tools)
          ? agent.tools.filter((name: string) => !removedTools.has(name))
          : {
              remove: [
                ...new Set([...(agent.tools?.remove ?? []), ...removedTools]),
              ],
            };
      }
      const record: ChildRecord = {
        callId: api.callId,
        deadlineAt: Date.now() + CHILD_TIMEOUT_MS,
        nativeId: created.id,
        ownerTaskId: api.taskId,
        purpose,
        title: text.slice(0, 160),
      };
      document.children.push(record);
      return record;
    }, context);
    if (child.deadlineAt <= Date.now()) {
      throw new Error("The child execution deadline expired.");
    }
    await options.ensureDeadline(childId(child), child.deadlineAt);
    await api.details({ childId: childId(child) }, context);
    const conversation = await api.conversation(child.nativeId, context);
    if (!conversation) {
      throw new NotFound({ resource: "Child conversation" });
    }
    const submission = await conversation.submit(
      { content: text, requestId: requestId(child), type: "input" },
      context
    );
    const settled = await submission.wait(context);
    await options.authorize(context.abortSignal);
    if (settled.status !== "done" || settled.type !== "input") {
      return {
        isError: true,
        output: [
          {
            text: "The child did not complete its answer.",
            type: "text" as const,
          },
        ],
      };
    }
    const answer = await api.commit(
      (tx) => tx.entry(AssistantEntry, settled.answer),
      context
    );
    const message = answer?.model?.[0];
    if (message?.role !== "assistant") {
      throw new NotFound({ resource: "Child answer" });
    }
    return {
      output: message.content.filter((part) => part.type === "text"),
    };
  };

  const searchConversations = defineTool({
    callers: ["model"],
    deferred: true,
    description:
      "Find permitted user and assistant messages containing a word or phrase. " +
      "Returns bounded excerpts and conversation IDs.",
    execute: async ({ term }, api, context) => {
      const children = await records();
      const child = children.find(
        (record) =>
          record.nativeId === api.conversationId && record.purpose === "history"
      );
      if (!child) {
        throw new Error("History search requires a search child.");
      }
      await options.authorize(context.abortSignal);
      const result = await options.search(term, context.abortSignal);
      return {
        output: [{ text: JSON.stringify(result), type: "text" }],
      };
    },
    name: "search_conversations",
    parameters: Type.Object({
      term: Type.String({ maxLength: 512, minLength: 1 }),
    }),
    replay: "safe",
  });
  const tools: ToolRegistration[] = [
    defineTool({
      callers: ["model"],
      description:
        "Delegate a self-contained task to a foreground subagent and return its answer. " +
        "The child uses this conversation's permissions and tools, has no parent transcript, " +
        "and cannot delegate or schedule work.",
      execute: ({ task }, api, context) =>
        runChild("delegate", task, api, context),
      name: "subagent",
      outputLimits: { maxBytes: 16_000, maxLines: 200 },
      parameters: Type.Object({
        task: Type.String({ maxLength: 16_000, minLength: 1 }),
      }),
      replay: "safe",
    }),
    defineTool({
      callers: ["model"],
      description:
        "Ask a bounded search subagent about earlier permitted conversations. " +
        "The answer cites the conversations used as evidence.",
      execute: ({ question }, api, context) =>
        runChild("history", question, api, context),
      name: "search_history",
      outputLimits: { maxBytes: 16_000, maxLines: 200 },
      parameters: Type.Object({
        question: Type.String({ maxLength: 4000, minLength: 1 }),
      }),
      replay: "safe",
    }),
    searchConversations,
  ];

  return {
    children: async (): Promise<ChatChild[]> => {
      const children = await records();
      return Promise.all(
        children
          .slice(-DISPLAY_CHILDREN)
          .map(async (child): Promise<ChatChild> => {
            const native = await options.pi.conversation(
              child.nativeId,
              piContext()
            );
            if (!native) {
              throw new NotFound({ resource: "Child conversation" });
            }
            const watch = await native.watch(piContext());
            try {
              const snapshot = chatPresentation(watch.value);
              let displayBudget = 16_000;
              const retain = (text: string): string => {
                const retained = text.slice(
                  0,
                  Math.min(DISPLAY_TEXT, displayBudget)
                );
                displayBudget -= retained.length;
                return retained;
              };
              const [owner, submission] = await options.pi.commit(
                (tx) =>
                  Promise.all([
                    tx.task(child.ownerTaskId),
                    tx.submissionByRequest(child.nativeId, requestId(child)),
                  ]),
                piContext()
              );
              let state: ChatChild["state"] = "running";
              if (submission?.status === "done") {
                state = "succeeded";
              } else if (submission?.status === "unanswered") {
                state =
                  submission.reason === "aborted" ? "interrupted" : "failed";
              } else if (owner?.state.status === "terminal") {
                state =
                  owner.state.outcome.status === "aborted"
                    ? "interrupted"
                    : "failed";
              }
              return {
                callId: child.callId,
                id: childId(child),
                messages: snapshot.messages
                  .slice(-DISPLAY_ITEMS)
                  .map((message) => ({
                    ...message,
                    text: retain(message.text),
                    ...(message.thinking
                      ? { thinking: retain(message.thinking) }
                      : {}),
                  })),
                ownerTaskId: String(child.ownerTaskId),
                purpose: child.purpose,
                state,
                title: child.title,
                tools: snapshot.tools.slice(-DISPLAY_ITEMS).map((tool) => {
                  const argumentsText = JSON.stringify(tool.arguments);
                  const rendered = retain(argumentsText);
                  return {
                    ...tool,
                    arguments:
                      rendered === argumentsText ? tool.arguments : rendered,
                    output: retain(tool.output),
                  };
                }),
              };
            } finally {
              await watch.stop();
            }
          })
      );
    },
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async (_request, api, context) => {
          if (api.conversationId === options.nativeId) {
            return;
          }
          const document = await api.snapshot(
            Children,
            options.nativeId,
            context
          );
          const child = document?.children.find(
            (record) => record.nativeId === api.conversationId
          );
          if (
            !child ||
            child.deadlineAt <= Date.now() ||
            (await completedRounds(api.conversationId, context)) >= MAX_ROUNDS
          ) {
            const signal = context.abortSignal;
            if (!signal) {
              throw new Error(
                "The child invocation has no cancellation signal."
              );
            }
            const interrupted = Promise.withResolvers<boolean>();
            if (signal.aborted) {
              interrupted.resolve(true);
            } else {
              signal.addEventListener(
                "abort",
                () => interrupted.resolve(true),
                {
                  once: true,
                }
              );
            }
            // abortTask joins the invocation, so join its signal here instead of waiting for ourselves.
            await Promise.race([
              options.pi.abortTask(api.taskId, piContext()),
              interrupted.promise,
            ]);
            throw new Error("The child execution limit was reached.");
          }
        },
      }),
    ],
    known: async () => {
      const children = await records();
      return children.map((child) => ({
        deadlineAt: child.deadlineAt,
        id: childId(child),
        nativeId: child.nativeId,
        ownerTaskId: child.ownerTaskId,
      }));
    },
    stop: async (id: string): Promise<boolean> => {
      const child = await find(id);
      return (
        (await options.pi.abortTask(child.ownerTaskId, piContext())) ===
        "marked"
      );
    },
    toolIds: async (): Promise<readonly string[]> => {
      const ids = new Set<string>();
      const children = await records();
      for (const child of children) {
        // oxlint-disable-next-line no-await-in-loop -- Read each retained child's complete tool history before display limits apply.
        const native = await options.pi.conversation(
          child.nativeId,
          piContext()
        );
        if (!native) {
          throw new NotFound({ resource: "Child conversation" });
        }
        let cursor: Cursor | undefined;
        do {
          // oxlint-disable-next-line no-await-in-loop -- Read complete history so compaction cannot remove an authorization dependency.
          const page = await native.entries({}, 64, cursor, piContext());
          for (const entry of page.items) {
            for (const message of entry.model ?? []) {
              if (
                message.role === "toolResult" &&
                !isInternalToolName(message.toolName)
              ) {
                ids.add(message.toolName);
              } else if (message.role === "assistant") {
                for (const part of message.content) {
                  if (
                    part.type === "toolCall" &&
                    !isInternalToolName(part.name)
                  ) {
                    ids.add(part.name);
                  }
                }
              }
            }
          }
          cursor = page.next;
        } while (cursor);
      }
      return [...ids];
    },
    tools,
  };
};
