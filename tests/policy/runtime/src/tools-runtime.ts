import { enforceDecision } from "@cerebro/contracts/authority-service";
import type { AuthorityService } from "@cerebro/contracts/authority-service";
import type { EventAddress } from "@cerebro/contracts/events";
import {
  Denied,
  InvalidInput,
  Unavailable,
  failureToHttp,
} from "@cerebro/contracts/failures";
import type { ContractFailure } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import type { AuthorizationPolicy } from "@cerebro/contracts/policy";
import { ToolReceiptStore } from "@cerebro/contracts/receipt-service";
import type {
  BoundApproval,
  BoundCapability,
} from "@cerebro/contracts/tool-service";
import { digestToolArguments } from "@cerebro/contracts/tools";
import { createControlledToolExecutor } from "@cerebro/tools/broker";
import {
  boundCapabilitySchema,
  createCapabilitySigner,
  gatewayInvocation,
} from "@cerebro/tools/capability";
import { createDynamicToolExecutorService } from "@cerebro/tools/dynamic-worker";
import { bindRegisteredTool } from "@cerebro/tools/registry";
import { Type } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider } from "@earendil-works/pi-ai/models";
import { Effect, Result } from "effect";
import { z } from "zod";

import { createCelldToolReceiptStore } from "../../../../packages/runtime/src/celld-tool-receipts.ts";
import { piContext } from "../../../../packages/runtime/src/pi-harness.ts";
import { SessionAgent } from "../../../../packages/runtime/src/session-agent.ts";
import type { SessionHostConfiguration } from "../../../../packages/runtime/src/session-agent.ts";
import {
  agentId,
  audience,
  context,
  createAuthorizationPolicy,
  fixtureToken,
  gatewayObject,
  gatewayProof,
  invocation,
  invocationInput,
  organizationId,
  policyVersion,
  principalId,
  registry,
  signerSecret,
} from "./shared.ts";
import type { Environment } from "./shared.ts";

const tuple = z.tuple([z.string(), z.string(), z.string(), z.string()]);
const currentAccess = z.object({ enabled: z.boolean() });
const storedApprovals = z.object({
  handoffs: z.array(
    z.object({
      approvals: z.array(
        boundCapabilitySchema.extend({
          approverId: z.string().transform(id.principal),
          id: z.string(),
        })
      ),
    })
  ),
});

const authenticate = (request: Request) =>
  request.headers.get("authorization") === `Bearer ${fixtureToken}` &&
  request.headers.get("x-fixture-principal") === principalId
    ? Effect.succeed(context)
    : Effect.fail(
        new Denied({
          code: "unauthorized",
          reason: "Trusted fixture caller required",
        })
      );

const envelope = async (input: z.infer<typeof invocationInput>) => {
  const { call, options } = await invocation(input);
  const capability: BoundCapability = {
    actorPrincipalId: principalId,
    agentId,
    argumentDigest: options.requestDigest,
    connectorFingerprint: call.tool.connectorFingerprint,
    connectorId: call.tool.connectorId,
    effect: call.tool.effect,
    expiresAt: Date.now() + 60_000,
    operationId: options.operationId,
    organizationId,
    policyVersion,
    principalId,
    runId: call.runId,
    toolId: call.tool.id,
    toolVersion: call.tool.version,
  };
  const entry = registry.get(call.tool.id);
  if (!entry) {
    throw new Error("Fixture registration missing");
  }
  const payload = gatewayInvocation(
    audience,
    call,
    capability,
    options,
    policyVersion,
    await digestToolArguments(entry.fingerprint)
  );
  const signer = await createCapabilitySigner(signerSecret);
  return { payload, signed: await signer.sign(payload), signer };
};

export class ToolsRuntime extends SessionAgent<Environment> {
  private readonly instanceId = crypto.randomUUID();
  private configuration: SessionHostConfiguration | undefined;

  private async gatewayControl(
    path: string,
    body: unknown = {}
  ): Promise<Response> {
    return await gatewayObject(this.env).fetch(
      new Request(`https://gateway.invalid${path}`, {
        body: JSON.stringify(body),
        headers: { "x-fixture-private-proof": gatewayProof },
        method: "POST",
      })
    );
  }

  private approvals(): readonly BoundApproval[] {
    const table = this.ctx.storage.sql
      .exec("SELECT name FROM sqlite_master WHERE name='cerebro_pi_session'")
      .toArray();
    if (!table.length) {
      return [];
    }
    const [row] = this.ctx.storage.sql
      .exec<{ state: string }>(
        "SELECT state FROM cerebro_pi_session WHERE id=1"
      )
      .toArray();
    return row
      ? storedApprovals
          .parse(JSON.parse(row.state))
          .handoffs.flatMap((handoff) => handoff.approvals)
      : [];
  }

