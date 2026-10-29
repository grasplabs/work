import type { ChatSummary } from "@grasp-os/shared/chat";

// The person's chats as people look back on them (grasplabs/prototype
// `lib/chat-history.ts`): by when each was last used, today, the last
// seven days and earlier, with that time as short as a row has room for.
// Core lists them the most recently used first, and searches what was said
// in them (`chats.search`); a search by title alone needs nothing from it.

export type ChatPeriod = "today" | "week" | "earlier";

const aDay = 24 * 60 * 60 * 1000;

/** When the day `date` falls on began, here. */
const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** Whole days between the day `iso` fell on and the day `now` falls on, here. */
const daysAgo = (iso: string, now: Date): number =>
  Math.round((startOfDay(now) - startOfDay(new Date(iso))) / aDay);

/** The period a chat last used at `lastAt` is in, as of `now`. */
export const periodOf = (lastAt: string, now: Date): ChatPeriod => {
  const days = daysAgo(lastAt, now);
  if (days <= 0) {
    return "today";
  }
  return days < 7 ? "week" : "earlier";
};

/**
 * The chats by the period they were last used in, each the most recent
 * first, leaving out periods with none.
 */
export const groupChats = (
  chats: readonly ChatSummary[],
  now: Date
): { period: ChatPeriod; chats: ChatSummary[] }[] => {
  const sorted = chats.toSorted((a, b) => b.lastAt.localeCompare(a.lastAt));
  return (["today", "week", "earlier"] as const).flatMap((period) => {
    const inPeriod = sorted.filter(
      (chat) => periodOf(chat.lastAt, now) === period
    );
    return inPeriod.length === 0 ? [] : [{ period, chats: inPeriod }];
  });
};

/**
 * When a chat was last used, as short as a row has room for: the time
 * today, the weekday this week, the date before that.
 */
export const whenShort = (
  lastAt: string,
  now: Date,
  locale: string
): string => {
  const at = new Date(lastAt);
  const period = periodOf(lastAt, now);
  if (period === "today") {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(at);
  }
  if (period === "week") {
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at);
  }
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
  }).format(at);
};

const whitespace = /\s+/u;

/** Whether every word of `search` is somewhere in `texts`, in any case. */
export const hasEvery = (search: string, ...texts: string[]): boolean => {
  const hay = texts.join(" ").toLowerCase();
  return search
    .toLowerCase()
    .split(whitespace)
    .filter((word) => word !== "")
    .every((word) => hay.includes(word));
};
