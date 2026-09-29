import { z } from "zod";

import { readBoundedJson } from "./bounded-json.ts";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_CLIENT_VERSION = "0.0.0";
const unsafeHeaderCharacters = /[^\t\u0020-\u007E]/u;

export const encodeMcpHeader = (value: string): string => {
  if (
    !unsafeHeaderCharacters.test(value) &&
    value.trim() === value &&
    !(value.startsWith("=?base64?") && value.endsWith("?="))
  ) {
    return value;
  }
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${btoa(String.fromCodePoint(...bytes))}?=`;
};

export const mcpToolRequest = (
  name: string,
  argumentsValue: unknown,
  operationId: string
) => ({
  body: {
    id: operationId,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      _meta: {
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: "cerebro",
          version: MCP_CLIENT_VERSION,
        },
        "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        progressToken: operationId,
      },
      arguments: argumentsValue,
      name,
    },
  },
  headers: {
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    "Mcp-Method": "tools/call",
    "Mcp-Name": encodeMcpHeader(name),
  },
});

const callToolResult = z.strictObject({
  _meta: z.record(z.string(), z.unknown()).optional(),
  content: z.array(
    z.object({ text: z.string(), type: z.literal("text") }).passthrough()
  ),
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
const finalResponse = z.strictObject({
  id: z.string(),
  jsonrpc: z.literal("2.0"),
  result: callToolResult,
});
const notification = z.strictObject({
  jsonrpc: z.literal("2.0"),
  method: z.enum(["notifications/progress", "notifications/message"]),
  params: z.record(z.string(), z.unknown()),
});
type McpResult = z.infer<typeof callToolResult>;
const parseMessage = (
  value: unknown,
  operationId: string,
  allowNotification: boolean
): McpResult | undefined => {
  const notice = notification.safeParse(value);
  if (allowNotification && notice.success) {
    if (
      notice.data.method === "notifications/progress" &&
      notice.data.params.progressToken !== operationId
    ) {
      throw new Error("MCP progress does not match the request.");
    }
    return;
  }
  const response = finalResponse.parse(value);
  if (response.id !== operationId) {
    throw new Error("MCP result does not match the operation.");
  }
  if (response.result.isError) {
    throw new TypeError("MCP tool returned an error.");
  }
  return response.result;
};

const readSseResult = async (
  response: Response,
  maxBytes: number,
  operationId: string,
  signal: AbortSignal
): Promise<McpResult> => {
  signal.throwIfAborted();
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("MCP stream has no body.");
  }
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation = reader.cancel();
  };
  signal.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let pending = "";
  let data: string[] = [];
  const takeEvents = (ended: boolean): McpResult | undefined => {
    while (true) {
      const index = pending.search(/[\r\n]/u);
      if (
        index === -1 ||
        (!ended && index === pending.length - 1 && pending[index] === "\r")
      ) {
        return;
      }
      const line = pending.slice(0, index);
      const separator =
        pending[index] === "\r" && pending[index + 1] === "\n" ? 2 : 1;
      pending = pending.slice(index + separator);
      if (line === "") {
        if (data.length > 0) {
          const message: unknown = JSON.parse(data.join("\n"));
          data = [];
          const result = parseMessage(message, operationId, true);
          if (result) {
            return result;
          }
        }
      } else if (line === "data" || line.startsWith("data:")) {
        const field = line === "data" ? "" : line.slice(5);
        data.push(field.startsWith(" ") ? field.slice(1) : field);
      }
    }
  };
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Each read advances this bounded response stream.
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (!chunk.done) {
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          throw new Error("MCP stream exceeds the byte limit.");
        }
      }
      pending += chunk.done
        ? decoder.decode()
        : decoder.decode(chunk.value, { stream: true });
      const result = takeEvents(chunk.done);
      if (result) {
        return result;
      }
      if (chunk.done) {
        throw new Error("MCP stream ended without a final response.");
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await (cancellation ?? reader.cancel());
    reader.releaseLock();
  }
};

export const readMcpToolResult = async (
  response: Response,
  maxBytes: number,
  operationId: string,
  signal: AbortSignal
): Promise<unknown> => {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  let result: McpResult;
  if (contentType === "application/json") {
    const parsed = await readBoundedJson(response, maxBytes, signal);
    const final = parseMessage(parsed, operationId, false);
    if (!final) {
      throw new Error("MCP response has no final result.");
    }
    result = final;
  } else if (contentType === "text/event-stream") {
    result = await readSseResult(response, maxBytes, operationId, signal);
  } else {
    await response.body?.cancel();
    throw new Error("MCP response has an unsupported media type.");
  }
  return result.structuredContent ?? result;
};
