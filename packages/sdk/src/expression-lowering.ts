import { generate } from "@babel/generator";
import * as t from "@babel/types";
import type { Comment, Node } from "@babel/types";

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
 * through `$call` (expression-runtime.ts), a `?.` through `$opt`, a
 * spread through `$spread`; every operand and every comparison is
 * parenthesized, so TypeScript reads no comparison as type arguments
 * (`[a < b, c > (d)]`); and every object key is a computed
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
        // The comparison itself in parentheses too: TypeScript reads
        // `(a) < (b), (c) > (d)` as type arguments, since `(b)` is a type,
        // but no type argument list closes across a `)`.
        return parenthesized(
          t.binaryExpression(
            node.operator,
            parenthesized(this.expression(node.left)),
            parenthesized(this.expression(node.right))
          )
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
      // A chain in parentheses is one of its own: `(a?.b).c` reads `.c`
      // of what `a?.b` gives, `undefined` included, and throws there.
      if (base !== node && base.extra?.parenthesized === true) {
        break;
      }
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

/**
 * An expression as TypeScript type-checks it: its source with every
 * operand and comparison in parentheses (as `Lowering` writes them) and
 * every comment blanked, so TypeScript reads
 * what JavaScript does (`[a < b, c > (d)]` as two comparisons, never a
 * generic call) and no `// @ts-ignore` reaches it. Built from the checked
 * tree's node positions rather than printed, so a position in `code` leads back
 * to the source exactly (`sourcePosition`). It has no guards, so its
 * types are the data's.
 */
export interface TypeForm {
  readonly code: string;
  /** Where in `code` the added parentheses are, in order. */
  readonly added: readonly number[];
}

/** JavaScript's line terminators, as Babel and TypeScript count lines. */
const lineBreak = /\r\n?|[\n\u2028\u2029]/u;

/** Whatever isn't a line terminator, to blank a comment and keep its lines. */
const notLineBreak = /[^\r\n\u2028\u2029]/gu;

/** The checked tree's source as `TypeForm` holds it. */
export const typeForm = (
  checked: Node,
  source: string,
  comments: readonly Comment[]
): TypeForm => {
  // Parentheses to add, by source offset: closing before opening where
  // one operand ends as the next begins.
  const insertions: { at: number; text: ")" | "(" }[] = [];
  const wrap = (node: Node): void => {
    if (node.start === null || node.start === undefined) {
      throw new Error("A parsed node has its position.");
    }
    if (node.end === null || node.end === undefined) {
      throw new Error("A parsed node has its position.");
    }
    insertions.push({ at: node.start, text: "(" }, { at: node.end, text: ")" });
  };
  t.traverseFast(checked, (node) => {
    if (node.type === "BinaryExpression") {
      // As `Lowering` writes one: the operator's own parentheses keep
      // TypeScript from reading `(a) < (b), (c) > (d)` as type arguments.
      wrap(node);
      wrap(node.left);
      wrap(node.right);
    } else if (node.type === "LogicalExpression") {
      wrap(node.left);
      wrap(node.right);
    } else if (node.type === "ConditionalExpression") {
      wrap(node.test);
      wrap(node.consequent);
      wrap(node.alternate);
    } else if (node.type === "UnaryExpression") {
      wrap(node.argument);
    }
  });
  const order = { ")": 0, "(": 1 };
  insertions.sort((a, b) => a.at - b.at || order[a.text] - order[b.text]);
  let blanked = source;
  for (const { start, end } of comments) {
    blanked = `${blanked.slice(0, start)}${blanked.slice(start, end).replaceAll(notLineBreak, " ")}${blanked.slice(end)}`;
  }
  let code = "";
  let from = 0;
  const added: number[] = [];
  for (const { at, text } of insertions) {
    code += blanked.slice(from, at);
    added.push(code.length);
    code += text;
    from = at;
  }
  code += blanked.slice(from);
  return { code, added };
};

/** A 1-based line and column in `text` as an offset. */
const offsetOf = (text: string, line: number, column: number): number => {
  let offset = 0;
  let rest = text;
  for (let current = 1; current < line; current += 1) {
    const found = lineBreak.exec(rest);
    if (found === null) {
      break;
    }
    const next = found.index + found[0].length;
    offset += next;
    rest = rest.slice(next);
  }
  return offset + column - 1;
};

/** An offset in `text` as a 1-based line and column. */
const positionOf = (
  text: string,
  offset: number
): { line: number; column: number } => {
  const before = text.slice(0, offset).split(lineBreak);
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
};

/**
 * Where a position in a `TypeForm`'s code (1-based line and column) is in
 * the expression's source: the same character, or the one an added
 * parenthesis stands before.
 */
export const sourcePosition = (
  form: TypeForm,
  source: string,
  line: number,
  column: number
): { line: number; column: number } => {
  const offset = offsetOf(form.code, line, column);
  const shift = form.added.filter((at) => at < offset).length;
  return positionOf(source, Math.min(offset - shift, source.length));
};
