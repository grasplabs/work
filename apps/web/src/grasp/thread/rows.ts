// The rows a thread draws: its messages, with a date line where the day changes and the unread
// line before the first unread message. Worked out from the items, so each is drawn once.

/** What a thread needs to know of a message; the rest is the caller's. */
export interface ThreadItemBase {
  /** Its own id, steady while it streams and edits. */
  id: string;
  /** When it was written: a Date, or an ISO string. Leave it out for no date lines. */
  at?: Date | string;
}

/** One row a thread draws: a message, a date line, or the unread line. */
export type ThreadRow<T> =
  | { kind: "message"; key: string; item: T; index: number }
  | { kind: "date"; key: string; day: Date; ago: number; sameYear: boolean }
  | { kind: "unread"; key: string };

const dayOf = (at: Date | string) => {
  const date = typeof at === "string" ? new Date(at) : at;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
};

/** How many days before `now` a day is: 0 for today, 1 for yesterday. */
const daysAgo = (day: Date, now: Date) =>
  Math.round((dayOf(now).getTime() - day.getTime()) / 86_400_000);

/** A day further back as it is written: "Monday 9 November", or "9 November 2025" in another year. */
export const dayWritten = (day: Date, sameYear: boolean, locale = "en-GB") =>
  new Intl.DateTimeFormat(
    locale,
    sameYear
      ? { weekday: "long", day: "numeric", month: "long" }
      : { day: "numeric", month: "long", year: "numeric" }
  ).format(day);

/** The rows for these messages: a date line where the day changes, the unread line before `unreadFrom`. */
export const rowsOf = <T extends ThreadItemBase>(
  items: T[],
  unreadFrom: string | undefined,
  now: Date
): ThreadRow<T>[] => {
  const rows: ThreadRow<T>[] = [];
  let lastDay: number | null = null;
  for (const [index, item] of items.entries()) {
    if (item.at !== undefined) {
      const day = dayOf(item.at);
      if (day.getTime() !== lastDay) {
        rows.push({
          kind: "date",
          key: `date-${day.getTime()}`,
          day,
          ago: daysAgo(day, now),
          sameYear: day.getFullYear() === now.getFullYear(),
        });
        lastDay = day.getTime();
      }
    }
    if (item.id === unreadFrom) {
      rows.push({ kind: "unread", key: "unread" });
    }
    rows.push({ kind: "message", key: `message-${item.id}`, item, index });
  }
  return rows;
};
