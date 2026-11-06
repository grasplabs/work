/**
 * Type-checks a workflow's JavaScript expressions (`@grasp-os/sdk/expression-check`)
 * against the types of what they read, on tsrs in the type checker's
 * isolate (checker.ts), diagnostics only: core sends the request this
 * builds, and reads the diagnostics back with it. A reference to a field,
 * step or method that isn't there is an error at its line and column in
 * the expression, as an author wrote it.
 *
 * Each expression is checked twice in the one module:
 * - `e<i>`, its source as JavaScript reads it (comparisons in
 *   parentheses, comments blanked), whose diagnostics are the author's
 *   type errors. A read stays a reference, so TypeScript narrows it as it
 *   would anywhere (`input.note && input.note.trim()`).
 * - `m<i>`, the same with every member read that isn't a call's callee
 *   wrapped in `$value(…)`, optional chains' links included, whose only
 *   use is the method-read refusal: `$value` refuses a value that is, or
 *   may be, a function (`$NoMethod`), so a method read without a call
 *   (`input.s.trim`, `input.s?.trim.length`), which `$read` gives no value,
 *   is a TypeScript error at the read. Every other diagnostic of `m<i>` is
 *   dropped: its reads are calls' results, which nothing narrows.
 *
 * The check is the author's help, not a guard: at run time `$read` gives
 * only a value's own data, never a function, so a method read it misses
 * reads `undefined`.
 */
import { parseExpression } from "@babel/parser";
import {
  allowedMethods,
  checkExpression,
  checkRoots,
} from "@grasp-os/sdk/expression-check";
import type { ExpressionError } from "@grasp-os/sdk/expression-check";

import type { Diagnostic } from "./diagnostic.ts";
import { serverTarget, typeCheckRequest } from "./type-check.ts";
import type { TypeCheckRequest } from "./type-check.ts";

/** Where the expressions are, as one module of their own. */
const modulePath = "expressions.ts";

/**
 * The types of an expression's values, as TypeScript type text the
 * generator writes from the workflow's schemas, never an author's text:
 * the run's input, each step's output by its ID, params and the run.
 */
export interface ExpressionScopeTypes {
  readonly input: string;
  readonly steps: Readonly<Record<string, string>>;
  readonly params: string;
  readonly run: string;
  /**
   * Roots beside those four, by name, with their types: `item` inside a
   * `forEach`, `error` in a catch. Each name is held to what
   * `checkExpression` takes as a root: a plain identifier, never a
   * global's name.
   */
  readonly roots?: Readonly<Record<string, string>>;
}

/** An expression, by its source. */
export interface TypedExpression {
  readonly source: string;
}

/** A problem in an expression: the subset's (`expression.*`) or TypeScript's (`TS2339`). */
export interface ExpressionTypeError {
  code: string;
  message: string;
  /** 1-based, in the expression's source. */
  line: number;
  /** 1-based. */
  column: number;
}

export interface ExpressionTypeCheck {
  /** Each expression's problems, by the name it was given. */
  readonly expressions: Readonly<Record<string, ExpressionTypeError[]>>;
  /**
   * Problems in the scope's types themselves, or of the check as a whole:
   * the platform's, never an expression's.
   */
  readonly scope: readonly ExpressionTypeError[];
}

/**
 * What a read refuses in `m<i>`: an argument that is, or may be, a
 * function. A value typed `any` passes, as nothing is known of it: the
 * field may be data named like a method (`item.at`). What it gives is
 * what's left of the value without its functions, so a read of a refused
 * read (`[input.s.trim][0]`) isn't refused again.
 */
const readHelpers = `type $Function = (...args: never[]) => unknown;
type $NoMethod<T> = [Extract<T, $Function>] extends [never] ? unknown : { readonly "expression.method": never };
declare function $value<T>(value: T & $NoMethod<T>): Exclude<T, $Function>;
`;

/** TypeScript's refusal of an argument: `$value`'s, of a method read. */
const refusedArgument = "TS2345";

