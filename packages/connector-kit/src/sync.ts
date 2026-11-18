import {
  syncChoiceTitleLength,
  syncChoicesSchema,
  syncContentSchema,
  syncCursorSchema,
  syncItemKindSchema,
  syncItemLimits,
  syncItemSchema,
  syncPageSchema,
  syncPlacesSchema,
  syncReaderSchema,
} from "@grasp-os/shared/sync";
import type {
  SyncChoices,
  SyncContent,
  SyncItem,
  SyncItemKind,
  SyncPage,
  SyncPlaces,
  SyncReader,
} from "@grasp-os/shared/sync";
import { z } from "zod";

import { ToolError } from "./connector.ts";
import { maxContentBytes } from "./content.ts";
import {
  connectorIsolateRequests,
  egressTooLargeMessage,
  syncManifestSchema,
  syncNameSchema,
  syncParamsSchema,
  syncPlacesParamsSchema,
} from "./manifest.ts";
import type { Route, SyncManifest } from "./manifest.ts";

// How a native connector reads a source for native sync (GRA-1758): one
// page of what changed from a cursor, as neutral items. A sync isn't a
// tool: no agent, App or workflow can call it. Connect alone asks for a
// page, by its own method on the connector's server (`syncMethod`), and
// runs it like a tool's call, in a fresh isolate whose only way out is the
// egress, which adds the token and lets through only the sync's routes.
// A route's `{place}` path parameter is bound to the place asked for.

/** Why a page couldn't be read, as the connector says it. */
export const syncFailureSchema = z.strictObject({
  code: z.enum(["restart", "throttled", "inactive", "failed"]),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
});
export type SyncFailure = z.infer<typeof syncFailureSchema>;

/**
 * What one page may take, so it fits what connect gives a connector's
 * isolate and reads of its answer:
 *
 * - `requests`: every request a connector's isolate may send
 *   (`connectorIsolateRequests`, which connect's isolate is loaded with).
 *   Nothing else in a sync's isolate sends any.
 * - `contentBytes`: its items' content together, as JSON, the same bound a
 *   tool's file read has (`maxContentBytes`, half of the 16 MiB connect
 *   reads, for the rest of the page). A file larger than a tool reads
 *   (`maxReadBytes`) comes without content.
 * - `millis`: how long after it started a page stops taking more, half of
 *   the 30 s connect waits for a connector's answer (`callTimeoutMs`), the
 *   rest for loading the isolate and answering. A request still under way
 *   then is given up, so a page always answers in time with what it has.
 */
export const syncPageLimits = {
  requests: connectorIsolateRequests,
  contentBytes: maxContentBytes,
  millis: 15_000,
} as const;

/** A connector's answer to `syncMethod`: a page, or why there is none. */
export const syncResultSchema = z.union([
  z.strictObject({ page: syncPageSchema }),
  z.strictObject({ failure: syncFailureSchema }),
]);
export type SyncResult = z.infer<typeof syncResultSchema>;

/**
 * A connector's answer to `syncPlacesMethod`: places (a `listed` sync's),
 * places to pick from (a `picked` sync's), or why there are none.
 */
export const syncPlacesResultSchema = z.union([
  syncPlacesSchema,
  syncChoicesSchema,
  z.strictObject({ failure: syncFailureSchema }),
]);
export type SyncPlacesResult = z.infer<typeof syncPlacesResultSchema>;

/**
 * Thrown by a sync's `read` when the provider no longer has the cursor (a
 * 404 or 410 on it): the source is listed again from the start.
 */
export class RestartSyncError extends Error {
  constructor(message = "The provider no longer has the cursor") {
    super(message);
    this.name = "RestartSyncError";
  }
}

