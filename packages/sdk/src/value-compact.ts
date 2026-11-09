import { canonicalText } from "@grasp-os/shared/json";

import { seal } from "./descriptor-seal.ts";
import {
  descriptorVersion,
  isPlainObject,
  unsafeKeys,
  ValueDefinitionError,
  valueLimits,
} from "./value-descriptor.ts";
import type {
  JsonValue,
  SemanticKind,
  ValueDescriptor,
} from "./value-descriptor.ts";

// A value descriptor's compact form: what a person or an agent writes by
// hand where a descriptor is stored as text (a workflow's JSON, an App's
// definition). It says what `v` says and nothing more, in `v`'s words:
// `{ "kind": "string", "max": 200, "optional": true }` is
// `v.string().max(200).optional()`. Everything a descriptor holds by
// default is left out (`descriptorVersion`, `nullable: false`, `presence:
// "required"`, `trim: false`, `email: false`, `integer: false`), a flag is
// only ever `true`, and a default is the `default` it falls back to.
//
// One reader, one writer: `descriptorFromCompact` reads the compact form
// into the full descriptor every check runs on, sealed exactly as `v`
// seals one, and `compactDescriptor` writes a full descriptor back. Where
// the text is kept (a file, a database row) is its holder's business.
// `compactDescriptorSchema` is its JSON Schema, for editors and for the
// JSON Schema of a format that holds it (grasp-workflow/1's `$schema`).

/** A descriptor's compact form (see the header). */
export type CompactDescriptor = CompactModifiers & CompactKind;

/** What every kind may add: `v`'s `.nullable()`, `.optional()` and `.default()`. */
interface CompactModifiers {
  readonly nullable?: true;
  readonly optional?: true;
  readonly default?: JsonValue;
}

/** What each kind adds, as its `v` builder and modifiers say it. */
export type CompactKind =
  | {
      readonly kind: "string";
      readonly trim?: true;
      readonly email?: true;
      readonly min?: number;
      readonly max?: number;
    }
  | {
      readonly kind: "number";
      readonly integer?: true;
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly kind: "boolean" | "null" | SemanticKind }
  | {
      readonly kind: "literal";
      readonly value: null | boolean | number | string;
    }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | {
      readonly kind: "id";
      readonly tableName: string;
      readonly onDelete?: "cascade";
    }
  | {
      readonly kind: "object";
      readonly fields: Readonly<Record<string, CompactDescriptor>>;
    }
  | {
      readonly kind: "array";
      readonly item: CompactDescriptor;
      readonly min?: number;
      readonly max?: number;
    }
  | { readonly kind: "union"; readonly members: readonly CompactDescriptor[] }
  | { readonly kind: "record"; readonly value: CompactDescriptor };

/** The keys every kind may have. */
const modifierKeys: ReadonlySet<string> = new Set([
  "nullable",
  "optional",
  "default",
]);

/** The keys each kind adds; a compact descriptor with any other is refused. */
const kindKeys: Readonly<Record<string, readonly string[]>> = {
  array: ["item", "min", "max"],
  boolean: [],
  enum: ["values"],
  id: ["tableName", "onDelete"],
  literal: ["value"],
  null: [],
  number: ["integer", "min", "max"],
  object: ["fields"],
  record: ["value"],
  string: ["trim", "email", "min", "max"],
  union: ["members"],
  duration: [],
  file: [],
  model: [],
  money: [],
  person: [],
  schedule: [],
  template: [],
  timestamp: [],
};

/** The keys that are flags: present only as `true`. */
const flagKeys: ReadonlySet<string> = new Set([
  "nullable",
  "optional",
  "trim",
  "email",
  "integer",
]);

/**
 * Why a compact descriptor was refused, and where: `path` leads to the
 * descriptor it is about, from the one read (`["fields", "name"]`), as a
 * JSON Pointer's tokens do.
 */
export class CompactDescriptorError extends ValueDefinitionError {
  readonly path: readonly (string | number)[];

  constructor(error: ValueDefinitionError, path: readonly (string | number)[]) {
    super(error.code, error.message);
    this.name = "CompactDescriptorError";
    this.path = path;
  }
}

