// How an independent workflow's parameter is taken from a field, by the
// JSON Schema its current version seals for it (`WorkflowParamSetting`):
// a switch for a boolean, a number for a number, plain text for a string,
// and JSON for anything else. Core checks every value against the schema
// itself (`setParams`); this only reads what was typed.

/** How a parameter's field takes its value. */
export type ParamKind = "boolean" | "number" | "string" | "json";

/** The kind of field a parameter of JSON Schema `schema` takes. */
export const paramKindOf = (schema: unknown): ParamKind => {
  const type: unknown =
    typeof schema === "object" && schema !== null
      ? Reflect.get(schema, "type")
      : undefined;
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

/**
 * A value as a field of kind `kind` shows it: a string field the string
 * as it is, any other its JSON, a string's quotes included, so what is
 * shown reads back as the same value (`paramValueOf`).
 */
export const paramText = (kind: ParamKind, value: unknown): string =>
  kind === "string" && typeof value === "string"
    ? value
    : JSON.stringify(value);

/**
 * The value text `text` stands for in a field of kind `kind`, or
 * undefined when it can't be read as one (a number that isn't, JSON that
 * doesn't parse).
 */
export const paramValueOf = (
  kind: Exclude<ParamKind, "boolean">,
  text: string
): { value: unknown } | undefined => {
  if (kind === "string") {
    return { value: text };
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
