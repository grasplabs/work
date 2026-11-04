import { parseExpression } from "@babel/parser";
import type { Node } from "@babel/types";
import { messageOf } from "@grasp-os/shared/errors";

import {
  literalKey,
  lowerExpression,
  typeForm,
} from "./expression-lowering.ts";
import type { ExpressionRead, TypeForm } from "./expression-lowering.ts";
import { allowedMethods, callbackMethods } from "./expression-runtime.ts";

export { runtimeNames, sourcePosition } from "./expression-lowering.ts";
export type { ExpressionRead, TypeForm } from "./expression-lowering.ts";
// The methods an expression can call, for the type check's own refusal
// of a method read without a call (`checkExpressionTypes`).
export { allowedMethods } from "./expression-runtime.ts";

/**
 * Workflow expressions, in JavaScript: what a JSON workflow writes where
 * a value is computed from the run's data, such as
 * `steps.extract.output.lines.filter((line) => line.total > params.limit)`.
 * The generator writes each checked expression's code (`code`) into the
 * workflow's generated TypeScript, so it runs in the workflow's isolate
 * with no interpreter, under the isolate's CPU and memory limits, as
 * compute modules do.
 *
 * Two lines of defence:
 *
 * 1. The check. An expression is parsed by Babel, as JavaScript in a
 *    module, and its syntax tree held to an allowlist: reads of the
 *    workflow's own values (`roots`) and of callback parameters,
 *    literals, operators, and calls of the allowed methods by name.
 *    Everything else is refused, with a position and a fix, and a syntax
 *    added to JavaScript later is refused until it is allowed here.
 * 2. The code. What runs is printed from the checked tree (`Lowering`),
 *    with every member read and method call through the guards of
 *    expression-runtime.ts, which give only own data and call only the
 *    allowed built-ins on real arrays, strings and numbers. So no
 *    expression holds a function value, whatever names its data's fields
 *    have: none can file a built-in method under an allowed name
 *    (`{ at: [].forEach }.at(…)`) or hand one to an implicit conversion
 *    (`${{ toString: list.reverse }}`), which a check of names alone
 *    can't refuse.
 *
 * Work is bounded by the isolate, not here: with no loops and no
 * function that can call itself, an expression's work is at most
 * polynomial in its data (a `map` inside a `map`), and the isolate's CPU
 * limit stops it.
 */

/** The workflow's values an expression may start from, by default. */
export const expressionRoots = ["input", "steps", "params", "run"] as const;

/**
 * Property names never read or written, however they're spelled: the way
 * from a value to its prototype and from there to `Function`, and
 * `Object.prototype`'s accessors to define and find getters and setters.
 */
export const blockedProperties: readonly string[] = [
  "constructor",
  "prototype",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
];

const blocked = new Set(blockedProperties);

/**
 * Operators that work on values alone: not bitwise operators, which no
 * workflow needs, nor `in` and `instanceof`, which ask about prototypes.
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
  | "expression.operator";

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

/**
 * A checked expression: its source, as written, and the code generated
 * from its syntax tree (`Lowering`), one parenthesized expression the
 * generator writes where the value is computed, in a module that
 * imports the guards under `runtimeNames`. Never write it right after an identifier on
 * the line before: `name\n(…)` is a call.
 */
export type CheckedExpression =
  | {
      ok: true;
      source: string;
      code: string;
      /** The reads of its roots, for the caller to hold to where it stands. */
      reads: ExpressionRead[];
      forTypes: TypeForm;
    }
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
  "expression.method": `Call one of: ${[...allowedMethods].join(", ")}.`,
  "expression.callback":
    "Pass one arrow function with plain parameters and an expression body, e.g. (line) => line.total, as the only argument of map, filter, some, every, find or findIndex.",
  "expression.operator":
    "Use arithmetic, comparison, logical or conditional operators; read fields with ?. instead of `in`.",
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

/**
 * A callback as `callbackMethods` take it: `(a, b) => expression`. Its
 * parameters' names don't start with `$`, which the generated code's own
 * names do (`runtimeNames`), so none can shadow them.
 */
