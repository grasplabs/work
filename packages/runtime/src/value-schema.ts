import { refuser } from "./declaration.ts";
import { seal } from "./descriptor-seal.ts";
import { fieldDescriptors } from "./sealed-descriptors.ts";
import type { DescriptorDraft } from "./sealed-descriptors.ts";
import { descriptorVersion, ValueDefinitionError } from "./value-descriptor.ts";
import type {
  ValueDefinitionCode,
  ValueDescriptor,
  ValueSchema,
} from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";

/** A schema of any kind, as the builders pass them around. */
export type AnySchema = ValueSchema<unknown, unknown>;

const refuse: (code: ValueDefinitionCode, message: string) => never =
  refuser(ValueDefinitionError);

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
