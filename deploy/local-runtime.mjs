// Writes the local runtime.json from the model settings in .env.
// Without CEREBRO_MODEL it leaves an existing runtime.json unchanged.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const secret = async (directory, name) => {
  const value = await readFile(path.join(directory, name), "utf-8");
  return value.trim();
};

export const writeLocalRuntime = async (directory, environment) => {
  const selected = environment.CEREBRO_MODEL?.trim();
  if (!selected) {
    process.stdout.write(
      "CEREBRO_MODEL is not set; keeping the existing runtime.json\n"
    );
    return;
  }
  const separator = selected.indexOf("/");
  if (separator < 1 || separator === selected.length - 1) {
    throw new Error("CEREBRO_MODEL must look like provider/model");
  }
  const baseUrl = environment.CEREBRO_MODEL_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error("CEREBRO_MODEL_BASE_URL is required with CEREBRO_MODEL");
  }
  const minioPassword = await secret(directory, "minio-password");
  const configuration = {
    artifacts: {
      accessKeyId: "cerebro",
      bucket: "cerebro-artifacts",
      endpoint: "http://minio-artifacts:9000",
      region: "us-east-1",
      secretAccessKey: minioPassword,
    },
    bootstrapToken: await secret(directory, "bootstrap-token"),
    gatewaySigningKey: await secret(directory, "gateway-signing-key"),
    mode: "local",
    models: [
      {
        // A local model server such as Ollama needs no key.
        apiKey: environment.CEREBRO_MODEL_API_KEY?.trim() || "local",
        baseUrl,
        deadlineMs: 90_000,
        id: selected,
        maxInputBytes: 131_072,
        // Reasoning models, such as GPT-6 Luna, spend part of this on reasoning.
        maxOutputTokens: 16_384,
        maxResponseBytes: 1_048_576,
        model: selected.slice(separator + 1),
        provider: selected.slice(0, separator),
      },
    ],
    retrievalMode: "full-text",
    tools: [],
  };
  const file = path.join(directory, "runtime.json");
  await writeFile(`${file}.tmp`, JSON.stringify(configuration), {
    mode: 0o600,
  });
  await rename(`${file}.tmp`, file);
  process.stdout.write(`Local runtime.json uses ${selected}\n`);
};
