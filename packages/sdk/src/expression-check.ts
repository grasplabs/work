import type {
  Argument,
  ArrowFunctionExpression,
  CallExpression,
  Expression,
  ObjectPropertyKind,
} from "@oxc-project/types";

import { isIdentifier } from "./code-print.ts";
import {
  jsonCallOf,
  literalKey,
  literalValue,
  lowerExpression,
} from "./expression-lowering.ts";
import type {
  ExpressionNode,
  ExpressionRead,
  JsonMethod,
} from "./expression-lowering.ts";
import { allowedMethods, callbackMethods } from "./expression-runtime.ts";
import { parseExpression } from "./oxc-parse.ts";

export { runtimeNames } from "./expression-lowering.ts";
export type { ExpressionRead } from "./expression-lowering.ts";
// The methods an expression can call, for the type check's own refusal
// of a method read without a call (`expressionTypeCheck`).
export { allowedMethods } from "./expression-runtime.ts";

/**
 * Workflow expressions, in JavaScript: what a JSON workflow writes where
 * a value is computed from the run's data, such as
 * `extract.lines.filter((line) => line.total > params.limit)`. The
 * generator writes each checked expression's code (`code`) into the
 * workflow's generated TypeScript as plain JavaScript (`invoice.id`), so
 * it runs in the workflow's isolate with no interpreter, under the
 * isolate's CPU and memory limits.
 *
 * Threat model, and how each is closed:
 *
 * - Reaching a prototype, and from there `Function`. The check refuses
 *   every name of `blockedProperties` (`__proto__`, `constructor`,
 *   `prototype`, the accessor helpers) wherever a name stands: a member
 *   read, a literal key in brackets (`a["__proto__"]`), an object
 *   literal's key or shorthand (`{ __proto__: a }`, `{ constructor }`).
 *   `in` and `instanceof`, which ask about prototypes, are refused. Every
 *   value an expression starts from is JSON copied into frozen objects
 *   with no prototype (the runtime's second layer, `frozenData` in
 *   workflow.ts), so a name the check missed finds nothing inherited, and
 *   the isolate's frozen intrinsics are a third.
 * - Computed names. A key in brackets is a string or number literal, held
 *   to the same names; `a[b]`, `a[1 + 1]` and template keys are refused,
 *   so every name an expression reads is in its source, for review.
 * - Holding a function value: filing a built-in method under an allowed
 *   name (`{ at: [].forEach }.at(…)`) or handing one to an implicit
 *   conversion (`${{ toString: list.reverse }}`). The only functions an
 *   expression writes are the arrows it passes to a callback method; it
 *   calls only `allowedMethods`, by name, in call position; and a field
 *   whose name a built-in prototype has as a function is read through
 *   `own` (expression-runtime.ts), which gives only an own field. JSON
 *   holds no function, so no read gives one.
 * - Replay giving another value. An expression reads only its roots
 *   (journaled values and the run's frozen args, parameters and state)
 *   and callback parameters: no global, so no clock, randomness or
 *   environment. Evaluated again on replay, it gives the same value.
 *
 * Two lines of defence, then: the check, which parses an expression by
 * oxc (oxc-parse.ts), as JavaScript in a module, and holds its syntax
 * tree to an allowlist (anything else is refused, with a position and a
 * fix, and a syntax added to JavaScript later is refused until it is
 * allowed here); and the code, printed from the checked tree
 * (`Lowering`), never from its source, over data with no prototype.
 *
 * Work is bounded by the isolate, not here: with no loops and no
 * function that can call itself, an expression's work is at most
 * polynomial in its data (a `map` inside a `map`), and the isolate's CPU
 * limit stops it.
 */

/** The workflow's values an expression may start from, by default. */
export const expressionRoots = ["args", "params", "run"] as const;

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
 * imports `own` under `runtimeNames.own`. Never write it right after an identifier on
 * the line before: `name\n(…)` is a call.
 */
