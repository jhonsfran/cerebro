/* oxlint-disable no-await-in-loop -- Application requests and authorization changes must run in order. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";
import { z } from "zod";

import type { ChatApproval } from "../../packages/contracts/src/session-service.ts";
import {
  ChatDecisionReceipt,
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

const conversationSchema = z.object({
  conversationId: z.string(),
  sessionId: z.string(),
});
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
const approvalSchema = z.object({
  approval: z
    .unknown()
    .transform((value) => Schema.decodeUnknownSync(ChatDecisionReceipt)(value)),
});
const providerSchema = z.object({
  model: z.array(
    z.object({ completedAt: z.number().optional(), operationId: z.string() })
  ),
  tools: z.array(z.object({ operationId: z.string(), write: z.boolean() })),
});
const applicationStateSchema = z.object({
  agent: z.object({
    agentId: z.string(),
    organizationId: z.string(),
    principalId: z.string(),
    version: z.number(),
  }),
  boot: z.object({ fixtureId: z.string(), sha: z.string() }),
  owner: z.object({
    cookie: z.string(),
    email: z.string(),
    password: z.string(),
    userId: z.string(),
  }),
});
const application = async () => {
  const statePath = process.env.CEREBRO_APPLICATION_STATE;
  if (statePath) {
    const state = applicationStateSchema.parse(
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
    const fixture = applicationFixture(boot);
    const signedIn = await fixture.request("/api/auth/sign-in/email", "", {
      email: state.owner.email,
      password: state.owner.password,
    });
    assert.equal(signedIn.status, 200);
    await signedIn.body?.cancel();
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie.includes("session_token"));
    return { agent: state.agent, fixture, owner: { ...state.owner, cookie } };
  }
  const fixture = applicationFixture(await bootApplication("native-api"));
  const owner = await fixture.signup("Native API owner");
  const agent = await initializeFixtureAgent(fixture, owner);
  return { agent, fixture, owner };
};
const route = (conversation: z.infer<typeof conversationSchema>) =>
  `/api/product/conversations/${encodeURIComponent(conversation.conversationId)}`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const expectStatus = async (response: Response, status: number) => {
  assert.equal(response.status, status);
  await response.body?.cancel();
};

test(
  "production API uses native chat operations and current company authority",
  { timeout: 20 * 60_000 },
  async (t) => {
    const { agent, fixture, owner } = await application();
    const { boot } = fixture;
    const sealedAccount = await fixture.sql(
      "SELECT sealed FROM connector_account WHERE id='connector:fixture-connector'"
    );
    assert.match(sealedAccount, /^v1\./u);
    assert.equal(sealedAccount.includes("fixture-connector-key"), false);
    assert.equal(
      await fixture.sql(
        "SELECT string_agg(id, ',' ORDER BY id COLLATE \"C\") FROM connector_tool WHERE source='runtime.json'"
      ),
      "fixture-read,fixture_effect"
    );
    // Discovered MCP tools: only the read-only one is a read without approval.
    assert.equal(
      await fixture.sql(
        "SELECT string_agg(id || ':' || (definition->>'effect') || ':' || (definition->>'requiresApproval'), ',' ORDER BY id COLLATE \"C\") FROM connector_tool WHERE source='mcp:fixture-mcp'"
      ),
      "fixture-mcp_archive:write:true,fixture-mcp_lookup:read:false"
    );
    const directory = path.resolve(
      "artifacts/slice-1",
      boot.sha,
      boot.fixtureId
    );
    const evidence: Record<string, unknown> = {};
    const support = await fixture.signup("Native API support");
    const outsider = await fixture.signup("Native API outsider");
    const supportPrincipal = `support:${randomUUID()}`;
    await fixture.sql(
      `INSERT INTO identity_principal(id,organization_id,better_auth_user_id,kind,state) VALUES (${literal(supportPrincipal)},${literal(agent.organizationId)},${literal(support.userId)},'human','active')`
    );
    const accessRoute = `/api/product/agents/${encodeURIComponent(agent.agentId)}/access/${encodeURIComponent(supportPrincipal)}`;
    const access = (actions: readonly string[]) =>
      fixture.json(
        accessRoute,
        owner.cookie,
        z.unknown(),
        { actions, operationId: randomUUID() },
        "PUT"
      );
    await access(["read", "execute", "approve"]);
    const createConversation = (cookie = owner.cookie) =>
      fixture.json("/api/product/conversations", cookie, conversationSchema, {
        agentId: agent.agentId,
        operationId: randomUUID(),
      });
    const read = (
      conversation: z.infer<typeof conversationSchema>,
      cookie = owner.cookie
    ) => fixture.json(route(conversation), cookie, viewSchema);
    const send = (
      conversation: z.infer<typeof conversationSchema>,
      text: string,
      operationId = randomUUID()
    ) =>
      fixture.json(
        `${route(conversation)}/messages`,
        owner.cookie,
        receiptSchema,
        { operationId, text }
      );
    const completed = (conversation: z.infer<typeof conversationSchema>) =>
      waitForFixture(
        () => read(conversation),
        (view) =>
          !view.snapshot.busy &&
          view.snapshot.messages.some(
            (message) =>
              message.role === "assistant" &&
              message.state === "complete" &&
              message.text === "Cerebro slice 1 completed."
          ),
        60_000
      );
    const pending = async (
      conversation: z.infer<typeof conversationSchema>
    ) => {
      const view = await waitForFixture(
        () => read(conversation),
        (value) =>
          value.snapshot.approvals.some(
            (approval) => approval.state === "pending"
          ),
        60_000
      );
      const approval = view.snapshot.approvals.find(
        (value) => value.state === "pending"
      );
      assert.ok(approval);
      return approval;
    };
    const decision = (
      conversation: z.infer<typeof conversationSchema>,
      approval: ChatApproval,
      value: "allow" | "deny",
      cookie = owner.cookie
    ) =>
      fixture.json(
        `${route(conversation)}/approvals/${encodeURIComponent(approval.approvalId)}`,
        cookie,
        approvalSchema,
        { decision: value }
      );
    const provider = async () =>
      providerSchema.parse(await fixture.observations());
    const writes = async () => {
      const observed = await provider();
      return observed.tools.filter((tool) => tool.write).length;
    };
    const grant = (
      principal: string,
      action: string,
      kind: string,
      resource: string
    ) =>
      fixture.sql(
        `INSERT INTO identity_grant(organization_id,principal_id,action,resource_kind,resource_id,source) VALUES (${[agent.organizationId, principal, action, kind, resource, "native-api-test"].map(literal).join(",")}) ON CONFLICT DO NOTHING`
      );
    const conversation = await createConversation();
    const approvedConversation = await createConversation();
    const initialProvider = await provider();
    await mkdir(directory, { recursive: true });
    const statePath = `/tmp/${boot.fixtureId}-application.json`;
    await writeFile(
      statePath,
      `${JSON.stringify({ agent, boot, owner }, null, 2)}\n`,
      { mode: 0o600 }
    );
    process.stdout.write(`Native API application state: ${statePath}\n`);

    try {
      await t.test(
        "authentication, origin, and conversation ownership deny access before execution",
        async () => {
          await expectStatus(
            await fixture.request(route(conversation), ""),
            401
          );
          await expectStatus(
            await fixture.request(route(conversation), outsider.cookie),
            403
          );
          await expectStatus(
            await fixture.request(route(conversation), support.cookie),
            404
          );
          await expectStatus(
            await fixture.request(
              `${route(conversation)}/messages`,
              support.cookie,
              { operationId: randomUUID(), text: "Denied owner access" }
            ),
            404
          );
          await expectStatus(
            await fixture.request(
              `${route(conversation)}/stop`,
              support.cookie,
              {}
            ),
            404
          );
          const foreign = await fetch(
            `${boot.apiUrl}${route(conversation)}/messages`,
            {
              body: JSON.stringify({
                operationId: randomUUID(),
                text: "Denied origin",
              }),
              headers: {
                "Content-Type": "application/json",
                Cookie: owner.cookie,
                Origin: "https://foreign.example.test",
              },
              method: "POST",
            }
          );
          await expectStatus(foreign, 403);
          assert.deepEqual(await provider(), initialProvider);
          await expectStatus(
            await fixture.request("/api/product/setup", support.cookie, {
              operationId: randomUUID(),
            }),
            403
          );
        }
      );

      await t.test(
        "Send returns the native receipt and an operation retry adds one input",
        async () => {
          const operationId = randomUUID();
          const text = "Answer the refund policy question.";
          const first = await send(conversation, text, operationId);
          assert.equal(first.receipt.operationId, operationId);
          assert.equal(first.receipt.accepted, true);
          assert.ok(first.receipt.session);
          const duplicate = await send(conversation, text, operationId);
          assert.equal(duplicate.receipt.operationId, operationId);
          assert.equal(duplicate.receipt.session, first.receipt.session);
          assert.equal(duplicate.receipt.accepted, false);
          const view = await completed(conversation);
          assert.equal(
            view.snapshot.messages.filter(
              (message) => message.role === "user" && message.text === text
            ).length,
            1
          );
          assert.equal(
            view.snapshot.messages.filter(
              (message) =>
                message.role === "assistant" &&
                message.text === "Cerebro slice 1 completed."
            ).length,
            1
          );
          const history = await fixture.json(
            `${route(conversation)}/history`,
            owner.cookie,
            z.object({ messages: z.array(z.unknown()) })
          );
          assert.deepEqual(history.messages, view.snapshot.messages);
          const observed = await provider();
          assert.equal(observed.model.length - initialProvider.model.length, 1);
          evidence.send = { duplicate, first, view };
        }
      );

      await t.test(
        "current source and agent access apply to native transcript reads",
        async () => {
          const beforeRevocation = await read(conversation);
          const sourceRoute = `${route(conversation)}/sources/pilot-source`;
          const source = await fixture.json(
            sourceRoute,
            owner.cookie,
            z.object({ text: z.string() })
          );
          assert.match(source.text, /Fixture refund policy/u);
          await fixture.sql(
            `DELETE FROM identity_grant WHERE organization_id=${literal(agent.organizationId)} AND principal_id=${literal(agent.principalId)} AND action='read' AND resource_kind='memory' AND resource_id='pilot-source'`
          );
          try {
            await expectStatus(
              await fixture.request(route(conversation), owner.cookie),
              403
            );
            await expectStatus(
              await fixture.request(sourceRoute, owner.cookie),
              403
            );
          } finally {
            await grant(agent.principalId, "read", "memory", "pilot-source");
          }
          const restored = await read(conversation);
          assert.deepEqual(
            restored.snapshot.messages,
            beforeRevocation.snapshot.messages
          );
          await grant(supportPrincipal, "read", "memory", "pilot-source");
          await grant(supportPrincipal, "read", "tool", "fixture-read");
          await grant(supportPrincipal, "read", "tool", "fixture_effect");
          const supportConversation = await createConversation(support.cookie);
          await read(supportConversation, support.cookie);
          await access(["execute", "approve"]);
          await expectStatus(
            await fixture.request(route(supportConversation), support.cookie),
            403
          );
          await access(["read", "execute", "approve"]);
          await read(supportConversation, support.cookie);
          await fixture.sql(
            `UPDATE identity_principal SET state='disabled' WHERE id=${literal(supportPrincipal)}`
          );
          try {
            await expectStatus(
              await fixture.request("/api/product/agents", support.cookie),
              403
            );
          } finally {
            await fixture.sql(
              `UPDATE identity_principal SET state='active' WHERE id=${literal(supportPrincipal)}`
            );
          }
        }
      );

      await t.test(
        "stored approval identity allows one write and rejects another owner",
        async () => {
          const address = approvedConversation;
          const beforeWrites = await writes();
          await send(address, "Apply write fixture with fixture_effect once.");
          const approval = await pending(address);
          assert.equal(approval.toolId, "fixture_effect");
          assert.deepEqual(approval.arguments, { value: "approved-fixture" });
          await expectStatus(
            await fixture.request(
              `${route(address)}/approvals/${encodeURIComponent(approval.approvalId)}`,
              support.cookie,
              { decision: "allow" }
            ),
            404
          );
          const allowed = await decision(address, approval, "allow");
          assert.equal(allowed.approval.approvalId, approval.approvalId);
          assert.equal(allowed.approval.state, "allowed");
          await decision(address, approval, "allow");
          await completed(address);
          assert.equal(await writes(), beforeWrites + 1);
          await expectStatus(
            await fixture.request(
              `${route(address)}/approvals/${encodeURIComponent(approval.approvalId)}`,
              owner.cookie,
              { decision: "deny" }
            ),
            409
          );
          const view = await read(address);
          evidence.allowed = {
            approval,
            snapshot: view.snapshot,
          };
        }
      );

      await t.test(
        "denial and revoked current tool authority prevent writes",
        async () => {
          const beforeWrites = await writes();
          const deniedConversation = await createConversation();
          await send(
            deniedConversation,
            "Apply write fixture with fixture_effect but ask approval first."
          );
          const approval = await pending(deniedConversation);
          const denied = await decision(deniedConversation, approval, "deny");
          assert.equal(denied.approval.state, "denied");
          await waitForFixture(
            () => read(deniedConversation),
            (view) => !view.snapshot.busy,
            60_000
          );
          assert.equal(await writes(), beforeWrites);
          const revokedConversation = await createConversation();
          await send(
            revokedConversation,
            "Apply write fixture with fixture_effect after approval."
          );
          const revokedApproval = await pending(revokedConversation);
          await fixture.sql(
            `DELETE FROM identity_grant WHERE organization_id=${literal(agent.organizationId)} AND principal_id=${literal(agent.principalId)} AND action='execute' AND resource_kind='tool' AND resource_id='fixture_effect'`
          );
          try {
            const response = await fixture.request(
              `${route(revokedConversation)}/approvals/${encodeURIComponent(revokedApproval.approvalId)}`,
              owner.cookie,
              { decision: "allow" }
            );
            assert.ok(
              [200, 403, 409].includes(response.status),
              `Revoked tool approval returned HTTP ${response.status}`
            );
            await response.body?.cancel();
            await waitForFixture(
              () => read(revokedConversation),
              (view) => !view.snapshot.busy,
              60_000
            );
            assert.equal(await writes(), beforeWrites);
          } finally {
            await grant(agent.principalId, "execute", "tool", "fixture_effect");
          }
          const deniedView = await read(deniedConversation);
          evidence.denied = {
            approval,
            snapshot: deniedView.snapshot,
          };
        }
      );

      await t.test(
        "source revocation keeps Stop and Deny available without sharing protected content",
        async () => {
          const stopConversation = await createConversation();
          const beforeStop = await provider();
          await fixture.controls({ delayMs: 2000 });
          await send(
            stopConversation,
            "Answer the refund policy question slowly."
          );
          await waitForFixture(
            provider,
            (value) =>
              value.model.length > beforeStop.model.length &&
              value.model.at(-1)?.completedAt === undefined
          );
          await fixture.sql(
            `DELETE FROM identity_grant WHERE organization_id=${literal(agent.organizationId)} AND principal_id=${literal(agent.principalId)} AND action='read' AND resource_kind='memory' AND resource_id='pilot-source'`
          );
          try {
            await expectStatus(
              await fixture.request(route(stopConversation), owner.cookie),
              403
            );
            await expectStatus(
              await fixture.request(`${route(stopConversation)}/stop`, "", {}),
              401
            );
            await expectStatus(
              await fixture.request(
                `${route(stopConversation)}/stop`,
                support.cookie,
                {}
              ),
              404
            );
            const stopped = await fixture.json(
              `${route(stopConversation)}/stop`,
              owner.cookie,
              z.strictObject({ stopped: z.boolean() }),
              {}
            );
            assert.deepEqual(stopped, { stopped: true });
            await expectStatus(
              await fixture.request(route(stopConversation), owner.cookie),
              403
            );
            evidence.sourceRevokedStop = stopped;
          } finally {
            await grant(agent.principalId, "read", "memory", "pilot-source");
            await fixture.controls({ delayMs: 100 });
          }
          await waitForFixture(
            () => read(stopConversation),
            (value) => !value.snapshot.busy
          );

          const deniedConversation = await createConversation();
          const beforeWrites = await writes();
          await send(
            deniedConversation,
            "Apply write fixture with fixture_effect for the refund policy."
          );
          const approval = await pending(deniedConversation);
          const approvalRoute = `${route(deniedConversation)}/approvals/${encodeURIComponent(approval.approvalId)}`;
          let finalDecisionState: "denied" | "cancelled";
          let decisionObservedAt: number;
          await fixture.sql(
            `DELETE FROM identity_grant WHERE organization_id=${literal(agent.organizationId)} AND principal_id=${literal(agent.principalId)} AND action='read' AND resource_kind='memory' AND resource_id='pilot-source'`
          );
          try {
            await expectStatus(
              await fixture.request(route(deniedConversation), owner.cookie),
              403
            );
            await expectStatus(
              await fixture.request(approvalRoute, owner.cookie, {
                decision: "allow",
              }),
              403
            );
            await expectStatus(
              await fixture.request(approvalRoute, "", { decision: "deny" }),
              401
            );
            await expectStatus(
              await fixture.request(approvalRoute, support.cookie, {
                decision: "deny",
              }),
              404
            );
            const response = await fixture.request(
              approvalRoute,
              owner.cookie,
              { decision: "deny" }
            );
            const denied = await response.json();
            decisionObservedAt = Date.now();
            assert.ok(approval.expiresAt > decisionObservedAt);
            if (response.status === 200) {
              assert.deepEqual(denied, {
                approval: { approvalId: approval.approvalId, state: "denied" },
              });
              assert.deepEqual(approvalSchema.parse(denied).approval, {
                approvalId: approval.approvalId,
                state: "denied",
              });
              finalDecisionState = "denied";
            } else {
              assert.equal(response.status, 409);
              assert.deepEqual(denied, {
                code: "Conflict",
                defined: false,
                message: "The approval already has a final decision.",
                status: 409,
              });
              finalDecisionState = "cancelled";
            }
            assert.equal(await writes(), beforeWrites);
            evidence.sourceRevokedDeny = denied;
          } finally {
            await grant(agent.principalId, "read", "memory", "pilot-source");
          }
          const settled = await waitForFixture(
            () => read(deniedConversation),
            (value) => !value.snapshot.busy
          );
          assert.equal(
            settled.snapshot.approvals.find(
              (value) => value.approvalId === approval.approvalId
            )?.state,
            finalDecisionState
          );
          const nativeToolErrors = settled.snapshot.messages
            .filter(
              (message) =>
                message.role === "tool" && message.text.includes("[error]")
            )
            .map(({ text, toolName }) => ({ reason: text, toolName }));
          if (finalDecisionState === "cancelled") {
            assert.ok(nativeToolErrors.length > 0);
          }
          evidence.sourceControlNative = {
            approvalId: approval.approvalId,
            busy: settled.snapshot.busy,
            decisionObservedAt,
            expiresAt: approval.expiresAt,
            finalDecisionState,
            nativeToolErrors,
          };
          assert.equal(await writes(), beforeWrites);
        }
      );

      await t.test(
        "current agent grants still authorize Stop and Deny",
        async () => {
          const idleConversation = await createConversation();
          const beforeWrites = await writes();
          await fixture.sql(
            `DELETE FROM identity_grant WHERE organization_id=${literal(agent.organizationId)} AND principal_id=${literal(agent.principalId)} AND action='execute' AND resource_kind='agent' AND resource_id=${literal(agent.agentId)}`
          );
          try {
            await expectStatus(
              await fixture.request(
                `${route(idleConversation)}/stop`,
                owner.cookie,
                {}
              ),
              403
            );
          } finally {
            await grant(agent.principalId, "execute", "agent", agent.agentId);
          }
          const stopped = await fixture.json(
            `${route(idleConversation)}/stop`,
            owner.cookie,
            z.strictObject({ stopped: z.boolean() }),
            {}
          );
          assert.deepEqual(stopped, { stopped: true });
          const view = await read(approvedConversation);
          const approval = view.snapshot.approvals.find(
            (value) => value.state === "allowed"
          );
          assert.ok(approval);
          assert.equal(view.snapshot.busy, false);
          const approvalRoute = `${route(approvedConversation)}/approvals/${encodeURIComponent(approval.approvalId)}`;
          await fixture.sql(
            `DELETE FROM identity_grant WHERE organization_id=${literal(agent.organizationId)} AND principal_id=${literal(agent.principalId)} AND action='approve' AND resource_kind='agent' AND resource_id=${literal(agent.agentId)}`
          );
          try {
            await expectStatus(
              await fixture.request(approvalRoute, owner.cookie, {
                decision: "deny",
              }),
              403
            );
          } finally {
            await grant(agent.principalId, "approve", "agent", agent.agentId);
          }
          await expectStatus(
            await fixture.request(approvalRoute, owner.cookie, {
              decision: "deny",
            }),
            409
          );
          const restored = await read(approvedConversation);
          assert.equal(
            restored.snapshot.approvals.find(
              (value) => value.approvalId === approval.approvalId
            )?.state,
            "allowed"
          );
          assert.equal(await writes(), beforeWrites);
        }
      );

      await t.test(
        "audit exports keep current company authorization and exclude transcript text",
        async () => {
          await grant(
            agent.principalId,
            "export",
            "audit",
            agent.organizationId
          );
          const exported = await fixture.json(
            "/rpc/identity/exportData",
            owner.cookie,
            z.object({
              json: z.object({
                records: z.array(
                  z.object({ organizationId: z.string() }).passthrough()
                ),
              }),
            }),
            {
              json: {
                kind: "audit",
                limit: 200,
                organizationId: agent.organizationId,
              },
            }
          );
          assert.ok(
            exported.json.records.every(
              (record) => record.organizationId === agent.organizationId
            )
          );
          assert.equal(
            JSON.stringify(exported).includes("Cerebro slice 1 completed."),
            false
          );
          await expectStatus(
            await fixture.request("/rpc/identity/exportData", support.cookie, {
              json: {
                kind: "audit",
                limit: 20,
                organizationId: agent.organizationId,
              },
            }),
            403
          );
          evidence.audit = exported;
        }
      );
      await t.test(
        "administrators add, refresh, and remove an MCP connector",
        async () => {
          const change = z.object({
            id: z.string(),
            skipped: z.array(z.string()),
            toolCount: z.number(),
          });
          const input = {
            headers: { Authorization: "Bearer fixture-connector-key" },
            id: "crm",
            url: "http://fixture:8090/mcp",
          };
          await expectStatus(
            await fixture.request(
              "/api/product/connectors",
              support.cookie,
              input,
              "POST"
            ),
            403
          );
          assert.deepEqual(
            await fixture.json(
              "/api/product/connectors",
              owner.cookie,
              change,
              input,
              "POST"
            ),
            { id: "crm", skipped: [], toolCount: 2 }
          );
          await expectStatus(
            await fixture.request(
              "/api/product/connectors",
              owner.cookie,
              input,
              "POST"
            ),
            409
          );
          const listed = await fixture.json(
            "/api/product/connectors",
            owner.cookie,
            z.object({
              connectors: z.array(
                z.object({
                  id: z.string(),
                  source: z.string(),
                  toolCount: z.number(),
                  url: z.string().nullable(),
                })
              ),
            })
          );
          assert.deepEqual(
            listed.connectors.find((connector) => connector.id === "crm"),
            {
              id: "crm",
              source: "admin",
              toolCount: 2,
              url: "http://fixture:8090/mcp",
            }
          );
          const sealed = await fixture.sql(
            "SELECT sealed FROM connector_account WHERE id='connector:crm'"
          );
          assert.match(sealed, /^v1\./u);
          assert.equal(sealed.includes("fixture-connector-key"), false);
          const catalog = await fixture.json(
            "/api/product/catalog",
            owner.cookie,
            z.object({
              connectorChoices: z.array(z.object({ id: z.string() })),
            })
          );
          assert.ok(
            ["crm_archive", "crm_lookup"].every((toolId) =>
              catalog.connectorChoices.some((choice) => choice.id === toolId)
            )
          );
          // Read and execute on both tools, and execute on the connector.
          assert.equal(
            await fixture.sql(
              "SELECT count(*) FROM identity_grant WHERE source='connector:crm'"
            ),
            "5"
          );
          const refreshed = await fixture.json(
            "/api/product/connectors/crm/refresh",
            owner.cookie,
            change,
            {},
            "POST"
          );
          assert.equal(refreshed.toolCount, 2);
          await fixture.json(
            "/api/product/connectors/crm",
            owner.cookie,
            z.object({ id: z.literal("crm"), removed: z.literal(true) }),
            {},
            "DELETE"
          );
          assert.equal(
            await fixture.sql(
              "SELECT (SELECT count(*) FROM connector_tool WHERE source='admin:crm') + (SELECT count(*) FROM identity_grant WHERE source='connector:crm') + (SELECT count(*) FROM connector_account WHERE id='connector:crm')"
            ),
            "0"
          );
        }
      );
      await t.test(
        "administrators save skills that new conversations offer",
        async () => {
          const skill = {
            body: "Check the order date, then offer store credit.",
            description: "Use when a customer asks for a refund.",
          };
          await expectStatus(
            await fixture.request(
              "/api/product/skills/refund-policy",
              support.cookie,
              skill,
              "PUT"
            ),
            403
          );
          await expectStatus(
            await fixture.request(
              "/api/product/skills/Refund%20Policy",
              owner.cookie,
              skill,
              "PUT"
            ),
            422
          );
          assert.deepEqual(
            await fixture.json(
              "/api/product/skills/refund-policy",
              owner.cookie,
              z.object({ name: z.string(), saved: z.literal(true) }),
              skill,
              "PUT"
            ),
            { name: "refund-policy", saved: true }
          );
          const skillList = z.object({
            skills: z.array(
              z.object({
                body: z.string(),
                description: z.string(),
                name: z.string(),
              })
            ),
          });
          assert.deepEqual(
            await fixture.json("/api/product/skills", owner.cookie, skillList),
            { skills: [{ ...skill, name: "refund-policy" }] }
          );
          // A conversation started now offers the skill tools to the model.
          const before = await provider();
          const skillConversation = await createConversation();
          await send(skillConversation, "Explain the current policy.");
          await completed(skillConversation);
          const calls = z
            .object({
              model: z.array(
                z.object({ toolNames: z.array(z.string()).optional() })
              ),
            })
            .parse(await fixture.observations())
            .model.slice(before.model.length);
          assert.ok(
            calls.some((call) => call.toolNames?.includes("activate_skill"))
          );
          await fixture.json(
            "/api/product/skills/refund-policy",
            owner.cookie,
            z.object({ name: z.string(), removed: z.literal(true) }),
            {},
            "DELETE"
          );
          assert.deepEqual(
            await fixture.json("/api/product/skills", owner.cookie, skillList),
            { skills: [] }
          );
        }
      );
    } finally {
      await fixture.controls({
        arm: null,
        delayMs: 100,
        failFirst: false,
        release: true,
      });
      await writeFile(
        path.join(directory, "native-api.json"),
        `${JSON.stringify({ boot, evidence, provider: await provider(), statePath }, null, 2)}\n`
      );
      process.stdout.write(
        `Owned native API stack retained: ${boot.fixtureId}\n`
      );
    }
  }
);
