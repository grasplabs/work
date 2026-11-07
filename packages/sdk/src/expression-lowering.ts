import type {
  Argument,
  ArrayExpressionElement,
  Expression,
  ObjectPropertyKind,
  PropertyKey,
} from "@oxc-project/types";

import { print } from "./code-print.ts";
import type { Code, Property, Spread } from "./code-print.ts";

/** A node of a parsed expression, or of what its nodes hold. */
export type ExpressionNode =
  | Expression
  | PropertyKey
  | Argument
  | ObjectPropertyKind;

/** A literal's value: a string, number, boolean or null; undefined for anything else. */
export const literalValue = (
  node: ExpressionNode
): string | number | boolean | null | undefined => {
  if (node.type !== "Literal" || "regex" in node || "bigint" in node) {
    return undefined;
  }
  const { value } = node;
  return typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
    ? value
    : undefined;
};

/** A property's name as JavaScript reads it, when written as a literal. */
export const literalKey = (node: ExpressionNode): string | undefined => {
  if (node.type === "Identifier") {
    return node.name;
  }
  const value = literalValue(node);
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
};

/**
 * A comparison, which the generated code puts in parentheses: TypeScript
 * reads `a < b, c > (d)` as a generic call with type arguments `b, c`, but
 * no type argument list closes across a `)`.
 */
const isComparison = (node: Expression): boolean =>
  node.type === "BinaryExpression" &&
  (node.operator === "<" ||
    node.operator === ">" ||
    node.operator === "<=" ||
    node.operator === ">=");

/**
 * The names the generated code calls its guards by: a generated module
 * imports `readMember`, `callMethod`, `optionalChain` and `jsonValue`
 * from `@grasp-os/sdk/workflow` under them. No root or callback parameter
 * can take them, as neither starts with `$`.
 */
export const runtimeNames = {
  read: "$read",
  call: "$call",
  optional: "$opt",
  json: "$json",
} as const;

/** A link of a member chain: `.key`, `[0]` or `.method(…)`, after `?.` or not. */
type Link =
  | { kind: "member"; key: string | number; optional: boolean }
  | { kind: "call"; method: string; args: Argument[]; optional: boolean };

/** Whether `node` is a chain of reads and calls. */
const isChain = (node: Expression): boolean =>
  node.type === "MemberExpression" || node.type === "CallExpression";

/** The keys `links` read before their first call. */
const pathOf = (links: readonly Link[]): (string | number)[] => {
  const path: (string | number)[] = [];
  for (const link of links) {
    if (link.kind !== "member") {
      break;
    }
    path.push(link.key);
  }
  return path;
};

const keyOf = (node: ExpressionNode): string | number => {
  const value = literalValue(node);
  if (typeof value === "number") {
    return value;
  }
  const name = literalKey(node);
  if (name === undefined) {
    throw new Error("A checked expression has only literal keys.");
  }
  return name;
};

const identifier = (name: string): Code => ({ type: "Identifier", name });

const call = (callee: string, args: Code[]): Code => ({
  type: "Call",
  callee: identifier(callee),
  arguments: args,
});

/**
 * A read of one of the roots: `steps.extract.output.total` is root
 * `steps` and path `["extract", "output", "total"]`, up to its first
 * call or computed step. What a caller holds an expression's reads to
 * where it stands (a step that ran before it, say).
 */
export interface ExpressionRead {
  readonly root: string;
  readonly path: readonly (string | number)[];
}

/**
 * A checked syntax tree as the code that runs, printed from the tree
 * itself (code-print.ts), never from the source: what runs is what was
 * checked. Every member read goes through `$read` and every call through
 * `$call` (expression-runtime.ts), a `?.` through `$opt`; every
 * comparison is in parentheses (`isComparison`); and every object key is
 * a computed string, so `__proto__` is an own field, never the prototype.
 */
class Lowering {
  /** The parameters `$opt`'s callbacks take: `$0`, `$1`, … */
  private next = 0;

  readonly reads: ExpressionRead[] = [];

  /** The array and object literals around what is lowered now. */
  private literals = 0;

  /** The most array and object literals it nests, one in another. */
  deepest = 0;

  private readonly roots: ReadonlySet<string>;

