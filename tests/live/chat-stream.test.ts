/* oxlint-disable no-await-in-loop -- Read ordered observation frames and poll actual committed state. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";
import { z } from "zod";

import { Observation } from "../../packages/contracts/src/session-service.ts";
import {
  applicationFixture,
  bootApplication,
  initializeFixtureAgent,
  waitForFixture,
} from "../slice-1/application.ts";

const snapshotSchema = z
  .object({
    outputs: z.array(
      z.object({
        answerId: z.string(),
        citations: z.array(z.unknown()),
        dependencies: z.object({
          sourceIds: z.array(z.string()),
          toolIds: z.array(z.string()),
        }),
        text: z.string(),
      })
    ),
    revision: z.number(),
    runs: z.array(z.object({ runId: z.string(), state: z.string() })),
    userMessages: z.array(z.object({ eventId: z.string(), text: z.string() })),
  })
  .passthrough();
const viewSchema = z
  .object({ items: z.array(z.unknown()), snapshot: snapshotSchema })
  .passthrough();
type Frame = Observation & { readonly receivedAt: number };

const openObservation = async (
  fixture: ReturnType<typeof applicationFixture>,
  route: string,
  cookie: string,
  generation = 0
) => {
  const controller = new AbortController();
  const response = await fetch(
    `${fixture.boot.apiUrl}${route}/observations?accessGeneration=${generation}`,
    {
      headers: { Cookie: cookie, Origin: fixture.boot.webUrl },
      signal: controller.signal,
    }
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/x-ndjson/u
  );
  assert.ok(response.body);
  const frames: Frame[] = [];
  let failure: unknown;
  let ended = false;
  const reader = response.body.getReader();
  const completion = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) {
          ended = true;
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        for (;;) {
          const index = buffer.indexOf("\n");
          if (index === -1) {
            break;
          }
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line) {
            frames.push({
              ...Schema.decodeUnknownSync(Observation)(JSON.parse(line)),
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
    predicate: (frame: Frame) => boolean,
    timeoutMs = 30_000
  ): Promise<Frame> => {
    const values = await waitForFixture(
      () => {
        if (failure) {
          throw failure;
        }
        return frames;
      },
      (value) => value.some(predicate),
      timeoutMs
    );
    const found = values.find(predicate);
    assert.ok(found);
    return found;
  };
  const close = async () => {
    controller.abort();
    await completion;
  };
  return { close, completion, ended: () => ended, frames, waitFor };
};

const readProvider = async (fixture: ReturnType<typeof applicationFixture>) =>
  z
    .object({
      model: z.array(
        z.object({
          completedAt: z.number().optional(),
          firstTokenAt: z.number().optional(),
          operationId: z.string(),
          startedAt: z.number(),
        })
      ),
      tools: z.array(z.object({ write: z.boolean() })),
    })
    .passthrough()
    .parse(await fixture.observations());

test(
  "application observation streams early text, reattaches canonical state, and closes on committed sign-out",
  { timeout: 240_000 },
  async () => {
    const boot = await bootApplication("chat");
    const fixture = applicationFixture(boot);
    const directory = path.join("artifacts/slice-1", boot.sha, boot.fixtureId);
    const observations: Awaited<ReturnType<typeof openObservation>>[] = [];
    let passed = false;
    try {
      const auth = await fixture.signup("Chat observation acceptance");
      const agent = await initializeFixtureAgent(fixture, auth);
      const created = await fixture.json(
        "/api/product/conversations",
        auth.cookie,
        z.object({ conversationId: z.string(), sessionId: z.string() }),
        { agentId: agent.agentId, operationId: randomUUID() }
      );
      const route = `/api/product/conversations/${encodeURIComponent(created.conversationId)}`;
      const initial = await readProvider(fixture);
      for (const [suffix, cookie, statuses] of [
        ["/observations?accessGeneration=0", "", [401]],
        ["/chat", auth.cookie, [404]],
        ["/chat/get-messages", auth.cookie, [404]],
      ] as const) {
        const denied = await fixture.request(`${route}${suffix}`, cookie);
        assert.ok(
          statuses.some((status) => status === denied.status),
          `${suffix}: ${denied.status}`
        );
        await denied.body?.cancel();
      }
      const other = await fixture.signup("Other company user");
      const foreignOrigin = await fetch(
        `${boot.apiUrl}${route}/observations?accessGeneration=0`,
        {
          headers: {
            Cookie: auth.cookie,
            Origin: "https://foreign.example.test",
          },
        }
      );
      assert.equal(foreignOrigin.status, 403);
      await foreignOrigin.body?.cancel();
      const otherHistory = await fixture.request(
        `${route}/history`,
        other.cookie
      );
      assert.ok([403, 404].includes(otherHistory.status));
      await otherHistory.body?.cancel();
      const deniedProvider = await readProvider(fixture);
      assert.equal(deniedProvider.model.length, initial.model.length);
      assert.equal(deniedProvider.tools.length, initial.tools.length);
      await fixture.controls({ delayMs: 600, failFirst: false });
      const first = await openObservation(fixture, route, auth.cookie);
      observations.push(first);
      const snapshot = await first.waitFor(
        (frame) => frame.type === "snapshot"
      );
      assert.ok(snapshot.type === "snapshot");
      assert.deepEqual(snapshot.address, {
        agentId: agent.agentId,
        conversationId: created.conversationId,
        organizationId: agent.organizationId,
        sessionId: created.sessionId,
      });
      assert.equal(snapshot.snapshot?.runs.length, 0);
      const eventId = randomUUID();
      const submittedAt = Date.now();
      const responses = await Promise.all(
        Array.from({ length: 2 }, () =>
          fixture.request(`${route}/messages`, auth.cookie, {
            eventId,
            mode: "follow-up",
            text: "What is the refund policy?",
          })
        )
      );
      const receipts: {
        readonly acceptedEventId: string;
        readonly runId: string;
        readonly sessionId: string;
      }[] = [];
      for (const response of responses) {
        assert.equal(response.status, 200);
        receipts.push(
          z
            .object({
              receipt: z.object({
                acceptedEventId: z.string(),
                runId: z.string(),
                sessionId: z.string(),
              }),
            })
            .passthrough()
            .parse(await response.json()).receipt
        );
      }
      assert.equal(receipts[0].acceptedEventId, receipts[1].acceptedEventId);
      assert.equal(receipts[0].runId, receipts[1].runId);
      const changed = await fixture.request(`${route}/messages`, auth.cookie, {
        eventId,
        mode: "follow-up",
        text: "Changed accepted text",
      });
      assert.equal(changed.status, 409);
      await changed.body?.cancel();
      const early = await first.waitFor(
        (frame) =>
          frame.type === "update" &&
          frame.update?.type === "provisional-text" &&
          Boolean(frame.update.text)
      );
      const during = await readProvider(fixture);
      const call = during.model.find(
        (row) => row.operationId === receipts[0].runId
      );
      assert.ok(call);
      assert.equal(
        call.completedAt,
        undefined,
        "First text must precede provider EOF"
      );
      await first.close();
      const resumed = await openObservation(fixture, route, auth.cookie);
      observations.push(resumed);
      const reopened = await resumed.waitFor(
        (frame) => frame.type === "snapshot"
      );
      assert.ok(reopened.type === "snapshot");
      assert.notEqual(reopened.epoch, snapshot.epoch);
      await resumed.close();
      const completed = await waitForFixture(
        () => fixture.json(route, auth.cookie, viewSchema),
        (view) => view.snapshot.runs.some((run) => run.state === "completed"),
        30_000
      );
      assert.equal(completed.snapshot.runs.length, 1);
      assert.equal(completed.snapshot.outputs.length, 1);
      assert.equal(completed.snapshot.userMessages.length, 1);
      assert.equal(
        completed.snapshot.userMessages[0].eventId,
        receipts[0].acceptedEventId
      );
      assert.equal(
        completed.snapshot.outputs[0].text,
        "Cerebro slice 1 completed."
      );
      assert.ok(completed.snapshot.outputs[0].citations.length > 0);
      assert.ok(
        completed.snapshot.outputs[0].dependencies.sourceIds.includes(
          "pilot-source"
        )
      );
      const finalObserver = await openObservation(fixture, route, auth.cookie);
      observations.push(finalObserver);
      const restored = await finalObserver.waitFor(
        (frame) => frame.type === "snapshot"
      );
      assert.ok(restored.type === "snapshot");
      assert.equal(restored.snapshot?.outputs.length, 1);
      assert.equal(restored.snapshot?.runs[0].state, "completed");
      const finalProvider = await readProvider(fixture);
      assert.equal(
        finalProvider.model.length - initial.model.length,
        1,
        "Observation and duplicate submit must not create another model request"
      );
      assert.equal(finalProvider.tools.length - initial.tools.length, 0);
      const sessionsBefore = Number(
        await fixture.sql(
          `SELECT count(*) FROM session WHERE user_id='${auth.userId.replaceAll("'", "''")}'`
        )
      );
      assert.equal(sessionsBefore, 1);
      const signOutStartedAt = Date.now();
      const signedOut = await fixture.request(
        "/api/auth/sign-out",
        auth.cookie,
        {}
      );
      assert.equal(signedOut.status, 200);
      await signedOut.body?.cancel();
      assert.equal(
        Number(
          await fixture.sql(
            `SELECT count(*) FROM session WHERE user_id='${auth.userId.replaceAll("'", "''")}'`
          )
        ),
        0
      );
      const denial = await finalObserver.waitFor(
        (frame) => frame.type === "access-denied",
        1500
      );
      assert.ok(denial.receivedAt - signOutStartedAt <= 1000);
      await waitForFixture(() => finalObserver.ended(), Boolean, 1000);
      assert.equal(finalObserver.frames.at(-1)?.type, "access-denied");
      const session = await fixture.json(
        "/api/auth/get-session",
        auth.cookie,
        z.null()
      );
      assert.equal(session, null);
      const revokedHistory = await fixture.request(
        `${route}/history`,
        auth.cookie
      );
      assert.equal(revokedHistory.status, 401);
      await revokedHistory.body?.cancel();
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "chat.json"),
        `${JSON.stringify({ denial, early, fixtureId: boot.fixtureId, frames: observations.map((value) => value.frames), provider: finalProvider, receipts, restored, sha: boot.sha, signOutStartedAt, sourceCheckoutDirty: boot.sourceCheckoutDirty, submittedAt, view: completed }, null, 2)}\n`
      );
      passed = true;
    } finally {
      for (const observer of observations) {
        await observer.close();
      }
      if (passed) {
        await fixture.close();
      } else {
        process.stderr.write(
          `Failed disposable chat stack retained: ${boot.fixtureId}\n`
        );
      }
    }
  }
);
