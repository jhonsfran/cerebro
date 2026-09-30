/* oxlint-disable no-await-in-loop -- Observe the live socket and its eventual audit projection until the shared deadline. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { WebSocket } from "ws";
import { z } from "zod";

const api = process.env.CEREBRO_CHAT_API_URL;
const origin = process.env.CEREBRO_CHAT_WEB_URL ?? "http://localhost:3001";
const policyCloseOnly = process.env.CEREBRO_CHAT_POLICY_CLOSE === "1";
const availableOpenCodeAgent = (
  model: string,
  available: ReadonlySet<string>
) => model.startsWith("opencode/") && available.has(model);
const exec = promisify(execFile);
const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.close();
  await once(server, "close");
  return address.port;
};
const debugSources = async () => {
  const imageProject = process.env.CEREBRO_CHAT_IMAGE_PROJECT;
  if (!imageProject) {
    return;
  }
  assert.match(imageProject, /^cerebro-chat-[a-f0-9]{8}$/u);
  const directory = await mkdtemp(
    nodePath.join(tmpdir(), "cerebro-chat-compose-")
  );
  const overridePath = nodePath.join(directory, "compose.json");
  const appServices = ["bootstrap", "celld", "secrets-init", "web"];
  const sources = [
    "deploy/bootstrap.mjs",
    "apps/server/src",
    "packages/runtime/src",
    "packages/channels/src",
  ];
  const services = Object.fromEntries(
    appServices.map((service) => [
      service,
      {
        image: `${imageProject}-${service}`,
        volumes: sources.map(
          (source) => `${nodePath.resolve(source)}:/app/${source}:ro`
        ),
      },
    ])
  );
  await writeFile(
    overridePath,
    JSON.stringify({
      services: {
        ...services,
        "minio-artifacts": { image: `${imageProject}-minio-artifacts` },
        "minio-runtime": { image: `${imageProject}-minio-runtime` },
      },
    })
  );
  return { directory, path: overridePath };
};
const createDeployment = async () => {
  const debug = await debugSources();
  const project = `cerebro-chat-${randomUUID().slice(0, 8)}`;
  const [apiPort, webPort] = await Promise.all([freePort(), freePort()]);
  const endpoint = `http://localhost:${apiPort}`;
  const webOrigin = `http://localhost:${webPort}`;
  const docker = async (...args: string[]) =>
    await exec(
      "docker",
      [
        "compose",
        "-p",
        project,
        ...(debug ? ["-f", "compose.yaml", "-f", debug.path] : []),
        ...args,
      ],
      {
        env: {
          ...process.env,
          CEREBRO_API_PORT: String(apiPort),
          CEREBRO_DEPLOY_MODE: "local",
          CEREBRO_PUBLIC_API_URL: endpoint,
          CEREBRO_PUBLIC_WEB_URL: webOrigin,
          CEREBRO_WEB_PORT: String(webPort),
          COMPOSE_PROFILES: "",
        },
        maxBuffer: 12 * 1024 * 1024,
        timeout: 720_000,
      }
    );
  const cleanup = async () => {
    try {
      await docker("down", "--volumes");
    } finally {
      if (debug) {
        await rm(debug.directory, { force: true, recursive: true });
      }
    }
  };
  let cookie = "";
  const request = async (path: string, body?: unknown) =>
    await fetch(new URL(path, endpoint), {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        Origin: webOrigin,
      },
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(10_000),
    });
  const json = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await request(path, body);
    assert.ok(
      response.ok,
      `Setup request failed with status ${response.status}.`
    );
    return await response.json();
  };
  try {
    await docker(
      "up",
      ...(debug ? ["--no-build"] : ["--build"]),
      "--detach",
      "--wait"
    );
    const ready = await request("/ready");
    assert.equal(ready.status, 200);
    const fixture = await request("/fixture/sessions/disabled");
    assert.equal(fixture.status, 404);
    const services = await docker("ps", "--services");
    assert.ok(!services.stdout.split("\n").includes("fixture"));
    const signup = await request("/api/auth/sign-up/email", {
      email: `chat-${randomUUID()}@example.test`,
      name: "Chat streaming check",
      password: randomUUID(),
    });
    assert.equal(signup.status, 200);
    cookie = signup.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    const token = await docker(
      "run",
      "--rm",
      "--no-deps",
      "bootstrap",
      "node",
      "--input-type=module",
      "-e",
      'import {readFile} from "node:fs/promises";process.stdout.write(await readFile("/run/cerebro-secrets/bootstrap-token","utf8"))'
    );
    const setup = z.object({ mode: z.string(), owner: z.boolean() }).parse(
      await json("/api/product/setup", {
        bootstrapToken: token.stdout.trim(),
        operationId: "chat-owner",
      })
    );
    assert.equal(setup.mode, "local");
    assert.equal(setup.owner, true);
    const catalog = z
      .object({ modelChoices: z.array(z.object({ id: z.string() })) })
      .parse(await json("/api/product/catalog"));
    const model = catalog.modelChoices.find(
      (choice) =>
        choice.id.startsWith("opencode/") && choice.id.endsWith("-free")
    );
    assert.ok(model, "The isolated stack has no free OpenCode model.");
    await json("/api/product/agents", {
      enabledToolIds: [],
      grants: [],
      instructions: "Answer the user directly. Do not use tools.",
      model: model.id,
      name: "Chat streaming verification",
      operationId: "chat-agent",
    });
    process.stdout.write(`Disposable native chat stack ready in ${project}.\n`);
    const settledUsage = async () => {
      const result = await docker(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "cerebro",
        "-d",
        "cerebro",
        "-At",
        "-c",
        "SELECT count(*), coalesce(sum(incurred),0) FROM usage_reservation WHERE unit='usd-micro' AND state='settled'"
      );
      return result.stdout.trim();
    };
    const activeSessions = async () => {
      const result = await docker(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "cerebro",
        "-d",
        "cerebro",
        "-At",
        "-c",
        "SELECT count(*) FROM session WHERE expires_at > now()"
      );
      return Number(result.stdout.trim());
    };
    const diagnostics = async () => {
      const result = await docker(
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "cerebro",
        "-d",
        "cerebro",
        "-At",
        "-c",
        "SELECT json_build_object('name',name,'kind',kind,'stage',payload->>'stage','status',payload->>'status','code',payload->>'code') FROM cerebro_audit_event WHERE name='runtime.failed'; SELECT json_build_object('state',state->>'state','status',state->'result'->>'status','code',state->'result'->>'code','reason',state->'result'->>'reason') FROM usage_remote_operation;"
      );
      process.stderr.write(
        `Native failure classifications: ${result.stdout.trim()}\n`
      );
      const journal = await docker(
        "exec",
        "-T",
        "celld",
        "node",
        "--input-type=module",
        "-e",
        await readFile(
          new URL("chat-journal-diagnostics.mjs", import.meta.url),
          "utf-8"
        )
      );
      process.stderr.write(`Native model journal: ${journal.stdout.trim()}\n`);
    };
    return {
      activeSessions,
      api: endpoint,
      cleanup,
      cookie,
      diagnostics,
      origin: webOrigin,
      settledUsage,
    };
  } catch (error) {
    try {
      const logs = await docker("logs", "--no-log-prefix", "bootstrap");
      const setupFailure = `${logs.stdout}\n${logs.stderr}`
        .split("\n")
        .filter(
          (line) =>
            /error|failed|cannot|could not|src\//iu.test(line) &&
            !/postgres(?:ql)?:\/\/|password|secret|token/iu.test(line)
        )
        .join("\n")
        .slice(0, 4096);
      process.stderr.write(`Native setup failure: ${setupFailure}\n`);
    } finally {
      await cleanup();
    }
    throw error;
  }
};
const target = (
  deployment: Awaited<ReturnType<typeof createDeployment>> | undefined
) => ({
  cookie: deployment?.cookie ?? process.env.CEREBRO_CHAT_COOKIE ?? "",
  endpoint: deployment?.api ?? api,
  webOrigin: deployment?.origin ?? origin,
});
const wire = {
  request: "cf_agent_use_chat_request",
  response: "cf_agent_use_chat_response",
  resume: "cf_agent_stream_resuming",
  resumeAck: "cf_agent_stream_resume_ack",
  resumeNone: "cf_agent_stream_resume_none",
  resumeRequest: "cf_agent_stream_resume_request",
} as const;
const frameSchema = z.object({
  body: z.string().optional(),
  done: z.boolean().optional(),
  error: z.boolean().optional(),
  id: z.string().optional(),
  probeId: z.string().optional(),
  replay: z.boolean().optional(),
  type: z.string(),
});
type Frame = z.infer<typeof frameSchema> & { readonly at: number };
const chunkSchema = z.object({
  data: z.unknown().optional(),
  delta: z.string().optional(),
  type: z.string(),
});
const chunk = (frame: Frame) => {
  if (frame.type !== wire.response || !frame.body || frame.error) {
    return;
  }
  return chunkSchema.parse(JSON.parse(frame.body));
};
const completed = (frame: Frame): boolean => {
  const value = chunk(frame);
  if (value?.type !== "data-conversation-item") {
    return false;
  }
  const item = z
    .object({ run: z.object({ state: z.string() }), type: z.literal("run") })
    .safeParse(value.data);
  return item.success && item.data.run.state === "completed";
};
const summarizeFrames = (frames: readonly Frame[]) => {
  const counts = new Map<string, number>();
  for (const frame of frames) {
    const kind = `${frame.type}/${chunk(frame)?.type ?? "control"}`;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return JSON.stringify(Object.fromEntries(counts));
};
const reportFailure = (
  phase: string,
  first: readonly Frame[],
  resumed: readonly Frame[] | undefined,
  revocationStart: number,
  revocationProbe: string | undefined
) => {
  const frames = resumed ?? [];
  process.stderr.write(
    `Chat failure phase: ${phase}. First socket frames: ${summarizeFrames(first)}. Resumed socket frames: ${summarizeFrames(frames)}.\n`
  );
  const replied =
    revocationProbe !== undefined &&
    frames.some((frame) => frame.probeId === revocationProbe);
  process.stderr.write(
    `Revocation phase frames: ${summarizeFrames(frames.slice(revocationStart))}. Matching probe reply: ${replied}.\n`
  );
};

const waitForDisconnectedCompletion = async (
  json: (path: string) => Promise<unknown>,
  path: string,
  signal: AbortSignal
) => {
  while (!signal.aborted) {
    const view = z
      .object({
        snapshot: z.object({ runs: z.array(z.object({ state: z.string() })) }),
      })
      .parse(await json(path));
    const [run] = view.snapshot.runs;
    assert.ok(run);
    assert.ok(
      !["failed", "unknown-outcome"].includes(run.state),
      `The disconnected run ended in ${run.state}.`
    );
    if (run.state === "completed") {
      return;
    }
    await delay(100, undefined, { signal });
  }
  throw new Error("The disconnected run did not complete before the deadline.");
};

const connect = async (
  url: URL,
  cookie: string,
  signal: AbortSignal,
  resumeRequestId?: string,
  socketOrigin = origin
) => {
  const socket = new WebSocket(url, {
    handshakeTimeout: 10_000,
    headers: { Cookie: cookie, Origin: socketOrigin },
  });
  const frames: Frame[] = [];
  const waiters = new Set<() => void>();
  let failure: Error | undefined;
  let acknowledged = false;
  const notify = () => {
    for (const waiter of waiters) {
      waiter();
    }
  };
  const abort = () => {
    failure = new Error("The live chat check exceeded its deadline.");
    socket.terminate();
    notify();
  };
  signal.addEventListener("abort", abort, { once: true });
  socket.on("message", (raw: unknown) => {
    const text = Buffer.isBuffer(raw) ? raw.toString("utf-8") : String(raw);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      failure = new Error("The chat socket returned invalid JSON.");
      notify();
      return;
    }
    const parsed = frameSchema.safeParse(value);
    if (!parsed.success) {
      return;
    }
    const frame = { ...parsed.data, at: performance.now() };
    frames.push(frame);
    if (
      resumeRequestId &&
      !acknowledged &&
      (frame.type === wire.resume || frame.type === wire.resumeNone)
    ) {
      acknowledged = true;
      socket.send(
        JSON.stringify({ id: resumeRequestId, type: wire.resumeAck })
      );
    }
    if (frame.error) {
      failure = new Error(frame.body || "The chat stream failed.");
    }
    notify();
  });
  socket.on("error", (error: Error) => {
    failure = error;
    notify();
  });
  socket.on("close", (code: number) => {
    signal.removeEventListener("abort", abort);
    failure ??= new Error(
      `The chat socket closed with code ${code} before its expected response.`
    );
    notify();
  });
  const opened = Promise.withResolvers<null>();
  socket.once("open", () => opened.resolve(null));
  socket.once("error", opened.reject);
  socket.once("close", () => opened.reject(failure));
  await opened.promise;
  const waitFor = (predicate: (frame: Frame) => boolean): Promise<Frame> => {
    const pending = Promise.withResolvers<Frame>();
    const check = () => {
      const found = frames.find(predicate);
      if (found) {
        waiters.delete(check);
        pending.resolve(found);
      } else if (failure) {
        waiters.delete(check);
        pending.reject(failure);
      }
    };
    waiters.add(check);
    check();
    return pending.promise;
  };
  if (resumeRequestId) {
    socket.send(
      JSON.stringify({ probeId: randomUUID(), type: wire.resumeRequest })
    );
  }
  return { frames, socket, waitFor };
};

const rejectedSocket = (
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<number> => {
  const pending = Promise.withResolvers<number>();
  const socket = new WebSocket(url, { handshakeTimeout: 10_000, headers });
  const abort = () => {
    socket.terminate();
    pending.reject(
      new Error("The WebSocket authorization check exceeded its deadline.")
    );
  };
  signal.addEventListener("abort", abort, { once: true });
  socket.once(
    "unexpected-response",
    (_request: unknown, response: IncomingMessage) => {
      signal.removeEventListener("abort", abort);
      response.resume();
      socket.terminate();
      pending.resolve(response.statusCode ?? 0);
    }
  );
  socket.once("error", (error: Error) => {
    signal.removeEventListener("abort", abort);
    pending.reject(error);
  });
  socket.once("open", () => {
    signal.removeEventListener("abort", abort);
    socket.terminate();
    pending.reject(
      new Error("An unauthorized WebSocket connection was accepted.")
    );
  });
  return pending.promise;
};

const signOutSocket = async (
  socket: WebSocket,
  call: (path: string, body?: unknown) => Promise<Response>,
  deployment: Awaited<ReturnType<typeof createDeployment>> | undefined,
  started: number
) => {
  const closed = Promise.withResolvers<number>();
  const registeredAt = performance.now();
  socket.once("close", (code: number) => closed.resolve(code));
  const sessionsBefore = await deployment?.activeSessions();
  const response = await call("/api/auth/sign-out", {});
  const sessionsAfter = await deployment?.activeSessions();
  const remaining = await call("/api/auth/get-session");
  const sessionResult = z
    .object({ session: z.unknown().optional() })
    .nullable()
    .parse(await remaining.json());
  const hasSession = Boolean(sessionResult?.session);
  process.stdout.write(
    `Sign-out status ${response.status}. Active session rows before ${sessionsBefore ?? "unavailable"}; after ${sessionsAfter ?? "unavailable"}. Original-cookie session present: ${hasSession}. Close listener registered at ${Math.round(registeredAt - started)} ms; sign-out checks ended at ${Math.round(performance.now() - started)} ms.\n`
  );
  const probeId = randomUUID();
  socket.send(JSON.stringify({ probeId, type: wire.resumeRequest }));
  return {
    closed: closed.promise,
    hasSession,
    probeId,
    sessionsAfter,
    sessionsBefore,
    status: response.status,
  };
};

test(
  policyCloseOnly
    ? "native chat delivers policy closure for an unsupported socket command"
    : "native chat streams early text and resumes without duplicate admission or usage",
  { timeout: api ? 150_000 : 900_000 },
  async (context) => {
    const deployment = api ? undefined : await createDeployment();
    if (deployment) {
      context.after(deployment.cleanup);
    }
    const selected = target(deployment);
    const { endpoint, webOrigin } = selected;
    assert.ok(endpoint);
    const signal = AbortSignal.timeout(120_000);
    let { cookie } = selected;
    const call = async (path: string, body?: unknown): Promise<Response> =>
      await fetch(new URL(path, endpoint), {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie,
          Origin: webOrigin,
        },
        method: body === undefined ? "GET" : "POST",
        signal,
      });
    const json = async (path: string, body?: unknown): Promise<unknown> => {
      const response = await call(path, body);
      assert.equal(
        response.ok,
        true,
        `The live API request failed with status ${response.status}.`
      );
      return await response.json();
    };
    if (!cookie) {
      const signin = await call("/api/auth/sign-in/email", {
        email: process.env.CEREBRO_CHAT_EMAIL ?? "session6-pilot@example.test",
        password: process.env.CEREBRO_CHAT_PASSWORD ?? "Session6-fixture-2026!",
      });
      assert.equal(
        signin.status,
        200,
        "The existing pilot account could not sign in."
      );
      cookie = signin.headers
        .getSetCookie()
        .map((entry) => entry.split(";")[0])
        .join("; ");
      assert.ok(cookie, "Sign-in returned no session cookie.");
    }
    const catalog = z
      .object({ modelChoices: z.array(z.object({ id: z.string() })) })
      .parse(await json("/api/product/catalog"));
    const available = new Set(catalog.modelChoices.map((model) => model.id));
    const agents = z
      .object({
        agents: z.array(z.object({ agentId: z.string(), model: z.string() })),
      })
      .parse(await json("/api/product/agents"));
    const agent = agents.agents.find((candidate) =>
      availableOpenCodeAgent(candidate.model, available)
    );
    assert.ok(
      agent,
      "The pilot account needs an agent configured with an available OpenCode model."
    );
    const conversation = z.object({ conversationId: z.string() }).parse(
      await json("/api/product/conversations", {
        agentId: agent.agentId,
        operationId: `chat-check:${randomUUID()}`,
      })
    );
    const path = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
    const socketUrl = new URL(`${path}/chat`, endpoint);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("_pk", randomUUID());
    assert.equal(
      await rejectedSocket(
        socketUrl,
        {
          Origin: webOrigin,
          "x-cerebro-chat-conversation": conversation.conversationId,
          "x-cerebro-chat-user": "forged-owner",
        },
        signal
      ),
      401
    );
    assert.equal(
      await rejectedSocket(
        socketUrl,
        { Cookie: cookie, Origin: "https://foreign.example.test" },
        signal
      ),
      403
    );
    const requestId = randomUUID();
    const eventId = randomUUID();
    const prompt = "Write 250 words explaining how a database index works.";
    const started = performance.now();
    const first = await connect(
      socketUrl,
      cookie,
      signal,
      undefined,
      webOrigin
    );
    let resumed: Awaited<ReturnType<typeof connect>> | undefined;
    let phase = "waiting-first-text";
    let revocationProbe: string | undefined;
    let revocationFramesStart = 0;
    try {
      if (policyCloseOnly) {
        phase = "unsupported-command-policy-close";
        const closed = Promise.withResolvers<number>();
        first.socket.once("close", (code: number) => closed.resolve(code));
        const deadline = setTimeout(() => {
          first.socket.terminate();
          closed.reject(
            new Error(
              "The native unsupported-command policy close was not delivered within ten seconds."
            )
          );
        }, 10_000);
        try {
          first.socket.send(
            JSON.stringify({ type: "unsupported-policy-check" })
          );
          assert.equal(await closed.promise, 4403);
          process.stdout.write(
            "Native unsupported-command policy close delivered with code 4403.\n"
          );
        } finally {
          clearTimeout(deadline);
        }
        return;
      }
      first.socket.send(
        JSON.stringify({
          id: requestId,
          init: {
            body: JSON.stringify({
              messages: [
                {
                  id: eventId,
                  parts: [{ text: prompt, type: "text" }],
                  role: "user",
                },
              ],
              trigger: "submit-message",
            }),
            method: "POST",
          },
          type: wire.request,
        })
      );
      const early = await first.waitFor(
        (frame) =>
          frame.id === requestId &&
          (chunk(frame)?.type === "text-delta" || frame.done === true)
      );
      assert.equal(
        chunk(early)?.type,
        "text-delta",
        "The native model completed without an assistant text delta."
      );
      phase = "active-reconnect";
      const completionIndex = first.frames.findIndex(
        (frame) => completed(frame) || frame.done
      );
      assert.ok(
        completionIndex === -1 || first.frames.indexOf(early) < completionIndex,
        "The first text update arrived after the run completed."
      );
      first.socket.terminate();
      socketUrl.searchParams.set("_pk", randomUUID());
      resumed = await connect(socketUrl, cookie, signal, requestId, webOrigin);
      await resumed.waitFor(
        (frame) =>
          frame.id === requestId &&
          frame.replay === true &&
          chunk(frame)?.type === "text-delta"
      );
      assert.ok(
        resumed.frames.some(
          (frame) => frame.id === requestId && frame.type === wire.resume
        ),
        "The stream completed before its active reconnect check."
      );
      process.stdout.write(
        `First text arrived in ${Math.round(early.at - started)} ms; active reconnect replay passed.\n`
      );
      resumed.socket.terminate();
      phase = "disconnected-completion";
      await waitForDisconnectedCompletion(json, path, signal);
      socketUrl.searchParams.set("_pk", randomUUID());
      resumed = await connect(socketUrl, cookie, signal, requestId, webOrigin);
      phase = "completed-replay";
      const terminal = await resumed.waitFor(
        (frame) =>
          frame.type === wire.response &&
          frame.id === requestId &&
          frame.done === true
      );
      const messages = z
        .array(
          z.object({
            id: z.string(),
            parts: z.array(
              z.object({ text: z.string().optional(), type: z.string() })
            ),
            role: z.string(),
          })
        )
        .parse(await json(`${path}/chat/get-messages`));
      assert.equal(
        messages.filter((message) => message.role === "user").length,
        1
      );
      assert.equal(
        messages.find((message) => message.role === "user")?.id,
        eventId
      );
      const assistants = messages.filter(
        (message) => message.role === "assistant"
      );
      assert.equal(assistants.length, 1);
      const [assistant] = assistants;
      assert.ok(assistant);
      const text = assistant.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("");
      assert.ok(
        text.length > 0,
        "Completed reconnect did not restore the authoritative assistant text."
      );
      assert.ok(
        assistant.parts.some((part) => part.type === "data-conversation-item"),
        "Completed reconnect did not restore its domain event history."
      );
      const snapshot = z
        .object({
          snapshot: z.object({
            runs: z.array(z.object({ runId: z.string(), state: z.string() })),
          }),
        })
        .parse(await json(path));
      assert.equal(snapshot.snapshot.runs.length, 1);
      const [run] = snapshot.snapshot.runs;
      assert.ok(run);
      assert.equal(run.state, "completed");
      let usageCount = 0;
      while (!signal.aborted) {
        const audit = z
          .object({
            entries: z.array(
              z.object({ description: z.string(), type: z.string() })
            ),
            state: z.string(),
          })
          .parse(await json(`${path}/audit/${encodeURIComponent(run.runId)}`));
        usageCount = audit.entries.filter(
          (entry) =>
            entry.type === "usage" && entry.description === "usage.recorded"
        ).length;
        if (usageCount > 0) {
          break;
        }
        await delay(250, undefined, { signal });
      }
      assert.equal(
        usageCount,
        1,
        "The single resumed run must have one accounted model request."
      );
      phase = "settled-usage-and-revocation";
      if (deployment) {
        assert.equal(
          await deployment.settledUsage(),
          "1|0",
          "The isolated free model must settle one zero-cost reservation."
        );
      }
      revocationFramesStart = resumed.frames.length;
      const revoked = await signOutSocket(
        resumed.socket,
        call,
        deployment,
        started
      );
      revocationProbe = revoked.probeId;
      assert.equal(revoked.status, 200);
      assert.equal(
        revoked.hasSession,
        false,
        "Sign-out kept the original session cookie valid."
      );
      if (deployment) {
        assert.equal(revoked.sessionsBefore, 1);
        assert.equal(
          revoked.sessionsAfter,
          0,
          "Sign-out did not delete the bound session row."
        );
      }
      assert.equal(
        await revoked.closed,
        4401,
        "Signing out did not revoke the existing chat socket."
      );
      process.stdout.write(
        `Chat check passed. First text ${Math.round(early.at - started)} ms. Completion ${Math.round(terminal.at - started)} ms. Restored text ${text.length} characters. One user message, one run, one usage receipt.\n`
      );
    } catch (error) {
      reportFailure(
        phase,
        first.frames,
        resumed?.frames,
        revocationFramesStart,
        revocationProbe
      );
      if (deployment) {
        await deployment.diagnostics();
      }
      throw error;
    } finally {
      first.socket.terminate();
      resumed?.socket.terminate();
    }
  }
);