/**
 * The SDK's value types (`@grasp-os/sdk`'s values.ts), as a scope's types
 * name them (`valueTypeOf` writes a file as `FileValue`, say): declared
 * here, since the module imports nothing.
 */
const sdkValueTypes = `type Id<TableName extends string = string> = string & { readonly __tableName: TableName };
interface FileValue { readonly id: string }
interface MoneyValue { readonly currency: string; readonly minorUnits: number }
interface ScheduleValue { readonly cron: string; readonly timeZone: string }
`;

/** Type text on lines of its own, so nothing in it reaches past its parentheses. */
const typeCode = (text: string): string => `(\n${text}\n)`;

/** JavaScript's line terminators, as TypeScript counts lines. */
const lineBreak = /\r\n?|[\n\u2028\u2029]/u;

/**
 * Each UTF-16 unit that isn't a line terminator, to blank a comment and
 * keep its lines and length.
 */
// oxlint-disable-next-line eslint/require-unicode-regexp -- one unit at a time, as offsets count them
const notLineBreak = /[^\r\n\u2028\u2029]/g;

/** A Babel node, as far as the walk reads one. */
type Node = Readonly<Record<string, unknown>> & { readonly type: string };

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  typeof value.type === "string";

/** Each node in `value`, with its parent and the key it is under. */
const walk = (
  value: unknown,
  visit: (node: Node, parent: Node | undefined, key: string) => void,
  parent?: Node,
  key = ""
): void => {
  if (!isNode(value)) {
    return;
  }
  visit(value, parent, key);
  for (const [name, child] of Object.entries(value)) {
    for (const item of Array.isArray(child) ? child : [child]) {
      walk(item, visit, value, name);
    }
  }
};

const startOf = (node: Node): number =>
  typeof node.start === "number" ? node.start : 0;
const endOf = (node: Node): number =>
  typeof node.end === "number" ? node.end : 0;

/** A comparison: TypeScript reads `a < b, c > (d)` as a generic call. */
const isComparison = (node: Node): boolean =>
  node.type === "BinaryExpression" &&
  ["<", ">", "<=", ">="].includes(String(node.operator));

/** The name a member read reads: a literal key, or its key's source. */
const nameOf = (node: Node, property: Node, source: string): string => {
  if (node.computed !== true) {
    return typeof property.name === "string" ? property.name : "";
  }
  return typeof property.value === "string"
    ? property.value
    : source.slice(startOf(property), endOf(property));
};

/** A member read whose value is used, not called. */
const isRead = (node: Node, parent: Node | undefined, key: string): boolean =>
  (node.type === "MemberExpression" ||
    node.type === "OptionalMemberExpression") &&
  !(
    (parent?.type === "CallExpression" ||
      parent?.type === "OptionalCallExpression") &&
    key === "callee"
  );

/** A wrapped read: where its argument starts in the form, and what it reads. */
interface Read {
  readonly argument: number;
  readonly name: string;
  /** The read property's offset in the source. */
  readonly property: number;
}

/**
 * An expression as the module holds it: its code, where the units added
 * to its source are in it, and, wrapped, its reads.
 */
interface Form {
  readonly code: string;
  readonly added: readonly number[];
  readonly reads: readonly Read[];
}

interface Insertion {
  readonly at: number;
  readonly text: string;
  /** The span it opens or closes: outer before inner. */
  readonly span: number;
  readonly read?: Omit<Read, "argument">;
}

/**
 * `source` as `e<i>` (`wrapped` false) or `m<i>` holds it: comparisons in
 * parentheses, comments blanked (so no `// @ts-ignore` reaches the
 * check), and, wrapped, every read in `$value(…)`.
 */
