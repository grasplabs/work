import { memberName } from "@grasp-os/sdk/host";
import type { CompactDescriptor } from "@grasp-os/sdk/host";
import { decidersPattern } from "@grasp-os/shared/decisions";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import {
  maxWorkflowParams,
  workflowParamNamePattern,
} from "@grasp-os/shared/workflows";

// grasp-workflow/2: a workflow as JSON, the stored form of a workflow on
// `@grasp-os/sdk/workflow`, in the App SDK's words: what starts a run is
// its `args`, what it ends with its `returns` (and its `result`), what it
// may reach its `permissions`, each kind by alias as an App's are. One
// step is one `ctx` call; a step's ID is an identifier, and an expression
// reads its result by it (`invoice.id`). The canvas draws it and the agent
// edits it step by step; what runs, is sealed and is exported is the
// TypeScript it generates (generate.ts). schema.ts defines it; check.ts
// checks it.
//
// A step kind joins the format as its SDK call joins the run host: a new
// `type` in the union, nothing else changing.

/**
 * The format's published JSON Schema, by its versioned URL: every document
 * names it as its `$schema`, the common way (as a tsconfig.json or a
 * package.json does), so an editor checks it as it is written.
 */
export const workflowSchemaUrl =
  "https://grasp.work/schemas/grasp-workflow/2.json";

/** The format's name and version, as a published version records it. */
export const definitionFormat = "grasp-workflow/2";

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
 * An expression (`@grasp-os/sdk/expression-check`): JavaScript a run
 * evaluates where it stands, reading `args`, `params`, `run`, `inbox`,
 * `state`, the results of the steps that ran before it by their IDs and,
 * in a catch, `error`; in a step's `state`, `output` too. As JSON, it is
 * an object of one value, so it is a `ValueRecord` too.
 */
export type Expression = ValueRecord & { readonly $expr: string };

/**
 * The root an expression reads a run's reply addresses by:
 * `inbox.<alias>`, the address (`reply-<token>@<host>`) of event
 * permission `<alias>`, whose contract takes email replies, as the run's
 * `ctx.inbox` has it. Typically a mail call's `replyTo`, and a later
 * `waitForEvent` on the same permission takes the reply. A string, or
 * `undefined` where the run has none: a deployment with no sign-in
 * origin, or one whose auth secret rotated since the run started.
 */
export const inboxRoot = "inbox";

/**
 * The roots an expression reads besides `args`, `params`, `run` and the
 * steps' results: the one list both the format's check (check.ts, which
 * says where each is in scope) and the compiler's typed check
 * (expression-scope.ts, which types each) read, so neither knows a root
 * the other doesn't. `inbox` and `state` are in scope everywhere, `error`
 * in a catch, `item` in a loop's items, and `output` in a step's `state`.
 */
export const expressionRoots = [
  inboxRoot,
  "state",
  "error",
  "item",
  "output",
] as const;
export type ExpressionRoot = (typeof expressionRoots)[number];

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

/**
 * A value's schema, as `v` declares it, in the compact form an SDK value
 * descriptor is written by hand in (`@grasp-os/sdk/host`'s
 * `descriptorFromCompact`): `{ "kind": "string", "max": 200 }` is
 * `v.string().max(200)`. A run's args, its returns, a model's answer, a
 * key of the state and a parameter are each declared so.
 */
export type Descriptor = CompactDescriptor;

/**
 * A parameter: a value people set without touching the workflow, of
 * `type`, as `v` declares it (`{ "kind": "money", "default": … }`).
 *
 * Sensitive unless it says `sensitive: false`, so a parameter nobody
 * thought about (an API key, say) is never shown, logged or handed to the
 * run's code. A sensitive parameter carries no value in the document,
 * which drafts, exports and reviews show: its value is set where parameter
 * values are kept, so its type has no `default`. A parameter that isn't
 * sensitive always has one.
 */
export interface Param {
  readonly label: string;
  readonly type: Descriptor;
  readonly sensitive?: boolean;
}

/** Whether `param` isn't sensitive: only one marked `sensitive: false`. */
export const isPlain = (param: Param): boolean => param.sensitive === false;

