import { generate } from "@babel/generator";
import * as t from "@babel/types";
import type { Node } from "@babel/types";

/** A property's name as JavaScript reads it, when written as a literal. */
export const literalKey = (node: Node): string | undefined => {
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

const parenthesized = (node: t.Expression): t.Expression =>
  t.parenthesizedExpression(node);

const nonNull = <T>(value: T | null): T => {
  if (value === null) {
    throw new Error("A checked array has no holes.");
  }
  return value;
};

/**
 * The names the generated code calls its guards by. The workflow module
 * imports them so (`runtimeImport`); no root or callback parameter can
 * take them, as neither starts with `$`.
 */
export const runtimeNames = {
  read: "$read",
  call: "$call",
  optional: "$opt",
  spread: "$spread",
  json: "$json",
} as const;

/** How a generated workflow module imports the guards its expressions call. */
export const runtimeImport = `import { readMember as ${runtimeNames.read}, callMethod as ${runtimeNames.call}, optionalChain as ${runtimeNames.optional}, spreadValue as ${runtimeNames.spread}, checkJson as ${runtimeNames.json} } from "@grasp-os/sdk/workflow";`;

/** A link of a member chain: `.key`, `[0]` or `.method(…)`, after `?.` or not. */
type Link =
  | { kind: "member"; key: string | number; optional: boolean }
  | { kind: "call"; method: string; args: Node[]; optional: boolean };

const keyOf = (node: Node): string | number => {
  if (node.type === "NumericLiteral") {
    return node.value;
  }
  const name = literalKey(node);
  if (name === undefined) {
    throw new Error("A checked expression has only literal keys.");
  }
  return name;
};

/**
 * A checked syntax tree as the code that runs, printed from the tree
 * itself (`@babel/generator`), never from the source: what runs is what
 * was checked. Every member read goes through `$read` and every call
 * through `$call` (expression-runtime.ts), a `?.` through `$opt`; every
 * operand is parenthesized, so TypeScript reads no comparison as type
 * arguments (`[a < b, c > (d)]`); and every object key is a computed
 * string, so `__proto__` is an own field, never the prototype.
 */
class Lowering {
  /** The parameters `$opt`'s callbacks take: `$0`, `$1`, … */
  private next = 0;

  /** The roots the expression reads, which it checks are JSON first. */
  readonly readRoots = new Set<string>();

  private readonly roots: ReadonlySet<string>;

  constructor(roots: ReadonlySet<string>) {
    this.roots = roots;
  }

  /** `...value`, of a plain array or object only (`$spread`). */
  private spread(node: Node): t.SpreadElement {
    return t.spreadElement(
      t.callExpression(t.identifier(runtimeNames.spread), [
        this.expression(node),
      ])
    );
  }

  expression(node: Node): t.Expression {
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the checker allows no other
    switch (node.type) {
      case "Identifier": {
        if (this.roots.has(node.name)) {
          this.readRoots.add(node.name);
        }
        return t.identifier(node.name);
      }
      case "StringLiteral": {
        return t.stringLiteral(node.value);
      }
      case "NumericLiteral": {
        return t.numericLiteral(node.value);
      }
      case "BooleanLiteral": {
        return t.booleanLiteral(node.value);
      }
      case "NullLiteral": {
        return t.nullLiteral();
      }
      case "TemplateLiteral": {
        return t.templateLiteral(
          node.quasis.map((quasi) =>
            t.templateElement(
              { raw: quasi.value.raw, cooked: quasi.value.cooked },
              quasi.tail
            )
          ),
          node.expressions.map((expression) => this.expression(expression))
        );
      }
      case "ArrayExpression": {
        return t.arrayExpression(
          node.elements.map((element) =>
            element?.type === "SpreadElement"
              ? this.spread(element.argument)
              : this.expression(nonNull(element))
          )
        );
      }
      case "ObjectExpression": {
        return t.objectExpression(
          node.properties.map((property) => {
            if (property.type === "SpreadElement") {
              return this.spread(property.argument);
            }
            if (property.type !== "ObjectProperty") {
              throw new Error("A checked object literal has only fields.");
            }
            return t.objectProperty(
              t.stringLiteral(String(keyOf(property.key))),
              this.expression(property.value),
              true
            );
          })
        );
      }
      case "UnaryExpression": {
        return t.unaryExpression(
          node.operator,
          parenthesized(this.expression(node.argument))
        );
      }
      case "BinaryExpression": {
        if (node.left.type === "PrivateName") {
          throw new Error("A checked expression has no private names.");
        }
        return t.binaryExpression(
          node.operator,
          parenthesized(this.expression(node.left)),
          parenthesized(this.expression(node.right))
        );
      }
      case "LogicalExpression": {
        return t.logicalExpression(
          node.operator,
          parenthesized(this.expression(node.left)),
          parenthesized(this.expression(node.right))
        );
      }
      case "ConditionalExpression": {
        return t.conditionalExpression(
          parenthesized(this.expression(node.test)),
          parenthesized(this.expression(node.consequent)),
          parenthesized(this.expression(node.alternate))
        );
      }
      case "MemberExpression":
      case "OptionalMemberExpression":
      case "CallExpression":
      case "OptionalCallExpression": {
        return this.chain(node);
      }
      default: {
        throw new Error(`A checked expression has no ${node.type}.`);
      }
    }
  }

  /** A chain of reads and calls, from its base out, `?.` links and all. */
  private chain(node: Node): t.Expression {
    const links: Link[] = [];
    let base = node;
    for (;;) {
      if (
        base.type === "MemberExpression" ||
        base.type === "OptionalMemberExpression"
      ) {
        links.unshift({
          kind: "member",
          key: keyOf(base.property),
          optional: base.type === "OptionalMemberExpression" && base.optional,
        });
        base = base.object;
      } else if (
        (base.type === "CallExpression" ||
          base.type === "OptionalCallExpression") &&
        (base.callee.type === "MemberExpression" ||
          base.callee.type === "OptionalMemberExpression") &&
        base.callee.property.type === "Identifier"
      ) {
        links.unshift({
          kind: "call",
          method: base.callee.property.name,
          args: base.arguments,
          optional:
            base.callee.type === "OptionalMemberExpression" &&
            base.callee.optional,
        });
        base = base.callee.object;
      } else {
        break;
      }
    }
    return this.links(this.expression(base), links, 0);
  }

  /**
   * `links[from…]` applied to `value`. At a `?.` link, the rest of the
   * chain runs only for a value that isn't nullish, as JavaScript's
   * short-circuit does: `$opt(value, ($0) => rest)`.
   */
  private links(
    value: t.Expression,
    links: readonly Link[],
    from: number,
    entered = false
  ): t.Expression {
    const link = links[from];
    if (link === undefined) {
      return value;
    }
    if (link.optional && !entered) {
      const parameter = t.identifier(`$${this.next}`);
      this.next += 1;
      return t.callExpression(t.identifier(runtimeNames.optional), [
        value,
        t.arrowFunctionExpression(
          [parameter],
          this.links(parameter, links, from, true)
        ),
      ]);
    }
    const applied =
      link.kind === "member"
        ? t.callExpression(t.identifier(runtimeNames.read), [
            value,
            typeof link.key === "number"
              ? t.numericLiteral(link.key)
              : t.stringLiteral(link.key),
          ])
        : t.callExpression(t.identifier(runtimeNames.call), [
            value,
            t.stringLiteral(link.method),
            t.arrayExpression(link.args.map((arg) => this.argument(arg))),
          ]);
    return this.links(applied, links, from + 1);
  }

  /** A call's argument: a value, or the callback arrow written there. */
  private argument(node: Node): t.Expression {
    if (node.type !== "ArrowFunctionExpression") {
      return this.expression(node);
    }
    return t.arrowFunctionExpression(
      node.params.map((param) => {
        if (param.type !== "Identifier") {
          throw new Error("A checked callback has only plain parameters.");
        }
        return t.identifier(param.name);
      }),
      parenthesized(this.expression(node.body))
    );
  }
}

/**
 * The code a checked expression runs as (`Lowering`): one parenthesized
 * expression, with no comment, printed from its syntax tree. It first
 * checks that each root it reads is JSON (`$json`), on every evaluation,
 * so what the guards rely on holds whatever the caller passed.
 */
export const lowerExpression = (
  checked: Node,
  roots: ReadonlySet<string>
): string => {
  const lowering = new Lowering(roots);
  const value = lowering.expression(checked);
  const read = [...lowering.readRoots];
  const expression =
    read.length === 0
      ? value
      : t.sequenceExpression([
          t.callExpression(
            t.identifier(runtimeNames.json),
            read.map((root) => t.identifier(root))
          ),
          t.parenthesizedExpression(value),
        ]);
  return `(${generate(expression, { comments: false }).code})`;
};