const isCallbackArrow = (node: Node): boolean =>
  node.type === "ArrowFunctionExpression" &&
  !node.async &&
  node.body.type !== "BlockStatement" &&
  node.params.every(
    (param) => param.type === "Identifier" && !param.name.startsWith("$")
  );

class Checker {
  readonly errors: ExpressionError[] = [];

  /** The roots, as a global's error names them. */
  private readonly rootList: string;

  constructor(roots: ReadonlySet<string>) {
    this.rootList = [...roots].join(", ");
  }

  private fail(
    node: Pick<Node, "start" | "loc">,
    code: ExpressionErrorCode,
    message: string
  ): void {
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
    if (blocked.has(name)) {
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
    // `(a?.map)(f)` calls what the parentheses give, `undefined` included:
    // a method is called directly.
    if (callee.extra?.parenthesized === true) {
      this.fail(
        callee,
        "expression.syntax",
        `Call \`${method}\` directly, without parentheses around it.`
      );
      return;
    }
    if (node.type === "OptionalCallExpression" && node.optional) {
      this.fail(
        node,
        "expression.syntax",
        `\`${method}?.()\`: an allowed method is always there; call it as \`${method}()\`.`
      );
      return;
    }
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
    if (!allowedMethods.has(method)) {
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
        // A field named like a method (`at`, `map`) is data, and `$read`
        // reads it. A method read without a call has a function type,
        // which the type check refuses (`checkExpressionTypes`).
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

/**
 * A root's name: ASCII, unescaped, so it reads the same wherever it's
 * written, and not starting with `$`, as the generated code's names do.
 */
const plainName = /^[A-Za-z_][\w$]*$/u;

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

const defaultRoots = new Set<string>(expressionRoots);

/**
 * The roots an expression may read: `expressionRoots`, always in scope,
 * and the further ones of where it runs (`item` inside a `forEach`,
 * `error` in a catch). Each further one is a plain identifier, as the
 * generated code binds it as a parameter (so a root named like a global
 * reads the root), and not one of the default roots again. A wrong root
 * is the caller's mistake, not the expression's, so it throws.
 */
export const checkRoots = (
  further: readonly string[] = []
): ReadonlySet<string> => {
  for (const name of further) {
    if (!(plainName.test(name) && isBindable(name))) {
      throw new Error(
        `"${name}" can't be an expression's root: a root is a plain identifier.`
      );
    }
    if (defaultRoots.has(name)) {
      throw new Error(`"${name}" is already one of an expression's roots.`);
    }
  }
  return new Set([...expressionRoots, ...further]);
};

/** How an expression is checked. */
export interface CheckOptions {
  /** Roots beside `expressionRoots`, which are always in scope. */
  readonly roots?: readonly string[];
}

/**
 * Checks a workflow expression against the subset: every problem found,
 * each with its code, position and fix, or the source to generate from.
 * Throws when a root in `options` is not one `checkRoots` takes.
 * Syntax alone can't tell a method read without a call from a data
 * field of that name, so production must also run the compiler's
 * `checkExpressionTypes`, which refuses it by its type.
 */
export const checkExpression = (
  source: string,
  options: CheckOptions = {}
): CheckedExpression => {
  const roots = checkRoots(options.roots);
  let parsed: ReturnType<typeof parseExpression>;
  try {
    // As a module, as the generated code is one: strict, no HTML comments.
    // No plugins: TypeScript's syntax and JSX are refused.
    parsed = parseExpression(source, { sourceType: "module", plugins: [] });
  } catch (error) {
    return { ok: false, errors: [syntaxError(source, error)] };
  }
  const checker = new Checker(roots);
  checker.visit(parsed, roots);
  if (checker.errors.length > 0) {
    return { ok: false, errors: checker.errors };
  }
  return {
    ok: true,
    source,
    ...lowerExpression(parsed, roots),
    forTypes: typeForm(parsed, source, parsed.comments ?? []),
  };
};
