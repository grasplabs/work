import {
  descriptorVersion,
  isPlainObject,
  isSemanticKind,
  unsafeKeys,
  ValueDefinitionError,
  valueLimits,
} from "./value-descriptor.ts";
import type {
  FrozenJson,
  Presence,
  ValueDefinitionCode,
  ValueDescriptor,
  ValueKindDescriptor,
  ValueSchema,
} from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";

// How a descriptor comes to be, and the schema around it. Every way to make
// one (a `v` builder, a modifier, reading a stored descriptor back) ends in
// `seal`, which checks the whole declaration and freezes it. So a descriptor
// that exists is valid, and two declarations that mean the same are the same
// descriptor, whatever order their modifiers were written in.

/** A schema of any kind, as the builders pass them around. */
export type AnySchema = ValueSchema<unknown, unknown>;

/** A descriptor not yet checked: what a builder or a stored copy proposes. */
export type DescriptorDraft = Readonly<Record<string, unknown>>;

interface Sealed {
  /** Levels of nesting, this descriptor included. */
  readonly depth: number;
  readonly descriptor: ValueDescriptor;
  /** Descriptors within, this one included, and enum values. */
  readonly weight: number;
}

/** Every descriptor `seal` made; nothing else counts as one. */
const sealed = new WeakMap<object, Sealed>();

// Typed where it is declared: only then does a call narrow what follows it.
const refuse: (code: ValueDefinitionCode, message: string) => never = (
  code,
  message
) => {
  throw new ValueDefinitionError(code, message);
};

const sealedChild = (value: unknown): Sealed => {
  const child =
    typeof value === "object" && value !== null ? sealed.get(value) : undefined;
  return (
    child ??
    refuse(
      "definition.invalid_schema",
      "A schema is built from `v` schemas only."
    )
  );
};

/** The descriptor of something passed where a schema belongs. */
export const descriptorOf = (schema: unknown): ValueDescriptor =>
  sealedChild(isPlainObject(schema) ? schema.descriptor : undefined).descriptor;

/**
 * The descriptors of a shape: the map of names to schemas an object is
 * declared with.
 */
export const fieldDescriptors = (shape: unknown): Record<string, unknown> => {
  if (!isPlainObject(shape)) {
    return refuse(
      "definition.invalid_schema",
      "An object's fields are a map of names to schemas."
    );
  }
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [key, descriptorOf(field)])
  );
};

/** A nested schema that stands for exactly one value: an item, a member. */
const requiredChild = (value: unknown): Sealed => {
  const child = sealedChild(value);
  if (child.descriptor.presence !== "required") {
    refuse(
      "definition.invalid_schema",
      "An array item, a record value and a union member can't be optional or have a default."
    );
  }
  return child;
};

const flag = (draft: DescriptorDraft, key: string): boolean => {
  const value = draft[key];
  return typeof value === "boolean"
    ? value
    : refuse("definition.invalid_descriptor", `\`${key}\` must be a boolean.`);
};

/** A `min` or `max`, when the draft has one. */
const bound = (
  draft: DescriptorDraft,
  key: "min" | "max",
  isValid: (limit: number) => boolean
): number | undefined => {
  const limit = draft[key];
  if (limit === undefined) {
    return undefined;
  }
  return typeof limit === "number" && isValid(limit)
    ? limit
    : refuse(
        "definition.invalid_bound",
        `\`${key}\` isn't a number this kind of value can be bound by.`
      );
};

/** The bounds of a draft, each the strongest that was set. */
const bounds = (
  draft: DescriptorDraft,
  isValid: (limit: number) => boolean
): { min?: number; max?: number } => {
  const min = bound(draft, "min", isValid);
  const max = bound(draft, "max", isValid);
  if (min !== undefined && max !== undefined && min > max) {
    refuse(
      "definition.contradictory_bounds",
      "`min` is above `max`: no value could pass."
    );
  }
  return {
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
  };
};

/** A length: of a string in code units, of an array in elements. */
const isLength = (limit: number): boolean =>
  Number.isSafeInteger(limit) && limit >= 0;

const isName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= valueLimits.nameLength;

/**
 * A table's name, as `v.id(tableName)` states it: a letter, then letters,
 * digits and underscores. Whether the table exists is the schema's to check.
 */
const tableNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

