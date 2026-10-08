import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const writeAtomic = async (filename, value) => {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    flush: true,
    mode: 0o600,
  });
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

export const saveRecord = async (filename, record) =>
  await writeAtomic(filename, {
    record,
    schemaVersion: 1,
    sha256: createHash("sha256").update(JSON.stringify(record)).digest("hex"),
  });

export const loadRecord = async (filename) => {
  const value = JSON.parse(await readFile(filename, "utf-8"));
  if (
    value.schemaVersion !== 1 ||
    !value.record ||
    createHash("sha256").update(JSON.stringify(value.record)).digest("hex") !==
      value.sha256
  ) {
    throw new Error("Retirement record checksum mismatch.");
  }
  return value.record;
};
