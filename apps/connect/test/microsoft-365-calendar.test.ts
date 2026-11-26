import { signCapability } from "@grasp-os/shared/capability";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import {
  agentFor,
  callAs,
  chatOrigin,
  connectAccount,
  outcome,
  ownAccount,
} from "./connect.ts";
import { ceo, invoices, eventId } from "./fixtures/graph.ts";
import {
  accessDenied,
  amsterdam,
  audit,
  connected,
  connectedWith,
  createEvent,
  createFocusTime,
  focusTime,
  grantOf,
  graph,
  graphPaths,
  madeId,
  mailboxPath,
  providers,
  readEvent,
  readOnlyCalendars,
  requests,
  statusOf,
  updateEvent,
} from "./microsoft-365-harness.ts";
import {
  callTool as call,
  claimedAgo,
  outputOf,
  resultOf,
  toolError,
} from "./tool-calls.ts";
import type { Input } from "./tool-calls.ts";

// The Microsoft 365 connector against Graph's recorded answers, through
// connect's real call path: capability, policy, a fresh isolate, the
// egress (which adds the token and holds each call to its routes), and
// back. Scoping comes first: a call for one mailbox or drive reaches only
// that one, by construction.

/** A write's start or end: a wall-clock time, in Amsterdam unless given. */
const at = (dateTime: string, timeZone = amsterdam) => ({ dateTime, timeZone });

/** An arg as a card shows it: an object as its JSON. */
const shown = (value: object): string => JSON.stringify(value, null, 2);

/** An hour's start and end in `timeZone`. */
const inZone = (timeZone: string) => ({
  start: at("2026-10-26T14:00", timeZone),
  end: at("2026-10-26T15:00", timeZone),
});

