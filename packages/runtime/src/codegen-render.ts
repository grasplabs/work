import { canonicalText } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";

import type { FunctionManifest } from "./app-types.ts";
import type { ValueDescriptor } from "./value-descriptor.ts";

const identifier = /^[A-Za-z_$][\w$]*$/u;

/** A property name as TypeScript and JavaScript take it. */
export const key = (name: string): string =>
  identifier.test(name) ? name : JSON.stringify(name);

/** What a caller passes (`input`), or what the value is once normalized. */
type Mode = "input" | "output";

/** Whether a value may be left out where `mode` reads it. */
const omittable = (descriptor: ValueDescriptor, mode: Mode): boolean =>
  descriptor.presence === "optional" ||
  (descriptor.presence === "default" && mode === "input");

/** The TypeScript of a kind's type, the kinds that hold others aside. */
const scalarTypeOf = (descriptor: ValueDescriptor): string => {
  switch (descriptor.kind) {
    case "string":
    case "person":
    case "model":
    case "template": {
      return "string";
    }
    case "number":
    case "timestamp":
    case "duration": {
      return "number";
    }
    case "boolean": {
      return "boolean";
    }
    case "null": {
      return "null";
    }
    case "literal": {
      return JSON.stringify(descriptor.value);
    }
    case "enum": {
      return descriptor.values
        .map((value) => JSON.stringify(value))
        .join(" | ");
    }
    case "id": {
      return `Id<${JSON.stringify(descriptor.tableName)}>`;
    }
    case "file": {
      return "FileValue";
    }
    case "money": {
      return "MoneyValue";
    }
    case "schedule": {
      return "ScheduleValue";
    }
    case "object":
    case "array":
    case "union":
    case "record": {
      return "never";
    }
    default: {
      return "never";
    }
  }
};

/**
 * The TypeScript type of the values `descriptor` accepts, as a caller
 * passes them (`input`: a field with a default may be left out) or as
 * they normalize (`output`): the same types `InferInput` and `Infer` give
 * the schema the descriptor came from. With `whole`, `undefined` too when
 * the value itself may be left out; an object field's presence is its
 * `?` instead.
 */
const typeOf = (
  descriptor: ValueDescriptor,
  mode: Mode,
  whole = false
): string => {
  let type: string;
  if (descriptor.kind === "object") {
    // In name order: a descriptor's own order means nothing, and the same
    // contract must make the same text.
    const fields = Object.entries(descriptor.fields)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([name, field]) =>
          `${key(name)}${omittable(field, mode) ? "?" : ""}: ${typeOf(field, mode)}`
      );
    type =
      fields.length === 0 ? "Record<never, never>" : `{ ${fields.join("; ")} }`;
  } else if (descriptor.kind === "array") {
    type = `Array<${typeOf(descriptor.item, mode)}>`;
  } else if (descriptor.kind === "union") {
    type = descriptor.members
      .map((member) => `(${typeOf(member, mode, true)})`)
      .join(" | ");
  } else if (descriptor.kind === "record") {
    type = `Record<string, ${typeOf(descriptor.value, mode)}>`;
  } else {
    type = scalarTypeOf(descriptor);
  }
  const nullable = descriptor.nullable ? `${type} | null` : type;
  return whole && omittable(descriptor, mode)
    ? `${nullable} | undefined`
    : nullable;
};

/**
 * The TypeScript type of a whole value `descriptor` accepts, as a caller
 * passes it (`input`) or as it normalizes (`output`): `typeOf`, with its
 * own presence.
 */
export const valueTypeOf = (descriptor: ValueDescriptor, mode: Mode): string =>
  typeOf(descriptor, mode, true);

/** A tree of entries, by the segments of their dotted paths. */
type Tree<Leaf> = Map<string, { leaf: Leaf } | { tree: Tree<Leaf> }>;