/** A descriptor's `min` and `max`, those it sets. */
const boundsOf = (descriptor: {
  readonly min?: number;
  readonly max?: number;
}): { min?: number; max?: number } => ({
  ...(descriptor.min === undefined ? {} : { min: descriptor.min }),
  ...(descriptor.max === undefined ? {} : { max: descriptor.max }),
});

/** What a scalar kind sets, in the compact form; undefined for any other. */
const scalarPart = (
  descriptor: ValueDescriptor
): Record<string, unknown> | undefined => {
  if (descriptor.kind === "string") {
    return {
      ...(descriptor.trim ? { trim: true } : {}),
      ...(descriptor.email ? { email: true } : {}),
      ...boundsOf(descriptor),
    };
  }
  if (descriptor.kind === "number") {
    return {
      ...(descriptor.integer ? { integer: true } : {}),
      ...boundsOf(descriptor),
    };
  }
  if (descriptor.kind === "literal") {
    return { value: descriptor.value };
  }
  if (descriptor.kind === "enum") {
    return { values: [...descriptor.values] };
  }
  if (descriptor.kind === "id") {
    return {
      tableName: descriptor.tableName,
      ...(descriptor.onDelete === undefined
        ? {}
        : { onDelete: descriptor.onDelete }),
    };
  }
  return undefined;
};

/** What a kind that nests sets, in the compact form; `{}` for any other. */
const nestedPart = (descriptor: ValueDescriptor): Record<string, unknown> => {
  if (descriptor.kind === "object") {
    return {
      fields: Object.fromEntries(
        Object.entries(descriptor.fields).map(([name, field]) => [
          name,
          // oxlint-disable-next-line no-use-before-define -- the two recurse
          compactDescriptor(field),
        ])
      ),
    };
  }
  if (descriptor.kind === "array") {
    return {
      // oxlint-disable-next-line no-use-before-define -- the two recurse
      item: compactDescriptor(descriptor.item),
      ...boundsOf(descriptor),
    };
  }
  if (descriptor.kind === "union") {
    // oxlint-disable-next-line no-use-before-define -- the two recurse
    return { members: descriptor.members.map(compactDescriptor) };
  }
  if (descriptor.kind === "record") {
    // oxlint-disable-next-line no-use-before-define -- the two recurse
    return { value: compactDescriptor(descriptor.value) };
  }
  return {};
};

/**
 * `descriptor` in its compact form (see the header): its kind and what
 * its kind sets, a flag only where it is true, then the modifiers.
 */
export const compactDescriptor = (
  descriptor: ValueDescriptor
): CompactDescriptor => {
  const out: { kind: ValueDescriptor["kind"]; [key: string]: unknown } = {
    kind: descriptor.kind,
    ...(scalarPart(descriptor) ?? nestedPart(descriptor)),
  };
  if (descriptor.nullable) {
    out.nullable = true;
  }
  if (descriptor.presence === "optional") {
    out.optional = true;
  } else if (descriptor.presence === "default") {
    out.default = structuredClone(descriptor.defaultValue);
  }
  // SAFETY: built above from a sealed descriptor, key by key, as
  // `CompactDescriptor` describes it.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return out as CompactDescriptor;
};

/** The longest compact form a refusal spells out for its writer. */
const canonicalHintLength = 300;

/** What reading one compact descriptor has spent of its limits so far. */
interface Budget {
  nodes: number;
}

const refuse = (message: string): never => {
  throw new ValueDefinitionError("definition.invalid_descriptor", message);
};

/** Refuses a key `input`'s kind doesn't have, and a flag that isn't `true`. */
const checkKeys = (input: Record<string, unknown>, kind: string): void => {
  const own = kindKeys[kind] ?? [];
  for (const key of Object.keys(input)) {
    if (key !== "kind" && !own.includes(key) && !modifierKeys.has(key)) {
      refuse(`\`${key.slice(0, 64)}\` isn't a key of a \`${kind}\`.`);
    }
    if (flagKeys.has(key) && input[key] !== true) {
      refuse(`\`${key}\` is \`true\`, or left out.`);
    }
  }
  if (Object.hasOwn(input, "optional") && Object.hasOwn(input, "default")) {
    refuse("A value is `optional` or has a `default`, never both.");
  }
};

