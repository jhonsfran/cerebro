/* oxlint-disable no-await-in-loop -- Native observation frames and dependent authority changes are ordered. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { id } from "@cerebro/contracts/identity";
import {
  DomainSnapshot,
  Observation,
} from "@cerebro/contracts/session-service";
import { Schema } from "effect";
import { z } from "zod";

import {
  applicationFixture,
  readApplicationBoot,
  waitForFixture,
} from "../../slice-1/application.ts";

const execute = promisify(execFile);
const metadataPath = process.env.CHANNEL_NATIVE_METADATA;
if (!metadataPath) {
  throw new Error(
    "Run tests/channels/native/run.mjs to boot a fresh owned application."
  );
}
const metadata = z
  .object({
    agent: z.object({
      agentId: z.string(),
      organizationId: z.string(),
      principalId: z.string(),
      version: z.number(),
    }),
    bootPath: z.string(),
    owner: z.object({ cookie: z.string(), userId: z.string() }),
    sourceCheckoutDirty: z.boolean(),
    sourceIdentity: z.string(),
  })
  .parse(JSON.parse(await readFile(metadataPath, "utf-8")));
const boot = await readApplicationBoot(metadata.bootPath);
const fixture = applicationFixture(boot);
const directory = path.dirname(metadataPath);
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const createdAgent = z.object({ agentId: z.string(), version: z.number() });
const conversationSchema = z.object({
  conversationId: z.string(),
  sessionId: z.string(),
});
const receiptSchema = z.object({
  receipt: z.object({
    acceptedEventId: z.string(),
    replayed: z.boolean(),
    runId: z.string(),
    sessionId: z.string(),
  }),
});
const itemSchema = z
  .object({
    approvalId: z.string().optional(),
    cursor: z.string(),
    runId: z.string().optional(),
    sourceId: z.string().optional(),
    state: z.string().optional(),
    type: z.string(),
  })
  .passthrough();
const viewSchema = z.object({
  cursor: z.string(),
  items: z.array(itemSchema),
  sessionId: z.string(),
  snapshot: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(DomainSnapshot)(value)),
});
const providerSchema = z.object({
  model: z.array(
    z.object({ completedAt: z.number().optional(), operationId: z.string() })
  ),
  tools: z.array(z.object({ operationId: z.string(), write: z.boolean() })),
});
const provider = async () => providerSchema.parse(await fixture.observations());
const firstSnapshot = async (
  route: string,
  cookie: string
): Promise<Observation> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const response = await fetch(
    `${boot.apiUrl}${route}/observations?accessGeneration=0`,
    {
      headers: { Cookie: cookie, Origin: boot.webUrl },
      signal: controller.signal,
    }
  );
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /application\/x-ndjson/u
  );
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const result = await reader.read();
      assert.equal(
        result.done,
        false,
        "An authorized native observation must start with a snapshot"
      );
      buffer += decoder.decode(result.value, { stream: true });
      const index = buffer.indexOf("\n");
      if (index !== -1) {
        const frame = Schema.decodeUnknownSync(Observation)(
          JSON.parse(buffer.slice(0, index))
        );
        assert.equal(frame.type, "snapshot");
        return frame;
      }
    }
  } finally {
    controller.abort();
    clearTimeout(timeout);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};

test(
  "selected native channels preserve publish replay, canonical citations, reconnect, approvals, and current denial",
  { timeout: 240_000 },
  async () => {
    const saved: Record<string, unknown> = {};
    try {
      const initial = await provider();
      const preflight = await fetch(`${boot.apiUrl}/api/auth/sign-in/email`, {
        headers: {
          "Access-Control-Request-Headers": "content-type",
          "Access-Control-Request-Method": "POST",
          Origin: boot.webUrl,
        },
        method: "OPTIONS",
      });
      assert.equal(preflight.status, 204);
      assert.equal(
        preflight.headers.get("Access-Control-Allow-Origin"),
        boot.webUrl
      );
      const { agent, owner } = metadata;
      const publishInput = {
        enabledToolIds: ["fixture-read"],
        grants: [],
        instructions: "Answer from the local source.",
        model: "fixture/slice-1",
        name: "Native publish replay",
        operationId: randomUUID(),
      };
      const published = await fixture.json(
        "/api/product/agents",
        owner.cookie,
        createdAgent,
        publishInput
      );
      const publishedReplay = await fixture.json(
        "/api/product/agents",
        owner.cookie,
        createdAgent,
        publishInput
      );
      assert.equal(published.version, 1);
      assert.deepEqual(publishedReplay, published);
      const conversation = await fixture.json(
        "/api/product/conversations",
        owner.cookie,
        conversationSchema,
        { agentId: agent.agentId, operationId: randomUUID() }
      );
      const route = `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
      const outsider = await fixture.signup("Native channel outsider");
      const outsiderSetup = await fixture.request(
        "/api/product/setup",
        outsider.cookie,
        { operationId: randomUUID() }
      );
      assert.equal(outsiderSetup.status, 403);
      await outsiderSetup.body?.cancel();
      const foreign = await fixture.signup("Native channel foreign company");
      const foreignCompany = `foreign:${randomUUID()}`;
      const foreignPrincipal = `foreign-principal:${randomUUID()}`;
      await fixture.sql(
        `INSERT INTO organization(id,name) VALUES(${literal(foreignCompany)},'Foreign native company'); INSERT INTO identity_principal(id,organization_id,better_auth_user_id,kind,state) VALUES(${literal(foreignPrincipal)},${literal(foreignCompany)},${literal(foreign.userId)},'human','active')`
      );
      const denials = [];
      for (const auth of [outsider, foreign]) {
        for (const suffix of [
          "",
          "/sources/pilot-source",
          "/observations?accessGeneration=0",
          "/messages",
        ]) {
          const response = await fixture.request(
            `${route}${suffix}`,
            auth.cookie,
            suffix === "/messages"
              ? { eventId: randomUUID(), text: "Denied fixture_effect" }
              : undefined
          );
          assert.equal(response.status, 403, suffix);
          denials.push({
            status: response.status,
            suffix,
            userId: auth.userId,
          });
          await response.body?.cancel();
        }
      }
      const originDenied = await fetch(`${boot.apiUrl}${route}`, {
        headers: {
          Cookie: owner.cookie,
          Origin: "https://foreign.example.test",
        },
      });
      assert.equal(originDenied.status, 403);
      await originDenied.body?.cancel();
      assert.deepEqual(await provider(), initial);
      saved.denials = denials;
      saved.publish = { published, publishedReplay };
      const message = {
        eventId: randomUUID(),
        mode: "follow-up",
        text: "What is the refund policy?",
      };
      const responses = await Promise.all([
        fixture.request(`${route}/messages`, owner.cookie, message),
        fixture.request(`${route}/messages`, owner.cookie, message),
      ]);
      const receipts = [];
      for (const response of responses) {
        assert.equal(response.status, 200, await response.clone().text());
        receipts.push(receiptSchema.parse(await response.json()).receipt);
      }
      assert.equal(receipts.length, 2);
      assert.equal(receipts[0].runId, receipts[1].runId);
      assert.equal(receipts[0].acceptedEventId, receipts[1].acceptedEventId);
      const complete = await waitForFixture(
        () => fixture.json(route, owner.cookie, viewSchema),
        (view) =>
          view.snapshot.runs[0]?.state === "completed" &&
          view.items.some((item) => item.type === "citation"),
        60_000
      );
      assert.equal(complete.sessionId, conversation.sessionId);
      assert.equal(complete.snapshot.runs.length, 1);
      assert.equal(complete.snapshot.userMessages.length, 1);
      assert.equal(
        complete.items.filter((item) => item.type === "user").length,
        1
      );
      assert.equal(complete.snapshot.outputs.length, 1);
      const [output] = complete.snapshot.outputs;
      assert.equal(output.text, "Cerebro slice 1 completed.");
      assert.ok(
        output.citations.some(
          (citation) => citation.sourceId === "pilot-source"
        )
      );
      assert.ok(
        output.dependencies.sourceIds.includes(id.source("pilot-source"))
      );
      const citation = complete.items.find((item) => item.type === "citation");
      assert.equal(citation?.sourceId, "pilot-source");
      const source = await fixture.json(
        `${route}/sources/pilot-source`,
        owner.cookie,
        z.object({
          mode: z.literal("local"),
          sourceId: z.literal("pilot-source"),
          text: z.string(),
        })
      );
      assert.match(
        source.text,
        /refunds require current company authorization/u
      );
      const attached = await firstSnapshot(route, owner.cookie);
      const reattached = await firstSnapshot(route, owner.cookie);
      assert.ok(attached.type === "snapshot" && reattached.type === "snapshot");
      assert.notEqual(attached.epoch, reattached.epoch);
      assert.deepEqual(attached.snapshot?.outputs, complete.snapshot.outputs);
      assert.deepEqual(reattached.snapshot?.outputs, complete.snapshot.outputs);
      assert.deepEqual(reattached.address, complete.snapshot.address);
      const exact = await fixture.json(
        `${route}/messages`,
        owner.cookie,
        receiptSchema,
        message
      );
      assert.equal(exact.receipt.replayed, true);
      assert.equal(exact.receipt.runId, receipts[0].runId);
      const baseline = await provider();
      assert.equal(baseline.model.length - initial.model.length, 1);
      assert.equal(baseline.tools.length, initial.tools.length);
      saved.read = { attached, complete, exact, reattached, receipts, source };
      const changedMessage = await fixture.request(
        `${route}/messages`,
        owner.cookie,
        {
          ...message,
          text: "Changed refund policy request with the same event ID",
        }
      );
      const changedBody = await changedMessage.text();
      saved.changedMessage = {
        beforeProvider: baseline,
        body: changedBody,
        status: changedMessage.status,
      };
      assert.equal(changedMessage.status, 409, changedBody);
      const afterConflictProvider = await provider();
      assert.deepEqual(afterConflictProvider, baseline);
      const afterConflict = await fixture.json(route, owner.cookie, viewSchema);
      assert.deepEqual(afterConflict.snapshot.runs, complete.snapshot.runs);
      assert.deepEqual(
        afterConflict.snapshot.userMessages,
        complete.snapshot.userMessages
      );
      assert.deepEqual(
        afterConflict.snapshot.outputs,
        complete.snapshot.outputs
      );
      assert.deepEqual(afterConflict.snapshot.tools, complete.snapshot.tools);
      assert.deepEqual(
        afterConflict.snapshot.approvals,
        complete.snapshot.approvals
      );
      saved.changedMessage = {
        afterConflict,
        afterProvider: afterConflictProvider,
        beforeProvider: baseline,
        body: changedBody,
        status: changedMessage.status,
      };
      const approvalSubmission = await fixture.json(
        `${route}/messages`,
        owner.cookie,
        receiptSchema,
        {
          eventId: randomUUID(),
          mode: "follow-up",
          text: "Run the approval fixture with fixture_effect",
        }
      );
      const waiting = await waitForFixture(
        () => fixture.json(route, owner.cookie, viewSchema),
        (view) =>
          view.snapshot.approvals.some(
            (approval) => approval.state === "pending"
          ) &&
          view.items.some(
            (item) => item.type === "approval" && item.state === "pending"
          ),
        60_000
      );
      const approval = waiting.snapshot.approvals.find(
        (value) => value.state === "pending"
      );
      assert.ok(approval);
      assert.equal(approval.runId, approvalSubmission.receipt.runId);
      const beforeApproval = await provider();
      assert.equal(beforeApproval.tools.filter((tool) => tool.write).length, 0);
      const pendingFrame = await firstSnapshot(route, owner.cookie);
      assert.ok(pendingFrame.type === "snapshot");
      assert.equal(
        pendingFrame.snapshot?.approvals.find(
          (value) => value.approvalId === approval.approvalId
        )?.state,
        "pending"
      );
      const pendingSql = await fixture.sql(
        `SELECT json_agg(item) FROM channel_item WHERE conversation_id=${literal(conversation.conversationId)} AND item->>'type'='approval'`
      );
      const containerId = await fixture.container("celld");
      await execute("rtk", [
        "proxy",
        "docker",
        "kill",
        "--signal",
        "SIGKILL",
        containerId,
      ]);
      await execute("rtk", ["proxy", "docker", "start", containerId]);
      await waitForFixture(
        async () => {
          try {
            const response = await fetch(`${boot.apiUrl}/ready`, {
              signal: AbortSignal.timeout(2000),
            });
            await response.body?.cancel();
            return response.status;
          } catch (error) {
            if (
              !(error instanceof TypeError) &&
              !(
                error instanceof DOMException &&
                ["AbortError", "TimeoutError"].includes(error.name)
              )
            ) {
              throw error;
            }
            return 0;
          }
        },
        (status) => status === 200,
        60_000
      );
      const reopened = await waitForFixture(
        () => fixture.json(route, owner.cookie, viewSchema),
        (view) =>
          view.snapshot.approvals.some(
            (value) =>
              value.approvalId === approval.approvalId &&
              value.state === "pending"
          ),
        60_000
      );
      assert.equal(
        reopened.snapshot.runs.find((run) => run.runId === approval.runId)
          ?.state,
        "waiting-for-approval"
      );
      const afterRestart = await provider();
      assert.equal(afterRestart.tools.filter((tool) => tool.write).length, 0);
      const approvalRoute = `${route}/approvals/${encodeURIComponent(approval.approvalId)}`;
      const deniedApproval = await fixture.request(
        approvalRoute,
        outsider.cookie,
        { decision: "allow", operationId: randomUUID(), runId: approval.runId }
      );
      assert.equal(deniedApproval.status, 403);
      await deniedApproval.body?.cancel();
      const invalidApproval = await fixture.request(
        approvalRoute,
        owner.cookie,
        { operationId: randomUUID() }
      );
      assert.equal(invalidApproval.status, 422);
      await invalidApproval.body?.cancel();
      const decision = {
        decision: "allow",
        operationId: randomUUID(),
        runId: approval.runId,
      };
      await fixture.json(
        approvalRoute,
        owner.cookie,
        z.object({ run: z.unknown() }),
        decision
      );
      const allowed = await waitForFixture(
        () => fixture.json(route, owner.cookie, viewSchema),
        (view) =>
          view.snapshot.runs.every((run) => run.state === "completed") &&
          view.snapshot.approvals.find(
            (value) => value.approvalId === approval.approvalId
          )?.state === "allowed",
        60_000
      );
      await fixture.json(
        approvalRoute,
        owner.cookie,
        z.object({ run: z.unknown() }),
        decision
      );
      assert.equal(allowed.snapshot.outputs.length, 2);
      assert.equal(
        allowed.snapshot.tools.find(
          (tool) => tool.operationId === approval.operationId
        )?.state,
        "succeeded"
      );
      const afterAllow = await provider();
      assert.equal(afterAllow.tools.filter((tool) => tool.write).length, 1);
      saved.approval = {
        afterAllow,
        allowed,
        containerId,
        pendingFrame,
        pendingSql,
        reopened,
        waiting,
      };
      const denialSubmit = await fixture.json(
        `${route}/messages`,
        owner.cookie,
        receiptSchema,
        {
          eventId: randomUUID(),
          mode: "follow-up",
          text: "Run the approval fixture; deny fixture_effect",
        }
      );
      const denialWait = await waitForFixture(
        () => fixture.json(route, owner.cookie, viewSchema),
        (view) =>
          view.snapshot.approvals.some(
            (value) =>
              value.runId === denialSubmit.receipt.runId &&
              value.state === "pending"
          ),
        60_000
      );
      const deniedPermit = denialWait.snapshot.approvals.find(
        (value) => value.runId === denialSubmit.receipt.runId
      );
      assert.ok(deniedPermit);
      await fixture.json(
        `${route}/approvals/${encodeURIComponent(deniedPermit.approvalId)}`,
        owner.cookie,
        z.object({ run: z.unknown() }),
        {
          decision: "deny",
          operationId: randomUUID(),
          runId: deniedPermit.runId,
        }
      );
      const denied = await waitForFixture(
        () => fixture.json(route, owner.cookie, viewSchema),
        (view) => view.snapshot.runs.every((run) => run.state === "completed"),
        60_000
      );
      assert.equal(
        denied.snapshot.approvals.find(
          (value) => value.approvalId === deniedPermit.approvalId
        )?.state,
        "denied"
      );
      assert.equal(
        denied.snapshot.tools.find(
          (tool) => tool.operationId === deniedPermit.operationId
        )?.state,
        "failed"
      );
      assert.equal(denied.snapshot.outputs.length, 3);
      const final = await provider();
      assert.deepEqual(final.tools, afterAllow.tools);
      saved.deniedDecision = { denied, final };
    } finally {
      await writeFile(
        path.join(directory, "channel-product.json"),
        `${JSON.stringify({ boot, saved, sourceCheckoutDirty: metadata.sourceCheckoutDirty, sourceIdentity: metadata.sourceIdentity }, null, 2)}\n`
      );
    }
  }
);
