import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { Schema } from "effect";
import { z } from "zod";

import {
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
const providerSchema = z.object({
  model: z.array(
    z.object({
      completedAt: z.number().optional(),
      operationId: z.string(),
      toolNames: z.array(z.string()),
    })
  ),
  tools: z.array(z.object({ operationId: z.string(), write: z.boolean() })),
});
const agentSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  definition: z.object({
    agentId: z.string(),
    organizationId: z.string(),
    version: z.number().int().positive(),
    instructions: z.string(),
    model: z.string(),
    enabledToolIds: z.array(z.string()),
    grants: z.array(
      z.object({
        action: z.enum([
          "read",
          "execute",
          "write",
          "approve",
          "manage",
          "export",
        ]),
        resource: z.object({
          id: z.string(),
          kind: z.enum(["agent", "tool", "memory", "artifact", "audit"]),
          organizationId: z.string(),
        }),
      })
    ),
  }),
});
const publishedSchema = z.object({ agentId: z.string(), version: z.number() });
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
    const agentRoute = `/api/product/agents/${encodeURIComponent(agent.agentId)}`;
    const accessRoute = `${agentRoute}/access/${encodeURIComponent(supportPrincipal)}`;
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
    const send = async (
      conversation: z.infer<typeof conversationSchema>,
      text: string,
      operationId = randomUUID()
    ) => {
      const before = await read(conversation);
      const sent = await fixture.json(
        `${route(conversation)}/messages`,
        owner.cookie,
        receiptSchema,
        { operationId, text }
      );
      assert.equal(sent.receipt.operationId, operationId);
      return { conversation, baseline: before.snapshot, text, ...sent };
    };
    const completed = async (turn: Awaited<ReturnType<typeof send>>) => {
      const entryIds = new Set(
        turn.baseline.messages.flatMap((message) =>
          message.entryId ? [message.entryId] : []
        )
      );
      const view = await waitForFixture(
        () => read(turn.conversation),
        (value) => {
          const { messages } = value.snapshot;
          const input = messages.findIndex(
            (message) =>
              message.role === "user" &&
              message.operationId === turn.receipt.operationId &&
              message.text === turn.text &&
              Boolean(message.entryId && !entryIds.has(message.entryId))
          );
          const answer = messages.findIndex(
            (message, index) =>
              index > input &&
              message.role === "assistant" &&
              message.state === "complete" &&
              message.outcome === "answered" &&
              message.text === "Cerebro slice 1 completed." &&
              Boolean(message.entryId && !entryIds.has(message.entryId))
          );
          return (
            !value.snapshot.busy &&
            input !== -1 &&
            answer > input &&
            !messages
              .slice(input + 1, answer)
              .some((message) => message.role === "user")
          );
        },
        60_000
      );
      const inputs = view.snapshot.messages.filter(
        (message) =>
          message.role === "user" &&
          message.operationId === turn.receipt.operationId
      );
      assert.equal(inputs.length, 1);
      const [input] = inputs;
      assert.ok(input?.entryId);
      assert.equal(entryIds.has(input.entryId), false);
      const inputIndex = view.snapshot.messages.indexOf(input);
      const answer = view.snapshot.messages.find(
        (message, index) =>
          index > inputIndex &&
          message.role === "assistant" &&
          message.state === "complete" &&
          message.outcome === "answered" &&
          message.text === "Cerebro slice 1 completed." &&
          message.entryId !== undefined &&
          !entryIds.has(message.entryId)
      );
      assert.ok(answer?.entryId);
      assert.notEqual(answer.entryId, input.entryId);
      assert.deepEqual(
        view.snapshot.messages.slice(0, turn.baseline.messages.length),
        turn.baseline.messages
      );
      return {
        ...view,
        inputEntryId: input.entryId,
        answerMessageId: answer.entryId,
      };
    };
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
    assert.deepEqual(await createConversation(), conversation);
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
          const before = await provider();
          const first = await send(conversation, text, operationId);
          assert.equal(first.receipt.accepted, true);
          assert.ok(first.receipt.session);
          const duplicate = await send(conversation, text, operationId);
          assert.deepEqual(duplicate.receipt, {
            ...first.receipt,
            accepted: false,
          });
          const view = await completed(first);
          const history = await fixture.json(
            `${route(conversation)}/history`,
            owner.cookie,
            z.object({ messages: z.array(z.unknown()) })
          );
          assert.deepEqual(history.messages, view.snapshot.messages);
          const observed = await provider();
          assert.equal(observed.model.length - before.model.length, 1);
          const settledReplay = await send(conversation, text, operationId);
          assert.deepEqual(settledReplay.receipt, duplicate.receipt);
          const reloaded = await read(conversation);
          assert.deepEqual(reloaded.snapshot.messages, view.snapshot.messages);
          assert.deepEqual(await provider(), observed);
          evidence.send = {
            duplicate: duplicate.receipt,
            first: first.receipt,
            settledReplay: settledReplay.receipt,
            view,
            reloaded,
          };
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
          assert.notEqual(
            supportConversation.conversationId,
            conversation.conversationId
          );
          assert.notEqual(
            supportConversation.sessionId,
            conversation.sessionId
          );
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
        "the primary completes a connector request without foreground execution",
        async () => {
          const definition = await fixture.json(
            agentRoute,
            owner.cookie,
            agentSchema
          );
          assert.ok(
            ["fixture-read", "fixture_effect"].every((toolId) =>
              definition.definition.enabledToolIds.includes(toolId)
            )
          );
          const before = await provider();
          const turn = await send(
            conversation,
            "Apply write fixture with fixture_effect once."
          );
          const view = await completed(turn);
          const observed = await provider();
          const calls = observed.model.slice(before.model.length);
          assert.ok(calls.length > 0);
          for (const call of calls) {
            assert.ok(call.completedAt !== undefined);
            assert.equal(
              call.toolNames.some((name) =>
                ["fixture_effect", "fixture-read"].includes(name)
              ),
              false
            );
          }
          const approvals = new Set(
            turn.baseline.approvals.map((approval) => approval.approvalId)
          );
          assert.deepEqual(
            view.snapshot.approvals.filter(
              (approval) => !approvals.has(approval.approvalId)
            ),
            []
          );
          assert.equal(observed.tools.length, before.tools.length);
          assert.equal(
            observed.tools.filter((tool) => tool.write).length,
            before.tools.filter((tool) => tool.write).length
          );
          assert.deepEqual(
            await fixture.json(agentRoute, owner.cookie, agentSchema),
            definition
          );
          evidence.coordinatorPolicy = {
            receipt: turn.receipt,
            view,
            calls,
            writes: observed.tools.filter((tool) => tool.write).length,
          };
        }
      );

      await t.test(
        "source revocation keeps Stop available without sharing protected content",
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
        }
      );

      await t.test("current agent grants still authorize Stop", async () => {
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
        assert.equal(await writes(), beforeWrites);
      });

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
        "published skills activate in the same primary conversation",
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
          const current = await fixture.json(
            agentRoute,
            owner.cookie,
            agentSchema
          );
          assert.equal(current.definition.agentId, agent.agentId);
          assert.equal(current.definition.organizationId, agent.organizationId);
          const idle = await read(conversation);
          assert.equal(idle.snapshot.busy, false);
          const published = await fixture.json(
            agentRoute,
            owner.cookie,
            publishedSchema,
            {
              operationId: randomUUID(),
              expectedVersion: current.definition.version,
              name: current.name,
              model: current.definition.model,
              instructions: current.definition.instructions,
              enabledToolIds: current.definition.enabledToolIds,
              grants: current.definition.grants,
            },
            "PUT"
          );
          assert.equal(published.agentId, agent.agentId);
          assert.equal(published.version, current.definition.version + 1);
          const skillConversation = await createConversation();
          assert.deepEqual(skillConversation, conversation);
          const before = await provider();
          const turn = await send(
            skillConversation,
            "Activate skill refund-policy"
          );
          const activated = await completed(turn);
          assert.equal(activated.snapshot.agentVersion, published.version);
          const priorIds = new Set(
            turn.baseline.messages.map((message) => message.id)
          );
          const results = activated.snapshot.messages.filter(
            (message) =>
              !priorIds.has(message.id) &&
              message.toolName === "activate_skill" &&
              message.text.includes(skill.body)
          );
          assert.equal(results.length, 1);
          const [result] = results;
          assert.ok(result);
          const { messages } = activated.snapshot;
          const inputIndex = messages.findIndex(
            (message) => message.entryId === activated.inputEntryId
          );
          const answerIndex = messages.findIndex(
            (message) => message.entryId === activated.answerMessageId
          );
          assert.ok(messages.indexOf(result) > inputIndex);
          assert.ok(messages.indexOf(result) < answerIndex);
          const observed = await provider();
          const calls = observed.model.slice(before.model.length);
          assert.ok(
            calls.some((call) => call.toolNames.includes("activate_skill"))
          );
          const reloaded = await read(skillConversation);
          assert.deepEqual(
            reloaded.snapshot.messages,
            activated.snapshot.messages
          );
          evidence.skills = {
            published,
            conversation: skillConversation,
            receipt: turn.receipt,
            activated,
            resultMessageId: result.id,
            calls,
            reloaded,
          };
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
