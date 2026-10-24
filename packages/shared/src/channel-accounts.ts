import { z } from "zod";

import { chatPlatformSchema } from "./chat.ts";

// A person's account on a chat platform, linked to their Grasp person
// (core's channels/accounts.ts), so the agent knows who writes on a
// platform whose messages carry no Entra object id. Never by a name, an
// email or a phone number on its own (threat model R15): only by the
// platform's own verified sender id, and only once the person signed in
// to Grasp and confirmed it, through a link sent to that sender alone.

/**
 * How long a link stays good once the chat sent it: long enough to sign
 * in, short enough that one lying in a chat's history soon opens nothing.
 */
export const channelLinkMs = 15 * 60 * 1000;

/**
 * Where a link opens on the deployment's site, with its secret after the
 * `#`, which no browser sends to a server, so it is never in a log or a
 * referrer: `<origin>/chat-link#<secret>`.
 */
export const channelLinkPath = "/chat-link";

/** A link's secret: 32 random bytes, base64url, as `randomToken` makes it. */
export const channelLinkSecretSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u, "A chat link's secret");

/**
 * A platform whose people are linked by account. Teams isn't one: its
 * messages carry the person's Entra object id, which their own sign-in
 * keeps, so a link there could only ever disagree with it.
 */
export const linkedPlatformSchema = chatPlatformSchema.refine(
  (platform) => platform !== "teams",
  { message: "Teams people are known by their Entra object id" }
);

/** No control characters: an id is shown back to the person in Settings. */
const printable = /^[^\p{Cc}]+$/u;

/**
 * A sender's id on their platform, as its adapter verified it (Chat SDK's
 * `message.author.userId`): a Slack member id, a Telegram user id, a
 * WhatsApp number. Opaque to Grasp; never parsed for meaning.
 */
export const platformUserIdSchema = z.string().min(1).max(256).regex(printable);

/**
 * What the platform calls the sender, as its adapter read it: shown to the
 * person deciding whether to link, and in Settings, never to tell who is
 * writing. Anyone can call themselves anything on most platforms.
 */
export const platformNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(printable);

/** A chat account linked to the signed-in person, as Settings lists it. */
export interface ChannelAccount {
  /** Names the link for {@link ChannelAccountsApi.unlink}; opaque. */
  id: string;
  /** The platform, by its Chat SDK adapter's name (`slack`). */
  platform: string;
  /** Their id on the platform. */
  platformUserId: string;
  /** What the platform called them when they linked it, if it said. */
  name: string | null;
  /** When it was linked (ISO 8601). */
  linkedAt: string;
}

/** The chat account a link would link, shown before the person confirms. */
export interface ChannelLinkOffer {
  platform: string;
  platformUserId: string;
  name: string | null;
  /** When the link stops working (ISO 8601). */
  expiresAt: string;
}

/**
 * Why a link links nothing. `not_found`: no link has this secret.
 * `used`: it linked an account already, and links nothing again.
 * `expired`: its time is up. `replaced`: the chat sent a newer link since.
 * `taken`: the account is linked to someone else, who unlinks it first.
 */
export type ChannelLinkRefusal =
  | "not_found"
  | "used"
  | "expired"
  | "replaced"
  | "taken";

/** What opening a link before confirming it came to. */
export type ChannelLinkPreview =
  | { state: "open"; offer: ChannelLinkOffer }
  | { state: "refused"; reason: ChannelLinkRefusal };

/** What confirming a link came to: `linked`, or why not. */
export type ChannelLinkOutcome =
  | { state: "linked"; account: ChannelAccount }
  | { state: "refused"; reason: ChannelLinkRefusal };

/**
 * What unlinking came to. `unlinked`: it was theirs and is gone: the
 * platform account is a stranger again from its next message.
 * `not_found`: they have no such link.
 */
export type ChannelUnlinked = "unlinked" | "not_found";

/**
 * The signed-in person's own chat accounts, over `/rpc`; never anyone
 * else's. Grasp staff link none: they aren't the company's people.
 */
export interface ChannelAccountsApi {
  /** Their linked chat accounts, newest first. */
  list: () => Promise<ChannelAccount[]>;
  /** What the link with `secret` would link, without using it. */
  preview: (secret: string) => Promise<ChannelLinkPreview>;
  /** Links the chat account the link with `secret` was sent to, to them; once. Audited. */
  link: (secret: string) => Promise<ChannelLinkOutcome>;
  /** Unlinks one of theirs, by its {@link ChannelAccount.id}. Audited. */
  unlink: (id: string) => Promise<ChannelUnlinked>;
}
