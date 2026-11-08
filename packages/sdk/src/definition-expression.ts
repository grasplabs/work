import type {
  CallExpression,
  Expression,
  ObjectExpression,
} from "@oxc-project/types";

import { literalKey, literalValue } from "./expression-lowering.ts";
import { parseExpression } from "./oxc-parse.ts";
import { unsafeKeys } from "./value-descriptor.ts";

// What a definition tool is handed for a type or a permission: the
// expression an author would write in code, `v.string().max(200)` or
// `permission.connection("mail", { … })`, which the generated files show
// back. It is read with oxc's parser (oxc-parse.ts), as TypeScript, and
// evaluated over the SDK's own builders, which check it exactly as they
// check code, so a type the tools take is one code could declare, and
// nothing else.
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

/** Why an expression of anything but what is evaluated is refused. */
const notCode =
  "Write it as code would: a builder's calls, with literals, arrays and objects as their arguments.";

/** The longest expression read, in characters. */
const expressionMaxLength = 20_000;

/** An object literal's value, its keys defined, never assigned. */
const objectOf = (
  node: ObjectExpression,
  roots: Readonly<Record<string, unknown>>
): Record<string, unknown> => {
  const object: Record<string, unknown> = {};
  for (const property of node.properties) {
    const key =
      property.type === "Property" &&
      property.kind === "init" &&
      !property.method &&
      !property.computed
        ? literalKey(property.key)
        : undefined;
    if (property.type !== "Property" || key === undefined) {
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

/** Whether `node` is a chain of reads and calls with a `?.` in it. */
const isOptionalChain = (node: Expression): boolean => {
  let link = node;
  for (;;) {
    if (link.type === "MemberExpression") {
      if (link.optional) {
        return true;
      }
      link = link.object;
    } else if (link.type === "CallExpression") {
      if (link.optional) {
        return true;
      }
      link = link.callee;
    } else {
      return false;
    }
  }
};

/** A call of a builder's own method, with its arguments evaluated. */
const callOf = (
  node: CallExpression,
  roots: Readonly<Record<string, unknown>>
): unknown => {
  // A builder's method is always there: `?.` is no code a type is written in.
  if (isOptionalChain(node)) {
    return refuse(notCode);
  }
  const { callee } = node;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    callee.property.type !== "Identifier"
  ) {
    return refuse("Only a builder's methods are called here, as `v.string()`.");
  }
  const { name } = callee.property;
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
  node: Expression,
  roots: Readonly<Record<string, unknown>>
): unknown => {
  // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- every other node is refused
  switch (node.type) {
    case "Literal": {
      const value = literalValue(node);
      return value === undefined ? refuse(notCode) : value;
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
      return refuse(notCode);
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
  const parsed = parseExpression(source, "ts");
  if (!parsed.ok) {
    return refuse(`That isn't one expression: ${parsed.message}`);
  }
  return evaluate(parsed.node, roots);
};