/** Whether `param` is sensitive: every parameter not marked otherwise. */
export const isSensitive = (param: Param): boolean => !isPlain(param);

/**
 * The kinds of permission a workflow declares, each by alias under its
 * key, as an App's `permissions` are: `ai` is the workflow's one model,
 * whose alias is `ai`; `connections`, `decisions` and `events` are the
 * catalog's connectors, decision contracts and event contracts; `files`
 * are the run's own files and `brain` one Brain collection each, which a
 * `call` step reaches as `ctx.files.<alias>` and `ctx.brain.<alias>`.
 */
export const permissionKinds = [
  "ai",
  "connections",
  "decisions",
  "events",
  "files",
  "brain",
] as const;
export type PermissionKind = (typeof permissionKinds)[number];

/**
 * What a permission reaches, as the host's catalog, the sealed table and
 * the run's bindings name it: the kind each permission is, by alias
 * (`bindingsOf`).
 */
export const bindingKinds = [
  "connector",
  "model",
  "decision",
  "event",
  "files",
  "brain",
] as const;
export type BindingKind = (typeof bindingKinds)[number];

/** The alias of the workflow's one `ai` permission. */
export const aiAlias = "ai";

/** A permission: the contract an admin approves, and its label. */
export interface Permission {
  readonly contract: string;
  /** What it is called where people see it: a label, renamed freely. */
  readonly title?: string;
}

/** What a workflow may reach, each kind by alias (`permissionKinds`). */
export interface Permissions {
  readonly ai?: Permission;
  readonly connections?: Readonly<Record<string, Permission>>;
  readonly decisions?: Readonly<Record<string, Permission>>;
  readonly events?: Readonly<Record<string, Permission>>;
  readonly files?: Readonly<Record<string, Permission>>;
  readonly brain?: Readonly<Record<string, Permission>>;
}

/** A permission held by alias: its kind, its alias, and what it binds. */
export interface AliasedPermission {
  readonly kind: Exclude<PermissionKind, "ai">;
  readonly alias: string;
  readonly binding: Binding;
}

/** The permissions of one kind held by alias, each binding as `bound`. */
const held = (
  kind: Exclude<PermissionKind, "ai">,
  entries: Readonly<Record<string, Permission>> | undefined,
  bound: BindingKind
): AliasedPermission[] =>
  Object.entries(entries ?? {}).map(([alias, permission]) => ({
    kind,
    alias,
    binding: { kind: bound, ...permission },
  }));

/**
 * Every permission `permissions` holds by alias, in the order of their
 * kinds: all but `ai`, whose alias is fixed (`aiAlias`).
 */
export const aliasedPermissions = (
  permissions: Permissions
): AliasedPermission[] => [
  ...held("connections", permissions.connections, "connector"),
  ...held("decisions", permissions.decisions, "decision"),
  ...held("events", permissions.events, "event"),
  ...held("files", permissions.files, "files"),
  ...held("brain", permissions.brain, "brain"),
];

/**
 * A permission as the host binds it: its kind, its contract and its
 * label. Every permission of every kind is one, by its alias
 * (`bindingsOf`).
 */
export interface Binding {
  readonly kind: BindingKind;
  readonly contract: string;
  readonly title?: string;
}

/**
 * Every permission of `document`, by alias, as the host binds it: the
 * `ai` permission as `ai`, a model. The check refuses one alias under two
 * kinds, so each alias is one binding.
 */
export const bindingsOf = (
  document: Pick<WorkflowDocument, "permissions">
): Readonly<Record<string, Binding>> => {
  const permissions = document.permissions ?? {};
  const bindings = new Map<string, Binding>();
  if (permissions.ai !== undefined) {
    bindings.set(aiAlias, { kind: "model", ...permissions.ai });
  }
  for (const { alias, binding } of aliasedPermissions(permissions)) {
    bindings.set(alias, binding);
  }
  return Object.fromEntries(bindings);
};

