/* oxlint-disable no-await-in-loop -- Native observation frames and provider state must be read in order. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";
import { z } from "zod";

import {
  ChatObservation,
  ChatReceipt,
  ChatSnapshot,
} from "../../packages/contracts/src/session-service.ts";
import {
  applicationFixture,
  bootApplication,
  initializeFixtureAgent,
  readApplicationBoot,
  waitForFixture,
} from "../slice-1/application.ts";

const viewSchema = z.object({
  agentId: z.string(),
  conversationId: z.string(),
  sessionId: z.string(),
  snapshot: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(ChatSnapshot)(value)),
});
const receiptSchema = z.object({
  receipt: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(ChatReceipt)(value)),
});
const stateSchema = z.object({
  agent: z.object({ agentId: z.string() }),
  boot: z.object({ fixtureId: z.string(), sha: z.string() }),
  owner: z.object({
    cookie: z.string(),
    email: z.string(),
    password: z.string(),
    userId: z.string(),
  }),
});
const openObservation = async (
  fixture: ReturnType<typeof applicationFixture>,
  route: string,
  cookie: string
) => {
  const controller = new AbortController();
  const response = await fetch(`${fixture.boot.apiUrl}${route}/observations`, {
    headers: {
      Accept: "application/x-ndjson",
      Cookie: cookie,
      Origin: fixture.boot.webUrl,
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.ok(
    response.headers.get("content-type")?.startsWith("application/x-ndjson")
  );
  assert.ok(response.body);
  const reader = response.body.getReader();
  const frames: (ChatObservation & { readonly receivedAt: number })[] = [];
  let failure: unknown;
  let ended = false;
  const completion = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          ended = true;
          break;
        }
        buffer += decoder.decode(next.value, { stream: true });
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index === -1) {
            break;
          }
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line) {
            frames.push({
              ...Schema.decodeUnknownSync(ChatObservation)(JSON.parse(line)),
              receivedAt: Date.now(),
            });
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        failure = error;
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const waitFor = async (
    predicate: (
      frame: ChatObservation & { readonly receivedAt: number }
    ) => boolean,
    timeoutMs = 30_000
  ) => {
    await waitForFixture(
      () => {
        if (failure) {
          throw failure;
        }
        return frames;
      },
      (values) => values.some(predicate),
      timeoutMs
    );
    const found = frames.find(predicate);
    assert.ok(found);
    return found;
  };
  const close = async () => {
    controller.abort();
    await completion;
  };
  return { close, ended: () => ended, frames, waitFor };
};
const readProvider = async (fixture: ReturnType<typeof applicationFixture>) =>
  z
    .object({
      model: z.array(
        z.object({
          completedAt: z.number().optional(),
          operationId: z.string(),
        })
      ),
      tools: z.array(z.object({ write: z.boolean() })),
    })
    .parse(await fixture.observations());

const application = async () => {
  const statePath = process.env.CEREBRO_APPLICATION_STATE;
  if (statePath) {
    const state = stateSchema.parse(
      JSON.parse(await readFile(statePath, "utf-8"))
    );
    const boot = await readApplicationBoot(
      path.resolve(
        "artifacts/slice-1",
        state.boot.sha,
        state.boot.fixtureId,
        "boot.json"
      )
    );
    return {
      agent: state.agent,
      auth: state.owner,
      fixture: applicationFixture(boot),
      owned: false,
    };
  }
  const fixture = applicationFixture(await bootApplication("native-chat"));
  const auth = await fixture.signup("Native chat acceptance");
  const agent = await initializeFixtureAgent(fixture, auth);
  return { agent, auth, fixture, owned: true };
};

test(
  "native observations stream text, reconnect, Stop, and close on committed sign-out",
  { timeout: 20 * 60_000 },
  async () => {
    const { agent, auth, fixture, owned } = await application();
    const { boot } = fixture;
    const directory = path.resolve(
      "artifacts/slice-1",
      boot.sha,
      boot.fixtureId
    );
    const observations: Awaited<ReturnType<typeof openObservation>>[] = [];
    let passed = false;
    try {
      const created = await fixture.json(
        "/api/product/conversations",
        auth.cookie,
        z.object({ conversationId: z.string() }),
        { agentId: agent.agentId, operationId: randomUUID() }
      );
      const route = `/api/product/conversations/${encodeURIComponent(created.conversationId)}`;
      const initialProvider = await readProvider(fixture);
      const unauthenticated = await fixture.request(
        `${route}/observations`,
        ""
      );
      assert.equal(unauthenticated.status, 401);
      await unauthenticated.body?.cancel();
      await fixture.controls({ delayMs: 1000, failFirst: false });
      const first = await openObservation(fixture, route, auth.cookie);
      observations.push(first);
      const initial = await first.waitFor((frame) => frame.type === "snapshot");
      assert.equal(initial.type, "snapshot");
      if (initial.type !== "snapshot") {
        throw new Error("Expected native snapshot");
      }
      assert.deepEqual(initial.snapshot.messages, []);
      assert.equal(initial.snapshot.busy, false);
      const operationId = randomUUID();
      const text = "What is the refund policy?";
      const receipt = await fixture.json(
        `${route}/messages`,
        auth.cookie,
        receiptSchema,
        { operationId, text }
      );
      const duplicate = await fixture.json(
        `${route}/messages`,
        auth.cookie,
        receiptSchema,
        { operationId, text }
      );
      assert.equal(receipt.receipt.accepted, true);
      assert.equal(duplicate.receipt.accepted, false);
      assert.equal(receipt.receipt.session, duplicate.receipt.session);
      const early = await first.waitFor(
        (frame) =>
          frame.type === "snapshot" &&
          frame.snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.state === "streaming" &&
              message.text.length > 0
          )
      );
      if (early.type !== "snapshot") {
        throw new Error("Expected early native snapshot");
      }
      const partial = early.snapshot.messages.find(
        (message) =>
          message.role === "assistant" && message.state === "streaming"
      );
      assert.ok(partial?.text);
      const during = await readProvider(fixture);
      const physicalCall = during.model.at(-1);
      assert.ok(physicalCall);
      assert.equal(physicalCall.completedAt, undefined);
      await first.close();
      const resumed = await openObservation(fixture, route, auth.cookie);
      observations.push(resumed);
      const reopened = await resumed.waitFor(
        (frame) => frame.type === "snapshot"
      );
      if (reopened.type !== "snapshot") {
        throw new Error("Expected reconnect snapshot");
      }
      assert.ok(
        reopened.snapshot.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.text.startsWith(partial.text)
        )
      );
      const final = await resumed.waitFor(
        (frame) =>
          frame.type === "snapshot" &&
          !frame.snapshot.busy &&
          frame.snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.state === "complete" &&
              message.text === "Cerebro slice 1 completed."
          )
      );
      assert.equal(resumed.ended(), false);
      const completed = await fixture.json(route, auth.cookie, viewSchema);
      assert.equal(
        completed.snapshot.messages.filter(
          (message) => message.role === "user" && message.text === text
        ).length,
        1
      );
      const observed = await readProvider(fixture);
      assert.equal(observed.model.length - initialProvider.model.length, 1);
      if (final.type !== "snapshot") {
        throw new Error("Expected completed native snapshot");
      }
      assert.deepEqual(final.snapshot.messages, completed.snapshot.messages);

      await fixture.controls({ delayMs: 2000 });
      const beforeStop = await readProvider(fixture);
      const stopText = "Stop this request while the model is active.";
      await fixture.json(`${route}/messages`, auth.cookie, receiptSchema, {
        operationId: randomUUID(),
        text: stopText,
      });
      await resumed.waitFor(
        (frame) =>
          frame.type === "snapshot" &&
          frame.snapshot.busy &&
          frame.snapshot.messages.some(
            (message) => message.role === "user" && message.text === stopText
          )
      );
      await waitForFixture(
        () => readProvider(fixture),
        (value) =>
          value.model.length > beforeStop.model.length &&
          value.model.at(-1)?.completedAt === undefined
      );
      const stopped = await fixture.json(
        `${route}/stop`,
        auth.cookie,
        z.object({ stopped: z.boolean() }),
        {}
      );
      assert.equal(stopped.stopped, true);
      await waitForFixture(
        () => fixture.json(route, auth.cookie, viewSchema),
        (view) => !view.snapshot.busy,
        30_000
      );
      assert.equal(resumed.ended(), false);
      await resumed.close();

      const finalObserver = await openObservation(fixture, route, auth.cookie);
      observations.push(finalObserver);
      await finalObserver.waitFor((frame) => frame.type === "snapshot");
      const signOutStartedAt = Date.now();
      const signedOut = await fixture.request(
        "/api/auth/sign-out",
        auth.cookie,
        {}
      );
      assert.equal(signedOut.status, 200);
      await signedOut.body?.cancel();
      const denial = await finalObserver.waitFor(
        (frame) => frame.type === "access-denied",
        4000
      );
      assert.ok(denial.receivedAt - signOutStartedAt <= 3500);
      await waitForFixture(() => finalObserver.ended(), Boolean, 3000);
      assert.equal(finalObserver.frames.at(-1)?.type, "access-denied");
      const revokedRead = await fixture.request(route, auth.cookie);
      assert.equal(revokedRead.status, 401);
      await revokedRead.body?.cancel();
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "native-chat.json"),
        `${JSON.stringify({ boot, completed, denial, duplicate, early, frames: observations.map((observer) => observer.frames), provider: await readProvider(fixture), receipt, reopened, stopped }, null, 2)}\n`
      );
      passed = true;
    } catch (error) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "native-chat-failure.json"),
        `${JSON.stringify({ boot, error: error instanceof Error ? { message: error.message, name: error.name } : String(error), frames: observations.map((observer) => observer.frames) }, null, 2)}\n`
      );
      throw error;
    } finally {
      for (const observer of observations) {
        await observer.close();
      }
      await fixture.controls({ delayMs: 100, failFirst: false });
      if (owned && passed) {
        await fixture.close();
      }
      if (owned && !passed) {
        process.stderr.write(
          `Failed owned native chat stack retained: ${boot.fixtureId}\n`
        );
      }
    }
  }
);
