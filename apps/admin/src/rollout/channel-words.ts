import type { Channel } from "../db/schema.ts";

/** A release channel, as the admin names it (src/rollout/channels.ts). */
export const channelWords: Readonly<Record<Channel, string>> = {
  edge: "Edge",
  beta: "Beta",
  stable: "Stable",
};