interface Body {
  readonly children: readonly Sealed[];
  /** Enum values, which count towards the size of a schema. */
  readonly extraWeight?: number;
  readonly kind: ValueKindDescriptor;
}

const literalBody = (draft: DescriptorDraft): Body => {
  const { value } = draft;
  const isLiteral =
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && value.length <= valueLimits.nameLength);
  return isLiteral
    ? { children: [], kind: { kind: "literal", value } }
    : refuse(
        "definition.invalid_value",
        "A literal is null, a boolean, a finite number or a short string."
      );
};

const enumBody = (draft: DescriptorDraft): Body => {
  const { values } = draft;
  // The length is checked before the values are read or copied.
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    values.length > valueLimits.descriptorNodes
  ) {
    return refuse(
      "definition.invalid_value",
      "An enum is a list of at least one string."
    );
  }
  const seen = new Set<string>();
  for (const value of values) {
    if (!isName(value) || seen.has(value)) {
      return refuse(
        "definition.invalid_value",
        "An enum's values are short strings, each once."
      );
    }
    seen.add(value);
  }
  const names = [...seen];
  return {
    children: [],
    extraWeight: names.length,
    kind: { kind: "enum", values: Object.freeze(names) },
  };
};

const objectBody = (draft: DescriptorDraft): Body => {
  const { fields } = draft;
  if (!isPlainObject(fields)) {
    return refuse(
      "definition.invalid_schema",
      "An object's fields are a map of names to schemas."
    );
  }
  const children: Sealed[] = [];
  const sealedFields: Record<string, ValueDescriptor> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!isName(key) || unsafeKeys.has(key)) {
      return refuse(
        "definition.invalid_key",
        "A field's name is a short string that isn't a prototype key."
      );
    }
    const child = sealedChild(value);
    children.push(child);
    // Defined, not assigned: no name can reach the prototype.
    Object.defineProperty(sealedFields, key, {
      enumerable: true,
      value: child.descriptor,
    });
  }
  return {
    children,
    kind: { kind: "object", fields: Object.freeze(sealedFields) },
  };
};

const unionBody = (draft: DescriptorDraft): Body => {
  const { members } = draft;
  if (
    !Array.isArray(members) ||
    members.length === 0 ||
    members.length > valueLimits.unionMembers
  ) {
    return refuse(
      "definition.invalid_schema",
      `A union has between 1 and ${valueLimits.unionMembers} members.`
    );
  }
  const children = members.map(requiredChild);
  return {
    children,
    kind: {
      kind: "union",
      members: Object.freeze(children.map((child) => child.descriptor)),
    },
  };
};

/** What the draft's kind adds, checked; and the descriptors nested in it. */
const kindBody = (draft: DescriptorDraft): Body => {
  const { kind } = draft;
  switch (kind) {
    case "string": {
      return {
        children: [],
        kind: {
          kind,
          trim: flag(draft, "trim"),
          email: flag(draft, "email"),
          ...bounds(draft, isLength),
        },
      };
    }
    case "number": {
      return {
        children: [],
        kind: {
          kind,
          integer: flag(draft, "integer"),
          ...bounds(draft, Number.isFinite),
        },
      };
    }
    case "boolean":
    case "null": {
      return { children: [], kind: { kind } };
    }
    case "literal": {
      return literalBody(draft);
    }
    case "enum": {
      return enumBody(draft);
    }
    case "id": {
      const { tableName } = draft;
      return typeof tableName === "string" && tableNamePattern.test(tableName)
        ? { children: [], kind: { kind, tableName } }
        : refuse(
            "definition.invalid_name",
            "A table's name starts with a letter and has only letters, digits and underscores."
          );
    }
    case "object": {
      return objectBody(draft);
    }
    case "array": {
      const item = requiredChild(draft.item);
      return {
        children: [item],
        kind: { kind, item: item.descriptor, ...bounds(draft, isLength) },
      };
    }
    case "union": {
      return unionBody(draft);
    }
    case "record": {
      const value = requiredChild(draft.value);
      return { children: [value], kind: { kind, value: value.descriptor } };
    }
    default: {
      return isSemanticKind(kind)
        ? { children: [], kind: { kind } }
        : refuse(
            "definition.invalid_descriptor",
            "The descriptor's kind isn't one this SDK knows."
          );
    }
  }
};

