import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { z } from "zod";

const script = path.resolve(import.meta.dirname, "../../deploy/queues.mjs");
const password = "fixture-minio-credential-$()-`-123456789";
const fleet = [
  "--bucket",
  "s3://cerebro-runtime",
  "--endpoint",
  "http://minio-runtime:9000",
  "--region",
  "us-east-1",
  "--json",
];
const recordedSchema = z.object({
  args: z.array(z.string()),
  accessKey: z.string(),
  region: z.string(),
  secretKey: z.string(),
  sessionToken: z.null(),
});
const setup = async (context: TestContext) => {
  const directory = await mkdtemp(path.join(tmpdir(), "cerebro-queue-ops-"));
  context.after(() => rm(directory, { force: true, recursive: true }));
  const bin = path.join(directory, "bin");
  const secrets = path.join(directory, "credentials with spaces");
  const record = path.join(directory, "invocation.json");
  await Promise.all([mkdir(bin), mkdir(secrets)]);
  await Promise.all([
    writeFile(path.join(secrets, "minio-password"), `\n${password}\n`, {
      mode: 0o600,
    }),
    writeFile(
      path.join(bin, "celld"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        "const secret = process.env.AWS_SECRET_ACCESS_KEY;",
        "fs.writeFileSync(process.env.QUEUE_TEST_RECORD, JSON.stringify({",
        "  args,",
        "  accessKey: process.env.AWS_ACCESS_KEY_ID,",
        "  region: process.env.AWS_REGION,",
        "  secretKey: secret,",
        "  sessionToken: process.env.AWS_SESSION_TOKEN ?? null,",
        "}), {mode: 0o600});",
        'process.stdout.write(JSON.stringify({operation: args[1], credential: secret}) + "\\n");',
        'process.stderr.write("diagnostic credential=" + secret + "\\n");',
        "process.exitCode = Number(process.env.QUEUE_TEST_STATUS);",
        "",
      ].join("\n"),
      { mode: 0o700 }
    ),
  ]);
  return {
    bin,
    record,
    secrets,
    recorded: async () =>
      recordedSchema.parse(JSON.parse(await readFile(record, "utf-8"))),
    run: (args: readonly string[], overrides: NodeJS.ProcessEnv = {}) => {
      const result = spawnSync(process.execPath, [script, ...args], {
        encoding: "utf-8",
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: "stale-access-key",
          AWS_REGION: "stale-region",
          AWS_SECRET_ACCESS_KEY: "stale-secret-key",
          AWS_SESSION_TOKEN: "stale-session-token",
          CEREBRO_SECRETS_DIR: secrets,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          QUEUE_TEST_RECORD: record,
          QUEUE_TEST_STATUS: "0",
          ...overrides,
        },
        timeout: 5000,
      });
      assert.equal(result.error, undefined);
      return result;
    },
  };
};

const cases = [
  {
    input: ["info", "cerebro-team-reports"],
    expected: ["queue", "info", "cerebro-team-reports"],
  },
  {
    input: ["peek", "cerebro-team-reports-dead-letter", "--limit", "1"],
    expected: [
      "queue",
      "peek",
      "cerebro-team-reports-dead-letter",
      "--limit",
      "1",
    ],
  },
  {
    input: ["redrive", "cerebro-team-reports-dead-letter", "--limit", "1"],
    expected: [
      "queue",
      "redrive",
      "cerebro-team-reports-dead-letter",
      "--limit",
      "1",
    ],
  },

  {
    input: ["info", "cerebro-slack-events"],
    expected: ["queue", "info", "cerebro-slack-events"],
  },
  {
    input: ["info", "cerebro-slack-events-dead-letter"],
    expected: ["queue", "info", "cerebro-slack-events-dead-letter"],
  },
  {
    input: ["info", "cerebro-team-commands"],
    expected: ["queue", "info", "cerebro-team-commands"],
  },
  {
    input: ["info", "cerebro-team-commands-dead-letter"],
    expected: ["queue", "info", "cerebro-team-commands-dead-letter"],
  },
  {
    input: ["peek", "cerebro-slack-events"],
    expected: ["queue", "peek", "cerebro-slack-events", "--limit", "10"],
  },
  {
    input: ["peek", "cerebro-team-commands-dead-letter", "--limit", "100"],
    expected: [
      "queue",
      "peek",
      "cerebro-team-commands-dead-letter",
      "--limit",
      "100",
    ],
  },
  {
    input: ["redrive", "cerebro-slack-events-dead-letter", "--limit", "1"],
    expected: [
      "queue",
      "redrive",
      "cerebro-slack-events-dead-letter",
      "--limit",
      "1",
    ],
  },
  {
    input: ["redrive", "cerebro-team-commands-dead-letter", "--limit", "100"],
    expected: [
      "queue",
      "redrive",
      "cerebro-team-commands-dead-letter",
      "--limit",
      "100",
    ],
  },
];

