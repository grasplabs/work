/**
 * JavaScript printed from a tree, never from source text: what a checked
 * workflow expression runs as (expression-lowering.ts) and the files an
 * App's definition generates (definition-source.ts). Every name and value
 * is written as the tree holds it, so nothing a value holds can become
 * code: a string is quoted and escaped to ASCII, a key that isn't a plain
 * name is quoted, and parentheses go wherever precedence needs them.
 *
 * Our own, as oxc's codegen prints only a tree it parsed itself, in Rust:
 * no tree built here can reach it. Its layout: an object's entries one to
 * a line, two spaces deeper, and everything else on its line.
 */

/** A node of the tree printed: only what the two printers build. */
export type Code =
  | { type: "Identifier"; name: string }
  | { type: "String"; value: string }
  /** Finite and not negative: a negative number is `-` of one. */
  | { type: "Number"; value: number }
  | { type: "Boolean"; value: boolean }
  | { type: "Null" }
  /** `quasis` as written (raw), one more than `expressions`. */
  | {
      type: "Template";
      quasis: readonly string[];
      expressions: readonly Code[];
    }
  | { type: "Array"; elements: readonly (Code | Spread)[] }
  | { type: "Object"; properties: readonly (Property | Spread)[] }
  | { type: "Unary"; operator: string; argument: Code }
  | { type: "Binary"; operator: string; left: Code; right: Code }
  | { type: "Logical"; operator: string; left: Code; right: Code }
  | { type: "Conditional"; test: Code; consequent: Code; alternate: Code }
  | { type: "Call"; callee: Code; arguments: readonly Code[] }
  /** `.property` where it is a name, `["property"]` otherwise. */
  | { type: "Member"; object: Code; property: string }
  | { type: "Arrow"; params: readonly string[]; body: Code }
  | { type: "Parenthesized"; expression: Code };

export interface Spread {
  type: "Spread";
  argument: Code;
}

export interface Property {
  type: "Property";
  key: string;
  /** `["key"]` whatever the key; otherwise a plain name where it is one. */
  computed: boolean;
  value: Code;
}

/** ECMAScript's IdentifierName (ECMA-262, Names and Keywords). */
const identifierName = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*$/u;

/** Its reserved words, those of strict mode code and modules included. */
const reservedWords = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** Whether `name` can stand as a name in a module: an identifier, not a reserved word. */
export const isIdentifier = (name: string): boolean =>
  identifierName.test(name) && !reservedWords.has(name);

const hex = (code: number, digits: number): string =>
  code.toString(16).toUpperCase().padStart(digits, "0");

const singleEscapes: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  '"': '\\"',
};

