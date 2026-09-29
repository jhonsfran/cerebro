export interface SdkToolCall {
  readonly messageId: string;
  readonly callId: string;
}

export const sdkCallKey = (call: SdkToolCall): string =>
  JSON.stringify([call.messageId, call.callId]);

export interface InvocationCallBinding {
  readonly sdkCallIds: readonly string[];
  readonly boundModelAttemptId: string;
}

export const priorInvocationForCall = <
  Invocation extends InvocationCallBinding,
>(
  candidates: readonly Invocation[],
  callKey: string,
  modelAttemptId: string,
  completedCallKeys: ReadonlySet<string>
): Invocation | undefined => {
  const exact = candidates.find((candidate) =>
    candidate.sdkCallIds.includes(callKey)
  );
  if (exact) {
    return exact;
  }
  return candidates.find(
    (candidate) =>
      candidate.boundModelAttemptId !== modelAttemptId &&
      candidate.sdkCallIds.every((key) => !completedCallKeys.has(key))
  );
};
