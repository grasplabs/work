import { syncErrors } from "@grasp-os/shared/sync";
import type { SyncItem, SyncPage } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, ownAccount, someone } from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The Microsoft 365 connector's calendar sync (calendar-sync.ts), through
// connect's real read (src/sync.ts): a fresh isolate, the egress that adds
// the token, and Graph mocked at its host. The ways it can fail come
// first: a cancelled or removed event kept, an event skipped when a page
// stops inside Graph's, a link of Graph's followed, a window that never
// moves, a gone token or a rate limit taken for a failure.

const providers = fakeProviders();

const graphHost = "graph.microsoft.com";
const deltaPath = "/v1.0/me/calendarView/delta";
const eventsPath = "/v1.0/me/events";
const year = 365 * 24 * 60 * 60 * 1000;

type Event = Record<string, unknown> & { id: string };

/** What the calendar holds, for each test to set. */
interface Calendar {
  /** The feed: each token's events, and the delta token after them. */
  feed: Record<string, { events: Event[]; end: string }>;
  /** The most events Graph puts in one page. */
  graphPage: number;
  /** Whether Graph takes `Prefer: odata.maxpagesize` as asked. */
  honoursPageSize: boolean;
  /** Every event Graph reads on its own (in UTC), by ID: masters too. */
  events: Record<string, Event>;
  /** Events whose next read Graph fails once (a 500). */
  failOnce: Set<string>;
  /** Events Graph reads on their own only after this many ms. */
  slowEvents: number;
  /** A skip token Graph answers only after `ms`. */
  slow?: { skip: string; ms: number };
  /** Answers every request instead, when it answers. */
  answer?: (url: URL) => Response | undefined;
}

const calendar: Calendar = {
  feed: {},
  events: {},
  failOnce: new Set(),
  slowEvents: 0,
  graphPage: 1000,
  honoursPageSize: true,
};

const reset = (): void => {
  calendar.feed = {};
  calendar.events = {};
  calendar.failOnce = new Set();
  calendar.slowEvents = 0;
  calendar.graphPage = 1000;
  calendar.honoursPageSize = true;
  calendar.slow = undefined;
  calendar.answer = undefined;
};

/** The listing's start: no token, and a window. */
const start = "";

/**
 * One page of the feed: from the window (the listing's start) or a delta
 * token, a page at a time with a skip token that carries where it is.
 */
const feedPage = (url: URL, prefer: string): Response => {
  // calendarView delta takes no `$select` (event-delta): Graph refuses it.
  if (url.searchParams.has("$select")) {
    return Response.json(
      { error: { code: "ErrorInvalidUrlQuery" } },
      { status: 400 }
    );
  }
  const asked = /odata\.maxpagesize=(?<size>\d+)/u.exec(prefer)?.groups?.size;
  const size =
    calendar.honoursPageSize && asked !== undefined
      ? Math.min(Number(asked), calendar.graphPage)
      : calendar.graphPage;
  const skip = url.searchParams.get("$skiptoken");
  const [token = "", from = "0"] = (
    skip ??
    url.searchParams.get("$deltatoken") ??
    start
  ).split("~");
  const at = calendar.feed[token];
  if (at === undefined) {
    return Response.json(
      { error: { code: "syncStateNotFound" } },
      { status: 410 }
    );
  }
  const offset = Number(from);
  const value = at.events.slice(offset, offset + size);
  const more = offset + size < at.events.length;
  return Response.json({
    value,
    ...(more
      ? {
          "@odata.nextLink": `https://${graphHost}${deltaPath}?$skiptoken=${token}~${offset + size}`,
        }
      : {
          "@odata.deltaLink": `https://${graphHost}${deltaPath}?$deltatoken=${at.end}`,
        }),
  });
};

/** One event, as Graph reads it on its own. */
const eventAnswer = (url: URL): Response => {
  const id = decodeURIComponent(url.pathname.slice(eventsPath.length + 1));
  if (calendar.failOnce.delete(id)) {
    return Response.json(
      { error: { code: "ErrorInternalServerError" } },
      { status: 500 }
    );
  }
  const found = calendar.events[id];
  return found === undefined
    ? Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 })
    : Response.json(found);
};

