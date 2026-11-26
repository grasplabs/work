import { page, tool, ToolError, v } from "@grasp-os/sdk/connector";
import type { Api } from "@grasp-os/sdk/connector";

import {
  checkIds,
  effectFilter,
  effectTag,
  graphId,
  graphPage,
  mailbox,
  next,
  nextOf,
  positionOf,
  top,
} from "./graph-sdk.ts";

// Calendars. A mailbox's calendar, read as `/users/{mailbox}` like mail:
// the same resource, so a permission for invoices@ covers its calendar
// too, and the mailbox may be a shared one or a colleague's
// (`Calendars.Read.Shared`), so these reads reach `company`. The person's
// own calendar view is under `/me`, so it reaches no one else's.
//
// Writes put events in a person's own calendar and never invite anyone:
// their args have no attendees at all, and an update refuses an event that
// has guests or that the mailbox didn't organise, since Outlook would tell
// every guest of the change. The connector asks for Calendars.ReadWrite,
// never its `.Shared` form, so Graph lets a write reach only the signed-in
// person's own calendar: writes reach `own`. Their times are wall-clock
// times in one time zone, the organization's, and Graph answers in that
// zone, so the person asked to confirm one reads the times they know.

const usersViewRoute = "/users/{mailbox}/calendarView";
const meViewRoute = "/me/calendarView";
const eventsRoute = "/users/{mailbox}/events";
const eventRoute = "/users/{mailbox}/events/{event}";

/** Graph's dateTimeTimeZone. */
const DateTimeTimeZone = v.object({
  dateTime: v.string(),
  timeZone: v.string(),
});

/** Graph's emailAddress. */
const EmailAddress = v.object({
  name: v.string().nullable().optional(),
  address: v.string().nullable().optional(),
});

/** Graph's attendee. */
const Attendee = v.object({
  type: v.string().nullable().optional(),
  status: v
    .object({ response: v.string().nullable().optional() })
    .nullable()
    .optional(),
  emailAddress: EmailAddress.nullable().optional(),
});

const eventFields = {
  id: v.string(),
  subject: v.string().nullable().optional(),
  bodyPreview: v.string().nullable().optional(),
  start: DateTimeTimeZone,
  end: DateTimeTimeZone,
  isAllDay: v.boolean().nullable().optional(),
  isCancelled: v.boolean().nullable().optional(),
  showAs: v.string().nullable().optional(),
  location: v
    .object({ displayName: v.string().nullable().optional() })
    .nullable()
    .optional(),
  organizer: v
    .object({ emailAddress: EmailAddress.nullable().optional() })
    .nullable()
    .optional(),
  webLink: v.string().nullable().optional(),
};

/** An event (Graph's event), narrowed to these fields. */
const Event = v.object(eventFields);

const select = Object.keys(eventFields).join(",");

const onlineMeeting = v
  .object({ joinUrl: v.string().nullable().optional() })
  .nullable()
  .optional();

const detailFields = {
  ...eventFields,
  body: v
    .object({ contentType: v.string(), content: v.string() })
    .nullable()
    .optional(),
  attendees: v.array(Attendee).nullable().optional(),
  onlineMeeting,
};

/** An event with its body, its attendees and its Teams link. */
const EventDetail = v.object(detailFields);

const detailSelect = Object.keys(detailFields).join(",");

const viewFields = {
  ...eventFields,
  isOnlineMeeting: v.boolean().nullable().optional(),
  responseStatus: v
    .object({ response: v.string().nullable().optional() })
    .nullable()
    .optional(),
  onlineMeeting,
};

/**
 * An event of the person's own calendar view, with what says whether it
 * is a Teams meeting they were in (`wasIn`).
 */
export const ViewEvent = v.object(viewFields);

export const viewSelect = Object.keys(viewFields).join(",");

/** Times in UTC, whatever the mailbox's own time zone. */
export const inUtc = { prefer: 'outlook.timezone="UTC"' };

/** Times in `timeZone`, which `checkTimes` held to an IANA zone. */
const inZone = (timeZone: string) => ({
  prefer: `outlook.timezone="${timeZone}"`,
});

/**
 * Whether the person was in an event as a Teams meeting: online, held, and
 * not declined. Graph can't filter a calendar view on these, so they are
 * checked here.
 */
export const wasIn = (event: {
  isOnlineMeeting?: boolean | null | undefined;
  isCancelled?: boolean | null | undefined;
  responseStatus?: { response?: string | null | undefined } | null | undefined;
  onlineMeeting?: { joinUrl?: string | null | undefined } | null | undefined;
}): boolean =>
  event.isOnlineMeeting === true &&
  event.isCancelled !== true &&
  event.responseStatus?.response !== "declined" &&
  typeof event.onlineMeeting?.joinUrl === "string";

