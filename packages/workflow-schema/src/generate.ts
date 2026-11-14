import type { ValueDescriptor } from "@grasp-os/runtime/app";
import { runtimeNames } from "@grasp-os/runtime/check";
import { validatorSource } from "@grasp-os/runtime/definition";
import { z } from "zod";

import type { CheckedWorkflow } from "./check.ts";
import {
  aiAlias,
  durationMs,
  inboxRoot,
  isPlain,
  isValueList,
  memberPathsOf,
  pointerJoin,
  resultStepTypes,
  retriesByGuard,
  retriesOf,
  takesByGuard,
  takesOf,
} from "./format.ts";
import type { Json, Step, TryStep, Value, WaitForEventStep } from "./format.ts";
import type {
  SealedCall,
  SealedCatch,
  SealedExpression,
  SealedTable,
  SealedTask,
  Template,
} from "./sealed.ts";

// The generator: a checked grasp-workflow/2 document (check.ts) translated
// straight into TypeScript on `@grasp-os/sdk/workflow` that reads as an
// App's code does, and into the sealed table the run host holds that code
// to (core's workflows/sealed-run.ts): each task's steps, the call its
// step makes with the template its arguments must match, its catch, its
// raise, its wait. The code is what runs, is sealed and is exported; the
// table is what the host trusts.
//
// The code is the document's steps in its order, in plain JavaScript: a
// `defineWorkflow` whose handler makes each call through `ctx`, each
// result a `const` named after its step (`const invoice = await
// ctx.connections.stripe.invoices.create({ … }, { step: "invoice" })`), an
// `if` an `if`, a loop a `for … of`, a `try` a `try`, a raise a thrown
// `AppError`. Every `ctx` call journals itself under the step it names, so
// no wrapper and no thunk stands around it; expressions are evaluated in
// the code as written, again on replay, which reads the same journaled
// values (workflow.ts's threat model). The line map (`spans`,
// `taskAtLine`) ties each line back to its step on the canvas.
//
// Why each call names its step (`{ step: "invoice" }`) rather than the
// line map tying a call to its step as it runs. The step is the call's
// journal key and what the host holds it to (its sealed task: its
// template, its timeout, its state, the `try` around it), so it must be
// a fact of the sealed build, the same on every replay, and something the
// host can check. A line is none of that at run time: the only way to
// learn it is a stack trace, which is V8's text, read in the isolate the
// host distrusts, over the compiled module, whose lines the compiler and
// the runtime may move; two calls can share a line; and a key derived
// from it would change the journal of every run in flight whenever a
// change upstream shifted the lines. Sequence alone (the n-th call, as a
// durable SDK without names journals) doesn't name a task either: an
// `if` and a loop decide in the isolate which call comes next, so the
// host can't tell which of two calls of one action a call is, nor which
// sealed template, timeout and catch hold it. So the step's ID, a literal
// of the sealed document, names the call, as Convex's workflow names a
// step and Temporal an activity; the line map stays what it is: the
// generated code's lines, mapped back to the canvas for diagnostics and
// the run view.
//
// Threat model, and how each is closed:
//
// - Text of the document becoming code. No string, key or ID of the
//   document is spliced into the module as written: every string is a
//   literal through `JSON.stringify` (quotes, backslashes, line
//   separators, `${`, backticks and `*\/` included), every key a plain
//   name only where it is an identifier (`__proto__` always a computed
//   string, so it is a key, never the prototype), a quoted string
//   otherwise. The only comment is a fixed header. Expressions come as
//   code printed from their checked syntax tree
//   (`@grasp-os/runtime/check`), never as their source.
// - IDs becoming names. A step's ID is a `const` of the handler: the
//   format holds it to an identifier that is no reserved word and none of
//   the names the code binds (`reservedStepIds`), so it shadows nothing.
//   Aliases and actions are members (`ctx.connections.<alias>.<path>`),
//   a member after a dot whatever word it is.
// - Prototype access through expressions or data, and computed names:
//   refused by the expression check, and data is frozen with no prototype
//   as the runtime reads it (expression-check.ts, workflow.ts).
// - Replay determinism without enter steps: each call's journal name is
//   its step's (`{ step }`); flow and arguments are evaluated again from
//   journaled values, which is what keeps a replay on its path (a step
//   already journaled answers from the journal, its arguments unread);
//   every call past the journal is held to its template and its step's
//   next run, so a replay that diverged reaches nothing unsealed.
// - Members exposing undeclared names. The module declares exactly the
//   permissions its steps use, by alias, with exactly the actions and
//   event types they name; the SDK builds `ctx`'s members from that alone
//   (workflow.ts). The host never trusts the declaration: what it decides
//   a call by is the sealed table.
// - Code that loops or reaches past the SDK. The only loop statement is a
//   `forEach`'s `for … of` over its items (`itemsOf`: a list of at most
//   the platform's 1,000), each item's steps one at a time and every one
//   counted against the run's step ceiling. The module imports
//   `@grasp-os/sdk/workflow`, its helpers for generated code included,
//   and nothing else (the compiler
//   refuses any other import of generated code all the same).
// - A sensitive value reaching the run's code. A sensitive parameter is
//   only ever `sensitiveParam(<name>)` in a connection call's arguments,
//   sealed there as a `param` the host fills in; the code declares only
//   the parameters that aren't sensitive.
// - The host trusting what the code says: a call the build didn't seal.
//   Everything the host decides on is in the sealed table, built here from
//   the same document, never read from the code: which steps exist, which
//   call each makes through which permission, every literal of its
//   arguments, each catch's code and retry, each raise's error, each
//   wait's length, each event wait's permission, types and timeout, and
//   the keys each task keeps in state with the template of each value: a
//   call or record of anything else is the host's to refuse.
// - The run's files and the Brain reached past what was approved. A files
//   or Brain call names its permission and its action, both sealed (an
//   action of the format's fixed lists, `filesActions`, `brainActions`),
//   and only its arguments are the isolate's: a file is named by its ID,
//   which an expression may compute, but the host looks each file up by
//   that ID *and* the run's own, so no ID of another run's file, made up
//   or carried in data, reaches one; a Brain collection is the
//   permission's one, read as the run's person may (core's
//   resource-reads.ts). A connection's `into` and `from`, the files
//   permissions a read keeps its file in and a write attaches files from,
//   are sealed too: the code names the same ones, and the host refuses a
//   call that names others, or names any where the action's contract
//   doesn't answer or take files.
//
// Calls of an App's functions (`ctx.apps.<alias>.<path>`, GRA-1663) add:
//
// - A workflow reaching a function it didn't declare. The member path is
//   only a name for the call: the module maps each path to the function's
//   stable ID, the isolate sends that ID, and the host holds it to the
//   sealed `grasp.app` call of the step, whose App and function IDs come
//   from the document, never from the code. The App's ID never crosses
//   into the isolate at all. The host then needs the workflow's own
//   active grant on exactly that function (core's workflows/app-calls.ts).
// - A rename racing a publish, or a rollback. Nothing that runs names a
//   function by its path: the sealed call carries its ID, which resolves
//   in the App's current release, so a rename, before, during or after a
//   publish, reaches the same function; the path, the document's hint,
//   only names the member, so a build is the document's alone, the same
//   whatever the App is called now. Saving the document names it afresh.
// - An App deleted, or a function removed, while runs wait. The call
//   resolves when it is made, so the next call fails
//   (`workflow.call_denied`, `workflow.app_function_unavailable`), which
//   no catch mistakes for the App's own answer; publication refuses a
//   function the App no longer gives.
// - A path becoming code. A path is held to an App's function path
//   (`functionPathPattern`: identifiers, so never `__proto__`), each
//   segment a member after a dot; the IDs are literals.

