/**
 * The release channels (src/rollout/channels.ts): every client follows
 * one, and each points at one release. Every new release goes to Edge on
 * its own; staff promote one to Beta or Stable. Plain data, so the
 * admin's pages and its database schema (src/db/schema.ts) share it
 * without the browser loading the schema.
 */
export const channelIds = ["edge", "beta", "stable"] as const;
export type Channel = (typeof channelIds)[number];
