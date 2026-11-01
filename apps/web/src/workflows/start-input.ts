// A workflow's input, as a form a person fills in to start it by hand
// (start-run.tsx): an object whose fields are each text, a number, a yes
// or no, or one of a few choices becomes a form, one field each; any
// other input (a list, a nested object, a value that may be one of
// several shapes) is typed as JSON. The form only helps: core checks what
// is sent against the version's schema exactly, and says what it refuses.

/** One field of a workflow's input, as its form asks for it. */
export type StartField =
  | { name: string; required: boolean; kind: "text" }
  | { name: string; required: boolean; kind: "number"; integer: boolean }
  | { name: string; required: boolean; kind: "yes" }
  | { name: string; required: boolean; kind: "choice"; choices: string[] };

/** What a person typed or picked into the fields, by field name. */
export type StartValues = Record<string, string | boolean>;

/** Why a field's value can't be sent. */
export type StartFieldProblem = "missing" | "number" | "integer";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `schema` as one field named `name`, if it is one a form can ask for. */
const fieldOf = (
  name: string,
  schema: unknown,
  required: boolean
): StartField | undefined => {
  if (!isRecord(schema)) {
    return undefined;
  }
  const { type } = schema;
  if (
    type === "string" &&
    Array.isArray(schema.enum) &&
    schema.enum.every((choice) => typeof choice === "string")
  ) {
    return { name, required, kind: "choice", choices: schema.enum };
  }
  if (type === "string") {
    return { name, required, kind: "text" };
  }
  if (type === "number" || type === "integer") {
    return { name, required, kind: "number", integer: type === "integer" };
  }
  return type === "boolean" ? { name, required, kind: "yes" } : undefined;
};

/**
 * The fields of an input `schema` (JSON Schema), in its order, when it
 * is an object a form can ask for; undefined for any other, typed as JSON.
 */
export const startFieldsOf = (schema: unknown): StartField[] | undefined => {
  if (!isRecord(schema) || schema.type !== "object") {
    return undefined;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (name): name is string => typeof name === "string"
        )
      : []
  );
  const fields: StartField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    const field = fieldOf(name, property, required.has(name));
    if (field === undefined) {
      return undefined;
    }
    fields.push(field);
  }
  return fields;
};

/** The value field `field` takes from `typed`, or why it can't. */
const valueOf = (
  field: StartField,
  typed: string | boolean | undefined
):
  | { ok: true; value: string | number | boolean | undefined }
  | { ok: false; problem: StartFieldProblem } => {
  if (field.kind === "yes") {
    return { ok: true, value: typed === true };
  }
  const text = typeof typed === "string" ? typed : "";
  if (field.kind === "number") {
    if (text.trim() === "") {
      return field.required
        ? { ok: false, problem: "missing" }
        : { ok: true, value: undefined };
    }
    const number = Number(text);
    if (!Number.isFinite(number)) {
      return { ok: false, problem: "number" };
    }
    return field.integer && !Number.isInteger(number)
      ? { ok: false, problem: "integer" }
      : { ok: true, value: number };
  }
  if (text === "") {
    // Text left empty is sent as empty when the workflow needs it; a
    // choice needs one picked.
    if (!field.required) {
      return { ok: true, value: undefined };
    }
    return field.kind === "choice"
      ? { ok: false, problem: "missing" }
      : { ok: true, value: "" };
  }
  return { ok: true, value: text };
};

/**
 * The input `values` make of `fields`, or the first field whose value
 * can't be sent and why: an optional field left empty is left out.
 */
export const startInputOf = (
  fields: readonly StartField[],
  values: StartValues
):
  | { ok: true; input: Record<string, string | number | boolean> }
  | { ok: false; field: string; problem: StartFieldProblem } => {
  const input: Record<string, string | number | boolean> = {};
  for (const field of fields) {
    const taken = valueOf(field, values[field.name]);
    if (!taken.ok) {
      return { ok: false, field: field.name, problem: taken.problem };
    }
    if (taken.value !== undefined) {
      input[field.name] = taken.value;
    }
  }
  return { ok: true, input };
};