/** The SDK the generated module imports. */
export const generatedImport = "@grasp-os/sdk/workflow";

/**
 * The generator, as a build names what made it. A build seals the SDK its
 * code was generated for, which the run host's engine must fit, so a new
 * version here is a new contract between them: core loads only builds of
 * this one, and an older build is refused, to publish again
 * (`workflow.format_unsupported`), never half run.
 */
export const generatorVersion = "grasp-workflow-ts/7";

/** A task as its generator writes it: the loops around it are added. */
type Unscoped<Task> = Task extends unknown ? Omit<Task, "scope"> : never;

/** The lines a task's code takes in the module, from 1, both ends included. */
export interface TaskSpan {
  readonly taskId: string;
  readonly pointer: string;
  readonly from: number;
  readonly to: number;
}

/** What a document generates: the module, and the table it is held to. */
export interface Generation {
  readonly source: string;
  readonly tasks: readonly SealedTask[];
  readonly expressions: readonly SealedExpression[];
  readonly spans: readonly TaskSpan[];
  /** Whether it returns a result, recorded in `workflow:output`. */
  readonly workflow: SealedTable["workflow"];
  /** The parameters its code reads: those that aren't sensitive. */
  readonly params: readonly string[];
}

/**
 * The innermost task whose code holds `line` of the module, if any: where
 * a diagnostic of the generated code is, in the document's terms.
 */
export const taskAtLine = (
  spans: readonly TaskSpan[],
  line: number
): TaskSpan | undefined => {
  let inner: TaskSpan | undefined;
  for (const span of spans) {
    const holds = span.from <= line && line <= span.to;
    if (
      holds &&
      (inner === undefined || span.to - span.from < inner.to - inner.from)
    ) {
      inner = span;
    }
  }
  return inner;
};

const literal = (value: unknown): string => JSON.stringify(value);

/**
 * An expression's code without the parentheses around it, for where it
 * stands as a whole expression (an argument, a value, a condition): the
 * check's code is one parenthesized expression, which needs them only as
 * an operand.
 */
const bare = (code: string): string => code.slice(1, -1);

/**
 * `text` at `depth`, each of its lines (a declaration or an object the
 * printer spread over several) two spaces further in a level. A line
 * break inside a string never reaches here: every string is a literal,
 * escaped, and a template's text carries its breaks as escapes too
 * (`@grasp-os/runtime`'s printer).
 */
const indented = (text: string, depth: number): string =>
  text
    .split("\n")
    .map((line) => `${"  ".repeat(depth)}${line}`)
    .join("\n");

/** An ASCII identifier name: what may follow a dot or stand as a key. */
const plainName = /^[A-Za-z_$][\w$]*$/u;

/** `key` as an object literal's key: plain where it can be, never `__proto__`. */
const keyOf = (key: string): string => {
  if (key === "__proto__") {
    return `[${literal(key)}]`;
  }
  return plainName.test(key) ? key : literal(key);
};

/** `.name` where it is a name, `["name"]` otherwise. */
const memberOf = (name: string): string =>
  plainName.test(name) ? `.${name}` : `[${literal(name)}]`;

/** An object literal of `entries`, each `[key, code]`, on one line. */
const objectCode = (entries: readonly (readonly [string, string])[]): string =>
  entries.length === 0
    ? "{}"
    : `{ ${entries.map(([key, code]) => `${keyOf(key)}: ${code}`).join(", ")} }`;

