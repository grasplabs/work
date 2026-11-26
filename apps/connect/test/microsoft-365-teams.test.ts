import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { connectAccount, outcome, ownAccount, someone } from "./connect.ts";
import {
  chatIds,
  eventIds,
  meetingIds,
  plantedInstruction,
  transcriptIds,
} from "./fixtures/graph-teams.ts";
import { ceo } from "./fixtures/graph.ts";
import { fakeGraph } from "./graph-api.ts";
import { fakeProviders } from "./oauth-provider.ts";
import {
  callTool as call,
  outputOf,
  parsedRequests,
  resultOf,
  toolError,
} from "./tool-calls.ts";
import type { Connection } from "./tool-calls.ts";

// Teams chats and meetings the person was in (GRA-747), the tools of Read
// others' words (connectors.test.ts holds each tool's class,
// class-rights.test.ts the class's rights). Against Graph's recorded
// answers, through connect's real call path. The ways each can fail, which
// the tests start from: a call names a colleague's mailbox and reads their
// chats or meetings; a chat the person isn't in, or a meeting they
// declined, is read anyway; what someone wrote or said comes back as
// anything but text attributed to them.

const providers = fakeProviders();
const graph = fakeGraph(providers);

const connected = async (): Promise<Connection> => {
  const person = someone();
  const id = await connectAccount(providers, person, ownAccount(person));
  graph.holdMeetings(person.email);
  return { id, person };
};

/** What left connect, each request with its query and JSON body parsed. */
const requests = () => parsedRequests(graph.sent);

/** The paths of what reached Graph, but who the token is for. */
const graphPaths = (): string[] =>
  requests()
    .map(({ path }) => path)
    .filter((path) => path !== "/v1.0/me");

const transcriptTool = "me.onlineMeetings.transcripts.content.getContent";

/** The content of each transcript a transcript read answered with. */
const contentsOf = (output: unknown): string[] =>
  z
    .object({ transcripts: z.array(z.object({ content: z.string() })) })
    .parse(output)
    .transcripts.map(({ content }) => content);

