import type { Plugin } from "@opencode-ai/plugin";
import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";

import type { StoredRun } from "./ledger.ts";
import type { PinnedAgentConfig } from "./pinned-agent.ts";
import type { RuntimePorts } from "./runtime-ports.ts";

export interface FixtureModelEnvironment {
  readonly FIXTURE_URL: string;
  readonly DEPLOY_MODE: "local" | "fixture" | "production";
}

export interface ModelToolCall {
  readonly callId: string;
  readonly messageId: string;
  readonly input: unknown;
  readonly toolId?: string;
}

export const fixturePrompt = (run: StoredRun): string =>
  `${run.agent.instructions}\noperationId=${run.operationId} ${run.prompt} Call fixture_effect once with value approved-fixture, then reply Cerebro fixture completed.`;

export const fixtureReplyMatches = (reply: string): boolean =>
  reply === "Cerebro fixture completed.";

export const createOpenCodeClient = async (
  storage: DurableObjectStorage,
  env: FixtureModelEnvironment,
  agent: PinnedAgentConfig,
  executeTool: (call: ModelToolCall) => Promise<{ content: string }>,
  runtime?: {
    readonly ports: RuntimePorts;
    readonly modelPlugin: Plugin.Plugin;
  }
): Promise<OpenCodeWorkerd.Interface> => {
  if (
    !runtime &&
    (env.DEPLOY_MODE !== "fixture" || agent.model !== "fixture/controlled")
  ) {
    throw new Error("The fixture model is forbidden in production");
  }
  return await OpenCodeWorkerd.create({
    config: {
      ...(runtime ? { compaction: { auto: false } } : {}),
      model: runtime?.ports.model.id ?? "fixture/controlled",
      permissions: [
        { action: "*", effect: "deny", resource: "*" },
        ...(runtime
          ? runtime.ports.registry.list().map((entry) => ({
              action: entry.definition.id,
              effect: "allow" as const,
              resource: "*",
            }))
          : [
              {
                action: "fixture_effect",
                effect: "allow" as const,
                resource: "*",
              },
            ]),
      ],
      providers: runtime
        ? {
            [runtime.ports.model.provider]: {
              models: {
                [runtime.ports.model.model]: {
                  capabilities: {
                    input: ["text"],
                    output: ["text"],
                    tools: true,
                  },
                  limit: {
                    context: runtime.ports.model.maxInputBytes,
                    output: runtime.ports.model.maxOutputTokens,
                  },
                  name: runtime.ports.model.id,
                },
              },
              package: "@opencode-ai/ai/providers/openai-compatible",
              settings: {
                apiKey: runtime.ports.model.apiKey,
                baseURL: runtime.ports.model.baseUrl,
              },
            },
          }
        : {
            fixture: {
              models: {
                controlled: {
                  capabilities: {
                    input: ["text"],
                    output: ["text"],
                    tools: true,
                  },
                  limit: { context: 32_768, output: 1024 },
                  name: "Controlled fixture",
                },
              },
              package: "@opencode-ai/ai/providers/openai-compatible",
              settings: { apiKey: "fixture", baseURL: `${env.FIXTURE_URL}/v1` },
            },
          },
    },
    models: { fetch: false },
    plugins: [
      ...(runtime ? [runtime.modelPlugin] : []),
      {
        id: "cerebro-session-runtime",
        setup: async (context) => {
          await context.tool.hook("execute.before", (event) => {
            if (
              runtime
                ? !runtime.ports.registry
                    .list()
                    .some((entry) => entry.definition.id === event.tool)
                : event.tool !== "fixture_effect"
            ) {
              throw new Error("Only fixture_effect is permitted");
            }
            return Promise.resolve();
          });
          await context.tool.transform((draft) => {
            for (const tool of draft.list()) {
              draft.remove(tool.id);
            }
            if (runtime) {
              for (const entry of runtime.ports.registry.list()) {
                draft.add({
                  description: entry.description,
                  execute: async (input, toolContext) =>
                    await executeTool({
                      callId: toolContext.id,
                      input: entry.prepareArguments(input),
                      messageId: toolContext.messageID,
                      toolId: entry.definition.id,
                    }),
                  input: entry.inputJsonSchema,
                  name: entry.definition.id,
                  options: { codemode: false },
                });
              }
              return;
            }
            draft.add({
              description: "Apply an approved fixture effect once.",
              execute: async (input, toolContext) =>
                await executeTool({
                  callId: toolContext.id,
                  input,
                  messageId: toolContext.messageID,
                }),
              input: {
                additionalProperties: false,
                properties: {
                  value: { const: "approved-fixture", type: "string" },
                },
                required: ["value"],
                type: "object",
              },
              name: "fixture_effect",
              options: { codemode: false },
            });
          });
        },
      },
    ],
    storage,
  });
};

export const readFinalReply = async (
  client: OpenCodeWorkerd.Interface,
  sessionId: string
): Promise<string | undefined> => {
  const messages = await client.message.list({
    order: "asc",
    sessionID: sessionId,
  });
  const assistant = messages.data.findLast(
    (message) => message.type === "assistant"
  );
  if (
    !assistant ||
    assistant.error ||
    assistant.finish === undefined ||
    assistant.finish === "tool-calls"
  ) {
    return undefined;
  }
  return assistant.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
};
