import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import nodePath from "node:path";

import { z } from "zod";

const fixtureSecret = "cerebro-local-fixture-secret";
const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/u);
const effectResult = z.object({
  invocationId: identifier,
  receipt: z.string(),
  value: z.string(),
});
const effectInput = z
  .object({
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    hold: z.boolean(),
    invocationId: identifier,
    mode: z.enum(["idempotent", "non-idempotent"]),
    value: z.literal("approved-fixture"),
  })
  .strict();
const effectRecord = z.object({
  calls: z.number().int().nonnegative(),
  digest: z.string(),
  effects: z.number().int().positive(),
  held: z.boolean(),
  mode: z.enum(["idempotent", "non-idempotent"]),
  released: z.boolean(),
  result: effectResult,
});
const checkpointInput = z
  .object({
    instance: z.string().max(256).optional(),
    operationId: identifier,
    phase: z.string().min(1).max(128),
  })
  .strict();
const modelRequest = z.object({
  messages: z.array(
    z.object({ content: z.unknown().optional(), role: z.string() })
  ),
  model: z.string().default("deterministic"),
  stream: z.boolean().default(false),
  tools: z
    .array(z.object({ function: z.object({ name: z.string() }) }))
    .default([]),
});
const attackInput = z
  .object({
    tool: z.enum(["shell", "webfetch", "execute", "mcp_unregistered"]),
  })
  .strict();
const attacks = new Map<string, z.infer<typeof attackInput>["tool"]>();
const modelObservation = z.object({
  advertisedTools: z.array(z.string()),
  model: z.string(),
  responseSecretPresent: z.boolean().optional(),
  secretPresent: z.boolean().optional(),
  toolCallsEmitted: z.number().int().nonnegative().optional(),
  toolResultsObserved: z.number().int().nonnegative().optional(),
});
const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("effect"), record: effectRecord }),
  z.object({
    kind: z.literal("attack"),
    operationId: identifier,
    tool: attackInput.shape.tool,
  }),
  z.object({
    at: z.number(),
    checkpoint: checkpointInput,
    kind: z.literal("checkpoint"),
  }),
  modelObservation.extend({ kind: z.literal("model") }),
  z.object({ invocationId: identifier, kind: z.literal("release") }),
]);
type JournalEvent = z.infer<typeof eventSchema>;
type EffectRecord = z.infer<typeof effectRecord>;
type EffectResult = z.infer<typeof effectResult>;
interface HeldReply {
  response: ServerResponse;
  result: EffectResult;
}
const effects = new Map<string, EffectRecord>();
const releases = new Set<string>();
const checkpoints = new Map<
  string,
  { at: number; instance?: string; phase: string }[]
>();
const observations: z.infer<typeof modelObservation>[] = [];
const replies = new Map<string, Set<HeldReply>>();
const directory = process.env.FIXTURE_DATA_DIR ?? "/tmp";
const journalPath = nodePath.join(directory, "cerebro-fixture.ndjson");
await mkdir(directory, { recursive: true });