interface StepBase {
  /**
   * Its stable key, unique in the workflow, never changed once it is made:
   * an identifier (`stepIdPattern`), so its result is a `const` of that
   * name and an expression reads it as `<id>.<field>`; lists, retries and
   * the sealed table name it by it. A step is renamed by its `title`,
   * never its ID, so a rename breaks nothing.
   */
  readonly id: string;
  /**
   * What it does, in plain language, as the canvas and the run show it: a
   * label, renamed freely, which no code is generated from.
   */
  readonly title?: string;
  /** Runs only when this holds; skipped, its result is `null`. */
  readonly if?: Expression;
}

/**
 * What a step keeps in its workflow's state, by a key the workflow
 * declares (`WorkflowDocument.state`): each value written from the step's
 * own result (`output` in its expressions) once the step succeeded, and
 * read by every later run as `state.<key>`. A step its `if` skips writes
 * nothing. A restricted run reads the workflow's state but
 * doesn't change it, and nor does a test run: the host skips the write.
 */
export type StateWrites = Readonly<Record<string, Value>>;

interface CallBase extends StepBase {
  readonly type: "call";
  readonly args?: Value;
  /** The most one attempt may take. */
  readonly timeout?: Duration;
  readonly state?: StateWrites;
}

/**
 * What a `call` step on a `files` permission does with the run's own
 * files, as `ctx.files.<alias>.<action>` names it: reads a text file whole
 * (`{ file }`: `{ file: <ref>, text }`), writes one (`{ name, type, text }`:
 * its ref), lists them (`{}`: refs) or deletes one (`{ file }`).
 */
export const filesActions = ["read", "write", "list", "delete"] as const;
export type FilesAction = (typeof filesActions)[number];

/**
 * What a `call` step on a `brain` permission does with its one Brain
 * collection, as `ctx.brain.<alias>.<action>` names it: searches it, reads
 * an entry, or recalls what bears on a question, each only as the run's
 * person may read it.
 */
export const brainActions = ["search", "read", "recall"] as const;
export type BrainAction = (typeof brainActions)[number];

/**
 * A call of a connection's action, `ctx.connections.<connection>.<action>`.
 * A read whose contract answers a file (`answersFile`) may keep that file
 * as the run's own, in files permission `into`; a write whose contract
 * takes files (`takesFiles`) may attach run files, named by ID in its
 * `attachments`, from files permission `from`.
 */
export interface ConnectionCallStep extends CallBase {
  readonly connection: string;
  readonly action: string;
  readonly into?: string;
  readonly from?: string;
}

/**
 * A call of a workflow's typed member: a connection's action
 * (`ctx.connections`), the run's own files (`ctx.files`) or a Brain
 * collection (`ctx.brain`). One step type for every member call: the key
 * that names its permission says which kind it is, as `ctx.<kind>.<alias>`
 * does.
 */
export type CallStep =
  | ConnectionCallStep
  | (CallBase & { readonly files: string; readonly action: FilesAction })
  | (CallBase & { readonly brain: string; readonly action: BrainAction });

/**
 * Asks the workflow's model (`permissions.ai`) for an answer of
 * `returns`' shape: `ctx.ai.generate`.
 */
export interface GenerateStep extends StepBase {
  readonly type: "generate";
  readonly instructions: Value;
  readonly input: Value;
  /** What the answer must be. */
  readonly returns: Descriptor;
  readonly timeout?: Duration;
  readonly state?: StateWrites;
}

/**
 * Asks people to decide, through decision permission `decision`, and
 * waits for the answer: `ctx.decisions.<decision>.ask`. Its result is
 * `{ timedOut: false, approved, by, payload }`, or `{ timedOut: true }`
 * when nobody answered within `timeout`. A timeout never means approval.
 */
export interface DecideStep extends StepBase {
  readonly type: "decide";
  readonly decision: string;
  /**
   * Who is asked, 1 to 16 of `person:<user ID>`, `team:<team ID>` and
   * `role:<role>`: a list, any item of which may be an expression, or an
   * expression for the whole list. Any of them may answer.
   */
  readonly recipients: Value;
  /** What they are asked, at most 500 characters. */
  readonly prompt: Value;
  /** What they decide on, as the permission's contract takes it. */
  readonly input: Value;
  /** How long it waits for an answer: until the run's own deadline if not given. */
  readonly timeout?: Duration;
}

