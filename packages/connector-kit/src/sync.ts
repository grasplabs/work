import { syncPageSchema } from "@grasp-os/shared/sync";
import type {
  SyncContent,
  SyncItem,
  SyncItemKind,
  SyncPage,
} from "@grasp-os/shared/sync";
import { z } from "zod";

import { ToolError } from "./connector.ts";
import { maxContentBytes } from "./content.ts";
import {
  connectorIsolateRequests,
  syncManifestSchema,
  syncNameSchema,
  syncParamsSchema,
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
}

/** A sync, as a connector carries it. */
export interface Sync {
  name: string;
  manifest: SyncManifest;
  /** Answers `syncMethod`'s params with a page or a failure. */
  call: (params: unknown) => Promise<SyncResult>;
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

/** A sync, from its definition. */
export const defineSync = (definition: SyncDefinition): Sync => ({
  name: syncNameSchema.parse(definition.name),
  manifest: syncManifestSchema.parse({
    kind: definition.kind,
    routes: definition.routes,
  }),
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
    const parsed = syncPageSchema.safeParse(page);
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

/** How a page is filled from one of a provider's pages (`fillPage`). */
export interface PageFill<Entry> {
  room: SyncRoom;
  entries: readonly Entry[];
  /** The key of the last entry handled, from the cursor; null from the start. */
  after: string | null;
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
 * The items of a provider's page `entries` after the one keyed `after`
 * (all of them when it isn't there), until the page is full: the items,
 * the key of the last entry handled, and whether every one was.
 *
 * Every connector's page follows the same rules here, so no read can stall
 * a source:
 *
 * - An entry whose own request ran past the deadline ("late") is left for
 *   the next page, unless the page holds nothing yet: then it is passed
 *   over (`passOver`, its content left out), so an entry that is always too
 *   slow can't stop the source.
 * - A page that can't even start its first entry ("full": its time ran out
 *   reading the provider's page) moves nothing on: it fails as throttled,
 *   without a time, so the caller backs off, never answering the same
 *   cursor as a page with more to read at once.
 */
export const fillPage = async <Entry>({
  room,
  entries,
  after,
  keyOf,
  itemsFor,
  passOver,
}: PageFill<Entry>): Promise<{
  items: SyncItem[];
  last: string | null;
  done: boolean;
}> => {
  const from =
    after === null
      ? 0
      : entries.findIndex((entry) => keyOf(entry) === after) + 1;
  const items: SyncItem[] = [];
  let last = after;
  for (const entry of entries.slice(from)) {
    // oxlint-disable-next-line no-await-in-loop -- one entry after another, within the page's room
    const found = await itemsFor(entry);
    if (found === "full" || found === "late") {
      if (!room.empty) {
        return { items, last, done: false };
      }
      if (found === "full") {
        throw new ToolError("The page's time ran out before it took anything", {
          code: "throttled",
        });
      }
      items.push(...passOver(entry));
    } else {
      items.push(...found);
    }
    room.empty = false;
    last = keyOf(entry);
  }
  return { items, last, done: true };
};

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
  deadline: number
): Promise<Response | "late"> => {
  try {
    const response = await fetch(url, {
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
  url: URL
): Promise<Response | "late"> => {
  room.requests -= 1;
  return await fetchBefore(url, room.deadline);
};
