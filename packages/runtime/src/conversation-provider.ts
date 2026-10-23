import type { Api, Model } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";

export const conversationProvider = (
  sessionId: string,
  model: Model<Api>,
  provider: Provider
): Provider => {
  const alias = `cerebro:${sessionId}`;
  const physicalModel = <A extends Api>(value: Model<A>): Model<A> => {
    if (value.provider !== alias || value.id !== model.id) {
      throw new Error("Conversation model does not match its provider scope.");
    }
    return { ...value, provider: model.provider };
  };
  return {
    auth: provider.auth,
    getModels: () => [{ ...model, provider: alias }],
    id: alias,
    name: provider.name,
    stream: (value, context, options) =>
      provider.stream(physicalModel(value), context, options),
    streamSimple: (value, context, options) =>
      provider.streamSimple(physicalModel(value), context, options),
  };
};
