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

const events = `${apisHost}/calendar/v3/calendars/{calendarId}/events`;
const event = `${events}/{eventId}`;

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
};
