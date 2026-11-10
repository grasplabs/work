import { currencyDecimals } from "@grasp-os/runtime";

// How an independent workflow's parameter is taken from a field, by the
// JSON Schema its current version seals for it (`WorkflowParamSetting`):
// a switch for a boolean, a number for a number, plain text for a string,
// an amount and a currency for money, cron fields and a time zone for a
// schedule (core marks both, `x-grasp-value`), and JSON for anything
// else. Core checks every value against the schema itself (`setParams`);
// this only reads what was typed.

/** How a parameter's field takes its value. */
export type ParamKind =
  | "boolean"
  | "number"
  | "string"
  | "money"
  | "schedule"
  | "json";

/** The kinds whose field has parts, each its own text. */
type PartsKind = "money" | "schedule";

/** The parts of each such kind, in the order the page shows them. */
export const paramParts = {
  money: ["amount", "currency"],
  schedule: ["cron", "timeZone"],
} as const satisfies Record<PartsKind, readonly string[]>;

const isPartsKind = (kind: ParamKind): kind is PartsKind =>
  kind === "money" || kind === "schedule";

/** What core marks a value of its own form with, if anything. */
const markOf = (schema: object): unknown => {
  const mark: unknown = Reflect.get(schema, "x-grasp-value");
  return typeof mark === "object" && mark !== null
    ? Reflect.get(mark, "kind")
    : undefined;
};

/**
 * The kind of field a parameter of JSON Schema `schema` takes. A
 * sensitive one's value is never shown, so it never takes parts: what is
 * typed to replace money or a schedule is its JSON.
 */
export const paramKindOf = (schema: unknown, sensitive = false): ParamKind => {
  if (typeof schema !== "object" || schema === null) {
    return "json";
  }
  const mark = markOf(schema);
  if ((mark === "money" || mark === "schedule") && !sensitive) {
    return mark;
  }
  const type: unknown = Reflect.get(schema, "type");
  if (type === "boolean") {
    return "boolean";
  }
  if (type === "number" || type === "integer") {
    return "number";
  }
  if (type === "string") {
    return "string";
  }
  return "json";
};

/** A field's parts, from its text: each part's text by name. */
export const partsOf = (text: string): Record<string, string> => {
  if (text === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
  } catch {
    return {};
  }
};

/** `text`, a field's parts, with part `name` set to `value`. */
export const withPart = (text: string, name: string, value: string): string =>
  JSON.stringify({ ...partsOf(text), [name]: value });

/** Whether a field's text is nothing typed: every part blank, for parts. */
export const isBlank = (kind: ParamKind, text: string): boolean =>
  isPartsKind(kind)
    ? Object.values(partsOf(text)).every((part) => part.trim() === "")
    : text.trim() === "";

const amountPattern = /^(?<sign>-?)(?<whole>\d+)(?:\.(?<fraction>\d+))?$/u;