/** Every character but printable ASCII, a double quote and a backslash. */
const escaped = /[^ !#-[\]-~]/gu;

const digit = /[0-9]/u;

/**
 * `value` as a string literal in double quotes, in ASCII: `\0` (unless a
 * digit follows), the usual single escapes, `\xHH` below U+0100 and
 * `\uHHHH` above (each half of a surrogate pair, and a lone one): the
 * generated code is ASCII, whatever its strings hold.
 */
const quoted = (value: string): string =>
  `"${value.replaceAll(escaped, (char, offset: number) => {
    const single = singleEscapes[char];
    if (single !== undefined) {
      return single;
    }
    if (char === "\0" && !digit.test(value.charAt(offset + 1))) {
      return "\\0";
    }
    // Each UTF-16 unit: both halves of a character past U+FFFF.
    let units = "";
    for (let at = 0; at < char.length; at += 1) {
      // oxlint-disable-next-line unicorn/prefer-code-point -- a unit each, as above
      const unit = char.charCodeAt(at);
      units += unit > 0xff ? `\\u${hex(unit, 4)}` : `\\x${hex(unit, 2)}`;
    }
    return units;
  })}"`;

/** How tightly each binary and logical operator binds. */
const precedence: ReadonlyMap<string, number> = new Map([
  ["||", 0],
  ["??", 1],
  ["&&", 2],
  ["|", 3],
  ["^", 4],
  ["&", 5],
  ["==", 6],
  ["===", 6],
  ["!=", 6],
  ["!==", 6],
  ["<", 7],
  [">", 7],
  ["<=", 7],
  [">=", 7],
  ["in", 7],
  ["instanceof", 7],
  [">>", 8],
  ["<<", 8],
  [">>>", 8],
  ["+", 9],
  ["-", 9],
  ["*", 10],
  ["/", 10],
  ["%", 10],
  ["**", 11],
]);

const precedenceOf = (operator: string): number => {
  const found = precedence.get(operator);
  if (found === undefined) {
    throw new Error(`\`${operator}\` is no binary operator.`);
  }
  return found;
};

/** Where a node stands in its parent, as far as its parentheses go. */
type Place =
  | "callee"
  | "object"
  | "left"
  | "right"
  | "test"
  | "operand"
  | "spread"
  | "other";

/** Whether an operator's `node`, at `place` in `parent`, would group otherwise without parentheses. */
const groupsApart = (
  node: Code & { type: "Binary" | "Logical" },
  parent: Code | Spread | undefined,
  place: Place
): boolean => {
  if (parent?.type !== "Binary" && parent?.type !== "Logical") {
    return false;
  }
  const outer = precedenceOf(parent.operator);
  const inner = precedenceOf(node.operator);
  if (outer > inner) {
    return true;
  }
  // Same precedence: a binary operator groups left, `**` right.
  if (
    outer === inner &&
    parent.type === "Binary" &&
    place === (inner === precedenceOf("**") ? "left" : "right")
  ) {
    return true;
  }
  // `??` mixes with `||` and `&&` only in parentheses.
  return (
    node.type === "Logical" &&
    parent.type === "Logical" &&
    (node.operator === "??") !== (parent.operator === "??")
  );
};

/** Whether `node`, at `place` in `parent`, needs parentheses. */
const needsParentheses = (
  node: Code,
  parent: Code | Spread | undefined,
  place: Place
): boolean => {
  // Called, read from, an operand or spread: no operator's expression.
  const bound =
    place === "callee" ||
    place === "object" ||
    place === "operand" ||
    place === "spread";
  if (node.type === "Binary" || node.type === "Logical") {
    return bound || groupsApart(node, parent, place);
  }
  if (node.type === "Conditional" || node.type === "Arrow") {
    return (
      bound ||
      place === "test" ||
      parent?.type === "Binary" ||
      parent?.type === "Logical"
    );
  }
  if (node.type === "Unary") {
    return (
      place === "callee" ||
      place === "object" ||
      (parent?.type === "Binary" &&
        parent.operator === "**" &&
        place === "left")
    );
  }
  return false;
};

const indentOf = (depth: number): string => "  ".repeat(depth);

interface Context {
  parent: Code | Spread | undefined;
  place: Place;
  /** How many objects deep: each one's entries are a line each, two spaces in. */
  depth: number;
  /**
   * Whether it is printed first in an arrow's body, where `{` would open
   * a block: passed on to what is printed first of it.
   */
  arrowBody: boolean;
}

/** `node` printed (see the header). */
// One case per node type: its length is the tree's, not complexity.
// oxlint-disable-next-line eslint/complexity -- see above
const printed = (node: Code, context: Context): string => {
  if (needsParentheses(node, context.parent, context.place)) {
    return `(${printed(node, { ...context, parent: undefined, place: "other", arrowBody: false })})`;
  }
  const { depth } = context;
  const child = (code: Code, place: Place, first = false): string =>
    printed(code, {
      parent: node,
      place,
      depth,
      arrowBody: first && context.arrowBody,
    });
  switch (node.type) {
    case "Identifier": {
      return node.name;
    }
    case "String": {
      return quoted(node.value);
    }
    case "Number": {
      return String(node.value);
    }
    case "Boolean": {
      return String(node.value);
    }
    case "Null": {
      return "null";
    }
    case "Template": {
      const parts = node.expressions.map(
        (expression, at) =>
          `${node.quasis[at] ?? ""}\${${child(expression, "other")}}`
      );
      return `\`${parts.join("")}${node.quasis.at(-1) ?? ""}\``;
    }
    case "Array": {
      const elements = node.elements.map((element) =>
        element.type === "Spread"
          ? `...${printed(element.argument, { parent: element, place: "spread", depth, arrowBody: false })}`
          : child(element, "other")
      );
      return `[${elements.join(", ")}]`;
    }
    case "Object": {
      if (context.arrowBody) {
        return `(${printed(node, { ...context, arrowBody: false })})`;
      }
      if (node.properties.length === 0) {
        return "{}";
      }
      const inner = depth + 1;
      const entries = node.properties.map((property) => {
        const value =
          property.type === "Spread" ? property.argument : property.value;
        const text = printed(value, {
          parent: property.type === "Spread" ? property : node,
          place: property.type === "Spread" ? "spread" : "other",
          depth: inner,
          arrowBody: false,
        });
        if (property.type === "Spread") {
          return `${indentOf(inner)}...${text}`;
        }
        const key =
          property.computed || !isIdentifier(property.key)
            ? quoted(property.key)
            : property.key;
        return `${indentOf(inner)}${property.computed ? `[${key}]` : key}: ${text}`;
      });
      return `{\n${entries.join(",\n")}\n${indentOf(depth)}}`;
    }
    case "Unary": {
      const argument = child(node.argument, "operand");
      if (/^[a-z]/u.test(node.operator)) {
        return `${node.operator} ${argument}`;
      }
      // `- -a`, not `--a`, which is a decrement (and `+ +a` likewise).
      const apart =
        (node.operator === "-" || node.operator === "+") &&
        argument.startsWith(node.operator)
          ? " "
          : "";
      return `${node.operator}${apart}${argument}`;
    }
    case "Binary":
    case "Logical": {
      return `${child(node.left, "left", true)} ${node.operator} ${child(node.right, "right")}`;
    }
    case "Conditional": {
      return `${child(node.test, "test", true)} ? ${child(node.consequent, "other")} : ${child(node.alternate, "other")}`;
    }
    case "Call": {
      const args = node.arguments.map((argument) => child(argument, "other"));
      return `${child(node.callee, "callee", true)}(${args.join(", ")})`;
    }
    case "Member": {
      const object = child(node.object, "object", true);
      // A reserved word is a name after a dot: `.default`.
      return identifierName.test(node.property)
        ? `${object}.${node.property}`
        : `${object}[${quoted(node.property)}]`;
    }
    case "Arrow": {
      const params =
        node.params.length === 1
          ? (node.params[0] ?? "")
          : `(${node.params.join(", ")})`;
      const body = printed(node.body, {
        parent: node,
        place: "other",
        depth,
        arrowBody: true,
      });
      return `${params} => ${body}`;
    }
    case "Parenthesized": {
      return `(${printed(node.expression, { parent: node, place: "other", depth, arrowBody: false })})`;
    }
    default: {
      throw new Error("A printed tree has no other node.");
    }
  }
};

/** `node` as JavaScript, at the top level: no parentheses around it. */
export const print = (node: Code): string =>
  printed(node, {
    parent: undefined,
    place: "other",
    depth: 0,
    arrowBody: false,
  });
