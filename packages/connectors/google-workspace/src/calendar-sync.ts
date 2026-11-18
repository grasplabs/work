import { ToolError } from "@grasp-os/connector-kit/connector";
import {
  RestartSyncError,
  cursorPart,
  defineSync,
  fetchInRoom,
  fillPage,
  fromCursorPart,
  fromInPagePart,
  inPagePart,
  startOfPage,
  syncRoom,
  takeContent,
} from "@grasp-os/connector-kit/sync";
import type { InPage, SyncRoom } from "@grasp-os/connector-kit/sync";
import type { SyncItem, SyncPage, SyncReader } from "@grasp-os/shared/sync";
import { ownPlace } from "@grasp-os/shared/sync";
import { z } from "zod";

import { apisHost, googleFailure, googleUrl } from "./google.ts";

// Native sync of a person's own calendar (GRA-1758): every event in it,
// then what changed and what was cancelled. A calendar's one reader is
// its owner; core keeps events in the owner's own store, so attendees
// aren't readers.
//
// Which calendar: the person's primary one, the calendar that is theirs
// alone. Others' calendars shared with them, and groups', are synced by
// their owners, or come as picked places of a shared connection.
//
// How it reads (Calendar's "Synchronize resources efficiently"): a full
// listing, page by page, whose last page gives a sync token; from then on,
// only what changed since that token, cancelled events included. A 410 on
// the token lists again from the start. A recurring event is one item, its
// rule in its text; an exception to it is an item of its own.
//
// Where a read stops, and where the next goes on: the kit's paging
// (`fillPage`). An entry's key is the event's ID with its `updated` time,
// so an event changed again is no longer the entry handled.

const primary = "/calendar/v3/calendars/primary";
const events = `${primary}/events`;
/**
 * The person's own entry for their primary calendar, whose ID is their
 * address: calendarList.get takes `primary` and needs only
 * `calendar.calendarlist.readonly`, which the connection holds, while
 * calendars.get needs `calendar.calendars.readonly` or more, which it
 * doesn't.
 * https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/get
 */
const primaryEntry = "/calendar/v3/users/me/calendarList/primary";

/** Events asked of Google per page. */
const calendarPageSize = 250;

const calendarSchema = z.object({ id: z.string().min(1) });

/**
 * When an event starts or ends (Calendar's Events resource): a time with
 * its offset, or a whole day, and the IANA zone it is kept in. The zone
 * says when a repeating event's later times fall: a weekly 09:00 in
 * Europe/Amsterdam stays 09:00 there when its offset changes for daylight
 * saving.
 */
const timeSchema = z
  .object({
    dateTime: z.string().nullish(),
    date: z.string().nullish(),
    timeZone: z.string().nullish(),
  })
  .nullish();

const personSchema = z
  .object({
    email: z.string().nullish(),
    displayName: z.string().nullish(),
  })
  .nullish();

const eventSchema = z.object({
  id: z.string(),
  status: z.string().nullish(),
  etag: z.string().nullish(),
  updated: z.string().nullish(),
  summary: z.string().nullish(),
  description: z.string().nullish(),
  location: z.string().nullish(),
  start: timeSchema,
  end: timeSchema,
  recurrence: z.array(z.string()).nullish(),
  organizer: personSchema,
  attendees: z.array(personSchema).nullish(),
});
type CalendarEvent = z.infer<typeof eventSchema>;

const eventsSchema = z.object({
  items: z.array(eventSchema).nullish(),
  nextPageToken: z.string().nullish(),
  nextSyncToken: z.string().nullish(),
});

/**
 * Where a read is: in the full listing, or in the changes since `sync`;
 * in Google's page `token`, where in it (`at`).
 */
interface Position {
  sync: string | null;
  token: string | null;
  at: InPage;
}

const cursorOf = ({ sync, token, at }: Position): string =>
  `${sync === null ? "f" : "s"}.${cursorPart(sync)}.${cursorPart(token)}.${inPagePart(at)}`;

/** The position a cursor this sync wrote names; any other starts over. */
const positionOf = (cursor: string): Position => {
  const [phase, ...parts] = cursor.split(".");
  const [sync, token] = parts.slice(0, 2).map(fromCursorPart);
  const known =
    parts.length === 3 &&
    ((phase === "f" && sync === null) || (phase === "s" && sync !== null));
  if (!known) {
    throw new RestartSyncError("Not a cursor this sync wrote");
  }
  return {
    sync: sync ?? null,
    token: token ?? null,
    at: fromInPagePart(parts[2]),
  };
};

/** One GET, read before the page's deadline: its JSON; a 410 starts over. */
const getJson = async <Schema extends z.ZodType>(
  room: SyncRoom,
  url: URL,
  schema: Schema
): Promise<z.output<Schema>> => {
  const response = await fetchInRoom(room, url);
  if (response === "late") {
    throw new ToolError("Calendar didn't answer in time", {
      code: "unavailable",
    });
  }
  if (response.status === 410) {
    await response.body?.cancel();
    throw new RestartSyncError();
  }
  if (!response.ok) {
    throw await googleFailure(response);
  }
  return schema.parse(await response.json());
};