export interface SyncDefinition {
  /** The sync's name, as core asks for it. */
  name: string;
  /** The kind of item it reads. */
  kind: SyncItemKind;
  /** The only requests it may send: GETs. */
  routes: readonly Route[];
  /**
   * One page from `cursor` on (from the start when null): what is there or
   * changed, and what went away, with the cursor to read on from. Only
   * what `place` holds: for `own`, only what the connection's own account
   * owns. A page stays within what connect reads of a connector's answer.
   */
  read: (params: {
    place: string;
    cursor: string | null;
    /** When the page stops taking more, in ms since the epoch (`syncPageLimits.millis`). */
    deadline: number;
  }) => Promise<SyncPage>;
  /**
   * The places of the connection's own account it reads, each a source of
   * its own with its own cursor (a mailbox's folders): none for a sync that
   * reads the whole account (`own`). A list too long for one read goes on
   * from `cursor` (none: from the start) in the next; core puts the reads
   * together, and drops the source of a place it doesn't list any more.
   */
  places?: (params: {
    cursor: string | null;
    /** When the read stops taking more, in ms since the epoch. */
    deadline: number;
  }) => Promise<SyncPlaces>;
  /**
   * For a sync of a shared connection's picked places instead
   * (`places: "picked"`): the places the connected account can see that an
   * admin may pick, each with its name, a read at a time from `cursor`.
   * `read` then reads only the place asked for, never the account's own
   * mail or files; connect asks only for a place an admin picked.
   */
  choices?: (params: {
    cursor: string | null;
    /** When the read stops taking more, in ms since the epoch. */
    deadline: number;
  }) => Promise<SyncChoices>;
}

/** A sync, as a connector carries it. */
export interface Sync {
  name: string;
  manifest: SyncManifest;
  /** Answers `syncMethod`'s params with a page or a failure. */
  call: (params: unknown) => Promise<SyncResult>;
  /** Answers `syncPlacesMethod`'s params with places or a failure. */
  places: (params: unknown) => Promise<SyncPlacesResult>;
}

/** The failure an error a sync threw stands for. */
const failureOf = (error: unknown): SyncFailure => {
  if (error instanceof RestartSyncError) {
    return { code: "restart" };
  }
  if (!(error instanceof ToolError) || error.details === undefined) {
    return { code: "failed" };
  }
  const { code, retryAfterSeconds } = error.details;
  if (code === "throttled" || code === "unavailable") {
    return retryAfterSeconds === undefined
      ? { code: "throttled" }
      : { code: "throttled", retryAfterSeconds };
  }
  return code === "access_denied" ? { code: "inactive" } : { code: "failed" };
};

/** `text` cut to at most `most` UTF-16 units, on a character's boundary. */
const cutText = (text: string, most: number): string => {
  let cut = "";
  for (const character of text) {
    if (cut.length + character.length > most) {
      break;
    }
    cut += character;
  }
  return cut;
};

const idSchema = syncItemSchema.options[1].shape.id;
const versionSchema = syncItemSchema.options[0].shape.version;
const changedAtSchema = syncItemSchema.options[0].shape.changedAt;

