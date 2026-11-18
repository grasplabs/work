import { z } from "zod";

import { connectionPersonSchema } from "./connect.ts";
import { defineErrorFamily } from "./errors.ts";

// Native sync (GRA-1758, GRA-1759): what one synced item is, whichever
// system it comes from. Connect reads a page of a source's changes with
// the connection's token, which never leaves it, in an isolate of the
// connection's own connector (`defineSync` in the connector kit); core
// applies the page to the Brain and keeps the cursor. Nothing here names
// a provider: the Brain knows none.

/** What kind of thing an item is. */
export const syncItemKindSchema = z.enum(["mail", "file", "event"]);
export type SyncItemKind = z.infer<typeof syncItemKindSchema>;

/**
 * The bounds an item's fields keep, so no vendor's value can make an item
 * unbounded. The connector kit fits every item a sync answers to them
 * (`fitItem`): a title is cut, a part that doesn't fit is left out.
 */
export const syncItemLimits = {
  /** An ID: of an item, an account, a group or a domain. */
  idLength: 1024,
  versionLength: 1024,
  titleLength: 1024,
  contentTypeLength: 255,
} as const;

/** A provider's ID of an item, an account, a group or a domain. */
const sourceIdSchema = z.string().min(1).max(syncItemLimits.idLength);

/**
 * Who may open an item, as the source lists it: one account, by its
 * verified email address, which the provider's sign-in vouches for; a
 * group; everyone in the source's organisation or domain, as the source
 * would show it to them in their own search; or whoever has a link to it.
 * The connection's provider and tenant say whose (core makes the
 * principals). A link counts for nobody: having it is no reason to find
 * the item in the Brain.
 */
export const syncReaderSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account"), id: sourceIdSchema }),
  z.strictObject({ kind: z.literal("group"), id: sourceIdSchema }),
  z.strictObject({ kind: z.literal("tenant"), id: sourceIdSchema }),
  z.strictObject({ kind: z.literal("link") }),
]);
export type SyncReader = z.infer<typeof syncReaderSchema>;

/** An item's content: its text, or a file's bytes for core's extractor. */
export const syncContentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("file"),
    contentType: z.string().min(1).max(syncItemLimits.contentTypeLength),
    base64: z.base64(),
  }),
]);
export type SyncContent = z.infer<typeof syncContentSchema>;

/**
 * One item of a page: one that is there, as it now is, or one that went
 * away (deleted, in the bin, unshared, or out of the connection's reach),
 * which stops answering.
 */
export const syncItemSchema = z.discriminatedUnion("gone", [
  z.strictObject({
    gone: z.literal(false),
    /** The provider's stable ID of the item in its source. */
    id: sourceIdSchema,
    kind: syncItemKindSchema,
    /**
     * Its change marker: the provider's version of it. Core keys each
     * version by it, so reading a page again changes nothing.
     */
    version: z.string().min(1).max(syncItemLimits.versionLength),
    /** When it last changed, as the provider says. */
    changedAt: z.iso.datetime({ offset: true }),
    title: z.string().max(syncItemLimits.titleLength),
    /**
     * Null when nothing of it is readable here: no text, or more than a
     * page holds. Core counts it as skipped.
     */
    content: syncContentSchema.nullable(),
    /** Null when the source's list couldn't be read whole: never guessed. */
    readers: z.array(syncReaderSchema).nullable(),
    /** The account ID of who changed it last, if the provider says. */
    changedBy: sourceIdSchema.nullable(),
    /** For an attachment: the ID of the item it belongs to. */
    partOf: sourceIdSchema.nullable(),
  }),
  z.strictObject({
    gone: z.literal(true),
    id: sourceIdSchema,
    kind: syncItemKindSchema,
  }),
]);
export type SyncItem = z.infer<typeof syncItemSchema>;

/**
 * Longest cursor: a position goes into a request's URL, and connect's
 * places' cursors have the same bound (`placesLimits.cursorLength`).
 */
const cursorMaxLength = 2048;

/**
 * A cursor: a provider's position (a history ID, a page token, a sync
 * token), as the connector writes it, never a link. Its alphabet has no
 * `/`, `?`, `#`, `%` or `:`, so it can't name a host, a path or a query of
 * its own; the connector builds every request itself.
 */
export const syncCursorSchema = z
  .string()
  .max(cursorMaxLength)
  .regex(/^[\w.~=+!*-]+$/u, "Not a position");

/** One page of a source's changes, and where the next read goes on from. */
export const syncPageSchema = z.strictObject({
  items: z.array(syncItemSchema),
  cursor: syncCursorSchema,
  /** Whether more is there already: the next read is due at once. */
  more: z.boolean(),
});
export type SyncPage = z.infer<typeof syncPageSchema>;

/** The connection's own account: its mailbox, its own drive, its calendars. */
export const ownPlace = "own";

/**
 * One path segment's characters: none that can step out of it, and no
 * control character (`\p{Cc}`).
 */
