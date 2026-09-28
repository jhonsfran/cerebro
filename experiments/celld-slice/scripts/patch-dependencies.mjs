import { deepStrictEqual, equal } from "node:assert/strict";
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