/** `value` if it is an ID the shared shape takes, else null. */
const idOrNull = (value: unknown): string | null => {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const fieldsSchema = z.record(z.string(), z.unknown());

/** A field of what a connector answered, read without trusting its shape. */
const fieldOf = (raw: unknown, name: string): unknown => {
  const fields = fieldsSchema.safeParse(raw);
  return fields.success && Object.hasOwn(fields.data, name)
    ? fields.data[name]
    : undefined;
};

/**
 * An item a sync answered, fitted to the shared shape (`syncItemSchema`),
 * so a vendor's value past one of its bounds never fails a whole page and
 * stalls the source:
 *
 * - a title too long is cut, on a character's boundary (the full one stays
 *   in the item's content);
 * - content, a reader, who changed it or what it is part of that doesn't
 *   fit is left out: content null, the reader dropped (fewer readers, never
 *   more), the others null;
 * - an item whose version or time doesn't fit can't be told apart from
 *   another version of it: it comes as gone, which shows it to nobody;
 * - an item whose ID doesn't fit can't be named at all: it is left out.
 */
export const fitItem = (raw: unknown, kind: SyncItemKind): SyncItem | null => {
  const exact = syncItemSchema.safeParse(raw);
  if (exact.success) {
    return exact.data;
  }
  const id = idOrNull(fieldOf(raw, "id"));
  if (id === null) {
    return null;
  }
  const itemKind = syncItemKindSchema.safeParse(fieldOf(raw, "kind"));
  const gone: SyncItem = {
    gone: true,
    id,
    kind: itemKind.success ? itemKind.data : kind,
  };
  const version = versionSchema.safeParse(fieldOf(raw, "version"));
  const changedAt = changedAtSchema.safeParse(fieldOf(raw, "changedAt"));
  if (
    fieldOf(raw, "gone") !== false ||
    !version.success ||
    !changedAt.success
  ) {
    return gone;
  }
  const title = fieldOf(raw, "title");
  const content = syncContentSchema.safeParse(fieldOf(raw, "content"));
  const readers = fieldOf(raw, "readers");
  const fitted = syncItemSchema.safeParse({
    gone: false,
    id,
    kind: gone.kind,
    version: version.data,
    changedAt: changedAt.data,
    title:
      typeof title === "string"
        ? cutText(title, syncItemLimits.titleLength)
        : "",
    content: content.success ? content.data : null,
    readers: Array.isArray(readers)
      ? readers.flatMap((reader): SyncReader[] => {
          const parsed = syncReaderSchema.safeParse(reader);
          return parsed.success ? [parsed.data] : [];
        })
      : null,
    changedBy: idOrNull(fieldOf(raw, "changedBy")),
    partOf: idOrNull(fieldOf(raw, "partOf")),
  });
  return fitted.success ? fitted.data : gone;
};

/** A page as a sync answers it, its items not yet fitted. */
const answeredPageSchema = z.object({
  items: z.array(z.unknown()),
  cursor: syncCursorSchema,
  more: z.boolean(),
});

/**
 * Control and format characters, bidirectional overrides among them: what
 * could make a planted name show as something else.
 */
const invisible = /[\p{Cc}\p{Cf}]/gu;
const spaces = /\s+/gu;

/**
 * A place's name as an admin is shown it: anyone who can name a shared
 * drive or a library can name it anything, so it is only data, on one
 * line, without control or format characters, cut to its bound.
 */
const cleanTitle = (title: string): string =>
  cutText(
    title.replaceAll(spaces, " ").replaceAll(invisible, "").trim(),
    syncChoiceTitleLength
  ).trim();

/** Places to pick from as a sync answered them, each name cleaned (`cleanTitle`). */
const withCleanTitles = (answered: unknown): unknown => {
  const choices = fieldOf(answered, "choices");
  if (!Array.isArray(choices)) {
    return answered;
  }
  return {
    choices: choices.map((choice: unknown) => {
      const title = fieldOf(choice, "title");
      return typeof title === "string"
        ? { place: fieldOf(choice, "place"), title: cleanTitle(title) }
        : choice;
    }),
    cursor: fieldOf(answered, "cursor"),
  };
};

/** What places a sync reads, from its definition. */
const placesKindOf = (definition: SyncDefinition): SyncManifest["places"] => {
  if (definition.places !== undefined && definition.choices !== undefined) {
    throw new Error("A sync lists its own places or places to pick, not both");
  }
  if (definition.places !== undefined) {
    return "listed";
  }
  return definition.choices === undefined ? "own" : "picked";
};

/** A sync, from its definition. */
export const defineSync = (definition: SyncDefinition): Sync => ({
  name: syncNameSchema.parse(definition.name),
  manifest: syncManifestSchema.parse({
    kind: definition.kind,
    places: placesKindOf(definition),
    routes: definition.routes,
  }),
  places: async (params) => {
    const asked = syncPlacesParamsSchema.parse(params);
    const list = definition.places ?? definition.choices;
    if (list === undefined) {
      return { failure: { code: "failed" } };
    }
    let places: unknown;
    try {
      places = await list({
        cursor: asked.cursor,
        deadline: Date.now() + syncPageLimits.millis,
      });
    } catch (error) {
      return { failure: failureOf(error) };
    }
    // A list with one place that isn't one is refused whole.
    const parsed =
      definition.places === undefined
        ? syncChoicesSchema.safeParse(withCleanTitles(places))
        : syncPlacesSchema.safeParse(places);
    return parsed.success ? parsed.data : { failure: { code: "failed" } };
  },
  call: async (params) => {
    const asked = syncParamsSchema.parse(params);
    let page: unknown;
    try {
      page = await definition.read({
        place: asked.place,
        cursor: asked.cursor,
        deadline: Date.now() + syncPageLimits.millis,
      });
    } catch (error) {
      return { failure: failureOf(error) };
    }
    // One item that doesn't fit never fails the page (`fitItem`); a page
    // whose cursor or form is wrong does.
    const answered = answeredPageSchema.safeParse(page);
    if (!answered.success) {
      return { failure: { code: "failed" } };
    }
    const parsed = syncPageSchema.safeParse({
      ...answered.data,
      items: answered.data.items.flatMap(
        (item) => fitItem(item, definition.kind) ?? []
      ),
    });
    return parsed.success
      ? { page: parsed.data }
      : { failure: { code: "failed" } };
  },
});

// Paging a provider's pages into sync pages, for any sync: a page stops
// once its requests, its content or its time reach `syncPageLimits`, and
// answers what it has. Its cursor names the key of the last entry it
// handled in the provider's page, never a position: the next read goes on
// after that entry, or handles the provider's page again from its start
// if the entry is no longer there. Handling an entry again changes nothing
// (core keys each version), and an entry that an earlier one's removal
// moves up is never skipped.

const cursorPartPattern = /^[\w-]*$/u;

/**
 * A part of a cursor: any text (a provider's token, an entry's key) as
 * base64url, so it stays in the cursor's alphabet; empty for null. Join
 * parts with `.`.
 */
export const cursorPart = (value: string | null): string =>
  btoa(String.fromCodePoint(...new TextEncoder().encode(value ?? "")))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

/**
 * The text a part of a cursor holds, null for empty. A part this kit
 * didn't write starts the source over.
 */
export const fromCursorPart = (value: string | undefined): string | null => {
  if (value === undefined || !cursorPartPattern.test(value)) {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(
      atob(value.replaceAll("-", "+").replaceAll("_", "/")),
      (character) => character.codePointAt(0) ?? 0
    );
  } catch {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
  const text = new TextDecoder().decode(bytes);
  return text === "" ? null : text;
};

/** What a page has left: requests, content bytes, and until when. */
export interface SyncRoom {
  requests: number;
  bytes: number;
  /** In ms since the epoch. */
  deadline: number;
  /**
   * Whether it holds no entry yet: an empty page takes its first entry
   * whatever it costs (without content that doesn't fit), so every read
   * moves on.
   */
  empty: boolean;
}

/** A page's whole room, until `deadline`. */
export const syncRoom = (deadline: number): SyncRoom => ({
  requests: syncPageLimits.requests,
  bytes: syncPageLimits.contentBytes,
  deadline,
  empty: true,
});

/** Bytes `content` takes in a page, as JSON. */
export const contentSize = (content: SyncContent): number =>
  new TextEncoder().encode(JSON.stringify(content)).byteLength;

/**
 * Takes room for `content` if the page has it; else none fits: null, or,
 * on an empty page, the content left out (`{ content: null }`).
 */
export const takeContent = (
  room: SyncRoom,
  content: SyncContent
): { content: SyncContent | null } | null => {
  const size = contentSize(content);
  if (size <= room.bytes) {
    room.bytes -= size;
    return { content };
  }
  return room.empty ? { content: null } : null;
};

/**
 * Whether a request may start: requests and time left. A request that
 * starts goes through `fetchInRoom`, so it is given up at the deadline.
 */
export const mayRequest = (room: SyncRoom): boolean =>
  room.requests > 0 && Date.now() < room.deadline;

/** What one entry of a provider's page gives a sync page. */
export type EntryItems =
  | readonly SyncItem[]
  /** No room or time was left to start it: the next read takes it. */
  | "full"
  /** Its own request ran past the page's deadline. */
  | "late";

/**
 * Where a read is inside a provider's page: after the entry keyed `after`
 * (null: from its start), and the key of an entry that ran late on the
 * read before (`late`), so a second late answer in a row passes it over.
 */
export interface InPage {
  after: string | null;
  late: string | null;
}

/** The start of a provider's page. */
export const startOfPage: InPage = { after: null, late: null };

/**
 * `InPage` as one part of a cursor: its two keys as `cursorPart`s joined
 * by `~`, which base64url never holds.
 */
export const inPagePart = ({ after, late }: InPage): string =>
  `${cursorPart(after)}~${cursorPart(late)}`;

/** The `InPage` a part of a cursor holds; a part this kit didn't write starts over. */
export const fromInPagePart = (value: string | undefined): InPage => {
  const parts = value?.split("~") ?? [];
  if (parts.length !== 2) {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
  const [after, late] = parts.map(fromCursorPart);
  return { after: after ?? null, late: late ?? null };
};

/** How a page is filled from one of a provider's pages (`fillPage`). */
export interface PageFill<Entry> {
  room: SyncRoom;
  entries: readonly Entry[];
  /** Where the read is in this page, from the cursor. */
  at: InPage;
  keyOf: (entry: Entry) => string;
  itemsFor: (entry: Entry) => Promise<EntryItems>;
  /**
   * The items of an entry passed over, with no request: what it is,
   * without its content (`content: null`), or nothing if nothing of it is
   * known without one.
   */
  passOver: (entry: Entry) => readonly SyncItem[];
}

/**
 * The items of a provider's page `entries` after the one `at` names (all
 * of them when it isn't there), until the page is full: the items, where
 * the next read goes on (`at`), and whether every entry was handled.
 *
 * Every connector's page follows the same rules here, so no read can stall
 * a source:
 *
 * - An entry whose own request ran past the deadline ("late") is left for
 *   the next page. On a page that holds nothing yet, it is passed over
 *   (`passOver`, its content left out) only when it ran late on the read
 *   before too: the first time, the page answers nothing, marking it in
 *   its cursor, so one slow answer (or a listing that used up the page's
 *   time) never costs an entry its content, and one that is always too
 *   slow costs one read more, then moves on.
 * - A page that can't even start its first entry ("full": its time ran out
 *   reading the provider's page) moves nothing on: it fails as throttled,
 *   without a time, so the caller backs off, never answering the same
 *   cursor as a page with more to read at once.
 */
export const fillPage = async <Entry>({
  room,
  entries,
  at,
  keyOf,
  itemsFor,
  passOver,
}: PageFill<Entry>): Promise<{
  items: SyncItem[];
  at: InPage;
  done: boolean;
}> => {
  const from =
    at.after === null
      ? 0
      : entries.findIndex((entry) => keyOf(entry) === at.after) + 1;
  const items: SyncItem[] = [];
  let last = at.after;
  for (const entry of entries.slice(from)) {
    // oxlint-disable-next-line no-await-in-loop -- one entry after another, within the page's room
    const found = await itemsFor(entry);
    if (found === "full" || found === "late") {
      if (!room.empty) {
        return { items, at: { after: last, late: null }, done: false };
      }
      if (found === "full") {
        throw new ToolError("The page's time ran out before it took anything", {
          code: "throttled",
        });
      }
      const key = keyOf(entry);
      if (at.late !== key) {
        return { items, at: { after: last, late: key }, done: false };
      }
      items.push(...passOver(entry));
    } else {
      items.push(...found);
    }
    room.empty = false;
    last = keyOf(entry);
  }
  return { items, at: { after: last, late: null }, done: true };
};

/**
 * Whether a read failed because its answer is larger than connect's egress
 * reads of one (`egressTooLargeMessage`), and nothing else: a connection
 * dropped while it came is another failure, to try again.
 */
export const isTooLarge = (error: unknown): boolean =>
  error instanceof Error && error.message === egressTooLargeMessage;

/**
 * Sends one GET and reads its whole answer before `deadline` (ms since the
 * epoch): the answer, its body already read, or "late" when the deadline
 * cut it off, before its headers or while its body still came. A sync
 * takes "late" as no room left on its page, so a page answers in time with
 * what it has, and a file that always takes too long is passed over by a
 * page that holds nothing else.
 */
export const fetchBefore = async (
  url: URL,
  deadline: number,
  /** The request's own headers, such as a provider's `Prefer`. */
  init: Pick<RequestInit, "headers"> = {}
): Promise<Response | "late"> => {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 0)),
    });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return "late";
    }
    throw error;
  }
};

/**
 * Sends one GET of a page, counted against its requests, and reads its
 * whole answer before the page's deadline (`fetchBefore`): "late" when the
 * deadline cut it off, before its headers or while its body still came.
 */
export const fetchInRoom = async (
  room: SyncRoom,
  url: URL,
  init: Pick<RequestInit, "headers"> = {}
): Promise<Response | "late"> => {
  room.requests -= 1;
  return await fetchBefore(url, room.deadline, init);
};
