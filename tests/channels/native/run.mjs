import { spawnSync } from "node:child_process";

for (const file of ["product.test.ts", "recovery.test.ts"]) {
  const result = spawnSync(
    "bun",
    ["test", "--timeout", "360000", `tests/channels/native/${file}`],
    { stdio: "inherit" }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
