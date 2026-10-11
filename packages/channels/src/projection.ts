import type { DomainSnapshot } from "@cerebro/contracts/session-service";
import type { ChannelItemBody } from "@cerebro/db/schema/agents";

// Flattens a session snapshot into the conversation items the API returns.

export const snapshotItems = (
  snapshot: DomainSnapshot
): { itemKey: string; item: ChannelItemBody }[] => {
  const entries: { itemKey: string; item: ChannelItemBody }[] = [];
  for (const message of snapshot.userMessages) {
    entries.push({
      item: {
        eventId: message.eventId,
        mode: message.mode,
        runId: message.runId,
        text: message.text,
        type: "user",
      },
      itemKey: `user:${message.eventId}`,
    });
  }
  for (const tool of snapshot.tools) {
    entries.push({
      item: {
        arguments: tool.arguments,
        dependencies: tool.dependencies,
        name: tool.toolId,
        operationId: tool.operationId,
        output: tool.output,
        runId: tool.runId,
        state: tool.state,
        toolId: tool.toolId,
        type: "tool",
      },
      itemKey: `tool:${tool.operationId}`,
    });
  }
  for (const approval of snapshot.approvals) {
    entries.push({
      item: {
        approvalId: approval.approvalId,
        expiresAt: approval.expiresAt,
        operationId: approval.operationId,
        runId: approval.runId,
        state: approval.state,
        type: "approval",
      },
      itemKey: `approval:${approval.approvalId}`,
    });
  }
  for (const output of snapshot.outputs) {
    entries.push({
      item: {
        answerId: output.answerId,
        dependencies: output.dependencies,
        executionId: output.executionId,
        runId: output.runId,
        runIds: output.runIds,
        text: output.text,
        type: "output",
      },
      itemKey: `answer:${output.answerId}`,
    });
    for (const citation of output.citations) {
      entries.push({
        item: {
          dependencies: output.dependencies,
          href: `/api/product/conversations/${encodeURIComponent(snapshot.address.conversationId)}/sources/${encodeURIComponent(citation.sourceId)}`,
          runId: output.runId,
          sourceId: citation.sourceId,
          sourceVersion: citation.sourceVersion,
          title: citation.sourceUri,
          type: "citation",
        },
        itemKey: `citation:${output.answerId}:${citation.sourceId}:${citation.sourceVersion}`,
      });
    }
  }
  for (const run of snapshot.runs) {
    entries.push({
      item: { run, runId: run.runId, type: "run" },
      itemKey: `run:${run.runId}`,
    });
  }
  return entries;
};
