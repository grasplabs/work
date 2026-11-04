/**
 * Type-checks a workflow's JavaScript expressions (`@grasp-os/sdk/expression-check`)
 * against the types of what they read, with the compiler's own TypeScript
 * check (`expressionProgram`): a reference to a field, step or method that isn't
 * there is an error at its line and column in the expression, as an
 * author wrote it.
 */
import {
  allowedMethods,
  checkExpression,
  checkRoots,
  sourcePosition,
} from "@grasp-os/sdk/expression-check";
import type { ExpressionError, TypeForm } from "@grasp-os/sdk/expression-check";
import ts from "typescript";

import type { Diagnostic } from "./diagnostic.ts";
import { serverTarget } from "./type-check.ts";

/** Where the expressions are checked, as one module of their own. */
const modulePath = "expressions.ts";

/** Where TypeScript's own declarations are among `kitTypes`. */
export const libLocation = "/node_modules/typescript/lib";

/**
 * The expressions' module as TypeScript 6 checks it, with App server
 * code's options (a worker's lib, no DOM) and no module to import. A
 * program of its own, not the App check's (tsrs, type-check.ts), which
 * answers diagnostics alone: a method read without a call is found by
 * its type (`methodReads`), which only a checker it can ask answers.
 */
const expressionProgram = (
  code: string,
  kitTypes: Readonly<Record<string, string>>
): ts.Program => {
  const { paths: _paths, ...json } = serverTarget({}, new Set()).options;
  const { options } = ts.convertCompilerOptionsFromJson(json, "/");
  const file = `/${modulePath}`;
  const readFile = (path: string): string | undefined => {
    if (path === file) {
      return code;
    }
    return Object.hasOwn(kitTypes, path) ? kitTypes[path] : undefined;
  };
  const host: ts.CompilerHost = {
    getSourceFile: (path, languageVersion) => {
      const text = readFile(path);
      return text === undefined
        ? undefined
        : ts.createSourceFile(path, text, languageVersion);
    },
    getDefaultLibFileName: (libOptions) =>
      `${libLocation}/${ts.getDefaultLibFileName(libOptions)}`,
    getDefaultLibLocation: () => libLocation,
    writeFile: () => {
      // Nothing is emitted.
    },
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (path) => readFile(path) !== undefined,
    readFile,
  };
  return ts.createProgram([file], options, host);
};

/** The program's errors and the module's, as diagnostics. */
const diagnosticsOf = (program: ts.Program): Diagnostic[] => {
  const file = program.getSourceFile(`/${modulePath}`);
  return [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...(file === undefined
      ? []
      : [
          ...program.getSyntacticDiagnostics(file),
          ...program.getSemanticDiagnostics(file),
        ]),
  ]
    .filter(({ category }) => category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const at =
        diagnostic.file === undefined || diagnostic.start === undefined
          ? undefined
          : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return {
        rule: `TS${diagnostic.code}`,
        severity: "error",
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ...(at === undefined
          ? {}
          : { line: at.line + 1, column: at.character + 1 }),
      };
    });
};

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
 * Whether reading `node` without a call reads a method: its type, or
 * any member of its union, has call signatures. On an object typed
 * `any` nothing is known, so a read of an allowed method's name is
 * taken for one.
 */
const readsMethod = (
  checker: ts.TypeChecker,
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  name: string
): boolean => {
  if (
    allowedMethods.has(name) &&
    checker.getTypeAtLocation(node.expression).flags === ts.TypeFlags.Any
  ) {
    return true;
  }
  const type = checker.getTypeAtLocation(node).getNonNullableType();
  return (type.isUnion() ? type.types : [type]).some(
    (member) => member.getCallSignatures().length > 0
  );
};

/**
 * Where the module reads a method without calling it, by its 1-based
 * line and column: a member read that isn't a call's callee and whose
 * type is a function (`readsMethod`). Its value would be `undefined`
 * (`$read` gives no function), while a field of data named like a
 * method (`at`, `map`) has a data type and is read.
 */
const methodReads = (
  program: ts.Program
): { line: number; column: number; name: string }[] => {
  const file = program.getSourceFile(`/${modulePath}`);
  if (file === undefined) {
    return [];
  }
  const checker = program.getTypeChecker();
  const found: { line: number; column: number; name: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      !(ts.isCallExpression(node.parent) && node.parent.expression === node)
    ) {
      const named = ts.isPropertyAccessExpression(node)
        ? node.name
        : node.argumentExpression;
      const name =
        ts.isStringLiteralLike(named) || ts.isIdentifier(named)
          ? named.text
          : named.getText(file);
      if (readsMethod(checker, node, name)) {
        const at = file.getLineAndCharacterOfPosition(named.getStart(file));
        found.push({ line: at.line + 1, column: at.character + 1, name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
};

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
 * code runs it. `kitTypes` holds TypeScript's own declarations
 * (`libLocation`), as the kit does. Throws when a root of
 * `scope.roots` repeats one of the four or isn't one `checkExpression`
 * takes.
 */
export const checkExpressionTypes = (
  scope: ExpressionScopeTypes,
  expressions: Readonly<Record<string, TypedExpression>>,
  kitTypes: Record<string, string>
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
  const checking = expressionProgram(code, kitTypes);
  for (const diagnostic of diagnosticsOf(checking)) {
    if (diagnostic.severity !== "error") {
      continue;
    }
    const line = diagnostic.line ?? 0;
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
      scopeErrors.push({ ...error, line, column: diagnostic.column ?? 1 });
    } else if (line < at.first) {
      errors[at.name]?.push(error);
    } else {
      errors[at.name]?.push({
        ...error,
        ...sourcePosition(
          at.form,
          at.source,
          line - at.first + 1,
          diagnostic.column ?? 1
        ),
      });
    }
  }
  for (const { line, column, name: method } of methodReads(checking)) {
    const at = placed.find(
      (expression) => line >= expression.first && line <= expression.last
    );
    if (at === undefined) {
      continue;
    }
    errors[at.name]?.push({
      ...methodReadError(method),
      ...sourcePosition(at.form, at.source, line - at.first + 1, column),
    });
  }
  return { expressions: errors, scope: scopeErrors };
};
