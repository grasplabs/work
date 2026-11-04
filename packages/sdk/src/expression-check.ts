import { parseExpression } from "@babel/parser";
import type { Expression, Node } from "@babel/types";
import { messageOf } from "@grasp-os/shared/errors";

/**
 * Workflow expressions, in JavaScript: what a JSON workflow writes where
 * a value is computed from the run's data, such as
 * `steps.extract.output.lines.filter((line) => line.total > params.limit)`.
 * The generator writes each checked expression as it is into the
 * workflow's generated TypeScript (`expressionCode`), so it runs in the
 * workflow's isolate with no interpreter, under the isolate's CPU and
 * memory limits, as compute modules do.
 *
 * An expression is parsed by Babel, as JavaScript in a module, and its
 * syntax tree held to an allowlist: reads of the workflow's own values
 * (`roots`) and of callback parameters, literals, operators, and calls of
 * the methods in `callbackMethods` and `plainMethods` only. Everything
 * else is refused, so what it can do is what the allowlist lets it, and
 * a syntax added to JavaScript later is refused until it is allowed here.
 *
 * What the allowlist relies on: the values it reads are JSON (a run's
 * input, a step's output, params), so they hold no functions, getters or
 * symbols of their own; whatever function an expression can reach is one
 * of the built-in prototypes', reached by name, and only the names below
 * are ever called. Work is bounded by the isolate, not here: with no
 * loops and no function that can call itself, an expression's work is at
 * most polynomial in its data (a `map` inside a `map`), and the isolate's
 * CPU limit stops it.
 */

/** The workflow's values an expression may start from, by default. */
export const expressionRoots = ["input", "steps", "params", "run"] as const;

/**
 * Array methods that take a callback, which must be the call's only
 * argument and an arrow function written there (`callbackArrow`): never
 * a function value, which `map(fn, thisArg)` would call with `this` set
 * to anything, a data array's `push` included.
 */
const callbackMethods = new Set([
  "map",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
]);

/**
 * Array, string and number methods that take only values, none of which
 * changes what it is called on or does work out of proportion to its
 * data (no `repeat` or `padStart`).
 */
const plainMethods = new Set([
  "includes",
  "indexOf",
  "slice",
  "concat",
  "join",
  "at",
  "split",
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "startsWith",
  "endsWith",
  "toFixed",
]);

/**
 * Property names never read or written, however they're spelled: the way
 * from a value to its prototype and from there to `Function`, and
 * `Object.prototype`'s accessors to define and find getters and setters.
 */
const blockedProperties = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * Operators that work on values alone. Not bitwise operators, which no
 * workflow needs and which, beside `<` and `>`, read as type arguments in
 * TypeScript (`chainedComparison`); not `in` and `instanceof`, which ask
 * about prototypes.
 */
const binaryOperators = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "**",
  "==",
  "!=",
  "===",
  "!==",
  "<",
  ">",
  "<=",
  ">=",
]);

const comparisons = new Set(["<", ">", "<=", ">="]);

/** Not `delete`, which changes data, `void` and `~`. */
const unaryOperators = new Set(["!", "-", "+", "typeof"]);

/** Why an expression was refused, stable for whoever fixes it. */
export type ExpressionErrorCode =
  | "expression.syntax"
  | "expression.global"
  | "expression.property"
  | "expression.computed-key"
  | "expression.method"
  | "expression.callback"
  | "expression.operator"
  | "expression.chained-comparison";