describe("the Microsoft 365 connector's chat tools", () => {
  it("list the person's own chats, with who is in each", async () => {
    const connection = await connected();
    await expect(
      outputOf(call(connection, "me.chats.list", {}))
    ).resolves.toMatchObject({
      items: [
        {
          id: chatIds.own,
          chatType: "oneOnOne",
          members: [{ displayName: "You" }, { displayName: "Lisa Meyer" }],
          lastUpdatedDateTime: "2026-10-20T15:42:10.000Z",
        },
      ],
      next: null,
    });
    expect(graphPaths()).toStrictEqual(["/v1.0/me/chats"]);
  });

  it("read a chat's messages as text, each with who wrote it, leaving out system and deleted ones", async () => {
    const connection = await connected();
    const { output, provenance } = await resultOf(
      call(connection, "me.chats.messages.list", { chat: chatIds.own })
    );
    expect(output).toMatchObject({
      items: [
        {
          from: { user: { displayName: "Lisa Meyer" } },
          createdDateTime: "2026-10-20T15:42:10.000Z",
          body: {
            contentType: "text",
            content:
              "Can you send me the signed Northwind contract by Friday?\nFabrikam & Contoso can wait.",
          },
        },
        // An instruction someone wrote is what they wrote, nothing more.
        {
          from: { user: { displayName: "Lisa Meyer" } },
          body: { contentType: "text", content: plantedInstruction },
        },
      ],
    });
    expect(output).toHaveProperty("items.length", 2);
    expect(provenance).toStrictEqual(["1729438930000", "1729438600000"]);
    // Reading changed nothing.
    expect(graph.writesDone()).toBe(0);
  });

  it("refuse a colleague's chats, and a chat the person isn't a member of", async () => {
    const connection = await connected();
    // A colleague's mailbox can't be named at all: every route is the
    // person's own.
    const theirs = await Promise.all(
      (
        [
          ["me.chats.list", { mailbox: ceo }],
          ["me.chats.messages.list", { mailbox: ceo, chat: chatIds.own }],
        ] as const
      ).map(
        async ([action, input]) =>
          await outcome(call(connection, action, input))
      )
    );
    expect(theirs).toStrictEqual([
      "connect.action_failed",
      "connect.action_failed",
    ]);
    expect(graphPaths()).toStrictEqual([]);

    await expect(
      toolError(
        call(connection, "me.chats.messages.list", { chat: chatIds.theirs })
      )
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    // The chat was looked at, its messages never asked for.
    expect(graphPaths().some((path) => path.endsWith("/messages"))).toBeFalsy();
  });
});

describe("the Microsoft 365 connector's meeting tools", () => {
  const window = {
    startDateTime: "2026-10-19T00:00:00Z",
    endDateTime: "2026-10-26T00:00:00Z",
  };

  it("list only the Teams meetings the person was in: online, held and not declined", async () => {
    const connection = await connected();
    const listed = await outputOf(
      call(connection, "me.calendarView.list", {
        ...window,
        isOnlineMeeting: true,
      })
    );
    expect(listed).toMatchObject({
      items: [
        {
          id: eventIds.review,
          subject: "Northwind contract review",
          organizer: { emailAddress: { name: "Lisa Meyer" } },
          start: { dateTime: "2026-10-21T09:00:00.0000000" },
        },
        { id: eventIds.standup, subject: "Team standup" },
        // The fake's calendar view doesn't hold to the window.
        {
          id: eventIds.reviewEarlier,
          start: { dateTime: "2026-10-14T09:00:00.0000000" },
        },
      ],
    });
    expect(listed).toHaveProperty("items.length", 3);
    const view = requests().find(({ path }) => path.endsWith("/calendarView"));
    expect(view).toMatchObject({
      path: "/v1.0/me/calendarView",
      query: window,
    });
  });

  it("list no more than a month at once", async () => {
    const connection = await connected();
    await expect(
      toolError(
        call(connection, "me.calendarView.list", {
          startDateTime: "2026-09-01T00:00:00Z",
          endDateTime: "2026-10-26T00:00:00Z",
          isOnlineMeeting: true,
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(graphPaths()).toStrictEqual([]);
  });

  it("read a meeting's transcript as Teams gives it, each line with its time and speaker", async () => {
    const connection = await connected();
    const { output, provenance } = await resultOf(
      call(connection, transcriptTool, { event: eventIds.review })
    );
    expect(output).toMatchObject({
      id: meetingIds.review,
      transcripts: [
        {
          id: transcriptIds.review,
          createdDateTime: "2026-10-21T09:01:12.000Z",
        },
      ],
    });
    expect(output).toHaveProperty("transcripts.length", 1);
    const [content] = contentsOf(output);
    // Each line keeps its time and its speaker; what someone said is theirs,
    // attributed, never an instruction.
    for (const line of [
      "00:00:03.120 --> 00:00:07.480\n<v Lisa Meyer>We agreed net 30 &amp; a 2% discount for Northwind.</v>",
      "00:00:08.000 --> 00:00:11.250\n<v Tom de Vries>I'll send the signed copy by Friday.</v>",
      `<v Lisa Meyer>${plantedInstruction}</v>`,
    ]) {
      expect(content).toContain(line);
    }
    expect(provenance).toStrictEqual([meetingIds.review]);
    expect(
      requests().find(({ path }) => path.endsWith("/content"))
    ).toMatchObject({
      path: `/v1.0/me/onlineMeetings/${meetingIds.review}/transcripts/${transcriptIds.review}/content`,
      query: { $format: "text/vtt" },
    });
  });

  it("read only the transcript of the occurrence asked for, of a meeting that recurs", async () => {
    const connection = await connected();
    const read = async (event: string) =>
      await outputOf(call(connection, transcriptTool, { event }));
    // Both occurrences share one join URL, so one online meeting, which
    // lists the transcripts of both.
    const [earlier, later] = await Promise.all([
      read(eventIds.reviewEarlier),
      read(eventIds.review),
    ]);
    expect({ earlier, later }).toMatchObject({
      earlier: {
        transcripts: [{ id: transcriptIds.reviewEarlier }],
      },
      later: { transcripts: [{ id: transcriptIds.review }] },
    });
    expect(contentsOf(earlier)).toStrictEqual([
      expect.stringContaining(
        "<v Lisa Meyer>Northwind wants net 60; we'll come back next week.</v>"
      ),
    ]);
    expect(later).toHaveProperty("transcripts.length", 1);
  });

  it("give no transcript for a meeting never transcribed", async () => {
    const connection = await connected();
    await expect(
      outputOf(call(connection, transcriptTool, { event: eventIds.standup }))
    ).resolves.toMatchObject({ id: meetingIds.standup, transcripts: [] });
  });

  it("refuse a meeting the person declined, one that isn't online or was cancelled, and a colleague's", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [eventIds.declined, eventIds.lunch, eventIds.cancelled].map(
        async (event) =>
          await toolError(call(connection, transcriptTool, { event }))
      )
    );
    expect(refusals).toMatchObject([
      { error: { code: "access_denied" } },
      { error: { code: "access_denied" } },
      { error: { code: "access_denied" } },
    ]);
    // Nothing past the event was asked for.
    expect(
      graphPaths().filter((path) => path.includes("/onlineMeetings"))
    ).toStrictEqual([]);

    // A colleague's mailbox can't be named at all.
    await expect(
      outcome(
        call(connection, transcriptTool, {
          mailbox: ceo,
          event: eventIds.review,
        })
      )
    ).resolves.toBe("connect.action_failed");
    expect(
      graphPaths().filter((path) => path.includes(encodeURIComponent(ceo)))
    ).toStrictEqual([]);
  });
});
