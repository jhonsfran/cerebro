/* oxlint-disable no-await-in-loop -- Pinned packages are hash checked before each patch is written. */
import { deepStrictEqual, equal } from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = fileURLToPath(new URL("../node_modules/.pnpm/", import.meta.url));
const entries = await readdir(root);
const matches = entries.filter((entry) =>
  entry.startsWith("@better-auth+utils@0.4.2")
);
equal(matches.length, 1, "Expected one pinned Better Auth utility package");
const packagePath = path.join(
  root,
  matches[0],
  "node_modules/@better-auth/utils/package.json"
);
const manifest = JSON.parse(await readFile(packagePath, "utf-8"));
equal(manifest.name, "@better-auth/utils");
equal(manifest.version, "0.4.2");

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
if (!isDeepStrictEqual(currentExport, patchedExport)) {
  deepStrictEqual(currentExport, originalExport, "Unexpected password export");
  await Promise.all(
    Object.values(javascriptImplementation).map((relativePath) =>
      readFile(path.join(path.dirname(packagePath), relativePath))
    )
  );
  manifest.exports["./password"] = patchedExport;
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
}
process.stdout.write("Verified Better Auth workerd password export\n");

const coreMatches = entries.filter((entry) =>
  entry.startsWith("@opencode-ai+core@0.0.0-dev-18697")
);
equal(
  coreMatches.length > 0,
  true,
  "Expected installed pinned OpenCode core packages"
);
for (const coreEntry of coreMatches) {
  const corePackagePath = new URL(
    `file://${path.join(root, coreEntry, "node_modules/@opencode-ai/core/package.json")}`
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
  const migrationSource = await readFile(migrationPath, "utf-8");
  const migrationHash = createHash("sha256")
    .update(migrationSource)
    .digest("hex");
  const originalMigrationHash =
    "35dbf314aa1037ff64b37d0b41333b5eb5113fb0031bc3f093ef050b35983466";
  const patchedMigrationHash =
    "1b507d14bae45959877de20936cd6698e4fb3cb409ea261a71c14dd6f0674f70";

  if (migrationHash === patchedMigrationHash) {
    process.stdout.write(
      "@opencode-ai/core shared-storage census patch already applied\n"
    );
  } else {
    equal(
      migrationHash,
      originalMigrationHash,
      "Unexpected OpenCode migration source; refusing to patch"
    );
    const originalCensus =
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_'";
    const sharedTables = [
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
}
