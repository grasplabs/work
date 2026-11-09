import { currencyDecimals } from "@grasp-os/sdk";
import type { ValueDescriptor } from "@grasp-os/sdk/form-binding";

import type { DataGridText } from "./data-grid-text.ts";

// How a grid's cells show and edit a field: by what the query declares the
// field is (its `returns`, a page of records), never by guessing from the
// value. A moment is a date, a file a file, money an amount in its
// currency; a nullable number is edited as a number and cleared to null.

/**
 * The fields of the records a query of pages answers, by name, read from
 * its declared return: a page (`{ items, hasMore, nextCursor }`), or the
 * union of a page with more and the last one.
 */
export const recordFieldsOf = (
  returns: ValueDescriptor | null
): Readonly<Record<string, ValueDescriptor>> => {
  // A query that declares no `returns` says nothing of its rows' fields.
  if (returns === null) {
    return {};
  }
  const pages = returns.kind === "union" ? returns.members : [returns];
  for (const page of pages) {
    if (page.kind !== "object" || !Object.hasOwn(page.fields, "items")) {
      continue;
    }
    const { items } = page.fields;
    if (items?.kind === "array" && items.item.kind === "object") {
      return items.item.fields;
    }
  }
  return {};
};

/** The page's language, as `Intl` takes it: the browser's when the page says none. */
const localeOf = (language: string): string | undefined =>
  language === "" ? undefined : language;

/**
 * A moment as a person reads it: the day, in UTC, for a field that holds
 * days (as a date field keeps them); its date and time where they are
 * otherwise. Never guessed from the value: midnight UTC is a moment too.
 */
const shownMoment = (moment: number, language: string, day: boolean): string =>
  day
    ? new Intl.DateTimeFormat(localeOf(language), {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(moment)
    : new Intl.DateTimeFormat(localeOf(language), {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(moment);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** An amount of money in its currency, from its whole minor units. */
const shownMoney = (value: unknown, language: string): string => {
  if (
    !isRecord(value) ||
    typeof value.currency !== "string" ||
    typeof value.minorUnits !== "number"
  ) {
    return "";
  }
  // Its decimals as ISO 4217 pins them, never as `Intl` guesses them.
  const digits = currencyDecimals(value.currency);
  if (digits === undefined) {
    // A currency the catalog doesn't have: its code and amount as they are.
    return `${value.currency} ${value.minorUnits}`;
  }
  try {
    return new Intl.NumberFormat(localeOf(language), {
      style: "currency",
      currency: value.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value.minorUnits / 10 ** digits);
  } catch {
    return `${value.currency} ${value.minorUnits}`;
  }
};

/** A value with nothing declared of it (a field the query doesn't declare). */
const shownUndeclared = (value: unknown, text: DataGridText): string => {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? text.yes : text.no;
  }
  return "";
};

/** The units a duration is said in, largest first, and how many milliseconds each is. */
const durationUnits = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1000],
] as const;

/**
 * A duration (whole milliseconds) as a person reads it: its two largest
 * units, `2 hr 30 min`, or milliseconds under a second.
 */
const shownDuration = (ms: number, language: string): string => {
  const parts: string[] = [];
  let rest = Math.abs(ms);
  for (const [unit, size] of durationUnits) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0 && parts.length < 2) {
      parts.push(
        new Intl.NumberFormat(localeOf(language), {
          style: "unit",
          unit,
          unitDisplay: "short",
        }).format(count)
      );
    }
  }
  if (parts.length === 0) {
    return new Intl.NumberFormat(localeOf(language), {
      style: "unit",
      unit: "millisecond",
      unitDisplay: "short",
    }).format(ms);
  }
  return parts.join(" ");
};

/**
 * An object's fields as a cell shows them, compactly, each as its own
 * kind shows: `city: Utrecht, country: nl`. Empty fields are left out.
 */
const shownFields = (
  value: unknown,
  fieldOf: (name: string) => ValueDescriptor | undefined,
  text: DataGridText,
  language: string
): string =>
  isRecord(value)
    ? Object.entries(value)
        .map(([name, field]) => [
          name,
          // oxlint-disable-next-line no-use-before-define -- the two recurse into each other
          shownCell(field, fieldOf(name), text, language),
        ])
        .filter(([, shown]) => shown !== "")
        .map(([name, shown]) => `${name}: ${shown}`)
        .join(", ")
    : "";

/** How a cell shows a value of one kind of field: what it is shown with. */
interface Showing {
  readonly descriptor: ValueDescriptor;
  readonly text: DataGridText;
  readonly language: string;
  readonly day: boolean;
}

/** How a cell shows each kind of field, beside text, which shows as it is. */
const showers: Readonly<
  Partial<
    Record<ValueDescriptor["kind"], (value: unknown, how: Showing) => string>
  >
