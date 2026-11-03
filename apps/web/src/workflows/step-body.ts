// A step's body as the definition text holds it, for changing that one
// step from the canvas: core's `editStep` replaces the body of the task at
// a diagram's pointer (`DiagramTask.pointer`), keeping its ID, and this
// reads the body it replaces from the same text the diagram was drawn
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
 * The body of the task at JSON Pointer `pointer` (RFC 6901) in definition
 * text `source`: the value of the task's single key, its ID. Undefined
 * when the text isn't JSON or names no such task there.
 */
export const stepBodyAt = (
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
  const id = tokens.pop();
  for (const token of tokens) {
    value = childOf(value, token);
  }
  if (
    id === undefined ||
    !isObject(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, id)
  ) {
    return undefined;
  }
  const body = value[id];
  return isObject(body) ? body : undefined;
};