/** The entries of `paths` as a tree of `leaf`s, by their segments. */
export const treeOf = <Leaf>(
  entries: readonly (readonly [string, Leaf])[]
): Tree<Leaf> => {
  const root: Tree<Leaf> = new Map();
  for (const [path, leaf] of entries) {
    const segments = path.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const existing = node.get(segment);
      if (existing !== undefined && "tree" in existing) {
        node = existing.tree;
      } else {
        const child: Tree<Leaf> = new Map();
        node.set(segment, { tree: child });
        node = child;
      }
    }
    node.set(segments.at(-1) ?? path, { leaf });
  }
  return root;
};

export const indent = (depth: number): string => "  ".repeat(depth);

/**
 * `tree` as TypeScript text, each leaf as `render` writes it, keys in
 * order: types (`readonly` members) or values.
 */
export const renderTree = <Leaf>(
  tree: Tree<Leaf>,
  render: (leaf: Leaf, depth: number) => string,
  member: (name: string) => string,
  separator: string,
  depth: number,
  empty = "{}"
): string => {
  const names = [...tree.keys()].toSorted();
  if (names.length === 0) {
    return empty;
  }
  const lines = names.map((name) => {
    const node = tree.get(name);
    let text = "";
    if (node !== undefined) {
      text =
        "leaf" in node
          ? render(node.leaf, depth + 1)
          : renderTree(node.tree, render, member, separator, depth + 1);
    }
    return `${indent(depth + 1)}${member(name)}: ${text}${separator}`;
  });
  return `{\n${lines.join("\n")}\n${indent(depth)}}`;
};

/** JSON data as a value in generated code: canonical, then indented. */
export const dataOf = (value: unknown, depth: number): string => {
  // SAFETY: canonical JSON text parses to JSON, keys in canonical order.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
  const canonical = JSON.parse(canonicalText(value)) as Json;
  return JSON.stringify(canonical, null, 2).replaceAll(
    "\n",
    `\n${indent(depth)}`
  );
};

/**
 * A function reference, as the data a generated module holds, built with
 * the server code: its name, and a mutation's or an action's kind and
 * argument descriptor (`useForm` sends and checks a form with them), or a query's declared return
 * (`DataGrid` reads its columns from it). Nothing that changes
 * from one release to the next: core resolves the name in the release
 * that answers the call, and checks the call with the function's own
 * validator.
 */
export const referenceOf = (fn: FunctionManifest) => {
  if (fn.kind !== "query") {
    return { name: fn.path, kind: fn.kind, args: fn.args };
  }
  return fn.returns === null
    ? { name: fn.path }
    : { name: fn.path, returns: fn.returns };
};

/**
 * A function reference's type, from its descriptors: what it takes, what
 * it answers (`unknown` where it declares no `returns`) and, for a
 * streaming action, what it streams. The same for every release that
 * declares the function alike.
 */
export const referenceTypeOf = (fn: FunctionManifest): string => {
  const parts = [
    JSON.stringify(fn.kind),
    JSON.stringify(fn.visibility),
    valueTypeOf(fn.args, "input"),
    fn.returns === null ? "unknown" : valueTypeOf(fn.returns, "output"),
  ];
  if (fn.stream !== null) {
    parts.push(valueTypeOf(fn.stream, "output"));
  }
  return `FunctionReference<${parts.join(", ")}>`;
};

export const banner =
  "// Generated by Grasp from the App's manifest. Don't edit it: it is made\n// again for every release, and edits are refused.\n";

/** Freezes generated data all the way down, inlined in each module. */
export const freezer = `const frozen = <Value>(value: Value): Value => {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const entry of Object.values(value)) {
      frozen(entry);
    }
  }
  return value;
};
`;

/** The value types a generated module may name, imported from the SDK. */
export const valueTypes = [
  "FileValue",
  "Id",
  "MoneyValue",
  "ScheduleValue",
] as const;

/** The SDK types `text` names, imported as types. */
export const typeImports = (text: string, names: readonly string[]): string => {
  const used = names.filter((name) =>
    new RegExp(`\\b${name}\\b`, "u").test(text)
  );
  return used.length === 0
    ? ""
    : `import type { ${used.toSorted().join(", ")} } from "@grasp-os/runtime";\n`;
};
