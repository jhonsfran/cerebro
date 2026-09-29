import type {
  ArtifactId,
  ExecutionContext,
  OrganizationId,
  SourceId,
} from "./identity.ts";
import type { EffectOptions, PortResult, ReadOptions } from "./port.ts";

export type Visibility =
  | {
      readonly kind: "private";
      readonly ownerId: ExecutionContext["actor"]["id"];
    }
  | { readonly kind: "organization" }
  | { readonly kind: "grant"; readonly grantId: string };

export interface Provenance {
  readonly sourceId: SourceId;
  readonly sourceVersion: string;
  readonly sourceUri: string;
  readonly observedAt: number;
}

export interface MemoryScope {
  readonly organizationId: OrganizationId;
  readonly context: ExecutionContext;
}

export type MemoryRecord =
  | {
      readonly kind: "source-chunk";
      readonly id: string;
      readonly text: string;
      readonly visibility: Visibility;
      readonly provenance: Provenance;
    }
  | {
      readonly kind: "conversation-summary";
      readonly id: string;
      readonly text: string;
      readonly visibility: Visibility;
      readonly provenance: Provenance;
      readonly dependentSourceIds: readonly SourceId[];
    }
  | {
      readonly kind: "remembered-fact";
      readonly id: string;
      readonly text: string;
      readonly visibility: Visibility;
      readonly provenance: Provenance;
    };

export interface MemoryQuery extends MemoryScope {
  readonly text: string;
  readonly limit: number;
}

export interface MemoryHit {
  readonly record: MemoryRecord;
  readonly citation: Provenance;
}

export interface MemoryStore {
  readonly retrieve: (
    query: MemoryQuery,
    options: ReadOptions
  ) => Promise<PortResult<readonly MemoryHit[]>>;
  readonly remember: (
    scope: MemoryScope,
    record: MemoryRecord,
    options: EffectOptions
  ) => Promise<PortResult<MemoryRecord>>;
  readonly forget: (
    scope: MemoryScope,
    sourceId: SourceId,
    options: EffectOptions
  ) => Promise<PortResult<{ readonly removed: number }>>;
}

export interface ArtifactRef {
  readonly organizationId: OrganizationId;
  readonly artifactId: ArtifactId;
  readonly provenance: Provenance;
  readonly visibility: Visibility;
}

export interface ArtifactStore {
  readonly put: (
    scope: MemoryScope,
    bytes: Uint8Array,
    metadata: Omit<ArtifactRef, "artifactId">,
    options: EffectOptions
  ) => Promise<PortResult<ArtifactRef>>;
  readonly read: (
    scope: MemoryScope,
    ref: ArtifactRef,
    options: ReadOptions
  ) => Promise<PortResult<Uint8Array>>;
  readonly delete: (
    scope: MemoryScope,
    ref: ArtifactRef,
    options: EffectOptions
  ) => Promise<PortResult<void>>;
}
