import { Denied, InvalidInput } from "@cerebro/contracts/failures";
import { BoundedContentDependenciesSchema } from "@cerebro/contracts/work";
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineTool,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

import { importContentIn } from "./imported-content.ts";
import type { TeamRole } from "./team-role.ts";
import {
  TeamState,
  requireTeamRunning,
  teamChildren,
  workerRequestId,
} from "./team-state.ts";

export type TeamWorker = TeamRole & {
  readonly agent: ReturnType<TeamRole["install"]>;
};

const failure = (text: string) => ({
  isError: true,
  output: [{ type: "text" as const, text }],
});

export const createTeamWorkerTool = (options: {
  readonly lead: TeamRole;
  readonly worker: (index: number) => Promise<TeamWorker>;
  readonly maxWorkers: number;
  readonly now: () => number;
}) =>
  defineTool({
    callers: ["model"],
    name: "delegate_worker",
    replay: "safe",
    description: `Delegate one bounded read-only question to a new worker conversation and return its answer. Call it several times in one turn to run workers in parallel. The team runs at most ${options.maxWorkers} workers at once and shares one model call budget.`,
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 16_000 }),
    }),
    execute: async ({ text }, api, context) => {
      const dependencies = Schema.decodeUnknownSync(
        BoundedContentDependenciesSchema
      )(await options.lead.dependencies());
      await options.lead.permit(dependencies, context.abortSignal);
      const claim = await api.commit(async (tx) => {
        const state = await tx.doc(TeamState);
        const work = requireTeamRunning(state, options.now());
        if (state.lead !== api.conversationId) {
          throw new Denied({
            code: "unauthorized",
            reason: "Only the team lead can delegate.",
          });
        }
        const children = teamChildren(state);
        const owned = children.find(
          (child) => child.ownerTaskId === api.taskId
        );
        if (owned) {
          return { kind: "started" as const, child: owned };
        }
        const index = children.length + 1;
        if (index > work.limits.maxTurns) {
          return { kind: "exhausted" as const };
        }
        const owners = await Promise.all(
          children.map((child) => tx.task(child.ownerTaskId))
        );
        const running = owners.filter(
          (task) => task && task.state.status !== "terminal"
        ).length;
        if (running >= work.limits.maxWorkers) {
          return { kind: "busy" as const, limit: work.limits.maxWorkers };
        }
        const created = await tx.createConversation({
          ownership: { kind: "task", taskId: api.taskId },
        });
        const child = {
          nativeId: created.id,
          ownerTaskId: api.taskId,
          startedAt: options.now(),
        };
        state.children[String(index)] = child;
        return { kind: "started" as const, child: { ...child, index } };
      }, context);
      if (claim.kind === "busy") {
        return failure(
          `The team already runs its maximum number of workers (${claim.limit}). Wait for their answers before delegating another question.`
        );
      }
      if (claim.kind === "exhausted") {
        return failure(
          "The team model call budget cannot start another worker. Combine the answers you have."
        );
      }
      const { child } = claim;
      const worker = await options.worker(child.index);
      await worker.permit(dependencies, context.abortSignal);
      await api.commit(async (tx) => {
        requireTeamRunning(await tx.doc(TeamState), options.now());
        await configure(tx, child.nativeId, worker.agent);
        await importContentIn(tx, child.nativeId, dependencies);
      }, context);
      await worker.reconcileImports(child.nativeId, {
        kind: "handoff",
        signal: context.abortSignal,
      });
      const native = await api.conversation(child.nativeId, context);
      if (!native) {
        throw new InvalidInput({
          reason: "The worker conversation is missing.",
        });
      }
      const submission = await native.submit(
        {
          type: "input",
          content: text,
          requestId: workerRequestId(child.ownerTaskId),
        },
        context
      );
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input") {
        return failure("The worker did not complete its answer.");
      }
      const resultDependencies = Schema.decodeUnknownSync(
        BoundedContentDependenciesSchema
      )(await worker.dependencies());
      await worker.permit(resultDependencies, context.abortSignal);
      await options.lead.permit(resultDependencies, context.abortSignal);
      const answer = await api.commit(async (tx) => {
        requireTeamRunning(await tx.doc(TeamState), options.now());
        await importContentIn(tx, api.conversationId, resultDependencies);
        return await tx.entry(AssistantEntry, settled.answer);
      }, context);
      await options.lead.reconcileImports(api.conversationId, {
        kind: "handoff",
        signal: context.abortSignal,
      });
      const message = answer?.model?.[0];
      const result =
        message?.role === "assistant"
          ? message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n")
          : "";
      if (!result || result.length > 16_000) {
        return failure(
          "The worker answer is unavailable within the output limit."
        );
      }
      return { output: [{ type: "text", text: result }] };
    },
  });
