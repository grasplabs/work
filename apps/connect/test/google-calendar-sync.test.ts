import type { SyncPageRequest } from "@grasp-os/shared/sync";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";

import { connectAccount, ownAccount, someone } from "./connect.ts";
import { fakeInternet } from "./internet.ts";
import { fakeProviders } from "./oauth-provider.ts";

// The Google Workspace connector's Calendar sync (calendar-sync.ts),
// through connect's real read (src/sync.ts): a fresh isolate, the egress
// that adds the token, and Calendar mocked at its host. The ways it can
// fail come first: attendees taken for readers, a cancelled event still
// answering, a later read bringing everything again instead of what
// changed, a gone sync token taken for a failure, another calendar than
// the person's own read.

const providers = fakeProviders();

const apisHost = "www.googleapis.com";
const primary = "/calendar/v3/calendars/primary";

/** What the calendar answers, for each test to set: by sync token ("" for the full listing). */
const calendar: { pages: Record<string, Record<string, unknown>> } = {
  pages: {},
};

const internet = fakeInternet((_request, url) => {
  if (url.hostname !== apisHost) {
    return new Response(null, { status: 404 });
  }
  if (url.pathname === primary) {
    return Response.json({ id: "Owner@Acme.test" });
  }
  if (url.pathname === `${primary}/events`) {
    const page =
      calendar.pages[
        `${url.searchParams.get("syncToken") ?? ""}/${url.searchParams.get("pageToken") ?? ""}`
      ];
    return page === undefined
      ? Response.json({ error: { code: 410 } }, { status: 410 })
      : Response.json(page);
  }
  return new Response(null, { status: 404 });
});

/** Someone's own Google account, connected. */
const connected = async (): Promise<string> => {
  calendar.pages = {};
  const person = someone();
  return await connectAccount(providers, person, ownAccount(person, "google"));
};

const request = (
  connectionId: string,
  cursor: string | null
): SyncPageRequest => ({
  connectionId,
  feed: "calendar",
  place: "own",
  cursor,
});

const read = async (connectionId: string, cursor: string | null) =>
  await exports.default.readSyncPage(request(connectionId, cursor));

const review = {
  id: "review",
  status: "confirmed",
  etag: '"3181161784712000"',
  updated: "2026-11-10T09:00:00.000Z",
  summary: "Price review",
  description: "Coffee goes to 3.40",
  location: "Room 2",
  start: { dateTime: "2026-11-20T10:00:00Z" },
  end: { dateTime: "2026-11-20T11:00:00Z" },
  recurrence: ["RRULE:FREQ=MONTHLY"],
  organizer: { email: "owner@acme.test" },
  attendees: [
    { email: "sales@acme.test", displayName: "Sales" },
    { email: "buyer@supplier.test" },
  ],
};

describe("syncing a person's own calendar", () => {
  it("brings in every event of their own calendar, page by page, its owner its one reader", async () => {
    const connectionId = await connected();
    calendar.pages = {
      "/": { items: [review], nextPageToken: "p2" },
      "/p2": {
        items: [{ ...review, id: "standup", summary: "Standup" }],
        nextSyncToken: "sync-1",
      },
    };
    const first = await read(connectionId, null);
    expect(first.items).toStrictEqual([
      {
        gone: false,
        id: "review",
        kind: "event",
        version: '"3181161784712000"',
        changedAt: "2026-11-10T09:00:00.000Z",
        title: "Price review",
        content: {
          type: "text",
          text: "Title: Price review\nStart: 2026-11-20T10:00:00Z\nEnd: 2026-11-20T11:00:00Z\nRepeats: RRULE:FREQ=MONTHLY\nLocation: Room 2\nOrganizer: owner@acme.test\nAttendees: Sales <sales@acme.test>, buyer@supplier.test\n\nCoffee goes to 3.40",
        },
        // Attendees aren't readers: the event is its owner's own.
        readers: [{ kind: "account", id: "owner@acme.test" }],
        changedBy: null,
        partOf: null,
      },
    ]);
    expect(first.more).toBeTruthy();

    const second = await read(connectionId, first.cursor);
    expect(second.items.map(({ id }) => id)).toStrictEqual(["standup"]);
    expect(second.more).toBeFalsy();
    // Only the person's own calendar was read.
    expect(
      internet.sent
        .filter(({ host }) => host === apisHost)
        .every(({ path }) => path.startsWith(primary))
    ).toBeTruthy();
  });

  it("then brings only what changed, and takes away what was cancelled", async () => {
    const connectionId = await connected();
    calendar.pages = {
      "/": { items: [review], nextSyncToken: "sync-1" },
      "sync-1/": {
        items: [
          {
            ...review,
            etag: '"3181161784712001"',
            updated: "2026-11-17T09:00:00.000Z",
            summary: "Price review, moved",
          },
          { id: "standup", status: "cancelled" },
        ],
        nextSyncToken: "sync-2",
      },
      "sync-2/": { items: [], nextSyncToken: "sync-2" },
    };
    const listed = await read(connectionId, null);
    const changes = await read(connectionId, listed.cursor);
    expect(changes.items).toStrictEqual([
      expect.objectContaining({
        id: "review",
        version: '"3181161784712001"',
        title: "Price review, moved",
      }),
      { gone: true, id: "standup", kind: "event" },
    ]);
    const quiet = await read(connectionId, changes.cursor);
    expect(quiet).toStrictEqual({
      items: [],
      cursor: changes.cursor,
      more: false,
    });
  });

  it("lists again when Calendar no longer has the sync token", async () => {
    const connectionId = await connected();
    calendar.pages = { "/": { items: [], nextSyncToken: "sync-1" } };
    const listed = await read(connectionId, null);
    await expect(read(connectionId, listed.cursor)).rejects.toMatchObject({
      code: "sync.restart",
    });
  });
});