/** A step, with where it is. */
type Placed<S extends Step = Step> = S & { readonly pointer: string };

/** An expression's entry in the review table, but for what generating it adds. */
type ExpressionEntry = Omit<
  SealedExpression,
  "slot" | "pointer" | "source" | "loopVariables"
>;

/** `templates`' literals, if every one is a literal. */
const literalsOf = (templates: readonly Template[]): Json[] | undefined => {
  const literals: Json[] = [];
  for (const template of templates) {
    if (!("literal" in template)) {
      return undefined;
    }
    literals.push(template.literal);
  }
  return literals;
};

/** What a loop's items' code reads its item by. */
const loopItem = "item";

/** The roots of `ctx` the handler binds, as its expressions read them. */
const contextRoots = ["params", "run", "state", inboxRoot] as const;

/**
 * The `try` around the code being generated that retries, if any: what a
 * call in its list passes as `retry`, `true` or the name of its `when`'s
 * function, which the try declares where it is written (`retriesOf`);
 * and the guards of the tries between it and the call whose catch takes
 * a failure by its `when` (`takesOf`), each declared where its try is.
 * The innermost catch that takes a failure has it before any retry
 * further out, so the call retries only when none of them takes it.
 */
interface Retrying {
  readonly retry: string;
  readonly unless: readonly string[];
}

/** What a call passes as `retry` under `retrying`. */
const retryCode = ({ retry, unless }: Retrying): string => {
  if (unless.length === 0) {
    return retry;
  }
  const holds = [
    ...unless.map((takes) => `!${takes}(error)`),
    ...(retry === "true" ? [] : [`${retry}(error)`]),
  ];
  return `(error: CaughtError) => ${holds.join(" && ")}`;
};

/** A call's options: its step, its retry, and what it keeps. */
const callOptions = (
  step: Step,
  retrying: Retrying | undefined,
  state: readonly (readonly [string, string])[]
): string => {
  const options: (readonly [string, string])[] = [["step", literal(step.id)]];
  // Where a connection's read keeps its file and where a write's
  // attachments come from, as the build seals them: the code names the
  // same, and the host refuses a call that names others.
  if (step.type === "call" && "connection" in step) {
    if (step.into !== undefined) {
      options.push(["into", literal(step.into)]);
    }
    if (step.from !== undefined) {
      options.push(["from", literal(step.from)]);
    }
  }
  if (retrying !== undefined) {
    options.push(["retry", retryCode(retrying)]);
  }
  if (state.length > 0) {
    options.push(["state", `(output) => (${objectCode(state)})`]);
  }
  return objectCode(options);
};

class Generator {
  readonly #workflow: CheckedWorkflow;
  readonly #lines: string[] = [];
  readonly #tasks: SealedTask[] = [];
  readonly #expressions: SealedExpression[] = [];
  readonly #spans: TaskSpan[] = [];
  readonly #imports = new Set(["defineWorkflow", "v"]);
  readonly #generatedImports = new Set<string>();
  /** The `forEach` loops around the code being generated, outermost first. */
  #loops: readonly string[] = [];
  /** What the module's permissions declare, as its steps use them. */
  readonly #connections = new Map<string, Map<string, string>>();
  /** Each connection's operations' member paths (`memberPathsOf`). */
  readonly #memberPaths: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly #decisions = new Set<string>();
  readonly #events = new Map<string, Set<string>>();
  /** The actions each files and brain permission's steps take. */
  readonly #files = new Map<string, Set<string>>();
  readonly #brain = new Map<string, Set<string>>();
  /** Each App's functions its steps call, member path to function ID. */
  readonly #apps = new Map<string, Map<string, string>>();
  #ai = false;

  constructor(workflow: CheckedWorkflow) {
    this.#workflow = workflow;
    this.#memberPaths = memberPathsOf(workflow.document);
  }