const formOf = (source: string, wrapped: boolean): Form => {
  const parsed = parseExpression(source, { sourceType: "module", plugins: [] });
  const insertions: Insertion[] = [];
  walk(parsed, (node, parent, key) => {
    if (isComparison(node)) {
      const span = endOf(node) - startOf(node);
      insertions.push(
        { at: startOf(node), text: "(", span },
        { at: endOf(node), text: ")", span: -span }
      );
    }
    const { property } = node;
    if (wrapped && isRead(node, parent, key) && isNode(property)) {
      const name = nameOf(node, property, source);
      const span = endOf(node) - startOf(node);
      insertions.push(
        {
          at: startOf(node),
          text: "$value(",
          span,
          read: { name, property: startOf(property) },
        },
        { at: endOf(node), text: ")", span: -span }
      );
    }
  });
  // At one offset, closings before openings, inner closings first and
  // outer openings first.
  insertions.sort(
    (a, b) =>
      a.at - b.at || Math.sign(a.span) - Math.sign(b.span) || b.span - a.span
  );
  let blanked = source;
  for (const { start, end } of parsed.comments ?? []) {
    blanked = `${blanked.slice(0, start)}${blanked.slice(start, end).replaceAll(notLineBreak, " ")}${blanked.slice(end)}`;
  }
  let code = "";
  let from = 0;
  const added: number[] = [];
  const reads: Read[] = [];
  for (const { at, text, read } of insertions) {
    code += blanked.slice(from, at);
    for (let unit = 0; unit < text.length; unit += 1) {
      added.push(code.length + unit);
    }
    code += text;
    if (read !== undefined) {
      reads.push({ ...read, argument: code.length });
    }
    from = at;
  }
  return { code: code + blanked.slice(from), added, reads };
};

/** An offset in `text` as a 1-based line and column. */
const positionOf = (
  text: string,
  offset: number
): { line: number; column: number } => {
  const before = text.slice(0, offset).split(lineBreak);
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 };
};

/** Where each line of `text` starts. */
const lineStarts = (text: string): number[] => {
  const starts = [0];
  for (const found of text.matchAll(new RegExp(lineBreak.source, "gu"))) {
    starts.push(found.index + found[0].length);
  }
  return starts;
};

const fromSubset = ({
  code,
  message,
  line,
  column,
}: ExpressionError): ExpressionTypeError => ({ code, message, line, column });

/**
 * The refusal of a method read without a call: only an allowed method
 * is worth calling, and any other gets the SDK's own refusal of a
 * method an expression doesn't call.
 */
const methodReadError = (
  method: string
): Pick<ExpressionTypeError, "code" | "message"> => ({
  code: "expression.method",
  message: allowedMethods.has(method)
    ? `\`${method}\` is a method, read without a call: it has no value.`
    : `\`${method}\` is not one of the methods an expression can call.`,
});

/** An expression in the module: its name, its source, and each form's place. */
interface Placed {
  readonly name: string;
  readonly source: string;
  readonly plain: { readonly at: number; readonly form: Form };
  readonly wrapped: { readonly at: number; readonly form: Form };
}

/**
 * The check of `expressions` against `scope`'s types: each against the
 * subset first (`checkExpression`), then, in one tsrs run of `request`
 * (none when no expression passed), the ones that did, each as the body
 * of a function of `input`, `steps`, `params`, `run` and `scope.roots`, as
 * the generated code runs it. `checked` reads the run's diagnostics back.
 * Throws when a root of `scope.roots` repeats one of the four or isn't
 * one `checkExpression` takes.
 */
