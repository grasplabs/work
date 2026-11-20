// When something happened, as people say it, in the reader's language: "now", "3 minutes ago",
// "3 hours ago" on the same day, "Yesterday", then the day itself ("12 Nov", with its year when the
// year differs). Ahead of now the same, the other way: "in 3 hours", "Tomorrow". Every word comes
// from the platform's Intl in the reader's locale, so nothing here needs translating.
//
//   const { words, full } = when(date, now, "nl-NL");   // "gisteren", "18 november 2026 om 14:05"
//
// One clock (useNow) ticks for every reader on the page, once a minute.
"use client";

import { useSyncExternalStore } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The start of a date's day, in the reader's own time zone. */
const dayOf = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** A word's first letter in capitals, as it starts a cell: "Yesterday", "Gisteren". */
const capital = (words: string, locale: string | undefined) =>
  words === ""
    ? words
    : words.charAt(0).toLocaleUpperCase(locale) + words.slice(1);

/** The relative words and the full date and time, for a date seen at `now`. */
export const when = (date: Date, now: number, locale?: string) => {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const gap = date.getTime() - now;
  const days = Math.round((dayOf(date) - dayOf(new Date(now))) / (24 * HOUR));
  const day = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: "numeric" }),
  });
  let words: string;
  if (Math.abs(gap) < MINUTE) {
    words = relative.format(0, "second");
  } else if (Math.abs(gap) < HOUR) {
    words = relative.format(Math.trunc(gap / MINUTE), "minute");
  } else if (days === 0) {
    words = relative.format(Math.trunc(gap / HOUR), "hour");
  } else if (Math.abs(days) === 1) {
    words = relative.format(days, "day");
  } else {
    words = day.format(date);
  }
  const full = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
  return { words: capital(words, locale), full };
};

/**
 * The widest the words can be in a locale, in characters: a box this wide never moves the row
 * when "59 minutes ago" becomes "1 hour ago".
 */
export const widestWords = (locale?: string) => {
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const day = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const candidates = [
    relative.format(0, "second"),
    relative.format(-59, "minute"),
    relative.format(59, "minute"),
    relative.format(-23, "hour"),
    relative.format(23, "hour"),
    relative.format(-1, "day"),
    relative.format(1, "day"),
    ...Array.from({ length: 12 }, (_, month) =>
      day.format(new Date(2026, month, 28))
    ),
  ];
  return Math.max(...candidates.map((each) => each.length));
};

// The one clock: the minute now, shared by every reader, ticking while anyone listens.
let minute = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (timer === undefined) {
    minute = Date.now();
    timer = setInterval(() => {
      minute = Date.now();
      for (const each of listeners) {
        each();
      }
    }, MINUTE);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

/** Now, to the minute: the same for every reader on the page, again each minute. */
export const useNow = () =>
  useSyncExternalStore(
    subscribe,
    () => minute,
    () => minute
  );