/** `amount`, a decimal of major units, in whole minor units. */
const minorUnitsOf = (amount: string, digits: number): number | undefined => {
  const groups = amountPattern.exec(amount.trim())?.groups;
  const fraction = groups?.fraction ?? "";
  if (groups === undefined || fraction.length > digits) {
    return undefined;
  }
  const units = Number(`${groups.whole}${fraction.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(units)) {
    return undefined;
  }
  return groups.sign === "-" ? -units : units;
};

/** `minorUnits` as a decimal of major units, with every minor digit. */
const amountOf = (minorUnits: number, digits: number): string => {
  const sign = minorUnits < 0 ? "-" : "";
  const text = String(Math.abs(minorUnits)).padStart(digits + 1, "0");
  return digits === 0
    ? `${sign}${text}`
    : `${sign}${text.slice(0, -digits)}.${text.slice(-digits)}`;
};

/** A money or schedule value as its field's parts, as JSON text. */
const partsText = (kind: PartsKind, value: unknown): string => {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const read = (name: string): unknown => Reflect.get(value, name);
  if (kind === "schedule") {
    const cron = read("cron");
    const timeZone = read("timeZone");
    return typeof cron === "string" && typeof timeZone === "string"
      ? JSON.stringify({ cron, timeZone })
      : "";
  }
  const minorUnits = read("minorUnits");
  const currency = read("currency");
  const digits =
    typeof currency === "string" ? currencyDecimals(currency) : undefined;
  return typeof minorUnits === "number" &&
    typeof currency === "string" &&
    digits !== undefined
    ? JSON.stringify({ amount: amountOf(minorUnits, digits), currency })
    : "";
};

/** The value a money or schedule field's parts stand for, if any. */
const partsValue = (
  kind: PartsKind,
  text: string
): { value: unknown } | undefined => {
  const parts = partsOf(text);
  if (kind === "schedule") {
    const cron = parts.cron?.trim() ?? "";
    const timeZone = parts.timeZone?.trim() ?? "";
    return cron === "" || timeZone === ""
      ? undefined
      : { value: { cron, timeZone } };
  }
  const currency = parts.currency?.trim().toUpperCase() ?? "";
  const digits = currencyDecimals(currency);
  const minorUnits =
    digits === undefined ? undefined : minorUnitsOf(parts.amount ?? "", digits);
  return minorUnits === undefined
    ? undefined
    : { value: { minorUnits, currency } };
};

/**
 * A value as a field of kind `kind` shows it: a string field the string
 * as it is, money and a schedule as their parts, any other its JSON, a
 * string's quotes included, so what is shown reads back as the same value
 * (`paramValueOf`).
 */
export const paramText = (kind: ParamKind, value: unknown): string => {
  if (isPartsKind(kind)) {
    return partsText(kind, value);
  }
  return kind === "string" && typeof value === "string"
    ? value
    : JSON.stringify(value);
};

/**
 * The value text `text` stands for in a field of kind `kind`, or
 * undefined when it can't be read as one (a number that isn't, JSON that
 * doesn't parse, an amount in a currency that isn't one).
 */
export const paramValueOf = (
  kind: Exclude<ParamKind, "boolean">,
  text: string
): { value: unknown } | undefined => {
  if (kind === "string") {
    return { value: text };
  }
  if (isPartsKind(kind)) {
    return partsValue(kind, text);
  }
  const trimmed = text.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (kind === "number") {
    const number = Number(trimmed);
    return Number.isFinite(number) ? { value: number } : undefined;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return { value };
  } catch {
    return undefined;
  }
};

/**
 * What a field of kind `kind` holds: `checked` for a switch, else `text`
 * read as a value; undefined while a sensitive parameter's field is as it
 * started (its value is never shown, so an untouched field is nothing
 * typed, a switch left as it is included), or when the text can't be read
 * as one.
 */
export const fieldValueOf = (
  kind: ParamKind,
  {
    text,
    checked,
    toggled,
    sensitive,
  }: { text: string; checked: boolean; toggled: boolean; sensitive: boolean }
): { value: unknown } | undefined => {
  if (kind === "boolean") {
    return sensitive && !toggled ? undefined : { value: checked };
  }
  if (sensitive && text === "") {
    return undefined;
  }
  return paramValueOf(kind, text);
};

/** What a field's shown value came from: its text, switch and revision. */
export interface FieldBase {
  text: string;
  checked: boolean;
  revision: number;
}

/**
 * The base a field takes as the page reads its parameter at a newer
 * revision (`next`), and whether it shows the new value: an untouched
 * field does, at that revision. An edited one keeps what is typed, and
 * moves to that revision only if its own value is unchanged there, so a
 * save of another field doesn't make its edit conflict; otherwise, or for
 * a sensitive one, whose value is never shown to compare, it keeps the
 * revision it read, and its save is refused as a conflict
 * (`workflow.params_conflict`), never let overwrite another's change.
 */
export const nextFieldBase = (
  base: FieldBase,
  next: FieldBase,
  { edited, sensitive }: { edited: boolean; sensitive: boolean }
): { base: FieldBase; refill: boolean } => {
  if (next.revision === base.revision) {
    return { base, refill: false };
  }
  if (!edited) {
    return { base: next, refill: true };
  }
  const unchanged = next.text === base.text && next.checked === base.checked;
  return {
    base: unchanged && !sensitive ? { ...base, revision: next.revision } : base,
    refill: false,
  };
};
