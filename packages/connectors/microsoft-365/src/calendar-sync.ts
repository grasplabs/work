import { ToolError } from "@grasp-os/connector-kit/connector";
import {
  cursorPart,
  defineSync,
  fetchInRoom,
  fillPage,
  fromInPagePart,
  inPagePart,
  startOfPage,
  fromCursorPart,
  mayRequest,
  RestartSyncError,
  syncRoom,
  takeContent,
} from "@grasp-os/connector-kit/sync";
import type { InPage, SyncRoom } from "@grasp-os/connector-kit/sync";
import type { SyncItem, SyncPage, SyncReader } from "@grasp-os/shared/sync";
import { ownPlace } from "@grasp-os/shared/sync";
import { z } from "zod";

import { graphFailure, graphHost, graphUrl, v1 } from "./graph.ts";

// Native sync of a person's own Outlook calendar (GRA-1759, PR H): every
// event of their primary calendar within a window, then what changed and
// what went away. An event is readable only by the calendar's own person:
// its only reader is them, and it lives in their own store.
//
// How it reads: calendarView delta, the change feed Graph v1.0 has for
// events, which reads a window of the person's primary calendar
// (https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0).
// A calendar view holds each occurrence of a recurring event as an event
// of its own. The window is one year back and one year ahead of when the
// listing began: the window the plan on GRA-1719 (part 3) set, since v1.0
// has no delta without one. The sync run's daily full relisting (PR I)
// starts a new listing, and so moves the window, every day; a listing
// older than a year lists again from the start (`sync.restart`) anyway.
// Graph's next and delta links are never followed: only their
// `$skiptoken` or `$deltatoken` is kept, which carry the window
// ("Microsoft Graph automatically encodes any specified parameters into
// the token portion"), and the request is built here.
//
// What goes away: an event under `@removed` (deleted, or "outside the date
// range" and changed), and a cancelled event (`isCancelled`). A token
// Graph no longer knows (410, `syncStateNotFound`) lists again.
//
// What is left out: calendars other than the primary one (calendarView
// delta reads the primary calendar only in v1.0), events outside the
// window, and events' attachments.
//
// Pages: an event comes whole in the feed, body and all, and calendarView
// delta takes no `$select`, so Graph is asked for one event per page
// (`Prefer: odata.maxpagesize=1`, event-delta): an answer of several
// large events could pass what connect's egress reads of one answer
// (10 MiB). Each of our pages follows Graph's pages, a request each, until
// the round's delta link, its requests, its content or the kit's deadline;
// it goes on from the next skip token, so it never stops inside Graph's
// page. Should Graph send more than one event a page anyway, a page that
// stops inside it goes on after the last event handled, by its ID and
// `changeKey`, or at the top of Graph's page when that event isn't there
// as it was.
//
// NEEDS A REAL TENANT TO CONFIRM (not documented by Microsoft):
// - That a token read again answers the same events in the same order,
//   less those changed since, should a page hold more than one.
// - An event whose own answer is over the egress's 10 MiB fails its page
//   every time; Exchange takes items larger than that.
// - That `outlook.body-content-type` applies to calendarView delta, as it
//   does to a calendar view; if not, a body comes as HTML, still text.

const me = "/me";
const delta = `${me}/calendarView/delta`;

/** A year, in ms: the window's reach either side of the listing's start. */
const year = 365 * 24 * 60 * 60 * 1000;

/**
 * One event per page, immutable IDs, bodies as text, times in UTC
 * (event-delta, Prefer).
 */
const prefer =
  'odata.maxpagesize=1, IdType="ImmutableId", outlook.body-content-type="text", outlook.timezone="UTC"';

const dateTimeSchema = z
  .object({ dateTime: z.string().nullish(), timeZone: z.string().nullish() })
  .nullish();

const addressSchema = z
  .object({
    emailAddress: z
      .object({
        name: z.string().nullish(),
        address: z.string().nullish(),
      })
      .nullish(),
  })
  .nullish();

