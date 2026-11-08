import { AppDefinitionError } from "./app-definition-error.ts";
import { refuser } from "./declaration.ts";
import { descriptorOf } from "./sealed-descriptors.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

const refuse: (message: string) => never = refuser(AppDefinitionError);

/** The App's preferences' descriptor, or null: a strict required object. */
export const preferencesOf = (preferences: unknown): ValueDescriptor | null => {
  if (preferences === undefined) {
    return null;
  }
  // Throws for anything but a `v` schema.
  const descriptor = descriptorOf(preferences);
  if (
    descriptor.kind !== "object" ||
    descriptor.nullable ||
    descriptor.presence !== "required"
  ) {
    return refuse("An App's `preferences` is a required `v.object`.");
  }
  // Every field has a default: a person who never chose answers them, and
  // a patch leaves out what it doesn't change. `_rev` is what the host
  // answers beside them, and `_` names are the platform's.
  for (const [name, field] of Object.entries(descriptor.fields)) {
    if (name.startsWith("_")) {
      return refuse(
        `An App's preference \`${name}\` starts with \`_\`, which is the platform's.`
      );
    }
    if (field.presence !== "default") {
      return refuse(
        `An App's preference \`${name}\` needs a \`.default(…)\`: every preference has one.`
      );
    }
  }
  return descriptor;
};