const apply = (event: JournalEvent): void => {
  switch (event.kind) {
    case "attack": {
      attacks.set(event.operationId, event.tool);
      break;
    }
    case "effect": {
      effects.set(event.record.result.invocationId, event.record);
      break;
    }
    case "release": {
      releases.add(event.invocationId);
      const record = effects.get(event.invocationId);
      if (record) {
        effects.set(event.invocationId, {
          ...record,
          held: false,
          released: true,
        });
      }
      break;
    }
    case "checkpoint": {
      const { instance, operationId, phase } = event.checkpoint;
      const history = checkpoints.get(operationId) ?? [];
      history.push({ at: event.at, ...(instance ? { instance } : {}), phase });
      checkpoints.set(operationId, history);
      break;
    }
    case "model": {
      observations.push({
        advertisedTools: event.advertisedTools,
        model: event.model,
        responseSecretPresent: event.responseSecretPresent,
        secretPresent: event.secretPresent,
        toolCallsEmitted: event.toolCallsEmitted,
        toolResultsObserved: event.toolResultsObserved,
      });
      break;
    }
    default: {
      throw new Error("Unknown fixture journal event");
    }
  }
};
let savedJournal = "";
try {
  savedJournal = await readFile(journalPath, "utf-8");
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT"
  ) {
    throw error;
  }
}
for (const line of savedJournal.split("\n")) {
  if (line) {
    apply(eventSchema.parse(JSON.parse(line)));
  }
}
let tail = Promise.resolve(null);
const serialized = async <T>(run: () => Promise<T>): Promise<T> => {
  const previous = tail;
  const next = Promise.withResolvers<null>();
  tail = next.promise;
  await previous;
  try {
    return await run();
  } finally {
    next.resolve(null);
  }
};
const persist = async (event: JournalEvent): Promise<void> => {
  await appendFile(journalPath, `${JSON.stringify(event)}\n`, { flush: true });
  apply(event);
};
const json = (
  response: ServerResponse,
  status: number,
  body: unknown
): void => {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
};
const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_048_576) {
      throw new Error("Fixture request too large");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
};
const textContent = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }
  const parts = z.array(z.object({ text: z.string() })).safeParse(content);
  return parts.success ? parts.data.map((part) => part.text).join("") : "";
};
const operationPattern = /operationId=(?<operationId>[A-Za-z0-9_.:-]+)/u;
const operationContext = (body: z.infer<typeof modelRequest>) => {
  const index = body.messages.findLastIndex(
    (message) =>
      message.role === "user" &&
      operationPattern.test(textContent(message.content))
  );
  const message = body.messages[index];
  const operationId = message
    ? operationPattern.exec(textContent(message.content))?.groups?.operationId
    : undefined;
  return { index, operationId };
};
const attackOutcome = (
  body: z.infer<typeof modelRequest>
):
  | { outcome: "call" | "denied"; tool: z.infer<typeof attackInput>["tool"] }
  | undefined => {
  if (body.model !== "controlled") {
    return;
  }
  const { index, operationId } = operationContext(body);
  const tool = operationId ? attacks.get(operationId) : undefined;
  if (!tool) {
    return;
  }
  return {
    outcome: body.messages
      .slice(index + 1)
      .some((message) => message.role === "tool")
      ? "denied"
      : "call",
    tool,
  };
};
const attackArguments = {
  execute: JSON.stringify({ code: "return 'cerebro-fixture-attack';" }),
  mcp_unregistered: "{}",
  shell: JSON.stringify({ command: "printf cerebro-fixture-attack" }),
  webfetch: JSON.stringify({ url: "http://fixture:8090/health" }),
};
const outcomeText = {
  completed: "Cerebro fixture completed.",
  denied: "Cerebro fixture denied.",
  unknown: "Cerebro fixture outcome is unknown.",
};
const modelOutcome = (
  body: z.infer<typeof modelRequest>
): "call" | "completed" | "unknown" => {
  if (body.model !== "controlled") {
    const lastUser = body.messages.findLastIndex(
      (message) => message.role === "user"
    );
    return body.messages
      .slice(lastUser + 1)
      .some((message) => message.role === "tool")
      ? "completed"
      : "call";
  }
  const { operationId } = operationContext(body);
  const tools = body.messages.filter((message) => message.role === "tool");
  for (const message of tools.toReversed()) {
    let value: unknown;
    try {
      value = JSON.parse(textContent(message.content));
    } catch {
      continue;
    }
    const result = effectResult.safeParse(value);
    if (
      result.success &&
      result.data.value === "approved-fixture" &&
      (!operationId ||
        result.data.invocationId === operationId ||
        result.data.invocationId.startsWith(`${operationId}:`))
    ) {
      return "completed";
    }
    const unknown = z
      .object({
        invocationId: identifier.optional(),
        status: z.literal("unknown-outcome"),
      })
      .safeParse(value);
    if (
      unknown.success &&
      (!operationId ||
        unknown.data.invocationId === operationId ||
        unknown.data.invocationId === `${operationId}:effect`)
    ) {
      return "unknown";
    }
  }
  return "call";
};
const serveModel = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const rawBody = await readBody(request);
  const secretPresent = JSON.stringify(rawBody).includes(fixtureSecret);
  const parsed = modelRequest.safeParse(rawBody);
  if (!parsed.success) {
    json(response, 400, { error: "Invalid model request" });
    return;
  }
  const body = parsed.data;
  const attack = attackOutcome(body);
  const outcome = attack?.outcome ?? modelOutcome(body);
  const controlled = body.model === "controlled";
  const name =
    attack?.tool ?? (controlled ? "fixture_effect" : "fixture_probe");
  const normalArguments = controlled
    ? JSON.stringify({ value: "approved-fixture" })
    : "{}";
  const toolArguments = attack ? attackArguments[attack.tool] : normalArguments;
  const delta =
    outcome === "call"
      ? {
          content: null,
          role: "assistant",
          tool_calls: [
            {
              function: {
                arguments: toolArguments,
                name,
              },
              id: `call_${name}_${crypto.randomUUID()}`,
              index: 0,
              type: "function",
            },
          ],
        }
      : {
          content: outcomeText[outcome],
          role: "assistant",
        };
  const finish = outcome === "call" ? "tool_calls" : "stop";
  const base = { created: 1, id: "chatcmpl_fixture", model: body.model };
  const usage = { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 };
  const completion = {
    ...base,
    choices: [{ finish_reason: finish, index: 0, message: delta }],
    object: "chat.completion",
    usage,
  };
  const chunks = [
    {
      ...base,
      choices: [{ delta, finish_reason: null, index: 0 }],
      object: "chat.completion.chunk",
    },
    {
      ...base,
      choices: [{ delta: {}, finish_reason: finish, index: 0 }],
      object: "chat.completion.chunk",
      usage,
    },
  ];
  const responseBody = body.stream
    ? `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
    : JSON.stringify(completion);
  await serialized(async () => {
    await persist({
      advertisedTools: body.tools.map((tool) => tool.function.name).toSorted(),
      kind: "model",
      model: body.model,
      responseSecretPresent: responseBody.includes(fixtureSecret),
      secretPresent,
      toolCallsEmitted: outcome === "call" ? 1 : 0,
      toolResultsObserved: body.messages.filter(
        (message) => message.role === "tool"
      ).length,
    });
  });
  response.writeHead(
    200,
    body.stream
      ? { "Cache-Control": "no-cache", "Content-Type": "text/event-stream" }
      : { "Content-Type": "application/json" }
  );
  response.end(responseBody);
};
const serveEffect = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  if (request.headers["x-fixture-secret"] !== fixtureSecret) {
    json(response, 401, { error: "Unauthorized fixture effect" });
    return;
  }
  const parsed = effectInput.safeParse(await readBody(request));
  if (!parsed.success) {
    json(response, 400, { error: "Invalid effect request" });
    return;
  }
  const input = parsed.data;
  await serialized(async () => {
    const previous = effects.get(input.invocationId);
    if (
      previous &&
      (previous.digest !== input.digest || previous.mode !== input.mode)
    ) {
      await persist({
        kind: "effect",
        record: { ...previous, calls: previous.calls + 1 },
      });
      json(response, 409, { error: "Invocation conflict" });
      return;
    }
    const count =
      previous && input.mode === "idempotent"
        ? previous.effects
        : (previous?.effects ?? 0) + 1;
    const result =
      previous && input.mode === "idempotent"
        ? previous.result
        : {
            invocationId: input.invocationId,
            receipt: `${input.invocationId}:${count}`,
            value: input.value,
          };
    const released = releases.has(input.invocationId);
    const held = input.hold && !released;
    await persist({
      kind: "effect",
      record: {
        calls: (previous?.calls ?? 0) + 1,
        digest: input.digest,
        effects: count,
        held,
        mode: input.mode,
        released,
        result,
      },
    });
    if (!held) {
      json(response, 200, result);
      return;
    }
    const pending = replies.get(input.invocationId) ?? new Set<HeldReply>();
    const reply = { response, result };
    pending.add(reply);
    replies.set(input.invocationId, pending);
    response.on("close", () => {
      pending.delete(reply);
    });
  });
};
const serveRelease = async (
  route: string,
  response: ServerResponse
): Promise<void> => {
  const id = identifier.parse(
    decodeURIComponent(route.slice("/release/".length))
  );
  await serialized(async () => {
    await persist({ invocationId: id, kind: "release" });
    for (const reply of replies.get(id) ?? []) {
      if (!reply.response.destroyed) {
        json(reply.response, 200, reply.result);
      }
    }
    replies.delete(id);
  });
  json(response, 200, { ok: true });
};
const serveCheckpoint = async (
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const checkpoint = checkpointInput.safeParse(await readBody(request));
  if (!checkpoint.success) {
    json(response, 400, { error: "Invalid checkpoint" });
    return;
  }
  await serialized(async () => {
    await persist({
      at: Date.now(),
      checkpoint: checkpoint.data,
      kind: "checkpoint",
    });
  });
  json(response, 200, { ok: true });
};
const serveAttack = async (
  route: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> => {
  const operationId = identifier.safeParse(
    decodeURIComponent(route.slice("/attacks/".length))
  );
  const attack = attackInput.safeParse(await readBody(request));
  if (!operationId.success || !attack.success) {
    json(response, 400, { error: "Invalid attack request" });
    return;
  }
  await serialized(async () => {
    await persist({
      kind: "attack",
      operationId: operationId.data,
      tool: attack.data.tool,
    });
  });
  json(response, 200, { ok: true });
};
const serveGet = (path: string, response: ServerResponse): void => {
  if (path === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  if (path.startsWith("/effects/")) {
    const record = effects.get(
      decodeURIComponent(path.slice("/effects/".length))
    );
    json(
      response,
      record ? 200 : 404,
      record
        ? {
            calls: record.calls,
            effects: record.effects,
            held: record.held,
            result: record.result,
          }
        : { calls: 0, effects: 0, held: false, result: null }
    );
    return;
  }
  if (path.startsWith("/checkpoints/")) {
    const operationId = decodeURIComponent(path.slice("/checkpoints/".length));
    json(response, 200, {
      operationId,
      phases: checkpoints.get(operationId) ?? [],
    });
    return;
  }
  if (path === "/model-observations") {
    json(response, 200, {
      advertisedTools: [
        ...new Set(observations.flatMap((item) => item.advertisedTools)),
      ].toSorted(),
      modelCalls: observations.length,
      observations,
    });
    return;
  }
  json(response, 404, { error: "Unknown fixture route" });
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://fixture:8090");
    const path = url.pathname;
    if (request.method === "GET") {
      serveGet(path, response);
      return;
    }

    if (request.method === "POST" && path === "/v1/chat/completions") {
      await serveModel(request, response);
      return;
    }
    if (request.method === "POST" && path.startsWith("/attacks/")) {
      await serveAttack(path, request, response);
      return;
    }
    if (request.method === "POST" && path === "/effects") {
      await serveEffect(request, response);
      return;
    }

    if (request.method === "POST" && path.startsWith("/release/")) {
      await serveRelease(path, response);
      return;
    }
    if (request.method === "POST" && path === "/checkpoints") {
      await serveCheckpoint(request, response);
      return;
    }

    json(response, 404, { error: "Unknown fixture route" });
  } catch {
    if (response.headersSent) {
      response.destroy();
    } else {
      json(response, 500, { error: "Fixture failed" });
    }
  }
});
server.listen(8090, "0.0.0.0");
