import { i18n } from "@lingui/core";

/**
 * A list as the page's language joins it: "a, b and c", "a, b und c".
 * Never glued with ", " in a message, where word order differs.
 */
export const formatList = (items: readonly string[]): string =>
  new Intl.ListFormat(i18n.locale, { type: "conjunction" }).format(items);

/** A date and time as the page's language writes it, such as "3 Oct 2026, 14:05". */
export const formatDateTime = (value: string | number | Date): string =>
  new Intl.DateTimeFormat(i18n.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

/** A date as the page's language writes it, such as "3 Oct 2026". */
export const formatDate = (value: string | number | Date): string =>
  new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" }).format(
    new Date(value)
  );

/** Alternatives as the page's language joins them: "a, b or c", "a, b oder c". */
export const formatOrList = (items: readonly string[]): string =>
  new Intl.ListFormat(i18n.locale, { type: "disjunction" }).format(items);

/**
 * A calendar day kept as an ISO date ("2026-10-03"), as the page's language
 * writes it: the same day wherever the reader is, since the day carries no
 * time to shift. An empty date stays empty.
 */
export const formatDay = (iso: string): string =>
  iso === ""
    ? iso
    : new Intl.DateTimeFormat(i18n.locale, {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(new Date(`${iso.slice(0, 10)}T00:00:00Z`));

/** A plain whole number with the page's language's separators: "1,234", "1.234". */
export const formatNumber = (value: number): string =>
  new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 0 }).format(
    value
  );

/** 0.42 as "42%", or "42 %" where a language puts a space before it. */
export const formatPercent = (fraction: number): string =>
  new Intl.NumberFormat(i18n.locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(fraction);

/** The month of an ISO date or time, "2026-09", as "Sep 2026": in UTC, as recorded. */
export const formatMonth = (iso: string): string => {
  const [year = 1970, month = 1] = iso.slice(0, 7).split("-").map(Number);
  return new Intl.DateTimeFormat(i18n.locale, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, 1));
};

/** A day and month as the page's language writes it, such as "3 Oct": for what is recent. */
export const formatDayMonth = (value: string | number | Date): string =>
  new Intl.DateTimeFormat(i18n.locale, {
    day: "numeric",
    month: "short",
  }).format(new Date(value));

/**
 * A calendar day kept as an ISO date ("2026-10-03"), as its day and month
 * only, "3 Oct": for days of this month or the last, as a chart's ticks.
 * Read at noon UTC, so it is the same day wherever the reader is.
 */
export const formatIsoDayMonth = (iso: string): string =>
  iso === "" ? iso : formatDayMonth(`${iso.slice(0, 10)}T12:00:00Z`);

/** An amount in whole euros, as the page's language writes it, such as "€1,240". */
export const formatEuro = (value: number): string =>
  new Intl.NumberFormat(i18n.locale, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);

/** The ISO week number (1 to 53) of a day kept as an ISO date: week 1 holds the year's first Thursday. */
export const isoWeek = (iso: string): number => {
  const day = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  // The Thursday of the same week decides its year.
  day.setUTCDate(day.getUTCDate() + 3 - ((day.getUTCDay() + 6) % 7));
  const newYear = Date.UTC(day.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.round((day.getTime() - newYear) / 86_400_000);
  return 1 + Math.floor(dayOfYear / 7);
};
/** The largest unit `formatBytes` steps up to, and the ones under it. */
const byteUnits = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
const bytesPerUnit = 1024;

/** A file's size as the page's language writes it: "512 bytes", "1.5 MB". */
export const formatBytes = (bytes: number): string => {
  let value = bytes;
  let unit = 0;
  while (value >= bytesPerUnit && unit < byteUnits.length - 1) {
    value /= bytesPerUnit;
    unit += 1;
  }
  return new Intl.NumberFormat(i18n.locale, {
    style: "unit",
    unit: byteUnits[unit],
    unitDisplay: unit === 0 ? "long" : "short",
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
};

/** A time of day as the page's language writes it, such as "14:05" or "2:05 PM". */
export const formatTime = (value: string | number | Date): string =>
  new Intl.DateTimeFormat(i18n.locale, { timeStyle: "short" }).format(
    new Date(value)
  );

const msPerDay = 24 * 60 * 60 * 1000;
const daysPerMonth = 30;
const monthsPerYear = 12;

/** When the day `date` falls on began, where the reader is. */
const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * How long ago a day was, by calendar days where the reader is, as the
 * page's language says it: "today", "yesterday", "4 days ago", then
 * "2 months ago" and "last year". Words to put in a sentence, such as
 * "Updated {when}", never a sentence of its own.
 */
export const formatDaysAgo = (
  value: string | number | Date,
  now: Date = new Date(),
  locale: string = i18n.locale
): string => {
  const days = Math.max(
    0,
    Math.round((startOfDay(now) - startOfDay(new Date(value))) / msPerDay)
  );
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (days < daysPerMonth) {
    return relative.format(-days, "day");
  }
  const months = Math.round(days / daysPerMonth);
  return months < monthsPerYear
    ? relative.format(-months, "month")
    : relative.format(-Math.round(months / monthsPerYear), "year");
};
