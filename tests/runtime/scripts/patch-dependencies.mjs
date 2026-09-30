import { deepStrictEqual, equal } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

const packagePath = new URL(
  "../node_modules/@better-auth/utils/package.json",
  import.meta.url
);
const source = await readFile(packagePath, "utf-8");
const manifest = JSON.parse(source);
equal(
  manifest.name,
  "@better-auth/utils",
  "Unexpected password utility package"
);
equal(
  manifest.version,
  "0.4.2",
  "Reassess the celld password export patch before upgrading"
);

const nativeImplementation = {
  import: "./dist/password.node.mjs",
  require: "./dist/password.node.cjs",
};
const javascriptImplementation = {
  import: "./dist/password.mjs",
  require: "./dist/password.cjs",
};
const originalExport = {
  node: nativeImplementation,
  workerd: nativeImplementation,
  ...javascriptImplementation,
};
const patchedExport = {
  ...originalExport,
  workerd: javascriptImplementation,
};
const currentExport = manifest.exports?.["./password"];

if (isDeepStrictEqual(currentExport, patchedExport)) {
  process.stdout.write(
    "@better-auth/utils@0.4.2 celld password export patch already applied\n"
  );
} else {
  deepStrictEqual(
    currentExport,
    originalExport,
    "Unexpected password export; refusing to patch"
  );
  await Promise.all(
    Object.values(javascriptImplementation).map((path) =>
      readFile(new URL(path, packagePath))
    )
  );
  manifest.exports["./password"] = patchedExport;
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    "Applied @better-auth/utils@0.4.2 celld password export patch\n"
  );
}

const corePackagePath = new URL(
  "../node_modules/@opencode-ai/core/package.json",
  import.meta.url
);
const coreManifest = JSON.parse(await readFile(corePackagePath, "utf-8"));
equal(
  coreManifest.name,
  "@opencode-ai/core",
  "Unexpected OpenCode core package"
);
equal(
  coreManifest.version,
  "0.0.0-dev-18697",
  "Reassess the OpenCode shared-storage patch before upgrading"
);

const migrationPath = new URL(
  "dist/chunks/file-mutation-vp77fm2w.js",
  corePackagePath
);
let migrationSource = await readFile(migrationPath, "utf-8");
const migrationHash = createHash("sha256")
  .update(migrationSource)
  .digest("hex");
const originalMigrationHash =
  "35dbf314aa1037ff64b37d0b41333b5eb5113fb0031bc3f093ef050b35983466";
const patchedMigrationHash =
  "2c82a6a7862cbc4a5680ed48195aec64886a61ec6f09854fda018076c261b6d1";

if (migrationHash === patchedMigrationHash) {
  process.stdout.write(
    "@opencode-ai/core shared-storage census patch already applied\n"
  );
} else {
  const originalCensus =
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_'";
  if (
    migrationHash ===
    "1b507d14bae45959877de20936cd6698e4fb3cb409ea261a71c14dd6f0674f70"
  ) {
    const previousCensus =
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_' AND name NOT IN ('cf_agent_tool_runs', 'cf_agents_facet_runs', 'cf_agents_fibers', 'cf_agents_jobs', 'cf_agents_mcp_servers', 'cf_agents_runs', 'cf_agents_state', 'cf_agents_task_runs', 'cf_agents_task_steps', 'cf_agents_workflows', 'cerebro_session', 'cerebro_operation')";
    migrationSource = migrationSource.replace(previousCensus, originalCensus);
  }
  equal(
    createHash("sha256").update(migrationSource).digest("hex"),
    originalMigrationHash,
    "Unexpected OpenCode migration source; refusing to patch"
  );
  const sharedTables = [
    "cf_agent_tool_runs",
    "cf_agents_chat_progress",
    "cf_agents_facet_runs",
    "cf_agents_fibers",
    "cf_agents_jobs",
    "cf_agents_mcp_servers",
    "cf_agents_runs",
    "cf_agents_session_attachment_chunks",
    "cf_agents_session_attachment_meta",
    "cf_agents_session_attachment_refs",
    "cf_agents_session_compactions",
    "cf_agents_session_config",
    "cf_agents_session_fts",
    "cf_agents_session_fts_config",
    "cf_agents_session_fts_content",
    "cf_agents_session_fts_data",
    "cf_agents_session_fts_docsize",
    "cf_agents_session_fts_idx",
    "cf_agents_session_message_chunks",
    "cf_agents_session_messages",
    "cf_agents_state",
    "cf_agents_stream_blocks",
    "cf_agents_streams",
    "cf_agents_task_runs",
    "cf_agents_task_steps",
    "cf_agents_workflows",
    "cf_ai_chat_agent_messages",
    "cf_ai_chat_agent_tool_milestones",
    "cf_ai_chat_agent_tool_runs",
    "cf_ai_chat_request_context",
    "cerebro_session",
    "cerebro_operation",
  ];
  const patchedCensus = `${originalCensus} AND name NOT IN (${sharedTables.map((name) => `'${name}'`).join(", ")})`;
  const patchedMigration = migrationSource.replace(
    originalCensus,
    patchedCensus
  );
  equal(
    createHash("sha256").update(patchedMigration).digest("hex"),
    patchedMigrationHash,
    "OpenCode migration replacement did not match the reviewed patch"
  );
  await writeFile(migrationPath, patchedMigration);
  process.stdout.write(
    "Applied @opencode-ai/core shared-storage census patch\n"
  );
}