/** A problem in an expression, where it is (in its source) and how to fix it. */
export interface ExpressionError {
  code: ExpressionErrorCode;
  message: string;
  fix: string;
  /** 0-based, in UTF-16 code units, as JavaScript counts a string. */
  offset: number;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export type CheckedExpression =
  | { ok: true; source: string }
  | { ok: false; errors: ExpressionError[] };

const fixes: Record<ExpressionErrorCode, string> = {
  "expression.syntax":
    "Write one expression of property reads, literals, operators and the allowed methods.",
  "expression.global":
    "Start from one of the values the message names, or a callback's own parameter.",
  "expression.property":
    "Read the data's own fields; the prototype chain is out of reach.",
  "expression.computed-key":
    "Write the key as a string or number literal, or read the field by name.",
  "expression.method": `Call one of: ${[...callbackMethods, ...plainMethods].join(", ")}.`,
  "expression.callback":
    "Pass one arrow function with plain parameters and an expression body, e.g. (line) => line.total, as the only argument of map, filter, some, every, find or findIndex.",
  "expression.operator":
    "Use arithmetic, comparison, logical or conditional operators; read fields with ?. instead of `in`.",
  "expression.chained-comparison":
    "Compare once, and join comparisons with && or ||.",
};

const located = (
  code: ExpressionErrorCode,
  message: string,
  offset: number,
  line: number,
  column: number
): ExpressionError => ({
  code,
  message,
  fix: fixes[code],
  offset,
  line,
  column,
});

/** A property's name as JavaScript reads it, when written as a literal. */
const literalKey = (node: Node): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (node.type === "StringLiteral") {
    return node.value;
  }
  if (node.type === "NumericLiteral") {
    return String(node.value);
  }
  return undefined;
};

/** A callback as `callbackMethods` take it: `(a, b) => expression`. */
const isCallbackArrow = (node: Node): boolean =>
  node.type === "ArrowFunctionExpression" &&
  !node.async &&
  node.body.type !== "BlockStatement" &&
  node.params.every((param) => param.type === "Identifier");

class Checker {
  readonly errors: ExpressionError[] = [];

  /** The roots, as a global's error names them. */
  private readonly rootList: string;

  constructor(roots: ReadonlySet<string>) {
    this.rootList = [...roots].join(", ");
  }

  private fail(node: Node, code: ExpressionErrorCode, message: string): void {
    const start = node.loc?.start;
    this.errors.push(
      located(
        code,
        message,
        node.start ?? 0,
        start?.line ?? 1,
        (start?.column ?? 0) + 1
      )
    );
  }

  private property(node: Node, name: string): void {
    if (blockedProperties.has(name)) {
      this.fail(node, "expression.property", `\`${name}\` can't be read.`);
    }
  }

  /** A member's key: a name, or a literal in brackets, never computed. */
  private key(node: Node, computed: boolean): void {
    const name = literalKey(node);
    if (name === undefined || (computed && node.type === "Identifier")) {
      this.fail(
        node,
        "expression.computed-key",
        "A key in brackets must be a string or number literal."
      );
      return;
    }
    this.property(node, name);
  }

  private call(
    node: Node & { callee: Node; arguments: Node[] },
    scope: ReadonlySet<string>
  ): void {
    const { callee } = node;
    if (
      (callee.type !== "MemberExpression" &&
        callee.type !== "OptionalMemberExpression") ||
      callee.computed ||
      callee.property.type !== "Identifier"
    ) {
      const before = this.errors.length;
      this.visit(callee, scope);
      if (this.errors.length === before) {
        this.fail(
          callee,
          "expression.method",
          "Only the allowed methods can be called, by name."
        );
      }
      this.values(node.arguments, scope);
      return;
    }
    const method = callee.property.name;
    this.visit(callee.object, scope);
    if (callbackMethods.has(method)) {
      const [callback] = node.arguments;
      if (
        node.arguments.length !== 1 ||
        callback === undefined ||
        !isCallbackArrow(callback)
      ) {
        this.fail(
          node,
          "expression.callback",
          `\`${method}\` takes one arrow function, written in the call.`
        );
        return;
      }
      if (callback.type === "ArrowFunctionExpression") {
        const inner = new Set(scope);
        for (const param of callback.params) {
          if (param.type === "Identifier") {
            inner.add(param.name);
          }
        }
        this.visit(callback.body, inner);
      }
      return;
    }
    if (!plainMethods.has(method)) {
      this.fail(
        callee.property,
        "expression.method",
        `\`${method}\` is not one of the methods an expression can call.`
      );
      return;
    }
    this.values(node.arguments, scope);
  }

