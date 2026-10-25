import {
  defineTool,
  invalidCode,
  ToolError,
} from "@grasp-os/connector-kit/connector";
import type { Effect } from "@grasp-os/connector-kit/connector";
import { segment } from "@grasp-os/connector-kit/provider";
import { z } from "zod";

import {
  atPage,
  effectPropertyId,
  graphHost,
  graphJson,
  graphUrl,
  idSchema,
  mailboxSchema,
  nextPageOf,
  pageOf,
  pageSchema,
  topSchema,
  v1,
} from "./graph.ts";
import { meRoute, requireOwnMailbox } from "./mail-sorting.ts";

// Calendars, of one mailbox per call, as `/users/{mailbox}` like mail: the
// same resource, so a permission for invoices@ covers its calendar too.
// Like mail, the mailbox a read names may be a shared one or a
// colleague's (`Calendars.Read.Shared`), so reads reach `company`. Reads
// give times in UTC. Writes take and give them in the time zone the call
// names, the organization's, so the person asked to confirm one reads the
// times they know.
//
// Writes put events in a person's own calendar and never invite anyone:
// their input has no attendees at all, and an update refuses an event that
// has guests or that the mailbox didn't organise, since Outlook would tell
// every guest of the change. The connector asks for Calendars.ReadWrite,
// never its `.Shared` form, so Graph lets a write reach only the signed-in
// person's own calendar: writes reach `own`.

const users = `${v1}/users/{mailbox}`;

const graphTime = z.object({ dateTime: z.string(), timeZone: z.string() });

const graphAttendee = z.object({
  type: z.string().nullish(),
  status: z.object({ response: z.string().nullish() }).nullish(),
  emailAddress: z
    .object({ name: z.string().nullish(), address: z.string().nullish() })
    .nullish(),
});

const graphEvent = z.object({
  id: z.string(),
  subject: z.string().nullish(),
  bodyPreview: z.string().nullish(),
  body: z.object({ contentType: z.string(), content: z.string() }).nullish(),
  start: graphTime,
  end: graphTime,
  isAllDay: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
  showAs: z.string().nullish(),
  location: z.object({ displayName: z.string().nullish() }).nullish(),
  organizer: graphAttendee.nullish(),
  attendees: z.array(graphAttendee).nullish(),
  webLink: z.string().nullish(),
  onlineMeeting: z.object({ joinUrl: z.string().nullish() }).nullish(),
});
type GraphEvent = z.infer<typeof graphEvent>;

const summaryFields = [
  "id",
  "subject",
  "bodyPreview",
  "start",
  "end",
  "isAllDay",
  "isCancelled",
  "showAs",
  "location",
  "organizer",
  "webLink",
].join(",");

const timeSchema = z.strictObject({
  dateTime: z.string(),
  timeZone: z.string(),
});

const personSchema = z.strictObject({
  name: z.string().nullable(),
  address: z.string().nullable(),
});

const summarySchema = z.strictObject({
  mailbox: z.string(),
  id: z.string(),
  subject: z.string().nullable(),
  bodyPreview: z.string().nullable(),
  start: timeSchema,
  end: timeSchema,
  isAllDay: z.boolean(),
  isCancelled: z.boolean(),
  showAs: z.string().nullable(),
  location: z.string().nullable(),
  organizer: personSchema.nullable(),
  webLink: z.string().nullable(),
});

const personOf = (
  attendee: z.infer<typeof graphAttendee>
): z.infer<typeof personSchema> => ({
  name: attendee.emailAddress?.name ?? null,
  address: attendee.emailAddress?.address ?? null,
});

const summaryOf = (
  mailbox: string,
  event: GraphEvent
): z.infer<typeof summarySchema> => ({
  mailbox,
  id: event.id,
  subject: event.subject ?? null,
  bodyPreview: event.bodyPreview ?? null,
  start: event.start,
  end: event.end,
  isAllDay: event.isAllDay ?? false,
  isCancelled: event.isCancelled ?? false,
  showAs: event.showAs ?? null,
  location: event.location?.displayName ?? null,
  organizer: event.organizer ? personOf(event.organizer) : null,
  webLink: event.webLink ?? null,
});