  /** The nodes that stood in parentheses (oxc-parse.ts). */
  private readonly parenthesized: ReadonlySet<object>;

  /** The callback parameters in scope, which a root's name may shadow. */
  private readonly bound: string[] = [];

  constructor(roots: ReadonlySet<string>, parenthesized: ReadonlySet<object>) {
    this.roots = roots;
    this.parenthesized = parenthesized;
  }

  /** Records a read of `name` with `path`, if `name` is a root there. */
  private read(name: string, path: readonly (string | number)[]): void {
    if (this.roots.has(name) && !this.bound.includes(name)) {
      this.reads.push({ root: name, path });
    }
  }

  /** An item of an array literal: a value, or one spread. */
  private element(element: ArrayExpressionElement): Code | Spread {
    if (element === null) {
      throw new Error("A checked array has no holes.");
    }
    return element.type === "SpreadElement"
      ? { type: "Spread", argument: this.expression(element.argument) }
      : this.expression(element);
  }

  /** An entry of an object literal: a field under a computed string key, or one spread. */
  private property(property: ObjectPropertyKind): Property | Spread {
    if (property.type === "SpreadElement") {
      return { type: "Spread", argument: this.expression(property.argument) };
    }
    return {
      type: "Property",
      key: String(keyOf(property.key)),
      computed: true,
      value: this.expression(property.value),
    };
  }

  /** An array or object literal, its values lowered. */
  private literal(node: Expression): Code {
    if (node.type === "ArrayExpression") {
      return {
        type: "Array",
        elements: node.elements.map((element) => this.element(element)),
      };
    }
    if (node.type !== "ObjectExpression") {
      throw new Error(`A literal is no ${node.type}.`);
    }
    return {
      type: "Object",
      properties: node.properties.map((property) => this.property(property)),
    };
  }

  expression(node: Expression): Code {
    const value = literalValue(node);
    if (node.type === "Literal") {
      if (value === undefined) {
        throw new Error("A checked expression has no such literal.");
      }
      if (typeof value === "string") {
        return { type: "String", value };
      }
      if (typeof value === "number") {
        return { type: "Number", value };
      }
      return typeof value === "boolean"
        ? { type: "Boolean", value }
        : { type: "Null" };
    }
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the checker allows no other
    switch (node.type) {
      case "Identifier": {
        this.read(node.name, []);
        return identifier(node.name);
      }
      case "TemplateLiteral": {
        return {
          type: "Template",
          quasis: node.quasis.map((quasi) => quasi.value.raw),
          expressions: node.expressions.map((expression) =>
            this.expression(expression)
          ),
        };
      }
      case "ArrayExpression":
      case "ObjectExpression": {
        this.literals += 1;
        this.deepest = Math.max(this.deepest, this.literals);
        const literal = this.literal(node);
        this.literals -= 1;
        return literal;
      }
      case "UnaryExpression": {
        return {
          type: "Unary",
          operator: node.operator,
          argument: this.expression(node.argument),
        };
      }
      case "BinaryExpression": {
        if (node.left.type === "PrivateIdentifier") {
          throw new Error("A checked expression has no private names.");
        }
        const binary: Code = {
          type: "Binary",
          operator: node.operator,
          left: this.expression(node.left),
          right: this.expression(node.right),
        };
        return isComparison(node)
          ? { type: "Parenthesized", expression: binary }
          : binary;
      }
      case "LogicalExpression": {
        return {
          type: "Logical",
          operator: node.operator,
          left: this.expression(node.left),
          right: this.expression(node.right),
        };
      }
      case "ConditionalExpression": {
        return {
          type: "Conditional",
          test: this.expression(node.test),
          consequent: this.expression(node.consequent),
          alternate: this.expression(node.alternate),
        };
      }
      case "MemberExpression":
      case "CallExpression": {
        return this.chain(node);
      }
      default: {
        throw new Error(`A checked expression has no ${node.type}.`);
      }
    }
  }

