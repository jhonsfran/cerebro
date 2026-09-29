import { deepStrictEqual, equal } from "node:assert/strict";
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
