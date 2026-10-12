import type { ChannelOptions } from "@cerebro/channels/types";
import type { Database } from "@cerebro/db";

// Procedures read only the signed-in user's ID from the session.
export interface Context {
  readonly db: Database;
  readonly session: { readonly user: { readonly id: string } } | null;
  // Product procedures need the installation's channel adapters.
  readonly channels?: ChannelOptions;
}