/**
 * Runs `do` for each of `items`, one item at a time, in order: `item` is
 * in scope in its steps and in `while`. A step inside it is read only by
 * the steps after it in the same item.
 *
 * What bounds a loop is the run's step ceiling (`forEachDescription`): every step
 * of every item counts toward it, so a loop of many items, or of items
 * of many steps, can reach it well before its last item. A run that does
 * fails with `workflow.too_many_steps`, which says to split the work over
 * more runs (a run per page of items, say).
 */
export interface ForEachStep extends StepBase {
  readonly type: "forEach";
  /** A list of items. */
  readonly items: Expression;
  /** Goes on to each next item only while this holds. */
  readonly while?: Expression;
  readonly do: readonly Step[];
}

/**
 * Which of an event source's events a wait takes (core's
 * workflows/event-waits.ts): the first whose `data` has, at JSON Pointer
 * `field` (RFC 6901, `/invoice` or `/order/id`), exactly the text, number
 * or boolean `equals` gives, worked out and recorded as the wait is
 * reached, so a replay waits for the same. Core matches it, never the
 * run's code. One that came before the wait was reached, and that no
 * other wait took, is taken first, if it came within a day.
 */
export interface EventFieldMatch {
  readonly field: string;
  readonly equals: Value;
}

/** Waits for a time span, or until a deadline (ms since the epoch). */
export type WaitStep =
  | (StepBase & { readonly type: "wait"; readonly for: Duration })
  | (StepBase & { readonly type: "wait"; readonly until: Expression });

/**
 * Waits for an event sent to the run through event permission `events`,
 * of `eventType` or any of a list of types, each one its contract admits:
 * `ctx.events.<events>.waitFor`. With `match`, only one of the events an
 * event source sends (a webhook) whose data has, at `match.field`, the
 * value `match.equals` gives. Its result is the first such event (once the
 * run started, or while it waited), as the host minted it, or
 * `{ timedOut: true }` when none came within its timeout. A timeout is an
 * outcome a later step reads (`<id>.timedOut`), never a failure; the
 * event's data is `<id>.event.data`.
 *
 * Any failure of an event wait fails the run, and no `try` catches it:
 * its permission revoked (`workflow.event_denied`), the run's person no
 * longer active (`permission.person_inactive`), or a test run's wait
 * limit (`workflow.candidate_wait_limit`). The host checks the permission
 * again on every replay, so a catch would let a replay after a revocation
 * take a path the run never took.
 */
export interface WaitForEventStep extends StepBase {
  readonly type: "waitForEvent";
  readonly events: string;
  readonly eventType: string | readonly string[];
  readonly match?: EventFieldMatch;
  readonly timeout: Duration;
}

/** Runs `then` when `condition` holds, `else` otherwise. */
export interface IfStep extends StepBase {
  readonly type: "if";
  readonly condition: Expression;
  readonly then: readonly Step[];
  readonly else?: readonly Step[];
}

/** Tries a failing call of the `try` list again, after a backoff. */
export interface Retry {
  /** Attempts in all, the first included: 1 to 5. */
  readonly attempts: number;
  readonly delay: Duration;
  readonly backoff: "constant" | "linear" | "exponential";
  /** Retries only while this holds, `error` in scope. */
  readonly when?: Expression;
}

/**
 * Runs `try`; a failure there its catch takes runs `catch.do` instead. A
 * catch takes a failure of its `code` (an `AppError` code: the platform's,
 * such as `connect.rate_limited`, or one the workflow raises), any when it
 * names none, and only while its `when` holds.
 */
export interface TryStep extends StepBase {
  readonly type: "try";
  readonly try: readonly Step[];
  readonly catch: {
    readonly code?: string;
    /** Takes only while this holds, `error` in scope. */
    readonly when?: Expression;
    readonly retry?: Retry;
    readonly do?: readonly Step[];
  };
}

/**
 * Fails the run with the workflow's own `AppError`, which a catch may
 * take: its `code` in a namespace of the workflow's own
 * (`invoice.rejected`), never one of the platform's.
 */
export interface RaiseStep extends StepBase {
  readonly type: "raise";
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Json;
  };
}

export type Step =
  | CallStep
  | GenerateStep
  | DecideStep
  | ForEachStep
  | WaitStep
  | WaitForEventStep
  | IfStep
  | TryStep
  | RaiseStep;

