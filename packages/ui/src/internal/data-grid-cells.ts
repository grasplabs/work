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
  returns: ValueDescriptor
): Readonly<Record<string, ValueDescriptor>> => {
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
  try {
    const format = new Intl.NumberFormat(localeOf(language), {
      style: "currency",
      currency: value.currency,
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(value.minorUnits / 10 ** digits);
  } catch {
    // A currency `Intl` doesn't know: its code and amount as they are.
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
  const kind = descriptor?.kind;
  if (kind === "timestamp") {
    return typeof value === "number" ? shownMoment(value, language, day) : "";
  }
  if (kind === "boolean") {
    return value === true ? text.yes : text.no;
  }
  if (kind === "number") {
    return typeof value === "number"
      ? new Intl.NumberFormat(localeOf(language)).format(value)
      : "";
  }
  if (kind === "money") {
    return shownMoney(value, language);
  }
  if (kind === "file") {
    return text.file;
  }
  if (descriptor?.kind === "array") {
    const { item } = descriptor;
    return Array.isArray(value)
      ? value
          .map((each: unknown) => shownCell(each, item, text, language))
          .join(", ")
      : "";
  }
  if (kind === undefined || kind === "union") {
    return shownUndeclared(value, text);
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
    return nullable ? { value: null } : { problem: text.required };
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
  return Number.isFinite(value) ? { value } : { problem: text.notANumber };
};