/** Times in UTC, whatever the mailbox's own time zone. */
const inUtc: HeadersInit = { prefer: 'outlook.timezone="UTC"' };

const listEvents = defineTool({
  name: "calendar.list",
  description:
    "Lists the events of a mailbox's calendar that fall in a range of time, recurring ones as their occurrences, earliest first.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    top: topSchema,
    page: pageSchema,
  }),
  output: z.strictObject({
    mailbox: z.string(),
    events: z.array(summarySchema),
    nextPage: z.string().nullable(),
  }),
  readOnly: true,
  reach: "company",
  resource: "mailbox",
  routes: [{ method: "GET", host: graphHost, path: `${users}/calendarView` }],
  run: async ({ mailbox, start, end, top, page }) => {
    if (Date.parse(end) <= Date.parse(start)) {
      throw new ToolError("The range must end after it starts", {
        code: invalidCode,
      });
    }
    const url = atPage(
      graphUrl(`/users/${segment(mailbox)}/calendarView`, {
        startDateTime: start,
        endDateTime: end,
        $select: summaryFields,
        $orderby: "start/dateTime",
        $top: String(top ?? 25),
      }),
      page
    );
    const { value, "@odata.nextLink": nextLink } = await graphJson(
      url,
      pageOf(graphEvent),
      { headers: inUtc }
    );
    return {
      output: {
        mailbox,
        events: value.map((event) => summaryOf(mailbox, event)),
        nextPage: nextPageOf(nextLink),
      },
      provenance: value.map(({ id }) => id),
    };
  },
});

