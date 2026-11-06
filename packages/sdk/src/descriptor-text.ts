import { ValueDefinitionError } from "./value-descriptor.ts";
import type { ValueDescriptor, ValueSchema } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";
import { schemaOf } from "./value-schema.ts";

// Typed where it is declared: only then does a call narrow what follows it.
const refuse: (message: string) => never = (message) => {
  throw new ValueDefinitionError("definition.invalid_descriptor", message);
};

/** The descriptor `text` holds, its structure checked (`readDescriptor`). */
const descriptorRead = (text: string): ValueDescriptor => {
  if (typeof text !== "string") {
    return refuse("A descriptor is read from its JSON text.");
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // What the parser said quotes the text; the refusal doesn't.
    return refuse("The descriptor isn't JSON.");
  }
  return readDescriptor(data, 1, { nodes: 0 });
};

/**
 * The schema a descriptor describes, read from its JSON text, e.g. as a
 * manifest stores it or a browser sent it.
 *
 * It takes the text, not an object, on purpose: what `JSON.parse` returns is
 * plain data, so nothing the sender wrote runs while it is read (no getters,
 * no proxies), it can't contain itself, and reading it costs in proportion to
 * the text, which is its caller's to bound as it bounds any message.
 *
 * The descriptor is untrusted and is checked as strictly as a declaration in
 * code: text that isn't JSON, unknown versions, kinds and keys, invalid
 * bounds and defaults, prototype keys and oversized descriptors all throw
 * `ValueDefinitionError`.
 */
export const schemaFromDescriptor = (
  text: string
): ValueSchema<unknown, unknown> => schemaOf(descriptorRead(text));

/**
 * The descriptor in `text`, checked exactly as {@link schemaFromDescriptor}
 * checks it, as data: what a host hands the reference generator from
 * descriptors it holds as text (a catalog contract's, as a bound
 * workflow's decision).
 */
export const descriptorFromText = (text: string): ValueDescriptor => {
  const descriptor = descriptorRead(text);
  schemaOf(descriptor);
  return descriptor;
};
