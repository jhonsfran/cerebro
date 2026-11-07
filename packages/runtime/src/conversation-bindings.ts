import type { EventAddress } from "@cerebro/contracts/events";
import { Unavailable } from "@cerebro/contracts/failures";
import { defineDoc } from "@earendil-works/pi-durable";
import type {
  ConversationId,
  JsonObject,
  Tx,
} from "@earendil-works/pi-durable";

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
  legacyVersion: number | null;
  refresh: ProfileIdentity | null;
  releaseEvent: string | null;
}
export const Bindings = defineDoc({
  initial: (): { conversations: Record<string, ConversationBinding> } => ({
    conversations: {},
  }),
  kind: "cerebro.conversation-bindings",
  scope: "session",
  version: 3,
  migrate: (): { conversations: Record<string, ConversationBinding> } => {
    throw new Error("Unsupported conversation bindings version.");
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
