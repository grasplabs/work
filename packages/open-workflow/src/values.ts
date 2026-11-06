import { taskIdOf } from "./checker.ts";
import type { Checker, Site, Where } from "./checker.ts";
import { pointerJoin } from "./diagnostics.ts";
import { isObject } from "./json-text.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";

/** Where a site is, at `pointer`. */
export const at = (site: Site, pointer: string): Where => ({
  pointer,
  taskId: taskIdOf(site),
});

/** A site outside every task: the workflow's own level. */
export const workflowSite: Site = { scope: [] };

/** Checks an object's keys against those the profile allows there. */
export const allowKeys = (
  checker: Checker,
  object: JsonObject,
  allowed: readonly string[],
  pointer: string,
  site: Site
): void => {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      checker.report.error(
        "profile.unknown_property",
        at(site, pointerJoin(pointer, key)),
        `Remove it; allowed here: ${allowed.join(", ")}.`
      );
    }
  }
};

/** Requires `key` in `object`; whether it is there. */
export const requireKey = (
  checker: Checker,
  object: JsonObject,
  key: string,
  pointer: string,
  site: Site
): boolean => {
  if (Object.hasOwn(object, key)) {
    return true;
  }
  checker.report.error(
    "profile.missing_property",
    at(site, pointerJoin(pointer, key)),
    `Add ${key}.`
  );
  return false;
};

/** An object where the profile needs one; reports and returns undefined. */
export const objectAt = (
  checker: Checker,
  value: JsonValue | undefined,
  pointer: string,
  site: Site,
  what: string
): JsonObject | undefined => {
  if (isObject(value)) {
    return value;
  }
  checker.report.error(
    "profile.invalid_value",
    at(site, pointer),
    `Write ${what} as an object.`,
    {
      expected: "object",
    }
  );
  return undefined;
};
