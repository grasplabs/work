import type { ChatProject, ChatSummary } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { groupChats, hasEvery, whenShort } from "./chat-history.ts";
import { projectsByUse } from "./project-shelf.tsx";

// The person's chats as the ⌘K window and the empty chat show core's list:
// by when each was last used, so an old chat someone just continued is
// under Today, not where it was started; the time as short as a row has
// room for; and their projects, the one used last first.

const now = new Date(2026, 9, 29, 15, 30);

/** `days` days before now, at `hour`, as core sends a time. */
const daysBack = (days: number, hour = 9): string =>
  new Date(2026, 9, 29 - days, hour).toISOString();

const chat = (
  title: string,
  lastAt: string,
  projectId: string | null = null
): ChatSummary => ({
  id: title,
  title,
  createdAt: daysBack(40),
  lastAt,
  running: false,
  projectId,
  appId: null,
});

const project = (id: string, createdAt: string): ChatProject => ({
  id,
  name: id,
  goal: "",
  createdAt,
  documents: [],
});

describe("chat history", () => {
  it("groups chats by when they were last used, the latest first", () => {
    const groups = groupChats(
      [
        chat("Started long ago, continued now", daysBack(0, 14)),
        chat("Last week", daysBack(3)),
        chat("This morning", daysBack(0, 8)),
        chat("Last month", daysBack(30)),
        chat("A week ago", daysBack(7)),
      ],
      now
    );
    expect(
      groups.map((group) => [group.period, group.chats.map(({ id }) => id)])
    ).toStrictEqual([
      ["today", ["Started long ago, continued now", "This morning"]],
      ["week", ["Last week"]],
      ["earlier", ["A week ago", "Last month"]],
    ]);
  });

  it("says when a chat was last used as short as a row has room for", () => {
    expect({
      today: whenShort(daysBack(0, 14), now, "en-GB"),
      thisWeek: whenShort(daysBack(2), now, "en-GB"),
      earlier: whenShort(daysBack(30), now, "en-GB"),
    }).toStrictEqual({
      today: "14:00",
      thisWeek: "Tue",
      earlier: "29 Sept",
    });
  });

  it("needs every word searched for, wherever each is, in any case", () => {
    expect({
      both: hasEvery("board REPORT", "Board", "the report"),
      one: hasEvery("board lease", "Board report"),
      none: hasEvery(" ", "anything"),
    }).toStrictEqual({ both: true, one: false, none: true });
  });

  it("puts the project used last first, and an unused one by when it was made", () => {
    const shelf = projectsByUse(
      [
        project("Old, used today", daysBack(60)),
        project("New, unused", daysBack(1)),
        project("Used last week", daysBack(50)),
      ],
      [
        chat("a", daysBack(0), "Old, used today"),
        chat("b", daysBack(5), "Old, used today"),
        chat("c", daysBack(4), "Used last week"),
        chat("d", daysBack(0)),
      ]
    );
    expect(
      shelf.map(({ project: { id }, chats }) => [id, chats])
    ).toStrictEqual([
      ["Old, used today", 2],
      ["New, unused", 0],
      ["Used last week", 1],
    ]);
  });
});