const getEvent = defineTool({
  name: "calendar.get",
  description:
    "Gets one event of a mailbox's calendar, with its body and attendees.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    event: idSchema,
  }),
  output: z.strictObject({
    event: summarySchema.extend({
      body: z
        .strictObject({ contentType: z.string(), content: z.string() })
        .nullable(),
      attendees: z.array(
        personSchema.extend({
          type: z.string().nullable(),
          response: z.string().nullable(),
        })
      ),
      joinUrl: z.string().nullable(),
    }),
  }),
  readOnly: true,
  reach: "company",
  resource: "mailbox",
  routes: [{ method: "GET", host: graphHost, path: `${users}/events/{event}` }],
  run: async ({ mailbox, event: id }) => {
    const event = await graphJson(
      graphUrl(`/users/${segment(mailbox)}/events/${segment(id)}`, {
        $select: `${summaryFields},body,attendees,onlineMeeting`,
      }),
      graphEvent,
      {
        headers: {
          prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"',
        },
      }
    );
    return {
      output: {
        event: {
          ...summaryOf(mailbox, event),
          body: event.body ?? { contentType: "text", content: "" },
          attendees: (event.attendees ?? []).map((attendee) => ({
            ...personOf(attendee),
            type: attendee.type ?? null,
            response: attendee.status?.response ?? null,
          })),
          joinUrl: event.onlineMeeting?.joinUrl ?? null,
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

/**
 * An IANA time zone, `Europe/Amsterdam`: the organization's (core's
 * `organizations.time_zone`). Its alphabet keeps it inside the quotes of
 * Graph's `Prefer` header.
 */
const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][\w+-]*(?:\/[\w+-]+)*$/u)
  .refine(isTimeZone, { message: "Not a time zone" });

/** How the event shows the person's time. */
const showAsSchema = z.enum([
  "free",
  "tentative",
  "busy",
  "oof",
  "workingElsewhere",
]);

const subjectSchema = z.string().min(1).max(255);
const locationSchema = z.string().max(255);
const notesSchema = z.string().max(32 * 1024);

/** Sends JSON with `method`, and asks for times in `timeZone`. */
const jsonIn = (
  method: string,
  timeZone: string,
  body: unknown,
  headers: Record<string, string> = {}
): RequestInit => ({
  method,
  headers: {
    "content-type": "application/json",
    prefer: `outlook.timezone="${timeZone}"`,
    ...headers,
  },
  body: JSON.stringify(body),
});

/** Refuses a range that doesn't end after it starts. */
const checkRange = (start: string, end: string): void => {
  if (withSeconds(end) <= withSeconds(start)) {
    throw new ToolError("The event must end after it starts", {
      code: invalidCode,
    });
  }
};

/** An event a write made or changed, its times in the call's time zone. */
const writtenSchema = z.strictObject({ event: summarySchema });

const createInput = z.strictObject({
  mailbox: mailboxSchema,
  subject: subjectSchema,
  start: localTimeSchema,
  end: localTimeSchema,
  timeZone: timeZoneSchema,
  location: locationSchema.optional(),
  body: notesSchema.optional(),
  showAs: showAsSchema.optional(),
});

/**
 * An event as Graph takes it: nobody invited, and tagged with the call's
 * effect key if any, so a call of unknown outcome can find it again.
 */
const graphNewEvent = (
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
  subject,
  start: { dateTime: start, timeZone },
  end: { dateTime: end, timeZone },
  ...(location === undefined ? {} : { location: { displayName: location } }),
  ...(body === undefined
    ? {}
    : { body: { contentType: "text", content: body } }),
  showAs: showAs ?? "busy",
  attendees: [],
  ...(key === null
    ? {}
    : {
        singleValueExtendedProperties: [{ id: effectPropertyId, value: key }],
      }),
});

const createEvent = defineTool({
  name: "calendar.create",
  description:
    "Puts an event in a person's own calendar, with nobody invited. Its start and end are wall-clock times (2026-10-26T14:30) in timeZone, the organization's time zone, which the answer's times are in too.",
  input: createInput,
  output: writtenSchema,
  readOnly: false,
  reach: "own",
  destructive: false,
  resource: "mailbox",
  routes: [
    { method: "GET", host: graphHost, path: `${users}/events` },
    { method: "POST", host: graphHost, path: `${users}/events` },
  ],
  describe: {
    title: "Put an event in your calendar",
    fields: [
      { label: "Calendar", input: "mailbox" },
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
    checkRange(input.start, input.end);
    const made = await graphJson(
      graphUrl(`/users/${segment(input.mailbox)}/events`),
      graphEvent,
      jsonIn("POST", input.timeZone, graphNewEvent(input, effect))
    );
    return { output: { event: summaryOf(input.mailbox, made) } };
  },
  // Made, if an event with its key is in the calendar. The key is 64 hex
  // characters (connect derives it, the kit checks it), so it can't break
  // out of the filter's string literal.
  find: async ({ mailbox, timeZone }, { key }) => {
    const { value } = await graphJson(
      graphUrl(`/users/${segment(mailbox)}/events`, {
        $filter: `singleValueExtendedProperties/Any(ep: ep/id eq '${effectPropertyId}' and ep/value eq '${key}')`,
        $select: summaryFields,
        $top: "1",
      }),
      pageOf(graphEvent),
      { headers: { prefer: `outlook.timezone="${timeZone}"` } }
    );
    const [made] = value;
    return made === undefined
      ? null
      : { output: { event: summaryOf(mailbox, made) } };
  },
});

/** What an update reads of the event before it changes anything. */
const guardedEvent = z.object({
  "@odata.etag": z.string().min(1),
  isOrganizer: z.boolean().nullish(),
  attendees: z.array(graphAttendee).nullish(),
});

const updateEvent = defineTool({
  name: "calendar.update",
  description:
    "Changes an event in a person's own calendar that they organised and nobody else is invited to: its title, times, place, notes or how it shows. Start and end change together, as wall-clock times (2026-10-26T14:30) in timeZone, the organization's time zone, which the answer's times are in too.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    event: idSchema,
    timeZone: timeZoneSchema,
    subject: subjectSchema.optional(),
    start: localTimeSchema.optional(),
    end: localTimeSchema.optional(),
    location: locationSchema.optional(),
    body: notesSchema.optional(),
    showAs: showAsSchema.optional(),
  }),
  output: writtenSchema,
  readOnly: false,
  reach: "own",
  destructive: true,
  resource: "mailbox",
  routes: [
    { method: "GET", host: graphHost, path: `${users}/events/{event}` },
    { method: "PATCH", host: graphHost, path: `${users}/events/{event}` },
  ],
  describe: {
    title: "Change an event in your calendar",
    fields: [
      { label: "Calendar", input: "mailbox" },
      { label: "Event", input: "event" },
      { label: "New title", input: "subject" },
      { label: "Starts", input: "start" },
      { label: "Ends", input: "end" },
      { label: "Time zone", input: "timeZone" },
      { label: "Where", input: "location" },
      { label: "Notes", input: "body" },
      { label: "Show as", input: "showAs" },
    ],
  },
  // Recovery `repeat`: an update sets the fields it names, so sent again
  // under the same key it changes nothing more, and it checks the event
  // for guests and its organiser again before it does.
  repeatable: true,
  run: async ({ mailbox, event: id, timeZone, start, end, ...rest }) => {
    if ((start === undefined) !== (end === undefined)) {
      throw new ToolError("An event's start and end change together", {
        code: invalidCode,
      });
    }
    if (start !== undefined && end !== undefined) {
      checkRange(start, end);
    }
    const { subject, location, body, showAs } = rest;
    const changes = {
      ...(subject === undefined ? {} : { subject }),
      ...(start === undefined ? {} : { start: { dateTime: start, timeZone } }),
      ...(end === undefined ? {} : { end: { dateTime: end, timeZone } }),
      ...(location === undefined
        ? {}
        : { location: { displayName: location } }),
      ...(body === undefined
        ? {}
        : { body: { contentType: "text", content: body } }),
      ...(showAs === undefined ? {} : { showAs }),
    };
    if (Object.keys(changes).length === 0) {
      throw new ToolError("The update changes nothing", { code: invalidCode });
    }
    const path = `/users/${segment(mailbox)}/events/${segment(id)}`;
    const found = await graphJson(
      graphUrl(path, { $select: "isOrganizer,attendees" }),
      guardedEvent
    );
    // An answer without a guest list proves nobody is invited no more than
    // it proves someone is: only an empty list lets the change go out.
    if (found.attendees === null || found.attendees === undefined) {
      throw new ToolError(
        "Outlook didn't say who is invited to this event: change it in Outlook",
        { code: invalidCode }
      );
    }
    if (found.attendees.length > 0) {
      throw new ToolError(
        "This event has guests, and Outlook would tell each of them of the change: change it in Outlook",
        { code: invalidCode }
      );
    }
    if (found.isOrganizer !== true) {
      throw new ToolError(
        "Someone else organised this event: only they can change it",
        { code: invalidCode }
      );
    }
    // Only the event as it was checked: if anyone changed it since (say,
    // invited a guest), Graph refuses the write (412) instead.
    const changed = await graphJson(
      graphUrl(path),
      graphEvent,
      jsonIn("PATCH", timeZone, changes, { "if-match": found["@odata.etag"] })
    );
    return { output: { event: summaryOf(mailbox, changed) } };
  },
});

