import type { ValueDescriptor } from "./value-descriptor.ts";

// A value descriptor's references to tables (`v.id`), followed through a
// rename of those tables: what a table renamed by its stable ID does to
// every field that refers to it, in an App's definition
// (definition-operations.ts) and in a store's contract (schema-plan.ts).

/** `descriptor` with every reference to a table `names` renames following it. */
export const referencesRenamed = (
  descriptor: ValueDescriptor,
  names: ReadonlyMap<string, string>
): ValueDescriptor => {
  // Walked by kind, as schema-plan.ts `holdsKind` walks: only these hold
  // a reference.
  if (descriptor.kind === "id") {
    return {
      ...descriptor,
      tableName: names.get(descriptor.tableName) ?? descriptor.tableName,
    };
  }
  if (descriptor.kind === "object") {
    return {
      ...descriptor,
      fields: Object.fromEntries(
        Object.entries(descriptor.fields).map(
          ([field, value]) => [field, referencesRenamed(value, names)] as const
        )
      ),
    };
  }
  if (descriptor.kind === "array") {
    return { ...descriptor, item: referencesRenamed(descriptor.item, names) };
  }
  if (descriptor.kind === "union") {
    return {
      ...descriptor,
      members: descriptor.members.map((member) =>
        referencesRenamed(member, names)
      ),
    };
  }
  if (descriptor.kind === "record") {
    return { ...descriptor, value: referencesRenamed(descriptor.value, names) };
  }
  return descriptor;
};
