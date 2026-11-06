/**
 * An App file's syntax tree as oxc's parser gives it (oxc.ts `parse`):
 * TS-ESTree, with each node's offsets in UTF-16 code units, for what reads
 * a file's syntax without compiling it (route-tree.ts, stand-ins.ts).
 */
import { oxc } from "./oxc.ts";

/** A node, as far as a reader reads one: its type, offsets and fields. */
export type Node = Readonly<Record<string, unknown>> & {
  readonly type: string;
  readonly start: number;
  readonly end: number;
};

export const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "type") === "string" &&
  typeof Reflect.get(value, "start") === "number";

/** `node`'s child under `key`, if it is a node. */
export const child = (
  node: Node | undefined,
  key: string
): Node | undefined => {
  const value = node?.[key];
  return isNode(value) ? value : undefined;
};

/** `node`'s children under `key`, the nodes among them. */
export const children = (node: Node | undefined, key: string): Node[] => {
  const value = node?.[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
};

/** Each node under `node`, in the source's order, with its parent and the key it is under. */
export const walk = (
  node: Node,
  visit: (node: Node, parent: Node | undefined, key: string) => void
): void => {
  const pending: [Node, Node | undefined, string][] = [[node, undefined, ""]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [current, parent, key] = next;
    visit(current, parent, key);
    const inner: [Node, Node, string][] = [];
    for (const [name, value] of Object.entries(current)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (isNode(item)) {
          inner.push([item, current, name]);
        }
      }
    }
    // Last first onto the stack: nodes are visited in the source's order.
    pending.push(...inner.toReversed());
  }
};

/** What ends a line, as JavaScript counts lines. */
const lineBreak = /\r\n?|[\n\u2028\u2029]/gu;

/** A file's program, and where an offset of it is: a 1-based line and column. */
export interface Parsed {
  readonly program: Node;
  readonly at: (offset: number) => { line: number; column: number };
}

/**
 * `source` (`path`, which picks the language) parsed; undefined when it
 * doesn't parse, or oxc.wasm can't read it (its compile says why).
 */
export const parsed = (path: string, source: string): Parsed | undefined => {
  let answer: unknown;
  try {
    answer = JSON.parse(oxc().parse(path, source));
  } catch {
    return undefined;
  }
  const program: unknown =
    typeof answer === "object" && answer !== null
      ? Reflect.get(answer, "node")
      : undefined;
  if (!isNode(program)) {
    return undefined;
  }
  const starts = [
    0,
    ...Array.from(
      source.matchAll(lineBreak),
      ({ index, 0: found }) => index + found.length
    ),
  ];
  return {
    program,
    at: (offset) => {
      const line = starts.findLastIndex((start) => start <= offset);
      return { line: line + 1, column: offset - (starts[line] ?? 0) + 1 };
    },
  };
};
