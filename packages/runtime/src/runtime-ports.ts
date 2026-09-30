import type { MemoryHit } from "@cerebro/contracts/memory";
import type { AuthorizationPolicy } from "@cerebro/contracts/policy";
import type { PortResult, ReadOptions } from "@cerebro/contracts/port";
import type { ContentDependencies } from "@cerebro/contracts/session";
import type { PaidWork } from "@cerebro/policy/authorization-gate";
import type { ToolBroker } from "@cerebro/tools/broker";
import type { ToolRegistry } from "@cerebro/tools/registry";

import type { StoredRun } from "./ledger.ts";
import type { DurableOperationJournal } from "./operation-journal.ts";

export interface ConfiguredModel {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly maxInputBytes: number;
  readonly maxRequestsPerRun: number;
  readonly maxOutputTokens: number;
  readonly maxResponseBytes: number;
  readonly deadlineMs: number;
  readonly pricing: {
    readonly version: string;
    readonly unit: string;
    readonly inputPerToken: number;
    readonly outputPerToken: number;
  };
}
export interface ModelHttpReceipt {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly units: number;
  readonly unit: string;
}
export interface RuntimePorts {
  readonly model: ConfiguredModel;
  readonly authorization: AuthorizationPolicy;
  readonly registry: ToolRegistry;
  readonly broker: ToolBroker;
  readonly modelJournal: DurableOperationJournal<ModelHttpReceipt>;
  readonly paidModel: PaidWork<ModelHttpReceipt>;
  readonly retrieve: (
    run: StoredRun,
    options: ReadOptions
  ) => Promise<PortResult<readonly MemoryHit[]>>;
  readonly checkDependencies: (
    run: StoredRun,
    dependencies: ContentDependencies,
    options: ReadOptions
  ) => Promise<PortResult<void>>;
  readonly prepareApproval: (operationId: string) => Promise<void>;
}