  /** A call's arguments, each a value: no spread into a call. */
  private values(nodes: readonly Node[], scope: ReadonlySet<string>): void {
    for (const node of nodes) {
      if (node.type === "SpreadElement") {
        this.fail(node, "expression.syntax", "A call takes no spread.");
      } else {
        this.visit(node, scope);
      }
    }
  }

  // One case per node type the subset allows; anything else is refused,
  // so the list is the subset. Its length is the subset's, not complexity.
  // oxlint-disable-next-line eslint/complexity -- see above
  visit(node: Node, scope: ReadonlySet<string>): void {
    // Not exhaustive on purpose: `default` refuses every other node type.
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- see above
    switch (node.type) {
      case "Identifier": {
        if (!scope.has(node.name)) {
          this.fail(
            node,
            "expression.global",
            `\`${node.name}\` is not one of the workflow's values: ${this.rootList}.`
          );
        }
        break;
      }
      case "StringLiteral":
      case "NumericLiteral":
      case "BooleanLiteral":
      case "NullLiteral": {
        break;
      }
      case "TemplateLiteral": {
        for (const expression of node.expressions) {
          this.visit(expression, scope);
        }
        break;
      }
      case "MemberExpression":
      case "OptionalMemberExpression": {
        this.visit(node.object, scope);
        this.key(node.property, node.computed);
        break;
      }
      case "CallExpression":
      case "OptionalCallExpression": {
        this.call(node, scope);
        break;
      }
      case "ArrayExpression": {
        for (const element of node.elements) {
          if (element === null) {
            this.fail(node, "expression.syntax", "An array has no holes.");
          } else {
            this.visit(element, scope);
          }
        }
        break;
      }
      case "ObjectExpression": {
        for (const property of node.properties) {
          if (property.type === "ObjectProperty") {
            if (property.computed) {
              this.key(property.key, true);
            } else {
              const name = literalKey(property.key);
              if (name !== undefined) {
                this.property(property.key, name);
              }
            }
            this.visit(property.value, scope);
          } else {
            this.visit(property, scope);
          }
        }
        break;
      }
      // Copies a JSON value's own fields or items into a new literal: no
      // getter or iterator of its own runs, as JSON holds none.
      case "SpreadElement": {
        this.visit(node.argument, scope);
        break;
      }
      case "UnaryExpression": {
        if (!unaryOperators.has(node.operator)) {
          this.fail(
            node,
            node.operator === "~" ? "expression.operator" : "expression.syntax",
            `\`${node.operator}\` is not an operator an expression has.`
          );
          return;
        }
        this.visit(node.argument, scope);
        break;
      }
      case "BinaryExpression": {
        if (!binaryOperators.has(node.operator)) {
          this.fail(
            node,
            "expression.operator",
            `\`${node.operator}\` is not an operator an expression has.`
          );
        } else if (
          comparisons.has(node.operator) &&
          node.left.type === "BinaryExpression" &&
          comparisons.has(node.left.operator)
        ) {
          // `a < b > (c)` is a generic call in TypeScript, which the
          // generated code is: TypeScript would call `a` with `c`.
          this.fail(
            node,
            "expression.chained-comparison",
            "A comparison can't compare another comparison."
          );
          return;
        }
        this.visit(node.left, scope);
        this.visit(node.right, scope);
        break;
      }
      case "LogicalExpression": {
        this.visit(node.left, scope);
        this.visit(node.right, scope);
        break;
      }
      case "ConditionalExpression": {
        this.visit(node.test, scope);
        this.visit(node.consequent, scope);
        this.visit(node.alternate, scope);
        break;
      }
      case "ArrowFunctionExpression":
      case "FunctionExpression": {
        this.fail(
          node,
          "expression.callback",
          "A function can only be written as the callback of map, filter, some, every, find or findIndex."
        );
        break;
      }
      default: {
        this.fail(
          node,
          "expression.syntax",
          `${node.type} is not part of what an expression can be.`
        );
      }
    }
  }
}