export const expressionTypeCheck = (
  scope: ExpressionScopeTypes,
  expressions: Readonly<Record<string, TypedExpression>>
): {
  request?: TypeCheckRequest;
  checked: (diagnostics: readonly Diagnostic[]) => ExpressionTypeCheck;
} => {
  const extra = Object.entries(scope.roots ?? {});
  const roots = extra.map(([name]) => name);
  // Before any name reaches the code: plain identifiers, no global's, no
  // default root again.
  checkRoots(roots);
  // Typed once, in `$Scope`: each function only names them, so the
  // module grows by its expressions alone.
  const parameters = ["input", "steps", "params", "run", ...roots].join(", ");
  const scopeParameters = `input: Input, steps: Steps, params: Params, run: Run${extra
    .map(([name, type]) => `, ${name}: ${typeCode(type)}`)
    .join("")}`;
  const steps = Object.entries(scope.steps)
    .map(
      ([id, output]) =>
        `readonly ${JSON.stringify(id)}: { readonly output: ${typeCode(output)} };`
    )
    .join("\n");
  let code = `${readHelpers}${sdkValueTypes}type Input = ${typeCode(scope.input)};
type Steps = {
${steps}
};
type Params = ${typeCode(scope.params)};
type Run = ${typeCode(scope.run)};
type $Scope = (${scopeParameters}) => unknown;
`;
  const found: Record<string, ExpressionTypeError[]> = {};
  const placed: Placed[] = [];
  for (const [index, [name, { source }]] of Object.entries(
    expressions
  ).entries()) {
    const subset = checkExpression(source, { roots });
    if (!subset.ok) {
      found[name] = subset.errors.map(fromSubset);
      continue;
    }
    found[name] = [];
    const plain = formOf(source, false);
    const wrapped = formOf(source, true);
    code += `export const e${index}: $Scope = (${parameters}) =>\n(\n`;
    const plainAt = code.length;
    code += `${plain.code}\n);\nexport const m${index}: $Scope = (${parameters}) =>\n(\n`;
    const wrappedAt = code.length;
    code += `${wrapped.code}\n);\n`;
    placed.push({
      name,
      source,
      plain: { at: plainAt, form: plain },
      wrapped: { at: wrappedAt, form: wrapped },
    });
  }
  const starts = lineStarts(code);
  /** A diagnostic's offset in the module. */
  const offsetOf = ({ line = 1, column = 1 }: Diagnostic): number =>
    (starts[line - 1] ?? code.length) + column - 1;
  /** Where offset `offset` of `form`'s code is in `source`. */
  const inSource = (form: Form, source: string, offset: number) =>
    positionOf(
      source,
      Math.min(
        offset - form.added.filter((at) => at < offset).length,
        source.length
      )
    );
  const checked = (diagnostics: readonly Diagnostic[]): ExpressionTypeCheck => {
    const errors: Record<string, ExpressionTypeError[]> = Object.fromEntries(
      Object.entries(found).map(([name, list]) => [name, [...list]])
    );
    const scopeErrors: ExpressionTypeError[] = [];
    for (const diagnostic of diagnostics) {
      if (diagnostic.severity !== "error") {
        continue;
      }
      const offset = offsetOf(diagnostic);
      const error = {
        code: diagnostic.rule,
        message: diagnostic.message,
        line: 1,
        column: 1,
      };
      const plain = placed.find(
        ({ plain: { at, form } }) =>
          offset >= at && offset <= at + form.code.length
      );
      const wrapped = placed.find(
        ({ wrapped: { at, form } }) =>
          offset >= at && offset <= at + form.code.length
      );
      if (wrapped !== undefined) {
        const { at, form } = wrapped.wrapped;
        const read = form.reads.find(
          ({ argument }) => argument === offset - at
        );
        if (diagnostic.rule === refusedArgument && read !== undefined) {
          errors[wrapped.name]?.push({
            ...methodReadError(read.name),
            ...positionOf(wrapped.source, read.property),
          });
        }
      } else if (plain !== undefined) {
        const { at, form } = plain.plain;
        errors[plain.name]?.push({
          ...error,
          ...inSource(form, plain.source, offset - at),
        });
      } else if (
        diagnostic.file === undefined ||
        diagnostic.file === modulePath
      ) {
        scopeErrors.push({
          ...error,
          line: diagnostic.line ?? 1,
          column: diagnostic.column ?? 1,
        });
      }
    }
    return { expressions: errors, scope: scopeErrors };
  };
  return {
    ...(placed.length === 0
      ? {}
      : {
          request: typeCheckRequest(
            { [modulePath]: code },
            serverTarget({}, new Set())
          ),
        }),
    checked,
  };
};
