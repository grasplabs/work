import type { ChatSummary } from "@grasp-os/shared/chat";

// The person's chats as people look back on them: by the day each was
// last used, the latest first, so an old chat someone just continued is
// under today, not where it was started. Today and yesterday by those
// words; an earlier day written out in the page's language, its year only
// when it isn't this one. Core lists them the most recently used first,
// and searches what was said in them (`chats.search`); a search by title
// alone reads the words as core does (`@grasp-os/shared/chat-search`).

/** How a day stands to today: today, yesterday, or a day further back. */
export type ChatDay =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "earlier"; day: Date; sameYear: boolean };

/** When the day `date` falls on began, here. */
const startOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

/** Whole days between the day `then` fell on and the day `now` falls on, here. */
const daysBetween = (then: Date, now: Date): number =>
  Math.round(
    (startOfDay(now).getTime() - startOfDay(then).getTime()) /
      (24 * 60 * 60 * 1000)
  );

/**
 * The chats by the day they were last used, each day the most recent
 * first, and the chats in it too.
 */
export const chatsByDay = (
  chats: readonly ChatSummary[],
  now: Date
): { key: string; day: ChatDay; chats: ChatSummary[] }[] => {
  const groups: { key: string; day: ChatDay; chats: ChatSummary[] }[] = [];
  const sorted = chats.toSorted((a, b) => b.lastAt.localeCompare(a.lastAt));
  for (const chat of sorted) {
    const at = new Date(chat.lastAt);
    const day = startOfDay(at);
    const key = day.toDateString();
    const last = groups.at(-1);
    if (last?.key === key) {
      last.chats.push(chat);
      continue;
    }
    const days = daysBetween(at, now);
    let kind: ChatDay = {
      kind: "earlier",
      day,
      sameYear: day.getFullYear() === now.getFullYear(),
    };
    if (days <= 0) {
      kind = { kind: "today" };
    } else if (days === 1) {
      kind = { kind: "yesterday" };
    }
    groups.push({ key, day: kind, chats: [chat] });
  }
  return groups;
};

/** A day further back, written out in `locale`: its weekday, or its year when that isn't this one. */
export const dayWrittenOut = (
  day: Date,
  sameYear: boolean,
  locale: string
): string =>
  new Intl.DateTimeFormat(
    locale,
    sameYear
      ? { weekday: "long", day: "numeric", month: "long" }
      : { day: "numeric", month: "long", year: "numeric" }
  ).format(day);

/** When a chat was last used, at its row's end: the time of day, its day standing over it. */
export const timeOfDay = (lastAt: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(lastAt));