/** A time of day, `09:00`, as working hours are given. */
const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

/** Days of the week as Graph names them, Sunday first as `getUTCDay` counts. */
const weekdays = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Working hours when the call names none: Monday to Friday, 9 to 5. */
const defaultWorkingHours = {
  from: "09:00",
  to: "17:00",
  days: ["monday", "tuesday", "wednesday", "thursday", "friday"],
} as const;

const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;

/** The longest range free time is looked for in. */
const maxRangeDays = 31;

/**
 * How many events a page of the calendar view asks for, and how many pages
 * free time reads at most: a month of a busy calendar fits many times.
 */
const viewPageSize = 100;
const maxViewPages = 10;

/** `ms` as a wall-clock time in `timeZone`, to the second: `2026-10-26T14:30:00`. */
const wallClockOf = (ms: number, timeZone: string): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(ms)
      .map(({ type, value }) => [type, value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
};

/** How far `timeZone`'s wall clock is ahead of UTC at `ms`. */
const offsetAt = (ms: number, timeZone: string): number =>
  Date.parse(`${wallClockOf(ms, timeZone)}Z`) - Math.floor(ms / 1000) * 1000;

/**
 * The moment a wall-clock time in `timeZone` names. A time a clock change
 * skips reads with the offset before the change, and one it repeats as
 * its first.
 */
const momentOf = (time: string, timeZone: string): number => {
  const asUtc = Date.parse(`${withSeconds(time)}Z`);
  const guess = asUtc - offsetAt(asUtc, timeZone);
  return asUtc - offsetAt(guess, timeZone);
};

/** A moment as the wall-clock time `calendar.create` takes: `2026-10-26T14:30`. */
const localTimeOf = (ms: number, timeZone: string): string =>
  wallClockOf(ms, timeZone).slice(0, minutesOnly);

/** What free time reads of an event: its times, and whether it takes the time. */
const busyEvent = z.object({
  start: graphTime,
  end: graphTime,
  isAllDay: z.boolean().nullish(),
  isCancelled: z.boolean().nullish(),
  showAs: z.string().nullish(),
});

/** Ways an event can show that leave the person's time free. */
const freeShows = new Set(["free", "workingElsewhere"]);

/**
 * When an event takes the person's time, as moments. Graph gives times in
 * UTC here; an all-day event spans its days in the organization's time
 * zone, as the person sees it, whichever zone it was made in.
 */
const busyOf = (
  event: z.infer<typeof busyEvent>,
  timeZone: string
): { start: number; end: number } | undefined => {
  if (event.isCancelled === true || freeShows.has(event.showAs ?? "busy")) {
    return undefined;
  }
  if (event.isAllDay === true) {
    return {
      start: momentOf(`${event.start.dateTime.slice(0, 10)}T00:00`, timeZone),
      end: momentOf(`${event.end.dateTime.slice(0, 10)}T00:00`, timeZone),
    };
  }
  return {
    start: Date.parse(`${event.start.dateTime.slice(0, 19)}Z`),
    end: Date.parse(`${event.end.dateTime.slice(0, 19)}Z`),
  };
};

/** Midnight of the day `day` (a UTC midnight) names, as a wall-clock time. */
const dayOf = (day: number): string =>
  `${new Date(day).toISOString().slice(0, 10)}T00:00`;

/** The working stretches of each day from `start` to `end`, as moments. */
const workingStretches = (
  start: number,
  end: number,
  timeZone: string,
  hours: { from: string; to: string; days: readonly string[] }
): { start: number; end: number }[] => {
  const stretches: { start: number; end: number }[] = [];
  const firstDay = Date.parse(`${wallClockOf(start, timeZone).slice(0, 10)}Z`);
  for (let day = firstDay; momentOf(dayOf(day), timeZone) < end; day += dayMs) {
    const weekday = weekdays[new Date(day).getUTCDay()] ?? "sunday";
    if (hours.days.includes(weekday)) {
      const from = Math.max(
        momentOf(`${dayOf(day).slice(0, 10)}T${hours.from}`, timeZone),
        start
      );
      const to = Math.min(
        momentOf(`${dayOf(day).slice(0, 10)}T${hours.to}`, timeZone),
        end
      );
      if (to > from) {
        stretches.push({ start: from, end: to });
      }
    }
  }
  return stretches;
};

/** What is left of `stretches` once every one of `busy` is taken out. */
const without = (
  stretches: { start: number; end: number }[],
  busy: { start: number; end: number }[]
): { start: number; end: number }[] => {
  let left = stretches;
  for (const taken of busy) {
    left = left.flatMap((stretch) =>
      taken.end <= stretch.start || taken.start >= stretch.end
        ? [stretch]
        : [
            { start: stretch.start, end: taken.start },
            { start: taken.end, end: stretch.end },
          ].filter((part) => part.end > part.start)
    );
  }
  return left;
};

const freeTime = defineTool({
  name: "calendar.freeTime",
  description:
    "Finds free stretches of at least `minutes` in a person's own calendar between start and end, within working hours (Monday to Friday, 09:00 to 17:00 unless given), earliest first. Start, end and the answer's times are wall-clock times (2026-10-26T14:30) in timeZone, the organization's time zone, as calendar.create takes them: to block a stretch, create an event in it that shows as busy.",
  input: z.strictObject({
    mailbox: mailboxSchema,
    start: localTimeSchema,
    end: localTimeSchema,
    timeZone: timeZoneSchema,
    minutes: z
      .number()
      .int()
      .min(5)
      .max(24 * 60),
    workingHours: z
      .strictObject({
        from: timeOfDaySchema,
        to: timeOfDaySchema,
        days: z.array(z.enum(weekdays)).min(1).max(weekdays.length),
      })
      .optional(),
  }),
  output: z.strictObject({
    mailbox: z.string(),
    timeZone: z.string(),
    free: z.array(
      z.strictObject({
        start: z.string(),
        end: z.string(),
        minutes: z.number(),
      })
    ),
  }),
  readOnly: true,
  reach: "own",
  resource: "mailbox",
  routes: [
    meRoute,
    { method: "GET", host: graphHost, path: `${users}/calendarView` },
  ],
  run: async ({ mailbox, start, end, timeZone, minutes, workingHours }) => {
    const from = momentOf(start, timeZone);
    const to = momentOf(end, timeZone);
    if (to <= from) {
      throw new ToolError("The range must end after it starts", {
        code: invalidCode,
      });
    }
    if (to - from > maxRangeDays * dayMs) {
      throw new ToolError(
        `Free time is looked for in at most ${maxRangeDays} days at a time`,
        { code: invalidCode }
      );
    }
    const hours = workingHours ?? defaultWorkingHours;
    if (hours.to <= hours.from) {
      throw new ToolError("Working hours must end after they start", {
        code: invalidCode,
      });
    }
    // Own only. The connector may read colleagues' and shared calendars
    // (Calendars.Read.Shared), and their free time is theirs to share.
    await requireOwnMailbox(mailbox);
    const view = graphUrl(`/users/${segment(mailbox)}/calendarView`, {
      startDateTime: new Date(from).toISOString(),
      endDateTime: new Date(to).toISOString(),
      $select: "start,end,isAllDay,isCancelled,showAs",
      $orderby: "start/dateTime",
      $top: String(viewPageSize),
    });
    const busy: { start: number; end: number }[] = [];
    let page: string | undefined;
    for (let read = 0; read < maxViewPages; read += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each page names the next
      const { value, "@odata.nextLink": nextLink } = await graphJson(
        atPage(new URL(view), page),
        pageOf(busyEvent),
        { headers: inUtc }
      );
      for (const event of value) {
        const taken = busyOf(event, timeZone);
        if (taken !== undefined) {
          busy.push(taken);
        }
      }
      page = nextPageOf(nextLink) ?? undefined;
      if (page === undefined) {
        break;
      }
    }
    if (page !== undefined) {
      throw new ToolError(
        "This calendar holds too many events in that range: look in a shorter one",
        { code: invalidCode }
      );
    }
    const free = without(
      workingStretches(from, to, timeZone, hours),
      busy
    ).filter((stretch) => stretch.end - stretch.start >= minutes * minuteMs);
    return {
      output: {
        mailbox,
        timeZone,
        free: free.map((stretch) => ({
          start: localTimeOf(stretch.start, timeZone),
          end: localTimeOf(stretch.end, timeZone),
          minutes: Math.round((stretch.end - stretch.start) / minuteMs),
        })),
      },
    };
  },
});

export const calendarTools = [
  listEvents,
  getEvent,
  freeTime,
  createEvent,
  updateEvent,
];
