import type { EffectOptions } from "@cerebro/contracts/port";
import type { ToolCall } from "@cerebro/contracts/tools";
import type { Plugin } from "@opencode-ai/plugin";

import type { ToolBroker } from "./broker.ts";
import type { ToolRegistry } from "./registry.ts";

export interface ToolAttempt {
  readonly toolId: string;
  readonly input: unknown;
  readonly sessionId: string;
  readonly messageId: string;
  readonly callId: string;
}
export const createOpenCodeToolPlugin = (dependencies: {
  readonly registry: ToolRegistry;
  readonly broker: ToolBroker;
  readonly resolveAttempt: (
    attempt: ToolAttempt
  ) => Promise<{ readonly call: ToolCall; readonly options: EffectOptions }>;
}): Plugin.Plugin => ({
  id: "cerebro-tool-broker",
  async setup(context) {
    const tools = dependencies.registry.list();
    const names = new Set(tools.map((tool) => tool.definition.id));
    const before = await context.tool.hook("execute.before", (event) => {
      if (![...names].some((name) => name === event.tool)) {
        throw new Error(
          "Tool execution must use a registered Cerebro broker tool."
        );
      }
    });
    const transformed = await context.tool.transform((draft) => {
      for (const entry of draft.list()) {
        draft.remove(entry.id);
      }
      for (const entry of tools) {
        draft.add({
          description: entry.description,
          async execute(input, toolContext) {
            const normalized = entry.prepareArguments(input);
            const resolved = await dependencies.resolveAttempt({
              callId: toolContext.id,
              input: normalized,
              messageId: toolContext.messageID,
              sessionId: toolContext.sessionID,
              toolId: entry.definition.id,
            });
            if (resolved.call.tool.id !== entry.definition.id) {
              throw new Error(
                "Runtime attempt resolver returned a different tool."
              );
            }
            const result = await dependencies.broker.invoke(
              resolved.call,
              resolved.options
            );
            if (result.status !== "ok") {
              throw new Error(
                `Broker rejected tool execution: ${result.status}`
              );
            }
            return { content: JSON.stringify(result.value.output) };
          },
          input: entry.inputJsonSchema,
          name: entry.definition.id,
          options: { codemode: false },
        });
      }
    });
    return async () => {
      await transformed.dispose();
      await before.dispose();
    };
  },
});
