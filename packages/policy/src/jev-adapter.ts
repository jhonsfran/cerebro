import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { TypeSafeClientConfig } from "@typesafe-ai/sdk";

import type {
  BudgetAmount,
  DecisionProposal,
  DecisionRequest,
} from "../../contracts/src/policy.ts";
import { preflightEffect } from "../../contracts/src/port.ts";
import type { EffectOptions } from "../../contracts/src/port.ts";
import { immutable } from "../../db/src/repositories/usage.ts";
import type { WorkOutcome } from "./authorization-gate.ts";

export interface BoundedDecisionProvider {
  readonly modelVersion: string;
  readonly maximum: BudgetAmount;
  readonly propose: (
    request: DecisionRequest,
    options: EffectOptions
  ) => Promise<WorkOutcome<DecisionProposal>>;
}
export interface JevConfiguration {
  readonly apiKey: string;
  readonly modelVersion: "jev-1.13.0";
  readonly currency: "USD";
  readonly minorUnit: string;
  readonly inputUsdPerMillion: 0.042;
  readonly outputUsdPerMillion: 0;
  readonly verifiedPricing: true;
  readonly fetch?: TypeSafeClientConfig["fetch"];
}
const MAXIMUM_INPUT_TOKENS = 65_536;
const MAXIMUM_SUMMARY_BYTES = 16_384;
const probability = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const requestBounded = (
  request: DecisionRequest,
  modelVersion: string
): boolean =>
  request.modelVersion === modelVersion &&
  new TextEncoder().encode(request.eventSummary).byteLength <=
    MAXIMUM_SUMMARY_BYTES &&
  request.allowedChoices.length >= 1 &&
  request.allowedChoices.length <= 3 &&
  new Set(request.allowedChoices).size === request.allowedChoices.length &&
  request.allowedChoices.every((choice) =>
    ["run", "clarify", "defer"].includes(choice)
  );
interface ResponseWithUsage {
  readonly model?: unknown;
  readonly answers?: unknown;
  readonly usage: {
    readonly input_tokens: number;
    readonly output_tokens: number;
  };
}
const tokenCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= MAXIMUM_INPUT_TOKENS;
const hasUsage = (response: unknown): response is ResponseWithUsage =>
  record(response) &&
  record(response.usage) &&
  tokenCount(response.usage.input_tokens) &&
  tokenCount(response.usage.output_tokens);
interface ValidAnswer {
  readonly choice: string;
}
const hasAnswer = (
  answer: unknown,
  request: DecisionRequest
): answer is ValidAnswer =>
  record(answer) &&
  answer.type === "choice" &&
  typeof answer.choice === "string" &&
  request.allowedChoices.some((choice) => choice === answer.choice) &&
  probability(answer.confidence) &&
  record(answer.probabilities) &&
  Object.keys(answer.probabilities).length === request.allowedChoices.length &&
  request.allowedChoices.every(
    (choice) =>
      record(answer.probabilities) && probability(answer.probabilities[choice])
  );
export const createJevAdapter = (
  configuration?: JevConfiguration
): BoundedDecisionProvider => {
  const configured =
    configuration &&
    configuration.apiKey.length > 0 &&
    configuration.modelVersion === "jev-1.13.0" &&
    configuration.currency === "USD" &&
    configuration.minorUnit.length > 0 &&
    configuration.inputUsdPerMillion === 0.042 &&
    configuration.outputUsdPerMillion === 0 &&
    configuration.verifiedPricing === true;
  const maximum: BudgetAmount = Object.freeze({
    unit: configuration?.minorUnit ?? "unconfigured",
    units: configured
      ? Math.ceil(
          (MAXIMUM_INPUT_TOKENS * configuration.inputUsdPerMillion * 100) /
            1_000_000
        )
      : 0,
  });
  const client = configured
    ? new TypeSafeClient({
        apiKey: configuration.apiKey,
        defaultModel: configuration.modelVersion,
        fetch: configuration.fetch,
        logLevel: "off",
        retry: { maxRetries: 0 },
      })
    : undefined;
  return {
    maximum,
    modelVersion: configuration?.modelVersion ?? "unconfigured",
    async propose(suppliedRequest, suppliedOptions) {
      const request = immutable(suppliedRequest);
      const options = Object.freeze({ ...suppliedOptions });
      const ready = preflightEffect(options, Date.now());
      if (ready.status !== "ok") {
        return {
          result: ready,
          usage: { incurred: { ...maximum, units: 0 }, state: "known" },
        };
      }
      if (!client || !configured) {
        return {
          result: {
            code: "entitlement",
            reason: "Verified Jev configuration is required.",
            status: "denied",
          },
          usage: { incurred: { ...maximum, units: 0 }, state: "known" },
        };
      }
      if (!requestBounded(request, configuration.modelVersion)) {
        return {
          result: {
            reason:
              "Decision request exceeds its verified model or choice bounds.",
            status: "invalid-input",
          },
          usage: { incurred: { ...maximum, units: 0 }, state: "known" },
        };
      }
      const criteria: Record<string, string> = {};
      for (const choice of request.allowedChoices) {
        criteria[choice] = choice;
      }
      let response: unknown;
      try {
        response = await client.systemOne(
          {
            model: configuration.modelVersion,
            questions: {
              next_action: {
                criteria,
                instructions:
                  "Choose the next action from the permitted choices.",
                type: "choice",
              },
            },
            state: request.eventSummary,
          },
          {
            retry: { maxRetries: 0 },
            signal: options.signal,
            timeout: Math.max(1, options.deadlineAt - Date.now()),
          }
        );
      } catch {
        return {
          result: {
            operationId: options.operationId,
            reason: "Jev did not return authoritative usage.",
            status: "unknown-outcome",
          },
          usage: { state: "unknown" },
        };
      }
      if (!hasUsage(response)) {
        return {
          result: {
            operationId: options.operationId,
            reason: "Jev usage is malformed or outside its verified bound.",
            status: "unknown-outcome",
          },
          usage: { state: "unknown" },
        };
      }
      const incurred = {
        unit: maximum.unit,
        units: Math.ceil(
          (response.usage.input_tokens *
            configuration.inputUsdPerMillion *
            100) /
            1_000_000
        ),
      };
      const answer = record(response.answers)
        ? response.answers.next_action
        : undefined;
      if (
        response.model !== configuration.modelVersion ||
        !hasAnswer(answer, request)
      ) {
        return {
          result: {
            reason:
              "Jev returned a model or answer outside the permitted request.",
            status: "invalid-input",
          },
          usage: { incurred, state: "known" },
        };
      }
      const choice = request.allowedChoices.find(
        (allowed) => allowed === answer.choice
      );
      if (!choice) {
        throw new Error("Validated decision choice is missing.");
      }
      return {
        result: {
          status: "ok",
          value: Object.freeze({
            choice,
            inputDigest: request.inputDigest,
            modelVersion: response.model,
            usage: Object.freeze(incurred),
          }),
        },
        usage: { incurred, state: "known" },
      };
    },
  };
};