/** When an event is, as its text says it, in its zone when Google names one. */
const whenOf = (time: z.output<typeof timeSchema>): string => {
  const when = time?.dateTime ?? time?.date ?? "";
  const zone = time?.timeZone ?? "";
  return zone === "" ? when : `${when} (${zone})`;
};

/** A person as an event names them. */
const personOf = (person: z.output<typeof personSchema>): string => {
  const name = person?.displayName ?? "";
  const email = person?.email ?? "";
  return name === "" ? email : `${name} <${email}>`;
};

/** A line of an event's text: none for an empty value. */
const line = (label: string, value: string | null | undefined): string[] =>
  value === null || value === undefined || value === ""
    ? []
    : [`${label}: ${value}`];

/** An event's text: what people read of it in their calendar. */
const textOf = (event: CalendarEvent): string =>
  [
    `Title: ${event.summary ?? ""}`,
    `Start: ${whenOf(event.start)}`,
    `End: ${whenOf(event.end)}`,
    ...(event.recurrence ?? []).flatMap((rule) => line("Repeats", rule)),
    ...line("Location", event.location),
    ...line(
      "Organizer",
      event.organizer === null || event.organizer === undefined
        ? null
        : personOf(event.organizer)
    ),
    ...line("Attendees", (event.attendees ?? []).map(personOf).join(", ")),
    "",
    event.description ?? "",
  ].join("\n");

/** What one event makes: the event as it now is, or gone. */
const eventItems = (
  room: SyncRoom | null,
  owner: SyncReader[],
  event: CalendarEvent
): SyncItem[] | "full" => {
  if (event.status === "cancelled") {
    return [{ gone: true, id: event.id, kind: "event" }];
  }
  // Passed over (no room): without its content.
  const kept =
    room === null
      ? { content: null }
      : takeContent(room, { type: "text", text: textOf(event) });
  if (kept === null) {
    return "full";
  }
  const updated = event.updated ?? "";
  return [
    {
      gone: false,
      id: event.id,
      kind: "event",
      // Moves with every change of the event.
      version: event.etag ?? updated,
      changedAt: updated,
      title: event.summary ?? "",
      content: kept.content,
      readers: owner,
      changedBy: null,
      partOf: null,
    },
  ];
};

/** One page of the listing, or of the changes. */
const eventsPage = async (
  room: SyncRoom,
  owner: SyncReader[],
  position: Position
): Promise<SyncPage> => {
  const read = await getJson(
    room,
    googleUrl(
      apisHost,
      events,
      {
        maxResults: String(calendarPageSize),
        ...(position.sync === null ? {} : { syncToken: position.sync }),
      },
      position.token ?? undefined
    ),
    eventsSchema
  );
  const { items, at, done } = await fillPage({
    room,
    entries: read.items ?? [],
    at: position.at,
    keyOf: (event) => `${event.id}@${event.updated ?? ""}`,
    // oxlint-disable-next-line require-await -- the kit's paging takes a promise
    itemsFor: async (event) => eventItems(room, owner, event),
    // An event needs no request of its own: it is never late. Were it,
    // it would come without its content.
    passOver: (event) => {
      const passed = eventItems(null, owner, event);
      return passed === "full" ? [] : passed;
    },
  });
  if (!done) {
    return {
      items,
      cursor: cursorOf({ ...position, at }),
      more: true,
    };
  }
  const next = read.nextPageToken ?? "";
  if (next !== "") {
    return {
      items,
      cursor: cursorOf({ ...position, token: next, at: startOfPage }),
      more: true,
    };
  }
  const sync = read.nextSyncToken ?? "";
  if (sync === "") {
    throw new ToolError("Calendar's last page has no sync token", {
      code: "failed",
    });
  }
  return {
    items,
    cursor: cursorOf({ sync, token: null, at: startOfPage }),
    more: false,
  };
};

/** The person's own calendar: every event, its changes and cancellations. */
export const calendarSync = defineSync({
  name: "calendar",
  kind: "event",
  routes: [
    { method: "GET", host: apisHost, path: primaryEntry },
    { method: "GET", host: apisHost, path: events },
  ],
  read: async ({ place, cursor, deadline }) => {
    if (place !== ownPlace) {
      throw new ToolError("This sync reads the person's own calendar only", {
        code: "failed",
      });
    }
    const room = syncRoom(deadline);
    // Whose calendar: its ID is its owner's address, its one reader.
    const calendar = await getJson(
      room,
      googleUrl(apisHost, primaryEntry),
      calendarSchema
    );
    const owner: SyncReader[] = [
      { kind: "account", id: calendar.id.toLowerCase() },
    ];
    return await eventsPage(
      room,
      owner,
      cursor === null
        ? { sync: null, token: null, at: startOfPage }
        : positionOf(cursor)
    );
  },
});
