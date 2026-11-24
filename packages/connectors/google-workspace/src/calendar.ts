import {
  defineTool,
  invalidCode,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import type { Effect } from "@grasp-os/connector-kit/connector";
import { forbiddenInValue } from "@grasp-os/connector-kit/manifest";
import { jsonBody, segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  apisHost,
  googleJson,
  googleUrl,
  idSchema,
  nextPageOf,
  pageSchema,
  topSchema,
} from "./google.ts";

// Calendars, one per call, as `/calendar/v3/calendars/{calendar}` with the
// calendar's ID, so a call's capability binds every request to it. The
// calendar may be a group's or a colleague's shared with the person, so
// these tools reach `company`. Times come back in UTC.
//
// Which calendars. A calendar's ID is an address: a person's own calendar
// is their email address, other calendars `...@group.calendar.google.com`.
// Google's `primary` alias isn't one, so it is refused, as `me` is for
// mail. Nor are the calendars whose IDs hold a `#` (national holidays,
// `en.dutch#holiday@group.v.calendar.google.com`, and contacts' birthdays,
// `addressbook#contacts@group.v.calendar.google.com`): a `#` can't stand
// in a path parameter, which the egress refuses so a value can't end the
// path early. Those calendars hold no organization's data, so they are
// left out rather than widening what a parameter may hold.
//
// Writes. `calendar.create` puts an event in the person's own calendar
// only, with nobody invited. `calendar.events` would let it write any
// calendar shared with the person, so before it writes it reads the
// calendar's entry in the person's own calendar list
// (`/users/me/calendarList/{calendar}`, `me` being the token's person,
// the calendar still bound to the capability's) and goes no further
// unless Google says it is their primary one. Its input has no guests, it
// sends none, and Google is told to notify nobody (`sendUpdates=none`).
// The event's ID is the call's effect key (64 lowercase hex characters,
// which Google's event IDs allow), so the same call can't make a second
// event, and a call of unknown outcome is found by that ID.

const calendars = "/calendar/v3/calendars/{calendar}";

/** The person's own entry for a calendar: whether it is their primary. */
const calendarEntry = "/calendar/v3/users/me/calendarList/{calendar}";

/**
 * A calendar's ID: one address, and nothing the egress refuses in a path
 * parameter, `#` and control characters included.
 */
const calendarPattern = new RegExp(
  `^[^${forbiddenInValue}@\\s]+@[^${forbiddenInValue}@\\s]+$`,
  "u"
);

const calendarSchema = z.string().min(3).max(256).regex(calendarPattern);

const googleTime = z.object({
  dateTime: z.string().nullish(),
  date: z.string().nullish(),
});

const googlePerson = z.object({
  email: z.string().nullish(),
  displayName: z.string().nullish(),
});

const googleEvent = z
  .object({
    id: z.string(),
    status: z.string().nullish(),
    htmlLink: z.string().nullish(),
    summary: z.string().nullish(),
    description: z.string().nullish(),
    location: z.string().nullish(),
    // A cancelled occurrence of a recurring event, as calendar.get reads
    // one, may have neither start nor end: only the start it had. Any other
    // event has both (the refinement below).
    start: googleTime.nullish(),
    end: googleTime.nullish(),
    originalStartTime: googleTime.nullish(),
    organizer: googlePerson.nullish(),
    recurringEventId: z.string().nullish(),
    attendees: z
      .array(
        googlePerson.extend({
          responseStatus: z.string().nullish(),
          optional: z.boolean().nullish(),
        })
      )
      .nullish(),
    hangoutLink: z.string().nullish(),
  })
  .refine(
    ({ status, start, end }) =>
      status === "cancelled" ||
      (start !== null &&
        start !== undefined &&
        end !== null &&
        end !== undefined),
    { message: "An event that isn't cancelled has a start and an end" }
  );
type GoogleEvent = z.infer<typeof googleEvent>;

const personSchema = z.strictObject({
  name: z.string().nullable(),
  address: z.string().nullable(),
});

const summarySchema = z.strictObject({
  calendar: z.string(),
  id: z.string(),
  subject: z.string().nullable(),
  /**
   * A time in UTC, or a date for an all-day event; empty when Google gave
   * none (a cancelled occurrence has no end).
   */
  start: z.string(),
  end: z.string(),
  isAllDay: z.boolean(),
  isCancelled: z.boolean(),
  location: z.string().nullable(),
  organizer: personSchema.nullable(),
  recurringEventId: z.string().nullable(),
  webLink: z.string().nullable(),
});

const personOf = (
  person: z.infer<typeof googlePerson>
): z.infer<typeof personSchema> => ({
  name: person.displayName ?? null,
  address: person.email ?? null,
});

type GoogleTime = z.infer<typeof googleTime>;

/** A time, or a date for an all-day event, if Google gave either. */
const timeOf = (time: GoogleTime | null | undefined): string | undefined =>
  time?.dateTime ?? time?.date ?? undefined;

const summaryOf = (
  calendar: string,
  event: GoogleEvent
): z.infer<typeof summarySchema> => {
  // Without a start, the start the occurrence had (a cancelled one's);
  // without an end, none: empty, as the schema's strings allow.
  const start =
    timeOf(event.start) === undefined ? event.originalStartTime : event.start;
  return {
    calendar,
    id: event.id,
    subject: event.summary ?? null,
    start: timeOf(start) ?? "",
    end: timeOf(event.end) ?? "",
    isAllDay:
      typeof start?.dateTime !== "string" && typeof start?.date === "string",
    isCancelled: event.status === "cancelled",
    location: event.location ?? null,
    organizer: event.organizer ? personOf(event.organizer) : null,
    recurringEventId: event.recurringEventId ?? null,
    webLink: event.htmlLink ?? null,
  };
};

const eventPage = z.object({
  items: z.array(googleEvent).nullish(),
  nextPageToken: z.string().nullish(),
});

const listEvents = defineTool({
  name: "calendar.list",
  description:
    "Lists the events of a calendar that fall in a range of time, recurring ones as their occurrences, earliest first, in UTC.",
  input: z.strictObject({
    calendar: calendarSchema,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    top: topSchema(100),
    page: pageSchema,
  }),
  output: z.strictObject({
    calendar: z.string(),
    events: z.array(summarySchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  reach: "company",
  resource: "calendar",
  routes: [{ method: "GET", host: apisHost, path: `${calendars}/events` }],
  run: async ({ calendar, start, end, top, page }) => {
    if (Date.parse(end) <= Date.parse(start)) {
      throw new ToolError("The range must end after it starts", {
        code: invalidCode,
      });
    }
    const { items, nextPageToken } = await googleJson(
      googleUrl(
        apisHost,
        `/calendar/v3/calendars/${segment(calendar)}/events`,
        {
          timeMin: start,
          timeMax: end,
          singleEvents: "true",
          orderBy: "startTime",
          timeZone: "UTC",
          maxResults: String(top ?? 25),
        },
        page
      ),
      eventPage
    );
    const events = items ?? [];
    return {
      output: {
        calendar,
        events: events.map((event) => summaryOf(calendar, event)),
        nextPage: nextPageOf(nextPageToken ?? undefined),
      },
      provenance: events.map(({ id }) => id),
    };
  },
});

const getEvent = defineTool({
  name: "calendar.get",
  description:
    "Gets one event of a calendar, with its description and attendees, in UTC.",
  input: z.strictObject({
    calendar: calendarSchema,
    event: idSchema,
  }),
  output: z.strictObject({
    event: summarySchema.extend({
      body: z.string().nullable(),
      attendees: z.array(
        personSchema.extend({
          response: z.string().nullable(),
          optional: z.boolean(),
        })
      ),
      joinUrl: z.string().nullable(),
    }),
  }),
  readOnly: true,
  reach: "company",
  resource: "calendar",
  routes: [
    { method: "GET", host: apisHost, path: `${calendars}/events/{event}` },
  ],
  run: async ({ calendar, event: id }) => {
    const event = await googleJson(
      googleUrl(
        apisHost,
        `/calendar/v3/calendars/${segment(calendar)}/events/${segment(id)}`,
        { timeZone: "UTC" }
      ),
      googleEvent
    );
    return {
      output: {
        event: {
          ...summaryOf(calendar, event),
          body: event.description ?? "",
          attendees: (event.attendees ?? []).map((attendee) => ({
            ...personOf(attendee),
            response: attendee.responseStatus ?? null,
            optional: attendee.optional ?? false,
          })),
          joinUrl: event.hangoutLink ?? null,
        },
      },
      provenance: [event.id],
    };
  },
});

const minutesOnly = "2026-10-26T14:30".length;

/** The same time with its seconds, so that two compare as strings. */
const withSeconds = (time: string): string =>
  time.length === minutesOnly ? `${time}:00` : time;

/**
 * Whether `time` names a day and time that exist: `Date.parse` moves
 * 30 February on to 2 March, and 24:00 on to the next day, so the time it
 * read must read back the same.
 */
const isRealTime = (time: string): boolean => {
  const parsed = Date.parse(`${time}Z`);
  return (
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().startsWith(withSeconds(time))
  );
};

/**
 * A wall-clock time without an offset, `2026-10-26T14:30`, or with
 * seconds: read in the call's time zone, as the person confirming it reads
 * it.
 */
const localTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u)
  .refine(isRealTime, { message: "Not a time" });

/** Whether the runtime knows `timeZone`. */
const isTimeZone = (timeZone: string): boolean => {
  try {
    // oxlint-disable-next-line no-new -- constructing it is the check
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** An IANA time zone, `Europe/Amsterdam`: the organization's. */
const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][\w+-]*(?:\/[\w+-]+)*$/u)
  .refine(isTimeZone, { message: "Not a time zone" });

/** Whether the event shows the person as busy or free. */
const showAsSchema = z.enum(["busy", "free"]);

const createInput = z.strictObject({
  calendar: calendarSchema,
  subject: z.string().min(1).max(255),
  start: localTimeSchema,
  end: localTimeSchema,
  timeZone: timeZoneSchema,
  location: z.string().max(255).optional(),
  body: z
    .string()
    .max(32 * 1024)
    .optional(),
  showAs: showAsSchema.optional(),
});

/** An event a write made, its times as Google gave them back. */
const writtenSchema = z.strictObject({ event: summarySchema });

/**
 * An event as Google takes it: nobody invited, and with the call's effect
 * key as its ID if there is one, so it can be made only once and found.
 */
const googleNewEvent = (
  {
    subject,
    start,
    end,
    timeZone,
    location,
    body,
    showAs,
  }: z.output<typeof createInput>,
  { key }: Effect
) => ({
  ...(key === null ? {} : { id: key }),
  summary: subject,
  start: { dateTime: withSeconds(start), timeZone },
  end: { dateTime: withSeconds(end), timeZone },
  ...(location === undefined ? {} : { location }),
  ...(body === undefined ? {} : { description: body }),
  transparency: showAs === "free" ? "transparent" : "opaque",
  attendees: [],
  guestsCanInviteOthers: false,
});

const calendarEntrySchema = z.object({
  id: z.string(),
  primary: z.boolean().nullish(),
});

/**
 * Refuses (`access_denied`) a calendar that isn't the person's own
 * primary one, as Google lists it for them.
 */
const requireOwnCalendar = async (calendar: string): Promise<void> => {
  const entry = await googleJson(
    googleUrl(
      apisHost,
      `/calendar/v3/users/me/calendarList/${segment(calendar)}`
    ),
    calendarEntrySchema
  );
  if (entry.id !== calendar || entry.primary !== true) {
    throw new ToolError("Events go only in the person's own calendar", {
      code: "access_denied",
    });
  }
};

const createEvent = defineTool({
  name: "calendar.create",
  description:
    "Puts an event in a person's own calendar (their address), with nobody invited. Its start and end are wall-clock times (2026-10-26T14:30) in timeZone, the organization's time zone.",
  input: createInput,
  output: writtenSchema,
  readOnly: false,
  reach: "own",
  destructive: false,
  resource: "calendar",
  routes: [
    { method: "GET", host: apisHost, path: calendarEntry },
    { method: "POST", host: apisHost, path: `${calendars}/events` },
    { method: "GET", host: apisHost, path: `${calendars}/events/{event}` },
  ],
  describe: {
    title: "Put an event in your calendar",
    fields: [
      { label: "Calendar", input: "calendar" },
      { label: "Title", input: "subject" },
      { label: "Starts", input: "start" },
      { label: "Ends", input: "end" },
      { label: "Time zone", input: "timeZone" },
      { label: "Where", input: "location" },
      { label: "Notes", input: "body" },
      { label: "Show as", input: "showAs" },
    ],
  },
  run: async (input, effect) => {
    if (withSeconds(input.end) <= withSeconds(input.start)) {
      throw new ToolError("The event must end after it starts", {
        code: invalidCode,
      });
    }
    await requireOwnCalendar(input.calendar);
    const made = await googleJson(
      googleUrl(
        apisHost,
        `/calendar/v3/calendars/${segment(input.calendar)}/events`,
        { sendUpdates: "none" }
      ),
      googleEvent,
      jsonBody(googleNewEvent(input, effect))
    );
    return { output: { event: summaryOf(input.calendar, made) } };
  },
  // Made, if the calendar has an event with the key as its ID.
  find: async ({ calendar }, { key }) => {
    try {
      const made = await googleJson(
        googleUrl(
          apisHost,
          `/calendar/v3/calendars/${segment(calendar)}/events/${segment(key)}`
        ),
        googleEvent
      );
      return { output: { event: summaryOf(calendar, made) } };
    } catch (error) {
      if (error instanceof ToolError && error.details?.code === "not_found") {
        return null;
      }
      throw error;
    }
  },
});

export const calendarTools = [listEvents, getEvent, createEvent];