const internet = fakeInternet(async (request, url) => {
  if (
    calendar.slow !== undefined &&
    url.searchParams.get("$skiptoken") === calendar.slow.skip
  ) {
    await scheduler.wait(calendar.slow.ms);
  }
  const answered = calendar.answer?.(url);
  if (answered !== undefined) {
    return answered;
  }
  if (url.hostname === graphHost && url.pathname === deltaPath) {
    return feedPage(url, request.headers.get("prefer") ?? "");
  }
  if (url.hostname === graphHost && url.pathname.startsWith(`${eventsPath}/`)) {
    if (calendar.slowEvents > 0) {
      await scheduler.wait(calendar.slowEvents);
    }
    return eventAnswer(url);
  }
  return Response.json({ error: { code: "NotFound" } }, { status: 404 });
});

/** What reached the feed. */
const feedRequests = () =>
  internet.sent.filter(
    ({ host, path }) => host === graphHost && path.startsWith(deltaPath)
  );

/** The connected person's Entra object ID, as Graph's /me gives it. */
let ownerId = "";

/** Someone's own Microsoft account, connected. */
const connected = async (): Promise<string> => {
  reset();
  const person = someone();
  const account = ownAccount(person);
  ownerId = account.subject.toLowerCase();
  return await connectAccount(providers, person, account);
};

const read = async (
  connectionId: string,
  cursor: string | null
): Promise<SyncPage> =>
  await exports.default.readSyncPage({
    connectionId,
    feed: "calendar",
    place: "own",
    cursor,
  });

/** An event in the calendar. */
const event = (id: string, fields: Record<string, unknown> = {}): Event => ({
  id,
  changeKey: `${id}-1`,
  lastModifiedDateTime: "2026-11-10T09:00:00Z",
  subject: `Meeting ${id}`,
  body: { contentType: "text", content: `Agenda of ${id}` },
  start: { dateTime: "2026-11-20T10:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-20T11:00:00.0000000", timeZone: "UTC" },
  isAllDay: false,
  isCancelled: false,
  location: { displayName: "Room 2" },
  organizer: { emailAddress: { name: "Ann", address: "ann@acme.test" } },
  attendees: [{ emailAddress: { address: "me@acme.test" } }],
  ...fields,
});

/** An item's text, if it has any. */
const textOf = (item: SyncItem | undefined): string =>
  item?.gone === false && item.content?.type === "text"
    ? item.content.text
    : "";

/** An item's time and repeat lines. */
const linesOf = (items: readonly SyncItem[], id: string): string[] =>
  textOf(items.find((each) => each.id === id))
    .split("\n")
    .filter((line) =>
      /^(?:Start|End|Time zone|End time zone|Repeats): /u.test(line)
    );

/** Reads every page until there is no more, and what they held. */
const readAll = async (
  connectionId: string,
  from: string | null
): Promise<{ items: SyncItem[]; cursor: string | null }> => {
  const items: SyncItem[] = [];
  let cursor = from;
  let page: SyncPage;
  let reads = 0;
  do {
    // oxlint-disable-next-line no-await-in-loop -- pages come one after another
    page = await read(connectionId, cursor);
    items.push(...page.items);
    ({ cursor } = page);
    reads += 1;
  } while (page.more && reads < 20);
  return { items, cursor };
};

