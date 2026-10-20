import type { OperationManifest } from "./app.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";
import { readDescriptor } from "./value-read.ts";

/** `descriptor` read back as any descriptor is: well formed, whatever made it. */
const checked = (descriptor: ValueDescriptor): ValueDescriptor =>
  readDescriptor(descriptor, 1, { nodes: 0 });

// An App's preferences (spec 10.7.7) as the two operations its generated
// `preferences` namespace holds: `preferences.get`, a query of `{}` that
// answers the declared fields and `_rev`, and `preferences.update`, a
// mutation of `{ expectedRevision, patch }` that answers the committed
// document the same way. Public query and mutation references like any of
// the App's, for `useQuery` and `useMutation`; but no App code serves
// them: core does (apps/core/src/app-preferences.ts), for the signed-in
// person only. Declared here once, so the descriptors generated into
// `#grasp` and the ones core checks a call against are the same, and so
// are their fingerprints.

/** The names of the operations an App's `preferences` namespace holds. */
export type PreferenceOperationName = "get" | "update";

/** The path of each preference operation, under the platform's segment. */
export const preferencePaths: Readonly<
  Record<PreferenceOperationName, string>
> = {
  get: "preferences.get",
  update: "preferences.update",
};

const base = { descriptorVersion: 1, nullable: false } as const;

/** A whole number from `min`, required: a revision. */
const revision = (min: number): ValueDescriptor => ({
  ...base,
  presence: "required",
  kind: "number",
  integer: true,
  min,
});

/** `fields` as a strict, required object. */
const objectOf = (
  fields: Readonly<Record<string, ValueDescriptor>>
): ValueDescriptor => ({
  ...base,
  presence: "required",
  kind: "object",
  fields,
});

/** The fields of `preferences`, a strict object registration checked. */
const fieldsOf = (
  preferences: ValueDescriptor
): Readonly<Record<string, ValueDescriptor>> => {
  if (preferences.kind !== "object") {
    throw new TypeError("An App's preferences are an object");
  }
  return preferences.fields;
};

/**
 * What a patch of `preferences` is: the same fields, each optional and
 * without its default, so a field left out stays as it was rather than
 * being reset; still strict, so a key the App didn't declare is refused.
 */
export const preferencePatch = (
  preferences: ValueDescriptor
): ValueDescriptor => {
  const fields: Record<string, ValueDescriptor> = {};
  for (const [name, field] of Object.entries(fieldsOf(preferences))) {
    const { defaultValue: _default, ...kept } = field;
    fields[name] = { ...kept, presence: "optional" };
  }
  return checked(objectOf(fields));
};

/**
 * What both operations answer: the declared fields, filled in, and the
 * document's revision, 0 for one never written.
 */
const documentOf = (preferences: ValueDescriptor): ValueDescriptor =>
  checked(objectOf({ ...fieldsOf(preferences), _rev: revision(0) }));

/**
 * The operations of an App whose preferences are `preferences`, by name,
 * as the App's own public functions are described: fingerprinted and
 * generated as any function reference is.
 */
export const preferenceOperations = (
  preferences: ValueDescriptor
): Readonly<Record<PreferenceOperationName, OperationManifest>> => {
  const answer = documentOf(preferences);
  const described = (
    name: PreferenceOperationName,
    kind: "query" | "mutation",
    args: ValueDescriptor
  ): OperationManifest => ({
    path: preferencePaths[name],
    kind,
    visibility: "public",
    args,
    returns: answer,
    stream: null,
    uses: [],
    tables: {},
  });
  return {
    get: described("get", "query", objectOf({})),
    update: described(
      "update",
      "mutation",
      objectOf({
        expectedRevision: revision(0),
        patch: preferencePatch(preferences),
      })
    ),
  };
};