> = {
  timestamp: (value, { language, day }) =>
    typeof value === "number" ? shownMoment(value, language, day) : "",
  boolean: (value, { text }) => (value === true ? text.yes : text.no),
  number: (value, { language }) =>
    typeof value === "number"
      ? new Intl.NumberFormat(localeOf(language)).format(value)
      : "",
  money: (value, { language }) => shownMoney(value, language),
  file: (_value, { text }) => text.file,
  duration: (value, { language }) =>
    typeof value === "number" ? shownDuration(value, language) : "",
  schedule: (value) =>
    isRecord(value) &&
    typeof value.cron === "string" &&
    typeof value.timeZone === "string"
      ? `${value.cron} (${value.timeZone})`
      : "",
  object: (value, { descriptor, text, language }) => {
    const fields = descriptor.kind === "object" ? descriptor.fields : {};
    return shownFields(
      value,
      (name) => (Object.hasOwn(fields, name) ? fields[name] : undefined),
      text,
      language
    );
  },
  record: (value, { descriptor, text, language }) =>
    descriptor.kind === "record"
      ? shownFields(value, () => descriptor.value, text, language)
      : "",
  array: (value, { descriptor, text, language }) => {
    if (descriptor.kind !== "array" || !Array.isArray(value)) {
      return "";
    }
    const { item } = descriptor;
    // Objects in a list each read as one, apart from the next.
    const separator =
      item.kind === "object" || item.kind === "record" ? "; " : ", ";
    return (
      value
        // oxlint-disable-next-line no-use-before-define -- each item shows as its own kind does
        .map((each: unknown) => shownCell(each, item, text, language))
        .join(separator)
    );
  },
  literal: (value, { text }) => shownUndeclared(value, text),
  union: (value, { text }) => shownUndeclared(value, text),
};

/** A field's value as a cell shows it, by what the query declares of the field. */
export const shownCell = (
  value: unknown,
  descriptor: ValueDescriptor | undefined,
  text: DataGridText,
  language: string,
  day = false
): string => {
  if (value === null || value === undefined) {
    return "";
  }
  if (descriptor === undefined) {
    return shownUndeclared(value, text);
  }
  const show = Object.hasOwn(showers, descriptor.kind)
    ? showers[descriptor.kind]
    : undefined;
  if (show !== undefined) {
    return show(value, { descriptor, text, language, day });
  }
  // Text of any kind: a string, an enum's value, an ID, a reference.
  return typeof value === "string" ? value : "";
};

/** How a cell's field is edited in place, if it can be. */
export type EditorKind =
  | "text"
  | "choice"
  | "number"
  | "boolean"
  | "moment"
  | "day";

/** How each kind of field is edited in place: the others aren't. */
const editors: Readonly<Partial<Record<ValueDescriptor["kind"], EditorKind>>> =
  {
    string: "text",
    enum: "choice",
    number: "number",
    boolean: "boolean",
    timestamp: "moment",
  };

/** How a field `descriptor` declares is edited in place; undefined if it isn't. */
export const editorKindOf = (
  descriptor: ValueDescriptor | undefined,
  day: boolean
): EditorKind | undefined => {
  if (descriptor?.kind === "timestamp" && day) {
    return "day";
  }
  return descriptor !== undefined && Object.hasOwn(editors, descriptor.kind)
    ? editors[descriptor.kind]
    : undefined;
};

/** Pads a part of a date to two digits. */
const twoDigits = (part: number): string => String(part).padStart(2, "0");

/** A moment in the person's own time zone, as a date-and-time input shows it. */
export const momentText = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  const date = new Date(value);
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}T${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
};

/** What an editor's text is to start from, for the value it edits. */
export const draftOf = (value: unknown, kind: EditorKind): string => {
  if (kind === "day") {
    return typeof value === "number" && Number.isFinite(value)
      ? new Date(value).toISOString().slice(0, "yyyy-mm-dd".length)
      : "";
  }
  if (kind === "moment") {
    return momentText(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "string" ? value : "";
};

/**
 * What the person typed, as the field takes it: the value to save, or the
 * problem to show. Empty is null where the field allows it.
 */
export const parsedDraft = (
  draft: string,
  kind: EditorKind,
  descriptor: ValueDescriptor | undefined,
  text: DataGridText
): { readonly value: unknown } | { readonly problem: string } => {
  const nullable = descriptor?.nullable === true;
  if (kind === "text" || kind === "boolean") {
    return { value: draft };
  }
  if (draft.trim() === "") {
    if (nullable) {
      return { value: null };
    }
    // A field that may be left out (or filled in by its default) is,
    // cleared; one that needs a value says so.
    return descriptor !== undefined && descriptor.presence !== "required"
      ? { value: undefined }
      : { problem: text.required };
  }
  if (kind === "choice") {
    return { value: draft };
  }
  let value = Number(draft);
  if (kind === "day") {
    // The day, as the moment it starts in UTC.
    value = Date.parse(`${draft}T00:00:00Z`);
  } else if (kind === "moment") {
    // Read in the person's own time zone: no `Z`.
    value = new Date(draft).getTime();
  }
  if (Number.isFinite(value)) {
    return { value };
  }
  return { problem: kind === "number" ? text.notANumber : text.notADate };
};