describe("syncing a person's own calendar", () => {
  it("brings in every event in the window, and nothing cancelled", async () => {
    const connectionId = await connected();
    calendar.feed[start] = {
      events: [event("review"), event("off", { isCancelled: true })],
      end: "t1",
    };
    const before = Date.now();
    const page = await read(connectionId, null);
    expect(page.items).toStrictEqual([
      {
        gone: false,
        id: "review",
        kind: "event",
        version: "review-1",
        changedAt: "2026-11-10T09:00:00Z",
        title: "Meeting review",
        content: {
          type: "text",
          text: "Subject: Meeting review\nStart: 2026-11-20T10:00:00.0000000 UTC\nEnd: 2026-11-20T11:00:00.0000000 UTC\nLocation: Room 2\nOrganizer: Ann <ann@acme.test>\nAttendees: me@acme.test\n\nAgenda of review",
        },
        readers: [{ kind: "account", id: ownerId }],
        changedBy: null,
        partOf: null,
      },
      { gone: true, id: "off", kind: "event" },
    ]);
    // A year back and a year ahead of when the listing began.
    const [listing] = feedRequests();
    const url = new URL(`https://${graphHost}${listing?.path ?? ""}`);
    const from = Date.parse(url.searchParams.get("startDateTime") ?? "");
    const to = Date.parse(url.searchParams.get("endDateTime") ?? "");
    expect({
      more: page.more,
      span: to - from,
      near: Math.abs(from + year - before) < 60_000,
      bodyAsText: listing?.headers.prefer?.includes(
        'outlook.body-content-type="text"'
      ),
    }).toStrictEqual({
      more: false,
      span: 2 * year,
      near: true,
      bodyAsText: true,
    });
  });

  it("then brings only what changed, and what was removed", async () => {
    const connectionId = await connected();
    calendar.feed[start] = { events: [event("a"), event("b")], end: "t1" };
    const first = await read(connectionId, null);

    calendar.feed.t1 = {
      events: [
        event("a", { changeKey: "a-2", subject: "Moved" }),
        { id: "b", "@removed": { reason: "deleted" } },
      ],
      end: "t2",
    };
    const changes = await read(connectionId, first.cursor);
    expect(changes).toMatchObject({
      items: [
        { id: "a", version: "a-2", title: "Moved" },
        { gone: true, id: "b" },
      ],
      more: false,
    });

    // Nothing changed since: nothing, from the same place.
    calendar.feed.t2 = { events: [], end: "t2" };
    const quiet = await read(connectionId, changes.cursor);
    expect(quiet).toStrictEqual({
      items: [],
      cursor: changes.cursor,
      more: false,
    });
  });

  it("asks Graph for one event a page and goes on from the next, skipping none", async () => {
    const connectionId = await connected();
    // Three such events fill a page's content.
    const long = "x".repeat(3 * 1024 * 1024);
    const events = Array.from({ length: 12 }, (_, index) =>
      event(`e${index}`, { body: { contentType: "text", content: long } })
    );
    calendar.feed[start] = { events, end: "t1" };
    const { items } = await readAll(connectionId, null);
    expect(items.map(({ id }) => id)).toStrictEqual(events.map(({ id }) => id));
    expect(
      items.every((item) => !item.gone && item.content !== null)
    ).toBeTruthy();
  });

  it("goes on after the last event handled when Graph sends more than asked", async () => {
    const connectionId = await connected();
    calendar.honoursPageSize = false;
    calendar.graphPage = 5;
    // Four such events fill a page's content, inside Graph's page of five.
    const long = "x".repeat(1.9 * 1024 * 1024);
    const events = Array.from({ length: 12 }, (_, index) =>
      event(`e${index}`, { body: { contentType: "text", content: long } })
    );
    calendar.feed[start] = { events, end: "t1" };
    const { items } = await readAll(connectionId, null);
    expect(items.map(({ id }) => id)).toStrictEqual(events.map(({ id }) => id));
  });

  it(
    "answers with what it has when Graph's next page is late, and waits when it has nothing",
    { timeout: 120_000 },
    async () => {
      const connectionId = await connected();
      calendar.feed[start] = {
        events: [event("a"), event("b")],
        end: "t1",
      };
      // The second event's page: always past the page's deadline.
      calendar.slow = { skip: "~1", ms: 35_000 };
      const first = await read(connectionId, null);
      const late = await read(connectionId, first.cursor).catch(
        (error: unknown) => error
      );
      calendar.slow = undefined;
      const next = await read(connectionId, first.cursor);
      expect({
        first: first.items.map(({ id }) => id),
        firstMore: first.more,
        late: syncErrors.codeOf(late),
        next: next.items.map(({ id }) => id),
      }).toStrictEqual({
        first: ["a"],
        firstMore: true,
        late: "sync.throttled",
        next: ["b"],
      });
    }
  );

  it("reads Graph's page from its top again when the event it stopped after changed meanwhile", async () => {
    const connectionId = await connected();
    calendar.honoursPageSize = false;
    calendar.graphPage = 5;
    // Four such events fill a page's content, inside Graph's page of five.
    const long = "x".repeat(1.9 * 1024 * 1024);
    const events = Array.from({ length: 10 }, (_, index) =>
      event(`e${index}`, { body: { contentType: "text", content: long } })
    );
    calendar.feed[start] = { events, end: "t1" };
    const first = await read(connectionId, null);

    // e3, the last one handled, changes and comes later in the feed now.
    calendar.feed[start] = {
      events: [
        ...events.filter(({ id }) => id !== "e3"),
        event("e3", {
          changeKey: "e3-2",
          body: { contentType: "text", content: long },
        }),
      ],
      end: "t1",
    };
    const { items } = await readAll(connectionId, first.cursor);
    expect({
      first: first.items.map(({ id }) => id),
      seen: [
        ...new Set([...first.items, ...items].map(({ id }) => id)),
      ].toSorted(),
    }).toStrictEqual({
      first: ["e0", "e1", "e2", "e3"],
      seen: events.map(({ id }) => id).toSorted(),
    });
  });

  it("keeps each occurrence's own time across a daylight saving change, names its zone, and says how it repeats", async () => {
    const connectionId = await connected();
    // 09:00 in Amsterdam, every Monday: 07:00 UTC in summer time, 08:00 UTC
    // after the clocks go back on 25 October 2026.
    const occurrence = (id: string, from: string, to: string) =>
      event(id, {
        subject: "Stand-up",
        originalStartTimeZone: "W. Europe Standard Time",
        originalEndTimeZone: "W. Europe Standard Time",
        seriesMasterId: "standup",
        start: { dateTime: from, timeZone: "UTC" },
        end: { dateTime: to, timeZone: "UTC" },
      });
    const before = occurrence(
      "standup-1019",
      "2026-10-19T07:00:00.0000000",
      "2026-10-19T07:15:00.0000000"
    );
    const after = occurrence(
      "standup-1026",
      "2026-10-26T08:00:00.0000000",
      "2026-10-26T08:15:00.0000000"
    );
    // A flight that lands in another zone than it leaves from.
    const flight = event("flight", {
      originalStartTimeZone: "W. Europe Standard Time",
      originalEndTimeZone: "GMT Standard Time",
    });
    calendar.events = {
      standup: event("standup", {
        recurrence: {
          pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] },
          range: {
            type: "noEnd",
            startDate: "2026-10-05",
            recurrenceTimeZone: "W. Europe Standard Time",
          },
        },
      }),
    };
    calendar.feed[start] = { events: [before, after, flight], end: "t1" };
    const { items } = await readAll(connectionId, null);
    const repeats =
      "Repeats: weekly, every 1 week on monday; from 2026-10-05, no end (W. Europe Standard Time)";
    expect({
      before: linesOf(items, "standup-1019"),
      after: linesOf(items, "standup-1026"),
      flight: linesOf(items, "flight"),
    }).toStrictEqual({
      before: [
        "Start: 2026-10-19T07:00:00.0000000 UTC",
        "End: 2026-10-19T07:15:00.0000000 UTC",
        "Time zone: W. Europe Standard Time",
        repeats,
      ],
      after: [
        "Start: 2026-10-26T08:00:00.0000000 UTC",
        "End: 2026-10-26T08:15:00.0000000 UTC",
        "Time zone: W. Europe Standard Time",
        repeats,
      ],
      flight: [
        "Start: 2026-11-20T10:00:00.0000000 UTC",
        "End: 2026-11-20T11:00:00.0000000 UTC",
        "Time zone: W. Europe Standard Time",
        "End time zone: GMT Standard Time",
      ],
    });
  });

  it("reads each series' repeats within a page's requests, leaving the rest to the next page", async () => {
    const connectionId = await connected();
    // Sixty occurrences, each of its own series: a read for each.
    const many = Array.from({ length: 60 }, (_, index) =>
      event(`e${index}`, { seriesMasterId: `series-${index}` })
    );
    calendar.events = Object.fromEntries(
      many.map((_, index) => [
        `series-${index}`,
        event(`series-${index}`, {
          recurrence: {
            pattern: { type: "daily", interval: 1 },
            range: { type: "noEnd", startDate: "2026-11-01" },
          },
        }),
      ])
    );
    calendar.feed[start] = { events: many, end: "t1" };
    const sent: number[] = [];
    const items: SyncItem[] = [];
    let cursor: string | null = null;
    let page: SyncPage;
    let reads = 0;
    do {
      const before = internet.sent.length;
      // oxlint-disable-next-line no-await-in-loop -- pages come one after another
      page = await read(connectionId, cursor);
      sent.push(internet.sent.length - before);
      items.push(...page.items);
      ({ cursor } = page);
      reads += 1;
    } while (page.more && reads < 10);
    expect({
      // The person's own `/me` read, answered by the sign-in fake, is the
      // fiftieth a connector's isolate may send.
      withinRequests: sent.every((count) => count <= 49),
      reads: reads > 1,
      all: items.map(({ id }) => id),
      repeats: items.every((item) =>
        textOf(item).includes(
          "Repeats: daily, every 1 day; from 2026-11-01, no end"
        )
      ),
    }).toStrictEqual({
      withinRequests: true,
      reads: true,
      all: many.map(({ id }) => id),
      repeats: true,
    });
  });

  it("says no repeats for a series whose master is gone, or whose read fails, and keeps the page", async () => {
    const connectionId = await connected();
    const daily = event("daily", {
      recurrence: {
        pattern: { type: "daily", interval: 1 },
        range: { type: "noEnd", startDate: "2026-11-01" },
      },
    });
    calendar.events = { daily };
    // Its master deleted between the listing and its read.
    const orphan = event("orphan", { seriesMasterId: "deleted-master" });
    // Graph fails the first read of `daily`: that occurrence goes without
    // its repeats, and the next one of the series reads them again.
    calendar.failOnce = new Set(["daily"]);
    const first = event("daily-1", { seriesMasterId: "daily" });
    const second = event("daily-2", { seriesMasterId: "daily" });
    calendar.feed[start] = { events: [orphan, first, second], end: "t1" };
    const { items } = await readAll(connectionId, null);
    const repeats = (id: string) =>
      linesOf(items, id).filter((line) => line.startsWith("Repeats: "));
    expect({
      orphan: repeats("orphan"),
      first: repeats("daily-1"),
      second: repeats("daily-2"),
      kept: items.map(({ id }) => id),
    }).toStrictEqual({
      orphan: [],
      first: [],
      second: ["Repeats: daily, every 1 day; from 2026-11-01, no end"],
      kept: ["orphan", "daily-1", "daily-2"],
    });
  });

  it(
    "keeps every event's text and time when its series' repeats are always late, without them",
    { timeout: 180_000 },
    async () => {
      const connectionId = await connected();
      calendar.events = {
        weekly: event("weekly", {
          recurrence: {
            pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] },
            range: { type: "noEnd", startDate: "2026-11-02" },
          },
        }),
      };
      // Past the page's deadline, and past the 30 s connect waits.
      calendar.slowEvents = 35_000;
      calendar.feed[start] = {
        events: [
          event("w1", { seriesMasterId: "weekly" }),
          event("w2", { seriesMasterId: "weekly" }),
        ],
        end: "t1",
      };
      const { items } = await readAll(connectionId, null);
      expect(
        items.map((item) => [item.id, linesOf(items, item.id)])
      ).toStrictEqual([
        [
          "w1",
          [
            "Start: 2026-11-20T10:00:00.0000000 UTC",
            "End: 2026-11-20T11:00:00.0000000 UTC",
          ],
        ],
        [
          "w2",
          [
            "Start: 2026-11-20T10:00:00.0000000 UTC",
            "End: 2026-11-20T11:00:00.0000000 UTC",
          ],
        ],
      ]);
    }
  );

  it("lists again when Graph no longer knows the token, or the window is a year old", async () => {
    const connectionId = await connected();
    calendar.feed[start] = { events: [], end: "t1" };
    const { cursor } = await read(connectionId, null);

    // Graph forgot the token.
    calendar.feed = {};
    await expect(read(connectionId, cursor)).rejects.toMatchObject({
      code: "sync.restart",
    });
    const old = `e.${Date.now() - year - 60_000}.d.dDE.~`;
    await expect(read(connectionId, old)).rejects.toMatchObject({
      code: "sync.restart",
    });
    await expect(read(connectionId, "x.1.n.")).rejects.toMatchObject({
      code: "sync.restart",
    });
  });

  it("waits when Graph throttles, as long as it asks", async () => {
    const connectionId = await connected();
    calendar.answer = () =>
      new Response(null, { status: 429, headers: { "retry-after": "30" } });
    const limited = await read(connectionId, null).catch(
      (error: unknown) => error
    );
    expect(syncErrors.codeOf(limited)).toBe("sync.throttled");
    expect(limited).toMatchObject({ details: { retryAfterMs: 30_000 } });
  });
});
