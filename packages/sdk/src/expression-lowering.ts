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

/**
 * A comparison, which the generated code and the type form put in
 * parentheses: TypeScript reads `a < b, c > (d)` as a generic call with
 * type arguments `b, c`, but no type argument list closes across a `)`.
 */
const isComparison = (node: Node): boolean =>
  node.type === "BinaryExpression" &&
  (node.operator === "<" ||
    node.operator === ">" ||
    node.operator === "<=" ||
    node.operator === ">=");

const nonNull = <T>(value: T | null): T => {
  if (value === null) {
    throw new Error("A checked array has no holes.");
  }
  return value;
};

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
  | { kind: "call"; method: string; args: Node[]; optional: boolean };

/** Whether `node` is a chain of reads and calls. */
const isChain = (node: Node): boolean =>
  node.type === "MemberExpression" ||
  node.type === "OptionalMemberExpression" ||
  node.type === "CallExpression" ||
  node.type === "OptionalCallExpression";

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
 * The base of the chain `node` and its links, from the base out. With
 * `parentheses`, a chain in parentheses is a base of its own: `(a?.b).c`
 * reads `.c` of what `a?.b` gives, `undefined` included, and throws
 * there.
 */
const linksOf = (
  node: Node,
  parentheses: boolean
): { base: Node; links: Link[] } => {
  const links: Link[] = [];
  let base = node;
  for (;;) {
    if (parentheses && base !== node && base.extra?.parenthesized === true) {
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
      return { base, links };
    }
  }
  return { base, links };
};

/**
 * A checked syntax tree as the code that runs, printed from the tree
 * itself (`@babel/generator`), never from the source: what runs is what
 * was checked. Every member read goes through `$read` and every call
 * through `$call` (expression-runtime.ts), a `?.` through `$opt`; every
 * comparison is in parentheses (`isComparison`); and every object key is
 * a computed string, so `__proto__` is an own field, never the prototype.
 */
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

class Lowering {
  /** The parameters `$opt`'s callbacks take: `$0`, `$1`, … */
  private next = 0;

  readonly reads: ExpressionRead[] = [];

  /** The array and object literals around what is lowered now. */
  private literals = 0;

  /** The most array and object literals it nests, one in another. */
  deepest = 0;

  private readonly roots: ReadonlySet<string>;

  /** The callback parameters in scope, which a root's name may shadow. */
  private readonly bound: string[] = [];

  constructor(roots: ReadonlySet<string>) {
    this.roots = roots;
  }

  /** Records a read of `name` with `path`, if `name` is a root there. */
  private read(name: string, path: readonly (string | number)[]): void {
    if (this.roots.has(name) && !this.bound.includes(name)) {
      this.reads.push({ root: name, path });
    }
  }

  /** An array or object literal, its values lowered. */
  private literal(node: Node): t.Expression {
    if (node.type === "ArrayExpression") {
      return t.arrayExpression(
        node.elements.map((element) =>
          element?.type === "SpreadElement"
            ? t.spreadElement(this.expression(element.argument))
            : this.expression(nonNull(element))
        )
      );
    }
    if (node.type !== "ObjectExpression") {
      throw new Error(`A literal is no ${node.type}.`);
    }
    return t.objectExpression(
      node.properties.map((property) => {
        if (property.type === "SpreadElement") {
          return t.spreadElement(this.expression(property.argument));
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

  expression(node: Node): t.Expression {
    // oxlint-disable-next-line typescript/switch-exhaustiveness-check -- the checker allows no other
    switch (node.type) {
      case "Identifier": {
        this.read(node.name, []);
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
      case "ArrayExpression":
      case "ObjectExpression": {
        this.literals += 1;
        this.deepest = Math.max(this.deepest, this.literals);
        const literal = this.literal(node);
        this.literals -= 1;
        return literal;
      }
      case "UnaryExpression": {
        return t.unaryExpression(node.operator, this.expression(node.argument));
      }
      case "BinaryExpression": {
        if (node.left.type === "PrivateName") {
          throw new Error("A checked expression has no private names.");
        }
        const binary = t.binaryExpression(
          node.operator,
          this.expression(node.left),
          this.expression(node.right)
        );
        return isComparison(node) ? t.parenthesizedExpression(binary) : binary;
      }
      case "LogicalExpression": {
        return t.logicalExpression(
          node.operator,
          this.expression(node.left),
          this.expression(node.right)
        );
      }
      case "ConditionalExpression": {
        return t.conditionalExpression(
          this.expression(node.test),
          this.expression(node.consequent),
          this.expression(node.alternate)
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
  private chain(node: Node, read = true): t.Expression {
    // What it reads is the whole chain's, parentheses or not:
    // `(steps.fetch).output` reads `steps.fetch.output`. A chain in
    // parentheses is evaluated as one of its own all the same, below.
    const whole = linksOf(node, false);
    if (read && whole.base.type === "Identifier") {
      this.read(whole.base.name, pathOf(whole.links));
    }
    const { base, links } = linksOf(node, true);
    if (base.type === "Identifier") {
      return this.links(t.identifier(base.name), links, 0);
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
    const params = node.params.map((param) => {
      if (param.type !== "Identifier") {
        throw new Error("A checked callback has only plain parameters.");
      }
      return param.name;
    });
    this.bound.push(...params);
    const body = this.expression(node.body);
    this.bound.splice(this.bound.length - params.length);
    return t.arrowFunctionExpression(
      params.map((name) => t.identifier(name)),
      body
    );
  }
}

/**
 * The code a checked expression runs as (`Lowering`): one parenthesized
 * expression, with no comment, printed from its syntax tree; the reads
 * of `roots` it makes; and the most array and object literals it nests,
 * one in another, as deep as what it writes is at least.
 */
export const lowerExpression = (
  checked: Node,
  roots: ReadonlySet<string>
): { code: string; reads: ExpressionRead[]; literalDepth: number } => {
  const lowering = new Lowering(roots);
  const lowered = lowering.expression(checked);
  return {
    code: `(${generate(lowered, { comments: false }).code})`,
    reads: lowering.reads,
    literalDepth: lowering.deepest,
  };
};

/**
 * An expression as TypeScript type-checks it: its source with every
 * comparison in parentheses (`isComparison`), as its code has them, and
 * every comment blanked, so TypeScript reads what JavaScript does
 * (`[a < b, c > (d)]` as two comparisons, never a generic call) and no
 * `// @ts-ignore` reaches it. The source plus parentheses, not printed,
 * so a position in `code` leads back to the source exactly
 * (`sourcePosition`). It has no guards, so its types are the data's.
 */
export interface TypeForm {
  readonly code: string;
  /** Where in `code` the added parentheses are, in order. */
  readonly added: readonly number[];
}

/** JavaScript's line terminators, as Babel and TypeScript count lines. */
const lineBreak = /\r\n?|[\n\u2028\u2029]/u;

/**
 * Each UTF-16 unit that isn't a line terminator, to blank a comment and
 * keep its lines and length: without `u`, an emoji's two units are two
 * spaces, as the parentheses' offsets count it.
 */
// oxlint-disable-next-line eslint/require-unicode-regexp -- see above
const notLineBreak = /[^\r\n\u2028\u2029]/g;

/** The checked tree's source as `TypeForm` holds it. */
export const typeForm = (
  checked: Node,
  source: string,
  comments: readonly Comment[]
): TypeForm => {
  // Parentheses to add, by source offset: closing before opening where
  // one comparison ends as the next begins.
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
    if (isComparison(node)) {
      wrap(node);
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