/** The kind `input` names, once it is one of the kinds `v` has. */
const kindOf = (input: Record<string, unknown>): string => {
  const { kind } = input;
  if (typeof kind !== "string" || !Object.hasOwn(kindKeys, kind)) {
    return refuse(
      `\`kind\` is one of ${Object.keys(kindKeys).join(", ")}, as \`v\` names them.`
    );
  }
  return kind;
};

/** A path's next step, read as a nested descriptor of its own. */
type Nested = (value: unknown, ...at: (string | number)[]) => ValueDescriptor;

/** An object's fields, each read where it is; a prototype key refused there. */
const fieldsOf = (
  fields: unknown,
  path: readonly (string | number)[],
  nested: Nested
): Record<string, unknown> => {
  if (!isPlainObject(fields)) {
    return refuse("An object's `fields` are a map of names to descriptors.");
  }
  const descriptors: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    if (unsafeKeys.has(name)) {
      throw new CompactDescriptorError(
        new ValueDefinitionError(
          "definition.invalid_key",
          "A field is never named `__proto__`, `constructor` or `prototype`."
        ),
        [...path, "fields", name]
      );
    }
    Object.defineProperty(descriptors, name, {
      enumerable: true,
      value: nested(field, "fields", name),
    });
  }
  return descriptors;
};

/** What a kind that nests holds, its parts read first; `{}` for any other. */
const nestedDraft = (
  kind: string,
  input: Record<string, unknown>,
  path: readonly (string | number)[],
  nested: Nested
): Record<string, unknown> => {
  if (kind === "array") {
    return { item: nested(input.item, "item") };
  }
  if (kind === "record") {
    return { value: nested(input.value, "value") };
  }
  if (kind === "object") {
    return { fields: fieldsOf(input.fields, path, nested) };
  }
  if (kind !== "union") {
    return {};
  }
  const { members } = input;
  // The length is checked before a member is read.
  if (!Array.isArray(members) || members.length > valueLimits.unionMembers) {
    return refuse(
      `A union's \`members\` are a list of at most ${valueLimits.unionMembers} descriptors.`
    );
  }
  return {
    members: members.map((member: unknown, index) =>
      nested(member, "members", index)
    ),
  };
};

/**
 * `sealed`, once `input` is its one spelling: what `v` seals it to,
 * written back, is what was read, or the reader refuses it (a union with
 * a null member, a default its own `.trim()` changes, a lone member).
 */
const canonicalOnly = (
  input: Record<string, unknown>,
  sealed: ValueDescriptor
): ValueDescriptor => {
  const canonical = compactDescriptor(sealed);
  if (canonicalText(input) === canonicalText(canonical)) {
    return sealed;
  }
  const written = JSON.stringify(canonical);
  return refuse(
    written.length <= canonicalHintLength
      ? `Write it in its one compact form: ${written}`
      : "Write it in its one compact form, as `v` would declare it."
  );
};

/** The flags a kind has, each false where the compact form leaves it out. */
const flagsOf = (
  kind: string,
  { trim, email, integer }: Record<string, unknown>
): Record<string, boolean> => {
  if (kind === "string") {
    return { trim: trim === true, email: email === true };
  }
  return kind === "number" ? { integer: integer === true } : {};
};

