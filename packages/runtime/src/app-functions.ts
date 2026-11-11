import {
  appMaxFunctions,
  functionPathMaxLength,
  functionPathMaxSegments,
  functionSegmentPattern,
} from "@grasp-os/shared/function-limits";
import { isPlainObject } from "@grasp-os/shared/json";

import { AppDefinitionError } from "./app-definition-error.ts";
import { refuser } from "./declaration.ts";
import { isServerFunction, serverFunctions } from "./handlers.ts";
import type { AnyFunction } from "./server-function.ts";

const refuse: (message: string) => never = refuser(AppDefinitionError);

/**
 * The top-level path segments the platform keeps, with what each is for:
 * `workflows` for its generated workflow references
 * (`workflows.<alias>.queries.*` and `.mutations.*`) and `people` for who calls and the
 * organization's people (people.ts), which the host answers itself. No
 * function registers under either, whether or not the App declares
 * workflows, so declaring one later never shadows or is shadowed by a
 * function.
 */
const reservedSegments: ReadonlyMap<string, string> = new Map([
  ["workflows", "the App's workflow references"],
  ["people", "the organization's people"],
]);

/**
 * Path segments no function registers at, at any depth: `name`, which a
 * reference answers as data and a reference tree can't also hold as a
 * child, and `then`, which would make a reference look like a promise to
 * whatever awaits it.
 */
const referenceKeys: ReadonlySet<string> = new Set(["name", "then"]);

/**
 * Why `segments` can't be a function's path, `where` naming the module or
 * export: past the bounds of a path, holding a segment that isn't an
 * identifier or that a reference answers itself, or starting at a segment
 * the platform keeps; undefined when it can be one.
 */
const pathProblem = (
  segments: readonly string[],
  where: string
): string | undefined => {
  const path = segments.join(".");
  const named = segments.every((segment) =>
    functionSegmentPattern.test(segment)
  );
  if (
    !named ||
    segments.length > functionPathMaxSegments ||
    path.length > functionPathMaxLength
  ) {
    return `${where} doesn't make a function path of up to ${functionPathMaxSegments} identifiers (letters, digits and _, not starting with a digit), each folder and file name included${named ? `: \`${path}\`` : ""}.`;
  }
  const answered = segments.find((segment) => referenceKeys.has(segment));
  if (answered !== undefined) {
    return `${where} can't be a function's path: \`${answered}\` is a name a reference itself answers.`;
  }
  const reservedFor = reservedSegments.get(segments[0] ?? "");
  if (reservedFor !== undefined) {
    return `${where} can't be a function's path: \`${segments[0] ?? ""}\` is the platform's, for ${reservedFor}.`;
  }
  return undefined;
};

/** Whether a function can register at `segments` (`pathProblem`). */
export const canRegisterAt = (segments: readonly string[]): boolean =>
  pathProblem(segments, "") === undefined;

/** `segments` as a function's path, refused where it can't be one (`pathProblem`). */
const checkPath = (segments: readonly string[], where: string): string => {
  const problem = pathProblem(segments, where);
  if (problem !== undefined) {
    refuse(problem);
  }
  return segments.join(".");
};

/**
 * The server functions `modules` export, by path (each module's path
 * under `server/`, then the export's name), each export read once.
 * Exports that aren't server functions are passed over.
 */
export const exportedFunctions = (modules: unknown): Map<string, unknown> => {
  if (!isPlainObject(modules)) {
    return refuse("An App's server modules are a map of module namespaces.");
  }
  const found = new Map<string, unknown>();
  for (const module of Object.keys(modules).toSorted()) {
    const where = `server/${module}.ts`;
    const namespace: unknown = modules[module];
    if (typeof namespace !== "object" || namespace === null) {
      refuse(`${where} isn't a module.`);
    }
    const segments = module.split("/");
    for (const name of Object.keys(namespace).toSorted()) {
      // Read once: what registers is what this read answered, whatever a
      // getter (a bundler's namespace has them) would answer later.
      const value: unknown = Reflect.get(namespace, name);
      if (!isServerFunction(value)) {
        continue;
      }
      found.set(
        checkPath([...segments, name], `\`${name}\` of ${where}`),
        value
      );
      if (found.size > appMaxFunctions) {
        refuse(`An App has at most ${appMaxFunctions} functions.`);
      }
    }
  }
  // A function's path is a reference's place in `api`: never also a
  // folder of others' (`server/notes.ts`'s `get` beside
  // `server/notes/get.ts`).
  const sorted = [...found.keys()].toSorted();
  for (const [index, path] of sorted.entries()) {
    const next = sorted[index + 1];
    if (next?.startsWith(`${path}.`) === true) {
      refuse(
        `\`${path}\` clashes with another registered path, \`${next}\`: rename the module or the export.`
      );
    }
  }
  return found;
};

/**
 * The functions `found` holds, by path: every one declared for `schema`,
 * exported at one path only.
 */
export const registeredFunctions = (
  schema: unknown,
  found: ReadonlyMap<string, unknown>
): Map<string, AnyFunction> => {
  const functions = new Map<string, AnyFunction>();
  const paths = new Map<unknown, string>();
  for (const [path, value] of found) {
    if (!isServerFunction(value)) {
      continue;
    }
    const known = paths.get(value);
    if (known !== undefined) {
      refuse(
        `One function is exported twice, as \`${known}\` and \`${path}\`: export it from one module only.`
      );
    }
    if (serverFunctions.of(value)?.schema !== schema) {
      refuse(
        `\`${path}\` was declared for another schema than the App's: declare it with the builders of server/_generated/server.`
      );
    }
    functions.set(path, value);
    paths.set(value, path);
  }
  return functions;
};
