import { isPlainObject } from "@grasp-os/shared/json";

import { namePattern, refuser } from "./declaration.ts";
import { requiredChild, sealedChild } from "./sealed-descriptors.ts";
import type { DescriptorDraft, Sealed } from "./sealed-descriptors.ts";
import {
  isSemanticKind,
  unsafeKeys,
  ValueDefinitionError,
  valueLimits,
} from "./value-descriptor.ts";
import type {
  ValueDefinitionCode,
  ValueDescriptor,
  ValueKindDescriptor,
} from "./value-descriptor.ts";

const refuse: (code: ValueDefinitionCode, message: string) => never =
  refuser(ValueDefinitionError);

export const flag = (draft: DescriptorDraft, key: string): boolean => {
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
  if (typeof limit !== "number" || !isValid(limit)) {
    return refuse(
      "definition.invalid_bound",
      `\`${key}\` isn't a number this kind of value can be bound by.`
    );
  }
  // -0 is 0: one bound, one descriptor.
  return limit === 0 ? 0 : limit;
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

/**
 * Length bounds without a minimum of 0, which every length meets: so
 * `.min(0)` and no minimum are one descriptor.
 */
const withoutZeroMin = ({
  min,
  max,
}: {
  min?: number;
  max?: number;
}): { min?: number; max?: number } => ({
  ...(min === undefined || min === 0 ? {} : { min }),
  ...(max === undefined ? {} : { max }),
});

/**
 * An integer's bounds as the integers they let through: rounded inwards
 * (`.min(1.5)` is `.min(2)`), and dropped past the safe integers, which
 * every safe integer is within anyway. So bounds that mean the same are
 * one descriptor.
 */
const integerBounds = ({
  min,
  max,
}: {
  min?: number;
  max?: number;
}): { min?: number; max?: number } => {
  const low = min === undefined ? undefined : Math.ceil(min);
  const high = max === undefined ? undefined : Math.floor(max);
  // Past the safe integers on the wrong side, or crossed: no safe integer
  // is left to pass.
  const admitsNone =
    (low !== undefined && low > Number.MAX_SAFE_INTEGER) ||
    (high !== undefined && high < Number.MIN_SAFE_INTEGER) ||
    (low !== undefined && high !== undefined && low > high);
  if (admitsNone) {
    return refuse(
      "definition.contradictory_bounds",
      "No safe whole number is between `min` and `max`."
    );
  }
  return {
    ...(low === undefined || low <= Number.MIN_SAFE_INTEGER
      ? {}
      : { min: low }),
    ...(high === undefined || high >= Number.MAX_SAFE_INTEGER
      ? {}
      : { max: high }),
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
    if (
      !isName(key) ||
      key.length > valueLimits.fieldNameLength ||
      unsafeKeys.has(key)
    ) {
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

/**
 * A record ID's table, and what deleting the record it names does: restrict,
 * the default, is left out, so a schema that never says it keeps its hash.
 */
const idBody = (draft: DescriptorDraft): Body => {
  const { tableName, onDelete } = draft;
  if (typeof tableName !== "string" || !namePattern.test(tableName)) {
    return refuse(
      "definition.invalid_name",
      "A table's name starts with a letter and has only letters, digits and underscores."
    );
  }
  if (onDelete === undefined || onDelete === "restrict") {
    return { children: [], kind: { kind: "id", tableName } };
  }
  return onDelete === "cascade"
    ? { children: [], kind: { kind: "id", tableName, onDelete } }
    : refuse(
        "definition.invalid_value",
        "A record ID's onDelete is restrict or cascade."
      );
};

/** What the draft's kind adds, checked; and the descriptors nested in it. */
export const kindBody = (draft: DescriptorDraft): Body => {
  const { kind } = draft;
  switch (kind) {
    case "string": {
      return {
        children: [],
        kind: {
          kind,
          trim: flag(draft, "trim"),
          email: flag(draft, "email"),
          ...withoutZeroMin(bounds(draft, isLength)),
        },
      };
    }
    case "number": {
      const integer = flag(draft, "integer");
      return {
        children: [],
        kind: {
          kind,
          integer,
          ...(integer
            ? integerBounds(bounds(draft, Number.isFinite))
            : bounds(draft, Number.isFinite)),
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
      return idBody(draft);
    }
    case "object": {
      return objectBody(draft);
    }
    case "array": {
      const item = requiredChild(draft.item);
      return {
        children: [item],
        kind: {
          kind,
          item: item.descriptor,
          ...withoutZeroMin(bounds(draft, isLength)),
        },
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
