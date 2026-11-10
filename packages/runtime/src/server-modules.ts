import { appPathSegmentPattern } from "@grasp-os/shared/app-limits";

import { generatedServerFolder } from "./codegen-contracts.ts";
import type { FunctionKind, Visibility } from "./server-function.ts";

// An App's server modules and the functions their syntax declares, read
// from a syntax tree alone (ESTree, as oxc's parser gives it), never by
// running the code: one reader for whoever reads them, the host as it
// generates `server/_generated/` on every save (server-syntax.ts) and the
// App compiler as it lists the functions a commit gives stable IDs
// (its index-uses.ts). A function is declared as
// `export const name = query({ … })`, with one of the six builders of
// `@server/_generated/server` called by name (`builders`), its call
// perhaps wrapped in parentheses or a type (`satisfies`, `as`, `!`). One
// registered any other way (an alias of a builder, a wrapper, a
// re-export) isn't read here, and a seal refuses it by name (core's
// app-releases.ts).

/** Where an App's schema is: generated from its definition, no module of functions. */
const schemaPath = "server/schema.ts";

/** Where an App's migrations are. */
export const migrationsFolder = "server/migrations/";

/**
 * The module of the App's server code at `path`, as its functions' paths
 * name it (`crm/deals` for `server/crm/deals.ts`): a `.ts` file anywhere
 * under `server/` but its schema, `server/_generated/` and its
 * migrations, each folder and file named as an App's path may be (dots,
 * but never leading); undefined for any other path.
 */
export const serverModuleOf = (path: string): string | undefined => {
  const isModule =
    path.startsWith("server/") &&
    path !== schemaPath &&
    !path.startsWith(generatedServerFolder) &&
    !path.startsWith(migrationsFolder) &&
    path.endsWith(".ts") &&
    !path.endsWith(".d.ts") &&
    path.split("/").every((segment) => appPathSegmentPattern.test(segment));
  return isModule ? path.slice("server/".length, -".ts".length) : undefined;
};

/** The App's server modules among `files`, each one's source by its module (`serverModuleOf`). */
export const serverModulesOf = (
  files: Readonly<Record<string, string>>
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(files).flatMap(([path, source]) => {
      const module = serverModuleOf(path);
      return module === undefined ? [] : [[module, source]];
    })
  );

/** What a builder declares: a function of this kind and visibility. */
export interface Declared {
  readonly kind: FunctionKind;
  readonly visibility: Visibility;
}

/** Each builder's name, by the visibility and kind of what it declares. */
export const builderNames = {
  public: { query: "query", mutation: "mutation", action: "action" },
  internal: {
    query: "internalQuery",
    mutation: "internalMutation",
    action: "internalAction",
  },
} as const;

/** What each builder, by name, declares. */
const builders: ReadonlyMap<string, Declared> = new Map(
  (["public", "internal"] as const).flatMap((visibility) =>
    (["query", "mutation", "action"] as const).map(
      (kind) => [builderNames[visibility][kind], { kind, visibility }] as const
    )
  )
);

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

/** The wrappers of an expression that change no value. */
const valueWrappers: ReadonlySet<string> = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

/** `node` without the wrappers around it (`query(…) satisfies T`). */
const unwrapped = (node: Node | undefined): Node | undefined => {
  let current = node;
  while (current !== undefined && valueWrappers.has(current.type)) {
    current = child(current, "expression");
  }
  return current;
};

/** The functions one statement declares: `export const name = builder(…)`. */
const declaredBy = (statement: Node): [string, Declared][] => {
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
    const declared = builder === undefined ? undefined : builders.get(builder);
    return name === undefined || declared === undefined
      ? []
      : [[name, declared]];
  });
};

/**
 * The functions the module whose syntax tree is `program` declares, each
 * by its export's name, in the source's order; none of what isn't a
 * program.
 */
export const declaredFunctionsIn = (program: unknown): Map<string, Declared> =>
  isNode(program)
    ? new Map(children(program, "body").flatMap(declaredBy))
    : new Map<string, Declared>();
