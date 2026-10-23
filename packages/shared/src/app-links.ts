import { z } from "zod";

import { linkLimits } from "./app-link-limits.ts";
import type { FrameLinkMessage } from "./app-link-limits.ts";
import { defineErrorFamily } from "./errors.ts";

// An App's external links (spec 10.7.7, 32.3), as core, the page around a
// screen's frame and the SDK say them to each other: the refusals, and the
// messages of the frame's link port read as what they are. The rules for
// which URL may open are in app-link-limits.ts, with nothing imported.

/** Why a link wasn't opened. */
export const linkErrors = defineErrorFamily({
  "link.invalid": "That isn't a link that can be opened.",
  "link.not_allowed":
    "This app may open links only to the sites its version declares, and never to a private network.",
  "link.declined": "The link wasn't opened.",
  "link.asking_paused":
    "Another link is waiting for an answer, or one was just turned down. Try again in a moment.",
  "link.unavailable": "Links can't be opened here.",
  "link.confirmation_required":
    "This app read restricted data, so each link it opens needs your confirmation.",
});

/** An alias of a links resource, as an App declares it. */
export const linkResourceSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u);

/** A URL, as a frame or the page sends it: bounded, decided elsewhere. */
const linkUrlSchema = z.string().min(1).max(linkLimits.urlLength);

/**
 * What a frame may send over its link port (`FrameLinkMessage`), read by
 * the page before anything else: anything else is refused, or dropped.
 */
export const frameLinkMessageSchema = z.strictObject({
  type: z.literal("open"),
  call: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  resource: linkResourceSchema,
  url: linkUrlSchema,
}) satisfies z.ZodType<FrameLinkMessage>;

/** What the page asks core to check before it asks the person: a URL. */
export const linkCheckSchema = z.strictObject({ url: linkUrlSchema });

/** What the page asks core to open: a URL, and how the person asked. */
export const linkOpenSchema = z.strictObject({
  url: linkUrlSchema,
  intent: z.enum(["activation", "confirmation"]),
});
