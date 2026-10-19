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
 * read as a value; undefined when nothing is typed in the field of a
 * sensitive parameter, whose value is never shown, or when the text can't
 * be read as one.
 */
export const fieldValueOf = (
  kind: ParamKind,
  {
    text,
    checked,
    sensitive,
  }: { text: string; checked: boolean; sensitive: boolean }
): { value: unknown } | undefined => {
  if (kind === "boolean") {
    return { value: checked };
  }
  if (sensitive && text === "") {
    return undefined;
  }
  return paramValueOf(kind, text);
};
