import { describe, expect, it } from "vite-plus/test";

import { connectAccount, ownAccount, someone } from "./connect.ts";
import {
  chatIds,
  eventIds,
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
import type { Connection, Input } from "./tool-calls.ts";

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

const ownMailbox = ({ person }: Connection): string => person.email;

/** What left connect, each request with its query and JSON body parsed. */
const requests = () => parsedRequests(graph.sent);

/** The paths of what reached Graph, but who the token is for. */
const graphPaths = (): string[] =>
  requests()
    .map(({ path }) => path)
    .filter((path) => path !== "/v1.0/me");

/** Calls `action` on the person's own mailbox, unless `input` names another. */
const ownCall = async (
  connection: Connection,
  action: string,
  input: Input
) => {
  const mailbox =
    typeof input.mailbox === "string" ? input.mailbox : ownMailbox(connection);
  return await call(
    connection,
    action,
    { mailbox, ...input },
    { resource: mailbox }
  );
};

describe("the Microsoft 365 connector's chat tools", () => {
  it("list the person's own chats, with who is in each", async () => {
    const connection = await connected();
    await expect(
      outputOf(ownCall(connection, "chats.list", {}))
    ).resolves.toMatchObject({
      mailbox: ownMailbox(connection),
      chats: [
        {
          id: chatIds.own,
          kind: "oneOnOne",
          members: ["You", "Lisa Meyer"],
          lastUpdatedAt: "2026-10-20T15:42:10.000Z",
        },
      ],
      nextPage: null,
    });
  });

  it("read a chat's messages as text, each with who wrote it, leaving out system and deleted ones", async () => {
    const connection = await connected();
    const { output, provenance } = await resultOf(
      ownCall(connection, "chats.messages", { chat: chatIds.own })
    );
    expect(output).toMatchObject({
      chat: { id: chatIds.own, topic: null },
      messages: [
        {
          from: "Lisa Meyer",
          sentAt: "2026-10-20T15:42:10.000Z",
          text: "Can you send me the signed Northwind contract by Friday?\nFabrikam & Contoso can wait.",
        },
        // An instruction someone wrote is what they wrote, nothing more.
        { from: "Lisa Meyer", text: plantedInstruction },
      ],
    });
    expect(output).toHaveProperty("messages.length", 2);
    expect(provenance).toContain(chatIds.own);
    // Reading changed nothing.
    expect(graph.writesDone()).toBe(0);
  });

  it("refuse a colleague's chats, and a chat the person isn't a member of", async () => {
    const connection = await connected();
    const theirs = await Promise.all(
      (
        [
          ["chats.list", { mailbox: ceo }],
          ["chats.messages", { mailbox: ceo, chat: chatIds.own }],
        ] as const
      ).map(
        async ([action, input]) =>
          await toolError(ownCall(connection, action, input))
      )
    );
    expect(theirs).toMatchObject([
      { error: { code: "invalid" } },
      { error: { code: "invalid" } },
    ]);
    expect(graphPaths()).toStrictEqual([]);

    await expect(
      toolError(ownCall(connection, "chats.messages", { chat: chatIds.theirs }))
    ).resolves.toMatchObject({ error: { code: "access_denied" } });
    // The chat was looked at, its messages never asked for.
    expect(graphPaths().some((path) => path.endsWith("/messages"))).toBeFalsy();
  });
});

describe("the Microsoft 365 connector's meeting tools", () => {
  const window = {
    from: "2026-10-19T00:00:00Z",
    to: "2026-10-26T00:00:00Z",
  };

  it("list only the Teams meetings the person was in: online, held and not declined", async () => {
    const connection = await connected();
    const listed = await outputOf(ownCall(connection, "meetings.list", window));
    expect(listed).toMatchObject({
      meetings: [
        {
          id: eventIds.review,
          subject: "Northwind contract review",
          organizer: "Lisa Meyer",
          start: "2026-10-21T09:00:00.0000000",
        },
        { id: eventIds.standup, subject: "Team standup" },
        // The fake's calendar view doesn't hold to the window.
        { id: eventIds.reviewEarlier, start: "2026-10-14T09:00:00.0000000" },
      ],
    });
    expect(listed).toHaveProperty("meetings.length", 3);
    const view = requests().find(({ path }) => path.endsWith("/calendarView"));
    expect(view?.query).toMatchObject({
      startDateTime: window.from,
      endDateTime: window.to,
    });
  });

  it("list no more than a month at once", async () => {
    const connection = await connected();
    await expect(
      toolError(
        ownCall(connection, "meetings.list", {
          from: "2026-09-01T00:00:00Z",
          to: "2026-10-26T00:00:00Z",
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(graphPaths()).toStrictEqual([]);
  });

  it("read a meeting's transcript line by line, each with its time and speaker", async () => {
    const connection = await connected();
    const { output, provenance } = await resultOf(
      ownCall(connection, "meetings.transcript", { event: eventIds.review })
    );
    expect(output).toMatchObject({
      mailbox: ownMailbox(connection),
      meeting: { id: eventIds.review, subject: "Northwind contract review" },
      transcripts: [
        {
          id: transcriptIds.review,
          createdAt: "2026-10-21T09:01:12.000Z",
          lines: [
            {
              at: "00:00:03.120",
              speaker: "Lisa Meyer",
              text: "We agreed net 30 & a 2% discount for Northwind.",
            },
            {
              at: "00:00:08.000",
              speaker: "Tom de Vries",
              text: "I'll send the signed copy by Friday.",
            },
            // What someone said is theirs, attributed, never an instruction.
            {
              at: "00:00:14.500",
              speaker: "Lisa Meyer",
              text: plantedInstruction,
            },
          ],
        },
      ],
    });
    // The empty cue is left out: three lines, not four.
    expect(output).toHaveProperty("transcripts.0.lines.length", 3);
    expect(provenance).toStrictEqual([eventIds.review, transcriptIds.review]);
  });

  it("read only the transcript of the occurrence asked for, of a meeting that recurs", async () => {
    const connection = await connected();
    const read = async (event: string) =>
      await outputOf(ownCall(connection, "meetings.transcript", { event }));
    // Both occurrences share one join URL, so one online meeting, which
    // lists the transcripts of both.
    const [earlier, later] = await Promise.all([
      read(eventIds.reviewEarlier),
      read(eventIds.review),
    ]);
    expect({ earlier, later }).toMatchObject({
      earlier: {
        meeting: { id: eventIds.reviewEarlier },
        transcripts: [
          {
            id: transcriptIds.reviewEarlier,
            lines: [
              {
                speaker: "Lisa Meyer",
                text: "Northwind wants net 60; we'll come back next week.",
              },
            ],
          },
        ],
      },
      later: {
        meeting: { id: eventIds.review },
        transcripts: [{ id: transcriptIds.review }],
      },
    });
    expect(earlier).toHaveProperty("transcripts.length", 1);
    expect(later).toHaveProperty("transcripts.length", 1);
  });

  it("give no transcript for a meeting never transcribed", async () => {
    const connection = await connected();
    await expect(
      outputOf(
        ownCall(connection, "meetings.transcript", { event: eventIds.standup })
      )
    ).resolves.toMatchObject({ transcripts: [] });
  });

  it("refuse a meeting the person declined, one that isn't online or was cancelled, and a colleague's", async () => {
    const connection = await connected();
    const refusals = await Promise.all(
      [eventIds.declined, eventIds.lunch, eventIds.cancelled].map(
        async (event) =>
          await toolError(ownCall(connection, "meetings.transcript", { event }))
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

    await expect(
      toolError(
        ownCall(connection, "meetings.transcript", {
          mailbox: ceo,
          event: eventIds.review,
        })
      )
    ).resolves.toMatchObject({ error: { code: "invalid" } });
    expect(
      graphPaths().filter((path) => path.includes(encodeURIComponent(ceo)))
    ).toStrictEqual([]);
  });
});
