// A cell's value as words and back, by its column's kind: how it shows, how it is typed and
// copied, and what typed or pasted words become. No React and no DOM.
import {
  CalendarIcon,
  KindCheckbox,
  KindCurrency,
  KindNumber,
  KindSelect,
  KindText,
  Person,
} from "../icons";
import type { IconData } from "../icons";
import type { CellValue } from "./model";
import type { DataGridColumn, DataGridKind } from "./types";

/** The icon a kind shows in its column's head. */
export const kindIcon: Record<DataGridKind, IconData> = {
  text: KindText,
  number: KindNumber,
  currency: KindCurrency,
  select: KindSelect,
  date: CalendarIcon,
  person: Person,
  checkbox: KindCheckbox,
};

/** Whether a kind holds figures: they stand at the cell's end, in ink. */
export const isFigure = (kind: DataGridKind) =>
  kind === "number" || kind === "currency";

/** A value as it is typed and copied: plain, with no grouping, so a spreadsheet reads it back. */
export const plainOf = (value: CellValue): string => {
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  return value === null ? "" : String(value);
};

/** A value as its cell shows it. */
export const shownOf = <Row>(
  column: DataGridColumn<Row>,
  value: CellValue,
  locale: string
): string => {
  if (column.format !== undefined) {
    return column.format(value);
  }
  if (typeof value !== "number") {
    return plainOf(value);
  }
  const digits = column.kind === "currency" ? 2 : undefined;
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
};

const truthy = /^(?:true|yes|x|1|✓)$/iu;
/** The locale's decimal mark and grouping mark, as Intl writes them. */
const marksOf = (locale: string) => {
  const parts = new Intl.NumberFormat(locale).formatToParts(12_345.6);
  return {
    decimal: parts.find((part) => part.type === "decimal")?.value ?? ".",
    group: parts.find((part) => part.type === "group")?.value ?? ",",
  };
};

/**
 * A figure as people type it in their locale: its grouping marks, spaces and a currency sign are
 * dropped, and its decimal mark is read as one. "1.234,50" is 1234.5 in German, "1,234.50" in English.
 */
const figureOf = (text: string, locale: string) => {
  const { decimal, group } = marksOf(locale);
  const plain = text
    .replaceAll(group, "")
    .replaceAll(/[\s\u00A0\u202F]/gu, "")
    .replaceAll(decimal, ".")
    .replaceAll(/[^\d.eE+-]/gu, "");
  return Number(plain);
};

const optionFor = (options: readonly string[], text: string) => {
  const wanted = text.toLowerCase();
  const exact = options.find((option) => option.toLowerCase() === wanted);
  if (exact !== undefined) {
    return exact;
  }
  const starting = options.filter((option) =>
    option.toLowerCase().startsWith(wanted)
  );
  return starting.length === 1 ? starting[0] : undefined;
};

/** What typed or pasted words become in a column, or `undefined` when they do not fit it. */
export const valueFrom = <Row>(
  column: DataGridColumn<Row>,
  words: string,
  locale = "en"
): CellValue | undefined => {
  const text = words.trim();
  if (column.kind === "checkbox") {
    return truthy.test(text);
  }
  if (isFigure(column.kind)) {
    if (text === "") {
      return null;
    }
    const figure = figureOf(text, locale);
    return Number.isFinite(figure) && /\d/u.test(text) ? figure : undefined;
  }
  if (column.kind === "select" && column.options !== undefined && text !== "") {
    return optionFor(column.options, text);
  }
  return text;
};

/** What a cell holds once cleared: a box empties, a figure goes, words go. */
export const clearedOf = (kind: DataGridKind): CellValue => {
  if (kind === "checkbox") {
    return false;
  }
  return isFigure(kind) ? null : "";
};
