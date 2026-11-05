import { failureToHttp, toContractFailure } from "@cerebro/contracts/failures";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";

export const coordinationToolResult = async (
  operation: () => Promise<unknown>
): Promise<ToolExecutionResult> => {
  try {
    return {
      output: [{ type: "text", text: JSON.stringify(await operation()) }],
    };
  } catch (error) {
    const failure = failureToHttp(
      toContractFailure(error, "The team operation is unavailable.")
    );
    return {
      isError: true,
      output: [{ type: "text", text: failure.body.message }],
    };
  }
};
