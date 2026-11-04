import { Denied, InvalidInput } from "@cerebro/contracts/failures";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { Type } from "@earendil-works/pi-ai";
import { AssistantEntry, defineTool } from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";

import type { TeamRole } from "./team-role.ts";
import { TeamState, requireTeamRunning } from "./team-state.ts";

export const createTeamWorkerTool = (options: {
  readonly pi: Harness;
  readonly lead: TeamRole;
  readonly workers: readonly TeamRole[];
  readonly now: () => number;
}) =>
  defineTool({
    callers: ["model"],
    name: "delegate_worker",
    replay: "safe",
    description:
      "Delegate one bounded read-only question to a worker. The team has at most two worker conversations and one shared model call budget.",
    parameters: Type.Object({
      text: Type.String({ minLength: 1, maxLength: 16_000 }),
    }),
    execute: async ({ text }, api, context) => {
      const dependencies = await options.lead.dependencies();
      await options.lead.permit(dependencies, context.abortSignal);
      const digest = await digestToolArguments(text);
      const selected = await api.commit(async (tx) => {
        const current = await tx.doc(TeamState);
        requireTeamRunning(current, options.now());
        if (current.lead !== api.conversationId) {
          throw new Denied({
            code: "unauthorized",
            reason: "Only the team lead can delegate.",
          });
        }
        const existingIndex = current.workers.findIndex(
          (item) => item.ownerTaskId === api.taskId
        );
        let index = existingIndex;
        if (index === -1) {
          index = current.workers.findIndex(
            (item) => item.ownerTaskId === null
          );
        }
        const worker = current.workers[index];
        if (!worker) {
          throw new InvalidInput({
            reason: "The team worker limit was reached.",
          });
        }
        if (existingIndex !== -1 && worker.digest !== digest) {
          throw new InvalidInput({ reason: "The worker request changed." });
        }
        if (worker.ownerTaskId === null) {
          worker.ownerTaskId = api.taskId;
          worker.digest = digest;
          worker.requestId = `worker:${api.taskId}`;
          worker.inputDependencies = dependencies;
        }
        return {
          index,
          worker: {
            ...worker,
            inputDependencies: worker.inputDependencies
              ? {
                  sourceIds: [...worker.inputDependencies.sourceIds],
                  toolIds: [...worker.inputDependencies.toolIds],
                }
              : null,
          },
        };
      }, context);
      const { worker, index } = selected;
      const role = options.workers[index];
      if (!role || !worker.inputDependencies) {
        throw new InvalidInput({ reason: "The worker role is missing." });
      }
      const { inputDependencies } = worker;
      await role.permit(inputDependencies, context.abortSignal);
      await api.commit(async (tx) => {
        requireTeamRunning(await tx.doc(TeamState), options.now());
        role.configuration.importDependencies(inputDependencies);
      }, context);
      if (!worker.requestId) {
        throw new InvalidInput({ reason: "The worker request is missing." });
      }
      const native = await api.conversation(worker.nativeId, context);
      if (!native) {
        throw new InvalidInput({
          reason: "The worker conversation is missing.",
        });
      }
      const submission = await native.submit(
        { type: "input", content: text, requestId: worker.requestId },
        context
      );
      const settled = await submission.wait(context);
      if (settled.status !== "done" || settled.type !== "input") {
        return {
          isError: true,
          output: [
            { type: "text", text: "The worker did not complete its answer." },
          ],
        };
      }
      const resultDependencies = await role.dependencies();
      await role.permit(resultDependencies, context.abortSignal);
      await options.lead.permit(resultDependencies, context.abortSignal);
      const answer = await api.commit(async (tx) => {
        const current = await tx.doc(TeamState);
        requireTeamRunning(current, options.now());
        options.lead.configuration.importDependencies(resultDependencies);
        return await tx.entry(AssistantEntry, settled.answer);
      }, context);
      const message = answer?.model?.[0];
      const result =
        message?.role === "assistant"
          ? message.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("\n")
          : "";
      if (!result || result.length > 16_000) {
        return {
          isError: true,
          output: [
            {
              type: "text",
              text: "The worker answer is unavailable within the output limit.",
            },
          ],
        };
      }
      return { output: [{ type: "text", text: result }] };
    },
  });
