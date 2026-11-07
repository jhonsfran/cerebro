import { randomUUID } from "node:crypto";
import { open, rename, writeFile } from "node:fs/promises";
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
