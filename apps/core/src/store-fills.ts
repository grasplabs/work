import type { ValueDescriptor } from "@grasp-os/sdk";
import type { SchemaManifest } from "@grasp-os/sdk/host";
import type { Json } from "@grasp-os/shared/json";
import type { StoreFields } from "@grasp-os/shared/stores";

// The fill-missing rule of a defaulted field (spec 17.1, 17.4 step 5):
// a record that lacks a field its store's contract gives a default gets
// that default, and a record that holds the field keeps its value. The
// store's host applies it in two places, with the same code: to every
// record a commit writes, so no writer (one pinned to a schema that never
// declared the field included) can leave a record without it; and to the
// records written before the field existed, a bounded batch at a time
// (store-host.ts, `fillMissing`), before the contract takes the field.
// Never at read time: a read shows what is stored.

/** A defaulted field of a table: its name, descriptor and default. */
export interface DefaultedField {
  readonly field: string;
  readonly descriptor: ValueDescriptor;
  readonly value: Json;
}

/** Each table's defaulted fields, by table name; tables with none left out. */
export type DefaultedFields = ReadonlyMap<string, readonly DefaultedField[]>;

/** The defaulted fields of every table of `manifest`. */
export const defaultedFieldsOf = (manifest: SchemaManifest): DefaultedFields =>
  new Map(
    Object.entries(manifest.tables).flatMap(([table, { fields }]) => {
      const defaulted = Object.entries(fields).flatMap(
        ([field, descriptor]): DefaultedField[] =>
          descriptor.presence === "default" &&
          descriptor.defaultValue !== undefined
            ? [
                {
                  field,
                  descriptor,
                  // A copy of its own: the descriptor's is frozen and
                  // shared, and a record's fields are its own.
                  value: structuredClone(descriptor.defaultValue),
                },
              ]
            : []
      );
      return defaulted.length > 0 ? [[table, defaulted] as const] : [];
    })
  );

/**
 * `fields` with each of `defaulted` it lacks filled in with its default;
 * the same object when it lacks none.
 */
export const filledIn = (
  fields: StoreFields,
  defaulted: readonly DefaultedField[] | undefined
): StoreFields => {
  const missing = (defaulted ?? []).filter(
    ({ field }) => !Object.hasOwn(fields, field)
  );
  if (missing.length === 0) {
    return fields;
  }
  return {
    ...fields,
    ...Object.fromEntries(
      missing.map(({ field, value }) => [field, structuredClone(value)])
    ),
  };
};