const presences: ReadonlySet<unknown> = new Set<Presence>([
  "required",
  "optional",
  "default",
]);

const isPresence = (value: unknown): value is Presence => presences.has(value);

const deepFreeze = (value: unknown): FrozenJson => {
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  // SAFETY: only called on what the interpreter just returned for a
  // descriptor, which is JSON it built itself; freezing it makes it
  // FrozenJson.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return value as FrozenJson;
};

/**
 * The default a draft proposes, as the schema itself would normalize it. It
 * is checked against the complete declaration every time the declaration
 * changes, so a constraint added after `.default()` refuses a default that
 * no longer fits, and a `.trim()` added after it trims it.
 */
const sealedDefault = (
  candidate: ValueDescriptor,
  defaultValue: unknown
): FrozenJson => {
  if (defaultValue === undefined) {
    return refuse("definition.invalid_default", "A default needs a value.");
  }
  const result = validateValue(candidate, defaultValue);
  return result.issues === undefined
    ? deepFreeze(result.value)
    : refuse(
        "definition.invalid_default",
        "The default isn't a value its own schema accepts."
      );
};

/**
 * Checks a draft and makes it a descriptor: canonical (the same keys in the
 * same order for the same meaning), frozen all the way down, within the
 * limits, and with a default its own rules accept. Throws
 * `ValueDefinitionError` for anything else.
 */
export const seal = (draft: DescriptorDraft): ValueDescriptor => {
  if (draft.descriptorVersion !== descriptorVersion) {
    refuse(
      "definition.invalid_descriptor",
      "The descriptor's version isn't one this SDK knows."
    );
  }
  const { presence } = draft;
  if (!isPresence(presence)) {
    return refuse(
      "definition.invalid_descriptor",
      "`presence` is required, optional or default."
    );
  }
  const base = {
    descriptorVersion,
    nullable: flag(draft, "nullable"),
    presence,
  } as const;
  const body = kindBody(draft);

  const depth = 1 + Math.max(0, ...body.children.map((child) => child.depth));
  let weight = 1 + (body.extraWeight ?? 0);
  for (const child of body.children) {
    weight += child.weight;
  }
  if (depth > valueLimits.depth || weight > valueLimits.descriptorNodes) {
    refuse(
      "definition.too_large",
      "The schema nests too deep or declares too much."
    );
  }

  const candidate: ValueDescriptor = Object.freeze({ ...base, ...body.kind });
  const descriptor: ValueDescriptor =
    presence === "default"
      ? Object.freeze({
          ...base,
          defaultValue: sealedDefault(candidate, draft.defaultValue),
          ...body.kind,
        })
      : candidate;
  sealed.set(descriptor, { depth, descriptor, weight });
  return descriptor;
};

/** A descriptor with one thing about it changed, sealed again. */
const changed = (
  descriptor: ValueDescriptor,
  change: DescriptorDraft
): AnySchema =>
  // oxlint-disable-next-line no-use-before-define -- a schema's modifiers make schemas
  schemaOf(seal({ ...descriptor, ...change }));

/**
 * `min` and `max`, for the kinds that have them. A bound set twice keeps the
 * strongest, so the order they were set in changes nothing.
 */
const boundMethods = (
  descriptor: ValueDescriptor & { readonly min?: number; readonly max?: number }
): object => {
  // Refused before it is weighed against the bound already set: `Math.min`
  // would turn `null` into 0 and `"3"` into 3, and leaving a limit out
  // would set no bound at all, each depending on what was set before.
  const limitOf = (limit: unknown): number =>
    typeof limit === "number"
      ? limit
      : refuse("definition.invalid_bound", "A bound is a number.");
  return {
    max: (limit: unknown) => {
      const max = limitOf(limit);
      return changed(descriptor, {
        max: descriptor.max === undefined ? max : Math.min(descriptor.max, max),
      });
    },
    min: (limit: unknown) => {
      const min = limitOf(limit);
      return changed(descriptor, {
        min: descriptor.min === undefined ? min : Math.max(descriptor.min, min),
      });
    },
  };
};

const objectOf = (fields: Record<string, unknown>): AnySchema =>
  // oxlint-disable-next-line no-use-before-define -- a schema's modifiers make schemas
  schemaOf(
    seal({
      descriptorVersion,
      fields,
      kind: "object",
      nullable: false,
      presence: "required",
    })
  );

