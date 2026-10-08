import type { ValueSchema } from "@grasp-os/sdk";
import type { Stage } from "@grasp-os/workflow-expressions/evaluate";

import { createCatalogBudget } from "./catalog.ts";
import type {
  BindingKind,
  CatalogBudget,
  ReadOptions,
  ResolvedContract,
} from "./catalog.ts";
import { diagnosticMessages, maxDiagnostics } from "./diagnostics.ts";
import type {
  AnyDiagnosticCode,
  Diagnostic,
  DiagnosticCode,
} from "./diagnostics.ts";
import type { JsonObject, JsonValue } from "./json-text.ts";

/**
 * Thrown once the report holds `maxDiagnostics` errors, or by a fatal
 * error: validation stops there, and a stopped validation never passes.
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

/** The diagnostics of one validation, bounded. */
export interface Report {
  readonly diagnostics: Diagnostic[];
  /** How many of the diagnostics are errors. */
  errors: () => number;
  add: (
    severity: Diagnostic["severity"],
    code: AnyDiagnosticCode,
    message: string,
    where: Where,
    remedy: string,
    details?: Details
  ) => void;
  error: (
    code: DiagnosticCode,
    where: Where,
    remedy: string,
    details?: Details
  ) => void;
  /** Reports an error that ends validation: nothing after it is checked. */
  fatal: (
    code: DiagnosticCode,
    where: Where,
    remedy: string,
    details?: Details
  ) => never;
  warning: (
    code: DiagnosticCode,
    where: Where,
    remedy: string,
    details?: Details
  ) => void;
}

export const createReport = (): Report => {
  const diagnostics: Diagnostic[] = [];
  let errors = 0;
  let warnings = 0;
  const add: Report["add"] = (
    severity,
    code,
    message,
    where,
    remedy,
    details = {}
  ) => {
    const diagnostic: Diagnostic = {
      severity,
      code,
      message,
      pointer: where.pointer,
      remedy,
      ...(where.taskId === undefined ? {} : { taskId: where.taskId }),
      ...(details.expected === undefined ? {} : { expected: details.expected }),
      ...(details.reason === undefined ? {} : { reason: details.reason }),
    };
    if (severity === "warning") {
      // Advice never stops validation: past the cap it is dropped, so
      // warnings can't crowd out the checks that still have to run.
      if (warnings < maxDiagnostics) {
        warnings += 1;
        diagnostics.push(Object.freeze(diagnostic));
      }
      return;
    }
    diagnostics.push(Object.freeze(diagnostic));
    errors += 1;
    if (errors >= maxDiagnostics) {
      throw new ReportFullError();
    }
  };
  const error: Report["error"] = (code, where, remedy, details) => {
    add("error", code, diagnosticMessages[code], where, remedy, details);
  };
  return {
    diagnostics,
    errors: () => errors,
    add,
    error,
    fatal: (code, where, remedy, details) => {
      error(code, where, remedy, details);
      throw new ReportFullError();
    },
    warning: (code, where, remedy, details) => {
      add("warning", code, diagnosticMessages[code], where, remedy, details);
    },
  };
};

/** What a result must be, where it can be proven before a run. */
export type Expectation = "boolean" | "array" | "string" | "number";

/** One `${ … }` in the definition, compiled after the walk. */
export interface ExpressionSlot {
  source: string;
  stage: Stage;
  /** Task IDs from the top-level list down to the task it belongs to. */
  scope: readonly string[];
  pointer: string;
  loopVariables: readonly string[];
  /** Variables of a catch (`catch.as`) in scope, which hold errors. */
  errorVariables: readonly string[];
  expects?: Expectation;
}

export interface Binding {
  alias: string;
  kind: BindingKind;
  contractKey: string;
  pointer: string;
  contract?: ResolvedContract;
  referenced: boolean;
}

/** A transition as written: `then` of a task, a switch case or a catch. */
export interface Transition {
  target: string;
  pointer: string;
}

export interface TaskRecord {
  id: string;
  kind: string;
  pointer: string;
  /** Task IDs from the top-level list down to this task. */
  scope: readonly string[];
  hasIf: boolean;
  /** Where the task's `then` leads. */
  next?: Transition;
  /** Where its `catch.then` leads. */
  catchNext?: Transition;
  /** Switch cases, in order, with where each case's `then` leads. */
  cases?: { name: string; when: boolean; next: Transition; pointer: string }[];
}

/** One task list: the unit transitions stay inside. */
export interface ListRecord {
  pointer: string;
  taskId?: string;
  tasks: TaskRecord[];
  /** Fork branches are separate scopes: no named transitions between them. */
  namedTransitions: boolean;
}

export interface FunctionCall {
  /** The reusable function the call is in; `undefined` in the workflow. */
  from: string | undefined;
  to: string;
  pointer: string;
  taskId: string;
  /** Scopes at the call: the calling task's, counted from its own root. */
  depth: number;
}

/** Where in the definition a walk is: the task and what is in scope. */
export interface Site {
  /** Task IDs from the top-level list down to the current task. */
  scope: readonly string[];
  loopVariables: readonly string[];
  errorVariables: readonly string[];
  /** The reusable function being walked, if any. */
  inFunction: string | undefined;
}

export const taskIdOf = (site: Site): string | undefined => site.scope.at(-1);

/** Everything one validation gathers while it walks the definition. */
export interface Checker {
  report: Report;
  options: ReadOptions;
  /** What resolving the bindings' contracts may still cost. */
  catalogBudget: CatalogBudget;
  params: Map<string, ValueSchema<unknown, unknown>>;
  bindings: Map<string, Binding>;
  functions: Map<string, string>;
  reusableErrors: Set<string>;
  reusableRetries: Set<string>;
  reusableTimeouts: Set<string>;
  taskIds: Set<string>;
  /** Tasks counted so far, each before its body is walked. */
  taskCount: number;
  tasks: TaskRecord[];
  lists: ListRecord[];
  slots: ExpressionSlot[];
  /** Set once the expression limit was reported. */
  slotsFull: boolean;
  schemas: Map<string, ValueSchema<unknown, unknown>>;
  functionCalls: FunctionCall[];
  workflowInput?: ValueSchema<unknown, unknown>;
  identity?: { namespace: string; name: string; version: string };
}

export const createChecker = (options: ReadOptions): Checker => ({
  report: createReport(),
  options,
  catalogBudget: createCatalogBudget(),
  params: new Map(),
  bindings: new Map(),
  functions: new Map(),
  reusableErrors: new Set(),
  reusableRetries: new Set(),
  reusableTimeouts: new Set(),
  taskIds: new Set(),
  taskCount: 0,
  tasks: [],
  lists: [],
  slots: [],
  slotsFull: false,
  schemas: new Map(),
  functionCalls: [],
});

/** A value's own key, or `undefined`: never a prototype member. */
export const member = (
  object: JsonObject,
  key: string
): JsonValue | undefined =>
  Object.hasOwn(object, key) ? object[key] : undefined;