const placePattern = /^[^/\\?#%;:\p{Cc}]+$/u;

/**
 * A place a sync reads of the connection's own account, as its connector
 * lists it (a mail folder's ID): one path segment, nothing that can step
 * out of one (`/ \ ? # % ; :` or a control character, `.` or `..`), and
 * never `own`, which names the whole account.
 */
export const syncPlaceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(placePattern, "Not a place")
  .refine(
    (place) => place !== "." && place !== ".." && place !== ownPlace,
    "Not a place"
  );

/**
 * Places of a sync to read, each its own source with its own cursor, and
 * where the listing goes on (`cursor`): null once it is whole. Core puts
 * the reads of one listing together before it adds or drops a source.
 */
export const syncPlacesSchema = z.strictObject({
  places: z.array(syncPlaceSchema),
  cursor: syncCursorSchema.nullable(),
});
export type SyncPlaces = z.infer<typeof syncPlacesSchema>;

/** Longest name of a place an admin is shown to pick from. */
export const syncChoiceTitleLength = 256;

/**
 * A place of a shared connection an admin may pick for a sync (a shared
 * drive, a document library), as its connector lists what the connected
 * account can see: its ID and its name, which is only ever shown.
 */
export const syncChoiceSchema = z.strictObject({
  place: syncPlaceSchema,
  title: z.string().max(syncChoiceTitleLength),
});
export type SyncChoice = z.infer<typeof syncChoiceSchema>;

/**
 * The places a sync of a shared connection can read (`places: "picked"`),
 * a read at a time: where the listing goes on (`cursor`), null once whole.
 */
export const syncChoicesSchema = z.strictObject({
  choices: z.array(syncChoiceSchema),
  cursor: syncCursorSchema.nullable(),
});
export type SyncChoices = z.infer<typeof syncChoicesSchema>;

/** What core asks connect for: the places of one connection's sync. */
export const syncPlacesRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  feed: z.string().regex(/^[a-z][a-z\d-]{0,63}$/u, "Not a sync's name"),
  /** Where the listing goes on, from the last read's answer; null from the start. */
  cursor: syncCursorSchema.nullable(),
});
export type SyncPlacesRequest = z.input<typeof syncPlacesRequestSchema>;

/** What core asks connect for: one page of one source, from `cursor` on. */
export const syncPageRequestSchema = z.strictObject({
  connectionId: z.string().min(1).max(128),
  /** Which of the connector's syncs: `drive`, `gmail`, `calendar`. */
  feed: z.string().regex(/^[a-z][a-z\d-]{0,63}$/u, "Not a sync's name"),
  /**
   * `own`; a place the connection's sync lists of its own account
   * (`listSyncPlaces`); or a place someone picked on a shared connection.
   */
  place: z.string().min(1).max(256),
  /** Null for the first listing. */
  cursor: syncCursorSchema.nullable(),
});
export type SyncPageRequest = z.input<typeof syncPageRequestSchema>;

/**
 * A sync's places of a shared connection, for its admin to pick from: as
 * its connector lists them, each with whether it is picked.
 */
export const syncPlaceChoicesSchema = z.strictObject({
  choices: z.array(syncChoiceSchema.extend({ picked: z.boolean() })),
  cursor: syncCursorSchema.nullable(),
});
export type SyncPlaceChoices = z.infer<typeof syncPlaceChoicesSchema>;

/**
 * Most bytes a set of picks takes as JSON: connect writes it as one value,
 * and D1 takes at most 2,000,000 bytes in a string
 * (https://developers.cloudflare.com/d1/platform/limits/).
 */
const picksMaxBytes = 2_000_000;

/**
 * The places of a shared connection a sync reads, as its admin picks them:
 * the whole set, replacing the one before, each once.
 */
export const syncPicksSchema = z
  .array(syncPlaceSchema)
  .refine((places) => new Set(places).size === places.length, {
    message: "A place picked twice",
  })
  .refine(
    (places) =>
      new TextEncoder().encode(JSON.stringify(places)).byteLength <=
      picksMaxBytes,
    { message: "More places than one write takes" }
  );

/**
 * What core asks connect for: the places the admin `person` may pick for a
 * sync of a shared connection, a read at a time from `cursor`.
 */
export const syncPlaceChoicesRequestSchema = z.strictObject({
  person: connectionPersonSchema,
  connectionId: z.string().min(1).max(128),
  feed: z.string().regex(/^[a-z][a-z\d-]{0,63}$/u, "Not a sync's name"),
  cursor: syncCursorSchema.nullable(),
});
export type SyncPlaceChoicesRequest = z.input<
  typeof syncPlaceChoicesRequestSchema
>;

/** What core asks connect for: the admin `person` picks a sync's places. */
export const pickSyncPlacesSchema = z.strictObject({
  person: connectionPersonSchema,
  connectionId: z.string().min(1).max(128),
  feed: z.string().regex(/^[a-z][a-z\d-]{0,63}$/u, "Not a sync's name"),
  places: syncPicksSchema,
});
export type PickSyncPlaces = z.input<typeof pickSyncPlacesSchema>;
export const syncErrors = defineErrorFamily({
  "sync.invalid": "That isn't a valid request for a page of a sync.",
  "sync.not_found":
    "There's no such connection, or its connector has no such sync.",
  "sync.inactive": "This connection needs reconnecting before it can sync.",
  "sync.place_refused":
    "That place isn't the connection's own account or a place picked on it.",
  "sync.not_shared":
    "Places are picked only on a connection shared with the company.",
  "sync.restart":
    "The source no longer knows that cursor: list it again from the start.",
  "sync.throttled": "The provider is throttling reads: try again later.",
  "sync.provider_failed": "The provider didn't answer the read.",
});
