// What an App's code reads of its tables' indexes, collected as the build
// compiles it, in the same parse: a server function orders a table along
// an index with `ctx.db.query(table).withIndex(name)` and searches one
// with `ctx.db.search(table, text)`, and a page calls a function as
// `api.<file>.<name>`. Only what the code spells out (string literals) is
// found. The Data view says from it what uses each index (core's
// app-definition.ts).

/** An index a server function reads: by name, or its table's search (`index` null). */
export interface IndexRead {
  table: string;
  index: string | null;
  /** The function, as pages call it: `deals.list` for `server/deals.ts`'s `list`. */
  query: string;
}

/** The parts of a Babel node these plugins read. */
interface Node {
  type: string;
  value?: unknown;
  name?: unknown;
  callee?: Node;
  object?: Node;
  property?: Node;
  arguments?: Node[];
  id?: Node;
}

/** The parts of a Babel path these plugins read. */
interface Path {
  node: Node;
  parentPath?: { node: Node; parentPath?: { node: Node } | null } | null;
  traverse: (visitor: Record<string, (inner: Path) => void>) => void;
}

/** A string literal's value; undefined for anything else. */
const literalOf = (node: Node | undefined): string | undefined =>
  node?.type === "StringLiteral" && typeof node.value === "string"
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
    const { callee } = current;
    if (callee?.type !== "MemberExpression") {
      return undefined;
    }
    if (nameOf(callee.property) === "query") {
      return literalOf(current.arguments?.[0]);
    }
    current = callee.object;
  }
  return undefined;
};

/** The index a call reads, if it reads one: a `withIndex` or a `search`. */
const indexRead = (
  call: Node
): { table: string; index: string | null } | undefined => {
  const { callee } = call;
  if (callee?.type !== "MemberExpression") {
    return undefined;
  }
  const method = nameOf(callee.property);
  if (method === "withIndex") {
    const index = literalOf(call.arguments?.[0]);
    const table = tableUnder(callee.object);
    return index === undefined || table === undefined
      ? undefined
      : { table, index };
  }
  if (method === "search") {
    const table = literalOf(call.arguments?.[0]);
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
 * A Babel plugin that lists into `reads` the indexes each exported
 * function of the server file `path` reads.
 */
export const collectIndexReads = (path: string, reads: IndexRead[]) => () => ({
  visitor: {
    VariableDeclarator: (declarator: Path) => {
      const exported =
        declarator.parentPath?.parentPath?.node.type ===
        "ExportNamedDeclaration";
      const name = nameOf(declarator.node.id);
      if (!exported || name === undefined) {
        return;
      }
      const query = `${moduleOf(path)}.${name}`;
      declarator.traverse({
        CallExpression: (call) => {
          const read = indexRead(call.node);
          if (read !== undefined) {
            reads.push({ ...read, query });
          }
        },
      });
    },
  },
});

/** A Babel plugin that lists into `calls` the functions a page calls: `api.deals.list` as `deals.list`. */
export const collectApiCalls = (calls: Set<string>) => () => ({
  visitor: {
    MemberExpression: (member: Path) => {
      // Only a whole chain, from its outermost member.
      if (member.parentPath?.node.type === "MemberExpression") {
        return;
      }
      const parts: string[] = [];
      let current: Node | undefined = member.node;
      while (current?.type === "MemberExpression") {
        const part = nameOf(current.property);
        if (part === undefined) {
          return;
        }
        parts.unshift(part);
        current = current.object;
      }
      if (nameOf(current) === "api" && parts.length > 0) {
        calls.add(parts.join("."));
      }
    },
  },
});
