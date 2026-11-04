/**
 * Type-checks a workflow's JavaScript expressions (`@grasp-os/sdk/expression-check`)
 * against the types of what they read, with the platform's type check
 * (tsrs, type-check.ts): a reference to a field, step or method that isn't
 * there is an error at its line and column in the expression, as an
 * author wrote it.
 */
import {
  allowedMethods,
  checkExpression,
  checkRoots,
  readAt,
  sourcePosition,
  typeReadNames,
} from "@grasp-os/sdk/expression-check";
import type { ExpressionError, TypeForm } from "@grasp-os/sdk/expression-check";

import { serverTarget, typeCheck, typeCheckRequest } from "./type-check.ts";

/** Where the expressions are checked, as one module of their own. */
const modulePath = "expressions.ts";

/** The expressions' module reads nothing of the kit, nor any module. */
const noKit = { files: {}, resolved: {} };

/**
 * The member read wrappers the type form calls (`typeReadNames`), as the
 * module declares them: each answers what it reads, and refuses a value
 * that is, or may be, a function. A method read without a call has no
 * value (`$read` gives no function); a field of data named like a method
 * (`at`, `map`) has a data type and is read. On a value typed `any`
 * nothing is known: a read of a name an expression may call (`method`)
 * is taken for a method, any other (`value`) for data.
 */
const readHelpers = `type $Function = (...args: never[]) => unknown;
type $NoMethod<T> = [Extract<T, $Function>] extends [never] ? unknown : { readonly "expression.method": never };
declare function ${typeReadNames.value}<T>(value: T & $NoMethod<T>): T;
declare function ${typeReadNames.method}<T>(value: T & (0 extends 1 & T ? never : $NoMethod<T>)): T;
`;

/** TypeScript's refusal of an argument: a wrapper's, where it refuses a method read. */
const refusedArgument = "TS2345";

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

/** An expression and, where the workflow needs one, the type of its result. */
export interface TypedExpression {
  readonly source: string;
  /** TypeScript type text, e.g. `boolean` for a condition. */
  readonly result?: string;
}

/** A problem in an expression: the subset's (`expression.*`) or TypeScript's (`TS2339`). */
export interface ExpressionTypeError {
  code: string;
  message: string;
  fix?: string;
  /** 1-based, in the expression's source. */
  line: number;
  /** 1-based. */
  column: number;
}

export interface ExpressionTypeCheck {
  /** Each expression's problems, by the name it was given. */
  readonly expressions: Readonly<Record<string, ExpressionTypeError[]>>;
  /**
   * Problems in the scope's types themselves: the generator's, never an
   * expression's.
   */
  readonly scope: readonly ExpressionTypeError[];
}

/** Type text on lines of its own, so nothing in it reaches past its parentheses. */
const typeCode = (text: string): string => `(\n${text}\n)`;

/** JavaScript's line terminators, as TypeScript counts lines (and the SDK's check). */
const lineBreak = /\r\n?|[\n\u2028\u2029]/u;

const lineCount = (text: string): number => text.split(lineBreak).length;

const fromSubset = ({
  code,
  message,
  fix,
  line,
  column,
}: ExpressionError): ExpressionTypeError => ({
  code,
  message,
  fix,
  line,
  column,
});

/**
 * The refusal of a method read without a call: only an allowed method
 * is worth calling, and any other gets the SDK's own refusal of a
 * method an expression doesn't call.
 */
const methodReadError = (
  method: string
): Pick<ExpressionTypeError, "code" | "message" | "fix"> =>
  allowedMethods.has(method)
    ? {
        code: "expression.method",
        message: `\`${method}\` is a method, read without a call: it has no value.`,
        fix: `Call it, as \`${method}(…)\`.`,
      }
    : {
        code: "expression.method",
        message: `\`${method}\` is not one of the methods an expression can call.`,
        fix: `Call one of: ${[...allowedMethods].join(", ")}.`,
      };

/**
 * Checks each expression against the subset first, then the ones that
 * pass against `scope`'s types, each as the body of a function of
 * `input`, `steps`, `params`, `run` and `scope.roots`, as the generated
 * code runs it, with tsrs's `module`. Throws when a root of
 * `scope.roots` repeats one of the four or isn't one `checkExpression`
 * takes.
 */
