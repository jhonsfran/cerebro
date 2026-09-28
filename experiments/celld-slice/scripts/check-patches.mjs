import {
  deepStrictEqual,
  equal,
  match,
  notEqual,
  ok,
} from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const experiment = new URL("../", import.meta.url);
const coreManifestPath = "node_modules/@opencode-ai/core/package.json";
const authManifestPath = "node_modules/@better-auth/utils/package.json";
const migrationPath =
  "node_modules/@opencode-ai/core/dist/chunks/file-mutation-vp77fm2w.js";
const originalHash =
  "35dbf314aa1037ff64b37d0b41333b5eb5113fb0031bc3f093ef050b35983466";
const patchedHash =
  "1b507d14bae45959877de20936cd6698e4fb3cb409ea261a71c14dd6f0674f70";
const digest = (source) => createHash("sha256").update(source).digest("hex");

await test("dependency patches preserve migration code and reject changed packages", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "cerebro-patch-check-"));
  t.after(async () => await rm(fixture, { force: true, recursive: true }));
  const fixtureWrite = async (relativePath, content) => {
    const target = path.join(fixture, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  const invoke = () => {
    const result = spawnSync(
      process.execPath,
      [path.join(fixture, "scripts/patch-dependencies.mjs")],
      {
        encoding: "utf-8",
        timeout: 10_000,
      }
    );
    equal(result.error, undefined);
    equal(result.signal, null);
    return result;
  };

  const evidence = JSON.parse(
    await readFile(
      new URL("evidence/06-fresh-project.json", experiment),
      "utf-8"
    )
  );
  const observedTables = evidence.results.find(
    (result) => result.id === "agent.base-storage"
  ).evidence.tables;
  const expectedTables = observedTables
    .map((table) => table.name)
    .filter((name) => !name.startsWith("_"));
  equal(expectedTables.length, 10);
  expectedTables.push("cerebro_session", "cerebro_operation");
  const originalCensus =
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_'";
  const expectedCensus = `${originalCensus} AND name NOT IN (${expectedTables.map((name) => `'${name}'`).join(", ")})`;
  const installedSource = await readFile(
    new URL(migrationPath, experiment),
    "utf-8"
  );
  const installedHash = digest(installedSource);
  ok(
    installedHash === originalHash || installedHash === patchedHash,
    "Installed core source must match a reviewed version"
  );
  const originalSource =
    installedHash === patchedHash
      ? installedSource.replace(expectedCensus, originalCensus)
      : installedSource;
  equal(digest(originalSource), originalHash);
  const coreManifest = JSON.parse(
    await readFile(new URL(coreManifestPath, experiment), "utf-8")
  );
  equal(coreManifest.version, "0.0.0-dev-18697");
  await fixtureWrite(coreManifestPath, JSON.stringify(coreManifest));
  await fixtureWrite(migrationPath, originalSource);

  const authManifest = JSON.parse(
    await readFile(new URL(authManifestPath, experiment), "utf-8")
  );
  equal(authManifest.version, "0.4.2");
  const nativePassword = {
    import: "./dist/password.node.mjs",
    require: "./dist/password.node.cjs",
  };
  const javascriptPassword = {
    import: "./dist/password.mjs",
    require: "./dist/password.cjs",
  };
  deepStrictEqual(authManifest.exports["./password"].node, nativePassword);
  authManifest.exports["./password"].workerd = nativePassword;
  await fixtureWrite(authManifestPath, JSON.stringify(authManifest));
  await Promise.all(
    ["password.mjs", "password.cjs"].map(async (file) => {
      const relativePath = `node_modules/@better-auth/utils/dist/${file}`;
      await fixtureWrite(
        relativePath,
        await readFile(new URL(relativePath, experiment))
      );
    })
  );
  await mkdir(path.join(fixture, "scripts"));
  await copyFile(
    new URL("scripts/patch-dependencies.mjs", experiment),
    path.join(fixture, "scripts/patch-dependencies.mjs")
  );

  const applied = invoke();
  equal(applied.status, 0, applied.stderr);
  const patchedSource = await readFile(
    path.join(fixture, migrationPath),
    "utf-8"
  );
  equal(digest(patchedSource), patchedHash);
  equal(
    patchedSource,
    originalSource.replace(originalCensus, expectedCensus),
    "Only the census query may change"
  );
  const patchedAuthSource = await readFile(
    path.join(fixture, authManifestPath),
    "utf-8"
  );
  const expectedAuth = structuredClone(authManifest);
  expectedAuth.exports["./password"].workerd = javascriptPassword;
  deepStrictEqual(
    JSON.parse(patchedAuthSource),
    expectedAuth,
    "Only the Better Auth workerd password export may change"
  );
  const repeated = invoke();
  equal(repeated.status, 0, repeated.stderr);
  equal(
    await readFile(path.join(fixture, migrationPath), "utf-8"),
    patchedSource
  );
  equal(
    await readFile(path.join(fixture, authManifestPath), "utf-8"),
    patchedAuthSource
  );

  await fixtureWrite(
    coreManifestPath,
    JSON.stringify({ ...coreManifest, version: "0.0.0-dev-18698" })
  );
  const wrongVersion = invoke();
  notEqual(wrongVersion.status, 0);
  match(
    wrongVersion.stderr,
    /Reassess the OpenCode shared-storage patch before upgrading/u
  );
  equal(
    await readFile(path.join(fixture, migrationPath), "utf-8"),
    patchedSource
  );
  await fixtureWrite(coreManifestPath, JSON.stringify(coreManifest));
  const verifyTamperRejection = async (source) => {
    const changed = `${source}\n// Unexpected dependency change\n`;
    await fixtureWrite(migrationPath, changed);
    const rejected = invoke();
    notEqual(rejected.status, 0);
    match(rejected.stderr, /Unexpected OpenCode migration source/u);
    equal(await readFile(path.join(fixture, migrationPath), "utf-8"), changed);
  };
  await verifyTamperRejection(originalSource);
  await verifyTamperRejection(patchedSource);
});