  protected override configure(): Effect.Effect<
    SessionHostConfiguration,
    ContractFailure
  > {
    return Effect.gen({ self: this }, function* configurePolicyHost() {
      if (this.configuration) {
        return this.configuration;
      }
      const addressTuple = yield* Effect.try({
        catch: () =>
          new InvalidInput({ reason: "Invalid policy host address" }),
        try: () => tuple.parse(JSON.parse(this.ctx.id.name ?? "null")),
      });
      const address: EventAddress = {
        agentId: id.agent(addressTuple[1]),
        conversationId: id.conversation(addressTuple[2]),
        organizationId: id.organization(addressTuple[0]),
        sessionId: id.session(addressTuple[3]),
      };
      if (
        address.organizationId !== organizationId ||
        address.agentId !== agentId
      ) {
        return yield* Effect.fail(
          new Denied({ code: "unauthorized", reason: "Foreign policy host" })
        );
      }
      const agent = {
        agentId,
        enabledToolIds: ["controlled_read", "controlled_write"],
        grants: [],
        instructions: "Call the named registered tool once for each input.",
        model: "fixture/controlled",
        organizationId,
        version: 1,
      };
      const policy: AuthorizationPolicy = {
        evaluate: async (...args) => {
          const response = await this.gatewayControl("/authority");
          const access = currentAccess.parse(await response.json());
          return await createAuthorizationPolicy(() => access.enabled).evaluate(
            ...args
          );
        },
      };
      const authority: AuthorityService = {
        evaluate: (request, options) =>
          Effect.tryPromise({
            catch: () =>
              new Unavailable({ reason: "Policy authority unavailable" }),
            try: async () => {
              const result = await policy.evaluate(
                request.context,
                request.action,
                request.resource,
                options
              );
              if (result.status !== "ok") {
                throw new Error("Policy evaluation unavailable");
              }
              return result.value;
            },
          }),
        require: (request, options) =>
          Effect.flatMap(authority.evaluate(request, options), (decision) =>
            enforceDecision(request, Date.now(), decision)
          ),
      };
      const receipts = yield* ToolReceiptStore.pipe(
        Effect.provide(
          createCelldToolReceiptStore(this.ctx.storage, {
            address,
            authorize: (receipt, caller, options) =>
              Effect.asVoid(
                authority.require(
                  {
                    action: "read",
                    address,
                    context: caller,
                    pinnedAgent: agent,
                    resource: {
                      id: receipt.intent.invocation.tool.id,
                      kind: "tool",
                      organizationId,
                    },
                  },
                  options
                )
              ),
          }).layer
        )
      );
      const nativeApproval = (operationId: string) =>
        this.approvals().find(
          (approval) => approval.operationId === operationId
        );
      const dynamic = createDynamicToolExecutorService({
        audience,
        authorizationPolicy: policy,
        gateway: this.env.GATEWAY,
        loader: this.env.LOADER,
        reconcile: async (operationId) => {
          const response = await this.gatewayControl("/reconcile", {
            operationId,
          });
          return await response.json();
        },
        registry,
        signer: yield* Effect.tryPromise({
          catch: () =>
            new Unavailable({ reason: "Capability signer unavailable" }),
          try: () => createCapabilitySigner(signerSecret),
        }),
      });
      const executor = createControlledToolExecutor({
        address,
        approval: (call) => Effect.succeed(nativeApproval(call.operationId)),
        authority,
        checkApprover: (approval, call, options) =>
          Effect.asVoid(
            authority.require(
              {
                action: "approve",
                address,
                context: {
                  actor: { ...context.actor, id: approval.approverId },
                },
                pinnedAgent: agent,
                resource: { id: call.tool.id, kind: "tool", organizationId },
              },
              options
            )
          ),
        driver: {
          execute: (call, capability, options) =>
            Effect.gen({ self: this }, function* signedDispatch() {
              const approval = nativeApproval(options.operationId);
              if (approval) {
                yield* Effect.tryPromise({
                  catch: () =>
                    new Unavailable({ reason: "Gateway approval unavailable" }),
                  try: async () => {
                    const response = await this.gatewayControl(
                      "/approve",
                      approval
                    );
                    if (!response.ok) {
                      throw new Error("Gateway approval rejected");
                    }
                  },
                });
              }
              return yield* dynamic.execute(call, capability, options);
            }),
          reconcile: dynamic.reconcile,
        },
        pinnedAgent: agent,
        receipts,
        registry,
      });
      const model: Model<"openai-completions"> = {
        api: "openai-completions",
        baseUrl: `${this.env.FIXTURE_URL}/v1`,
        contextWindow: 32_768,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: "controlled",
        input: ["text"],
        maxTokens: 256,
        name: "fixture/controlled",
        provider: "fixture",
        reasoning: false,
      };
      const provider = createProvider({
        api: openAICompletionsApi(),
        auth: {
          apiKey: {
            name: "fixture",
            resolve: () =>
              Promise.resolve({ auth: { apiKey: "local-fixture" } }),
          },
        },
        baseUrl: model.baseUrl,
        id: model.provider,
        models: [model],
      });
      this.configuration = {
        address,
        agent,
        authenticate,
        authority,
        checkDependencies: (caller, _dependencies, options) =>
          Effect.asVoid(
            authority.require(
              {
                action: "read",
                address,
                context: caller,
                pinnedAgent: agent,
                resource: { id: agentId, kind: "agent", organizationId },
              },
              options
            )
          ),
        content: () =>
          Effect.succeed({
            citations: [],
            dependencies: {
              sourceIds: [],
              toolIds: [
                id.tool("controlled_read"),
                id.tool("controlled_write"),
              ],
            },
          }),
        executor,
        provider: {
          deadlineMs: 60_000,
          maxInputBytes: 131_072,
          model,
          provider,
        },
        receipts,
        toolDependencies: () =>
          Effect.succeed({
            sourceIds: [],
            toolIds: [id.tool("controlled_read"), id.tool("controlled_write")],
          }),
        tools: yield* Effect.all(
          registry.list().map((entry) =>
            Effect.map(bindRegisteredTool(entry), (definition) => ({
              definition,
              description: entry.description,
              parameters: Type.Object({ value: Type.String() }),
              requiresApproval: entry.requiresApproval,
            }))
          )
        ),
      };
      return this.configuration;
    });
  }