export const checkExpressionTypes = (
  module: WebAssembly.Module,
  scope: ExpressionScopeTypes,
  expressions: Readonly<Record<string, TypedExpression>>
): ExpressionTypeCheck => {
  const extra = Object.entries(scope.roots ?? {});
  const roots = extra.map(([name]) => name);
  // Before any name reaches the code: plain identifiers, no global's, no
  // default root again.
  checkRoots(roots);
  const extraParameters = extra
    .map(([name, type]) => `, ${name}: ${typeCode(type)}`)
    .join("");
  const errors: Record<string, ExpressionTypeError[]> = {};
  const steps = Object.entries(scope.steps)
    .map(
      ([id, output]) =>
        `readonly ${JSON.stringify(id)}: { readonly output: ${typeCode(output)} };`
    )
    .join("\n");
  let code = [
    readHelpers,
    `type Input = ${typeCode(scope.input)};`,
    `type Steps = {\n${steps}\n};`,
    `type Params = ${typeCode(scope.params)};`,
    `type Run = ${typeCode(scope.run)};`,
    "",
  ].join("\n");
  // The first line of each expression in the module, 1-based, and its last.
  const placed: {
    name: string;
    first: number;
    last: number;
    form: TypeForm;
    source: string;
  }[] = [];
  for (const [index, [name, { source, result }]] of Object.entries(
    expressions
  ).entries()) {
    const checked = checkExpression(source, { roots });
    if (!checked.ok) {
      errors[name] = checked.errors.map(fromSubset);
      continue;
    }
    errors[name] = [];
    // By an alias: `(): (T) => …` would read as a function type.
    let returns = "";
    if (result !== undefined) {
      code += `type Result${index} = ${typeCode(result)};\n`;
      returns = `: Result${index}`;
    }
    const head = `export const e${index} = (input: Input, steps: Steps, params: Params, run: Run${extraParameters})${returns} =>\n`;
    const first = lineCount(code + head) + 1;
    // Built from its checked tree (`forTypes`), every operand and comparison in
    // parentheses and no comment: TypeScript reads what JavaScript does.
    // It is only type-checked, never run: what runs is `checked.code`,
    // through the SDK's guards. Errors map back to the source
    // (`sourcePosition`).
    const form = checked.forTypes;
    code += `${head}(\n${form.code}\n);\n`;
    placed.push({
      name,
      first,
      last: first + lineCount(form.code) - 1,
      form,
      source,
    });
  }
  const scopeErrors: ExpressionTypeError[] = [];
  if (placed.length === 0) {
    return { expressions: errors, scope: scopeErrors };
  }
  const diagnostics = typeCheck(
    module,
    noKit,
    typeCheckRequest(
      { [modulePath]: code },
      // A worker's lib, no DOM, and no module to import.
      serverTarget({}, new Set())
    )
  );
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "error") {
      continue;
    }
    const line = diagnostic.line ?? 0;
    const column = diagnostic.column ?? 1;
    // On the opening parenthesis's line (a result of the wrong type): the
    // expression's start.
    const at = placed.find(
      ({ first, last }) => line >= first - 1 && line <= last
    );
    const error = {
      code: diagnostic.rule,
      message: diagnostic.message,
      line: 1,
      column: 1,
    };
    if (at === undefined) {
      scopeErrors.push({ ...error, line, column });
      continue;
    }
    if (line < at.first) {
      errors[at.name]?.push(error);
      continue;
    }
    const formLine = line - at.first + 1;
    const read =
      diagnostic.rule === refusedArgument
        ? readAt(at.form, at.source, formLine, column)
        : undefined;
    errors[at.name]?.push(
      read === undefined
        ? {
            ...error,
            ...sourcePosition(at.form, at.source, formLine, column),
          }
        : {
            ...methodReadError(read.name),
            line: read.line,
            column: read.column,
          }
    );
  }
  return { expressions: errors, scope: scopeErrors };
};
