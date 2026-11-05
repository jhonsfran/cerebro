import {
  InvalidInput,
  failureToHttp,
  toContractFailure,
} from "@cerebro/contracts/failures";
import type { ExecutionContext } from "@cerebro/contracts/identity";
import type { PrivateInspectionQuery } from "@cerebro/contracts/inspection";
import { normalizeTeamCommand } from "@cerebro/contracts/team-events";
import type { TeamCommandTransport } from "@cerebro/contracts/team-events";
import { canonicalToolArguments } from "@cerebro/contracts/tools";
import type { WorkAdmission } from "@cerebro/contracts/work";
import { WorkAdmissionSchema } from "@cerebro/contracts/work";
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

import { initializeContentSchema } from "./content-dependency-store.ts";
import { trackNativeProgress } from "./native-progress.ts";
import { piContext } from "./pi-harness.ts";
import type {
  MetadataTransaction,
  SessionEnvironment,
} from "./session-agent.ts";
import { createTeamAdmission } from "./team-admission.ts";
import { readTeamRoleImports } from "./team-content.ts";
import type { ReadTeamRoleImports } from "./team-content.ts";
import { createTeamEvents } from "./team-events.ts";
import type { TeamEventReturnTransport, TeamEvents } from "./team-events.ts";
import { expireTeam, receiveExpiredTeam } from "./team-expiration.ts";
import { readTeamInspection } from "./team-inspection.ts";
import { createTeamReportOutbox } from "./team-report-outbox.ts";
import type { TeamReportTransport } from "./team-report-outbox.ts";
import type { TeamRoleConfiguration } from "./team-role.ts";
import { createTeamRuntime } from "./team-runtime.ts";
import type { TeamRuntime } from "./team-runtime.ts";
import {
  TeamState,
  requireTeamAdmission,
  teamInputRejection,
} from "./team-state.ts";
import { drainTerminalTeam } from "./team-terminal.ts";

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
  private events: TeamEvents | undefined;

  protected abstract resolve(request: Request): Promise<TeamCommandTransport>;
  protected abstract reportTransport(work: WorkAdmission): TeamReportTransport;
  protected abstract eventReturnTransport(
    work: WorkAdmission
  ): TeamEventReturnTransport;
  protected abstract configure(
    work: WorkAdmission,
    metadata: MetadataTransaction,
    importedDependencies: ReadTeamRoleImports
  ): Promise<readonly TeamRoleConfiguration[]>;

  // oxlint-disable-next-line class-methods-use-this -- Server subclasses verify the signed private inspection target.
  protected resolveInspection(
    _request: Request
  ): Promise<PrivateInspectionQuery & { readonly context: ExecutionContext }> {
    throw new InvalidInput({ reason: "Private inspection is not configured." });
  }
  // oxlint-disable-next-line class-methods-use-this -- Server subclasses check current source and recorded content reads.
  protected authorizeInspection(
    _pi: Harness,
    _work: WorkAdmission,
    _context: ExecutionContext,
    _signal?: AbortSignal
  ): Promise<void> {
    throw new InvalidInput({
      reason: "Private inspection access is not configured.",
    });
  }

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
      this.runtime = undefined;
      this.opening = undefined;
      this.outbox = undefined;
      this.events = undefined;
      const close = async () => {
        const end = await pi.closed;
        if (end.reason === "failed") {
          this.ctx.abort("The team Pi store failed. Reopen the team runtime.");
        }
      };
      void close();
      let work = this.incoming;
      try {
        await pi.commit(
          () => initializeContentSchema(this.ctx.storage),
          context
        );
        const state = await pi.snapshot(TeamState, context);
        const retained = state?.admission ?? this.incoming;
        work = retained
          ? Schema.decodeUnknownSync(WorkAdmissionSchema, {
              onExcessProperty: "error",
            })(retained)
          : undefined;
        if (work) {
          const outbox = await this.ensureReportOutbox(work);
          const events = await this.ensureEvents(work);
          if (teamInputRejection(state, work, Date.now())) {
            await this.finishTerminal(work);
          } else {
            try {
              await this.open(work);
            } catch (error) {
              if (work.deadlineAt > Date.now()) {
                throw error;
              }
              await this.finishTerminal(work);
            }
          }
          await outbox.wake();
          await events.wake();
        }
        return pi;
      } catch (error) {
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

  private async ensureEvents(work: WorkAdmission): Promise<TeamEvents> {
    if (this.events) {
      return this.events;
    }
    if (!this.host) {
      throw new InvalidInput({ reason: "The Team native host is not open." });
    }
    const root = await this.host.pi.root(piContext());
    this.events = createTeamEvents({
      ...this.host,
      nativeId: root.id,
      work,
      transport: this.eventReturnTransport(work),
      persist: () => this.ctx.storage.sync(),
      waitUntil: (promise) => this.trackWork(promise),
    });
    return this.events;
  }

  private async finishTerminal(work: WorkAdmission): Promise<void> {
    if (!this.host) {
      throw new InvalidInput({ reason: "The Team native host is not open." });
    }
    const { pi, registry } = this.host;
    const events = await this.ensureEvents(work);
    const outbox = await this.ensureReportOutbox(work);
    const admission = createTeamAdmission({
      pi,
      work,
      now: Date.now,
      events,
      deliver: () =>
        Promise.reject(
          new InvalidInput({
            reason: "Terminal Team work cannot accept input.",
          })
        ),
    });
    registry.install({ name: "cerebro-team-admission", tasks: [admission] });
    await pi.commit(async (tx) => {
      const state = await tx.doc(TeamState);
      requireTeamAdmission(state, work);
      if (state.phase === "running" || state.phase === "waiting") {
        state.phase = state.report?.kind ?? "failed";
      }
    }, piContext());
    await drainTerminalTeam(pi);
    await expireTeam(pi, registry, work, outbox.enqueueIn);
  }

  private async createRuntime(work: WorkAdmission): Promise<TeamRuntime> {
    const { host } = this;
    if (!host) {
      throw new InvalidInput({ reason: "The team native host is not open." });
    }
    const metadata: MetadataTransaction = (operation) =>
      host.pi.commit(operation, piContext());
    const outbox = await this.ensureReportOutbox(work);
    const events = await this.ensureEvents(work);
    const configurations = await this.configure(work, metadata, (index) =>
      readTeamRoleImports(host.pi, work, index)
    );
    return await createTeamRuntime({
      ...host,
      work,
      configurations,
      events,
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
      if (new URL(request.url).pathname === "/inspect") {
        const input = await this.resolveInspection(request);
        const pi = await this.harness.pi();
        await this.authorizeInspection(
          pi,
          input.work,
          input.context,
          request.signal
        );
        const frame = await readTeamInspection({
          pi,
          work: input.work,
          query: input.query,
          signal: request.signal,
        });
        await this.authorizeInspection(
          pi,
          input.work,
          input.context,
          request.signal
        );
        return Response.json(frame);
      }
      const input = await this.resolve(request);
      const { command, wire } = normalizeTeamCommand(input);
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
      const state =
        this.host && (await this.host.pi.snapshot(TeamState, piContext()));
      const rejection = teamInputRejection(state, command.work, Date.now());
      if (wire.kind === "event-command" && rejection) {
        await this.finishTerminal(command.work);
        const events = await this.ensureEvents(command.work);
        const receipt = await events.fallback(wire, rejection);
        await this.ensureWake(command.work.deadlineAt);
        await events.wake();
        return Response.json(receipt);
      }
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
      return Response.json(await runtime.receive(wire));
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
      const running = await this.runtime?.wake(deadlineAt);
      const outboxWake = await this.outbox?.wake();
      const eventWake = await this.events?.wake();
      const times = [
        running?.rescheduleAt,
        outboxWake?.rescheduleAt,
        eventWake?.rescheduleAt,
      ].filter((value): value is number => value !== undefined);
      if (times.length > 0) {
        return { rescheduleAt: Math.min(...times) };
      }
      return !this.runtime && deadlineAt > Date.now()
        ? { rescheduleAt: Math.min(deadlineAt, Date.now() + 5000) }
        : undefined;
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
