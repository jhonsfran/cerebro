import type { EventAddress } from "@cerebro/contracts/events";
import { Unavailable } from "@cerebro/contracts/failures";
import { EventAddressSchema } from "@cerebro/contracts/work";
import { defineDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  JsonObject,
  Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";

export interface ProfileIdentity extends JsonObject {
  agentVersion: number;
}
export const sameProfile = (
  left: ProfileIdentity,
  right: ProfileIdentity
): boolean => left.agentVersion === right.agentVersion;
export const profileKey = (identity: ProfileIdentity): string =>
  `v${identity.agentVersion}`;
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
  refresh: ProfileIdentity | null;
}
const profileIdentity = Schema.Struct({
  agentVersion: Schema.Int.check(Schema.isGreaterThan(0)),
});
const bindingFields = {
  address: EventAddressSchema,
  agentVersion: profileIdentity.fields.agentVersion,
  nativeId: Schema.declare<ConversationId>(
    (value): value is ConversationId =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0
  ),
  refresh: Schema.NullOr(profileIdentity),
};
const previousBindings = Schema.Struct({
  conversations: Schema.Record(Schema.String, Schema.Struct(bindingFields)),
});
const policyBindings = Schema.Struct({
  conversations: Schema.Record(
    Schema.String,
    Schema.Struct({
      ...bindingFields,
      policyVersion: Schema.Literals([0, 1]),
    })
  ),
});
export const Bindings = defineDoc({
  initial: (): { conversations: Record<string, ConversationBinding> } => ({
    conversations: {},
  }),
  kind: "cerebro.conversation-bindings",
  scope: "session",
  version: 5,
  migrate: (
    value,
    fromVersion
  ): { conversations: Record<string, ConversationBinding> } => {
    if (fromVersion === 4) {
      return Schema.decodeUnknownSync(previousBindings)(value);
    }
    if (fromVersion !== 2 && fromVersion !== 3) {
      throw new Error("Unsupported conversation bindings version.");
    }
    const previous = Schema.decodeUnknownSync(policyBindings)(value);
    return {
      conversations: Object.fromEntries(
        Object.entries(previous.conversations)
          .filter(([, binding]) => binding.policyVersion === 1)
          .map(([key, { address, agentVersion, nativeId, refresh }]) => [
            key,
            { address, agentVersion, nativeId, refresh },
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
