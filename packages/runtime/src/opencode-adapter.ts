import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";

export interface FixtureModelEnvironment {
  readonly FIXTURE_URL: string;
  readonly DEPLOY_MODE: "fixture" | "production";
}

export interface ModelToolCall {
  readonly callId: string;
  readonly messageId: string;
  readonly input: unknown;
}

export const createOpenCodeClient = async (
  storage: DurableObjectStorage,
  env: FixtureModelEnvironment,
  executeTool: (call: ModelToolCall) => Promise<{ content: string }>
): Promise<OpenCodeWorkerd.Interface> => {
  if (env.DEPLOY_MODE !== "fixture") {
    throw new Error("The fixture model is forbidden in production");
  }
  return await OpenCodeWorkerd.create({
    config: {
      model: "fixture/controlled",
      permissions: [
        { action: "*", effect: "deny", resource: "*" },
        { action: "fixture_effect", effect: "allow", resource: "*" },
      ],
      providers: {
        fixture: {
          models: {
            controlled: {
              capabilities: { input: ["text"], output: ["text"], tools: true },
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
      {
        id: "cerebro-session-runtime",
        setup: async (context) => {
          await context.tool.hook("execute.before", (event) => {
            if (event.tool !== "fixture_effect") {
              throw new Error("Only fixture_effect is permitted");
            }
            return Promise.resolve();
          });
          await context.tool.transform((draft) => {
            for (const tool of draft.list()) {
              draft.remove(tool.id);
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
