export const readBoundedJson = async (
  response: Response,
  maxBytes: number,
  signal?: AbortSignal
): Promise<unknown> => {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Provider response has no body.");
  }
  signal?.throwIfAborted();
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation = reader.cancel();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      // oxlint-disable-next-line no-await-in-loop -- Each read advances the bounded stream.
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > maxBytes) {
        // oxlint-disable-next-line no-await-in-loop -- Cancel the same stream before rejecting its oversized body.
        await reader.cancel();
        throw new Error("Provider response exceeds the byte limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    if (cancellation) {
      await cancellation;
    }
    reader.releaseLock();
  }
  signal?.throwIfAborted();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
  );
};

export const redactSecrets = (
  value: unknown,
  secrets: readonly string[]
): unknown => {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) {
      if (secret) {
        result = result.replaceAll(secret, "[redacted]");
      }
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactSecrets(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        String(redactSecrets(key, secrets)),
        redactSecrets(item, secrets),
      ])
    );
  }
  return value;
};