const dayMs = 86_400_000;

/** The most days the person's own calendar view covers at once. */
const maxViewDays = 31;

/**
 * Refuses a range that doesn't end after it starts, or spans more than
 * `maxDays` if given.
 */
const checkRange = (start: string, end: string, maxDays?: number): void => {
  const span = Date.parse(end) - Date.parse(start);
  if (!(span > 0)) {
    throw new ToolError("The range must end after it starts", {
      code: "invalid",
    });
  }
  if (maxDays !== undefined && span > maxDays * dayMs) {
    throw new ToolError(`The range spans at most ${maxDays} days`, {
      code: "invalid",
    });
  }
};

const minutesOnly = "2026-10-26T14:30".length;

/** The same time with its seconds, so that two compare as strings. */
const withSeconds = (time: string): string =>
  time.length === minutesOnly ? `${time}:00` : time;

/** A wall-clock time without an offset, `2026-10-26T14:30`, or with seconds. */
const localTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/u;

/**
 * Whether `time` is a wall-clock time that exists: `Date.parse` moves
 * 30 February on to 2 March, and 24:00 on to the next day, so the time it
 * read must read back the same.
 */
const isRealTime = (time: string): boolean => {
  const parsed = Date.parse(`${time}Z`);
  return (
    localTime.test(time) &&
    !Number.isNaN(parsed) &&
    new Date(parsed).toISOString().startsWith(withSeconds(time))
  );
};

/**
 * An IANA time zone, `Europe/Amsterdam`. Its alphabet keeps it inside the
 * quotes of Graph's `Prefer` header.
 */
const timeZonePattern = /^[A-Za-z][\w+-]*(?:\/[\w+-]+)*$/u;

/** Whether `timeZone` is a time zone the runtime knows, in that alphabet. */
const isTimeZone = (timeZone: string): boolean => {
  if (!timeZonePattern.test(timeZone)) {
    return false;
  }
  try {
    // oxlint-disable-next-line no-new -- constructing it is the check
    new Intl.DateTimeFormat("en", { timeZone });
    return true;
  } catch {
    return false;
  }
};

/** A write's start or end (Graph's dateTimeTimeZone): a wall-clock time in a time zone. */
const writtenTime = v.object({
  dateTime: v.string().max(19),
  timeZone: v.string().min(1).max(64),
});

interface WrittenTime {
  dateTime: string;
  timeZone: string;
}

/**
 * Refuses, before anything is sent, a start or end that isn't a
 * wall-clock time (2026-10-26T14:30) in a time zone the runtime knows, a
 * start and end in two zones, and an end that isn't after the start.
 * Gives back their zone, which Graph is asked to answer in.
 */
const checkTimes = (start: WrittenTime, end: WrittenTime): string => {
  for (const [name, time] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (!isRealTime(time.dateTime)) {
      throw new ToolError(
        `Invalid input: ${name}.dateTime isn't a wall-clock time, such as 2026-10-26T14:30`,
        { code: "invalid" }
      );
    }
    if (!isTimeZone(time.timeZone)) {
      throw new ToolError(
        `Invalid input: ${name}.timeZone isn't a time zone, such as Europe/Amsterdam`,
        { code: "invalid" }
      );
    }
  }
  if (start.timeZone !== end.timeZone) {
    throw new ToolError("An event's start and end are in one time zone", {
      code: "invalid",
    });
  }
  if (withSeconds(end.dateTime) <= withSeconds(start.dateTime)) {
    throw new ToolError("The event must end after it starts", {
      code: "invalid",
    });
  }
  return start.timeZone;
};

/** How the event shows the person's time. */
const showAs = v.enum(["free", "tentative", "busy", "oof", "workingElsewhere"]);

const subject = v.string().min(1).max(255);
const location = v.object({ displayName: v.string().max(255) });
const body = v.object({ content: v.string().max(32 * 1024) });

/** A body as Graph takes it, in text, if there is one. */
const textBody = (given: { content: string } | undefined) =>
  given === undefined
    ? {}
    : { body: { contentType: "text", content: given.content } };

/** What an update reads of the event before it changes anything. */
const GuardedEvent = v.object({
  "@odata.etag": v.string().min(1),
  isOrganizer: v.boolean().nullable().optional(),
  attendees: v.array(Attendee).nullable().optional(),
});

