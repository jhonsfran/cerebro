import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const directory = process.env.CEREBRO_SECRETS_DIR ?? "/run/cerebro-secrets";
const mode = process.env.DEPLOY_MODE ?? "local";
const names = [
  "postgres-password",
  "minio-password",
  "auth-secret",
  ...(mode === "local" ? ["bootstrap-token"] : []),
];

const writeSecret = async (secretPath, value) => {
  const temporaryPath = `${secretPath}.tmp`;
  await writeFile(temporaryPath, value, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, secretPath);
};

if (!["local", "production"].includes(mode)) {
  throw new Error("Invalid deployment mode");
}
await mkdir(directory, { mode: 0o700, recursive: true });
await Promise.all(
  names.map(async (name) => {
    const secretPath = path.join(directory, name);
    if (mode === "production") {
      const contents = await readFile(secretPath, "utf-8");
      if (contents.trim().length < 32) {
        throw new Error(`Production secret ${name} is too short`);
      }
      return;
    }
    try {
      const contents = await readFile(secretPath, "utf-8");
      if (contents.trim().length >= 32) {
        return;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await writeSecret(secretPath, randomBytes(36).toString("base64url"));
  })
);
if (mode !== "production") {
  await Promise.all(
    [
      ["postgres-password", "/run/postgres-credential"],
      ["minio-password", "/run/minio-credential"],
    ].map(async ([name, outputDirectory]) => {
      await mkdir(outputDirectory, { mode: 0o700, recursive: true });
      const value = await readFile(path.join(directory, name), "utf-8");
      await writeSecret(path.join(outputDirectory, name), value);
    })
  );
}
process.stdout.write("Cerebro secrets are ready\n");
