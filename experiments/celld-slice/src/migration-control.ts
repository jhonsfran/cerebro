import { EffectDrizzleSqlite } from "@opencode-ai/core/database/drizzle";
import { DatabaseMigration } from "@opencode-ai/core/database/migration";
import { migrations } from "@opencode-ai/core/database/migration.gen";
import { sqliteLayer } from "@opencode-ai/core/database/sqlite.workerd";
import { OpenCodeWorkerd } from "@opencode-ai/sdk/workerd";
import { Global } from "@opencode-ai/util/global";
import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";

type FixtureCase = "current" | "pending" | "legacy-names";
interface Marker extends Record<string, string | number> {
  id: string;
  time_completed: number;
}
interface Workspace extends Record<string, string | number> {
  id: string;
  provider: string;
  binding: string;
  created_at: number;
  last_used_at: number;
}
interface Prepared {
  kind: FixtureCase;
  instanceId: string;
  markers: Marker[];
  sentinel: Workspace;
  bindingNotNull: number;
}
const snapshotKey = "cerebro-migration-fixture";
const sentinel: Workspace = {
  binding: "preserved",
  created_at: 1,
  id: "migration-sentinel",
  last_used_at: 1,
  provider: "fixture",
};

export class MigrationControl extends DurableObject {
  private readonly instanceId = crypto.randomUUID();
  private client: Promise<OpenCodeWorkerd.Interface> | undefined;

  private markers(): Marker[] {
    return this.ctx.storage.sql
      .exec<Marker>("SELECT id, time_completed FROM migration ORDER BY id")
      .toArray();
  }

  private bindingNotNull(): number {
    const columns = this.ctx.storage.sql
      .exec<{ name: string; notnull: number }>("PRAGMA table_info(workspace)")
      .toArray();
    const binding = columns.find((column) => column.name === "binding");
    if (!binding) {
      throw new Error("Workspace binding is missing");
    }
    return binding.notnull;
  }

