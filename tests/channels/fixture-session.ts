/* oxlint-disable no-await-in-loop -- Each stream item requires its own current permission check before emission. */
// A deterministic in-process SessionService for channel tests. Runs live in
// memory; transcript items use the real channel_item projection table.
import { Effect, Schema, Stream } from "effect";

import {
  authorize,
  authorizeContent,
  digest,
  unwrap,
} from "../../packages/channels/src/security";
import { ChannelError } from "../../packages/channels/src/types";
import type { ChannelOptions } from "../../packages/channels/src/types";
import {
  Conflict,
  Denied,
  InvalidInput,
  NotFound,
  Unavailable,
  UnknownOutcome,
} from "../../packages/contracts/src/failures";
import type { ContractFailure } from "../../packages/contracts/src/failures";
import {
  classifyEventDelivery,
  id,
  preflightEffect,
} from "../../packages/contracts/src/index";
import type {
  EventAddress,
  EventEnvelope,
  RunState,
  SessionReceipt,
} from "../../packages/contracts/src/index";
import type { PortResult } from "../../packages/contracts/src/port";
import { DomainSnapshot } from "../../packages/contracts/src/session-service";
import type {
  SessionService,
  SubmissionMode,
} from "../../packages/contracts/src/session-service";
import { and, asc, eq, sql } from "../../packages/db/node_modules/drizzle-orm";
import type { Database } from "../../packages/db/src/index";
import { createAgentRepository } from "../../packages/db/src/repositories/agents";
import {
  channelEffect,
  channelItem,
} from "../../packages/db/src/schema/agents";
import type { ChannelItemBody } from "../../packages/db/src/schema/agents";

export const FIXTURE_SOURCE_ID = "pilot-source";
export const FIXTURE_TOOL_ID = "fixture-read";
export const FIXTURE_MODEL_ID = "fixture-model";

interface FixtureRun {
  readonly agentVersion: number;
  readonly conversationId: string;
  readonly digest: string;
  readonly envelope: EventEnvelope;
  readonly eventId: string;
  readonly mode: SubmissionMode;
  readonly operationId: string;
  readonly organizationId: string;
  readonly runId: string;
  state: RunState;
}
const fixtureRuns = new Map<string, FixtureRun>();
export const resetFixtureSessions = (): void => {
  fixtureRuns.clear();
};
export const fixtureRunCount = (): number => fixtureRuns.size;
export const fixtureRun = (
  conversationId: string,
  runId: string
): FixtureRun | undefined => {
  const run = fixtureRuns.get(runId);
  return run?.conversationId === conversationId ? run : undefined;
};

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
const typedResult = <Value>(
  result: PortResult<Value>
): Effect.Effect<Value, ContractFailure> => {
  switch (result.status) {
    case "ok": {
      return Effect.succeed(result.value);
    }
    case "denied": {
      return Effect.fail(
        new Denied({ code: "unauthorized", reason: result.reason })
      );
    }
    case "conflict": {
      return Effect.fail(
        new Conflict({ code: result.code, reason: result.reason })
      );
    }
    case "invalid-input": {
      return Effect.fail(new InvalidInput({ reason: result.reason }));
    }
    case "not-found": {
      return Effect.fail(new NotFound({ resource: result.resource }));
    }
    case "unavailable": {
      return Effect.fail(new Unavailable({ reason: result.reason }));
    }
    default: {
      return Effect.fail(
        new UnknownOutcome({
          operationId: result.operationId,
          reason: result.reason,
        })
      );
    }
  }
};
const fixtureFailure = (cause: unknown): ContractFailure => {
  if (cause instanceof ChannelError && cause.status === 403) {
    return new Denied({ code: "unauthorized", reason: cause.message });
  }
  return new Unavailable({
    reason: "The isolated channel fixture is unavailable.",
  });
};
const fixtureEffect = <Value>(
  operation: () => Promise<Value>
): Effect.Effect<Value, ContractFailure> =>
  Effect.tryPromise({ catch: fixtureFailure, try: operation });
const addressMatches = (event: EventEnvelope, address: EventAddress): boolean =>
  event.organizationId === address.organizationId &&
  event.agentId === address.agentId &&
  event.conversationId === address.conversationId &&
  event.sessionId === address.sessionId;
