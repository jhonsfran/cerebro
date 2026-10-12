import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { Tool } from "@earendil-works/pi-mcp";

export type { Tool as McpTool } from "@earendil-works/pi-mcp";

export interface McpConnection {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly maxMessageBytes?: number;
}

// One short session per operation: initialize, one request, close. No GET
// stream, because Cerebro never waits for server-initiated messages.
const withMcp = async <A>(
  connection: McpConnection,
  run: (client: McpClient) => Promise<A>
): Promise<A> => {
  const client = new McpClient({ name: "cerebro", version: "0.0.0" });
  await client.connect(
    new StreamableHttpTransport({
      headers: { ...connection.headers },
      openGetStream: false,
      url: connection.url,
      ...(connection.fetch ? { fetch: connection.fetch } : {}),
      ...(connection.maxMessageBytes
        ? { maxMessageBytes: connection.maxMessageBytes }
        : {}),
    })
  );
  try {
    return await run(client);
  } finally {
    await client.close();
  }
};

export const listMcpTools = (connection: McpConnection): Promise<Tool[]> =>
  withMcp(connection, (client) =>
    client.listTools(connection.signal ? { signal: connection.signal } : {})
  );

// Returns the structured result when the tool provides one, else the whole
// result. A tool-reported error is a definite failure.
export const callMcpTool = async (
  connection: McpConnection,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> => {
  const result = await withMcp(connection, (client) =>
    client.callTool(
      name,
      args,
      connection.signal ? { signal: connection.signal } : {}
    )
  );
  if (result.isError) {
    throw new TypeError("MCP tool returned an error.");
  }
  return result.structuredContent ?? result;
};
