/**
 * A build as the compiler answers it, before its type check: the check
 * runs in an isolate of its own (checker.ts, `typeCheck`), which core
 * starts once the compiler has answered, and `withTypeCheck` puts its
 * diagnostics together with the build's, as the build itself would have.
 */
import { isError, together } from "./diagnostic.ts";
import type { Diagnostic } from "./diagnostic.ts";
import type { TypeCheckRequest } from "./type-check.ts";

/** What a build's type check checks, and how its diagnostics join the build's. */
export interface TypeCheckPlan {
  readonly request: TypeCheckRequest;
  /** What the build found before the check (compile and import errors). */
  readonly found?: readonly Diagnostic[];
  /** The files the parser refused, and those whose JSX runtime was refused (`together`). */
  readonly unparsed?: readonly string[];
  readonly untyped?: readonly string[];
  /** Only these files' diagnostics count, and the program's own. */
  readonly reported?: readonly string[];
  /** Only errors count. */
  readonly errorsOnly?: boolean;
  /** Said last when the build fails. */
  readonly failing?: Diagnostic;
  /**
   * Where an implicit `any` is a callback's parameter over a stand-in
   * typed `any` (`file:line:column`, `standInCallbacks`): never reported.
   */
  readonly lenient?: readonly string[];
  /** Whether a passing build carries its diagnostics (a pages build's warnings). */
  readonly carries?: boolean;
}

/** A build, and the type check it waits on, if any: what the compiler answers. */
export interface Unchecked<Build> {
  built: Build;
  typeCheck?: TypeCheckPlan;
}

/** TypeScript's "implicitly has an 'any' type", of a parameter and of a name destructured in one. */
const implicitAny: ReadonlySet<string> = new Set(["TS7006", "TS7031"]);

/**
 * `answer`'s build once its type check said `diagnostics`: failed when
 * anything together is an error, every gate's diagnostics in it, none
 * hiding another (`together`); else the build, carrying its warnings
 * where it does.
 */
export const withTypeCheck = <Build extends { ok: boolean }>(
  { built, typeCheck }: Unchecked<Build>,
  diagnostics: readonly Diagnostic[]
): Build | { ok: false; diagnostics: Diagnostic[] } => {
  if (typeCheck === undefined) {
    return built;
  }
  const lenient = new Set(typeCheck.lenient);
  const reported =
    typeCheck.reported === undefined ? undefined : new Set(typeCheck.reported);
  const checked = diagnostics.filter(
    (diagnostic) =>
      !(
        implicitAny.has(diagnostic.rule) &&
        lenient.has(
          `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`
        )
      ) &&
      (diagnostic.file === undefined ||
        (reported?.has(diagnostic.file) ?? true)) &&
      (typeCheck.errorsOnly !== true || isError(diagnostic))
  );
  const all = together(
    typeCheck.found ?? [],
    checked,
    new Set(typeCheck.unparsed),
    new Set(typeCheck.untyped)
  );
  if (!all.some((diagnostic) => isError(diagnostic))) {
    return typeCheck.carries === true ? { ...built, diagnostics: all } : built;
  }
  return {
    ok: false,
    diagnostics:
      typeCheck.failing === undefined ? all : [...all, typeCheck.failing],
  };
};