for (const value of cases) {
  test(`the queue wrapper forwards ${value.input.join(" ")} with private fleet credentials`, async (context) => {
    const fixture = await setup(context);
    const result = fixture.run(value.input);
    assert.equal(result.status, 0);
    assert.deepEqual(await fixture.recorded(), {
      args: [...value.expected, ...fleet],
      accessKey: "cerebro",
      region: "us-east-1",
      secretKey: password,
      sessionToken: null,
    });
    assert.deepEqual(JSON.parse(result.stdout), {
      operation: value.input[0],
      credential: "[secret removed]",
    });
    assert.equal(result.stderr, "diagnostic credential=[secret removed]\n");
    assert.equal(result.stdout.includes(password), false);
    assert.equal(result.stderr.includes(password), false);
  });
}

test("invalid commands, targets and limits fail before credential access or celld execution", async (context) => {
  const fixture = await setup(context);
  const invalid = [
    [],
    ["purge", "cerebro-slack-events"],
    ["pause", "cerebro-slack-events"],
    ["resume", "cerebro-slack-events"],
    ["info", "other-fleet-queue"],
    ["info", "cerebro-unknown-reports"],
    ["info", "cerebro-slack-events", "--bucket", "another-bucket"],
    ["info", "cerebro-slack-events", "--limit", "1"],
    ["redrive", "cerebro-slack-events", "--limit", "1"],
    ["redrive", "cerebro-slack-events-dead-letter"],
    ["peek", "cerebro-slack-events", "--limit", "0"],
    ["peek", "cerebro-slack-events", "--limit", "101"],
    ["peek", "cerebro-slack-events", "--limit", "-1"],
    ["peek", "cerebro-slack-events", "--limit", "1.5"],
    ["peek", "cerebro-slack-events", "--limit", "01"],
    ["peek", "cerebro-slack-events", "--limit", "NaN"],
    ["peek", "cerebro-slack-events", "--limit", "1", "--limit", "2"],
    ["info", "cerebro-slack-events; echo unwanted"],
  ];
  for (const args of invalid) {
    const result = fixture.run(args, {
      CEREBRO_SECRETS_DIR: path.join(fixture.secrets, "missing"),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Use info QUEUE, peek QUEUE/u);
  }
  await assert.rejects(access(fixture.record), { code: "ENOENT" });
});

test("the wrapper preserves native failures and redacts their credential output", async (context) => {
  const fixture = await setup(context);
  const result = fixture.run(
    ["redrive", "cerebro-slack-events-dead-letter", "--limit", "1"],
    { QUEUE_TEST_STATUS: "17" }
  );
  assert.equal(result.status, 17);
  assert.equal(result.stdout.includes(password), false);
  assert.equal(result.stderr, "diagnostic credential=[secret removed]\n");
  assert.deepEqual(JSON.parse(result.stdout), {
    operation: "redrive",
    credential: "[secret removed]",
  });
  const recorded = await fixture.recorded();
  assert.deepEqual(recorded.args, [
    "queue",
    "redrive",
    "cerebro-slack-events-dead-letter",
    "--limit",
    "1",
    ...fleet,
  ]);
});

test("missing fleet credentials and a missing celld executable fail without a native call", async (context) => {
  const fixture = await setup(context);
  const missingSecret = fixture.run(["info", "cerebro-slack-events"], {
    CEREBRO_SECRETS_DIR: path.join(fixture.secrets, "missing"),
  });
  assert.equal(missingSecret.status, 1);
  assert.equal(missingSecret.stdout, "");
  assert.equal(
    missingSecret.stderr,
    "Could not read valid fleet credentials.\n"
  );
  await writeFile(path.join(fixture.secrets, "minio-password"), "short");
  const shortSecret = fixture.run(["info", "cerebro-slack-events"]);
  assert.equal(shortSecret.status, 1);
  assert.equal(shortSecret.stderr, "Could not read valid fleet credentials.\n");
  await writeFile(
    path.join(fixture.secrets, "minio-password"),
    `${password}\0`
  );
  const invalidSecret = fixture.run(["info", "cerebro-slack-events"]);
  assert.equal(invalidSecret.status, 1);
  assert.equal(
    invalidSecret.stderr,
    "Could not read valid fleet credentials.\n"
  );
  await writeFile(path.join(fixture.secrets, "minio-password"), password);
  await rm(path.join(fixture.bin, "celld"));
  const missingBinary = fixture.run(["info", "cerebro-slack-events"], {
    PATH: fixture.bin,
  });
  assert.equal(missingBinary.status, 1);
  assert.equal(missingBinary.stdout, "");
  assert.equal(
    missingBinary.stderr,
    "The celld queue command did not complete.\n"
  );
  await assert.rejects(access(fixture.record), { code: "ENOENT" });
});

test("JSON-encoded quotes and backslashes cannot disclose the fleet credential", async (context) => {
  const fixture = await setup(context);
  const complex = String.raw`fixture-"quoted"-\backslash\-credential-123456789`;
  await writeFile(path.join(fixture.secrets, "minio-password"), complex);
  const result = fixture.run(["info", "cerebro-team-reports"]);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    operation: "info",
    credential: "[secret removed]",
  });
  assert.equal(result.stderr, "diagnostic credential=[secret removed]\n");
  const saved = await fixture.recorded();
  assert.equal(saved.secretKey, complex);
});
