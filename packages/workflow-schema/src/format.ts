// grasp-workflow/1: a workflow as JSON, the stored form of a workflow on
// `@grasp-os/sdk/workflow`. One step is one SDK call; steps name each
// other's results explicitly (`steps.extract.output`), and everything a
// run reads besides (its input, its parameters, its bindings) is declared
// at the top. The canvas draws it and the agent edits it step by step;
// what runs, is sealed and is exported is the TypeScript it generates
// (generate.ts). schema.ts defines it; check.ts checks it.
//
// A step kind joins the format as its SDK call joins the run host: a new
// `type` in the union, nothing else changing (forEach, decision, fork,
// race, event waits and child runs come so).

import { workflowModulePattern } from "@grasp-os/shared/workflow-modules";

/**
 * The format's published JSON Schema, by its versioned URL: every document
 * names it as its `$schema`, the common way (as a tsconfig.json or a
 * package.json does), so an editor checks it as it is written.
 */
export const workflowSchemaUrl =
  "https://grasp.work/schemas/grasp-workflow/1.json";

/**
 * Where the host's own error kinds are (`<errorTypeBase>timeout`, say), as
 * a catch's `errors.type` names them. A raise never names one: an error of
 * these kinds is always the host's.
 */
export const errorTypeBase =
  "https://grasp.work/schemas/grasp-workflow/1/errors/";

/** JSON, as the format's values hold it. */
export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** A JSON object of values, as `Value` holds one. */
export interface ValueRecord {
  readonly [key: string]: Value;
}

/**
 * An expression (expressions.ts): JavaScript a run evaluates where it
 * stands, reading `input`, `params`, `steps` and, in a catch, `error`.
 * As JSON, it is an object of one value, so it is a `ValueRecord` too.
 */
export type Expression = ValueRecord & { readonly $expr: string };

/**
 * A value a step passes: JSON, any part of which may be an expression. A
 * string is always text, never interpolated.
 */
export type Value =
  | null
  | boolean
  | number
  | string
  | Expression
  | readonly Value[]
  | ValueRecord;

/** Whether `value` is a list of values. */
export const isValueList = (value: Value): value is readonly Value[] =>
  Array.isArray(value);

/** A time span, as the SDK takes one: `"30 minutes"`, `"3 days"`. */
export type Duration = `${number} ${DurationUnit}${"" | "s"}`;

export const durationUnits = ["second", "minute", "hour", "day", "week"];
export type DurationUnit = "second" | "minute" | "hour" | "day" | "week";

/** The kinds of parameter, as the SDK has them (`@grasp-os/sdk/params`). */
export const paramKinds = [
  "text",
  "number",
  "money",
  "person",
  "schedule",
  "template",
] as const;
export type ParamKind = (typeof paramKinds)[number];

interface ParamBase {
  readonly kind: ParamKind;
  readonly label: string;
  /** A money parameter's ISO 4217 currency. */
  readonly currency?: string;
}

/**
 * A parameter: a value people set without touching the workflow.
 *
 * Sensitive unless it says `sensitive: false`, so a parameter nobody
 * thought about (an API key, say) is never shown, logged or handed to the
 * run's code. A sensitive parameter carries no value in the document,
 * which drafts, exports and reviews show: its value is set where parameter
 * values are kept. Only a parameter that isn't sensitive has a `default`.
 */
export type Param = ParamBase &
  (
    | { readonly sensitive: false; readonly default: Json }
    | { readonly sensitive?: true; readonly default?: never }
  );

/** A parameter that isn't sensitive: the run's code may read it. */
export type PlainParam = Extract<Param, { readonly sensitive: false }>;

/** Whether `param` isn't sensitive: only one marked `sensitive: false`. */
export const isPlain = (param: Param): param is PlainParam =>
  param.sensitive === false;

/** Whether `param` is sensitive: every parameter not marked otherwise. */
export const isSensitive = (param: Param): boolean => !isPlain(param);

/** What a binding reaches, as the host's catalog has its contracts. */
export const bindingKinds = [
  "connector",
  "operation",
  "model",
  "compute",
  "action",
] as const;
export type BindingKind = (typeof bindingKinds)[number];

/**
 * A binding: what a step calls, by the contract an admin approves. A
 * `compute` or `action` binding names one of the workflow's own modules
 * (`local:code/<file>.ts#<export>`).
 */
export interface Binding {
  readonly kind: BindingKind;
  readonly contract: string;
  /** What it is called where people see it: a label, renamed freely. */
  readonly title?: string;
}

interface StepBase {
  /**
   * Its stable key, unique in the workflow, never changed once it is made:
   * `steps.<id>` reads its result, and lists, retries and the sealed table
   * name it by it. A step is renamed by its `title`, never its ID, so a
   * rename breaks nothing.
   */
  readonly id: string;
  /**
   * What it does, in plain language, as the canvas and the run show it: a
   * label, renamed freely, which no code is generated from.
   */
  readonly title?: string;
  /** Runs only when this holds; skipped, its output is `null`. */
  readonly if?: Expression;
}

/** Calls a binding: a connector's operation, a store operation, code. */
export interface DoStep extends StepBase {
  readonly type: "do";
  readonly binding: string;
  /** A connector's operation; no other binding takes one. */
  readonly operation?: string;
  readonly arguments?: Value;
  /** The most one attempt may take. */
  readonly timeout?: Duration;
}

