/* oxlint-disable no-await-in-loop -- Each source variant rewrites and verifies the same isolated fixture. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

const originalCensus =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_'";
const censusPattern =
  /SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr\(name, 1, 1\) <> '_'[^`]*/u;
const originalHash =
  "35dbf314aa1037ff64b37d0b41333b5eb5113fb0031bc3f093ef050b35983466";
const patchedHash =
  "2c82a6a7862cbc4a5680ed48195aec64886a61ec6f09854fda018076c261b6d1";
const previousTables = [
  "cf_agent_tool_runs",
  "cf_agents_facet_runs",
  "cf_agents_fibers",
  "cf_agents_jobs",
  "cf_agents_mcp_servers",
  "cf_agents_runs",
  "cf_agents_state",
  "cf_agents_task_runs",
  "cf_agents_task_steps",
  "cf_agents_workflows",
  "cerebro_session",
  "cerebro_operation",
];
const sdkTables = [
  ...previousTables,
  "cf_agents_chat_progress",
  "cf_agents_session_attachment_chunks",
  "cf_agents_session_attachment_meta",
  "cf_agents_session_attachment_refs",
  "cf_agents_session_compactions",
  "cf_agents_session_config",
  "cf_agents_session_message_chunks",
  "cf_agents_session_messages",
  "cf_agents_stream_blocks",
  "cf_agents_streams",
  "cf_ai_chat_agent_messages",
  "cf_ai_chat_agent_tool_milestones",
  "cf_ai_chat_agent_tool_runs",
  "cf_ai_chat_request_context",
];
const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");

const originalMigration = async (): Promise<string> => {
  const installed = await readdir(
    new URL("../../node_modules/.pnpm/", import.meta.url)
  );
  const core = installed.find((entry) =>
    entry.startsWith("@opencode-ai+core@0.0.0-dev-18697")
  );
  assert.ok(core);
  const source = await readFile(
    new URL(
      `../../node_modules/.pnpm/${core}/node_modules/@opencode-ai/core/dist/chunks/file-mutation-vp77fm2w.js`,
      import.meta.url
    ),
    "utf-8"
  );
  const original = source.replace(censusPattern, originalCensus);
  assert.equal(hash(original), originalHash);
  return original;
};

const patchFixture = async (kind: "deploy" | "runtime", source: string) => {
  const root = await mkdtemp(path.join(tmpdir(), "cerebro-census-"));
  const scriptPath = path.join(
    root,
    kind === "deploy"
      ? "deploy/patch-dependencies.mjs"
      : "scripts/patch-dependencies.mjs"
  );
  const nodeModules = path.join(root, "node_modules");
  const betterAuth =
    kind === "deploy"
      ? path.join(
          nodeModules,
          ".pnpm/@better-auth+utils@0.4.2/node_modules/@better-auth/utils"
        )
      : path.join(nodeModules, "@better-auth/utils");
  const core =
    kind === "deploy"
      ? path.join(
          nodeModules,
          ".pnpm/@opencode-ai+core@0.0.0-dev-18697/node_modules/@opencode-ai/core"
        )
      : path.join(nodeModules, "@opencode-ai/core");
  const migrationPath = path.join(
    core,
    "dist/chunks/file-mutation-vp77fm2w.js"
  );
  await Promise.all([
    mkdir(path.dirname(scriptPath), { recursive: true }),
    mkdir(betterAuth, { recursive: true }),
    mkdir(path.dirname(migrationPath), { recursive: true }),
  ]);
  const javascript = {
    import: "./dist/password.mjs",
    require: "./dist/password.cjs",
  };
  await Promise.all([
    writeFile(
      scriptPath,
      await readFile(
        new URL(
          kind === "deploy"
            ? "../../deploy/patch-dependencies.mjs"
            : "../runtime/scripts/patch-dependencies.mjs",
          import.meta.url
        )
      )
    ),
    writeFile(
      path.join(betterAuth, "package.json"),
      JSON.stringify({
        exports: {
          "./password": {
            node: {
              import: "./dist/password.node.mjs",
              require: "./dist/password.node.cjs",
            },
            workerd: javascript,
            ...javascript,
          },
        },
        name: "@better-auth/utils",
        version: "0.4.2",
      })
    ),
    writeFile(
      path.join(core, "package.json"),
      JSON.stringify({ name: "@opencode-ai/core", version: "0.0.0-dev-18697" })
    ),
    writeFile(migrationPath, source),
  ]);
  return { migrationPath, root, scriptPath };
};

for (const kind of ["deploy", "runtime"] as const) {
  test(`${kind} patch supports fresh AIChatAgent storage, upgrades its prior patch, and rejects unknown source`, async () => {
    const original = await originalMigration();
    const fixture = await patchFixture(kind, original);
    try {
      const run = () =>
        spawnSync(process.execPath, [fixture.scriptPath], {
          encoding: "utf-8",
        });
      let patched = "";
      const previousCensus = `${originalCensus} AND name NOT IN (${previousTables.map((name) => `'${name}'`).join(", ")})`;
      for (const source of [
        original,
        original.replace(originalCensus, previousCensus),
      ]) {
        await writeFile(fixture.migrationPath, source);
        const result = run();
        assert.equal(result.status, 0, result.stderr);
        patched = await readFile(fixture.migrationPath, "utf-8");
        assert.equal(hash(patched), patchedHash);
      }
      assert.equal(run().status, 0);
      assert.equal(await readFile(fixture.migrationPath, "utf-8"), patched);
      const census = patched.match(censusPattern)?.[0];
      assert.ok(census);
      const db = new DatabaseSync(":memory:");
      try {
        for (const table of sdkTables) {
          db.exec(`CREATE TABLE ${table} (id TEXT)`);
        }
        db.exec(
          "CREATE VIRTUAL TABLE cf_agents_session_fts USING fts5(content)"
        );
        assert.deepEqual(db.prepare(census).all(), []);
        db.exec("CREATE TABLE unknown_foreign_table (id TEXT)");
        assert.deepEqual(
          db
            .prepare(census)
            .all()
            .map((row) => row.name),
          ["unknown_foreign_table"]
        );
        db.exec(
          "DROP TABLE unknown_foreign_table; CREATE TABLE session_v2 (id TEXT)"
        );
        assert.deepEqual(
          db
            .prepare(census)
            .all()
            .map((row) => row.name),
          ["session_v2"]
        );
      } finally {
        db.close();
      }
      const tampered = `${original}\n// unexpected source\n`;
      await writeFile(fixture.migrationPath, tampered);
      const rejected = run();
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, /Unexpected OpenCode migration source/u);
      assert.equal(await readFile(fixture.migrationPath, "utf-8"), tampered);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
}
