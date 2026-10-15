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

/** A share from 0 to 1 in whole percent, as the page's language writes it, such as "42%". */
export const formatPercent = (fraction: number): string =>
  new Intl.NumberFormat(i18n.locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(fraction);
