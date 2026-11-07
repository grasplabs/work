import { parse } from "@babel/parser";
import { traverseFast } from "@babel/types";
import type { Node } from "@babel/types";

// Which of an App's queries read each of its indexes, and which pages call
// those queries, read from the App's code as Babel parses it: a query
// orders a table along an index with `ctx.db.query(table).withIndex(name)`
// and searches one with `ctx.db.search(table, text)`, and a page reaches a
// query as `api.<file>.<name>`. What the code says in other ways (a name
// built at run time) isn't found, so a use found is certain and none found
// means none that the code spells out.

/** An index a function of the App's reads: by name, or the table's search (`index` null). */
export interface IndexUse {
  readonly table: string;
  readonly index: string | null;
  /** The function, as pages call it: `deals.list` for `server/deals.ts`'s `list`. */
  readonly query: string;
  /** The routes of the pages that call it, as their paths: `/pipeline`. */
  readonly pages: readonly string[];
}

/** A file's syntax, or none when it doesn't parse. */
const syntaxOf = (source: string): Node | undefined => {
  try {
    return parse(source, {
      sourceType: "module",
      plugins: ["typescript", "jsx"],
      errorRecovery: true,
    });
  } catch {
    return undefined;
  }
};

/** A string literal's value; undefined for anything else. */
const literalOf = (node: Node | undefined): string | undefined =>
  node?.type === "StringLiteral" ? node.value : undefined;

/** The table a query chain starts from: `query("deals")` under `.withIndex`. */
const tableUnder = (node: Node): string | undefined => {
  let current: Node = node;
  while (current.type === "CallExpression") {
    const { callee } = current;
    if (callee.type !== "MemberExpression") {
      return undefined;
    }
    if (
      callee.property.type === "Identifier" &&
      callee.property.name === "query"
    ) {
      return literalOf(current.arguments[0]);
    }
    current = callee.object;
  }
  return undefined;
};

/** The index a call reads, if it reads one: a `withIndex` or a `search`. */
const indexRead = (
  node: Node
): { table: string; index: string | null } | undefined => {
  if (
    node.type !== "CallExpression" ||
    node.callee.type !== "MemberExpression" ||
    node.callee.property.type !== "Identifier"
  ) {
    return undefined;
  }
  const method = node.callee.property.name;
  if (method === "withIndex") {
    const index = literalOf(node.arguments[0]);
    const table = tableUnder(node.callee.object);
    return index === undefined || table === undefined
      ? undefined
      : { table, index };
  }
  if (method === "search") {
    const table = literalOf(node.arguments[0]);
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

/** The indexes each exported function of a server file reads. */
const usesIn = (
  path: string,
  syntax: Node
): { table: string; index: string | null; query: string }[] => {
  const found: { table: string; index: string | null; query: string }[] = [];
  if (syntax.type !== "File") {
    return found;
  }
  for (const statement of syntax.program.body) {
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration?.type === "VariableDeclaration"
    ) {
      for (const declarator of statement.declaration.declarations) {
        if (declarator.id.type === "Identifier") {
          const query = `${moduleOf(path)}.${declarator.id.name}`;
          traverseFast(declarator.init, (node) => {
            const read = indexRead(node);
            if (read !== undefined) {
              found.push({ ...read, query });
            }
          });
        }
      }
    }
  }
  return found;
};

/** `src/routes/tasks.$taskId.tsx` as its route's path: `/tasks/$taskId`. */
const routeOf = (path: string): string => {
  const name = path
    .slice("src/routes/".length)
    .replace(/\.tsx?$/u, "")
    .replaceAll(".", "/");
  const trimmed = name.replace(/(?:^|\/)index$/u, "");
  return `/${trimmed}`;
};

/** The functions a page calls, as `api.deals.list` names them: `deals.list`. */
const callsIn = (syntax: Node): Set<string> => {
  const called = new Set<string>();
  traverseFast(syntax, (node) => {
    if (
      node.type !== "MemberExpression" ||
      node.property.type !== "Identifier"
    ) {
      return;
    }
    const parts: string[] = [node.property.name];
    let object: Node = node.object;
    while (
      object.type === "MemberExpression" &&
      object.property.type === "Identifier"
    ) {
      parts.unshift(object.property.name);
      ({ object } = object);
    }
    if (object.type === "Identifier" && object.name === "api") {
      called.add(parts.join("."));
    }
  });
  return called;
};

/**
 * Which index each of the App's functions reads, by table, and the pages
 * that call that function, from the App's files (path to text).
 */
export const indexUsesOf = (files: ReadonlyMap<string, string>): IndexUse[] => {
  const pages: { route: string; calls: Set<string> }[] = [];
  const reads: { table: string; index: string | null; query: string }[] = [];
  for (const [path, source] of files) {
    const isServer = path.startsWith("server/") && !path.includes("_generated");
    const isRoute = path.startsWith("src/routes/") && /\.tsx?$/u.test(path);
    if ((isServer && path.endsWith(".ts")) || isRoute) {
      const syntax = syntaxOf(source);
      if (syntax !== undefined) {
        if (isServer) {
          reads.push(...usesIn(path, syntax));
        } else if (!path.endsWith("__root.tsx")) {
          pages.push({ route: routeOf(path), calls: callsIn(syntax) });
        }
      }
    }
  }
  const seen = new Set<string>();
  return reads.flatMap((read) => {
    const key = JSON.stringify([read.table, read.index, read.query]);
    if (seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [
      {
        ...read,
        pages: pages
          .filter(({ calls }) => calls.has(read.query))
          .map(({ route }) => route)
          .toSorted(),
      },
    ];
  });
};
