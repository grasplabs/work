import type { StandardSchemaV1 } from "@standard-schema/spec";

import { issuePathKey } from "./client-error.ts";

// Validation issues as a form shows them: by the field each one names, as
// TanStack Form names fields, and the rest at the form's level.

/**
 * An issue's path as TanStack names the field: `items[0].name`, array
 * indexes in brackets, keys after dots.
 */
const fieldName = (path: StandardSchemaV1.Issue["path"]): string => {
  let name = "";
  for (const segment of path ?? []) {
    const key = issuePathKey(segment);
    if (typeof key === "number") {
      name += `[${key}]`;
    } else {
      name += name === "" ? String(key) : `.${String(key)}`;
    }
  }
  return name;
};

/** The form's own field a TanStack field name lies in: `items` of `items[0].name`. */
const rootField = (name: string): string => name.split(/[.[]/u)[0] ?? "";

/** TanStack's form-level error for `issues`: field errors and the rest. */
export const errorsOf = (
  issues: readonly StandardSchemaV1.Issue[],
  editable: (field: string) => boolean
): { form?: string; fields: Record<string, string> } | undefined => {
  if (issues.length === 0) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  const rest: string[] = [];
  for (const issue of issues) {
    const name = fieldName(issue.path);
    if (name !== "" && editable(rootField(name))) {
      fields[name] ??= issue.message;
    } else {
      rest.push(issue.message);
    }
  }
  return rest.length === 0 ? { fields } : { form: rest.join(" "), fields };
};
