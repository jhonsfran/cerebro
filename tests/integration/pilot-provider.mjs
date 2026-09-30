import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const directory = process.env.FIXTURE_DATA_DIR ?? "/tmp/cerebro-pilot-provider";
await mkdir(directory, { recursive: true });
const statePath = path.join(directory, "state.json");
let state = { effects: {}, model: [], tools: {} };
try {
  state = JSON.parse(await readFile(statePath, "utf-8"));
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error;
  }
}
let controls = {
  dropModel: false,
  dropTool: false,
  holdModel: false,
  holdTool: false,
  omitUsage: false,
};
const held = new Set();
let saving = Promise.resolve();
const save = async () => {
  const snapshot = JSON.stringify(state);
  const prior = saving;
  saving = (async () => {
    await prior;
    await writeFile(statePath, snapshot, { flush: true });
  })();
  await saving;
};
const json = (response, status, value, headers = {}) => {
  response.writeHead(status, {
    "Content-Type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(value));
};
const body = async (request) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_048_576) {
      throw new Error("Fixture request exceeds bound.");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
};
const finish = async (request, response, work, kind) => {
  if (controls[`drop${kind}`]) {
    response.destroy();
    return;
  }
  if (controls[`hold${kind}`]) {
    const entry = { kind, response, work };
    held.add(entry);
    response.once("close", () => held.delete(entry));
    return;
  }
  await work();
};
const content = (value) => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => part.text ?? "").join("");
  }
  return "";
};
const modelResponse = async (request, response) => {
  const input = await body(request);
  const operationId = request.headers["x-cerebro-model-operation"];
  const promptIndex = input.messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      content(message.content).includes("operationId=")
  );
  let userIndex = promptIndex;
  if (userIndex === -1) {
    userIndex = input.messages.findLastIndex(
      (message) => message.role === "user"
    );
  }
  const text = content(input.messages[userIndex]?.content);
  const observedTools = input.messages
    .slice(userIndex + 1)
    .filter(
      (message) =>
        message.role === "tool" &&
        /MCP read completed\.|approved-fixture/u.test(content(message.content))
    );
  const names = input.tools?.map((entry) => entry.function.name) ?? [];
  const promptLines = text.split("\n");
  const operationLine = promptLines.findIndex((line) =>
    line.startsWith("operationId=")
  );
  const userText = promptLines.slice(operationLine + 1).join("\n");
  const desiredTool =
    userText.includes("write fixture") || userText.includes("approval fixture")
      ? "fixture_effect"
      : "fixture-read";
  const tool =
    !userText.includes("no tools") &&
    observedTools.length === 0 &&
    names.includes(desiredTool)
      ? desiredTool
      : undefined;
  state.model.push({
    bytes: Buffer.byteLength(JSON.stringify(input)),
    maxTokens: input.max_tokens,
    model: input.model,
    names,
    operationId,
    shapes: input.messages.map((message) => ({
      contentType: typeof message.content,
      parts: Array.isArray(message.content)
        ? message.content.map((part) => part.type)
        : [],
      role: message.role,
      toolCallCount: message.tool_calls?.length ?? 0,
      toolCallId: Boolean(message.tool_call_id),
    })),
    toolResults: observedTools.length,
  });
  await save();
  const sourceLines = text
    .split("\n")
    .filter((line) => line.startsWith("[source "));
  const answer =
    sourceLines.length > 0
      ? sourceLines.join("\n")
      : "Cerebro pilot completed.";
  const delta = tool
    ? {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: {
              arguments:
                tool === "fixture_effect"
                  ? JSON.stringify({ value: "approved-fixture" })
                  : JSON.stringify({ query: "pilot" }),
              name: tool,
            },
            id: `call_${crypto.randomUUID()}`,
            index: 0,
            type: "function",
          },
        ],
      }
    : { content: answer, role: "assistant" };
  const usage = {
    completion_tokens: 4,
    prompt_tokens: 8,
    total_tokens: 12,
  };
  const base = {
    created: 1,
    id: `chatcmpl_${crypto.randomUUID()}`,
    model: input.model,
  };
  const chunks = [
    {
      ...base,
      choices: [{ delta, finish_reason: null, index: 0 }],
      object: "chat.completion.chunk",
    },
    {
      ...base,
      choices: [
        {
          delta: {},
          finish_reason: tool ? "tool_calls" : "stop",
          index: 0,
        },
      ],
      object: "chat.completion.chunk",
      ...(controls.omitUsage ? {} : { usage }),
    },
  ];
  const result = input.stream
    ? `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
    : JSON.stringify({
        ...base,
        choices: [
          {
            finish_reason: tool ? "tool_calls" : "stop",
            index: 0,
            message: delta,
          },
        ],
        object: "chat.completion",
        ...(controls.omitUsage ? {} : { usage }),
      });
  await finish(
    request,
    response,
    () => {
      response.writeHead(200, {
        "Content-Type": input.stream ? "text/event-stream" : "application/json",
      });
      response.end(result);
    },
    "Model"
  );
};
const toolResponse = async (request, response, url) => {
  if (request.headers.authorization !== "Bearer fixture-connector-key") {
    json(response, 401, {
      error: "Fixture connector credentials are missing.",
    });
    return;
  }
  const input = await body(request);
  const operationId = input.id ?? input.operationId;
  const write = url.pathname === "/effects";
  const records = write ? state.effects : state.tools;
  const prior = records[operationId];
  const digest = JSON.stringify(input);
  if (prior && prior.digest !== digest) {
    json(response, 409, { error: "Fixture operation differs." });
    return;
  }
  const count = prior?.count ?? 0;
  records[operationId] = {
    count: count + 1,
    digest,
    effects: write ? (prior?.effects ?? 0) + 1 : 0,
    startedAt: Date.now(),
  };
  await save();
  const output = {
    operationId,
    receipt: `receipt:${operationId}`,
    value: write ? "approved-fixture" : "MCP read completed.",
  };
  await finish(
    request,
    response,
    async () => {
      records[operationId].completedAt = Date.now();
      await save();
      json(
        response,
        200,
        write
          ? output
          : {
              id: operationId,
              jsonrpc: "2.0",
              result: {
                content: [{ text: "MCP read completed.", type: "text" }],
                structuredContent: output,
              },
            },
        { "X-Provider-Receipt": output.receipt }
      );
    },
    "Tool"
  );
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://fixture:8090");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/observations") {
      json(response, 200, {
        ...state,
        held: [...held].map((item) => item.kind),
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/control") {
      const input = await body(request);
      controls = { ...controls, ...input };
      if (input.release) {
        await Promise.all([...held].map((entry) => entry.work()));
        held.clear();
      }
      json(response, 200, { ok: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      await modelResponse(request, response);
      return;
    }
    if (
      request.method === "POST" &&
      (url.pathname === "/mcp" || url.pathname === "/effects")
    ) {
      await toolResponse(request, response, url);
      return;
    }
    if (request.method === "GET" && url.pathname === "/effects") {
      const operationId = url.searchParams.get("operationId");
      const prior = state.effects[operationId];
      if (!prior) {
        json(response, 404, { error: "No receipt." });
        return;
      }
      json(
        response,
        200,
        {
          operationId,
          receipt: `receipt:${operationId}`,
          value: "approved-fixture",
        },
        { "X-Provider-Receipt": `receipt:${operationId}` }
      );
      return;
    }
    json(response, 404, { error: "Unknown fixture route." });
  } catch {
    if (response.headersSent) {
      response.destroy();
    } else {
      json(response, 500, { error: "Fixture request failed." });
    }
  }
});
server.listen(8090, "0.0.0.0");
