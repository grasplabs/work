import { z } from "zod";

import { defineErrorFamily } from "./errors.ts";

// The keys a chat platform signs its requests to Grasp with, as connect
// fetches them for core's channel door (core's src/channels). Core checks
// every request from a chat platform against them before any handler
// runs, and never fetches them itself: every outside call goes through
// connect. They are public, so nothing here is a client's.

/**
 * The platforms whose signing keys connect fetches: Microsoft's Bot
 * Framework for Teams, and Google's for Gmail's Pub/Sub pushes.
 */
export const channelKeyPlatforms = ["teams", "gmail"] as const;

export const channelKeyPlatformSchema = z.enum(channelKeyPlatforms);
export type ChannelKeyPlatform = z.infer<typeof channelKeyPlatformSchema>;

/** What connect reads of a platform's answers and passes on, at most. */
export const channelKeyLimits = {
  /** Bytes of one answer: Microsoft's key set is a few KiB. */
  answerBytes: 64 * 1024,
  /** Keys passed on: Microsoft publishes a handful. */
  keys: 32,
} as const;

const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/u);

/**
 * One RSA public key, with the channels it is endorsed for: Microsoft's
 * Bot Framework key set names, for each key, the channels whose requests
 * it may sign (`msteams` for Teams). Only what checking a signature needs
 * is passed on.
 */
export const channelSigningKeySchema = z.strictObject({
  kid: z.string().min(1).max(256),
  kty: z.literal("RSA"),
  /** The modulus: 2048 to 4096 bits, base64url. */
  n: base64UrlSchema.min(342).max(684),
  e: base64UrlSchema.max(8),
  endorsements: z.array(z.string().min(1).max(64)).max(32),
});
export type ChannelSigningKey = z.infer<typeof channelSigningKeySchema>;

/** A platform's signing keys, as connect read them just now. */
export const channelSigningKeysSchema = z.strictObject({
  keys: z.array(channelSigningKeySchema).max(channelKeyLimits.keys),
});
export type ChannelSigningKeys = z.infer<typeof channelSigningKeysSchema>;

export const channelErrors = defineErrorFamily({
  "channel.invalid": "That isn't a chat platform Grasp checks requests from.",
  "channel.keys_unavailable":
    "The chat platform's signing keys couldn't be read. Try again in a minute.",
});
