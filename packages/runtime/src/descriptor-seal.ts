import { deepFreeze, refuser } from "./declaration.ts";
import { flag, kindBody } from "./descriptor-bodies.ts";
import { requiredChild, sealed } from "./sealed-descriptors.ts";
import type { DescriptorDraft } from "./sealed-descriptors.ts";
import {
  descriptorVersion,
  ValueDefinitionError,
  valueLimits,
} from "./value-descriptor.ts";
import type {
  FrozenJson,
  Presence,
  ValueDefinitionCode,
  ValueDescriptor,
} from "./value-descriptor.ts";
import { validateValue } from "./value-interpreter.ts";

// How a descriptor comes to be, and the schema around it. Every way to make
// one (a `v` builder, a modifier, reading a stored descriptor back) ends in
// `seal`, which checks the whole declaration and freezes it. So a descriptor
// that exists is valid, and two declarations that mean the same are the same
// descriptor, whatever order their modifiers were written in.

const refuse: (code: ValueDefinitionCode, message: string) => never =
  refuser(ValueDefinitionError);

/** Whether a member of a union lets through only null. */
const isNullOnly = (descriptor: ValueDescriptor): boolean =>
  descriptor.kind === "null" ||
  (descriptor.kind === "literal" && descriptor.value === null);

/**
 * The one form of a union that means the same as a simpler draft, or
 * undefined if it has none. Its null members become its being nullable
 * (`v.union(T, v.null())` is `T.nullable()`), and a union left with one
 * member is that member, with the union's presence, default and
 * nullability. A union too long or with members that aren't schemas is
 * left as it is, for `unionBody` to refuse.
 */
const collapsedUnion = (
  draft: DescriptorDraft
): DescriptorDraft | undefined => {
  const { members } = draft;
  if (
    draft.kind !== "union" ||
    !Array.isArray(members) ||
    members.length === 0 ||
    members.length > valueLimits.unionMembers
  ) {
    return undefined;
  }
  // Read first, so a malformed flag is refused even when null members
  // would make the union nullable anyway.
  const declaredNullable = flag(draft, "nullable");
  const children = members.map(requiredChild);
  const others = children.filter((child) => !isNullOnly(child.descriptor));
  const [only] = others;
  const hasNull = others.length < children.length;
  if (!hasNull && others.length > 1) {
    return undefined;
  }
  const nullable = hasNull || declaredNullable;
  const presence =
    draft.presence === "default"
      ? { presence: "default", defaultValue: draft.defaultValue }
      : { presence: draft.presence };
  if (only === undefined) {
    return { descriptorVersion, kind: "null", nullable: false, ...presence };
  }
  return others.length === 1
    ? {
        ...only.descriptor,
        nullable: nullable || only.descriptor.nullable,
        ...presence,
      }
    : {
        ...draft,
        members: others.map((child) => child.descriptor),
        nullable,
      };
};

const presences: ReadonlySet<unknown> = new Set<Presence>([
  "required",
  "optional",
  "default",
]);

const isPresence = (value: unknown): value is Presence => presences.has(value);

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
  if (result.issues !== undefined) {
    return refuse(
      "definition.invalid_default",
      "The default isn't a value its own schema accepts."
    );
  }
  // SAFETY: what the interpreter just returned for a descriptor is JSON it
  // built itself; freezing it makes it FrozenJson.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  return deepFreeze(result.value) as FrozenJson;
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
  const collapsed = collapsedUnion(draft);
  if (collapsed !== undefined) {
    return seal(collapsed);
  }
  const nullable = flag(draft, "nullable");
  const base = {
    descriptorVersion,
    // Null alone is null whether or not it is also nullable.
    nullable: draft.kind !== "null" && nullable,
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