  /**
   * The base of the chain `node` and its links, from the base out. With
   * `parentheses`, a chain in parentheses is a base of its own: `(a?.b).c`
   * reads `.c` of what `a?.b` gives, `undefined` included, and throws
   * there.
   */
  private linksOf(
    node: Expression,
    parentheses: boolean
  ): { base: Expression; links: Link[] } {
    const links: Link[] = [];
    let base = node;
    for (;;) {
      if (parentheses && base !== node && this.parenthesized.has(base)) {
        return { base, links };
      }
      if (base.type === "MemberExpression") {
        links.unshift({
          kind: "member",
          key: keyOf(base.property),
          optional: base.optional,
        });
        base = base.object;
      } else if (
        base.type === "CallExpression" &&
        base.callee.type === "MemberExpression" &&
        !base.callee.computed &&
        base.callee.property.type === "Identifier"
      ) {
        links.unshift({
          kind: "call",
          method: base.callee.property.name,
          args: base.arguments,
          optional: base.callee.optional,
        });
        base = base.callee.object;
      } else {
        return { base, links };
      }
    }
  }

  /** A chain of reads and calls, from its base out, `?.` links and all. */
  private chain(node: Expression, read = true): Code {
    // What it reads is the whole chain's, parentheses or not:
    // `(steps.fetch).output` reads `steps.fetch.output`. A chain in
    // parentheses is evaluated as one of its own all the same, below.
    const whole = this.linksOf(node, false);
    if (read && whole.base.type === "Identifier") {
      this.read(whole.base.name, pathOf(whole.links));
    }
    const { base, links } = this.linksOf(node, true);
    if (base.type === "Identifier") {
      return this.links(identifier(base.name), links, 0);
    }
    // Its reads are the outer chain's, recorded above.
    const inner = isChain(base)
      ? this.chain(base, false)
      : this.expression(base);
    return this.links(inner, links, 0);
  }

  /**
   * `links[from…]` applied to `value`. At a `?.` link, the rest of the
   * chain runs only for a value that isn't nullish, as JavaScript's
   * short-circuit does: `$opt(value, ($0) => rest)`.
   */
  private links(
    value: Code,
    links: readonly Link[],
    from: number,
    entered = false
  ): Code {
    const link = links[from];
    if (link === undefined) {
      return value;
    }
    if (link.optional && !entered) {
      const parameter = `$${this.next}`;
      this.next += 1;
      return call(runtimeNames.optional, [
        value,
        {
          type: "Arrow",
          params: [parameter],
          body: this.links(identifier(parameter), links, from, true),
        },
      ]);
    }
    const applied =
      link.kind === "member"
        ? call(runtimeNames.read, [
            value,
            typeof link.key === "number"
              ? { type: "Number", value: link.key }
              : { type: "String", value: link.key },
          ])
        : call(runtimeNames.call, [
            value,
            { type: "String", value: link.method },
            {
              type: "Array",
              elements: link.args.map((arg) => this.argument(arg)),
            },
          ]);
    return this.links(applied, links, from + 1);
  }

  /** A call's argument: a value, or the callback arrow written there. */
  private argument(node: Argument): Code {
    if (node.type === "SpreadElement") {
      throw new Error("A checked call takes no spread.");
    }
    if (node.type !== "ArrowFunctionExpression") {
      return this.expression(node);
    }
    const params = node.params.map((param) => {
      if (param.type !== "Identifier") {
        throw new Error("A checked callback has only plain parameters.");
      }
      return param.name;
    });
    if (node.body.type === "BlockStatement") {
      throw new Error("A checked callback has an expression for its body.");
    }
    this.bound.push(...params);
    const body = this.expression(node.body);
    this.bound.splice(this.bound.length - params.length);
    return { type: "Arrow", params, body };
  }
}

/**
 * The code a checked expression runs as (`Lowering`): one parenthesized
 * expression, with no comment, printed from its syntax tree; the reads
 * of `roots` it makes; and the most array and object literals it nests,
 * one in another, as deep as what it writes is at least.
 */
export const lowerExpression = (
  checked: Expression,
  roots: ReadonlySet<string>,
  parenthesized: ReadonlySet<object>
): { code: string; reads: ExpressionRead[]; literalDepth: number } => {
  const lowering = new Lowering(roots, parenthesized);
  const lowered = lowering.expression(checked);
  return {
    code: `(${print(lowered)})`,
    reads: lowering.reads,
    literalDepth: lowering.deepest,
  };
};