  #line(depth: number, text: string): void {
    this.#lines.push(...indented(text, depth).split("\n"));
  }

  /** The code of the expression at `pointer`, recorded for review. */
  #expression(
    pointer: string,
    entry: ExpressionEntry
  ): { code: string; slot: number } {
    const code = this.#workflow.code.get(pointer);
    if (code === undefined) {
      throw new Error(`No checked expression at ${pointer}`);
    }
    if (code.includes(`${runtimeNames.own}(`)) {
      this.#generatedImports.add(`own as ${runtimeNames.own}`);
    }
    if (code.includes(`${runtimeNames.parse}(`)) {
      this.#generatedImports.add(`parse as ${runtimeNames.parse}`);
    }
    const slot = this.#expressions.length;
    this.#expressions.push({
      slot,
      pointer,
      source: code,
      // `item` in a loop's items: the innermost loop's, for review.
      loopVariables: this.#loops.length === 0 ? [] : [loopItem],
      ...entry,
    });
    return { code, slot };
  }

  /** `value`'s code and the template the host holds its value to. */
  #value(
    value: Value | undefined,
    pointer: string,
    entry: ExpressionEntry
  ): { code: string; template: Template } {
    if (value === undefined) {
      return { code: "{}", template: { literal: {} } };
    }
    const placeholder = this.#workflow.placeholders.get(pointer);
    if (placeholder !== undefined) {
      this.#imports.add("sensitiveParam");
      return {
        code: `sensitiveParam(${literal(placeholder)})`,
        template: { param: placeholder },
      };
    }
    if (this.#workflow.code.has(pointer)) {
      const { code, slot } = this.#expression(pointer, entry);
      return { code: bare(code), template: { slot } };
    }
    if (value === null || typeof value !== "object") {
      return { code: literal(value), template: { literal: value } };
    }
    if (isValueList(value)) {
      const items = value.map((item: Value, index) =>
        this.#value(item, pointerJoin(pointer, index), entry)
      );
      const literals = literalsOf(items.map(({ template }) => template));
      return {
        code: `[${items.map(({ code }) => code).join(", ")}]`,
        template:
          literals === undefined
            ? { array: items.map(({ template }) => template) }
            : { literal: literals },
      };
    }
    const fields: Readonly<Record<string, Value>> = value;
    const entries = Object.entries(fields).map(
      ([key, item]) =>
        [key, this.#value(item, pointerJoin(pointer, key), entry)] as const
    );
    const literals = literalsOf(entries.map(([, { template }]) => template));
    return {
      code: objectCode(entries.map(([key, { code }]) => [key, code] as const)),
      template:
        literals === undefined
          ? {
              object: entries.map(
                ([key, { template }]) => [key, template] as const
              ),
            }
          : {
              literal: Object.fromEntries(
                entries.map(([key], index) => [key, literals[index] ?? null])
              ),
            },
    };
  }

  /** The descriptor of state key `key`'s declared schema. */
  #descriptorOf(key: string): ValueDescriptor {
    const descriptor = this.#workflow.state.get(key);
    if (descriptor === undefined) {
      throw new Error(`No checked state key ${key}`);
    }
    return descriptor;
  }

  #task(task: Unscoped<SealedTask>): void {
    this.#tasks.push({ ...task, scope: [...this.#loops] });
  }

  /** A step's `if`, if it has one: its condition's code. */
  #guard(step: Placed): string | undefined {
    return step.if === undefined
      ? undefined
      : this.#expression(`${step.pointer}/if`, {
          taskId: step.id,
          stage: "taskIf",
          result: "boolean",
        }).code;
  }

  /**
   * A call: with a result, `const <id> = await <call>;`, or with an `if`,
   * `const <id> = <if> ? await <call> : null;`, a skipped step's result
   * `null`; with none, `await <call>;`, inside `if (<if>) { … }`.
   */
  #emitCall(step: Placed, depth: number, call: string): void {
    const guard = this.#guard(step);
    if (resultStepTypes.has(step.type)) {
      this.#line(
        depth,
        guard === undefined
          ? `const ${step.id} = await ${call};`
          : `const ${step.id} = ${guard} ? await ${call} : null;`
      );
      return;
    }
    if (guard === undefined) {
      this.#line(depth, `await ${call};`);
      return;
    }
    this.#line(depth, `if (${guard}) {`);
    this.#line(depth + 1, `await ${call};`);
    this.#line(depth, "}");
  }

  /** A call step's state: its sealed entries, and each value's code. */
  #state(step: Placed<Extract<Step, { type: "call" | "generate" }>>): {
    sealed: SealedTask["state"];
    code: (readonly [string, string])[];
  } {
    const state = Object.entries(step.state ?? {}).map(
      ([key, value]) =>
        [
          key,
          // A value made from the task's result, as the host's sealed table
          // names one (its stages are for review: the isolate computes it).
          this.#value(value, `${step.pointer}/state/${key}`, {
            taskId: step.id,
            stage: "taskState",
            result: "json",
          }),
        ] as const
    );
    return {
      sealed:
        state.length === 0
          ? undefined
          : Object.fromEntries(
              state.map(([key, { template }]) => [
                key,
                { template, value: z.json().parse(this.#descriptorOf(key)) },
              ])
            ),
      code: state.map(([key, { code }]) => [key, code] as const),
    };
  }

  #call(
    step: Placed<Extract<Step, { type: "call" }>>,
    retrying: Retrying | undefined,
    depth: number
  ): void {
    const args = this.#value(step.args, `${step.pointer}/args`, {
      taskId: step.id,
      stage: "taskDefinition",
      result: "json",
    });
    const state = this.#state(step);
    let call: SealedCall;
    let member: string;
    if ("connection" in step) {
      call = {
        name: "grasp.connector",
        binding: step.connection,
        operation: step.action,
        arguments: args.template,
        ...(step.into === undefined ? {} : { into: step.into }),
        ...(step.from === undefined ? {} : { from: step.from }),
      };
      // The member path as an App's member reads (`memberPathsOf`:
      // `read-attachment` is `readAttachment`), mapped in the declaration
      // to the operation the host gets.
      const path = (
        this.#memberPaths.get(step.connection)?.get(step.action) ?? step.action
      ).split(".");
      const actions =
        this.#connections.get(step.connection) ?? new Map<string, string>();
      actions.set(path.join("."), step.action);
      this.#connections.set(step.connection, actions);
      member = `ctx.connections${memberOf(step.connection)}${path
        .map((segment) => memberOf(segment))
        .join("")}`;
    } else if ("app" in step) {
      const permission = this.#workflow.document.permissions?.apps?.[step.app];
      if (permission === undefined) {
        throw new Error(`No App permission ${step.app}`);
      }
      call = {
        name: "grasp.app",
        binding: step.app,
        app: permission.app,
        function: step.function,
        arguments: args.template,
      };
      const path = permission.functions[step.function] ?? "";
      const functions = this.#apps.get(step.app) ?? new Map<string, string>();
      functions.set(path, step.function);
      this.#apps.set(step.app, functions);
      member = `ctx.apps${memberOf(step.app)}${path
        .split(".")
        .map((segment) => memberOf(segment))
        .join("")}`;
    } else {
      ({ call, member } = this.#resourceCall(step, args.template));
    }
    this.#task({
      id: step.id,
      kind: "call",
      pointer: step.pointer,
      steps: ["task"],
      call,
      ...(step.timeout === undefined
        ? {}
        : { timeoutMs: durationMs(step.timeout) }),
      ...(state.sealed === undefined ? {} : { state: state.sealed }),
    });
    this.#emitCall(
      step,
      depth,
      `${member}(${args.code}, ${callOptions(step, retrying, state.code)})`
    );
  }

  /**
   * A call on the run's files or the Brain, `ctx.files.<alias>.<action>`
   * or `ctx.brain.<alias>.<action>` (`.skills.select`): an action
   * of the format's own fixed list, sealed as its call, and declared.
   */
  #resourceCall(
    step: Exclude<
      Extract<Step, { type: "call" }>,
      { connection: string } | { app: string }
    >,
    args: Template
  ): { call: SealedCall; member: string } {
    const [kind, alias, actions] =
      "files" in step
        ? (["files", step.files, this.#files] as const)
        : (["brain", step.brain, this.#brain] as const);
    const declared = actions.get(alias) ?? new Set<string>();
    declared.add(step.action);
    actions.set(alias, declared);
    return {
      call:
        "files" in step
          ? {
              name: "grasp.files",
              binding: alias,
              operation: step.action,
              arguments: args,
            }
          : {
              name: "grasp.brain",
              binding: alias,
              operation: step.action,
              arguments: args,
            },
      // A Brain action's path, `skills.select`, is a member of a member.
      member: `ctx.${kind}${memberOf(alias)}${step.action
        .split(".")
        .map(memberOf)
        .join("")}`,
    };
  }

  #generate(
    step: Placed<Extract<Step, { type: "generate" }>>,
    retrying: Retrying | undefined,
    depth: number
  ): void {
    const entry: ExpressionEntry = {
      taskId: step.id,
      stage: "taskDefinition",
      result: "json",
    };
    const instructions = this.#value(
      step.instructions,
      `${step.pointer}/instructions`,
      entry
    );
    const input = this.#value(step.input, `${step.pointer}/input`, entry);
    const answer = this.#workflow.answers.get(step.pointer);
    if (answer === undefined) {
      throw new Error(`No checked answer schema at ${step.pointer}`);
    }
    const state = this.#state(step);
    this.#ai = true;
    this.#task({
      id: step.id,
      kind: "call",
      pointer: step.pointer,
      steps: ["task"],
      call: {
        name: "grasp.model",
        binding: aiAlias,
        instructions: instructions.template,
        input: input.template,
        // The descriptor as the JSON it is sealed as.
        outputSchema: z.json().parse(answer),
      },
      ...(step.timeout === undefined
        ? {}
        : { timeoutMs: durationMs(step.timeout) }),
      ...(state.sealed === undefined ? {} : { state: state.sealed }),
    });
    const request = objectCode([
      ["instructions", instructions.code],
      ["input", input.code],
    ]);
    this.#emitCall(
      step,
      depth,
      `ctx.ai.generate(${request}, ${callOptions(step, retrying, state.code)})`
    );
  }

  /**
   * A decision: the SDK records whom it asks, what and on what in its
   * `enter` step, which the host matches against the sealed templates and
   * asks; its `task` step opens it and waits for the answer,
   * `{ timedOut: true }` once its timeout passed. Its timeout is sealed
   * (with none, the host waits until the run's own deadline); the one the
   * code passes is the SDK's, never the host's.
   */
  #decide(
    step: Placed<Extract<Step, { type: "decide" }>>,
    depth: number
  ): void {
    const entry: ExpressionEntry = {
      taskId: step.id,
      stage: "taskDefinition",
      result: "json",
    };
    const recipients = this.#value(
      step.recipients,
      `${step.pointer}/recipients`,
      entry
    );
    const prompt = this.#value(step.prompt, `${step.pointer}/prompt`, entry);
    const input = this.#value(step.input, `${step.pointer}/input`, entry);
    this.#decisions.add(step.decision);
    this.#task({
      id: step.id,
      kind: "call",
      pointer: step.pointer,
      steps: ["enter", "task"],
      call: {
        name: "grasp.decision",
        binding: step.decision,
        recipients: recipients.template,
        prompt: prompt.template,
        input: input.template,
        ...(step.timeout === undefined
          ? {}
          : { timeoutMs: durationMs(step.timeout) }),
      },
    });
    const request = objectCode([
      ["recipients", recipients.code],
      ["prompt", prompt.code],
      ["input", input.code],
      ...(step.timeout === undefined
        ? []
        : [["timeout", literal(step.timeout)] as const]),
    ]);
    this.#emitCall(
      step,
      depth,
      `ctx.decisions${memberOf(step.decision)}.ask(${request}, { step: ${literal(step.id)} })`
    );
  }

  /**
   * An event wait: a task of its own (`listen`) whose task step waits for
   * the first event of its sealed permission and types sent to the run,
   * its timeout sealed beside them. The host decides what it takes and
   * until when from the table alone, and answers `{ timedOut: true }` past
   * its timeout; the request the code passes is for its reader. With a
   * `match`, the SDK records the value it matches in its `enter` step
   * (`{ key }`), which the host holds to the sealed template and matches
   * events by.
   */
  #waitForEvent(step: Placed<WaitForEventStep>, depth: number): void {
    const { events, eventType, match } = step;
    const types = typeof eventType === "string" ? [eventType] : [...eventType];
    const equals =
      match === undefined
        ? undefined
        : this.#value(match.equals, `${step.pointer}/match/equals`, {
            taskId: step.id,
            stage: "taskDefinition",
            result: "json",
          });
    const declared = this.#events.get(events) ?? new Set();
    for (const type of types) {
      declared.add(type);
    }
    this.#events.set(events, declared);
    this.#task({
      id: step.id,
      kind: "listen",
      pointer: step.pointer,
      steps: equals === undefined ? ["task"] : ["enter", "task"],
      listen: {
        binding: events,
        strategy: "any",
        filters: types.map((each) => ({ type: each, attributes: [] })),
        ...(match === undefined || equals === undefined
          ? {}
          : { match: { field: match.field, equals: equals.template } }),
      },
      timeoutMs: durationMs(step.timeout),
    });
    const request = objectCode([
      ["type", literal(eventType)],
      ...(match === undefined || equals === undefined
        ? []
        : [
            [
              "match",
              objectCode([
                ["field", literal(match.field)],
                ["equals", equals.code],
              ]),
            ] as const,
          ]),
      ["timeout", literal(step.timeout)],
    ]);
    this.#emitCall(
      step,
      depth,
      `ctx.events${memberOf(events)}.waitFor(${request}, { step: ${literal(step.id)} })`
    );
  }

  #wait(step: Placed<Extract<Step, { type: "wait" }>>, depth: number): void {
    if ("for" in step) {
      this.#task({
        id: step.id,
        kind: "wait",
        pointer: step.pointer,
        steps: ["task"],
        milliseconds: durationMs(step.for),
      });
      this.#emitCall(
        step,
        depth,
        `ctx.sleep(${literal(step.for)}, { step: ${literal(step.id)} })`
      );
      return;
    }
    const { code, slot } = this.#expression(`${step.pointer}/until`, {
      taskId: step.id,
      stage: "taskDefinition",
      result: "json",
    });
    this.#task({
      id: step.id,
      kind: "call",
      pointer: step.pointer,
      steps: ["enter", "task"],
      call: { name: "grasp.sleepUntil", timestamp: { slot } },
    });
    this.#emitCall(
      step,
      depth,
      `ctx.sleepUntil(${bare(code)}, { step: ${literal(step.id)} })`
    );
  }

  /** `then` inside `if (<if>) { … }` when `step` has an `if`. */
  #guarded(step: Placed, depth: number, then: (depth: number) => void): void {
    const guard = this.#guard(step);
    if (guard === undefined) {
      then(depth);
      return;
    }
    this.#line(depth, `if (${guard}) {`);
    then(depth + 1);
    this.#line(depth, "}");
  }

  /** An `if` step: a task of its own (`switch`), its flow the code's. */
  #if(
    step: Placed<Extract<Step, { type: "if" }>>,
    retrying: Retrying | undefined,
    depth: number
  ): void {
    this.#task({
      id: step.id,
      kind: "switch",
      pointer: step.pointer,
      steps: [],
    });
    this.#guarded(step, depth, (inner) => {
      const { code } = this.#expression(`${step.pointer}/condition`, {
        taskId: step.id,
        stage: "taskIf",
        result: "boolean",
      });
      this.#line(inner, `if (${bare(code)}) {`);
      this.#list(step.then, `${step.pointer}/then`, retrying, inner + 1);
      if (step.else !== undefined) {
        this.#line(inner, "} else {");
        this.#list(step.else, `${step.pointer}/else`, retrying, inner + 1);
      }
      this.#line(inner, "}");
    });
  }

  /**
   * A loop: `for (const item of itemsOf(<items>))`, its items a list of
   * at most the platform's 1,000 (`itemsOf`), each item's steps one at a
   * time; with a `while`, it stops at the first item where that doesn't
   * hold.
   */
  #forEach(
    step: Placed<Extract<Step, { type: "forEach" }>>,
    retrying: Retrying | undefined,
    depth: number
  ): void {
    this.#guarded(step, depth, (inner) => {
      const items = this.#expression(`${step.pointer}/items`, {
        taskId: step.id,
        stage: "taskDefinition",
        result: "json",
      });
      const around = this.#loops;
      this.#loops = [...around, step.id];
      const holds =
        step.while === undefined
          ? undefined
          : this.#expression(`${step.pointer}/while`, {
              taskId: step.id,
              stage: "taskIf",
              result: "boolean",
            });
      this.#loops = around;
      this.#task({
        id: step.id,
        kind: "for",
        pointer: step.pointer,
        steps: [],
        loop: {
          in: { slot: items.slot },
          each: loopItem,
          ...(holds === undefined ? {} : { while: holds.slot }),
        },
      });
      this.#generatedImports.add("itemsOf");
      const list = `itemsOf(${bare(items.code)})`;
      if (around.length === 0) {
        this.#line(inner, `for (const ${loopItem} of ${list}) {`);
      } else {
        // Inside another loop, its items read the outer `item`, which the
        // `for` binding would shadow (and hold uninitialized) as they are
        // evaluated: they are taken first, under a name no step, root or
        // import has (`$$<id>`: a step's ID starts with a letter, and an
        // import such as `$own` has one `$`).
        this.#line(inner, `const $$${step.id} = ${list};`);
        this.#line(inner, `for (const ${loopItem} of $$${step.id}) {`);
      }
      if (holds !== undefined) {
        this.#line(inner + 1, `if (!${holds.code}) break;`);
      }
      this.#loops = [...around, step.id];
      this.#list(step.do, `${step.pointer}/do`, retrying, inner + 1);
      this.#loops = around;
      this.#line(inner, "}");
    });
  }

  /** A try's catch, as sealed: its code, its `when`'s slot, its retry. */
  #sealedCatch(step: Placed<TryStep>): {
    sealed: SealedCatch;
    when: string | undefined;
  } {
    const { code, retry } = step.catch;
    const when =
      step.catch.when === undefined
        ? undefined
        : this.#expression(`${step.pointer}/catch/when`, {
            taskId: step.id,
            stage: "taskDefinition",
            result: "boolean",
            caught: [{ variable: "error", taskId: step.id }],
          });
    return {
      sealed: {
        variable: "error",
        ...(code === undefined ? {} : { code }),
        ...(when === undefined ? {} : { when: when.slot }),
        ...(retry === undefined
          ? {}
          : {
              retry: {
                attempts: retry.attempts,
                delayMs: durationMs(retry.delay),
                backoff: retry.backoff,
              },
            }),
      },
      when: when?.code,
    };
  }

  /**
   * A try: a JavaScript `try`, whose `catch` reads the failure as `error`
   * (`caughtError`: frozen data) and throws it on unless its code and
   * `when` hold. A call in its list that its retry covers passes `retry`
   * (`#callOptions`), which the host holds to the sealed policy.
   */
  #try(
    step: Placed<TryStep>,
    retrying: Retrying | undefined,
    depth: number
  ): void {
    const { sealed, when } = this.#sealedCatch(step);
    this.#task({
      id: step.id,
      kind: "try",
      pointer: step.pointer,
      steps: [],
      catch: sealed,
    });
    // The check allows one retrying try around a step: this one, if it
    // retries, or the one around it. Its `when` is a function written where
    // the try is, so it reads that place's `item`, whatever loop a call in
    // its list stands in.
    const { retry } = step.catch;
    const retryWhen =
      retry?.when === undefined
        ? undefined
        : this.#expression(`${step.pointer}/catch/retry/when`, {
            taskId: step.id,
            stage: "taskDefinition",
            result: "boolean",
            caught: [{ variable: "error", taskId: step.id }],
          }).code;
    // A retry runs only for a failure its catch would take: the catch's
    // `when` with the retry's own, so a failure the catch then throws on
    // is never tried again first. Its code filter is the host's to hold.
    const retryHolds = [
      ...(when === undefined ? [] : [when]),
      ...(retryWhen === undefined ? [] : [retryWhen]),
    ];
    const guard = retriesByGuard(step);
    const takes = takesByGuard(step, retrying !== undefined);
    const conditions = [
      ...(step.catch.code === undefined
        ? []
        : [`error.code === ${literal(step.catch.code)}`]),
      ...(when === undefined ? [] : [when]),
    ];
    let inner = retrying;
    if (retry !== undefined) {
      inner = { retry: guard ? retriesOf(step.id) : "true", unless: [] };
    } else if (retrying !== undefined && takes) {
      inner = { ...retrying, unless: [...retrying.unless, takesOf(step.id)] };
    }
    this.#guarded(step, depth, (at) => {
      if (guard) {
        this.#imports.add("type CaughtError");
        this.#line(
          at,
          `const ${retriesOf(step.id)} = (error: CaughtError) => Boolean(${retryHolds.length === 1 ? bare(retryHolds[0] ?? "") : retryHolds.join(" && ")});`
        );
      }
      if (takes) {
        // Whether this catch takes a failure: its code and its `when`, as
        // its `catch` below decides, read where the try is written.
        this.#imports.add("type CaughtError");
        this.#line(
          at,
          `const ${takesOf(step.id)} = (error: CaughtError) => Boolean(${conditions.join(" && ")});`
        );
      }
      this.#line(at, "try {");
      this.#list(step.try, `${step.pointer}/try`, inner, at + 1);
      // `caughtError` throws on what no catch may take, so even a catch of
      // everything ends the run with it.
      this.#generatedImports.add("caughtError");
      this.#line(at, "} catch (thrown) {");
      if (conditions.length === 0 && step.catch.do === undefined) {
        this.#line(at + 1, "caughtError(thrown);");
        this.#line(at, "}");
        return;
      }
      this.#line(at + 1, "const error = caughtError(thrown);");
      if (conditions.length > 0) {
        this.#line(at + 1, `if (!(${conditions.join(" && ")})) throw thrown;`);
      }
      if (step.catch.do !== undefined) {
        this.#list(step.catch.do, `${step.pointer}/catch/do`, retrying, at + 1);
      }
      this.#line(at, "}");
    });
  }

  #raise(step: Placed<Extract<Step, { type: "raise" }>>, depth: number): void {
    this.#task({
      id: step.id,
      kind: "raise",
      pointer: step.pointer,
      steps: [],
      error: {
        code: step.error.code,
        message: step.error.message,
        ...(step.error.details === undefined
          ? {}
          : { details: z.json().parse(step.error.details) }),
      },
    });
    this.#imports.add("AppError");
    const { code, message, details } = step.error;
    const parts = [code, message, ...(details === undefined ? [] : [details])];
    this.#guarded(step, depth, (at) => {
      this.#line(at, `throw new AppError(${parts.map(literal).join(", ")});`);
    });
  }

  #step(
    step: Step,
    pointer: string,
    retrying: Retrying | undefined,
    depth: number
  ): void {
    const from = this.#lines.length + 1;
    switch (step.type) {
      case "call": {
        this.#call({ ...step, pointer }, retrying, depth);
        break;
      }
      case "generate": {
        this.#generate({ ...step, pointer }, retrying, depth);
        break;
      }
      case "decide": {
        this.#decide({ ...step, pointer }, depth);
        break;
      }
      case "forEach": {
        this.#forEach({ ...step, pointer }, retrying, depth);
        break;
      }
      case "wait": {
        this.#wait({ ...step, pointer }, depth);
        break;
      }
      case "waitForEvent": {
        this.#waitForEvent({ ...step, pointer }, depth);
        break;
      }
      case "if": {
        this.#if({ ...step, pointer }, retrying, depth);
        break;
      }
      case "try": {
        this.#try({ ...step, pointer }, retrying, depth);
        break;
      }
      case "raise": {
        this.#raise({ ...step, pointer }, depth);
        break;
      }
      default: {
        step satisfies never;
      }
    }
    this.#spans.push({
      taskId: step.id,
      pointer,
      from,
      to: this.#lines.length,
    });
  }

  #list(
    steps: readonly Step[],
    pointer: string,
    retrying: Retrying | undefined,
    depth: number
  ): void {
    for (const [index, step] of steps.entries()) {
      this.#step(step, `${pointer}/${index}`, retrying, depth);
    }
  }

  /** The module's `permissions`: what its steps use, as `ctx` names it. */
  #permissionsCode(): string | undefined {
    const listed = (items: Iterable<string>): string =>
      `[${[...items].map(literal).join(", ")}]`;
    const kinds: (readonly [string, string])[] = [];
    if (this.#ai) {
      kinds.push(["ai", "true"]);
    }
    if (this.#connections.size > 0) {
      kinds.push([
        "connections",
        objectCode(
          [...this.#connections].map(([alias, actions]) => [
            alias,
            objectCode(
              [...actions].map(([path, operation]) => [
                path,
                literal(operation),
              ])
            ),
          ])
        ),
      ]);
    }
    if (this.#apps.size > 0) {
      kinds.push([
        "apps",
        objectCode(
          [...this.#apps].map(([alias, functions]) => [
            alias,
            objectCode([...functions].map(([path, id]) => [path, literal(id)])),
          ])
        ),
      ]);
    }
    if (this.#decisions.size > 0) {
      kinds.push(["decisions", listed(this.#decisions)]);
    }
    if (this.#events.size > 0) {
      kinds.push([
        "events",
        objectCode(
          [...this.#events].map(([alias, types]) => [alias, listed(types)])
        ),
      ]);
    }
    for (const [kind, held] of [
      ["files", this.#files],
      ["brain", this.#brain],
    ] as const) {
      if (held.size > 0) {
        kinds.push([
          kind,
          objectCode(
            [...held].map(([alias, actions]) => [alias, listed(actions)])
          ),
        ]);
      }
    }
    return kinds.length === 0 ? undefined : objectCode(kinds);
  }

  generate(): Generation {
    const { document, contract } = this.#workflow;
    const params = Object.entries(document.params ?? {}).flatMap(
      ([name, param]) => {
        const type = contract.params.get(name);
        return isPlain(param) && type !== undefined
          ? [
              [
                name,
                `{ label: ${literal(param.label)}, type: ${validatorSource(type)} }`,
              ] as const,
            ]
          : [];
      }
    );
    this.#list(document.steps, "/steps", undefined, 2);
    if (document.result === undefined) {
      this.#line(2, "return null;");
    } else {
      const { code } = this.#value(document.result, "/result", {
        taskId: null,
        stage: "workflowOutputAs",
        result: "json",
      });
      this.#line(2, `return ${code};`);
    }
    const roots = contextRoots.filter((root) => this.#workflow.roots.has(root));
    const permissions = this.#permissionsCode();
    const state = [...this.#workflow.state.keys()].map(
      (key) => [key, validatorSource(this.#descriptorOf(key))] as const
    );
    // A declaration in `v` may take lines of its own: each counts.
    const prelude = [
      "// Generated from a grasp-workflow/2 document on every save: not edited by hand.",
      `import { ${[...this.#imports, ...this.#generatedImports].toSorted().join(", ")} } from ${literal(generatedImport)};`,
      "",
      "export default defineWorkflow({",
      indented(`args: ${validatorSource(contract.args)},`, 1),
      ...(document.returns === undefined
        ? []
        : [indented(`returns: ${validatorSource(contract.returns)},`, 1)]),
      ...(params.length === 0
        ? []
        : [indented(`params: ${objectCode(params)},`, 1)]),
      ...(state.length === 0
        ? []
        : [indented(`state: ${objectCode(state)},`, 1)]),
      ...(permissions === undefined ? [] : [`  permissions: ${permissions},`]),
      "  handler: async (ctx, args) => {",
      ...(roots.length === 0
        ? []
        : [`    const { ${roots.join(", ")} } = ctx;`]),
    ]
      .join("\n")
      .split("\n");
    const offset = prelude.length;
    return {
      source: [...prelude, ...this.#lines, "  },", "});", ""].join("\n"),
      tasks: this.#tasks,
      expressions: this.#expressions,
      spans: this.#spans.map((span) => ({
        ...span,
        from: span.from + offset,
        to: span.to + offset,
      })),
      workflow: { output: document.returns !== undefined },
      params: params.map(([name]) => name),
    };
  }
}

/**
 * Generates `checked` as a workflow's module and the table it is held to.
 * Deterministic: the same document makes the same module.
 */
export const generateWorkflow = (checked: CheckedWorkflow): Generation =>
  new Generator(checked).generate();
