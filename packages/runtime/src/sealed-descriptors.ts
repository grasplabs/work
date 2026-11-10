import { refuser } from "./declaration.ts";
import { isPlainObject, ValueDefinitionError } from "./value-descriptor.ts";
import type {
  ValueDefinitionCode,
  ValueDescriptor,
} from "./value-descriptor.ts";

/** A descriptor not yet checked: what a builder or a stored copy proposes. */
export type DescriptorDraft = Readonly<Record<string, unknown>>;

export interface Sealed {
  /** Levels of nesting, this descriptor included. */
  readonly depth: number;
  readonly descriptor: ValueDescriptor;
  /** Descriptors within, this one included, and enum values. */
  readonly weight: number;
}

/** Every descriptor `seal` made; nothing else counts as one. */
export const sealed = new WeakMap<object, Sealed>();

const refuse: (code: ValueDefinitionCode, message: string) => never =
  refuser(ValueDefinitionError);

export const sealedChild = (value: unknown): Sealed => {
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
export const requiredChild = (value: unknown): Sealed => {
  const child = sealedChild(value);
  if (child.descriptor.presence !== "required") {
    refuse(
      "definition.invalid_schema",
      "An array item, a record value and a union member can't be optional or have a default."
    );
  }
  return child;
};