describe("the Microsoft 365 connector's calendar tools", () => {
  it("list a range of events in UTC, page by page", async () => {
    const connection = await connected();
    const range = {
      mailbox: invoices,
      startDateTime: "2026-09-28T00:00:00Z",
      endDateTime: "2026-10-05T00:00:00Z",
      top: 1,
    };
    const skipToken = "d2c7f1a0-5b9e-4d1c-8e6a-3f2b7c9d0e1f";
    const first = await resultOf(
      call(connection, "users.calendarView.list", range)
    );
    expect(first).toMatchObject({
      output: {
        items: [
          {
            id: eventId(invoices, 1),
            subject: "Month-end close",
            start: { dateTime: "2026-09-29T09:00:00.0000000", timeZone: "UTC" },
            location: { displayName: "Room 4.12" },
          },
        ],
        next: `%24skiptoken=${skipToken}`,
      },
      provenance: [eventId(invoices, 1)],
    });
    await expect(
      outputOf(
        call(connection, "users.calendarView.list", {
          ...range,
          next: `%24skiptoken=${skipToken}`,
        })
      )
    ).resolves.toMatchObject({
      items: [{ id: eventId(invoices, 2) }],
      next: null,
    });
    expect(requests()).toMatchObject([
      {
        path: `${mailboxPath}/calendarView`,
        query: {
          startDateTime: range.startDateTime,
          endDateTime: range.endDateTime,
        },
        headers: { prefer: 'outlook.timezone="UTC"' },
      },
      { path: `${mailboxPath}/calendarView`, query: { $skiptoken: skipToken } },
    ]);
    await expect(
      toolError(
        call(connection, "users.calendarView.list", {
          ...range,
          endDateTime: range.startDateTime,
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
  });

  it("get an event with its body and attendees", async () => {
    const connection = await connected();
    await expect(
      resultOf(
        call(connection, "users.events.get", {
          mailbox: invoices,
          event: eventId(invoices, 1),
        })
      )
    ).resolves.toMatchObject({
      output: {
        id: eventId(invoices, 1),
        body: { contentType: "text" },
        attendees: [
          {
            type: "required",
            status: { response: "accepted" },
            emailAddress: {
              name: "Controller",
              address: "controller@example.com",
            },
          },
        ],
      },
      provenance: [eventId(invoices, 1)],
    });
    expect(graphPaths()).toStrictEqual([
      `${mailboxPath}/events/${encodeURIComponent(eventId(invoices, 1))}`,
    ]);
  });
});

describe("the Microsoft 365 connector's view of the person's own calendar", () => {
  it("lists their own events in UTC under /me, page by page, to find their free time in", async () => {
    const connection = await connected();
    const own = connection.person.email;
    graph.holdEvents(own, [
      { start: "2026-10-26T08:00:00", end: "2026-10-26T09:00:00" },
      { start: "2026-10-26T11:00:00", end: "2026-10-26T12:00:00" },
      {
        start: "2026-10-26T14:00:00",
        end: "2026-10-26T15:00:00",
        showAs: "free",
      },
    ]);
    const range = {
      startDateTime: "2026-10-23T22:00:00.000Z",
      endDateTime: "2026-10-26T23:00:00.000Z",
    };
    const first = await outputOf(
      call(connection, "me.calendarView.list", range)
    );
    expect(first).toStrictEqual({
      items: [
        {
          id: "held-0",
          start: { dateTime: "2026-10-26T08:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-10-26T09:00:00.0000000", timeZone: "UTC" },
          isAllDay: false,
          isCancelled: false,
          showAs: "busy",
        },
        {
          id: "held-1",
          start: { dateTime: "2026-10-26T11:00:00.0000000", timeZone: "UTC" },
          end: { dateTime: "2026-10-26T12:00:00.0000000", timeZone: "UTC" },
          isAllDay: false,
          isCancelled: false,
          showAs: "busy",
        },
      ],
      next: "%24skiptoken=2",
    });
    await expect(
      outputOf(
        call(connection, "me.calendarView.list", {
          ...range,
          next: z.object({ next: z.string() }).parse(first).next,
        })
      )
    ).resolves.toMatchObject({
      items: [{ id: "held-2", showAs: "free" }],
      next: null,
    });
    expect(requests()).toMatchObject([
      {
        path: "/v1.0/me/calendarView",
        query: range,
        headers: { prefer: 'outlook.timezone="UTC"' },
      },
      { path: "/v1.0/me/calendarView", query: { $skiptoken: "2" } },
    ]);
  });

  it("names no mailbox, and refuses a range that doesn't end after it starts or spans more than a month, before anything goes out", async () => {
    const connection = await connected();
    const range = {
      startDateTime: "2026-10-26T00:00:00Z",
      endDateTime: "2026-10-27T00:00:00Z",
    };
    // Another person's calendar, or a shared one, can't be named at all.
    for (const mailbox of [ceo, invoices]) {
      // oxlint-disable-next-line no-await-in-loop -- one calendar at a time
      await expect(
        outcome(call(connection, "me.calendarView.list", { ...range, mailbox }))
      ).resolves.toBe("connect.action_failed");
    }
    const wrongs: Input[] = [
      { endDateTime: range.startDateTime },
      { endDateTime: "2026-12-01T00:00:00Z" },
    ];
    for (const wrong of wrongs) {
      // oxlint-disable-next-line no-await-in-loop -- one input at a time
      await expect(
        toolError(
          call(connection, "me.calendarView.list", { ...range, ...wrong })
        )
      ).resolves.toMatchObject({ error: { code: "invalid" } });
    }
    expect(graphPaths()).toStrictEqual([]);
  });
});

describe("the Microsoft 365 connector's calendar writes", () => {
  it("put an event in a person's own calendar with nobody invited, its times in the organization's time zone", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const made = await outputOf(createEvent(connection, focusTime(own)));
    expect(made).toMatchObject({
      subject: "Focus time: Q4 forecast",
      start: { dateTime: "2026-10-26T14:00:00.0000000", timeZone: amsterdam },
      end: { dateTime: "2026-10-26T15:00:00.0000000", timeZone: amsterdam },
      showAs: "busy",
    });
    // What Graph was asked to make: these fields, nobody invited, and the
    // call's tag; nothing else.
    const [sent] = requests();
    expect(sent).toMatchObject({
      method: "POST",
      path: `/v1.0/users/${encodeURIComponent(own)}/events`,
      headers: { prefer: `outlook.timezone="${amsterdam}"` },
    });
    expect(
      Object.keys(
        z.record(z.string(), z.unknown()).parse(sent?.body)
      ).toSorted()
    ).toStrictEqual(
      [
        "subject",
        "start",
        "end",
        "showAs",
        "attendees",
        "singleValueExtendedProperties",
      ].toSorted()
    );
    expect(sent?.body).toMatchObject({
      start: { dateTime: "2026-10-26T14:00", timeZone: amsterdam },
      attendees: [],
    });
    await expect(
      readEvent(connection, madeId.parse(made))
    ).resolves.toMatchObject({
      subject: "Focus time: Q4 forecast",
      attendees: [],
    });
  });

  it("refuse guests, and times that aren't wall-clock times in a time zone, before anything goes out", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const changes: Input[] = [
      { attendees: [{ emailAddress: { address: "guest@example.org" } }] },
      { requiredAttendees: ["guest@example.org"] },
      { start: at("2026-10-26T14:00:00Z") },
      { start: at("2026-10-26T14:00+01:00") },
      // A day that doesn't exist, which Date.parse would move on.
      { start: at("2026-02-30T10:00") },
      inZone("Mars/Olympus_Mons"),
      inZone('UTC", outlook.body-content-type="html'),
      { end: at("2026-10-26T13:00") },
      { end: at("2026-10-26T15:00", "Europe/London") },
    ];
    const refusals = await Promise.all(
      changes.map(
        async (change) =>
          await outcome(
            createEvent(connection, { ...focusTime(own), ...change })
          )
      )
    );
    // Guests are input the tool doesn't have: connect refuses them before
    // the tool does. The tool refuses the rest.
    expect(refusals).toStrictEqual([
      "connect.resource_out_of_scope",
      "connect.resource_out_of_scope",
      ...Array.from({ length: 7 }, () => "connect.action_failed"),
    ]);
    expect(graph.sent).toStrictEqual([]);
  });

  it("are shown for the person to confirm as the card will show them, and made once confirmed", async () => {
    const connection = await connected();
    const { person } = connection;
    const input = {
      ...focusTime(person.email),
      location: { displayName: "Desk 3" },
    };
    const inChat = agentFor(person.userId, "agent-chat", "interactive");
    const asked = {
      connectionId: connection.id,
      action: "users.events.create",
      input,
      resource: person.email,
      idempotencyKey: `chat-1:${crypto.randomUUID()}`,
    };
    await callAs(inChat, asked);
    const [held] = await exports.default.listPendingActions(person, "grasp");
    expect({ held: held?.description, sent: graph.sent }).toStrictEqual({
      held: {
        title: "Put an event in your calendar",
        fields: [
          { input: "mailbox", label: "Calendar", value: person.email },
          { input: "subject", label: "Title", value: input.subject },
          // An object arg shows as its JSON.
          { input: "start", label: "Starts", value: shown(input.start) },
          { input: "end", label: "Ends", value: shown(input.end) },
          { input: "location", label: "Where", value: shown(input.location) },
        ],
        complete: true,
      },
      sent: [],
    });
    const confirmed = await exports.default.confirmAction({
      person,
      id: held?.id ?? "",
      inputHash: held?.inputHash ?? "",
      capability: await signCapability(env.CAPABILITY_SIGNING_KEY, inChat, {
        ...asked,
        origin: chatOrigin,
        decision: { kind: "confirm", pendingActionId: held?.id ?? "" },
      }),
    });
    const made = madeId.parse(JSON.parse(confirmed.output));
    await expect(readEvent(connection, made)).resolves.toMatchObject({
      location: { displayName: "Desk 3" },
      attendees: [],
    });
  });

  it("move an event the person organised alone, in the organization's time zone", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const made = madeId.parse(
      await outputOf(createEvent(connection, focusTime(own)))
    );
    const moved = await outputOf(
      updateEvent(connection, {
        mailbox: own,
        event: made,
        start: { dateTime: "2026-10-27T09:30", timeZone: amsterdam },
        end: { dateTime: "2026-10-27T10:30", timeZone: amsterdam },
      })
    );
    expect(moved).toMatchObject({
      id: made,
      start: { dateTime: "2026-10-27T09:30:00.0000000", timeZone: amsterdam },
      subject: "Focus time: Q4 forecast",
    });
    const patch = requests().find(({ method }) => method === "PATCH");
    expect(patch?.body).toStrictEqual({
      start: { dateTime: "2026-10-27T09:30", timeZone: amsterdam },
      end: { dateTime: "2026-10-27T10:30", timeZone: amsterdam },
    });
  });

  it("refuse to change an event with guests, or one someone else organised, and change nothing", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const errors = await Promise.all(
      // The first has a guest; the CEO organised the second, and hides
      // its guests.
      [eventId(own, 1), eventId(own, 2)].map(
        async (event) =>
          await toolError(
            updateEvent(connection, {
              mailbox: own,
              event,
              subject: "Moved",
            })
          )
      )
    );
    expect(errors).toMatchObject([
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
    ]);
    expect(graph.writesDone()).toBe(0);
  });

  it("refuse a change when Graph's answer doesn't say who is invited", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const made = madeId.parse(
      await outputOf(createEvent(connection, focusTime(own)))
    );
    const outcomes: string[] = [];
    for (const how of ["missing", "null"] as const) {
      graph.leaveOutAttendees(how);
      outcomes.push(
        // oxlint-disable-next-line no-await-in-loop -- one read left out at a time
        await outcome(
          updateEvent(connection, {
            mailbox: own,
            event: made,
            subject: "Moved",
          })
        )
      );
    }
    expect(outcomes).toStrictEqual([
      "connect.action_failed",
      "connect.action_failed",
    ]);
    expect(graph.writesDone()).toBe(1);
  });

  it("refuse a change once a guest was invited after the event was checked", async () => {
    const connection = await connected();
    const own = connection.person.email;
    const made = madeId.parse(
      await outputOf(createEvent(connection, focusTime(own)))
    );
    graph.inviteDuringRead();
    await expect(
      outcome(
        updateEvent(connection, {
          mailbox: own,
          event: made,
          subject: "Moved",
        })
      )
    ).resolves.toBe("connect.action_failed");
    await expect(readEvent(connection, made)).resolves.toMatchObject({
      subject: "Focus time: Q4 forecast",
      attendees: [{ emailAddress: { address: "guest@example.org" } }],
    });
  });
});

