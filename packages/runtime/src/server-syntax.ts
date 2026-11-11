import { appLimits } from "@grasp-os/shared/app-limits";
import { appMaxOperations } from "@grasp-os/shared/function-limits";

import { canRegisterAt } from "./app-functions.ts";
import type { AppManifest } from "./app-types.ts";
import type { ServerFunctions } from "./codegen-api.ts";
import { definitionManifest } from "./definition.ts";
import type { AppDefinition } from "./definition.ts";
import { generateServerModules } from "./generate.ts";
import { parseProgram } from "./oxc-parse.ts";
import { declaredFunctionsIn, serverModulesOf } from "./server-modules.ts";
import type { Declared } from "./server-modules.ts";

// The functions an App's server modules declare (server-modules.ts),
// parsed in the host's own isolate (oxc-parse.ts): what
// `server/_generated/` is generated from (generate.ts), so the host makes
// it again on every save, the same bytes for the same files and
// definition.

/** The most characters of module sources whose functions are kept: one App's. */
const parsedMaxLength = appLimits.totalLength;

/**
 * The functions of each module source read lately, by its text, the most
 * lately used last: a save reads the same modules for its references, its
 * check and its preview, and a module that doesn't change is never parsed
 * again.
 */
const parsed = new Map<string, ReadonlyMap<string, Declared>>();

/** The characters of `parsed`'s sources together. */
let parsedLength = 0;

/** What an entry of `parsed` weighs beside its source: its map and slot. */
const entryWeight = 256;

/** The functions the TypeScript module `source` declares; none of one that doesn't parse. */
const declaredFunctionsOf = (source: string): ReadonlyMap<string, Declared> => {
  const kept = parsed.get(source);
  if (kept !== undefined) {
    parsed.delete(source);
    parsed.set(source, kept);
    return kept;
  }
  let declared: ReadonlyMap<string, Declared>;
  try {
    declared = declaredFunctionsIn(parseProgram(source, "ts").program);
  } catch (error) {
    // What doesn't parse, or runs the parser out of its memory, declares
    // nothing, every time. Anything else (the host's stack, nested too
    // deep for where the call runs; no memory for an instance) declares
    // nothing now, kept for no later read: a seal refuses what that
    // hides (`undeclaredFunctions`).
    if (
      !(
        error instanceof SyntaxError ||
        error instanceof WebAssembly.RuntimeError
      )
    ) {
      return new Map();
    }
    declared = new Map();
  }
  parsed.set(source, declared);
  parsedLength += source.length + entryWeight;
  for (const oldest of parsed.keys()) {
    if (parsedLength <= parsedMaxLength) {
      break;
    }
    parsed.delete(oldest);
    parsedLength -= oldest.length + entryWeight;
  }
  return declared;
};

/**
 * The functions `files`' server modules declare, each one's visibility by
 * its path (`crm.deals.list` for `server/crm/deals.ts`'s `list`): only
 * paths a function can have (`isFunctionPath`), and at most as many as an
 * App may register (`appMaxOperations`), in path order. A module that
 * doesn't parse declares none here: such code is never sealed.
 */
export const serverFunctionsIn = (
  files: Readonly<Record<string, string>>
): ServerFunctions => {
  const functions: Record<string, Declared> = {};
  const modules = Object.entries(serverModulesOf(files)).toSorted(([a], [b]) =>
    a < b ? -1 : 1
  );
  for (const [module, source] of modules) {
    for (const [name, declared] of declaredFunctionsOf(source)) {
      const path = `${module.replaceAll("/", ".")}.${name}`;
      // Never a folder named with a dot, which would make another
      // function's path, nor a path registration refuses
      // (app-functions.ts).
      if (!module.includes(".") && canRegisterAt(path.split("."))) {
        functions[path] = declared;
      }
      // No more than an App may register: what is generated stays bounded
      // whatever the code declares, and a seal refuses the App anyway.
      if (Object.keys(functions).length >= appMaxOperations) {
        return functions;
      }
    }
  }
  return functions;
};

/**
 * `server/_generated/`, by path, as `files`' server modules and
 * `definition` generate it: the same bytes for the same files and
 * definition, whatever ran or was sealed before.
 */
export const generatedServerSources = (
  files: Readonly<Record<string, string>>,
  definition: AppDefinition
): Record<string, string> =>
  generateServerModules(
    serverFunctionsIn(files),
    definitionManifest(definition)
  );

/**
 * The paths of the functions where `manifest`, what the code registers,
 * and `functions`, what its syntax declares, disagree, sorted: one
 * registered that the syntax doesn't declare (an alias of a builder, a
 * wrapper), or declares as another kind or visibility; and one declared
 * that doesn't register (a builder of the module's own). The references
 * generated from the syntax would name none of them rightly.
 */
export const undeclaredFunctions = (
  manifest: Pick<AppManifest, "operations">,
  functions: ServerFunctions
): string[] =>
  [
    ...Object.values(manifest.operations).flatMap(
      ({ path, kind, visibility }) => {
        const declared = Object.hasOwn(functions, path)
          ? functions[path]
          : undefined;
        return declared?.kind === kind && declared.visibility === visibility
          ? []
          : [path];
      }
    ),
    ...Object.keys(functions).filter(
      (path) => !Object.hasOwn(manifest.operations, path)
    ),
  ].toSorted();
