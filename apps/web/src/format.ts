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

/** An amount in whole euros, as the page's language writes it, such as "€1,240". */
export const formatEuro = (value: number): string =>
  new Intl.NumberFormat(i18n.locale, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  }).format(value);

/** A file's size in bytes, as "2.4 MB" or "12 kB" in the page's language. */
export const formatFileSize = (bytes: number): string =>
  bytes >= 1_000_000
    ? new Intl.NumberFormat(i18n.locale, {
        style: "unit",
        unit: "megabyte",
        maximumFractionDigits: 1,
      }).format(bytes / 1_000_000)
    : new Intl.NumberFormat(i18n.locale, {
        style: "unit",
        unit: "kilobyte",
        maximumFractionDigits: 0,
      }).format(Math.max(1, bytes / 1000));