describe("the Microsoft 365 connector's calendar writes, when something goes wrong", () => {
  it("find an event whose answer was lost by its tag, and never make it twice", async () => {
    const connection = await connected();
    graph.loseWriteAnswer();
    await expect(
      outcome(createFocusTime(connection, "run-4:hold"))
    ).resolves.toBe("connect.outcome_unknown");
    await claimedAgo(connection);
    const found = await outputOf(createFocusTime(connection, "run-4:hold"));
    expect({
      found,
      writesDone: graph.writesDone(),
      lookups: requests()
        .filter(({ method }) => method === "GET")
        .map(({ path, headers }) => ({ path, prefer: headers.prefer })),
    }).toMatchObject({
      found: {
        subject: "Focus time: Q4 forecast",
        start: {
          dateTime: "2026-10-26T14:00:00.0000000",
          timeZone: amsterdam,
        },
      },
      writesDone: 1,
      lookups: [
        {
          path: `/v1.0/users/${encodeURIComponent(connection.person.email)}/events`,
          prefer: `outlook.timezone="${amsterdam}"`,
        },
      ],
    });
  });

  it("report a connection made before it could write calendars for reconnecting, in place, and go through once it is", async () => {
    const connection = await connectedWith(readOnlyCalendars);
    graph.failWrite(403, accessDenied);
    const refused = await outcome(createFocusTime(connection, "run-5:hold"));
    const status = await statusOf(connection);
    const audited = await audit.events();
    // The person reconnects, granting the new right: the same connection,
    // and the same call goes out under its key.
    const reconnected = await connectAccount(providers, connection.person, {
      ...ownAccount(connection.person),
      granted: grantOf([...readOnlyCalendars, "Calendars.ReadWrite"]),
    });
    const again = await outcome(createFocusTime(connection, "run-5:hold"));
    expect({
      refused,
      status,
      marked: audited
        .filter(({ action }) => action === "connection.needs_reauth")
        .map(({ detail }) => detail),
      sameConnection: reconnected === connection.id,
      again,
      writesDone: graph.writesDone(),
    }).toStrictEqual({
      refused: "connect.connection_inactive",
      status: "needs_reauth",
      marked: [{ provider: "microsoft", reason: "scopes_missing" }],
      sameConnection: true,
      again: "ok",
      writesDone: 1,
    });
  });

  it("let every call Graph refused before the connection was marked go through once it is reconnected", async () => {
    const connection = await connectedWith(readOnlyCalendars);
    // A second call is refused while the first's refusal is still on its
    // way: the second marks the connection, so the first finds it marked.
    let second = "";
    graph.failWrite(403, accessDenied, async () => {
      graph.failWrite(403, accessDenied);
      second = await outcome(createFocusTime(connection, "run-7:second"));
    });
    const first = await outcome(createFocusTime(connection, "run-7:first"));
    await connectAccount(providers, connection.person, {
      ...ownAccount(connection.person),
      granted: grantOf([...readOnlyCalendars, "Calendars.ReadWrite"]),
    });
    const again = [
      await outcome(createFocusTime(connection, "run-7:first")),
      await outcome(createFocusTime(connection, "run-7:second")),
    ];
    expect({
      first,
      second,
      again,
      writesDone: graph.writesDone(),
    }).toStrictEqual({
      first: "connect.connection_inactive",
      second: "connect.connection_inactive",
      again: ["ok", "ok"],
      writesDone: 2,
    });
  });

  it("keep a connection granted every right, or whose grant isn't known, when Graph refuses it a calendar", async () => {
    const granted = await connectedWith([
      ...readOnlyCalendars,
      "Calendars.ReadWrite",
      "Notes.ReadWrite",
    ]);
    // Tokens stored before connect kept their grant.
    const unknown = await connected();
    const outcomes: string[] = [];
    for (const connection of [granted, unknown]) {
      graph.failWrite(403, accessDenied);
      outcomes.push(
        // oxlint-disable-next-line no-await-in-loop -- one write failed at a time
        await outcome(createFocusTime(connection, "run-6:hold")),
        // oxlint-disable-next-line no-await-in-loop -- one write failed at a time
        (await statusOf(connection)) ?? "none"
      );
    }
    expect(outcomes).toStrictEqual([
      "connect.action_failed",
      "active",
      "connect.action_failed",
      "active",
    ]);
  });
});
