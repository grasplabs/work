import { page, tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { ConnectorTool, Infer } from "@grasp-os/sdk/connector";

import { apisHost, googleScope, nextOf } from "./google.ts";

// Calendars, one per call, as `/calendar/v3/calendars/{calendarId}` with the
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
// in a path parameter, which the API refuses before anything is sent, as
// the egress would, so a value can't end the path early. Those calendars
// hold no organization's data, so they are left out rather than widening
// what a parameter may hold.
//
// Writes. `calendar.calendars.events.create` puts an event in the person's
// own calendar only, with nobody invited. `calendar.events` would let it
// write any calendar shared with the person, so before it writes it reads
// the calendar's entry in the person's own calendar list
// (`/users/me/calendarList/{calendarId}`, `me` being the token's person,
// the calendar still bound to the capability's) and goes no further
// unless Google says it is their primary one. Its args have no guests, it
// sends none, and Google is told to notify nobody (`sendUpdates=none`).
// The event's ID is the call's effect key (64 lowercase hex characters,
// which Google's event IDs allow), so the same call can't make a second
// event, and a call of unknown outcome is found by that ID.

const events = `${apisHost}/calendar/v3/calendars/{calendarId}/events`;
const event = `${events}/{eventId}`;

/** The person's own entry for a calendar: whether it is their primary. */
const calendarEntry = `${apisHost}/calendar/v3/users/me/calendarList/{calendarId}`;

/** A calendar's ID: one address, never Google's alias `primary`. */
const calendarArg = v.string().min(3).max(256).email();

const time = v.object({
  dateTime: v.string().optional(),
  date: v.string().optional(),
  timeZone: v.string().optional(),
});

const person = v.object({
  email: v.string().optional(),
  displayName: v.string().optional(),
});

/**
 * An event as Calendar gives it, narrowed. A cancelled occurrence of a
 * recurring event may have neither start nor end, only the start it had
 * (`originalStartTime`); any other event has both (`checkTimes`).
 */
const listedEvent = v.object({
  id: v.string(),
  status: v.string().optional(),
  htmlLink: v.string().optional(),
  summary: v.string().optional(),
  location: v.string().optional(),
  start: time.optional(),
  end: time.optional(),
  originalStartTime: time.optional(),
  organizer: person.optional(),
  recurringEventId: v.string().optional(),
});

const fullEvent = listedEvent.extend({
  description: v.string().optional(),
  attendees: v
    .array(
      person.extend({
        responseStatus: v.string().optional(),
        optional: v.boolean().optional(),
      })
    )
    .optional(),
  hangoutLink: v.string().optional(),
});

const eventPage = v.object({
  items: v.array(listedEvent).optional(),
  nextPageToken: v.string().optional(),
});

/** Refuses an answer with an event that isn't cancelled but lacks a time. */
const checkTimes = (
  answered: readonly Pick<
    Infer<typeof listedEvent>,
    "status" | "start" | "end"
  >[]
): void => {
  if (
    answered.some(
      ({ status, start, end }) =>
        status !== "cancelled" && (start === undefined || end === undefined)
    )
  ) {
    throw new ToolError("Google's answer isn't what the connector expects", {
      code: "failed",
    });
  }
};

/** A wall-clock time without an offset, `2026-10-26T14:30`, or with seconds. */
const localTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u;

const minutesOnly = "2026-10-26T14:30".length;

/** The same time with its seconds, so that two compare as strings. */
const withSeconds = (wallTime: string): string =>
  wallTime.length === minutesOnly ? `${wallTime}:00` : wallTime;

/**
 * Whether `wallTime` is a wall-clock time that exists: `Date.parse` moves
 * 30 February on to 2 March, and 24:00 on to the next day, so the time it
 * read must read back the same.
 */
const isLocalTime = (wallTime: string): boolean => {
  const parsed = Date.parse(`${wallTime}Z`);
  return (
    localTime.test(wallTime) &&
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().startsWith(withSeconds(wallTime))
  );
};

/** Whether the runtime knows `timeZone`, an IANA one: `Europe/Amsterdam`. */
const isTimeZone = (timeZone: string): boolean => {
  try {
    // oxlint-disable-next-line no-new -- constructing it is the check
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/**
 * A start or an end as an event takes it: a wall-clock time
 * (`2026-10-26T14:30`) in an IANA time zone, read there as the person
 * confirming it reads it.
 */
const wallClock = v.object({
  dateTime: v.string().min(1).max(32),
  timeZone: v.string().min(1).max(64),
});

const calendarListEntry = v.object({
  id: v.string(),
  primary: v.boolean().optional(),
});

export const calendarTools: Readonly<Record<string, ConnectorTool>> = {
  "calendar.calendars.events.list": tool({
    description:
      "Lists the events of a calendar that fall between timeMin and timeMax, recurring ones as their occurrences, earliest first, in UTC.",
    args: {
      calendarId: calendarArg,
      timeMin: v.string().datetime(),
      timeMax: v.string().datetime(),
      maxResults: v.number().integer().min(1).max(100).optional(),
      pageToken: v.string().min(1).max(4096).optional(),
    },
    returns: page(listedEvent),
    readOnly: true,
    reach: "company",
    resource: "calendarId",
    scopes: [googleScope("calendar.events.readonly")],
    routes: [`GET ${events}`],
    handler: async (
      { calendarId, timeMin, timeMax, maxResults, pageToken },
      api
    ) => {
      if (Date.parse(timeMax) <= Date.parse(timeMin)) {
        throw new ToolError("The range must end after it starts", {
          code: "invalid",
        });
      }
      const { items = [], nextPageToken } = await api.get(events, {
        path: { calendarId },
        query: {
          timeMin,
          timeMax,
          singleEvents: true,
          orderBy: "startTime",
          timeZone: "UTC",
          maxResults: maxResults ?? 25,
          pageToken,
        },
        returns: eventPage,
      });
      checkTimes(items);
      return { items, next: nextOf(nextPageToken) };
    },
  }),
  "calendar.calendars.events.get": tool({
    description:
      "Gets one event of a calendar, with its description and attendees, in UTC.",
    args: {
      calendarId: calendarArg,
      eventId: v.string().min(1).max(1024),
    },
    returns: fullEvent,
    readOnly: true,
    reach: "company",
    resource: "calendarId",
    scopes: [googleScope("calendar.events.readonly")],
    routes: [`GET ${event}`],
    handler: async ({ calendarId, eventId }, api) => {
      const answered = await api.get(event, {
        path: { calendarId, eventId },
        query: { timeZone: "UTC" },
        returns: fullEvent,
      });
      checkTimes([answered]);
      return answered;
    },
  }),
  "calendar.calendars.events.create": tool({
    description:
      "Puts an event in a person's own calendar (calendarId is their address), with nobody invited. Its start and end are wall-clock times (2026-10-26T14:30) in one time zone, the organization's.",
    args: {
      calendarId: calendarArg,
      summary: v.string().min(1).max(255),
      start: wallClock,
      end: wallClock,
      location: v.string().max(255).optional(),
      description: v
        .string()
        .max(32 * 1024)
        .optional(),
      transparency: v.enum(["opaque", "transparent"]).optional(),
    },
    returns: listedEvent,
    readOnly: false,
    reach: "own",
    resource: "calendarId",
    scopes: [
      googleScope("calendar.events"),
      googleScope("calendar.calendarlist.readonly"),
    ],
    routes: [`GET ${calendarEntry}`, `POST ${events}`, `GET ${event}`],
    describe: {
      title: "Put an event in your calendar",
      fields: [
        { label: "Calendar", arg: "calendarId" },
        { label: "Title", arg: "summary" },
        { label: "Starts", arg: "start" },
        { label: "Ends", arg: "end" },
        { label: "Where", arg: "location" },
        { label: "Notes", arg: "description" },
        { label: "Show as", arg: "transparency" },
      ],
    },
    handler: async (
      { calendarId, start, end, transparency = "opaque", ...rest },
      api,
      { key }
    ) => {
      if (
        !isLocalTime(start.dateTime) ||
        !isLocalTime(end.dateTime) ||
        !isTimeZone(start.timeZone) ||
        end.timeZone !== start.timeZone ||
        withSeconds(end.dateTime) <= withSeconds(start.dateTime)
      ) {
        throw new ToolError(
          "An event starts and ends at wall-clock times in one time zone, and ends after it starts",
          { code: "invalid" }
        );
      }
      const entry = await api.get(calendarEntry, {
        path: { calendarId },
        returns: calendarListEntry,
      });
      if (entry.id !== calendarId || entry.primary !== true) {
        throw new ToolError("Events go only in the person's own calendar", {
          code: "access_denied",
        });
      }
      const made = await api.post(events, {
        path: { calendarId },
        query: { sendUpdates: "none" },
        body: {
          ...(key === null ? {} : { id: key }),
          ...rest,
          start: { ...start, dateTime: withSeconds(start.dateTime) },
          end: { ...end, dateTime: withSeconds(end.dateTime) },
          transparency,
          attendees: [],
          guestsCanInviteOthers: false,
        },
        returns: listedEvent,
      });
      checkTimes([made]);
      return made;
    },
    // Made, if the calendar has an event with the key as its ID.
    find: async ({ calendarId }, api, { key }) => {
      try {
        const made = await api.get(event, {
          path: { calendarId, eventId: key },
          returns: listedEvent,
        });
        checkTimes([made]);
        return made;
      } catch (error) {
        if (error instanceof ToolError && error.details?.code === "not_found") {
          return null;
        }
        throw error;
      }
    },
  }),
};