const fixtureApprovalState = (
  run: RunState
): "pending" | "allowed" | "cancelled" => {
  if (run.state === "waiting-for-approval") {
    return "pending";
  }
  if (run.state === "completed") {
    return "allowed";
  }
  return "cancelled";
};
const fixtureItemKey = (value: ChannelItemBody): string => {
  switch (value.type) {
    case "user": {
      return `user:${value.eventId}`;
    }
    case "tool": {
      return `tool:fixture-tool:${value.runId}`;
    }
    case "approval": {
      return `approval:${value.approvalId}`;
    }
    case "output": {
      return `answer:answer:${value.runId}`;
    }
    case "citation": {
      return `citation:answer:${value.runId}:${value.sourceId}:${value.sourceVersion}`;
    }
    default: {
      return `run:${value.runId}`;
    }
  }
};
const item = (
  tx: Transaction,
  envelope: EventEnvelope,
  value: ChannelItemBody
) =>
  tx
    .insert(channelItem)
    .values({
      conversationId: envelope.conversationId,
      item: value,
      itemKey: `runtime:${envelope.sessionId}:${fixtureItemKey(value)}`,
      organizationId: envelope.organizationId,
    })
    .onConflictDoUpdate({ set: { item: value }, target: channelItem.itemKey });
const fixtureDependencies = {
  sourceIds: [id.source(FIXTURE_SOURCE_ID)],
  toolIds: [FIXTURE_TOOL_ID],
};
const toolDependencies = { sourceIds: [], toolIds: [FIXTURE_TOOL_ID] };
const complete = async (
  tx: Transaction,
  envelope: EventEnvelope,
  runId: string,
  now: number
): Promise<RunState> => {
  const text =
    envelope.event.type === "user.message"
      ? envelope.event.payload.text
      : "Scheduled fixture request";
  const answer = `Fixture answer for "${text}". The local pilot source describes durable conversation admission.`;
  await item(tx, envelope, {
    dependencies: toolDependencies,
    name: "Read pilot source",
    runId,
    state: "succeeded",
    toolId: FIXTURE_TOOL_ID,
    type: "tool",
  });
  await item(tx, envelope, {
    dependencies: fixtureDependencies,
    runId,
    text: answer,
    type: "output",
  });
  await item(tx, envelope, {
    dependencies: fixtureDependencies,
    href: `/api/product/conversations/${envelope.conversationId}/sources/${FIXTURE_SOURCE_ID}`,
    runId,
    sourceId: FIXTURE_SOURCE_ID,
    sourceVersion: "1",
    title: "Local pilot source",
    type: "citation",
  });
  const state: RunState = {
    completedAt: now,
    runId: id.run(runId),
    state: "completed",
  };
  await item(tx, envelope, {
    run: state,
    runId,
    type: "run",
  });
  return state;
};

