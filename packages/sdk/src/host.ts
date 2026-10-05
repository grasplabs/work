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

// Which currencies and time zones this SDK accepts: a host compares it with
// its own before it activates an App.
export { valueCatalogVersion } from "./value-catalog.ts";

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

/**
 * How deep the data of a descriptor nests at most: each of its levels is a
 * descriptor inside a map of fields, and a default value nests below those.
 */
const dataDepth = valueLimits.depth * 4;

/**
 * Objects and arrays in the largest descriptor `v` declares, defaults aside:
 * each descriptor is one, and holds at most one more (its fields, its
 * members or its values).
 */
const structureNodes = valueLimits.descriptorNodes * 2;

interface CopyBudget {
  /** Objects and arrays this part of the copy may still hold. */
  left: number;
  /** Shared by every part of one copy: set when our own bound refused it. */
  readonly copy: { tooLarge: boolean };
}

const tooLarge = (budget: CopyBudget): never => {
  budget.copy.tooLarge = true;
  throw new Error("The descriptor is too large.");
};

/**
 * A copy of what was passed in, holding plain data only. A descriptor is
 * JSON, so a property that is computed when read (a getter) is refused
 * without being read, as is anything that isn't a plain object or an array.
 *
 * It is bounded as a declaration is, so every schema `v` declares can be
 * read back: the descriptors share one budget, and each default value has
 * its own, the size one check may read. Data that contains itself runs out
 * of depth and is refused instead of followed. `inDefault` says the copy is
 * inside a default value, where a key named `defaultValue` is only data.
 */
const dataOf = (
  value: unknown,
  depth: number,
  budget: CopyBudget,
  inDefault: boolean
): unknown => {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  budget.left -= 1;
  if (depth > dataDepth || budget.left < 0) {
    return tooLarge(budget);
  }
  const isArray = Array.isArray(value);
  if (!(isArray || isPlainObject(value))) {
    throw new Error("The descriptor isn't JSON.");
  }
  // Counted before a property is read or copied: one that is too wide is
  // refused for its width, not after the work of copying it.
  const keys = Object.keys(value);
  const width = isArray ? Math.max(value.length, keys.length) : keys.length;
  if (width > valueLimits.steps) {
    return tooLarge(budget);
  }
  const copy: unknown[] | Record<string, unknown> = isArray ? [] : {};
  if (isArray) {
    // Kept, so an array with holes stays one and is refused as before.
    copy.length = value.length;
  }
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (property === undefined || !("value" in property)) {
      throw new Error("The descriptor has a getter.");
    }
    const ofDefault = !(inDefault || isArray) && key === "defaultValue";
    const nested = ofDefault
      ? dataOf(
          property.value,
          depth + 1,
          { copy: budget.copy, left: valueLimits.steps },
          true
        )
      : dataOf(property.value, depth + 1, budget, inDefault);
    // Defined, not assigned: a prototype key stays a key and is refused by
    // its name later.
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      value: nested,
      writable: true,
    });
  }
  return copy;
};

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
  const budget: CopyBudget = {
    copy: { tooLarge: false },
    left: structureNodes,
  };
  let data: unknown;
  try {
    data = dataOf(descriptor, 1, budget, false);
  } catch {
    // Replaced on purpose. Copying is the only step that touches the object
    // passed in, so it is the only one that can run its sender's code (a
    // proxy's traps). Whatever that code threw, even an error of our own
    // class, is the sender's text and is not passed on.
    if (budget.copy.tooLarge) {
      throw new ValueDefinitionError(
        "definition.too_large",
        "The descriptor nests too deep or declares too much."
      );
    }
    return refuse("The descriptor can't be read as JSON.");
  }
  // From here only the copy is read: plain data, which runs no code.
  return schemaOf(read(data, 1, { nodes: 0 }));
};
