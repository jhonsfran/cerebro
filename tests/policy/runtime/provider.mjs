import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

mkdirSync("/run/provider", { recursive: true });
const database = new DatabaseSync("/run/provider/effects.sqlite");
database.exec(
  "CREATE TABLE IF NOT EXISTS effects(operation_id TEXT PRIMARY KEY, calls INTEGER NOT NULL, effects INTEGER NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS observations(payload TEXT NOT NULL);"
);
const secret = "s4-provider-secret-never-in-model";
const json = (response, status, body, headers = {}) => {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
};
const body = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
};
const serveModel = async (request, response) => {
  const input = await body(request);
  const user = input.messages.findLast((message) => message.role === "user");
  const text =
    typeof user?.content === "string"
      ? user.content
      : JSON.stringify(user?.content);
  const tool =
    /forcedTool=(?<tool>[a-z_]+)/u.exec(text)?.groups?.tool ??
    "controlled_read";
  const done = input.messages.some((message) => message.role === "tool");
  const args = {
    execute: { code: "return fetch('http://fixture:8090/write')" },
    mcp_unregistered: {},
    shell: { command: "printf forbidden-effect" },
    webfetch: { url: "http://fixture:8090/write" },
  }[tool] ?? { value: "runtime-value" };
  const delta = done
    ? { content: "Runtime tool attempt finished.", role: "assistant" }
    : {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: { arguments: JSON.stringify(args), name: tool },
            id: `call_${crypto.randomUUID()}`,
            index: 0,
            type: "function",
          },
        ],
      };
  const finish = done ? "stop" : "tool_calls";
  database.prepare("INSERT INTO observations(payload) VALUES(?)").run(
    JSON.stringify({
      advertisedTools:
        input.tools?.map((item) => item.function.name).toSorted() ?? [],
      forcedTool: tool,
      kind: "model",
      secretPresent: JSON.stringify(input).includes(secret),
      toolResults: input.messages.filter((message) => message.role === "tool")
        .length,
    })
  );
  const base = { created: 1, id: "chatcmpl_s4", model: input.model };
  const usage = { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 };
  if (!input.stream) {
    return json(response, 200, {
      ...base,
      choices: [{ finish_reason: finish, index: 0, message: delta }],
      object: "chat.completion",
      usage,
    });
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ ...base, choices: [{ delta, finish_reason: null, index: 0 }], object: "chat.completion.chunk" })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ delta: {}, finish_reason: finish, index: 0 }], object: "chat.completion.chunk", usage })}\n\ndata: [DONE]\n\n`
  );
};
const validMcpRequest = (input, headers) => {
  const metadata = input.params?._meta;
  return (
    headers["mcp-protocol-version"] === "2026-07-28" &&
    headers["mcp-method"] === "tools/call" &&
    headers["mcp-name"] === input.params?.name &&
    headers.accept?.includes("application/json") &&
    headers.accept?.includes("text/event-stream") &&
    metadata?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28" &&
    metadata?.["io.modelcontextprotocol/clientInfo"]?.name === "cerebro" &&
    typeof metadata?.["io.modelcontextprotocol/clientCapabilities"] === "object"
  );
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://fixture:8090");
    if (url.pathname === "/health") {
      return json(response, 200, { ok: true });
    }
    if (url.pathname === "/counts") {
      return json(response, 200, {
        effects: database
          .prepare("SELECT * FROM effects ORDER BY operation_id")
          .all(),
        observations: database
          .prepare("SELECT payload FROM observations")
          .all()
          .map((row) => JSON.parse(row.payload)),
      });
    }
    if (
      (url.pathname === "/mcp" || url.pathname === "/write") &&
      request.headers.authorization !== `Bearer ${secret}`
    ) {
      return json(response, 401, {
        error: "Missing fixture connector credential",
      });
    }
    if (url.pathname === "/mcp" && request.method === "POST") {
      const input = await body(request);
      if (!validMcpRequest(input, request.headers)) {
        return json(response, 400, {
          error: "Missing pinned MCP transport metadata",
        });
      }
      database.prepare("INSERT INTO observations(payload) VALUES(?)").run(
        JSON.stringify({
          input,
          kind: "read",
          secretPresent: JSON.stringify(input).includes(secret),
        })
      );
      const output = {
        secret,
        source: "controlled-read",
        value: input.params.arguments.value,
      };
      const result = {
        id: input.id,
        jsonrpc: "2.0",
        result: {
          content: [{ text: JSON.stringify(output), type: "text" }],
          structuredContent: output,
        },
      };
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Provider-Receipt": `read:${input.id}`,
      });
      response.end(
        `: fixture keepalive\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1, progressToken: input.id } })}\n\nevent: message\ndata: ${JSON.stringify(result)}\n\n`
      );
      return;
    }
    if (url.pathname === "/write" && request.method === "GET") {
      const record = database
        .prepare("SELECT payload FROM effects WHERE operation_id=?")
        .get(url.searchParams.get("operationId"));
      return record
        ? json(response, 200, JSON.parse(record.payload))
        : json(response, 404, {});
    }
    if (url.pathname === "/write" && request.method === "POST") {
      const input = await body(request);
      const previous = database
        .prepare("SELECT * FROM effects WHERE operation_id=?")
        .get(input.operationId);
      const count = (previous?.effects ?? 0) + 1;
      const result = {
        receipt: `${input.operationId}:${count}`,
        source: "controlled-write",
        value: input.arguments.value,
      };
      database
        .prepare(
          "INSERT INTO effects(operation_id,calls,effects,payload) VALUES(?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET calls=excluded.calls,effects=excluded.effects,payload=excluded.payload"
        )
        .run(
          input.operationId,
          (previous?.calls ?? 0) + 1,
          count,
          JSON.stringify(result)
        );
      return json(response, 200, result, {
        "X-Provider-Receipt": result.receipt,
      });
    }
    if (url.pathname === "/v1/chat/completions") {
      return await serveModel(request, response);
    }
    return json(response, 404, { error: "Unknown fixture route" });
  } catch (error) {
    return json(response, 500, { error: error.message });
  }
});
server.listen(8090, "0.0.0.0");
