// A step's fields as the definition text holds them, for changing that one
// step from the canvas: core's `editStep` replaces the fields of the step
// at a diagram's pointer (`DiagramTask.pointer`), keeping its ID, and this
// reads the fields it replaces from the same text the diagram was drawn
// from. Only own keys and array indexes are walked, as core walks them.

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const indexPattern = /^(?:0|[1-9]\d*)$/u;

/** What `token` names in `value`, by an own key or an index only. */
const childOf = (value: unknown, token: string): unknown => {
  if (Array.isArray(value)) {
    return indexPattern.test(token) ? value.at(Number(token)) : undefined;
  }
  return isObject(value) && Object.hasOwn(value, token)
    ? value[token]
    : undefined;
};

/**
 * The fields of the step at JSON Pointer `pointer` (RFC 6901) in
 * grasp-workflow/1 text `source`, its `id` aside: what a change of it
 * sends. Undefined when the text isn't JSON or names no step there.
 */
export const stepFieldsAt = (
  source: string,
  pointer: string
): Record<string, unknown> | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return undefined;
  }
  if (!pointer.startsWith("/")) {
    return undefined;
  }
  const tokens = pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
  // A step is an item of a list of steps: its last token is an index.
  if (!indexPattern.test(tokens.at(-1) ?? "")) {
    return undefined;
  }
  for (const token of tokens) {
    value = childOf(value, token);
  }
  if (!isObject(value) || typeof value.id !== "string") {
    return undefined;
  }
  const { id: _id, ...fields } = value;
  return fields;
};