export type StepType = Step["type"];

/** The steps that have a result, which a later expression reads by the step's ID. */
export const resultStepTypes: ReadonlySet<StepType> = new Set([
  "call",
  "generate",
  "decide",
  "waitForEvent",
]);

/** A workflow in grasp-workflow/2. */
export interface WorkflowDocument {
  /** What the document is: the format's schema, `workflowSchemaUrl`. */
  readonly $schema: typeof workflowSchemaUrl;
  /** What starts a run: an object of no fields when not given. */
  readonly args?: Descriptor;
  /** What a run ends with: null when not given. */
  readonly returns?: Descriptor;
  /** What it ends with, of `returns`' shape: only with `returns`. */
  readonly result?: Value;
  readonly params?: Readonly<Record<string, Param>>;
  readonly permissions?: Permissions;
  /**
   * What it keeps between its runs: each key's schema, as `args`'. A
   * step writes only these keys, each value of its key's schema.
   */
  readonly state?: Readonly<Record<string, Descriptor>>;
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
  params: maxWorkflowParams,
  /** Permissions in all, every kind's. */
  bindings: 64,
  /** The keys one step keeps in its workflow's state, as the host seals them. */
  stateKeys: 64,
  /** An event wait's `match.field`, a JSON Pointer. */
  matchFieldLength: 256,
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

/**
 * The steps that may keep state: those whose own recorded step is their
 * call's, which the host writes the state with. A decision, a wait, a
 * loop, an `if`, a `try` and a raise record no result of their own there.
 */
export const stateStepTypes = ["call", "generate"] as const;

/**
 * What a step's `state` is, to whoever writes one: the schema's
 * description. The 64 KB is the run host's cap on a workflow's state in
 * all (core's `workflowStateMaxBytes`), which only a run can reach: no
 * check of the document can.
 */
export const stateDescription = `What the step keeps in its workflow's state once it succeeded: \`{ "<key>": <value> }\`, each key one the workflow declares under its top-level \`state\`, and each value of that key's schema. A value is JSON, any part of which may be an expression; there \`output\` is this step's result. A literal value is checked against its key's schema as the workflow is; every value is checked again as the step records it, and one of another shape fails the step, keeping nothing. Every expression of the workflow reads the state as it was when the run started, as \`state.<key>\`, which is undefined until a run kept it: write \`state.<key> ?? <default>\`. Every version of the workflow keeps the same state, so a value kept under an older schema that doesn't fit this version's reads as undefined too, as a key never written. A step its \`if\` skips keeps nothing, and a replay never writes twice. A restricted run reads the workflow's state but doesn't change it, and nor does a test run. A workflow's state holds at most 64 KB in all, which only a run can reach: a step that would pass it fails with workflow.state_too_large, and since its call already answered, the run ends with workflow.failed_after_effect, as it does when a value isn't of its key's schema. Only a \`call\` or a \`generate\` step keeps state.`;

/** What a workflow's `state` declares, to whoever writes one. */
export const stateDeclarationDescription = `What the workflow keeps between its runs: \`{ "<key>": <descriptor> }\`, at most ${formatLimits.stateKeys} keys, each a letter then letters, digits and \`_\`, each with a value's schema as \`args\` has one, such as \`{ "kind": "number", "integer": true }\`. A \`call\` or \`generate\` step's \`state\` writes these keys alone, and every expression reads them as \`state.<key>\`.`;

/** What an event wait is, to whoever writes one: the schema's description. */
export const waitForEventDescription =
  "Waits for an event sent to the run: `events` names an event permission and `eventType` one or a list of the types its contract admits. To wait for a webhook event about this run's own thing (a payment for the invoice it sent, say), give `match: { field, equals }`: `field` a JSON Pointer into the event's data (`/invoice`), `equals` the text, number or boolean it must be, usually an expression (`{ $expr: \"send.invoice\" }`); Grasp matches it, and an event that came up to a day before the wait is taken first. An event wait names its `timeout`, at most a year, and its result is `{ timedOut: false, event: { id, type, source, subject?, time, data } }`, or `{ timedOut: true }` when no event came in time: a timeout is no failure, so read `<id>.timedOut` before `<id>.event.data`. To wait for a reply to the run's mail, give the mail `inbox.<events>` (the run's reply address for that permission, or `undefined` when it has none) as its reply-to address, then wait on the same permission. Any failure of an event wait fails the run; no `try` catches it: its permission revoked, the run's person no longer active, or a test run's wait limit. The run checks its permission again on every replay, so a catch would let a replay after a revocation take a path the run never took.";

/**
 * Who a decision asks: a person or a team by ID, or everyone with a role,
 * as the platform's deciders are (`@grasp-os/shared/decisions`).
 */
export const recipientPattern = decidersPattern.source;

/**
 * What a step ID may be: an identifier of ASCII letters and digits,
 * starting with a lower-case letter, so its result is a `const` of that
 * name in the generated code (`reservedStepIds` says which names it may
 * not take).
 */
export const stepIdPattern = "^[a-z][A-Za-z0-9]{0,63}$";

/**
 * The names a step can't take: JavaScript's reserved words and the
 * globals an expression may not shadow, the expression roots and the
 * names the generated code binds (`ctx`, `thrown`, its imports and
 * helpers; a nested loop's list is `$$<id>` and a retry's guard
 * `<id>Retries`, which no ID can shadow), and the names no expression may
 * read (`constructor`, `prototype`, `__proto__`).
 */
export const reservedStepIds: ReadonlySet<string> = new Set([
  // ECMAScript's reserved words, strict mode's and modules' included,
  // lower-case and so able to match the pattern.
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "arguments",
  "eval",
  "undefined",
  "async",
  "of",
  // What the generated code and its expressions bind.
  "args",
  "params",
  "run",
  "result",
  "ctx",
  "thrown",
  "defineWorkflow",
  "v",
  "caughtError",
  "itemsOf",
  "sensitiveParam",
  ...expressionRoots,
  // What no expression reads.
  "constructor",
  "prototype",
]);

/**
 * A parameter's name: an identifier, so code reads it as `params.<name>`.
 * Like a step's ID and a permission's alias, a stable key, never changed
 * once made: a parameter is renamed by its `label`.
 */
export const paramNamePattern = workflowParamNamePattern.source;

/**
 * A key of a workflow's state, as the host keeps it and an expression
 * reads it (`state.<key>`).
 */
export const stateKeyPattern = "^[A-Za-z][A-Za-z0-9_]{0,63}$";

/** A permission's alias, as the host's bindings take it and `ctx.<kind>.<alias>` reads it. */
export const aliasPattern = "^[A-Za-z][A-Za-z0-9_]{0,63}$";

/**
 * A connection's action, as `ctx.connections.<alias>.<action>` calls it:
 * dotted segments (`mail.send`), each a member of the one before, each a
 * letter, then letters, digits, `_` or `-` (`send-mail` is `sendMail`).
 */
export const actionPattern =
  "^[A-Za-z][A-Za-z0-9_-]{0,63}(?:\\.[A-Za-z][A-Za-z0-9_-]{0,63}){0,3}$";

/**
 * The lists of steps a step of each type may hold, each by the path it is
 * under: an `if`'s `then` and `else`, a `try`'s `try` and its catch's
 * `catch/do`, a `forEach`'s `do`. The one list of them, for every tool
 * that walks or edits a document's steps.
 */
export const stepListPaths: Readonly<Record<StepType, readonly string[]>> = {
  call: [],
  generate: [],
  decide: [],
  wait: [],
  waitForEvent: [],
  if: ["then", "else"],
  try: ["try", "catch/do"],
  raise: [],
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

/**
 * The name the generated code gives a retrying try's guard (`<try>Retries`),
 * which the check keeps from any step's ID: the two would be one name in
 * one scope.
 */
export const retriesOf = (id: string): string => `${id}Retries`;

/**
 * Whether a try retries through a guard (`retriesOf`): it retries, and its
 * catch's `when` or its retry's own decides which failures, so a retry
 * runs only for a failure its catch would take.
 */
export const retriesByGuard = (step: TryStep): boolean =>
  step.catch.retry !== undefined &&
  (step.catch.when !== undefined || step.catch.retry.when !== undefined);

/**
 * The name the generated code gives the guard of a try inside a retrying
 * one whose catch takes a failure by its `when` (`<try>Takes`): whether
 * it takes a failure, which the isolate alone can say. A call in its list
 * retries only when it doesn't: the innermost catch that takes a failure
 * has it before any retry further out.
 */
export const takesOf = (id: string): string => `${id}Takes`;

/**
 * Whether a try, inside a retrying one when `retrying`, takes a failure
 * through a guard (`takesOf`): it doesn't retry itself, and its catch's
 * `when` decides. A catch with no `when` the host decides by its code.
 */
export const takesByGuard = (step: TryStep, retrying: boolean): boolean =>
  retrying && step.catch.retry === undefined && step.catch.when !== undefined;

/**
 * The names the generated code gives the tries' guards of `steps`
 * (`retriesOf`, `takesOf`), inside a retrying try when `retrying`: the
 * check keeps them from every step's ID, as one scope would hold both.
 */
export const guardNamesOf = (
  steps: readonly Step[],
  retrying = false
): string[] =>
  steps.flatMap((step) => {
    const names: string[] = [];
    let inner = retrying;
    if (step.type === "try") {
      if (retriesByGuard(step)) {
        names.push(retriesOf(step.id));
      }
      if (takesByGuard(step, retrying)) {
        names.push(takesOf(step.id));
      }
      inner = retrying || step.catch.retry !== undefined;
    }
    return [
      ...names,
      ...stepListsOf(step).flatMap((list) =>
        // Only a try's own list is what its retry covers; its catch's
        // steps stand where the try does.
        guardNamesOf(list.steps, list.path === "try" ? inner : retrying)
      ),
    ];
  });

/** A connector contract's group: `mail` of `google-workspace.mail@1`. */
const contractGroup = /\.(?<group>[^.@]+)@[^@]*$/u;

/** A dotted action as a path of members (`memberName` of each part). */
const memberPath = (action: string): string =>
  action
    .split(".")
    .map((part) => memberName(part))
    .join(".");

/**
 * Each connection's actions, by alias, each by the member path a call
 * reads it by (`memberName` of each dotted part): the action as its
 * contract names it, without the group every operation of the contract
 * starts with (`mail.send` of `google-workspace.mail@1` is `send`), as an
 * App's connection lists it, so `ctx.connections.mail.send` reads as an
 * App's call does. Where two of a connection's actions would read alike
 * so (`mail.readX` and `read-x`), each keeps its whole name, a path of
 * members (`ctx.connections.crm.notes.add`); the check refuses two whose
 * whole names read alike. The host always gets the action itself.
 */
export const memberPathsOf = (
  document: WorkflowDocument
): ReadonlyMap<string, ReadonlyMap<string, string>> => {
  const actions = new Map<string, Set<string>>();
  for (const { step } of eachStep(document.steps)) {
    if (step.type === "call" && "connection" in step) {
      const called = actions.get(step.connection) ?? new Set<string>();
      called.add(step.action);
      actions.set(step.connection, called);
    }
  }
  return new Map(
    [...actions].map(([alias, called]) => {
      const contract =
        document.permissions?.connections?.[alias]?.contract ?? "";
      const group = contractGroup.exec(contract)?.groups?.group;
      const prefix = group === undefined ? undefined : `${group}.`;
      const stripped = [...called].map(
        (action) =>
          [
            action,
            memberPath(
              prefix !== undefined && action.startsWith(prefix)
                ? action.slice(prefix.length)
                : action
            ),
          ] as const
      );
      const alike =
        new Set(stripped.map(([, member]) => member)).size !== stripped.length;
      return [
        alias,
        new Map(
          stripped.map(([action, member]) => [
            action,
            alike ? memberPath(action) : member,
          ])
        ),
      ] as const;
    })
  );
};

const pointerEscape = /[~/]/gu;

/** `pointer` with `token` appended, escaped (RFC 6901). */
export const pointerJoin = (pointer: string, token: string | number): string =>
  `${pointer}/${String(token).replaceAll(pointerEscape, (char) =>
    char === "~" ? "~0" : "~1"
  )}`;
