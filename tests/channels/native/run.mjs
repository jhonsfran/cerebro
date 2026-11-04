import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  applicationFixture,
  bootApplication,
  initializeFixtureAgent,
} from "../../slice-1/application.ts";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../../..");
const revision = await execute("rtk", ["proxy", "git", "rev-parse", "HEAD"], {
  cwd: root,
});
const status = await execute(
  "rtk",
  [
    "proxy",
    "git",
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude)artifacts/**",
  ],
  { cwd: root }
);
const listed = await execute(
  "rtk",
  ["proxy", "git", "ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: root }
);
const hash = createHash("sha256");
const files = [...new Set(listed.stdout.trim().split("\n"))]
  .filter((entry) => !entry.startsWith("artifacts/"))
  .toSorted();
const contents = await Promise.all(
  files.map(async (file) => {
    try {
      const metadata = await lstat(path.join(root, file));
      if (metadata.isSymbolicLink()) {
        return `symlink:${await readlink(path.join(root, file))}`;
      }
      return await readFile(path.join(root, file));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return "<deleted>";
    }
  })
);
for (const [index, file] of files.entries()) {
  hash.update(`${file}\n`);
  hash.update(contents[index]);
}
const sourceIdentity = `${revision.stdout.trim()}:sha256:${hash.digest("hex")}`;
const sourceCheckoutDirty = Boolean(status.stdout.trim());
const available = ["web-coordinator", "product", "slack-events", "coordinator"];
const selected = process.argv.slice(2);
assert.ok(
  selected.every((name) => available.includes(name)),
  "Unknown native test group."
);
const groups = selected.length > 0 ? selected : available;
const boot = await bootApplication("channels-native");
const fixture = applicationFixture(boot);
const owner = await fixture.signup("Native channel owner");
const agent = await initializeFixtureAgent(fixture, owner);
const directory = path.join(
  root,
  "artifacts/slice-1",
  boot.sha,
  boot.fixtureId
);
const metadataPath = path.join(directory, "channel-native.json");
await writeFile(
  metadataPath,
  `${JSON.stringify({ agent, bootPath: path.join(directory, "boot.json"), owner: { cookie: owner.cookie, userId: owner.userId }, sourceCheckoutDirty, sourceIdentity }, null, 2)}\n`,
  { mode: 0o600 }
);
let passed = false;
const runGroup = async (name) => {
  const child = spawn(
    "rtk",
    [
      "proxy",
      process.execPath,
      "--test",
      "--test-concurrency=1",
      ...(process.env.CHANNEL_NATIVE_TEST_PATTERN
        ? ["--test-name-pattern", process.env.CHANNEL_NATIVE_TEST_PATTERN]
        : []),
      `tests/channels/native/${name}.test.ts`,
    ],
    {
      cwd: root,
      env: { ...process.env, CHANNEL_NATIVE_METADATA: metadataPath },
      stdio: "inherit",
    }
  );
  const [code] = await once(child, "exit");
  if (code !== 0) {
    process.exitCode = code ?? 1;
    return false;
  }
  return true;
};
try {
  const runRemaining = async ([name, ...remaining]) => {
    if (!name) {
      return true;
    }
    return (await runGroup(name)) && (await runRemaining(remaining));
  };
  passed = await runRemaining(groups);
  await writeFile(
    path.join(directory, "channel-native-result.json"),
    `${JSON.stringify({ fixtureId: boot.fixtureId, passed, sourceCheckoutDirty, sourceIdentity }, null, 2)}\n`
  );
} finally {
  if (passed) {
    await fixture.close();
  } else {
    process.stderr.write(
      `Failed owned channel stack retained: ${boot.fixtureId}\n`
    );
  }
}
