import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";

export const createProvisionalTextProjection = () => {
  const blocks = new Map<number, string>();
  let delivered = "";
  let messageTimestamp: number | undefined;
  let attempt: number | undefined;
  let primaryInput:
    | Extract<AgentEvent, { type: "run_start" }>["inputs"][number]
    | undefined;
  const replace = (content: AssistantMessage["content"]) => {
    blocks.clear();
    for (const [index, block] of content.entries()) {
      if (block.type === "text") {
        blocks.set(index, block.text);
      }
    }
  };
  const applyChanges = (
    changes: Extract<AgentEvent, { type: "message_update" }>["changes"]
  ) => {
    for (const change of changes) {
      if (change.type === "text_delta") {
        blocks.set(
          change.contentIndex,
          `${blocks.get(change.contentIndex) ?? ""}${change.delta}`
        );
      } else if (change.type === "message") {
        replace(change.message.content);
      } else if ("block" in change) {
        if (change.block.type === "text") {
          blocks.set(change.contentIndex, change.block.text);
        } else {
          blocks.delete(change.contentIndex);
        }
      }
    }
  };
  const applySnapshot = (event: Extract<AgentEvent, { type: "snapshot" }>) => {
    const message = event.generation?.message;
    const [nextPrimary] = event.run?.inputs ?? [];
    if (
      nextPrimary !== primaryInput ||
      message?.timestamp !== messageTimestamp ||
      (attempt !== undefined && event.generation?.attempt !== attempt)
    ) {
      delivered = "";
    }
    messageTimestamp = message?.timestamp;
    attempt = event.generation?.attempt;
    primaryInput = nextPrimary;
    replace(event.generation?.message?.content ?? []);
    if (!event.generation?.message) {
      delivered = "";
    }
  };
  return (event: AgentEvent): string => {
    if (event.type === "snapshot") {
      applySnapshot(event);
    } else if (event.type === "run_start") {
      const [nextPrimary] = event.inputs;
      if (nextPrimary !== primaryInput) {
        blocks.clear();
        delivered = "";
        messageTimestamp = undefined;
        attempt = undefined;
      }
      primaryInput = nextPrimary;
      return "";
    } else if (
      event.type === "message_start" &&
      event.message.role === "assistant"
    ) {
      replace(event.message.content);
      delivered = "";
      messageTimestamp = event.message.timestamp;
      attempt = undefined;
    } else if (event.type === "message_update") {
      applyChanges(event.changes);
    } else {
      return "";
    }
    const current = [...blocks.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join("");
    if (!current.startsWith(delivered)) {
      return "";
    }
    const appended = current.slice(delivered.length);
    delivered = current;
    return appended;
  };
};