export const createFixtureSessionService = (
  database: Database,
  options: ChannelOptions
): SessionService => {
  const now = options.now ?? Date.now;
  const fixture = {
    async approve(
      command: Parameters<SessionService["approve"]>[0],
      effect: Parameters<SessionService["approve"]>[1]
    ): Promise<PortResult<RunState>> {
      const preflight = preflightEffect(effect, now());
      if (preflight.status !== "ok") {
        return preflight;
      }
      await authorize(
        database,
        options,
        command.context,
        "approve",
        "agent",
        command.address.agentId
      );
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${command.address.sessionId}))`
        );
        const requestDigest = await digest({ command, kind: "approve" });
        const [prior] = await tx
          .select()
          .from(channelEffect)
          .where(eq(channelEffect.operationId, effect.operationId));
        if (prior) {
          return prior.digest === requestDigest && "state" in prior.result
            ? { status: "ok", value: prior.result }
            : {
                code: "digest-mismatch",
                reason: "The approval operation changed.",
                status: "conflict",
              };
        }
        const rows = [...fixtureRuns.values()].filter(
          (row) => row.conversationId === command.address.conversationId
        );
        const found = rows.find(
          (row) =>
            row.runId === command.runId &&
            `approval:${row.runId}` === command.approvalId &&
            addressMatches(row.envelope, command.address)
        );
        if (!found) {
          return { resource: "approval", status: "not-found" };
        }
        if (found.state.state !== "waiting-for-approval") {
          return {
            code: "already-final",
            reason: "The run is no longer waiting for approval.",
            status: "conflict",
          };
        }
        const result: RunState =
          command.decision === "allow"
            ? await complete(tx, found.envelope, found.runId, now())
            : { endedAt: now(), runId: command.runId, state: "cancelled" };
        await item(tx, found.envelope, {
          approvalId: command.approvalId,
          expiresAt: found.envelope.occurredAt + 60_000,
          operationId: `fixture-tool:${found.runId}`,
          runId: found.runId,
          state: command.decision === "allow" ? "allowed" : "denied",
          type: "approval",
        });
        if (command.decision === "deny") {
          await item(tx, found.envelope, {
            run: result,
            runId: found.runId,
            type: "run",
          });
        }
        found.state = result;
        await tx.insert(channelEffect).values({
          digest: requestDigest,
          operationId: effect.operationId,
          result,
        });
        return { status: "ok", value: result };
      });
    },
    async cancel(
      command: Parameters<SessionService["cancel"]>[0],
      effect: Parameters<SessionService["cancel"]>[1]
    ): Promise<PortResult<RunState>> {
      const preflight = preflightEffect(effect, now());
      if (preflight.status !== "ok") {
        return preflight;
      }
      await authorize(
        database,
        options,
        command.context,
        "execute",
        "agent",
        command.address.agentId
      );
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${command.address.sessionId}))`
        );
        const requestDigest = await digest({ command, kind: "cancel" });
        const [prior] = await tx
          .select()
          .from(channelEffect)
          .where(eq(channelEffect.operationId, effect.operationId));
        if (prior) {
          return prior.digest === requestDigest && "state" in prior.result
            ? { status: "ok", value: prior.result }
            : {
                code: "digest-mismatch",
                reason: "The cancel operation changed.",
                status: "conflict",
              };
        }
        const found = fixtureRuns.get(command.runId);
        if (!found || !addressMatches(found.envelope, command.address)) {
          return { resource: "run", status: "not-found" };
        }
        if (["completed", "failed", "cancelled"].includes(found.state.state)) {
          return {
            code: "already-final",
            reason: "The run is already final.",
            status: "conflict",
          };
        }
        const result: RunState = {
          endedAt: now(),
          runId: command.runId,
          state: "cancelled",
        };
        found.state = result;
        await item(tx, found.envelope, {
          run: result,
          runId: found.runId,
          type: "run",
        });
        await tx.insert(channelEffect).values({
          digest: requestDigest,
          operationId: effect.operationId,
          result,
        });
        return { status: "ok", value: result };
      });
    },
    async submit(
      command: Parameters<SessionService["submit"]>[0],
      effect: Parameters<SessionService["submit"]>[1]
    ): Promise<PortResult<SessionReceipt>> {
      const preflight = preflightEffect(effect, now());
      if (preflight.status !== "ok") {
        return preflight;
      }
      const envelope = command.event;
      await authorize(
        database,
        options,
        envelope.context,
        "execute",
        "agent",
        envelope.agentId
      );
      const definition = unwrap(
        await createAgentRepository(database).get(
          envelope.organizationId,
          envelope.agentId,
          "latest",
          effect
        )
      );
      return database.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${envelope.sessionId}))`
        );
        const prior = [...fixtureRuns.values()].find(
          (run) => run.eventId === envelope.eventId
        );
        if (prior) {
          if (
            classifyEventDelivery(prior.envelope, envelope) !== "duplicate" ||
            prior.operationId !== effect.operationId ||
            prior.digest !== effect.requestDigest
          ) {
            return {
              code: "digest-mismatch",
              reason: "The fixture event has different content.",
              status: "conflict",
            };
          }
          return {
            status: "ok",
            value: {
              acceptedEventId: envelope.eventId,
              replayed: true,
              runId: id.run(prior.runId),
              sessionId: envelope.sessionId,
            },
          };
        }
        const runId = id.run(`run:${envelope.eventId}`);
        const requiresApproval =
          envelope.event.type === "user.message" &&
          /\bapproval\b/iu.test(envelope.event.payload.text);
        await item(tx, envelope, {
          eventId: envelope.eventId,
          runId,
          text:
            envelope.event.type === "user.message"
              ? envelope.event.payload.text
              : "Scheduled fixture request",
          type: "user",
        });
        await item(tx, envelope, {
          dependencies: toolDependencies,
          name: "Read pilot source",
          runId,
          state: "running",
          toolId: FIXTURE_TOOL_ID,
          type: "tool",
        });
        let state: RunState;
        if (requiresApproval) {
          state = { runId, state: "waiting-for-approval" };
          await item(tx, envelope, {
            approvalId: `approval:${runId}`,
            runId,
            type: "approval",
          });
          await item(tx, envelope, {
            run: state,
            runId,
            type: "run",
          });
        } else {
          state = await complete(tx, envelope, runId, now());
        }
        fixtureRuns.set(runId, {
          agentVersion: definition.version,
          conversationId: envelope.conversationId,
          digest: effect.requestDigest,
          envelope,
          eventId: envelope.eventId,
          mode: command.mode ?? "follow-up",
          operationId: effect.operationId,
          organizationId: envelope.organizationId,
          runId,
          state,
        });
        return {
          status: "ok",
          value: {
            acceptedEventId: envelope.eventId,
            replayed: false,
            runId,
            sessionId: envelope.sessionId,
          },
        };
      });
    },
  };
  const service: SessionService = {
    approve: (command, effect) =>
      Effect.flatMap(
        fixtureEffect(() => fixture.approve(command, effect)),
        typedResult
      ),
    cancel: (command, effect) =>
      Effect.flatMap(
        fixtureEffect(() => fixture.cancel(command, effect)),
        typedResult
      ),
    inspect: (address, context, read) =>
      fixtureEffect(async () => {
        if (read.signal?.aborted || read.deadlineAt <= now()) {
          throw new ChannelError(
            503,
            "unavailable",
            "The fixture read deadline passed."
          );
        }
        await authorize(
          database,
          options,
          context,
          "read",
          "agent",
          address.agentId
        );
        const runs = [...fixtureRuns.values()].filter(
          (run) =>
            run.organizationId === address.organizationId &&
            run.conversationId === address.conversationId &&
            addressMatches(run.envelope, address)
        );
        const records = await database
          .select()
          .from(channelItem)
          .where(
            and(
              eq(channelItem.organizationId, address.organizationId),
              eq(channelItem.conversationId, address.conversationId)
            )
          )
          .orderBy(asc(channelItem.cursor));
        for (const record of records) {
          await authorizeContent(database, options, context, record.item);
        }
        const dependencies = fixtureDependencies;
        const tools = new Map(
          records.flatMap((record) =>
            record.item.type === "tool"
              ? [[record.item.runId, record.item] as const]
              : []
          )
        );
        const approvalStates = new Map(
          records.flatMap((record) =>
            record.item.type === "approval"
              ? [[record.item.runId, record.item.state] as const]
              : []
          )
        );
        const runStates = new Map(
          runs.map((run) => [run.runId, run.state.state])
        );
        const outputs = records.flatMap((record) =>
          record.item.type === "output" ? [record.item] : []
        );
        return Schema.decodeUnknownSync(DomainSnapshot)({
          address,
          agentVersion: runs[0]?.agentVersion ?? 1,
          approvals: runs
            .filter(
              (run) =>
                run.envelope.event.type === "user.message" &&
                /\bapproval\b/iu.test(run.envelope.event.payload.text)
            )
            .map((run) => ({
              approvalId: `approval:${run.runId}`,
              expiresAt: run.envelope.occurredAt + 60_000,
              operationId: `fixture-tool:${run.runId}`,
              runId: run.runId,
              state:
                approvalStates.get(run.runId) ??
                fixtureApprovalState(run.state),
            })),
          executions: runs.map((run) => ({
            executionId: `execution:${run.runId}`,
            runIds: [run.runId],
          })),
          outputs: outputs.map((output) => ({
            answerId: `answer:${output.runId}`,
            citations: records.flatMap((record) =>
              record.item.type === "citation" &&
              record.item.runId === output.runId
                ? [
                    {
                      observedAt: 1,
                      sourceId: record.item.sourceId,
                      sourceUri: record.item.href,
                      sourceVersion: record.item.sourceVersion,
                    },
                  ]
                : []
            ),
            dependencies: output.dependencies ?? dependencies,
            executionId: `execution:${output.runId}`,
            runId: output.runId,
            runIds: [output.runId],
            text: output.text,
          })),
          revision: records.at(-1)?.cursor ?? 0,
          runs: runs.map((run) => run.state),
          tools: [...tools.values()].map((tool) => ({
            arguments: {},
            dependencies: tool.dependencies ?? dependencies,
            effect: "read",
            operationId: `fixture-tool:${tool.runId}`,
            output: tool.output ?? null,
            runId: tool.runId,
            state:
              runStates.get(tool.runId) === "cancelled"
                ? "cancelled"
                : tool.state,
            toolId: tool.toolId,
            toolVersion: "1",
          })),
          userMessages: runs.map((run) => ({
            eventId: run.eventId,
            mode: run.mode,
            occurredAt: run.envelope.occurredAt,
            runId: run.runId,
            text:
              run.envelope.event.type === "user.message"
                ? run.envelope.event.payload.text
                : "Scheduled fixture request",
          })),
        });
      }),
    stream: (address, context, request, read) =>
      Stream.map(
        Stream.fromEffect(service.inspect(address, context, read)),
        (snapshot) => ({
          accessGeneration: request.accessGeneration,
          address,
          epoch: crypto.randomUUID(),
          reason: "attach" as const,
          schemaVersion: 1 as const,
          sequence: 0,
          snapshot,
          type: "snapshot" as const,
        })
      ),
    submit: (command, effect) =>
      Effect.flatMap(
        fixtureEffect(() => fixture.submit(command, effect)),
        typedResult
      ),
  };
  return service;
};
