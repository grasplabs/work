import {
  isPlainObject,
  ValueDefinitionError,
  valueLimits,
} from "./value-descriptor.ts";
import type { ValueDescriptor, ValueSchema } from "./value-descriptor.ts";
import { schemaOf, seal } from "./value-schema.ts";

// What a host needs of the SDK and App code never does. A host holds
// descriptors as data (in a manifest, from a browser, from another version)
// and turns them back into schemas here, without running the code that
// declared them.

/** The keys every descriptor has. */
const baseKeys = new Set(["descriptorVersion", "kind", "presence", "nullable"]);

/** The keys each kind adds; a descriptor with any other key is refused. */
const kindKeys: Readonly<Record<string, readonly string[]>> = {
  array: ["item", "min", "max"],
  boolean: [],
  duration: [],
  enum: ["values"],
  file: [],
  id: ["tableName"],
  literal: ["value"],
  model: [],
  money: [],
  null: [],
  number: ["integer", "min", "max"],
  object: ["fields"],
  person: [],
  record: ["value"],
  schedule: [],
  string: ["trim", "email", "min", "max"],
  template: [],
  timestamp: [],
  union: ["members"],
};

// Typed where it is declared: only then does a call narrow what follows it.
const refuse: (message: string) => never = (message) => {
  throw new ValueDefinitionError("definition.invalid_descriptor", message);
};

interface Budget {
  nodes: number;
}

/** The keys of a descriptor's kind, once every key it has is one of them. */
const knownKind = (input: Record<string, unknown>): string => {
  const { kind } = input;
  const ownKeys =
    typeof kind === "string" && Object.hasOwn(kindKeys, kind)
      ? kindKeys[kind]
      : undefined;
  if (typeof kind !== "string" || ownKeys === undefined) {
    return refuse("The descriptor's kind isn't one this SDK knows.");
  }
  const hasDefault = input.presence === "default";
  for (const key of Object.keys(input)) {
    const known =
      baseKeys.has(key) ||
      ownKeys.includes(key) ||
      (hasDefault && key === "defaultValue");
    if (!known) {
      return refuse("The descriptor has a key its kind doesn't have.");
    }
  }
  return kind;
};

/**
 * Reads one descriptor of unknown origin. The depth and the count are
 * checked before anything nested is read, so a descriptor that refers to
 * itself, or is too large, is refused instead of followed.
 */
const read = (
  input: unknown,
  depth: number,
  budget: Budget
): ValueDescriptor => {
  budget.nodes += 1;
  if (depth > valueLimits.depth || budget.nodes > valueLimits.descriptorNodes) {
    throw new ValueDefinitionError(
      "definition.too_large",
      "The descriptor nests too deep or declares too much."
    );
  }
  if (!isPlainObject(input)) {
    return refuse("A descriptor is a JSON object.");
  }
  const kind = knownKind(input);
  const nested = (value: unknown): ValueDescriptor =>
    read(value, depth + 1, budget);
  const draft: Record<string, unknown> = { ...input };
  if (kind === "array") {
    draft.item = nested(input.item);
  } else if (kind === "record") {
    draft.value = nested(input.value);
  } else if (kind === "union") {
    const { members } = input;
    // The length is checked before a member is read.
    if (!Array.isArray(members) || members.length > valueLimits.unionMembers) {
      return refuse("A union's members are a short list of descriptors.");
    }
    draft.members = members.map(nested);
  } else if (kind === "object") {
    const { fields } = input;
    if (!isPlainObject(fields)) {
      return refuse("An object's fields are a map of names to descriptors.");
    }
    const descriptors: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(fields)) {
      // Defined, not assigned: `seal` refuses a prototype key by its name.
      Object.defineProperty(descriptors, key, {
        enumerable: true,
        value: nested(field),
      });
    }
    draft.fields = descriptors;
  }
  return seal(draft);
};

/**
 * The schema a descriptor describes, e.g. one read from a manifest or sent
 * by a browser. The descriptor is untrusted: it is checked as strictly as a
 * declaration in code (unknown versions, kinds and keys, invalid bounds and
 * defaults, prototype keys, cycles and oversized descriptors all throw
 * `ValueDefinitionError`), and the schema returned is built from a checked
 * copy, never from the object passed in.
 */
export const schemaFromDescriptor = (
  descriptor: unknown
): ValueSchema<unknown, unknown> => {
  try {
    return schemaOf(read(descriptor, 1, { nodes: 0 }));
  } catch (error) {
    if (error instanceof ValueDefinitionError) {
      throw error;
    }
    // Only a descriptor that runs code when read (a proxy, a getter) gets
    // here; what it threw is not passed on.
    return refuse("The descriptor can't be read as JSON.");
  }
};