type CheckedExpression =
  | {
      ok: true;
      source: string;
      code: string;
      /** The reads of its roots, for the caller to hold to where it stands. */
      reads: ExpressionRead[];
      /**
       * The most array and object literals it nests, one in another: how
       * deep what it writes is at least, whatever it reads.
       */
      literalDepth: number;
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

/** JavaScript's line terminators, as oxc and TypeScript count lines. */
const lineBreak = /\r\n?|[\n\u2028\u2029]/gu;

/** A problem at `offset` of `source`, with its line and column there. */
const located = (
  source: string,
  code: ExpressionErrorCode,
  message: string,
  offset: number
): ExpressionError => {
  const before = source.slice(0, offset).split(lineBreak);
  return {
    code,
    message,
    fix: fixes[code],
    offset,
    line: before.length,
    column: (before.at(-1)?.length ?? 0) + 1,
  };
};

/**
 * A callback as `callbackMethods` take it: `(a, b) => expression`. Its
 * parameters' names don't start with `$`, which the generated code's own
 * names do (`runtimeNames`), so none can shadow them.
 */
const isCallbackArrow = (
  node: Argument
): node is ArrowFunctionExpression & { body: Expression } =>
  node.type === "ArrowFunctionExpression" &&
  !node.async &&
  node.body.type !== "BlockStatement" &&
  node.params.every(
    (param) => param.type === "Identifier" && !param.name.startsWith("$")
  );

/** A node's type as an error names it: a regular expression's and a BigInt's by kind. */
const typeName = (node: ExpressionNode): string => {
  if (node.type === "Literal" && "regex" in node) {
    return "RegExpLiteral";
  }
  if (node.type === "Literal" && "bigint" in node) {
    return "BigIntLiteral";
  }
  if (node.type === "ImportExpression") {
    return "Import";
  }
  // An entry refused is a getter, a setter or a method: not a field.
  return node.type === "Property" ? "ObjectMethod" : node.type;
};

class Checker {
  readonly errors: ExpressionError[] = [];

  private readonly source: string;

  /** The roots, as a global's error names them. */
  private readonly rootList: string;

  /** The nodes that stood in parentheses (oxc-parse.ts). */
  private readonly parenthesized: ReadonlySet<object>;

  constructor(
    source: string,
    roots: ReadonlySet<string>,
    parenthesized: ReadonlySet<object>
  ) {
    this.source = source;
    this.rootList = [...roots].join(", ");
    this.parenthesized = parenthesized;
  }

  private fail(
    node: { start: number },
    code: ExpressionErrorCode,
    message: string
  ): void {
    this.errors.push(located(this.source, code, message, node.start));
  }

  private property(node: ExpressionNode, name: string): void {
    if (blocked.has(name)) {
      this.fail(node, "expression.property", `\`${name}\` can't be read.`);
    }
  }

  /** A member's key: a name, or a literal in brackets, never computed. */
  private key(node: ExpressionNode, computed: boolean): void {
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

  private call(node: CallExpression, scope: ReadonlySet<string>): void {
    const { callee } = node;
    const json = jsonCallOf(node, scope);
    if (json !== undefined) {
      this.jsonCall(node, json, scope);
      return;
    }
    if (
      callee.type !== "MemberExpression" ||
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
    if (this.parenthesized.has(callee)) {
      this.fail(
        callee,
        "expression.syntax",
        `Call \`${method}\` directly, without parentheses around it.`
      );
      return;
    }
    if (node.optional) {
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
      const inner = new Set(scope);
      for (const param of callback.params) {
        if (param.type === "Identifier") {
          inner.add(param.name);
        }
      }
      this.visit(callback.body, inner);
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

  /**
   * `JSON.stringify(value)` or `JSON.parse(text)`: called directly, never
   * optionally or from parentheses, on one value, with no reviver,
   * replacer or indent, so no function of an expression's own runs in it.
   */
  private jsonCall(
    node: CallExpression,
    method: JsonMethod,
    scope: ReadonlySet<string>
  ): void {
    const [argument, ...more] = node.arguments;
    const { callee } = node;
    if (
      this.parenthesized.has(callee) ||
      node.optional ||
      (callee.type === "MemberExpression" && callee.optional)
    ) {
      this.fail(
        node,
        "expression.syntax",
        `Call \`JSON.${method}\` directly, as \`JSON.${method}(value)\`.`
      );
      return;
    }
    if (
      argument === undefined ||
      more.length > 0 ||
      argument.type === "SpreadElement"
    ) {
      this.fail(
        node,
        "expression.syntax",
        `\`JSON.${method}\` takes one value, and nothing else.`
      );
      return;
    }
    this.visit(argument, scope);
  }

  /** A call's arguments, each a value: no spread into a call. */
  private values(nodes: readonly Argument[], scope: ReadonlySet<string>): void {
    for (const node of nodes) {
      if (node.type === "SpreadElement") {
        this.fail(node, "expression.syntax", "A call takes no spread.");
      } else {
        this.visit(node, scope);
      }
    }
  }

  /** An object literal's entry: a field, or a spread. */
  private entry(
    property: ObjectPropertyKind,
    scope: ReadonlySet<string>
  ): void {
    // Copies a JSON value's own fields into a new literal: no getter of
    // its own runs, as JSON holds none.
    if (property.type === "SpreadElement") {
      this.visit(property.argument, scope);
      return;
    }
    if (property.kind !== "init" || property.method) {
      this.refuse(property);
      return;
    }
    if (property.computed) {
      this.key(property.key, true);
    } else {
      const name = literalKey(property.key);
      if (name !== undefined) {
        this.property(property.key, name);
      }
    }
    this.visit(property.value, scope);
  }

  /** A node of a type the subset doesn't have. */
  private refuse(node: ExpressionNode): void {
    this.fail(
      node,
      "expression.syntax",
      `${typeName(node)} is not part of what an expression can be.`
    );
  }

  // One case per node type the subset allows; anything else is refused,
  // so the list is the subset. Its length is the subset's, not complexity.
  // oxlint-disable-next-line eslint/complexity -- see above
  visit(node: Expression, scope: ReadonlySet<string>): void {
    // Not exhaustive on purpose: `default` refuses every other node type.
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- see above
    switch (node.type) {
      case "Identifier": {
        // `undefined` is a value, as `null` is: the global can't be written
        // or redefined, so it reads the same in every isolate.
        if (!scope.has(node.name) && node.name !== "undefined") {
          this.fail(
            node,
            "expression.global",
            `\`${node.name}\` is not one of the workflow's values: ${this.rootList}.`
          );
        }
        break;
      }
      case "Literal": {
        if (literalValue(node) === undefined) {
          this.refuse(node);
        }
        break;
      }
      case "TemplateLiteral": {
        for (const expression of node.expressions) {
          this.visit(expression, scope);
        }
        break;
      }
      case "MemberExpression": {
        this.visit(node.object, scope);
        // A field named like a method (`at`, `map`) is data, and `own`
        // reads it (`inheritedNames`): a method read without a call is no
        // own field, so it never gives the function.
        if (node.property.type === "PrivateIdentifier") {
          this.refuse(node.property);
        } else {
          this.key(node.property, node.computed);
        }
        break;
      }
      case "CallExpression": {
        this.call(node, scope);
        break;
      }
      case "ArrayExpression": {
        for (const element of node.elements) {
          if (element === null) {
            this.fail(node, "expression.syntax", "An array has no holes.");
          } else if (element.type === "SpreadElement") {
            // Copies a JSON value's own items: no iterator of its own
            // runs, as JSON holds none.
            this.visit(element.argument, scope);
          } else {
            this.visit(element, scope);
          }
        }
        break;
      }
      case "ObjectExpression": {
        for (const property of node.properties) {
          this.entry(property, scope);
        }
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
        if (node.left.type === "PrivateIdentifier") {
          this.refuse(node.left);
          return;
        }
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
        this.refuse(node);
      }
    }
  }
}

/**
 * A root's name: ASCII, unescaped, so it reads the same wherever it's
 * written, and not starting with `$`, as the generated code's names do.
 */
const plainName = /^[A-Za-z_][\w$]*$/u;

/**
 * Whether `name` binds as a parameter in a module: no reserved word, nor
 * `eval` or `arguments`, which strict code binds to nothing.
 */
const isBindable = (name: string): boolean =>
  isIdentifier(name) && name !== "eval" && name !== "arguments";

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
interface CheckOptions {
  /** Roots beside `expressionRoots`, which are always in scope. */
  readonly roots?: readonly string[];
}

/**
 * Checks a workflow expression against the subset: every problem found,
 * each with its code, position and fix, or the source to generate from.
 * Throws when a root in `options` is not one `checkRoots` takes.
 */
export const checkExpression = (
  source: string,
  options: CheckOptions = {}
): CheckedExpression => {
  const roots = checkRoots(options.roots);
  // As a module, as the generated code is one: strict, no HTML comments.
  // JavaScript: TypeScript's syntax and JSX are refused.
  const parsed = parseExpression(source, "js");
  if (!parsed.ok) {
    return {
      ok: false,
      errors: [
        located(
          source,
          "expression.syntax",
          `The expression doesn't parse: ${parsed.message}`,
          parsed.offset
        ),
      ],
    };
  }
  const checker = new Checker(source, roots, parsed.parenthesized);
  checker.visit(parsed.node, roots);
  if (checker.errors.length > 0) {
    return { ok: false, errors: checker.errors };
  }
  return {
    ok: true,
    source,
    ...lowerExpression(parsed.node, roots, parsed.parenthesized),
  };
};