/**
 * The etag the event was read at, once it is checked: refused if it has
 * guests, if Graph didn't say who is invited, or if someone else
 * organised it.
 */
const checkedEtag = async (
  api: Api,
  path: { mailbox: string; event: string }
): Promise<string> => {
  const found = await api.get(eventRoute, {
    path,
    query: { $select: "isOrganizer,attendees" },
    returns: GuardedEvent,
  });
  // An answer without a guest list proves nobody is invited no more than
  // it proves someone is: only an empty list lets the change go out.
  if (found.attendees === null || found.attendees === undefined) {
    throw new ToolError(
      "Outlook didn't say who is invited to this event: change it in Outlook",
      { code: "invalid" }
    );
  }
  if (found.attendees.length > 0) {
    throw new ToolError(
      "This event has guests, and Outlook would tell each of them of the change: change it in Outlook",
      { code: "invalid" }
    );
  }
  if (found.isOrganizer !== true) {
    throw new ToolError(
      "Someone else organised this event: only they can change it",
      { code: "invalid" }
    );
  }
  return found["@odata.etag"];
};

/**
 * The calendar tools, by name: each named from its route
 * (`GET /users/{mailbox}/calendarView` is `users.calendarView.list`).
 */
export const calendarTools = {
  "users.calendarView.list": tool({
    description:
      "Lists the events of a mailbox's calendar between startDateTime and endDateTime, recurring ones as their occurrences, earliest first, a page at a time. Times are in UTC.",
    readOnly: true,
    reach: "company",
    scopes: ["Calendars.Read.Shared"],
    resource: "mailbox",
    routes: [`GET ${usersViewRoute}`],
    args: {
      mailbox,
      startDateTime: v.string().datetime(),
      endDateTime: v.string().datetime(),
      top,
      next,
    },
    returns: page(Event),
    handler: async (args, api) => {
      checkRange(args.startDateTime, args.endDateTime);
      const answer = await api.get(usersViewRoute, {
        path: { mailbox: args.mailbox },
        query: {
          startDateTime: args.startDateTime,
          endDateTime: args.endDateTime,
          $select: select,
          $orderby: "start/dateTime",
          $top: args.top ?? 25,
          ...positionOf(args.next),
        },
        headers: inUtc,
        returns: graphPage(Event),
      });
      return { items: answer.value, next: nextOf(answer["@odata.nextLink"]) };
    },
  }),
  "users.events.get": tool({
    description:
      "Gets one event of a mailbox's calendar, with its body as text, its attendees and its Teams link. Times are in UTC.",
    readOnly: true,
    reach: "company",
    scopes: ["Calendars.Read.Shared"],
    resource: "mailbox",
    routes: [`GET ${eventRoute}`],
    args: { mailbox, event: graphId },
    returns: EventDetail,
    handler: async (args, api) => {
      checkIds({ event: args.event });
      return await api.get(eventRoute, {
        path: { mailbox: args.mailbox, event: args.event },
        query: { $select: detailSelect },
        headers: {
          prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
        },
        returns: EventDetail,
      });
    },
  }),
  "users.events.create": tool({
    description:
      "Puts an event in a person's own calendar, with nobody invited, and a text body if given. Its start and end are wall-clock times (2026-10-26T14:30) in one time zone, the organization's, which the answer's times are in too.",
    readOnly: false,
    reach: "own",
    scopes: ["Calendars.ReadWrite"],
    resource: "mailbox",
    routes: [`POST ${eventsRoute}`, `GET ${eventsRoute}`],
    args: {
      mailbox,
      subject,
      start: writtenTime,
      end: writtenTime,
      location: location.optional(),
      body: body.optional(),
      showAs: showAs.optional(),
    },
    returns: Event,
    describe: {
      title: "Put an event in your calendar",
      fields: [
        { label: "Calendar", arg: "mailbox" },
        { label: "Title", arg: "subject" },
        { label: "Starts", arg: "start" },
        { label: "Ends", arg: "end" },
        { label: "Where", arg: "location" },
        { label: "Notes", arg: "body" },
        { label: "Show as", arg: "showAs" },
      ],
    },
    handler: async (args, api, call) => {
      const timeZone = checkTimes(args.start, args.end);
      return await api.post(eventsRoute, {
        path: { mailbox: args.mailbox },
        headers: inZone(timeZone),
        body: {
          subject: args.subject,
          start: args.start,
          end: args.end,
          ...(args.location === undefined ? {} : { location: args.location }),
          ...textBody(args.body),
          showAs: args.showAs ?? "busy",
          attendees: [],
          ...effectTag(call.key),
        },
        returns: Event,
      });
    },
    // Made, if an event with its key is in the calendar. The key is 64 hex
    // characters (connect derives it), so it can't break out of the
    // filter's string literal.
    find: async (args, api, call) => {
      const timeZone = checkTimes(args.start, args.end);
      const { value } = await api.get(eventsRoute, {
        path: { mailbox: args.mailbox },
        query: { $filter: effectFilter(call.key), $select: select, $top: 1 },
        headers: inZone(timeZone),
        returns: graphPage(Event),
      });
      return value[0] ?? null;
    },
  }),
  "users.events.update": tool({
    description:
      "Changes an event in a person's own calendar that they organised and nobody else is invited to: its subject, start and end, location, body or showAs. Start and end change together, as wall-clock times (2026-10-26T14:30) in one time zone, the organization's, which the answer's times are in too; without them its times are in UTC.",
    readOnly: false,
    reach: "own",
    scopes: ["Calendars.ReadWrite"],
    resource: "mailbox",
    routes: [`PATCH ${eventRoute}`, `GET ${eventRoute}`],
    args: {
      mailbox,
      event: graphId,
      subject: subject.optional(),
      start: writtenTime.optional(),
      end: writtenTime.optional(),
      location: location.optional(),
      body: body.optional(),
      showAs: showAs.optional(),
    },
    returns: Event,
    describe: {
      title: "Change an event in your calendar",
      fields: [
        { label: "Calendar", arg: "mailbox" },
        { label: "Event", arg: "event" },
        { label: "New title", arg: "subject" },
        { label: "Starts", arg: "start" },
        { label: "Ends", arg: "end" },
        { label: "Where", arg: "location" },
        { label: "Notes", arg: "body" },
        { label: "Show as", arg: "showAs" },
      ],
    },
    // An update sets the fields it names, so sent again under the same key
    // it changes nothing more, and it checks the event for guests and its
    // organiser again before it does.
    repeatable: true,
    handler: async (args, api) => {
      const { start, end } = args;
      checkIds({ event: args.event });
      if ((start === undefined) !== (end === undefined)) {
        throw new ToolError("An event's start and end change together", {
          code: "invalid",
        });
      }
      const timeZone =
        start === undefined || end === undefined
          ? "UTC"
          : checkTimes(start, end);
      const changes = {
        ...(args.subject === undefined ? {} : { subject: args.subject }),
        ...(start === undefined ? {} : { start }),
        ...(end === undefined ? {} : { end }),
        ...(args.location === undefined ? {} : { location: args.location }),
        ...textBody(args.body),
        ...(args.showAs === undefined ? {} : { showAs: args.showAs }),
      };
      if (Object.keys(changes).length === 0) {
        throw new ToolError("The update changes nothing", { code: "invalid" });
      }
      const path = { mailbox: args.mailbox, event: args.event };
      const etag = await checkedEtag(api, path);
      // Only the event as it was checked: if anyone changed it since (say,
      // invited a guest), Graph refuses the write (412) instead.
      return await api.patch(eventRoute, {
        path,
        headers: { ...inZone(timeZone), "if-match": etag },
        body: changes,
        returns: Event,
      });
    },
  }),
  "me.calendarView.list": tool({
    description: `Lists the events in the person's own calendar between startDateTime and endDateTime, at most ${maxViewDays} days apart, recurring ones as their occurrences, earliest first, a page at a time: what to read to find their free time. With isOnlineMeeting, only the Microsoft Teams meetings they were in: online, held and not declined. Times are in UTC.`,
    readOnly: true,
    reach: "conversations",
    scopes: ["Calendars.Read"],
    routes: [`GET ${meViewRoute}`],
    args: {
      startDateTime: v.string().datetime(),
      endDateTime: v.string().datetime(),
      isOnlineMeeting: v.literal(true).optional(),
      top,
      next,
    },
    returns: page(ViewEvent),
    handler: async (args, api) => {
      checkRange(args.startDateTime, args.endDateTime, maxViewDays);
      const answer = await api.get(meViewRoute, {
        query: {
          startDateTime: args.startDateTime,
          endDateTime: args.endDateTime,
          $select: viewSelect,
          $orderby: "start/dateTime",
          $top: args.top ?? 25,
          ...positionOf(args.next),
        },
        headers: inUtc,
        returns: graphPage(ViewEvent),
      });
      return {
        items:
          args.isOnlineMeeting === true
            ? answer.value.filter(wasIn)
            : answer.value,
        next: nextOf(answer["@odata.nextLink"]),
      };
    },
  }),
};
