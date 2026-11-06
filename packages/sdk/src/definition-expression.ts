import { parseExpression } from "@babel/parser";
import type { Node } from "@babel/types";

import { unsafeKeys } from "./value-descriptor.ts";

// What a definition tool is handed for a type or a permission: the
// expression an author would write in code, `v.string().max(200)` or
// `permission.connection("mail", { … })`, which the generated files show
// back. It is read with Babel's parser and evaluated over the SDK's own
// builders, which check it exactly as they check code, so a type the
// tools take is one code could declare, and nothing else.
//
// Only what such an expression holds is evaluated: calls of a builder's
// own methods (never a prototype's), and literals, arrays and objects as
// their arguments. No variable but the roots it is given, no member read
// but a method called, no spread, computed key or function: nothing that
// could reach anything but the builders.

/** Why an expression was refused. */
export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressionError";
  }
}

const refuse = (message: string): never => {
  throw new ExpressionError(message);
};

/** The longest expression read, in characters. */
export const expressionMaxLength = 20_000;

/** The name of a non-computed key or member, if it has one. */
const keyName = (node: Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "StringLiteral") {
    return node.value;
  }
  return node.type === "NumericLiteral" ? String(node.value) : undefined;
};

/** An object literal's value, its keys defined, never assigned. */
const objectOf = (
  node: Extract<Node, { type: "ObjectExpression" }>,
  roots: Readonly<Record<string, unknown>>
): Record<string, unknown> => {
  const object: Record<string, unknown> = {};
  for (const property of node.properties) {
    const key =
      property.type === "ObjectProperty" && !property.computed
        ? keyName(property.key)
        : undefined;
    if (property.type !== "ObjectProperty" || key === undefined) {
      return refuse("An object here holds plain `key: value` entries only.");
    }
    if (unsafeKeys.has(key)) {
      return refuse(`\`${key}\` can't be a key.`);
    }
    // Defined once each (a defined property can't be redefined): a key
    // given twice is refused, as no one can tell which value it holds.
    if (Object.hasOwn(object, key)) {
      return refuse(`\`${key}\` is a key twice.`);
    }
    Object.defineProperty(object, key, {
      enumerable: true,
      // oxlint-disable-next-line no-use-before-define -- the evaluator is recursive
      value: evaluate(property.value, roots),
    });
  }
  return object;
};

/** A call of a builder's own method, with its arguments evaluated. */
const callOf = (
  node: Extract<Node, { type: "CallExpression" }>,
  roots: Readonly<Record<string, unknown>>
): unknown => {
  const { callee } = node;
  const name =
    callee.type === "MemberExpression" && !callee.computed
      ? keyName(callee.property)
      : undefined;
  if (callee.type !== "MemberExpression" || name === undefined) {
    return refuse("Only a builder's methods are called here, as `v.string()`.");
  }
  // oxlint-disable-next-line no-use-before-define -- the evaluator is recursive
  const target = evaluate(callee.object, roots);
  const method: unknown =
    typeof target === "object" && target !== null && Object.hasOwn(target, name)
      ? Reflect.get(target, name)
      : undefined;
  if (typeof method !== "function") {
    return refuse(`\`${name}\` isn't a method there.`);
  }
  const args = node.arguments.map((argument) => {
    if (argument.type === "SpreadElement") {
      return refuse("An argument here is never spread.");
    }
    // oxlint-disable-next-line no-use-before-define -- the evaluator is recursive
    return evaluate(argument, roots);
  });
  return Reflect.apply(method, target, args);
};

/** What `node` evaluates to over `roots` (see the header). */
const evaluate = (
  node: Node,
  roots: Readonly<Record<string, unknown>>
): unknown => {
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- every other node is refused
  switch (node.type) {
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral": {
      return node.value;
    }
    case "NullLiteral": {
      return null;
    }
    case "TemplateLiteral": {
      if (node.expressions.length > 0) {
        return refuse("A template here holds no placeholders.");
      }
      return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("");
    }
    case "UnaryExpression": {
      const value = evaluate(node.argument, roots);
      if (node.operator !== "-" || typeof value !== "number") {
        return refuse("Only a number is negated here.");
      }
      return -value;
    }
    case "ArrayExpression": {
      return node.elements.map((element) =>
        element === null || element.type === "SpreadElement"
          ? refuse("An array here lists its items, never a hole or a spread.")
          : evaluate(element, roots)
      );
    }
    case "ObjectExpression": {
      return objectOf(node, roots);
    }
    case "Identifier": {
      return Object.hasOwn(roots, node.name)
        ? roots[node.name]
        : refuse(
            `\`${node.name}\` isn't known here: use ${Object.keys(roots)
              .map((root) => `\`${root}\``)
              .join(" or ")}.`
          );
    }
    case "TSAsExpression":
    case "TSSatisfiesExpression": {
      return evaluate(node.expression, roots);
    }
    case "CallExpression": {
      return callOf(node, roots);
    }
    default: {
      return refuse(
        "Write it as code would: a builder's calls, with literals, arrays and objects as their arguments."
      );
    }
  }
};

/**
 * What `source`, one expression, evaluates to over `roots` (see the
 * header); throws `ExpressionError` for one that isn't such an expression,
 * and the builders' own errors for one they refuse.
 */
export const evaluateExpression = (
  source: unknown,
  roots: Readonly<Record<string, unknown>>
): unknown => {
  if (typeof source !== "string" || source.length > expressionMaxLength) {
    return refuse(
      `An expression is text of at most ${expressionMaxLength} characters.`
    );
  }
  let node: Node;
  try {
    node = parseExpression(source, { plugins: ["typescript"] });
  } catch (error) {
    return refuse(
      `That isn't one expression: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return evaluate(node, roots);
};
