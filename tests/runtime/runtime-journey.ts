import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { EventAddress } from "../../packages/contracts/src/events.ts";
import type { ChatSnapshot } from "../../packages/contracts/src/session-service.ts";
import {
  boot,
  compose,
  control,
  evidence,
  lifecycle,
  newStack,
  provider,
  request,
  waitFor,
} from "./helpers.ts";
import type { Stack } from "./helpers.ts";

export const answer = "Cerebro slice 1 completed.";
export const completed = (snapshot: ChatSnapshot): boolean =>
  !snapshot.busy &&
  snapshot.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.state === "complete" &&
      message.text === answer
  );
export const writeCount = async (
  stack: Stack,
  operationId: string
): Promise<number> => {
  const value = await provider(stack);
  return value.tools.filter(
    (tool) => tool.operationId === operationId && tool.write
  ).length;
};
export const authorityCalls = async (
  stack: Stack,
  address: EventAddress,
  failNextToolCheck?: boolean
): Promise<number> => {
  const value = await request(stack, "/runtime/fixture/authority", {
    address,
    failNextToolCheck,
  });
  assert.ok(value && typeof value === "object" && "calls" in value);
  return Number(value.calls);
};
export const restart = (stack: Stack): void => {
  compose(stack, ["kill", "-s", "SIGKILL", "celld"]);
  compose(stack, ["up", "-d", "--wait", "celld"]);
};
export const waitForQuiet = (stack: Stack, address: EventAddress) =>
  waitFor(
    () => lifecycle(stack, address),
    (value) =>
      value.alarmAt === null &&
      value.jobs.length === 0 &&
      value.pending.length === 0
  );

export const userTexts = (snapshot: ChatSnapshot) =>
  snapshot.messages
    .filter((message) => message.role === "user")
    .map((message) => message.text);
export const runtimeJourney = (suite: string) => {
  let stack: Stack;
  let failed = false;
  before(
    async () => {
      stack = await newStack(suite);
      boot(stack);
    },
    { timeout: 600_000 }
  );
  after(
    async () => {
      if (failed) {
        await evidence(stack, "failure", {
          logs: compose(stack, [
            "logs",
            "--no-color",
            "--tail=150",
            "celld",
            "bootstrap",
          ]),
          provider: await provider(stack),
        });
      }
      compose(stack, ["down", "-v"]);
    },
    { timeout: 120_000 }
  );
  return (name: string, run: (stack: Stack) => Promise<void>) =>
    test(name, { timeout: 180_000 }, async () => {
      try {
        await control(stack, {
          arm: null,
          delayMs: 0,
          failFirst: false,
          release: true,
        });
        await run(stack);
      } catch (error) {
        failed = true;
        throw error;
      }
    });
};
