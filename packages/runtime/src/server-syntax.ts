import { appMaxOperations } from "@grasp-os/shared/function-limits";

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

/** Names a reference answers itself, which no function registers at. */
const referenceKeys: ReadonlySet<string> = new Set(["name", "then"]);

/** The most module sources whose functions are kept, parsed once each. */
const parsedMax = 32;

/**
 * The functions of each module source parsed lately, by its text: a save
 * reads the same modules for its references, its check and its preview,
 * and a module that doesn't change is never parsed again.
 */
const parsed = new Map<string, ReadonlyMap<string, Declared>>();

/** The functions the TypeScript module `source` declares; none of one that doesn't parse. */
const declaredFunctionsOf = (source: string): ReadonlyMap<string, Declared> => {
  const kept = parsed.get(source);
  if (kept !== undefined) {
    return kept;
  }
  let declared: ReadonlyMap<string, Declared>;
  try {
    declared = declaredFunctionsIn(parseProgram(source, "ts").program);
  } catch {
    // What doesn't parse, or runs the parser out of memory or stack.
    declared = new Map();
  }
  parsed.set(source, declared);
  if (parsed.size > parsedMax) {
    const [oldest] = parsed.keys();
    if (oldest !== undefined) {
      parsed.delete(oldest);
    }
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
      // function's path, nor a name a reference answers itself, which
      // registration refuses (app-functions.ts).
      if (
        isFunctionPath(path) &&
        !module.includes(".") &&
        !path.split(".").some((segment) => referenceKeys.has(segment))
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