  private async prepare(kind: FixtureCase): Promise<Response> {
    if (await this.ctx.storage.get(snapshotKey)) {
      return Response.json(
        { error: "Fixture is already prepared", ok: false },
        { status: 409 }
      );
    }
    if (kind === "pending") {
      await Effect.runPromise(
        Effect.gen(function* preparePendingSchema() {
          const db = yield* EffectDrizzleSqlite.makeWithDefaults();
          yield* DatabaseMigration.applyOnly(db, migrations.slice(0, -1));
        }).pipe(
          Effect.provide(sqliteLayer({ storage: this.ctx.storage })),
          Effect.provide(
            Global.layerWith({ data: "/tmp/cerebro-migration-fixture" })
          )
        )
      );
    } else {
      const client = await OpenCodeWorkerd.create({
        models: { fetch: false },
        storage: this.ctx.storage,
      });
      try {
        await client.health.get();
      } finally {
        await client.close();
      }
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO workspace (id, provider, binding, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)",
      sentinel.id,
      sentinel.provider,
      sentinel.binding,
      sentinel.created_at,
      sentinel.last_used_at
    );
    const prepared: Prepared = {
      bindingNotNull: this.bindingNotNull(),
      instanceId: this.instanceId,
      kind,
      markers: this.markers(),
      sentinel,
    };
    if (kind === "legacy-names") {
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.sql.exec(
          "CREATE TABLE __drizzle_migrations (name TEXT NOT NULL)"
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO __drizzle_migrations (name) SELECT id FROM migration"
        );
        this.ctx.storage.sql.exec("DELETE FROM migration");
      });
    }
    await this.ctx.storage.put(snapshotKey, prepared);
    return Response.json({
      ok: true,
      ...prepared,
      markerCountAfterPrepare: this.markers().length,
    });
  }

  private async verify(): Promise<Response> {
    const prepared = await this.ctx.storage.get<Prepared>(snapshotKey);
    if (!prepared) {
      return Response.json(
        { error: "Fixture was not prepared", ok: false },
        { status: 409 }
      );
    }
    if (prepared.instanceId === this.instanceId) {
      return Response.json(
        { error: "Restart celld before verification", ok: false },
        { status: 409 }
      );
    }
    this.client ??= OpenCodeWorkerd.create({
      models: { fetch: false },
      storage: this.ctx.storage,
    });
    const client = await this.client;
    const health = await client.health.get();
    const after = this.markers();
    const [workspace] = this.ctx.storage.sql
      .exec<Workspace>(
        "SELECT id, provider, binding, created_at, last_used_at FROM workspace WHERE id = ?",
        sentinel.id
      )
      .toArray();
    const expectedIds = migrations.map((migration) => migration.id).toSorted();
    const markerIdsCorrect =
      JSON.stringify(after.map((marker) => marker.id)) ===
      JSON.stringify(expectedIds);
    const previousMarkersPreserved = prepared.markers.every((before) =>
      after.some(
        (marker) =>
          marker.id === before.id &&
          marker.time_completed === before.time_completed
      )
    );
    const sentinelPreserved =
      workspace !== undefined &&
      Object.entries(prepared.sentinel).every(([key, value]) =>
        Object.entries(workspace).some(
          ([actualKey, actualValue]) =>
            actualKey === key && actualValue === value
        )
      );
    const bindingNotNull = this.bindingNotNull();
    let nullBindingAccepted = false;
    if (prepared.kind === "pending") {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO workspace (id, provider, binding, created_at, last_used_at) VALUES (?, ?, NULL, ?, ?)",
        "migration-null-binding",
        "fixture",
        1,
        1
      );
      nullBindingAccepted =
        this.ctx.storage.sql
          .exec<{ binding: string | null }>(
            "SELECT binding FROM workspace WHERE id = ?",
            "migration-null-binding"
          )
          .toArray()[0]?.binding === null;
    }
    const legacyNames =
      prepared.kind === "legacy-names"
        ? this.ctx.storage.sql
            .exec<{ name: string }>(
              "SELECT name FROM __drizzle_migrations ORDER BY name"
            )
            .toArray()
            .map((row) => row.name)
        : [];
    const pendingChange =
      prepared.kind !== "pending" ||
      (prepared.bindingNotNull === 1 &&
        bindingNotNull === 0 &&
        nullBindingAccepted);
    const legacyNamesPreserved =
      prepared.kind !== "legacy-names" ||
      JSON.stringify(legacyNames) === JSON.stringify(expectedIds);
    const ok =
      health.healthy &&
      sentinelPreserved &&
      markerIdsCorrect &&
      pendingChange &&
      legacyNamesPreserved &&
      (prepared.kind === "legacy-names" || previousMarkersPreserved);
    return Response.json(
      {
        afterMarkers: after,
        beforeBindingNotNull: prepared.bindingNotNull,
        beforeMarkers: prepared.markers,
        bindingNotNull,
        expectedIds,
        health,
        instanceChanged: true,
        kind: prepared.kind,
        legacyNamesPreserved,
        markerIdsCorrect,
        nullBindingAccepted,
        ok,
        previousMarkersPreserved,
        sentinelPreserved,
      },
      { status: ok ? 200 : 500 }
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname.endsWith("/prepare")) {
        const kind = url.searchParams.get("case");
        if (
          kind !== "current" &&
          kind !== "pending" &&
          kind !== "legacy-names"
        ) {
          return Response.json(
            { error: "Unknown migration fixture", ok: false },
            { status: 400 }
          );
        }
        return await this.prepare(kind);
      }
      if (request.method === "GET" && url.pathname.endsWith("/verify")) {
        return await this.verify();
      }
      return Response.json(
        { error: "Unknown migration route", ok: false },
        { status: 404 }
      );
    } catch {
      return Response.json(
        { error: "Migration fixture failed", ok: false },
        { status: 500 }
      );
    }
  }
}
