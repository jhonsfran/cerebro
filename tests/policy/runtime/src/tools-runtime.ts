import { id } from "@cerebro/contracts/identity";
import { digestToolArguments } from "@cerebro/contracts/tools";
import type { ToolCapability, ToolExecution } from "@cerebro/contracts/tools";
import { createToolBroker } from "@cerebro/tools/broker";
import {
  createCapabilitySigner,
  gatewayInvocation,
} from "@cerebro/tools/capability";
import { createDynamicToolExecutor } from "@cerebro/tools/dynamic-worker";
import { createOpenCodeToolPlugin } from "@cerebro/tools/opencode-plugin";
import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";
import { Agent } from "agents";
import { z } from "zod";

import { DurableOperationJournal } from "../../fixtures/journal-core.ts";
import { DoDatabase } from "./do-database.ts";
import {
  agentId,
  audience,
  authorizationPolicy,
  boundApproval,
  entitlementPolicy,
  gatewayObject,
  invocation,
  invocationInput,
  organizationId,
  policyVersion,
  principalId,
  registry,
  signerSecret,
} from "./shared.ts";
import type { Environment } from "./shared.ts";

export class ToolsRuntime extends Agent<Environment> {
  private readonly instanceId = crypto.randomUUID();
  private journal(): DurableOperationJournal<ToolExecution> {
    return new DurableOperationJournal(
      new DoDatabase(this.ctx.storage),
      "broker"
    );
  }
  private async broker() {
    const executor = createDynamicToolExecutor({
      audience,
      authorizationPolicy,
      gateway: this.env.GATEWAY,
      loader: this.env.LOADER,
      reconcile: async (operationId) => {
        const response = await gatewayObject(this.env).fetch(
          new Request("https://gateway.invalid/reconcile", {
            body: JSON.stringify({ operationId }),
            method: "POST",
          })
        );
        return await response.json();
      },
      registry,
      signer: await createCapabilitySigner(signerSecret),
    });
    return createToolBroker({
      authorizationPolicy,
      entitlementPolicy,
      executor,
      journal: this.journal(),
      registry,
    });
  }
  private async approve(
    input: z.infer<typeof invocationInput>
  ): Promise<Response> {
    const { call, options } = await invocation(input);
    const approval = boundApproval(call, options);
    this.journal().putApproval(approval);
    await this.ctx.storage.sync();
    const saved = await gatewayObject(this.env).fetch(
      new Request("https://gateway.invalid/approve", {
        body: JSON.stringify(approval),
        method: "POST",
      })
    );
    return Response.json({
      broker: true,
      gateway: saved.ok,
      instanceId: this.instanceId,
    });
  }
  private async sdk(input: {
    operationId: string;
    tool: string;
  }): Promise<Response> {
    const attempts: unknown[] = [];
    const broker = await this.broker();
    const client = await OpenCodeWorkerd.create({
      config: {
        model: "fixture/controlled",
        permissions: [
          { action: "*", effect: "deny", resource: "*" },
          { action: "controlled_read", effect: "allow", resource: "*" },
          { action: "controlled_write", effect: "allow", resource: "*" },
        ],
        providers: {
          fixture: {
            models: {
              controlled: {
                capabilities: {
                  input: ["text"],
                  output: ["text"],
                  tools: true,
                },
                limit: { context: 32_768, output: 1024 },
                name: "Session 4 deterministic provider",
              },
            },
            package: "@opencode-ai/ai/providers/openai-compatible",
            settings: {
              apiKey: "local-fixture",
              baseURL: `${this.env.FIXTURE_URL}/v1`,
            },
          },
        },
      },
      models: { fetch: false },
      plugins: [
        createOpenCodeToolPlugin({
          broker,
          registry,
          resolveAttempt: async (attempt) => {
            attempts.push(attempt);
            const tool = z
              .enum(["controlled_read", "controlled_write"])
              .parse(attempt.toolId);
            const { value } = z
              .strictObject({ value: z.string() })
              .parse(attempt.input);
            return await invocation({
              operationId: input.operationId,
              tool,
              value,
            });
          },
        }),
      ],
      storage: this.ctx.storage,
    });
    try {
      const session = await client.session.create();
      await client.session.prompt({
        sessionID: session.id,
        text: `operationId=${input.operationId} forcedTool=${input.tool} Call the named tool once with value runtime-value.`,
      });
      await client.session.wait(
        { sessionID: session.id },
        { signal: AbortSignal.timeout(60_000) }
      );
      const messages = await client.message.list({
        order: "asc",
        sessionID: session.id,
      });
      const tools = messages.data.flatMap((message) =>
        message.type === "assistant"
          ? message.content
              .filter((part) => part.type === "tool")
              .map((part) => ({
                id: part.id,
                name: part.name,
                state: part.state,
              }))
          : []
      );
      await this.ctx.storage.sync();
      return Response.json({
        attempts,
        instanceId: this.instanceId,
        record: await this.journal().read(
          organizationId,
          id.operation(input.operationId),
          { deadlineAt: Date.now() + 30_000 }
        ),
        tools,
      });
    } finally {
      await client.close();
    }
  }
  private async isolation(
    input: z.infer<typeof invocationInput>
  ): Promise<Response> {
    const direct = await fetch(`${this.env.FIXTURE_URL}/health`);
    const { call, options } = await invocation(input);
    const capability: ToolCapability = {
      actorPrincipalId: principalId,
      agentId,
      argumentDigest: options.requestDigest,
      connectorId: call.tool.connectorId,
      effect: call.tool.effect,
      expiresAt: Date.now() + 60_000,
      operationId: options.operationId,
      organizationId,
      principalId,
      toolId: call.tool.id,
      toolVersion: call.tool.version,
    };
    const resultSnapshot1 = await createCapabilitySigner(signerSecret);
    const signed = await resultSnapshot1.sign(
      gatewayInvocation(
        audience,
        call,
        capability,
        options,
        policyVersion,
        await digestToolArguments(registry.get(call.tool.id)?.fingerprint)
      )
    );
    const worker = this.env.LOADER.get("s4-egress-probe-v1", () => ({
      compatibilityDate: "2026-09-28",
      env: { GATEWAY: this.env.GATEWAY },
      globalOutbound: null,
      mainModule: "probe.js",
      modules: {
        "probe.js": `export default { async fetch(request, env) { let directError = null; let directStatus = null; try { directStatus = (await fetch("http://fixture:8090/health")).status; } catch(error) { directError = error.message; } const gateway = await env.GATEWAY.fetch(new Request("https://gateway.invalid/invoke", { method: "POST", body: await request.text() })); return Response.json({ directError, directStatus, gateway: await gateway.json() }); } };`,
      },
    }));
    const result = await worker.getEntrypoint().fetch(
      new Request("https://probe.invalid/", {
        body: JSON.stringify(signed),
        method: "POST",
      })
    );
    return Response.json({
      parent: await direct.json(),
      parentStatus: direct.status,
      wrapper: await result.json(),
    });
  }
  private async tamper(
    input: z.infer<typeof invocationInput>
  ): Promise<Response> {
    const { call, options } = await invocation(input);
    const capability: ToolCapability = {
      actorPrincipalId: principalId,
      agentId,
      argumentDigest: options.requestDigest,
      connectorId: call.tool.connectorId,
      effect: call.tool.effect,
      expiresAt: Date.now() + 60_000,
      operationId: options.operationId,
      organizationId,
      principalId,
      toolId: call.tool.id,
      toolVersion: call.tool.version,
    };
    const signer = await createCapabilitySigner(signerSecret);
    const payload = gatewayInvocation(
      audience,
      call,
      capability,
      options,
      policyVersion,
      await digestToolArguments(registry.get(call.tool.id)?.fingerprint)
    );
    const signed = await signer.sign(payload);
    const tampered = {
      ...signed,
      payload: signed.payload.replace("runtime-value", "tampered-value"),
    };
    const widened = await signer.sign({
      ...payload,
      call: {
        ...call,
        tool: { ...call.tool, connectorId: "unregistered-connector" },
      },
      capability: { ...capability, connectorId: "unregistered-connector" },
    });
    const send = async (envelope: unknown) => {
      const response = await this.env.GATEWAY.fetch(
        new Request("https://gateway.invalid/invoke", {
          body: JSON.stringify(envelope),
          method: "POST",
        })
      );
      return await response.json();
    };
    return Response.json({
      tampered: await send(tampered),
      widened: await send(widened),
    });
  }
  async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/state") {
      return Response.json({ instanceId: this.instanceId });
    }
    if (path === "/sdk") {
      return await this.sdk(
        z
          .strictObject({
            operationId: z.string(),
            tool: z.enum([
              "controlled_read",
              "controlled_write",
              "shell",
              "webfetch",
              "execute",
              "mcp_unregistered",
            ]),
          })
          .parse(await request.json())
      );
    }
    const input = invocationInput.parse(await request.json());
    if (path === "/approve") {
      return await this.approve(input);
    }
    if (path === "/isolation") {
      return await this.isolation(input);
    }
    if (path === "/tamper") {
      return await this.tamper(input);
    }
    if (path === "/invoke") {
      const { call, options } = await invocation(input);
      const resultSnapshot2 = await this.broker();
      const result = await resultSnapshot2.invoke(call, options);
      await this.ctx.storage.sync();
      return Response.json({ instanceId: this.instanceId, result });
    }
    return Response.json({ error: "Unknown runtime route" }, { status: 404 });
  }
}