/** Reads `input` at `path`, its nested descriptors first (see the header). */
const expand = (
  input: unknown,
  path: readonly (string | number)[],
  budget: Budget
): ValueDescriptor => {
  const nested: Nested = (value, ...at) =>
    expand(value, [...path, ...at], budget);
  try {
    budget.nodes += 1;
    if (
      path.length >= valueLimits.depth * 2 ||
      budget.nodes > valueLimits.descriptorNodes
    ) {
      throw new ValueDefinitionError(
        "definition.too_large",
        "The descriptor nests too deep or declares too much."
      );
    }
    if (!isPlainObject(input)) {
      return refuse("A descriptor is a JSON object with a `kind`.");
    }
    const kind = kindOf(input);
    checkKeys(input, kind);
    const {
      nullable,
      optional,
      default: defaultValue,
      trim,
      email,
      integer,
      ...rest
    } = input;
    const presence = Object.hasOwn(input, "default")
      ? { presence: "default", defaultValue }
      : { presence: optional === true ? "optional" : "required" };
    const sealed = seal({
      descriptorVersion,
      nullable: nullable === true,
      ...presence,
      ...rest,
      ...flagsOf(kind, { trim, email, integer }),
      ...nestedDraft(kind, input, path, nested),
    });
    return canonicalOnly(input, sealed);
  } catch (error) {
    if (
      error instanceof ValueDefinitionError &&
      !(error instanceof CompactDescriptorError)
    ) {
      throw new CompactDescriptorError(error, path);
    }
    throw error;
  }
};

/**
 * The full descriptor `input`, a compact one, stands for, sealed as `v`
 * seals one: checked as strictly as a declaration in code. Throws
 * `CompactDescriptorError`, whose `path` leads to the descriptor at fault,
 * for anything that isn't a compact descriptor: an unknown kind or key, a
 * flag that isn't `true`, invalid bounds or defaults, prototype keys, and
 * descriptors past the limits.
 */
export const descriptorFromCompact = (input: unknown): ValueDescriptor =>
  expand(input, [], { nodes: 0 });

// The JSON Schema (draft 2020-12) of the compact form, as `$defs` a schema
// that holds descriptors takes in: `descriptor` refers to itself as
// `#/$defs/descriptor`. It describes the form for editors; whether a
// descriptor holds (its bounds, its default) is `descriptorFromCompact`'s
// to decide.

const ref = { $ref: "#/$defs/descriptor" } as const;
const flag = { const: true } as const;
const count = { type: "integer", minimum: 0 } as const;

/** What each kind adds, as JSON Schema properties. */
const kindProperties: Readonly<Record<string, Record<string, unknown>>> = {
  string: { trim: flag, email: flag, min: count, max: count },
  number: { integer: flag, min: { type: "number" }, max: { type: "number" } },
  literal: { value: { type: ["null", "boolean", "number", "string"] } },
  enum: {
    values: {
      type: "array",
      minItems: 1,
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 1,
        maxLength: valueLimits.nameLength,
      },
    },
  },
  id: {
    tableName: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,63}$" },
    onDelete: { const: "cascade" },
  },
  object: {
    fields: {
      type: "object",
      propertyNames: { minLength: 1, maxLength: valueLimits.fieldNameLength },
      additionalProperties: ref,
    },
  },
  array: { item: ref, min: count, max: count },
  union: {
    members: {
      type: "array",
      minItems: 1,
      maxItems: valueLimits.unionMembers,
      items: ref,
    },
  },
  record: { value: ref },
};

/** The keys each kind must have. */
const kindRequired: Readonly<Record<string, readonly string[]>> = {
  literal: ["value"],
  enum: ["values"],
  id: ["tableName"],
  object: ["fields"],
  array: ["item"],
  union: ["members"],
  record: ["value"],
};

/** The compact form's JSON Schema, as `$defs` entries (see above). */
export const compactDescriptorSchema = {
  descriptor: {
    description:
      'A value\'s schema, as `v` declares it: `{ "kind": "string", "max": 200 }` is `v.string().max(200)`. Add `"nullable": true`, `"optional": true` or `"default": <value>` as `.nullable()`, `.optional()` and `.default(value)`; leave out whatever is false.',
    type: "object",
    required: ["kind"],
    properties: { kind: { enum: Object.keys(kindKeys) } },
    not: { required: ["optional", "default"] },
    allOf: Object.keys(kindKeys).map((kind) => ({
      if: { properties: { kind: { const: kind } }, required: ["kind"] },
      // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema's if/then
      then: {
        properties: {
          kind: true,
          nullable: flag,
          optional: flag,
          default: true,
          ...kindProperties[kind],
        },
        required: kindRequired[kind] ?? [],
        additionalProperties: false,
      },
    })),
  },
} as const;