/** The keys a `pick` or an `omit` names: fields that exist, each once. */
const namedKeys = (
  fields: Readonly<Record<string, ValueDescriptor>>,
  keys: unknown
): ReadonlySet<string> => {
  if (!Array.isArray(keys)) {
    return refuse("definition.invalid_key", "The keys are a list of names.");
  }
  const names = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string" || !Object.hasOwn(fields, key)) {
      return refuse(
        "definition.invalid_key",
        "A key names a field the object doesn't have."
      );
    }
    if (names.has(key)) {
      return refuse("definition.invalid_key", "A key is named twice.");
    }
    names.add(key);
  }
  return names;
};

/**
 * What an object schema adds: its shape, and new objects made from it. Each
 * of those is a plain required object: the optional, nullable or default of
 * the one it came from doesn't carry over.
 */
const objectMethods = (
  fields: Readonly<Record<string, ValueDescriptor>>
): object => {
  const select = (keys: unknown, keep: boolean): AnySchema => {
    const names = namedKeys(fields, keys);
    // In the order the fields were declared, whatever order the keys came in.
    return objectOf(
      Object.fromEntries(
        Object.entries(fields).filter(([key]) => names.has(key) === keep)
      )
    );
  };
  return {
    extend: (added: unknown) => {
      const more = fieldDescriptors(added);
      if (Object.keys(more).some((key) => Object.hasOwn(fields, key))) {
        return refuse(
          "definition.invalid_key",
          "`extend` adds fields; it can't replace one the object has."
        );
      }
      return objectOf({ ...fields, ...more });
    },
    omit: (keys: unknown) => select(keys, false),
    // Each field optional and without its default, so a patch that leaves a
    // field out never has it filled in. Nested schemas and nullability stay.
    partial: () =>
      objectOf(
        Object.fromEntries(
          Object.entries(fields).map(([key, field]) => [
            key,
            seal({ ...field, presence: "optional" }),
          ])
        )
      ),
    pick: (keys: unknown) => select(keys, true),
    shape: Object.freeze(
      Object.fromEntries(
        Object.entries(fields).map(([key, field]) => [
          key,
          // oxlint-disable-next-line no-use-before-define -- a schema's modifiers make schemas
          schemaOf(field),
        ])
      )
    ),
  };
};

/** The constraints a kind can be given; none for most kinds. */
const kindMethods = (descriptor: ValueDescriptor): object => {
  if (descriptor.kind === "string") {
    return {
      ...boundMethods(descriptor),
      email: () => changed(descriptor, { email: true }),
      trim: () => changed(descriptor, { trim: true }),
    };
  }
  if (descriptor.kind === "number") {
    return {
      ...boundMethods(descriptor),
      integer: () => changed(descriptor, { integer: true }),
    };
  }
  if (descriptor.kind === "array") {
    return boundMethods(descriptor);
  }
  return descriptor.kind === "object" ? objectMethods(descriptor.fields) : {};
};

const schemas = new WeakMap<ValueDescriptor, AnySchema>();

/**
 * The schema of a sealed descriptor: the descriptor, the one validation
 * entry point, and the modifiers its kind supports. The same descriptor
 * always gives the same schema.
 */
export const schemaOf = (descriptor: ValueDescriptor): AnySchema => {
  const known = schemas.get(descriptor);
  if (known !== undefined) {
    return known;
  }
  const schema: AnySchema = Object.freeze({
    ...kindMethods(descriptor),
    "~standard": Object.freeze({
      validate: (value: unknown) => validateValue(descriptor, value),
      vendor: "grasp",
      version: 1,
    }),
    default: (defaultValue: unknown) => {
      if (descriptor.presence === "optional") {
        return refuse(
          "definition.default_with_optional",
          "A value is optional or has a default, never both."
        );
      }
      return changed(descriptor, { defaultValue, presence: "default" });
    },
    descriptor,
    nullable: () => changed(descriptor, { nullable: true }),
    optional: () => {
      if (descriptor.presence === "default") {
        return refuse(
          "definition.default_with_optional",
          "A value is optional or has a default, never both."
        );
      }
      return changed(descriptor, { presence: "optional" });
    },
  });
  schemas.set(descriptor, schema);
  return schema;
};
