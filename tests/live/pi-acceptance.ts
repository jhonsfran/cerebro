import { setTimeout as delay } from "node:timers/promises";

import { Schema } from "effect";
import { z } from "zod";

import {
  ChatReceipt,
  ChatSnapshot,
} from "../../packages/contracts/src/session-service.ts";

export const decodeLiveReceipt = (value: unknown): ChatReceipt => {
  try {
    const body = z.object({ receipt: z.unknown() }).parse(value);
    return Schema.decodeUnknownSync(ChatReceipt)(body.receipt);
  } catch {
    throw new Error(
      "The live receipt does not match the native chat contract."
    );
  }
};

export const decodeLiveSnapshot = (value: unknown): ChatSnapshot => {
  try {
    const body = z.object({ snapshot: z.unknown() }).parse(value);
    return Schema.decodeUnknownSync(ChatSnapshot)(body.snapshot);
  } catch {
    throw new Error(
      "The live snapshot does not match the native chat contract."
    );
  }
};

interface LiveReadOptions {
  readonly read: () => Promise<unknown>;
  readonly agentId: string;
  readonly conversationId: string;
  readonly prompt: string;
  readonly toolId: string;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}
const checkExpectedWork = (
  snapshot: ChatSnapshot,
  input: LiveReadOptions
): void => {
  if (
    snapshot.address.agentId !== input.agentId ||
    snapshot.address.conversationId !== input.conversationId
  ) {
    throw new Error("The live snapshot belongs to another conversation.");
  }
  if (
    snapshot.tools.length > 1 ||
    snapshot.tools.some((tool) => tool.toolName !== input.toolId) ||
    snapshot.approvals.some((approval) => approval.state === "pending") ||
    (snapshot.activity?.children.length ?? 0) > 0 ||
    (snapshot.activity?.reminders.length ?? 0) > 0
  ) {
    throw new Error(
      "The live input requested work beyond its single MCP read."
    );
  }
  const [execution] = snapshot.tools;
  if (execution?.state === "failed" || execution?.state === "interrupted") {
    throw new Error("The live MCP read did not succeed.");
  }
};
const completedRead = (snapshot: ChatSnapshot, prompt: string) => {
  const answerIndex = snapshot.messages.findLastIndex(
    (message) =>
      message.role === "assistant" &&
      message.state === "complete" &&
      message.text.trim().length > 0
  );
  const answer = snapshot.messages[answerIndex];
  if (snapshot.busy || snapshot.queuedInputs.length > 0 || !answer) {
    return;
  }
  const [execution] = snapshot.tools;
  if (!execution) {
    throw new Error("The live model answered without the required MCP read.");
  }
  const resultIndex = snapshot.messages.findIndex(
    (message) => message.id === execution.resultMessageId
  );
  if (
    execution.state !== "succeeded" ||
    resultIndex === -1 ||
    answerIndex <= resultIndex
  ) {
    return;
  }
  const users = snapshot.messages.filter((message) => message.role === "user");
  if (users.length !== 1 || users[0]?.text !== prompt) {
    throw new Error("The live input was not represented exactly once.");
  }
  return { answer, execution, snapshot };
};

export const waitForLiveRead = async (input: LiveReadOptions) => {
  const deadlineAt = Date.now() + (input.timeoutMs ?? 120_000);
  while (Date.now() < deadlineAt) {
    // oxlint-disable-next-line no-await-in-loop -- Each snapshot observes the next durable state of this input.
    const snapshot = decodeLiveSnapshot(await input.read());
    checkExpectedWork(snapshot, input);
    const result = completedRead(snapshot, input.prompt);
    if (result) {
      return result;
    }
    // oxlint-disable-next-line no-await-in-loop -- Wait before observing the next native state.
    await delay(input.pollMs ?? 250);
  }
  throw new Error(
    "The live MCP read did not produce a complete answer before its deadline."
  );
};
