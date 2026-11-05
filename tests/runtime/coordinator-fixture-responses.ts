import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type {
  FauxResponseFactory,
  FauxResponseStep,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { Schema } from "effect";

const eventReply = (transcript: TranscriptContext): string | undefined => {
  const message = transcript.messages.findLast(
    (entry) => entry.role === "user"
  );
  const prompt = typeof message?.content === "string" ? message.content : "";
  if (!prompt.startsWith("Internal coordinator event.")) {
    return;
  }
  const event = Schema.decodeUnknownSync(
    Schema.Struct({ content: Schema.Struct({ text: Schema.String }) })
  )(JSON.parse(prompt.slice(prompt.indexOf("\n") + 1)));
  return `Coordinator result. ${event.content.text}`;
};

export const coordinatorFixtureResponses = (options: {
  readonly goal: string;
  readonly record: () => Promise<void>;
}): FauxResponseStep[] => {
  const answer: FauxResponseFactory = async (transcript) => {
    await options.record();
    return fauxAssistantMessage(
      eventReply(transcript) ?? "The coordinator answer is complete."
    );
  };
  return [
    async (transcript) => {
      await options.record();
      const reply = eventReply(transcript);
      if (reply) {
        return fauxAssistantMessage(reply);
      }
      return fauxAssistantMessage(
        fauxToolCall("start_team", { goal: options.goal }),
        { stopReason: "toolUse" }
      );
    },
    answer,
    answer,
  ];
};
