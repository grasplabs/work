import type { ChatSummary } from "@grasp-os/shared/chat";
import { describe, expect, it } from "vite-plus/test";

import { chatsByDay, dayWrittenOut } from "./chat-history.ts";

// The person's chats as the chats window shows core's list: by the day
// each was last used, so an old chat someone just continued is under
// Today, not where it was started.

const now = new Date(2026, 9, 29, 15, 30);

/** `days` days before now, at `hour`, as core sends a time. */
const daysBack = (days: number, hour = 9): string =>
  new Date(2026, 9, 29 - days, hour).toISOString();

const chat = (title: string, lastAt: string): ChatSummary => ({
  id: title,
  title,
  agentId: "organization",
  createdAt: daysBack(400),
  lastAt,
  running: false,
  appId: null,
  via: "web",
  make: null,
  archived: false,
});

describe("chat history", () => {
  it("groups chats by the day they were last used, today and yesterday by name, the latest first", () => {
    const groups = chatsByDay(
      [
        chat("Started long ago, continued now", daysBack(0, 14)),
        chat("Yesterday evening", daysBack(1, 21)),
        chat("This morning", daysBack(0, 8)),
        chat("Last week", daysBack(5)),
        chat("Also last week", daysBack(5, 7)),
        chat("Last year", daysBack(400)),
      ],
      now
    );
    expect(
      groups.map(({ day, chats }) => [
        day.kind === "earlier"
          ? dayWrittenOut(day.day, day.sameYear, "en-GB")
          : day.kind,
        chats.map(({ id }) => id),
      ])
    ).toStrictEqual([
      ["today", ["Started long ago, continued now", "This morning"]],
      ["yesterday", ["Yesterday evening"]],
      ["Saturday 24 October", ["Last week", "Also last week"]],
      ["24 September 2025", ["Last year"]],
    ]);
  });
});
