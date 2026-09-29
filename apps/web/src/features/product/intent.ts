export interface OperationIntent {
  readonly canonicalInput: string;
  readonly operationId: string;
}

const canonicalInput = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalInput).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(
      ([, item]) => item !== undefined
    );
    // eslint-disable-next-line unicorn/no-array-sort -- The configured browser library predates toSorted; entries is a new array.
    entries.sort(([first], [second]) => first.localeCompare(second));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalInput(item)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("An operation needs JSON input.");
  }
  return serialized;
};

export const operationFor = (
  reference: { current: OperationIntent | null },
  input: unknown
): string => {
  const canonical = canonicalInput(input);
  if (!reference.current || reference.current.canonicalInput !== canonical) {
    reference.current = {
      canonicalInput: canonical,
      operationId: crypto.randomUUID(),
    };
  }
  return reference.current.operationId;
};
