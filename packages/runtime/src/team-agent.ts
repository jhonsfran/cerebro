import {
  InvalidInput,
  failureToHttp,
  toContractFailure,
} from "@cerebro/contracts/failures";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { WorkAdmission, TeamCommand } from "@cerebro/contracts/work";
import { createModels } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import type { ConversationId, Registry } from "@earendil-works/pi-durable";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import type {
  LifecycleJobContext,
  LifecycleJobOutcome,
} from "agents/lifecycle";
import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";

import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import type {
  MetadataTransaction,
  SessionEnvironment,
} from "./session-agent.ts";
import { expireTeam, receiveExpiredTeam } from "./team-expiration.ts";
import { createTeamReportOutbox } from "./team-report-outbox.ts";
import type { TeamReportTransport } from "./team-report-outbox.ts";
import type { TeamRoleConfiguration } from "./team-role.ts";
import { createTeamRuntime } from "./team-runtime.ts";
import type { TeamRuntime } from "./team-runtime.ts";
import { TeamState } from "./team-state.ts";

const wakePayload = Schema.Struct({ deadlineAt: Schema.Int });

export abstract class TeamAgent<
  Environment extends SessionEnvironment,
> extends DurableObject<Environment> {
  private host:
    | { pi: Harness; models: MutableModels; registry: Registry }
    | undefined;
  private runtime: TeamRuntime | undefined;
  private opening: Promise<TeamRuntime> | undefined;
  private outbox: ReturnType<typeof createTeamReportOutbox> | undefined;
  private incoming: WorkAdmission | undefined;

  protected abstract resolve(request: Request): Promise<TeamCommand>;
  protected abstract reportTransport(work: WorkAdmission): TeamReportTransport;
  protected abstract configure(
    work: WorkAdmission,
    metadata: MetadataTransaction
  ): Promise<readonly TeamRoleConfiguration[]>;

  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      const models = createModels();
      const registry = createRegistry();
      const pi = await Harness.open(
        storage,
        {
          models,
          registry,
          onReport: (error) => this.reportFailure(error),
          settings: {
            extensions: [],
            stream: { maxRetries: 0, transport: "sse" },
          },
        },
        context
      );
      this.host = { pi, models, registry };
      const close = async () => {
        const end = await pi.closed;
        if (end.reason === "failed") {
          this.ctx.abort("The team Pi store failed. Reopen the team runtime.");
        }
      };
      void close();
      let work = this.incoming;
      try {
        const state = await pi.snapshot(TeamState, context);
        work = state?.admission ?? this.incoming;
        if (work) {
          const outbox = await this.ensureReportOutbox(work);
          await (state?.report || work.deadlineAt <= Date.now()
            ? expireTeam(pi, registry, work, outbox.enqueueIn)
            : this.open(work));
          await outbox.wake();
        }
        return pi;
      } catch (error) {
        if (work && work.deadlineAt <= Date.now()) {
          const outbox = await this.ensureReportOutbox(work);
          await expireTeam(pi, registry, work, outbox.enqueueIn);
          await outbox.wake();
          return pi;
        }
        await pi.close(context);
        this.host = undefined;
        throw error;
      }
    },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  private async ensureWake(deadlineAt: number): Promise<void> {
    await this.lifecycle.jobs.push({
      fn: "cerebro-team",
      id: "cerebro-team",
      payload: { deadlineAt },
      recoveryLoop: true,
      singleflight: true,
      time: Date.now(),
    });
  }

  private async open(work: WorkAdmission): Promise<TeamRuntime> {
    if (this.runtime) {
      return this.runtime;
    }
    if (!this.opening) {
      this.opening = this.createRuntime(work);
    }
    try {
      this.runtime = await this.opening;
      return this.runtime;
    } finally {
      this.opening = undefined;
    }
  }

  protected async submit(
    nativeId: ConversationId,
    text: string,
    operationId: string
  ): Promise<unknown> {
    const receipt = await this.harness.submit(text, {
      session: String(nativeId),
      operationId,
      whenBusy: "steer",
    });
    if (this.host) {
      trackNativeProgress(
        this.host.pi,
        { conversations: [nativeId] },
        (promise) => this.trackWork(promise)
      );
    }
    return receipt;
  }

  private trackWork(work: Promise<unknown>): void {
    if (!this.lifecycle.trackAlarmWork(work)) {
      this.ctx.waitUntil(work);
    }
  }

  protected reportFailure(error: unknown): void {
    console.error(
      JSON.stringify({
        event: "team.execution.failed",
        errorCode: toContractFailure(error, "Team execution failed.")._tag,
        team: this.ctx.id.name,
        service: "cerebro-runtime",
      })
    );
  }

  private async ensureReportOutbox(work: WorkAdmission) {
    if (this.outbox) {
      return this.outbox;
    }
    const { host } = this;
    if (!host) {
      throw new InvalidInput({ reason: "The team native host is not open." });
    }
    const root = await host.pi.root(piContext());
    this.outbox = createTeamReportOutbox({
      pi: host.pi,
      registry: host.registry,
      nativeId: root.id,
      transport: this.reportTransport(work),
      persist: () => this.ctx.storage.sync(),
      waitUntil: (promise) => this.trackWork(promise),
    });
    return this.outbox;
  }

  private async createRuntime(work: WorkAdmission): Promise<TeamRuntime> {
    const { host } = this;
    if (!host) {
      throw new InvalidInput({ reason: "The team native host is not open." });
    }
    const metadata: MetadataTransaction = (operation) =>
      host.pi.commit(operation, piContext());
    const outbox = await this.ensureReportOutbox(work);
    const configurations = await this.configure(work, metadata);
    return await createTeamRuntime({
      ...host,
      work,
      configurations,
      storage: this.ctx.storage,
      metadata,
      persistReportIn: outbox.enqueueIn,
      ensureWake: (deadlineAt) => this.ensureWake(deadlineAt),
      waitUntil: (promise) => this.trackWork(promise),
      submit: (nativeId, text, operationId) =>
        this.submit(nativeId, text, operationId),
    });
  }

  async onRequest(request: Request): Promise<Response> {
    try {
      const command = await this.resolve(request);
      if (
        this.incoming &&
        canonicalToolArguments(this.incoming) !==
          canonicalToolArguments(command.work)
      ) {
        throw new InvalidInput({ reason: "The team admission changed." });
      }
      this.incoming = command.work;
      await this.harness.pi();
      const outbox = await this.ensureReportOutbox(command.work);
      if (command.work.deadlineAt <= Date.now() && this.host) {
        await this.ensureWake(command.work.deadlineAt);
        return Response.json(
          await receiveExpiredTeam(
            this.host.pi,
            this.host.registry,
            command,
            outbox.enqueueIn
          )
        );
      }
      const runtime = await this.open(command.work);
      return Response.json(await runtime.receive(command));
    } catch (error) {
      this.reportFailure(error);
      const result = failureToHttp(
        toContractFailure(error, "The team command is unavailable.")
      );
      return Response.json(result.body, { status: result.status });
    }
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn !== "cerebro-team") {
      return;
    }
    const { deadlineAt } = Schema.decodeUnknownSync(wakePayload)(job.payload);
    try {
      await this.harness.pi();
      const outboxWake = await this.outbox?.wake();
      if (!this.runtime) {
        if (outboxWake) {
          return outboxWake;
        }
        return deadlineAt > Date.now()
          ? { rescheduleAt: Math.min(deadlineAt, Date.now() + 5000) }
          : undefined;
      }
      const running = await this.runtime.wake(deadlineAt);
      return running ?? (await this.outbox?.wake());
    } catch (error) {
      this.reportFailure(error);
      if (deadlineAt <= Date.now()) {
        return;
      }
      return { rescheduleAt: Math.min(deadlineAt, Date.now() + 5000) };
    }
  }

  async dispose(): Promise<void> {
    await this.harness.dispose();
  }
}