/**
 * One entry of the feed: an event as it now is, or one removed
 * (https://learn.microsoft.com/en-us/graph/api/resources/event?view=graph-rest-1.0).
 */
const eventSchema = z.object({
  id: z.string().min(1),
  "@removed": z.unknown().optional(),
  changeKey: z.string().nullish(),
  lastModifiedDateTime: z.string().nullish(),
  subject: z.string().nullish(),
  body: z.object({ content: z.string().nullish() }).nullish(),
  start: dateTimeSchema,
  end: dateTimeSchema,
  isAllDay: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
  location: z.object({ displayName: z.string().nullish() }).nullish(),
  organizer: addressSchema,
  attendees: z.array(addressSchema).nullish(),
});
type Event = z.infer<typeof eventSchema>;

const feedSchema = z.object({
  value: z.array(eventSchema),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

const meSchema = z.object({ id: z.string().min(1) });

/**
 * Where a read is: when the listing began (its window's middle), Graph's
 * token to read from (none: the listing's start), and where it is inside
 * that token's page (the kit's `InPage`, events keyed by `keyOf`).
 */
interface Position {
  began: number;
  token: { kind: "skip" | "delta"; value: string } | null;
  at: InPage;
}

/** An event's key in Graph's page: its ID and `changeKey`. */
const keyOf = ({ id, changeKey }: Event): string => `${id}\n${changeKey ?? ""}`;

const notOurs = (): RestartSyncError =>
  new RestartSyncError("Not a cursor this sync wrote");

const kinds: Readonly<Record<string, "skip" | "delta" | null>> = {
  s: "skip",
  d: "delta",
  n: null,
};

/**
 * The cursor of a position: `e.<began>.<s|d|n>.<token>.<at>` (a skip
 * token, a delta token, or none; where it is in the token's page).
 */
const cursorOf = ({ began, token, at }: Position): string => {
  const kind = token === null ? "n" : token.kind.charAt(0);
  return `e.${began}.${kind}.${cursorPart(token?.value ?? null)}.${inPagePart(at)}`;
};

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [tag, began = "", kind = "", token, at, ...rest] = cursor.split(".");
  const tokenKind = Object.hasOwn(kinds, kind) ? kinds[kind] : undefined;
  if (
    tag !== "e" ||
    !/^\d{1,15}$/u.test(began) ||
    tokenKind === undefined ||
    rest.length > 0
  ) {
    throw notOurs();
  }
  const value = fromCursorPart(token);
  if ((tokenKind === null) !== (value === null)) {
    throw notOurs();
  }
  return {
    began: Number(began),
    token:
      tokenKind === null || value === null ? null : { kind: tokenKind, value },
    at: fromInPagePart(at),
  };
};

/** The token a link Graph handed back carries; the link is never followed. */
const tokenOf = (
  link: string,
  kind: "skip" | "delta"
): { kind: "skip" | "delta"; value: string } => {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new ToolError("Graph's link isn't a URL", { code: "failed" });
  }
  const value = url.searchParams.get(`$${kind}token`) ?? "";
  if (url.hostname !== graphHost || value === "") {
    throw new ToolError("Graph's link has no token", { code: "failed" });
  }
  return { kind, value };
};

/** An ISO 8601 time in UTC, to the second, as calendarView takes it. */
const isoOf = (time: number): string =>
  new Date(time).toISOString().replace(/\.\d+Z$/u, "Z");

