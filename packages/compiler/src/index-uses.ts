// What an App's code reads of its tables' indexes, read from its syntax
// tree (oxc's, syntax.ts) as the build compiles it: a server function
// orders a table along an index with `ctx.db.query(table).withIndex(name)`
// and searches one with `ctx.db.search(table, text)`, and a page calls a
// function as `api.<file>.<name>`. Only what the code spells out (string
// literals) is found. The Data view says from it what uses each index
// (core's app-definition.ts). The queries and mutations a server file
// exports are found the same way (`exportedFunctionsOf`).

import { child, children, walk } from "./syntax.ts";
import type { Node, Parsed } from "./syntax.ts";

/** An index a server function reads: by name, or its table's search (`index` null). */
export interface IndexRead {
  table: string;
  index: string | null;
  /** The function, as pages call it: `deals.list` for `server/deals.ts`'s `list`. */
  query: string;
}

/** A string literal's value; undefined for anything else. */
const literalOf = (node: Node | undefined): string | undefined =>
  node?.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;

/** An identifier's name; undefined for anything else. */
const nameOf = (node: Node | undefined): string | undefined =>
  node?.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;

/** The table a query chain starts from: `query("deals")` under `.withIndex`. */
const tableUnder = (start: Node | undefined): string | undefined => {
  let current = start;
  while (current?.type === "CallExpression") {
    const callee = child(current, "callee");
    if (callee?.type !== "MemberExpression") {
      return undefined;
    }
    if (nameOf(child(callee, "property")) === "query") {
      return literalOf(children(current, "arguments")[0]);
    }
    current = child(callee, "object");
  }
  return undefined;
};

/** The index a call reads, if it reads one: a `withIndex` or a `search`. */
const indexRead = (
  call: Node
): { table: string; index: string | null } | undefined => {
  const callee = child(call, "callee");
  if (callee?.type !== "MemberExpression") {
    return undefined;
  }
  const method = nameOf(child(callee, "property"));
  const [first] = children(call, "arguments");
  if (method === "withIndex") {
    const index = literalOf(first);
    const table = tableUnder(child(callee, "object"));
    return index === undefined || table === undefined
      ? undefined
      : { table, index };
  }
  if (method === "search") {
    const table = literalOf(first);
    return table === undefined ? undefined : { table, index: null };
  }
  return undefined;
};

/** `server/deals/open.ts` as pages reach it: `deals.open`. */
const moduleOf = (path: string): string =>
  path
    .slice("server/".length)
    .replace(/\.tsx?$/u, "")
    .replaceAll("/", ".");

/**
 * The indexes each exported function (`export const name = …`) of the
 * server file `path` reads, in the order its source reads them; none of a
 * file that doesn't parse.
 */
export const indexReadsOf = (
  path: string,
  tree: Parsed | undefined
): IndexRead[] =>
  children(tree?.program, "body").flatMap((statement) => {
    const declaration = child(statement, "declaration");
    if (
      statement.type !== "ExportNamedDeclaration" ||
      declaration?.type !== "VariableDeclaration"
    ) {
      return [];
    }
    return children(declaration, "declarations").flatMap((declarator) => {
      const name = nameOf(child(declarator, "id"));
      if (name === undefined) {
        return [];
      }
      const query = `${moduleOf(path)}.${name}`;
      const reads: IndexRead[] = [];
      walk(declarator, (node) => {
        const read =
          node.type === "CallExpression" ? indexRead(node) : undefined;
        if (read !== undefined) {
          reads.push({ ...read, query });
        }
      });
      return reads;
    });
  });

/** The builders of a public query or mutation, as server code calls them. */
const callableBuilders: ReadonlySet<string> = new Set(["query", "mutation"]);

/**
 * The public queries and mutations the server file `path` exports, as
 * pages call them (`deals.list` for `server/deals.ts`'s `list`): each
 * `export const name = query(…)` or `mutation(…)`, as the code spells it
 * out; none of a file that doesn't parse. What a commit gives a stable ID
 * a workflow calls it by (core's apps.ts); a seal keeps only those the
 * code registers.
 */
export const exportedFunctionsOf = (
  path: string,
  tree: Parsed | undefined
): string[] =>
  children(tree?.program, "body").flatMap((statement) => {
    const declaration = child(statement, "declaration");
    if (
      statement.type !== "ExportNamedDeclaration" ||
      declaration?.type !== "VariableDeclaration"
    ) {
      return [];
    }
    return children(declaration, "declarations").flatMap((declarator) => {
      const name = nameOf(child(declarator, "id"));
      const init = child(declarator, "init");
      const builder =
        init?.type === "CallExpression"
          ? nameOf(child(init, "callee"))
          : undefined;
      return name !== undefined &&
        builder !== undefined &&
        callableBuilders.has(builder)
        ? [`${moduleOf(path)}.${name}`]
        : [];
    });
  });

/**
 * The functions a page file calls through `api`, `api.deals.list` as
 * `deals.list`, each once and sorted; none of a file that doesn't parse.
 */
export const apiCallsOf = (tree: Parsed | undefined): string[] => {
  const calls = new Set<string>();
  if (tree === undefined) {
    return [];
  }
  walk(tree.program, (member, parent) => {
    // Only a whole chain, from its outermost member.
    if (
      member.type !== "MemberExpression" ||
      parent?.type === "MemberExpression"
    ) {
      return;
    }
    const parts: string[] = [];
    let current: Node | undefined = member;
    while (current?.type === "MemberExpression") {
      const part = nameOf(child(current, "property"));
      if (part === undefined) {
        return;
      }
      parts.unshift(part);
      current = child(current, "object");
    }
    if (nameOf(current) === "api" && parts.length > 0) {
      calls.add(parts.join("."));
    }
  });
  return [...calls].toSorted();
};