/** Asks a model, through a model binding, for an answer of `output`'s shape. */
export interface AgentStep extends StepBase {
  readonly type: "agent";
  readonly binding: string;
  readonly instructions: Value;
  readonly input: Value;
  /** A JSON Schema the answer must match. */
  readonly output: Json;
  readonly timeout?: Duration;
}

/** Waits: for a time span, or until a deadline (ms since the epoch). */
export type WaitStep = StepBase &
  (
    | { readonly type: "wait"; readonly for: Duration }
    | { readonly type: "wait"; readonly until: Expression }
  );

/** Runs `then` when `condition` holds, `else` otherwise. */
export interface IfStep extends StepBase {
  readonly type: "if";
  readonly condition: Expression;
  readonly then: readonly Step[];
  readonly else?: readonly Step[];
}

/** Which failures a catch takes, as the run host maps them. */
export interface ErrorFilter {
  readonly type?: string;
  readonly status?: number;
}

/** Tries a failing step of the `try` list again, after a backoff. */
export interface Retry {
  /** Attempts in all, the first included: 1 to 5. */
  readonly attempts: number;
  readonly delay: Duration;
  readonly backoff: "constant" | "linear" | "exponential";
  /** Retries only while this holds, `error` in scope. */
  readonly when?: Expression;
}

/** Runs `try`; a failure there its catch takes runs `catch.do` instead. */
export interface TryStep extends StepBase {
  readonly type: "try";
  readonly try: readonly Step[];
  readonly catch: {
    readonly errors?: ErrorFilter;
    /** Takes only while this holds, `error` in scope. */
    readonly when?: Expression;
    readonly retry?: Retry;
    readonly do?: readonly Step[];
  };
}

/** Fails the run with the workflow's own error, which a catch may take. */
export interface RaiseStep extends StepBase {
  readonly type: "raise";
  readonly error: {
    /** A URI naming the kind of error, e.g. `urn:acme:error:rejected`. */
    readonly type: string;
    readonly status: number;
    readonly title?: string;
    readonly detail?: string;
  };
}

export type Step = DoStep | AgentStep | WaitStep | IfStep | TryStep | RaiseStep;

export type StepType = Step["type"];

/** A workflow in grasp-workflow/1. */
export interface WorkflowDocument {
  /** What the document is: the format's schema, `workflowSchemaUrl`. */
  readonly $schema: typeof workflowSchemaUrl;
  /** A JSON Schema of what starts a run. */
  readonly input?: Json;
  /** What a run ends with: its JSON Schema, and its value. */
  readonly output?: { readonly schema: Json; readonly value: Value };
  readonly params?: Readonly<Record<string, Param>>;
  readonly bindings?: Readonly<Record<string, Binding>>;
  readonly steps: readonly Step[];
}

/**
 * The format's bounds: what one workflow may hold. What it generates is
 * bounded besides by what a sealed build holds (`sealedBuildLimits`).
 */
export const formatLimits = {
  /** Steps in all, at every level. */
  steps: 200,
  /** Lists one inside another (`then`, `try`, `catch.do`). */
  depth: 8,
  /**
   * Levels of the whole document, its leaves included, measured without
   * recursion before its schema is applied, which recurses. The deepest
   * list's step is 24 levels in (3 a list: `catch`, `do`, the step), so a
   * value or a schema there still nests as deep as the SDK takes one (32).
   */
  documentDepth: 64,
  /** One expression's source. */
  expressionLength: 2048,
  idLength: 64,
  titleLength: 200,
  params: 64,
  bindings: 64,
} as const;

const unitMs: Readonly<Record<DurationUnit, number>> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

const isUnit = (unit: string): unit is DurationUnit =>
  durationUnits.includes(unit);

/** A duration in milliseconds: the schema checked its shape. */
export const durationMs = (duration: Duration): number => {
  const [count = "", unit = ""] = duration.split(" ");
  const singular = unit.replace(/s$/u, "");
  if (!isUnit(singular)) {
    throw new Error(`Not a duration: ${duration}`);
  }
  return Number(count) * unitMs[singular];
};

/**
 * What a step ID may be: lower-case words joined by dashes, and none of
 * the names an expression may never read (`constructor`, `prototype`), so
 * `steps.<id>.output` reads every step.
 */
export const stepIdPattern = "^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$";

/**
 * A parameter's name: an identifier, so code reads it as `params.<name>`.
 * Like a step's ID and a binding's alias, a stable key, never changed once
 * made: a parameter is renamed by its `label`.
 */
export const paramNamePattern = "^[a-z][A-Za-z0-9]{0,63}$";

/** A binding's alias, as the host's bindings take it. */
export const aliasPattern = "^[A-Za-z][A-Za-z0-9_]{0,63}$";

/**
 * A workflow's own module and export, `local:code/<path>.ts#<export>`: its
 * module's path as the host keeps the workflow's modules
 * (`workflowModulePattern`), then an export's name.
 */
export const localContractPattern = `^local:(${workflowModulePattern.source.slice(1, -1)})#([A-Za-z_$][A-Za-z0-9_$]*)$`;
