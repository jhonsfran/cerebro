import { id } from "@cerebro/contracts";
import { createToolRegistry } from "@cerebro/tools/registry";
import { z } from "zod";

const positive = z.number().int().positive().max(1_048_576);
const modelSchema = z.strictObject({
  apiKey: z.string().min(1),
  baseUrl: z.url(),
  deadlineMs: positive,
  id: z.string().min(1),
  maxInputBytes: positive,
  maxOutputTokens: positive,
  model: z.string().min(1),
  provider: z.string().min(1),
});
const jsonSchema = z.custom<Parameters<typeof z.fromJSONSchema>[0]>(
  (value) =>
    typeof value === "boolean" ||
    Boolean(value && typeof value === "object" && !Array.isArray(value))
);
const toolSchema = z.strictObject({
  connectorId: z.string().min(1),
  credentials: z.strictObject({
    headers: z.record(z.string(), z.string()),
    secrets: z.array(z.string().min(1)),
  }),
  description: z.string().min(1),
  effect: z.enum(["read", "write"]),
  id: z.string().min(1),
  inputSchema: jsonSchema,
  maxInputBytes: positive,
  maxOutputBytes: positive,
  outputSchema: jsonSchema,
  requiresApproval: z.boolean(),
  retryMode: z.enum(["idempotent", "reconcile-only"]),
  target: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("mcp-read"),
      method: z.string().min(1),
      url: z.url(),
    }),
    z.strictObject({
      kind: z.literal("fixture-write"),
      method: z.string().min(1),
      url: z.url(),
    }),
  ]),
  version: z.string().min(1),
});
const schema = z.strictObject({
  artifacts: z.strictObject({
    accessKeyId: z.string().min(1),
    bucket: z.string().min(1),
    endpoint: z.url(),
    region: z.string().min(1),
    secretAccessKey: z.string().min(1),
  }),
  bootstrapToken: z.string().min(32).optional(),
  gatewaySigningKey: z.string().min(32),
  mode: z.enum(["local", "fixture", "production"]),
  models: z.array(modelSchema).min(1),
  retrievalMode: z.literal("full-text"),
  tools: z.array(toolSchema),
  trustedOwnerUserId: z.string().min(1).optional(),
});
export type RuntimeConfiguration = z.infer<typeof schema>;

export const createRuntimeRegistry = (config: RuntimeConfiguration) =>
  createToolRegistry(
    config.tools.map((tool) => ({
      definition: {
        connectorId: tool.connectorId,
        effect: tool.effect,
        id: id.tool(tool.id),
        version: tool.version,
      },
      description: tool.description,
      input: z.fromJSONSchema(tool.inputSchema),
      maxInputBytes: tool.maxInputBytes,
      maxOutputBytes: tool.maxOutputBytes,
      output: z.fromJSONSchema(tool.outputSchema),
      requiresApproval: tool.requiresApproval,
      retryMode: tool.retryMode,
      target: tool.target,
    })),
    config.mode
  );

const fixtureHost = (value: string): boolean => {
  const host = new URL(value).hostname;
  return (
    ["fixture", "localhost", "127.0.0.1", "[::1]"].includes(host) ||
    host.endsWith(".invalid")
  );
};
export const parseRuntimeConfiguration = (
  serialized: string,
  mode: "local" | "fixture" | "production"
): RuntimeConfiguration => {
  try {
    const config = schema.parse(JSON.parse(serialized));
    if (
      config.models.some((model) => {
        const url = new URL(model.baseUrl);
        return Boolean(url.username || url.password || url.hash || url.search);
      })
    ) {
      throw new Error(
        "Model URLs must not contain credentials, fragments, or queries."
      );
    }
    if (
      config.mode !== mode ||
      new Set(config.models.map((model) => model.id)).size !==
        config.models.length ||
      config.models.some(
        (model) => model.id !== `${model.provider}/${model.model}`
      )
    ) {
      throw new Error("Invalid runtime model configuration");
    }
    if (
      mode !== "fixture" &&
      !config.bootstrapToken &&
      !config.trustedOwnerUserId
    ) {
      throw new Error(
        "Local and production deployments require trusted setup credentials."
      );
    }
    if (
      mode !== "fixture" &&
      config.models.some(
        (model) =>
          model.id.startsWith("fixture") ||
          model.provider.startsWith("fixture") ||
          fixtureHost(model.baseUrl) ||
          new URL(model.baseUrl).protocol !== "https:"
      )
    ) {
      throw new Error(
        "Local and production models must use real HTTPS providers"
      );
    }
    if (
      mode !== "fixture" &&
      config.tools.some(
        (tool) =>
          tool.effect !== "read" ||
          tool.target.kind !== "mcp-read" ||
          fixtureHost(tool.target.url) ||
          tool.id.startsWith("fixture")
      )
    ) {
      throw new Error(
        "Local and production permit configured real read-only MCP tools"
      );
    }
    const connectorIdentities = new Map<string, string>();
    for (const tool of config.tools) {
      const identity = JSON.stringify({
        headers: Object.entries(tool.credentials.headers).toSorted(
          ([first], [second]) => first.localeCompare(second)
        ),
        origin: new URL(tool.target.url).origin,
      });
      const prior = connectorIdentities.get(tool.connectorId);
      if (prior && prior !== identity) {
        throw new Error("A connector has conflicting targets or credentials.");
      }
      connectorIdentities.set(tool.connectorId, identity);
    }
    const normalized = {
      ...config,
      tools: config.tools.map((tool) => ({
        ...tool,
        credentials: {
          ...tool.credentials,
          secrets: [
            ...new Set([
              ...tool.credentials.secrets,
              ...Object.values(tool.credentials.headers).flatMap((value) => [
                value,
                value.replace(/^(?:Bearer|Basic)\s+/iu, ""),
              ]),
            ]),
          ].filter(Boolean),
        },
      })),
    };
    createRuntimeRegistry(normalized);
    return normalized;
  } catch {
    throw new Error(
      "Runtime configuration is invalid or uses an unsupported provider or retrieval mode."
    );
  }
};