  private async isolation(input: z.infer<typeof invocationInput>) {
    const parent = await fetch(`${this.env.FIXTURE_URL}/health`);
    const { signed } = await envelope(input);
    const worker = this.env.LOADER.get("policy-egress-probe-v1", () => ({
      compatibilityDate: "2026-09-28",
      env: { GATEWAY: this.env.GATEWAY },
      globalOutbound: null,
      mainModule: "probe.js",
      modules: {
        "probe.js": `export default {async fetch(request, env) {let directError=null;let directStatus=null;try{directStatus=(await fetch("http://fixture:8090/health")).status;}catch(error){directError=error.message;}const gateway=await env.GATEWAY.fetch(new Request("https://gateway.invalid/invoke",{method:"POST",body:await request.text()}));return Response.json({directError,directStatus,gateway:await gateway.json()});}};`,
      },
    }));
    const response = await worker.getEntrypoint().fetch(
      new Request("https://probe.invalid/", {
        body: JSON.stringify(signed),
        method: "POST",
      })
    );
    return {
      parent: await parent.json(),
      parentStatus: parent.status,
      wrapper: await response.json(),
    };
  }

  private async tamper(input: z.infer<typeof invocationInput>) {
    const { payload, signer, signed } = await envelope(input);
    const variants = {
      changedArguments: await signer.sign({
        ...payload,
        call: { ...payload.call, arguments: { value: "changed" } },
      }),
      changedVersion: await signer.sign({
        ...payload,
        call: { ...payload.call, tool: { ...payload.call.tool, version: "2" } },
        capability: { ...payload.capability, toolVersion: "2" },
      }),
      crossCompany: await signer.sign({
        ...payload,
        call: {
          ...payload.call,
          context: {
            actor: {
              ...context.actor,
              organizationId: id.organization("foreign-company"),
            },
          },
          organizationId: id.organization("foreign-company"),
        },
        capability: {
          ...payload.capability,
          organizationId: id.organization("foreign-company"),
        },
      }),
      tampered: {
        ...signed,
        payload: signed.payload.replace("runtime-value", "tampered-value"),
      },
      widened: await signer.sign({
        ...payload,
        call: {
          ...payload.call,
          tool: { ...payload.call.tool, connectorId: "unregistered-connector" },
        },
        capability: {
          ...payload.capability,
          connectorId: "unregistered-connector",
        },
      }),
      wrongAudience: await signer.sign({
        ...payload,
        audience: "another-gateway",
      }),
    };
    const results = await Promise.all(
      Object.entries(variants).map(async ([name, attackEnvelope]) => {
        const response = await this.env.GATEWAY.fetch(
          new Request("https://gateway.invalid/invoke", {
            body: JSON.stringify(attackEnvelope),
            method: "POST",
          })
        );
        return [
          name,
          { httpStatus: response.status, result: await response.json() },
        ] as const;
      })
    );
    return Object.fromEntries(results);
  }