/** JavaScript's line terminators, as Babel and TypeScript count lines. */
const lineBreak = /\r\n?|[\n\u2028\u2029]/gu;

/** Babel's syntax error, at the offset it gives (`pos`). */
const syntaxError = (source: string, error: unknown): ExpressionError => {
  const offset =
    typeof error === "object" &&
    error !== null &&
    "pos" in error &&
    typeof error.pos === "number"
      ? error.pos
      : 0;
  const before = source.slice(0, offset).split(lineBreak);
  return located(
    "expression.syntax",
    `The expression doesn't parse: ${messageOf(error)}`,
    offset,
    before.length,
    (before.at(-1)?.length ?? 0) + 1
  );
};

/** A root's name: ASCII, unescaped, so it reads the same wherever it's written. */
const plainName = /^[A-Za-z_$][\w$]*$/u;

/**
 * Global names of the hosts JavaScript runs on that this isolate may not
 * have (`isGlobal` asks it for the rest), and `arguments`, which an arrow
 * reads from the function around it.
 */
const hostGlobals = new Set([
  "arguments",
  "global",
  "window",
  "self",
  "document",
  "process",
  "require",
  "module",
  "exports",
  "Deno",
  "Bun",
]);

const isGlobal = (name: string): boolean =>
  hostGlobals.has(name) || Reflect.has(globalThis, name);

/** Whether `name` binds as a parameter: no reserved word, by Babel. */
const isBindable = (name: string): boolean => {
  try {
    const parsed = parseExpression(`(${name}) => 0`, {
      sourceType: "module",
      plugins: [],
    });
    return (
      parsed.type === "ArrowFunctionExpression" &&
      parsed.params[0]?.type === "Identifier" &&
      parsed.params[0].name === name
    );
  } catch {
    return false;
  }
};

/**
 * The roots an expression may read, as a caller names them: the default
 * ones, or those of where it runs (`item` inside a `forEach`, `error` in
 * a catch). Each is a plain identifier the generated code binds as a
 * parameter, never a global's name: even shadowed, an expression that
 * reads `globalThis` would read differently wherever the binding isn't.
 * A wrong root is the caller's mistake, not the expression's, so it
 * throws.
 */
export const checkRoots = (names: readonly string[]): ReadonlySet<string> => {
  for (const name of names) {
    if (!(plainName.test(name) && isBindable(name))) {
      throw new Error(
        `"${name}" can't be an expression's root: a root is a plain identifier.`
      );
    }
    if (isGlobal(name)) {
      throw new Error(
        `"${name}" can't be an expression's root: it is a global's name.`
      );
    }
  }
  return new Set(names);
};

/** How an expression is checked. */
export interface CheckOptions {
  /** The values it may read by name; `expressionRoots` by default. */
  readonly roots?: readonly string[];
}

/**
 * Checks a workflow expression against the subset: every problem found,
 * each with its code, position and fix, or the source to generate from.
 * Throws when a root in `options` is not a plain, non-global identifier.
 */
export const checkExpression = (
  source: string,
  options: CheckOptions = {}
): CheckedExpression => {
  const roots = checkRoots(options.roots ?? expressionRoots);
  let parsed: Expression;
  try {
    // As a module, as the generated code is one: strict, no HTML comments.
    // No plugins: TypeScript's syntax and JSX are refused.
    parsed = parseExpression(source, { sourceType: "module", plugins: [] });
  } catch (error) {
    return { ok: false, errors: [syntaxError(source, error)] };
  }
  const checker = new Checker(roots);
  checker.visit(parsed, roots);
  return checker.errors.length === 0
    ? { ok: true, source }
    : { ok: false, errors: checker.errors };
};

/**
 * A checked expression as the generator writes it into generated code:
 * on lines of its own in parentheses, so a trailing `//` comment ends
 * before the code after it and the expression stays one, whatever is
 * around it. Its line `n` is line `n + 1` of what this returns.
 */
export const expressionCode = (checked: { ok: true; source: string }): string =>
  `(\n${checked.source}\n)`;
