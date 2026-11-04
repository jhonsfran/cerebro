import { digestToolArguments } from "@cerebro/contracts/tools";
import { listMcpTools } from "@cerebro/tools/mcp";
import type { McpTool } from "@cerebro/tools/mcp";

import { createCatalogRegistry, parseCatalogTool } from "./config.ts";
import type { CatalogTool } from "./config.ts";

interface McpConnector {
  readonly id: string;
  readonly url: string;
  readonly readTools: readonly string[];
}

const MAX_INPUT_BYTES = 65_536;
const MAX_OUTPUT_BYTES = 262_144;

// Model tool names allow 64 characters of [A-Za-z0-9_-].
const toolId = (connectorId: string, name: string): string =>
  `${connectorId}_${name}`.replaceAll(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);

// Only a tool the connector owner lists in readTools is a read. Every other tool
// is a write and needs approval, because annotations come from the server and
// never decide a safety property. The version changes whenever the server's
// description of the tool changes, which invalidates pending approvals for it.
export const catalogToolFromMcp = async (
  connector: McpConnector,
  tool: McpTool
): Promise<CatalogTool> => {
  const effect = connector.readTools.includes(tool.name) ? "read" : "write";
  return parseCatalogTool({
    connectorId: connector.id,
    description: tool.description ?? tool.title ?? tool.name,
    effect,
    id: toolId(connector.id, tool.name),
    inputSchema: tool.inputSchema,
    maxInputBytes: MAX_INPUT_BYTES,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    outputSchema: tool.outputSchema ?? {},
    requiresApproval: effect === "write",
    retryMode: effect === "read" ? "idempotent" : "at-most-once",
    target: { kind: "mcp", method: tool.name, url: connector.url },
    version: await digestToolArguments({
      annotations: tool.annotations ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema,
      name: tool.name,
      outputSchema: tool.outputSchema ?? null,
    }),
  });
};

// A tool the registry cannot load is skipped, so one bad tool cannot stop the
// connector's other tools or break a session.
export const discoverMcpTools = async (
  connector: McpConnector,
  headers: Readonly<Record<string, string>>,
  mode: "local" | "production",
  fetch?: typeof globalThis.fetch
): Promise<{
  readonly tools: readonly CatalogTool[];
  readonly skipped: readonly string[];
}> => {
  const listed = await listMcpTools({
    headers,
    url: connector.url,
    ...(fetch ? { fetch } : {}),
  });
  const tools: CatalogTool[] = [];
  const skipped: string[] = [];
  for (const tool of listed) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Each tool is checked against the ones already accepted.
      const candidate = await catalogToolFromMcp(connector, tool);
      createCatalogRegistry([...tools, candidate], mode);
      tools.push(candidate);
    } catch {
      skipped.push(tool.name);
    }
  }
  return { skipped, tools };
};
