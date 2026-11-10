import { appLimits } from "@grasp-os/shared/app-limits";
import { appMaxOperations } from "@grasp-os/shared/function-limits";

import { canRegisterAt } from "./app-functions.ts";
import type { ServerFunctions } from "./codegen-api.ts";
import { definitionManifest, isFunctionPath } from "./definition.ts";
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
    // What doesn't parse, or runs the parser out of its memory or stack,
    // declares nothing, every time. Anything else (no memory for an
    // instance at all) says nothing of the source: the write fails.
    if (
      !(
        error instanceof SyntaxError ||
        error instanceof WebAssembly.RuntimeError
      )
    ) {
      throw error;
    }
    declared = new Map();
  }
  parsed.set(source, declared);
  parsedLength += source.length;
  for (const oldest of parsed.keys()) {
    if (parsedLength <= parsedMaxLength) {
      break;
    }
    parsed.delete(oldest);
    parsedLength -= oldest.length;
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
  const functions: Record<string, "public" | "internal"> = {};
  const modules = Object.entries(serverModulesOf(files)).toSorted(([a], [b]) =>
    a < b ? -1 : 1
  );
  for (const [module, source] of modules) {
    for (const [name, { visibility }] of declaredFunctionsOf(source)) {
      const path = `${module.replaceAll("/", ".")}.${name}`;
      // Never a folder named with a dot, which would make another
      // function's path, nor a path registration refuses
      // (app-functions.ts).
      if (
        isFunctionPath(path) &&
        !module.includes(".") &&
        canRegisterAt(path.split("."))
      ) {
        functions[path] = visibility;
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
