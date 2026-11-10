import { appMaxOperations } from "@grasp-os/shared/function-limits";

import type { ServerFunctions } from "./codegen-api.ts";
import { definitionManifest, isFunctionPath } from "./definition.ts";
import type { AppDefinition } from "./definition.ts";
import { generateServerModules } from "./generate.ts";
import { parseProgram } from "./oxc-parse.ts";

// The functions an App's server modules declare, read from their syntax
// alone (oxc's parser in the host's own isolate, oxc-parse.ts), never by
// running them: what `server/_generated/` is generated from
// (generate.ts), so the host makes it again on every save, the same
// bytes for the same files and definition. A function is declared as
// `export const name = query({ … })`, with one of the six builders of
// `@server/_generated/server` called by name; its builder says whether
// it is public or internal. One registered any other way (an alias of a
// builder, a wrapper, a re-export) isn't read here, and a seal refuses it
// by name (core's app-releases.ts).

/** Each builder a function is declared with, and the visibility it gives. */
const builders: ReadonlyMap<string, "public" | "internal"> = new Map([
  ["query", "public"],
  ["mutation", "public"],
  ["action", "public"],
  ["internalQuery", "internal"],
  ["internalMutation", "internal"],
  ["internalAction", "internal"],
]);

/** Names a reference answers itself, which no function registers at. */
const referenceKeys: ReadonlySet<string> = new Set(["name", "then"]);

/** A syntax node, as far as this reads one. */
interface Node {
  readonly type: string;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "type") === "string";

/** `node`'s child under `key`, if it is a node. */
const child = (node: Node, key: string): Node | undefined => {
  const value = node[key];
  return isNode(value) ? value : undefined;
};

/** `node`'s children under `key`, the nodes among them. */
const children = (node: Node, key: string): Node[] => {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

/** An identifier's name; undefined for anything else. */
const nameOf = (node: Node | undefined): string | undefined =>
  node?.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;

/** TypeScript's wrappers of an expression, which change no value. */
const typeWrappers: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
]);

/** `node` without the type wrappers around it (`query(…) satisfies T`). */
const unwrapped = (node: Node | undefined): Node | undefined => {
  let current = node;
  while (current !== undefined && typeWrappers.has(current.type)) {
    current = child(current, "expression");
  }
  return current;
};

/** The functions one statement declares: `export const name = builder(…)`. */
const declaredBy = (statement: Node): [string, "public" | "internal"][] => {
  const declaration = child(statement, "declaration");
  if (
    statement.type !== "ExportNamedDeclaration" ||
    declaration?.type !== "VariableDeclaration" ||
    declaration.declare === true
  ) {
    return [];
  }
  return children(declaration, "declarations").flatMap((declarator) => {
    const name = nameOf(child(declarator, "id"));
    const init = unwrapped(child(declarator, "init"));
    const builder =
      init?.type === "CallExpression"
        ? nameOf(child(init, "callee"))
        : undefined;
    const visibility =
      builder === undefined ? undefined : builders.get(builder);
    return name === undefined || visibility === undefined
      ? []
      : [[name, visibility]];
  });
};

/**
 * The functions the TypeScript module `source` declares, each export's
 * visibility by its name; undefined when it doesn't parse.
 */
export const declaredFunctionsOf = (
  source: string
): Map<string, "public" | "internal"> | undefined => {
  let program: unknown;
  try {
    ({ program } = parseProgram(source, "ts"));
  } catch {
    // What doesn't parse, or runs the parser out of memory or stack.
    return undefined;
  }
  return isNode(program)
    ? new Map(children(program, "body").flatMap(declaredBy))
    : undefined;
};

/**
 * The functions an App's server modules declare (`modules`: each one's
 * source by its path under `server/` without `.ts`, `crm/deals`), each
 * one's visibility by its path (`crm.deals.list`): only paths a function
 * can have (`isFunctionPath`), and at most as many as an App may register
 * (`appMaxOperations`). A module that doesn't parse declares none here:
 * such code is never sealed.
 */
export const serverFunctionsOf = (
  modules: Readonly<Record<string, string>>
): ServerFunctions => {
  const functions: Record<string, "public" | "internal"> = {};
  // In path order, each module's in its own: so the most an App may have
  // (`appMaxOperations`) are the same ones whatever order they come in.
  const ordered = Object.entries(modules).toSorted(([a], [b]) =>
    a < b ? -1 : 1
  );
  for (const [module, source] of ordered) {
    const prefix = module.replaceAll("/", ".");
    for (const [name, visibility] of declaredFunctionsOf(source) ?? []) {
      const path = `${prefix}.${name}`;
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
 * `server/_generated/`, by path, as the App's server modules (`modules`,
 * as `serverFunctionsOf` takes them) and its `definition` generate it:
 * the same bytes for the same files and definition, whatever ran or was
 * sealed before.
 */
export const generatedServerSources = (
  modules: Readonly<Record<string, string>>,
  definition: AppDefinition
): Record<string, string> =>
  generateServerModules(
    serverFunctionsOf(modules),
    definitionManifest(definition)
  );
