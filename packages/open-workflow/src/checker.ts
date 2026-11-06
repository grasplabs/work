import { diagnosticMessages, maxDiagnostics } from "./diagnostics.ts";
import type { Diagnostic, DiagnosticCode } from "./diagnostics.ts";
import type { DeclaredStore } from "./stores.ts";

/**
 * Thrown once the report holds `maxDiagnostics` errors: the check stops
 * there, and a stopped check never passes.
 */
export class ReportFullError extends Error {
  constructor() {
    super("The diagnostics are at their limit");
    this.name = "ReportFullError";
  }
}

export interface Where {
  pointer: string;
  taskId?: string | undefined;
}

export interface Details {
  expected?: string;
  reason?: string;
}

/** The diagnostics of one check, bounded. */
export interface Report {
  readonly diagnostics: Diagnostic[];
  /** How many of the diagnostics are errors. */
  errors: () => number;
  error: (
    code: DiagnosticCode,
    where: Where,
    remedy: string,
    details?: Details
  ) => void;
}

export const createReport = (): Report => {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    errors: () => diagnostics.length,
    error: (code, where, remedy, details = {}) => {
      diagnostics.push(
        Object.freeze({
          code,
          message: diagnosticMessages[code],
          pointer: where.pointer,
          remedy,
          ...(where.taskId === undefined ? {} : { taskId: where.taskId }),
          ...(details.expected === undefined
            ? {}
            : { expected: details.expected }),
          ...(details.reason === undefined ? {} : { reason: details.reason }),
        })
      );
      if (diagnostics.length >= maxDiagnostics) {
        throw new ReportFullError();
      }
    },
  };
};

/** Where in the definition a check is: the task IDs down to it. */
export interface Site {
  scope: readonly string[];
}

export const taskIdOf = (site: Site): string | undefined => site.scope.at(-1);

/** What one check gathers: its report, and the stores it read. */
export interface Checker {
  report: Report;
  /** The stores the definition declares, by name (stores.ts). */
  stores: Map<string, DeclaredStore>;
}

export const createChecker = (): Checker => ({
  report: createReport(),
  stores: new Map(),
});