/** One page of the feed: from a token, or the listing's start. */
const feedPage = async (room: SyncRoom, position: Position) => {
  const { token, began } = position;
  const url =
    token === null
      ? graphUrl(delta, {
          startDateTime: isoOf(began - year),
          endDateTime: isoOf(began + year),
        })
      : graphUrl(delta, { [`$${token.kind}token`]: token.value });
  // Read whole before the page's deadline (the kit's `fetchInRoom`).
  const response = await fetchInRoom(room, url, { headers: { prefer } });
  if (response === "late") {
    return "late";
  }
  if (response.status === 410 || (response.status === 404 && token !== null)) {
    throw new RestartSyncError();
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  return feedSchema.parse(await response.json());
};

/**
 * What a late read stands for when the page has nothing yet: Graph is
 * slow, and the page waits as for a rate limit.
 */
const tooSlow = (): ToolError =>
  new ToolError("Microsoft 365 didn't answer in time", {
    code: "unavailable",
  });

/** A person, as an event's line writes them. */
const addressOf = (person: z.infer<typeof addressSchema>): string => {
  const name = person?.emailAddress?.name ?? "";
  const address = person?.emailAddress?.address ?? "";
  if (name === "" || name === address) {
    return address;
  }
  return address === "" ? name : `${name} <${address}>`;
};

/** A start or end, as an event's line writes it. */
const whenOf = (time: z.infer<typeof dateTimeSchema>): string =>
  [time?.dateTime ?? "", time?.timeZone ?? ""].filter(Boolean).join(" ");

/** An event's text: its lines, then its body as text. */
const textOf = (event: Event): string => {
  const lines = [
    ["Subject", event.subject ?? ""],
    ["Start", whenOf(event.start)],
    ["End", whenOf(event.end)],
    ["All day", event.isAllDay === true ? "yes" : ""],
    ["Location", event.location?.displayName ?? ""],
    ["Organizer", addressOf(event.organizer)],
    ["Attendees", (event.attendees ?? []).map(addressOf).join(", ")],
  ]
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value}`);
  return `${lines.join("\n")}\n\n${event.body?.content ?? ""}`;
};

const goneOf = (id: string): SyncItem => ({ gone: true, id, kind: "event" });

/**
 * The item an event now is, gone, or "full" when the page has no room
 * left for it (the page's first takes it without its content).
 */
const itemOf = (
  room: SyncRoom,
  owner: SyncReader[],
  event: Event
): SyncItem | "full" => {
  if (event["@removed"] !== undefined || event.isCancelled === true) {
    return goneOf(event.id);
  }
  const changedAt = event.lastModifiedDateTime ?? "";
  const changeKey = event.changeKey ?? "";
  if (changedAt === "" || changeKey === "") {
    throw new ToolError("Graph's event has no change key or time", {
      code: "failed",
    });
  }
  // The kit's `takeContent`: an empty page takes it without content.
  const taken = takeContent(room, { type: "text", text: textOf(event) });
  if (taken === null) {
    return "full";
  }
  return {
    gone: false,
    id: event.id,
    kind: "event",
    version: changeKey,
    changedAt,
    title: event.subject ?? "",
    content: taken.content,
    readers: owner,
    changedBy: null,
    partOf: null,
  };
};

/**
 * An event passed over (the kit's `passOver`), with no request: gone, or
 * itself without its content. An event comes whole in its feed page and
 * takes no request of its own, so the kit never passes one over now; it
 * is what an event is without room.
 */
const passOverEvent = (owner: SyncReader[], event: Event): SyncItem[] => {
  const room = { requests: 0, bytes: 0, deadline: 0, empty: true };
  const item = itemOf(room, owner, event);
  return item === "full" ? [] : [item];
};

/**
 * The last of each event's entries: an event that changed twice in a round
 * may come twice; its last entry counts.
 */
const lastOfEach = (items: readonly SyncItem[]): SyncItem[] => {
  const last = new Map(items.map((item, index) => [item.id, index]));
  return items.filter((item, index) => last.get(item.id) === index);
};

/** The person's own Entra object ID, their events' only reader. */
const ownerOf = async (room: SyncRoom): Promise<SyncReader[]> => {
  const response = await fetchInRoom(room, graphUrl(me, { $select: "id" }), {
    headers: { prefer },
  });
  if (response === "late") {
    throw tooSlow();
  }
  if (!response.ok) {
    throw await graphFailure(response);
  }
  const { id } = meSchema.parse(await response.json());
  return [{ kind: "account", id: id.toLowerCase() }];
};

/** Where the feed goes on once Graph's page is done, and whether it's due. */
const nextOf = (
  position: Position,
  feed: z.infer<typeof feedSchema>
): { position: Position; more: boolean } => {
  const next = feed["@odata.nextLink"];
  const end = feed["@odata.deltaLink"];
  if (next === undefined && end === undefined) {
    throw new ToolError("Graph's page has no link on", { code: "failed" });
  }
  return {
    position: {
      began: position.began,
      token:
        next === undefined
          ? tokenOf(end ?? "", "delta")
          : tokenOf(next, "skip"),
      at: startOfPage,
    },
    more: next !== undefined,
  };
};

/**
 * The events of one page of Graph's from `position` on, while the page has
 * room: how far it got, the items, and where to go on.
 */
const takePage = async (
  room: SyncRoom,
  owner: SyncReader[],
  position: Position
): Promise<{
  items: SyncItem[];
  at: Position;
  more: boolean;
  done: boolean;
}> => {
  const feed = await feedPage(room, position);
  if (feed === "late") {
    // Cut off by the page's deadline: the page answers with what it has,
    // or, holding nothing yet, waits as for a rate limit.
    if (room.empty) {
      throw tooSlow();
    }
    return { items: [], at: position, more: true, done: false };
  }
  // The kit's `fillPage`: after the event handled, by its key, or from the
  // top of Graph's page when that event isn't there as it was.
  const filled = await fillPage({
    room,
    entries: feed.value,
    at: position.at,
    keyOf,
    // oxlint-disable-next-line require-await -- the kit's fillPage takes a promise
    itemsFor: async (event) => {
      if (!room.empty && Date.now() >= room.deadline) {
        return "full";
      }
      const item = itemOf(room, owner, event);
      return item === "full" ? "full" : [item];
    },
    passOver: (event) => passOverEvent(owner, event),
  });
  if (!filled.done) {
    return {
      items: filled.items,
      at: { ...position, at: filled.at },
      more: true,
      done: false,
    };
  }
  const next = nextOf(position, feed);
  return {
    items: filled.items,
    at: next.position,
    more: next.more,
    done: true,
  };
};

/** One page of the person's own calendar from `position` on. */
const readPage = async (
  position: Position,
  deadline: number
): Promise<SyncPage> => {
  if (Date.now() - position.began > year) {
    // The window has moved a year: list again from the start.
    throw new RestartSyncError("The calendar's window moved");
  }
  const room = syncRoom(deadline);
  const owner = await ownerOf(room);
  const items: SyncItem[] = [];
  let at = position;
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one page of Graph's after another
    const page = await takePage(room, owner, at);
    items.push(...page.items);
    ({ at } = page);
    const roomLeft = room.empty ? room.requests > 0 : mayRequest(room);
    if (!page.done || !page.more || !roomLeft) {
      return {
        items: lastOfEach(items),
        cursor: cursorOf(at),
        more: page.more,
      };
    }
  }
};

/** The person's own calendar: its events in the window, changes and removals. */
export const calendarSync = defineSync({
  name: "calendar",
  kind: "event",
  routes: [
    { method: "GET", host: graphHost, path: `${v1}${me}` },
    { method: "GET", host: graphHost, path: `${v1}${delta}` },
  ],
  read: async ({ place, cursor, deadline }) => {
    if (place !== ownPlace) {
      throw new ToolError("This sync reads the person's own calendar only", {
        code: "failed",
      });
    }
    return await readPage(
      cursor === null
        ? { began: Date.now(), token: null, at: startOfPage }
        : positionOf(cursor),
      deadline
    );
  },
});
