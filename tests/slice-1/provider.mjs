/* oxlint-disable no-await-in-loop -- Ordered physical dispatch and persistence are the fixture's evidence. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// The provider holds a connector response at these points so a test can
// kill celld while a physical write is in flight.
export const boundaries = ["before-tool-dispatch", "after-tool-dispatch"];
const canonical = (value) => {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonical(value[key])])
    );
  }
  return value;
};
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const json = (response, status, value) => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
};
const body = async (request) => {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_048_576) {
      throw new Error("Fixture input exceeds 1 MiB");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
};
const identity = (value) => {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error("A stable operation identity is required");
  }
  return value;
};

const textParts = (message) => {
  if (typeof message?.content === "string") {
    return [message.content];
  }
  return Array.isArray(message?.content)
    ? message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
    : [];
};
const messageText = (message) => textParts(message).join("\n");
// The prompt names the fixture tool it wants, so tests need no host hooks.
const promptedTool = (input) => {
  const prompt = messageText(
    input.messages.findLast((message) => message.role === "user")
  );
  if (
    prompt.includes("fixture_effect") ||
    prompt.includes("approval fixture")
  ) {
    return "fixture_effect";
  }
  if (prompt.includes("Activate skill refund-policy")) {
    return "activate_skill";
  }
  return prompt.includes("fixture-read") ? "fixture-read" : undefined;
};
const requestedTool = (request, input) =>
  request.headers["x-fixture-tool"] ?? promptedTool(input);
const toolArguments = (name) => {
  if (name === "activate_skill") {
    return { name: "refund-policy" };
  }
  if (name === "fixture_effect") {
    return { value: "approved-fixture" };
  }
  return { query: "slice-1" };
};
// One user turn keeps one identity across its model requests.
const turnIdentity = (input) =>
  `turn:${digest(
    input.messages.slice(
      0,
      input.messages.findLastIndex((message) => message.role === "user") + 1
    )
  ).slice(0, 48)}`;

const requestsTool = (input, purpose, toolName) =>
  purpose === "turn" &&
  !input.messages
    .slice(
      input.messages.findLastIndex((message) => message.role === "user") + 1
    )
    .some((message) => message.role === "tool") &&
  ["fixture-read", "fixture_effect", "activate_skill"].includes(toolName) &&
  input.tools?.some((item) => item.function?.name === toolName);

const recordToken = (call, delta) => {
  call.firstFrameAt ??= Date.now();
  if (delta.content || delta.tool_calls?.length) {
    call.firstTokenAt ??= Date.now();
  }
};

export const createFixture = async ({
  directory,
  fixtureId,
  sha,
  controlToken = "slice-1-control",
}) => {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const filename = path.join(directory, "committed.json");
  let state = {
    checkpoints: [],
    controls: { arm: null, delayMs: 100, failFirst: false },
    fixtureId,
    model: [],
    revision: 0,
    schemaVersion: 1,
    sha,
    tools: [],
  };
  try {
    state = JSON.parse(await readFile(filename, "utf-8"));
    if (
      state.fixtureId !== fixtureId ||
      state.sha !== sha ||
      state.schemaVersion !== 1
    ) {
      throw new Error(
        "Fixture state belongs to a different identity or source SHA"
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  let writes = Promise.resolve();
  const save = () => {
    state.revision += 1;
    const bytes = `${JSON.stringify(state, null, 2)}\n`;
    const previous = writes;
    writes = (async () => {
      await previous;
      await writeFile(`${filename}.tmp`, bytes, { flush: true, mode: 0o600 });
      await rename(`${filename}.tmp`, filename);
    })();
    return writes;
  };
  await save();
  const held = new Set();
  const checkpoint = async (boundary, operationId, response) => {
    if (!boundaries.includes(boundary)) {
      throw new Error("Unknown checkpoint boundary");
    }
    const entry = {
      at: Date.now(),
      boundary,
      operationId: identity(operationId),
    };
    state.checkpoints.push(entry);
    await save();
    if (
      state.controls.arm?.boundary === boundary &&
      (!state.controls.arm.operationId ||
        state.controls.arm.operationId === operationId)
    ) {
      entry.armed = true;
      entry.armId = state.controls.arm.id ?? null;
      await save();
      const { promise, resolve } = Promise.withResolvers();
      {
        const release = () => {
          held.delete(release);
          resolve();
        };
        held.add(release);
        response.once("close", release);
      }
      await promise;
    }
  };
  const model = async (request, response) => {
    if (request.headers.authorization !== "Bearer fixture-model-key") {
      json(response, 401, { error: "Fixture model credentials required" });
      return;
    }
    const input = await body(request);
    if (!Array.isArray(input.messages)) {
      throw new TypeError("Messages are required");
    }
    const operationId = identity(
      request.headers["x-fixture-request-id"] ?? turnIdentity(input)
    );
    const purpose =
      request.headers["x-fixture-purpose"] === "compaction"
        ? "compaction"
        : "turn";
    const call = {
      digest: digest(input),
      maxTokens: input.max_completion_tokens ?? input.max_tokens ?? null,
      messageTextDigests: input.messages.flatMap((message) =>
        textParts(message).map((text) =>
          createHash("sha256").update(text).digest("hex")
        )
      ),
      model: input.model,
      operationId,
      purpose,
      startedAt: Date.now(),
      toolNames: (input.tools ?? []).map((item) => item.function?.name),
    };
    state.model.push(call);
    await save();
    if (
      state.controls.failFirst &&
      state.model.filter(
        (item) => item.operationId === operationId && item.purpose === purpose
      ).length === 1
    ) {
      call.status = 503;
      await save();
      json(response, 503, {
        error: { message: "Deterministic retry", type: "server_error" },
      });
      return;
    }
    const toolName = requestedTool(request, input);
    const tool = requestsTool(input, purpose, toolName);
    const text =
      purpose === "compaction"
        ? "Fixture compacted history."
        : "Cerebro slice 1 completed.";
    const message = tool
      ? {
          content: null,
          role: "assistant",
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify(toolArguments(toolName)),
                name: toolName,
              },
              id: `call_${digest({ operationId, toolName }).slice(0, 24)}`,
              type: "function",
            },
          ],
        }
      : { content: text, role: "assistant" };
    const base = {
      created: 1,
      id: `chatcmpl_${operationId}`,
      model: input.model ?? "slice-1",
    };
    const usage = { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 };
    if (input.stream) {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      const deltas = tool
        ? [
            {
              ...message,
              tool_calls: message.tool_calls.map((item) => ({
                ...item,
                index: 0,
              })),
            },
          ]
        : [
            { content: "", role: "assistant" },
            ...text.split(" ").map((word, index) => ({
              content: `${index ? " " : ""}${word}`,
            })),
          ];
      for (const delta of deltas) {
        if (response.destroyed) {
          return;
        }
        await delay(state.controls.delayMs);
        recordToken(call, delta);
        response.write(
          `data: ${JSON.stringify({ ...base, choices: [{ delta, finish_reason: null, index: 0 }], object: "chat.completion.chunk" })}\n\n`
        );
      }
      call.completedAt = Date.now();
      call.status = 200;
      await save();
      response.end(
        `data: ${JSON.stringify({ ...base, choices: [{ delta: {}, finish_reason: tool ? "tool_calls" : "stop", index: 0 }], object: "chat.completion.chunk", usage })}\n\ndata: [DONE]\n\n`
      );
    } else {
      await delay(state.controls.delayMs);
      call.firstTokenAt = Date.now();
      call.completedAt = Date.now();
      call.status = 200;
      await save();
      json(response, 200, {
        ...base,
        choices: [
          { finish_reason: tool ? "tool_calls" : "stop", index: 0, message },
        ],
        object: "chat.completion",
        usage,
      });
    }
  };
  const tool = async (request, response, write, input, rpcId) => {
    const operationId = identity(
      request.headers["x-cerebro-operation-id"] ?? input.operationId
    );
    const inputDigest = digest(input);
    const previous = state.tools.find(
      (item) => item.operationId === operationId
    );
    if (
      previous &&
      (previous.digest !== inputDigest || previous.write !== write)
    ) {
      json(response, 409, { error: "Changed fixture operation" });
      return;
    }
    await checkpoint("before-tool-dispatch", operationId, response);
    const entry = {
      digest: inputDigest,
      operationId,
      receipt: `receipt:${operationId}`,
      startedAt: Date.now(),
      write,
    };
    // Every physical write counts, including duplicates; the fixture does not hide runtime replay.
    state.tools.push(entry);
    await save();
    await checkpoint("after-tool-dispatch", operationId, response);
    entry.completedAt = Date.now();
    await save();
    const output = {
      operationId,
      receipt: entry.receipt,
      value: write ? "approved-fixture" : "MCP read completed.",
    };
    json(
      response,
      200,
      write
        ? output
        : {
            id: rpcId,
            jsonrpc: "2.0",
            result: {
              content: [{ text: output.value, type: "text" }],
              structuredContent: output,
            },
          }
    );
  };
  // The tools a discovered fixture MCP connector lists. Only `lookup` is
  // marked read-only, so `archive` becomes a write that needs approval.
  const listedTools = [
    {
      annotations: { readOnlyHint: true },
      description: "Look up a fixture record",
      inputSchema: {
        additionalProperties: false,
        properties: { query: { type: "string" } },
        required: ["query"],
        type: "object",
      },
      name: "lookup",
    },
    {
      description: "Archive a fixture record",
      inputSchema: {
        additionalProperties: false,
        properties: { id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      name: "archive",
    },
  ];
  const mcp = async (request, response) => {
    const message = await body(request);
    if (message.method === "notifications/initialized") {
      response.writeHead(202);
      response.end();
    } else if (message.method === "initialize") {
      json(response, 200, {
        id: message.id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: message.params.protocolVersion,
          serverInfo: { name: "cerebro-fixture", version: "1.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      json(response, 200, {
        id: message.id,
        jsonrpc: "2.0",
        result: { tools: listedTools },
      });
    } else if (message.method === "tools/call") {
      await tool(request, response, false, message.params, message.id);
    } else {
      json(response, 200, {
        error: { code: -32_601, message: "Method not found" },
        id: message.id,
        jsonrpc: "2.0",
      });
    }
  };
  const applyControls = (input) => {
    if (input.delayMs !== undefined) {
      if (
        !Number.isInteger(input.delayMs) ||
        input.delayMs < 0 ||
        input.delayMs > 5000
      ) {
        throw new Error("Invalid delay");
      }
      state.controls.delayMs = input.delayMs;
    }
    if (input.failFirst !== undefined) {
      if (typeof input.failFirst !== "boolean") {
        throw new TypeError("Invalid retry control");
      }
      state.controls.failFirst = input.failFirst;
    }
    if (input.arm !== undefined) {
      if (input.arm !== null && !boundaries.includes(input.arm.boundary)) {
        throw new Error("Invalid crash boundary");
      }
      state.controls.arm = input.arm;
    }
  };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://fixture:8090");
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { fixtureId, ok: true, sha });
      } else if (request.method === "GET" && url.pathname === "/observations") {
        // Serve the file that crossed the persistence boundary, not mutable process state.
        await writes;
        json(response, 200, {
          ...JSON.parse(await readFile(filename, "utf-8")),
          held: held.size,
        });
      } else if (
        request.method === "POST" &&
        ["/control", "/checkpoints"].includes(url.pathname)
      ) {
        if (request.headers["x-fixture-control"] !== controlToken) {
          json(response, 403, { error: "Fixture control token required" });
          return;
        }
        const input = await body(request);
        if (url.pathname === "/checkpoints") {
          await checkpoint(input.boundary, input.operationId, response);
        } else {
          applyControls(input);
          await save();
          if (input.release) {
            for (const release of held) {
              release();
            }
          }
        }
        json(response, 200, { ok: true, revision: state.revision });
      } else if (
        request.method === "POST" &&
        url.pathname === "/v1/chat/completions"
      ) {
        await model(request, response);
      } else if (
        request.method === "POST" &&
        ["/mcp", "/effects"].includes(url.pathname)
      ) {
        if (request.headers.authorization !== "Bearer fixture-connector-key") {
          json(response, 401, {
            error: "Fixture connector credentials required",
          });
        } else if (url.pathname === "/mcp") {
          await mcp(request, response);
        } else {
          await tool(request, response, true, await body(request));
        }
      } else {
        json(response, 404, { error: "Unknown fixture route" });
      }
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
      } else {
        json(response, 400, { error: error.message });
      }
    }
  });
  server.on("close", () => {
    for (const release of held) {
      release();
    }
  });
  return { flush: () => writes, server };
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const fixture = await createFixture({
    directory: process.env.FIXTURE_DATA_DIR ?? "/tmp/cerebro-slice-1-provider",
    fixtureId: process.env.FIXTURE_ID ?? "slice-1-local",
    sha: process.env.FIXTURE_SHA ?? "unrecorded",
  });
  fixture.server.listen(
    Number(process.env.FIXTURE_PORT ?? 8090),
    "0.0.0.0",
    () => {
      process.send?.({ port: fixture.server.address().port });
    }
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => fixture.server.close());
  }
}
