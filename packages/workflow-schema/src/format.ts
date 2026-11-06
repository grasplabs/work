import { decidersPattern } from "@grasp-os/shared/decisions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { workflowModulePattern } from "@grasp-os/shared/workflow-modules";

// grasp-workflow/1: a workflow as JSON, the stored form of a workflow on
// `@grasp-os/sdk/workflow`. One step is one SDK call; steps name each
// other's results explicitly (`steps.extract.output`), and everything a
// run reads besides (its input, its parameters, its bindings) is declared
// at the top. The canvas draws it and the agent edits it step by step;
// what runs, is sealed and is exported is the TypeScript it generates
// (generate.ts). schema.ts defines it; check.ts checks it.
//
// A step kind joins the format as its SDK call joins the run host: a new
// `type` in the union, nothing else changing.

/**
 * The format's published JSON Schema, by its versioned URL: every document
 * names it as its `$schema`, the common way (as a tsconfig.json or a
 * package.json does), so an editor checks it as it is written.
 */
export const workflowSchemaUrl =
  "https://grasp.work/schemas/grasp-workflow/1.json";

/** The format's name and version, as a published version records it. */
export const definitionFormat = "grasp-workflow/1";

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
  "decision",
  "event",
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

/**
 * Asks people to decide, through a decision binding, and waits for the
 * answer: its output is `{ timedOut: false, approved, by, payload }`, or
 * `{ timedOut: true }` when nobody answered within `timeout`. A timeout
 * never means approval.
 */
export interface DecisionStep extends StepBase {
  readonly type: "decision";
  readonly binding: string;
  /**
   * Who is asked, 1 to 16 of `person:<user ID>`, `team:<team ID>` and
   * `role:<role>`: a list, any item of which may be an expression, or an
   * expression for the whole list. The first is the SDK's `from`; any of
   * them may answer.
   */
  readonly recipients: Value;
  /** What they are asked, at most 500 characters. */
  readonly prompt: Value;
  /** What they decide on, as the binding's contract takes it. */
  readonly input: Value;
  /** How long it waits for an answer: until the run's own deadline if not given. */
  readonly timeout?: Duration;
}

/**
 * Runs `do` for each of `items`, one item at a time, in order: `item` is
 * in scope in its steps and in `while`. Its own output is `null`; a step
 * inside it is read only by the steps after it in the same item.
 *
 * What bounds a loop is the run's step ceiling (`forEachDescription`): every step
 * of every item counts toward it, so a loop of many items, or of items
 * of many steps, can reach it well before its last item. A run that does
 * fails with `workflow.too_many_steps`, which says to split the work over
 * more runs (a run per page of items, say).
 */
export interface ForEachStep extends StepBase {
  readonly type: "forEach";
  /** A list of items, as its run records them first. */
  readonly items: Expression;
  /** Goes on to each next item only while this holds. */
  readonly while?: Expression;
  readonly do: readonly Step[];
}

/**
 * The events an event wait takes: those sent to the run through event
 * binding `from`, of `type` or any of a list of types, each one the
 * binding's contract admits.
 */
export interface EventFilter {
  readonly from: string;
  readonly type: string | readonly string[];
}

/**
 * Waits: for a time span, until a deadline (ms since the epoch), or for an
 * event (`EventWaitStep`), at most `timeout`, which an event wait always
 * names: a run never waits for an event with no end.
 */
export type WaitStep =
  | (StepBase & { readonly type: "wait"; readonly for: Duration })
  | (StepBase & { readonly type: "wait"; readonly until: Expression })
  | EventWaitStep;

/**
 * A wait for an event. Its output is the SDK's `step.listen`'s
 * (`EventWait`): the first event of its filter sent to the run (once the
 * run started, or while it waited), as the host minted it, or
 * `{ timedOut: true }` when none came within its timeout. A timeout is an
 * outcome a later step reads (`steps.<id>.output.timedOut`), never a
 * failure; the event's data is `steps.<id>.output.event.data`.
 *
 * Any failure of an event wait fails the run, and no `try` catches it:
 * its binding revoked (`workflow.event_denied`), the run's person no
 * longer active (`permission.person_inactive`), or a test run's wait
 * limit (`workflow.candidate_wait_limit`). The host checks the binding
 * again on every replay, so a catch would let a replay after a revocation
 * take a path the run never took.
 */
