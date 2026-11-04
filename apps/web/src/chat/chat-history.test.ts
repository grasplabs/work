import type { ChatSummary } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { groupChats, whenShort } from "./chat-history.ts";

// The person's chats as the ⌘K window and the empty chat show core's list:
// by when each was last used, so an old chat someone just continued is
// under Today, not where it was started; and the time as short as a row
// has room for.

const now = new Date(2026, 9, 29, 15, 30);

/** `days` days before now, at `hour`, as core sends a time. */
const daysBack = (days: number, hour = 9): string =>
  new Date(2026, 9, 29 - days, hour).toISOString();

const chat = (title: string, lastAt: string): ChatSummary => ({
  id: title,
  title,
  createdAt: daysBack(40),
  lastAt,
  running: false,
  appId: null,
  via: "web",
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
});
