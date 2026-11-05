import type { EventAddress } from "@cerebro/contracts/events";
import { Unavailable } from "@cerebro/contracts/failures";
import { id } from "@cerebro/contracts/identity";
import { defineDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  JsonObject,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

export interface ProfileIdentity extends JsonObject {
  agentVersion: number;
  policyVersion: 0 | 1;
}
export const sameProfile = (
  left: ProfileIdentity,
  right: ProfileIdentity
): boolean =>
  left.agentVersion === right.agentVersion &&
  left.policyVersion === right.policyVersion;
export const profileKey = (identity: ProfileIdentity): string =>
  `v${identity.agentVersion}:p${identity.policyVersion}`;
export class ProfileChanged extends Unavailable {
  constructor() {
    super({
      reason: "The conversation profile changed. Retry authorization.",
      retryAfter: 1,
    });
  }
}
export interface ConversationBinding extends JsonObject, ProfileIdentity {
  address: { [Key in keyof EventAddress]: EventAddress[Key] };
  nativeId: ConversationId;
  origin: string | null;
  legacyVersion: number | null;
  refresh: ProfileIdentity | null;
  releaseEvent: string | null;
}
const previous = Schema.Struct({
  conversations: Schema.Record(
    Schema.String,
    Schema.Struct({
      address: Schema.Struct({
        organizationId: Schema.String,
        agentId: Schema.String,
        conversationId: Schema.String,
        sessionId: Schema.String,
      }),
      agentVersion: Schema.Number,
      nativeId: Schema.declare<ConversationId>(
        (value): value is ConversationId =>
          typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ),
      origin: Schema.optional(Schema.NullOr(Schema.String)),
    })
  ),
});
export const Bindings = defineDoc({
  initial: (): { conversations: Record<string, ConversationBinding> } => ({
    conversations: {},
  }),
  kind: "cerebro.conversation-bindings",
  scope: "session",
  version: 2,
  migrate: (
    value,
    fromVersion
  ): { conversations: Record<string, ConversationBinding> } => {
    if (fromVersion !== 1) {
      throw new Error("Unsupported conversation binding version.");
    }
    const parsed = Schema.decodeUnknownSync(previous)(value);
    return {
      conversations: Object.fromEntries(
        Object.entries(parsed.conversations).map(([key, binding]) => [
          key,
          {
            ...binding,
            origin: binding.origin ?? null,
            address: {
              organizationId: id.organization(binding.address.organizationId),
              agentId: id.agent(binding.address.agentId),
              conversationId: id.conversation(binding.address.conversationId),
              sessionId: id.session(binding.address.sessionId),
            },
            policyVersion: 0 as const,
            legacyVersion: binding.agentVersion,
            refresh: null,
            releaseEvent: null,
          },
        ])
      ),
    };
  },
});
export const requireProfileIn = async (
  tx: Tx,
  sessionId: string,
  identity: ProfileIdentity
): Promise<ConversationBinding> => {
  const bindings = await tx.doc(Bindings);
  const binding = bindings.conversations[sessionId];
  if (!binding || !sameProfile(binding, identity)) {
    throw new ProfileChanged();
  }
  return binding;
};