  override async onRequest(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/fixture/")) {
      return await super.onRequest(request);
    }
    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen({ self: this }, function* fixtureRoute() {
          const configuration = yield* this.configure();
          const caller = yield* configuration.authenticate(request);
          const body: unknown = yield* Effect.tryPromise({
            catch: () => new InvalidInput({ reason: "Invalid fixture JSON" }),
            try: () => request.json(),
          });
          if (path === "/fixture/state") {
            return { instanceId: this.instanceId };
          }
          if (path === "/fixture/native") {
            yield* configuration.authority.require(
              {
                action: "read",
                address: configuration.address,
                context: caller,
                pinnedAgent: configuration.agent,
                resource: { id: agentId, kind: "agent", organizationId },
              },
              { deadlineAt: Date.now() + 30_000 }
            );
            const stream = yield* Effect.tryPromise({
              catch: () =>
                new Unavailable({ reason: "Native snapshot unavailable" }),
              try: () => this.harness.session().events(piContext()),
            });
            return {
              entries: stream.snapshot.entries,
              inbox: stream.snapshot.inbox,
              receiptCount:
                this.ctx.storage.sql
                  .exec<{ count: number }>(
                    "SELECT COUNT(*) AS count FROM cerebro_pi_tool_receipts"
                  )
                  .toArray()[0]?.count ?? 0,
              tools: stream.snapshot.tools,
            };
          }
          if (path === "/fixture/access") {
            const response = yield* Effect.tryPromise({
              catch: () =>
                new Unavailable({ reason: "Fixture access unavailable" }),
              try: () =>
                this.gatewayControl("/access", currentAccess.parse(body)),
            });
            return yield* Effect.tryPromise({
              catch: () =>
                new Unavailable({ reason: "Fixture access response invalid" }),
              try: () => response.json(),
            });
          }
          if (path === "/fixture/isolation" || path === "/fixture/tamper") {
            const input = yield* Effect.try({
              catch: () =>
                new InvalidInput({ reason: "Invalid policy invocation" }),
              try: () =>
                invocationInput.extend({ address: z.unknown() }).parse(body),
            });
            return yield* Effect.tryPromise({
              catch: (error) => new Unavailable({ reason: String(error) }),
              try: async (): Promise<unknown> =>
                await (path === "/fixture/isolation"
                  ? this.isolation(input)
                  : this.tamper(input)),
            });
          }
          const input = yield* Effect.try({
            catch: () =>
              new InvalidInput({ reason: "Operation identity required" }),
            try: () => z.object({ operationId: z.string() }).parse(body),
          });
          if (path === "/fixture/journal") {
            const response = yield* Effect.tryPromise({
              catch: () =>
                new Unavailable({ reason: "Gateway journal unavailable" }),
              try: () => this.gatewayControl("/journal", input),
            });
            return yield* Effect.tryPromise({
              catch: () =>
                new Unavailable({ reason: "Gateway journal response invalid" }),
              try: () => response.json(),
            });
          }
          const receipt = yield* configuration.receipts.read(
            { operationId: id.operation(input.operationId), organizationId },
            caller,
            { deadlineAt: Date.now() + 30_000 }
          );
          if (path === "/fixture/receipt") {
            return receipt;
          }
          if (path === "/fixture/replay") {
            const { invocation: call, policyVersion: version } = receipt.intent;
            return yield* configuration.executor.execute(
              {
                agentId: call.agentId,
                arguments: call.arguments,
                context: caller,
                organizationId: call.organizationId,
                runId: call.runId,
                tool: call.tool,
              },
              {
                actorPrincipalId: caller.actor.id,
                agentId,
                argumentDigest: call.argumentDigest,
                connectorFingerprint: call.tool.connectorFingerprint,
                connectorId: call.tool.connectorId,
                effect: call.tool.effect,
                expiresAt: Date.now() + 60_000,
                operationId: call.operationId,
                organizationId,
                policyVersion: version,
                principalId,
                runId: call.runId,
                toolId: call.tool.id,
                toolVersion: call.tool.version,
              },
              {
                deadlineAt: Date.now() + 60_000,
                operationId: call.operationId,
                requestDigest: call.argumentDigest,
              }
            );
          }
          return yield* Effect.fail(
            new InvalidInput({ reason: "Unknown fixture route" })
          );
        })
      )
    );
    if (Result.isFailure(result)) {
      const failure = failureToHttp(result.failure);
      return Response.json(failure.body, { status: failure.status });
    }
    return Response.json({ status: "ok", value: result.success });
  }
}