export interface EventWaitStep extends StepBase {
  readonly type: "wait";
  readonly event: EventFilter;
  readonly timeout: Duration;
}

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

export type Step =
  | DoStep
  | AgentStep
  | DecisionStep
  | ForEachStep
  | WaitStep
  | IfStep
  | TryStep
  | RaiseStep;

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
  /** The document as text, in UTF-8 bytes. */
  bytes: 1024 * 1024,
  /** Steps in all, at every level. */
  steps: 200,
  /** Lists one inside another (`then`, `try`, `catch.do`, a loop's `do`). */
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
 * What a `forEach` is, to whoever writes one: the schema's description,
 * with what bounds it from the platform's limits: the steps one run takes
 * in all, every item's counted, and the items one list may hold.
 */
export const forEachDescription = `Runs \`do\` for each of \`items\`, one item at a time, in order, with \`item\` in scope in its steps and in \`while\`. A run takes at most ${platformLimits.workflowSteps.toLocaleString("en")} steps in all, every step of every item counted, and that ceiling is what bounds a loop: a list may hold ${platformLimits.workflowCollectionItems.toLocaleString("en")} items, but a loop reaches the ceiling well before that when its items take more than one step each. A run that reaches it fails with workflow.too_many_steps: split the work over more runs, a run per page of items, say.`;

/** What a wait is, to whoever writes one: the schema's description. */
export const waitDescription =
  "Waits for a time span (`for`), until a deadline (`until`, ms since the epoch), or for an event sent to the run (`event: { from, type }`, `from` an event binding and `type` one or a list of the types its contract admits). An event wait names its `timeout`, at most a year, and its output is `{ timedOut: false, event: { id, type, source, subject?, time, data } }`, or `{ timedOut: true }` when no event came in time: a timeout is no failure, so read `steps.<id>.output.timedOut` before `steps.<id>.output.event.data`. Any failure of an event wait fails the run; no `try` catches it: its binding revoked, the run's person no longer active, or a test run's wait limit. The run checks its binding again on every replay, so a catch would let a replay after a revocation take a path the run never took.";

/**
 * Who a decision asks: a person or a team by ID, or everyone with a role,
 * as the platform's deciders are (`@grasp-os/shared/decisions`).
 */
export const recipientPattern = decidersPattern.source;

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

/**
 * The lists of steps a step of each type may hold, each by the path it is
 * under: an `if`'s `then` and `else`, a `try`'s `try` and its catch's
 * `catch/do`, a `forEach`'s `do`. The one list of them, for every tool
 * that walks or edits a document's steps.
 */
export const stepListPaths: Readonly<Record<StepType, readonly string[]>> = {
  do: [],
  agent: [],
  wait: [],
  if: ["then", "else"],
  try: ["try", "catch/do"],
  raise: [],
  decision: [],
  forEach: ["do"],
};

/** The steps `step` holds under list path `path`, if it holds that list. */
const stepListAt = (step: Step, path: string): readonly Step[] | undefined => {
  if (step.type === "if") {
    return path === "then" ? step.then : step.else;
  }
  if (step.type === "try") {
    return path === "try" ? step.try : step.catch.do;
  }
  if (step.type === "forEach") {
    return step.do;
  }
  return undefined;
};

/** The lists of steps `step` holds, each by its path (`stepListPaths`). */
export const stepListsOf = (
  step: Step
): readonly { readonly path: string; readonly steps: readonly Step[] }[] =>
  stepListPaths[step.type].flatMap((path) => {
    const steps = stepListAt(step, path);
    return steps === undefined ? [] : [{ path, steps }];
  });

/** Every step of `steps`, in order, nested ones included, with its pointer. */
export const eachStep = (
  steps: readonly Step[],
  pointer = "/steps"
): { readonly step: Step; readonly pointer: string }[] =>
  steps.flatMap((step, index) => {
    const at = `${pointer}/${index}`;
    return [
      { step, pointer: at },
      ...stepListsOf(step).flatMap((list) =>
        eachStep(list.steps, `${at}/${list.path}`)
      ),
    ];
  });
