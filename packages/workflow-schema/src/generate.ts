import type { ValueDescriptor } from "@grasp-os/sdk";
import { runtimeNames } from "@grasp-os/sdk/expression-check";
import { sealedBuildLimits } from "@grasp-os/shared/sealed-builds";
import { z } from "zod";

import type { CheckedWorkflow } from "./check.ts";
import { pointerJoin } from "./data-schema.ts";
import {
  durationMs,
  inboxRoot,
  isPlain,
  isValueList,
  localContractPattern,
} from "./format.ts";
import type {
  Binding,
  EventWaitStep,
  Json,
  PlainParam,
  Step,
  TryStep,
  Value,
} from "./format.ts";
import type {
  SealedCall,
  SealedCatch,
  SealedExpression,
  SealedTable,
  SealedTask,
  Template,
} from "./sealed.ts";

// The generator: a checked grasp-workflow/1 document (check.ts) translated
// straight into TypeScript on `@grasp-os/sdk/workflow`, one SDK call per
// step, and into the sealed table the run host holds that code to (core's
// workflows/sealed-run.ts): each task's steps, the call its step makes with
// the template its arguments must match, its catch, its raise, its wait.
// The code is what runs, is sealed and is exported; the table is what the
// host trusts.
//
// The code runs the steps in the document's order on the run host's
// shapes: a step's own engine step is `<id>:<kind>` (kind `task`, `enter`
// or `catch`); a call is `env[<binding>].call(<operation>, <arguments>)`
// inside its task's step; a deadline wait records its deadline in its
// `enter` step and sleeps `until` it; a raise is a task step the host
// fails unless it records `{ skipped: true }`; an event wait is its task
// step's `step.listen`, the host deciding what it takes; a try's catch asks
// `step.caught` and throws the failure on when its catch doesn't take it;
// a step in a try whose catch retries offers `retry`, which names the
// catch that takes a failure and whether it retries. Every expression is
// evaluated inside a recorded step (`#decided`), never between steps: a
// step's `if` in its first step, which records `{ skipped: true }` where
// it doesn't hold; an `if` step's condition in its own task step; the
// output in `workflow:output`. A call step that keeps state records
// `{ output, state }` in its task step, its state's values evaluated
// there from its result, which the host writes once that step succeeded;
// every expression reads the run's snapshot of it, `state` of the run's
// context, frozen.
//
// Threat model, and how each is closed:
//
// - Text of the document becoming code. No string, key or ID of the
//   document is spliced into the module as written: every one becomes a
//   literal through `JSON.stringify` (quotes, backslashes, line
//   separators, `${`, backticks and `*\/` included), every key a computed
//   property, so not even `__proto__` is anything but a key. The only
//   comment is a fixed header. Expressions come as code printed from
//   their checked syntax tree (`@grasp-os/sdk/expression-check`), never
//   as their source, reading and calling only through its guards.
// - IDs becoming names. Step IDs are only ever literals: the code's own
//   variables come from a counter (`thrown3`, `caught3`, `until3`), and a
//   step's result is kept as `steps[<literal>]` on an object with no
//   prototype.
// - Code that loops or reaches past the SDK. The only loop statement is a
//   `forEach`'s `for … of` over the items its enter step recorded, which
//   the host bounds: at most 1,000 an enter, each item's steps one at a
//   time, and every one counted against the run's step ceiling, which is
//   what ends a long loop (`workflow.too_many_steps`). The module imports
//   `@grasp-os/sdk/workflow` and nothing else (the compiler refuses any
//   other import of generated code all the same).
// - A sensitive value reaching the run's code. A sensitive parameter is
//   only ever `sensitiveParam(<name>)` in a connector call's arguments,
//   sealed there as a `param` the host fills in; the code declares only
//   the parameters that aren't sensitive.
// - The host trusting what the code says. Everything the host decides on
//   is in the sealed table, built here from the same document, never read
//   from the code: which steps exist, which call each makes through which
//   binding, every literal of its arguments, each catch's filter, each
//   raise's error, each wait's length, each event wait's binding, types
//   and timeout, and the keys each task keeps in state with the template
//   of each value: a record keeping any other key, or another value, is
//   the host's to refuse.

/** The SDK the generated module imports, and nothing else. */
export const generatedImport = "@grasp-os/sdk/workflow";

/** The generator, as a build names what made it. */
export const generatorVersion = "grasp-workflow-ts/1";

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
  /** Whether it has an output, evaluated in `workflow:output`. */
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

const localPattern = new RegExp(localContractPattern, "u");

/**
 * A try around a step, with where it is (its catch's expressions are by
 * it), and the names of the functions its code decides its catch's `when`
 * and its retry's `when` by, if it has them.
 */
type PlacedTry = TryStep & {
  readonly pointer: string;
  readonly catches?: string;
  readonly retries?: string;
};

/** A try's retry decision for a failure: whether its retry holds. */
const retriesOf = (around: PlacedTry): string => {
  if (around.catch.retry === undefined) {
    return "false";
  }
  return around.retries === undefined ? "true" : `${around.retries}(error)`;
};

/**
 * The step options' `retry`, deciding by the tries around a step. Each
 * try's conditions are its own functions, made where the try is written
 * (`#try`), never their code pasted here: a loop's step inside the try
 * has an `item` of its own, which the try's conditions don't mean.
 */
const retryOf = (
  tries: readonly PlacedTry[],
  depth: number
): string | undefined => {
  if (!tries.some((around) => around.catch.retry !== undefined)) {
    return undefined;
  }
  const lines = ["async (error) => {"];
  for (const around of tries) {
    const { errors } = around.catch;
    const conditions = [
      ...(errors?.type === undefined
        ? []
        : [`error.type === ${literal(errors.type)}`]),
      ...(errors?.status === undefined
        ? []
        : [`error.status === ${literal(errors.status)}`]),
      ...(around.catches === undefined ? [] : [`${around.catches}(error)`]),
    ];
    lines.push(
      `${"  ".repeat(depth + 1)}if (${conditions.length === 0 ? "true" : conditions.join(" && ")}) return { by: ${literal(around.id)}, retry: ${retriesOf(around)} };`
    );
  }
  lines.push(`${"  ".repeat(depth + 1)}return null;`, `${"  ".repeat(depth)}}`);
  return lines.join("\n");
};

/** A step, with where it is. */
type Placed<S extends Step = Step> = S & { readonly pointer: string };

/** An expression's entry in the review table, but for what generating it adds. */
type ExpressionEntry = Omit<
  SealedExpression,
  "slot" | "pointer" | "source" | "loopVariables"
>;

/** The SDK's constructor for a parameter of `kind`. */
const paramCall = (param: PlainParam): string => {
  const options = [
    `label: ${literal(param.label)}`,
    `default: ${literal(param.default)}`,
    ...(param.currency === undefined
      ? []
      : [`currency: ${literal(param.currency)}`]),
  ];
  return `${param.kind}({ ${options.join(", ")} })`;
};

/** The engine steps of a task, by the key its step names it with. */
type StepKey = "task" | "enter" | "item" | "leave" | "catch";

/** What a loop's items' code reads its item and its index by. */
const loopItem = "item";
const loopIndex = "index";

/** A `forEach` around the code being generated: its task, its index's name. */
interface Loop {
  readonly id: string;
  readonly index: string;
}

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

/** What a call step names: its sealed call, and the operation its code calls. */
const callOf = (
  step: Extract<Step, { type: "do" }>,
  binding: Binding,
  args: Template
): { call: SealedCall; operation: string } => {
  if (binding.kind === "connector") {
    const operation = step.operation ?? "";
    return {
      call: {
        name: "grasp.connector",
        binding: step.binding,
        operation,
        arguments: args,
      },
      operation,
    };
  }
  // A checked `do` step binds a connector, a compute or an action alone.
  const parts = localPattern.exec(binding.contract);
  const name = binding.kind === "compute" ? "grasp.compute" : "grasp.action";
  return {
    call: {
      name,
      binding: step.binding,
      module: parts?.[1] ?? "",
      export: parts?.[2] ?? "",
      arguments: args,
    },
    operation: name,
  };
};

class Generator {
  readonly #workflow: CheckedWorkflow;
  readonly #lines: string[] = [];
  readonly #tasks: SealedTask[] = [];
  readonly #expressions: SealedExpression[] = [];
  readonly #spans: TaskSpan[] = [];
  // The workflow SDK, and the guards expressions read and call through.
  readonly #imports = new Set([
    "workflow",
    "z",
    `readMember as ${runtimeNames.read}`,
    `callMethod as ${runtimeNames.call}`,
    `optionalChain as ${runtimeNames.optional}`,
    `jsonValue as ${runtimeNames.json}`,
  ]);
  #counter = 0;
  /** The `forEach` loops around the code being generated, outermost first. */
  #loops: readonly Loop[] = [];

  constructor(workflow: CheckedWorkflow) {
    this.#workflow = workflow;
  }

  #line(depth: number, text: string): void {
    this.#lines.push(`${"  ".repeat(depth)}${text}`);
  }

  #next(): number {
    this.#counter += 1;
    return this.#counter;
  }

  /**
   * The code of an engine step's key: `key` itself at the top level, and
   * inside loop items `key@i1/i2/…`, one index per loop around it,
   * outermost first, as the run host names an item's steps. The indexes
   * are the code's own counters, never text of the document.
   */
  #key(key: StepKey): string {
    if (this.#loops.length === 0) {
      return literal(key);
    }
    return [
      literal(`${key}@`),
      this.#loops.map(({ index }) => index).join(' + "/" + '),
    ].join(" + ");
  }

  /**
   * A step's options: its engine step's key, its description, and `extra`.
   * The description is the step's ID, its stable key, never its title: a
   * title is a label, renamed freely, so renaming a step changes nothing
   * that runs or is sealed. What shows a run reads the titles from the
   * document by ID.
   */
  #options(step: Step, key: StepKey, extra: readonly string[] = []): string {
    return `{ ${[
      `key: ${this.#key(key)}`,
      `description: ${literal(step.id)}`,
      ...extra,
    ].join(", ")} }`;
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
      // A value is JSON, but an expression reads a missing field as
      // `undefined`, on its own or in a list or object it writes. The
      // SDK's `jsonValue` makes any of them JSON, as `JSON.stringify` does.
      return { code: `${runtimeNames.json}(${code})`, template: { slot } };
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
      code: `{ ${entries.map(([key, { code }]) => `[${literal(key)}]: ${code}`).join(", ")} }`,
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

  #binding(alias: string): Binding {
    const binding = this.#workflow.document.bindings?.[alias];
    if (binding === undefined) {
      throw new Error(`No binding ${alias}`);
    }
    return binding;
  }

  #task(task: Unscoped<SealedTask>): void {
    this.#tasks.push({ ...task, scope: this.#loops.map(({ id }) => id) });
  }

  /**
   * Step `key` of `step`, deciding it: it records `record` where the
   * step's `if` holds, and `{ skipped: true }` where it doesn't (its
   * output null). `then` emits what runs past it, at its depth, reading
   * the record by the name it is given.
   *
   * Every expression of the workflow is evaluated so, inside a recorded
   * step, never in the code between steps: its `if`, its values, an `if`
   * step's condition, the workflow's output. An expression that throws
   * (a field of `null` read, say) fails that step, a failure the host
   * records and a catch around it takes, as any task's. Thrown between
   * steps, it would reach the host as no step's: a catch of it would be
   * a catch with no failure to take, which in a loop's item that ran no
   * step yet even starts the item, and the host refuses either.
   */
  #decided(
    step: Placed,
    depth: number,
    key: StepKey,
    record: string,
    then: (depth: number, recorded: string) => void,
    extra: readonly string[] = []
  ): void {
    const recorded = `decided${this.#next()}`;
    const guard =
      step.if === undefined
        ? undefined
        : this.#expression(`${step.pointer}/if`, {
            taskId: step.id,
            stage: "taskIf",
            result: "boolean",
          }).code;
    const records =
      guard === undefined ? record : `${guard} ? ${record} : { skipped: true }`;
    this.#line(
      depth,
      `const ${recorded} = await step.do(${literal(step.id)}, ${this.#options(step, key, extra)}, async () => (${records}));`
    );
    if (guard === undefined) {
      then(depth, recorded);
      return;
    }
    this.#line(depth, `if ("skipped" in ${recorded}) {`);
    this.#line(
      depth + 1,
      `steps[${literal(step.id)}] = { output: null, skipped: true };`
    );
    this.#line(depth, "} else {");
    then(depth + 1, recorded);
    this.#line(depth, "}");
  }

  /** A call step: its task, and its code making the call in its step. */
  #emitCall(
    step: Placed<Extract<Step, { type: "do" | "agent" }>>,
    tries: readonly PlacedTry[],
    depth: number,
    sealed: { call: SealedCall; operation: string; arguments: string }
  ): void {
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
    this.#task({
      id: step.id,
      kind: "call",
      pointer: step.pointer,
      steps: ["task"],
      call: sealed.call,
      ...(step.timeout === undefined
        ? {}
        : { timeoutMs: durationMs(step.timeout) }),
      ...(state.length === 0
        ? {}
        : {
            state: Object.fromEntries(
              state.map(([key, { template }]) => [
                key,
                { template, value: z.json().parse(this.#descriptorOf(key)) },
              ])
            ),
          }),
    });
    const called = `z.json().parse(await env[${literal(step.binding)}].call(${literal(sealed.operation)}, ${sealed.arguments}))`;
    // Its state is evaluated from its result, `output`, in the step that
    // records both, so the host writes exactly what that step recorded.
    // Each value is held first to its key's declared schema, by the SDK's
    // own validator (`fittedValue`), as the check and the host hold it:
    // one of another shape fails the step, unchanged, which then records,
    // and so keeps, nothing.
    if (state.length > 0) {
      this.#imports.add("fittedValue");
    }
    const kept = state.map(
      ([key, { code }]) =>
        `[${literal(key)}]: fittedValue(${literal(JSON.stringify(this.#descriptorOf(key)))}, ${code})`
    );
    const record =
      state.length === 0
        ? `{ output: ${called} }`
        : `((output) => ({ output, state: { ${kept.join(", ")} } }))(${called})`;
    // Its `if` is decided in its task step, with its call: skipped, the
    // step makes none and keeps nothing.
    const retry = retryOf(tries, depth);
    this.#decided(
      step,
      depth,
      "task",
      record,
      (inner, recorded) => {
        this.#line(
          inner,
          `steps[${literal(step.id)}] = { output: ${recorded}.output };`
        );
      },
      retry === undefined ? [] : [`retry: ${retry}`]
    );
  }

  #do(
    step: Placed<Extract<Step, { type: "do" }>>,
    tries: readonly PlacedTry[],
    depth: number
  ): void {
    const args = this.#value(step.arguments, `${step.pointer}/arguments`, {
      taskId: step.id,
      stage: "taskDefinition",
      result: "json",
    });
    const { call, operation } = callOf(
      step,
      this.#binding(step.binding),
      args.template
    );
    this.#emitCall(step, tries, depth, {
      call,
      operation,
      arguments: args.code,
    });
  }

  #agent(
    step: Placed<Extract<Step, { type: "agent" }>>,
    tries: readonly PlacedTry[],
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
    const outputSchema = this.#workflow.answers.get(step.pointer);
    if (outputSchema === undefined) {
      throw new Error(`No checked answer schema at ${step.pointer}`);
    }
    this.#emitCall(step, tries, depth, {
      call: {
        name: "grasp.model",
        binding: step.binding,
        instructions: instructions.template,
        input: input.template,
        // The descriptor as the JSON it is sealed as.
        outputSchema: z.json().parse(outputSchema),
      },
      operation: "grasp.model",
      arguments: `{ ["instructions"]: ${instructions.code}, ["input"]: ${input.code} }`,
    });
  }

  /**
   * A decision: its enter step records whom it asks, what and on what, as
   * its `if` holds (`{ skipped: true }` otherwise, as a raise's); the host
   * matches that record against the sealed templates and asks the
   * recorded prompt. The recipients are recorded as deciders
   * (`person:<id>`, `team:<id>`, `role:<role>`), parsed so, as the host
   * takes nothing else: a bare user ID fails the enter step, where it is
   * written. Its task step then asks from the first recipient, exactly
   * the recorded one, and waits for the answer: `{ timedOut: true }` once
   * its timeout passes. Its description is the step's ID, as every
   * step's: the host reads neither it nor the timeout passed here (the
   * SDK requires one; the host's is the sealed one). Telling people is
   * the host's alone.
   */
  #decision(
    step: Placed<Extract<Step, { type: "decision" }>>,
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
    // With no timeout, none is sealed: the host waits until the run's own
    // deadline, as long as the run can wait (`timeoutOf`).
    const timeoutMs =
      step.timeout === undefined ? undefined : durationMs(step.timeout);
    this.#task({
      id: step.id,
      kind: "call",
      pointer: step.pointer,
      steps: ["enter", "task"],
      call: {
        name: "grasp.decision",
        binding: step.binding,
        recipients: recipients.template,
        prompt: prompt.template,
        input: input.template,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
    });
    this.#imports.add("paramValueSchemas");
    // The host holds the record to what a decision takes, as it records
    // it (`#decisionEntered`): how many recipients, the prompt's length,
    // not blank. Each fails this enter step, as the call's own failure.
    // The recipients are parsed as `person` values here only so `from`
    // takes the first of them as it is.
    const record = [
      `["recipients"]: z.array(paramValueSchemas.person).parse(${recipients.code})`,
      `["prompt"]: z.json().parse(${prompt.code})`,
      `["input"]: z.json().parse(${input.code})`,
    ];
    this.#decided(
      step,
      depth,
      "enter",
      `{ ${record.join(", ")} }`,
      (inner, entered) => {
        this.#line(
          inner,
          `steps[${literal(step.id)}] = { output: await step.decision(${literal(step.id)}, ${this.#options(step, "task", [`from: ${entered}.recipients[0]`, `timeout: ${literal(timeoutMs ?? sealedBuildLimits.deadlineMs)}`])}) };`
        );
      }
    );
  }

  /**
   * A loop: its enter step records its items (`{ skipped: true }` when its
   * `if` doesn't hold), and its items run over that record, one at a
   * time, in order, each item's steps keyed by its index. With a `while`,
   * each item starts with its item step, which records whether it holds,
   * and the loop stops where it doesn't.
   */
  #forEach(
    step: Placed<Extract<Step, { type: "forEach" }>>,
    tries: readonly PlacedTry[],
    depth: number
  ): void {
    const items = this.#expression(`${step.pointer}/items`, {
      taskId: step.id,
      stage: "taskDefinition",
      result: "json",
    });
    const number = this.#next();
    const index = `index${number}`;
    const around = this.#loops;
    const inside = [...around, { id: step.id, index }];
    // `while` reads the item, so its slot is recorded among its items'.
    this.#loops = inside;
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
      steps: holds === undefined ? ["enter"] : ["enter", "item"],
      loop: {
        in: { slot: items.slot },
        each: loopItem,
        at: loopIndex,
        ...(holds === undefined ? {} : { while: holds.slot }),
      },
    });
    this.#decided(
      step,
      depth,
      "enter",
      // JSON as the record is: a missing field in the list is `null`.
      `{ items: ${runtimeNames.json}(${items.code}) }`,
      (inner, entered) => {
        this.#loops = inside;
        // Over the recorded items, never a fresh evaluation: the host
        // holds the items to what the enter step recorded, and fails a
        // record that isn't a list of at most 1,000
        // (`workflow.collection_invalid`), so this parse only types them:
        // each item as every value an expression reads (the SDK's `Read`),
        // which the typed check types where it is written, so an item read
        // bare (`100 * item`) compiles as it was checked.
        this.#line(
          inner,
          `for (const [${index}, item${number}] of z.array(z.any()).parse(${entered}.items).entries()) {`
        );
        this.#line(inner + 1, `const ${loopItem} = item${number};`);
        if (holds !== undefined) {
          this.#line(
            inner + 1,
            `const holds${number} = await step.do(${literal(step.id)}, ${this.#options(step, "item")}, async () => ({ while: Boolean(${holds.code}) }));`
          );
          this.#line(inner + 1, `if (!holds${number}.while) break;`);
        }
        this.#list(step.do, `${step.pointer}/do`, tries, inner + 1);
        this.#line(inner, "}");
        this.#loops = around;
        this.#line(inner, `steps[${literal(step.id)}] = { output: null };`);
      }
    );
  }

  /**
   * An event wait: a task of its own (`listen`) whose task step waits for
   * the first event of its sealed binding and types sent to the run, its
   * timeout sealed beside them. The host decides what it takes and until
   * when from the table alone (`step.listen` passes neither), and answers
   * `{ timedOut: true }` past its timeout. Any failure of the wait fails
   * the run, whatever `try` is around it (`EventWaitStep`). Its `if`, if
   * any, is decided in an enter step before it, as a sleep's; with a
   * `match`, that enter step records the value it matches (`{ key }`),
   * which the host holds to the sealed template and matches events by.
   */
  #listen(step: Placed<EventWaitStep>, depth: number): void {
    const { from, type, match } = step.event;
    const types = typeof type === "string" ? [type] : type;
    const equals =
      match === undefined
        ? undefined
        : this.#value(match.equals, `${step.pointer}/event/match/equals`, {
            taskId: step.id,
            stage: "taskDefinition",
            result: "json",
          });
    this.#task({
      id: step.id,
      kind: "listen",
      pointer: step.pointer,
      steps:
        step.if === undefined && equals === undefined
          ? ["task"]
          : ["enter", "task"],
      listen: {
        binding: from,
        strategy: "any",
        filters: types.map((each) => ({ type: each, attributes: [] })),
        ...(match === undefined || equals === undefined
          ? {}
          : { match: { field: match.field, equals: equals.template } }),
      },
      timeoutMs: durationMs(step.timeout),
    });
    const listen = (inner: number): void => {
      this.#line(
        inner,
        `steps[${literal(step.id)}] = { output: await step.listen(${literal(step.id)}, ${this.#options(step, "task")}) };`
      );
    };
    if (equals !== undefined) {
      this.#decided(
        step,
        depth,
        "enter",
        `{ ["key"]: z.json().parse(${equals.code}) }`,
        listen
      );
      return;
    }
    if (step.if === undefined) {
      listen(depth);
      return;
    }
    this.#decided(step, depth, "enter", "{ output: null }", listen);
  }

  #wait(
    step: Placed<Extract<Step, { type: "wait" }>>,
    tries: readonly PlacedTry[],
    depth: number
  ): void {
    const done = `steps[${literal(step.id)}] = { output: null };`;
    if ("event" in step) {
      this.#listen(step, depth);
      return;
    }
    if ("for" in step) {
      const milliseconds = durationMs(step.for);
      const sleep = (inner: number): void => {
        this.#line(
          inner,
          `await step.sleep(${literal(step.id)}, ${this.#options(step, "task", [`duration: ${literal(milliseconds)}`])});`
        );
        this.#line(inner, done);
      };
      // A sleep records nothing: its `if`, if any, is decided in an enter
      // step before it.
      this.#task({
        id: step.id,
        kind: "wait",
        pointer: step.pointer,
        steps: step.if === undefined ? ["task"] : ["enter", "task"],
        milliseconds,
      });
      if (step.if === undefined) {
        sleep(depth);
        return;
      }
      this.#decided(step, depth, "enter", "{ output: null }", sleep);
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
    // Its deadline may fail to evaluate in its enter step, as a call may
    // fail: a retry around it decides it as any call's.
    const retry = retryOf(tries, depth);
    this.#decided(
      step,
      depth,
      "enter",
      `{ output: null, until: ${code} }`,
      (inner, entered) => {
        this.#line(
          inner,
          `await step.sleepUntil(${literal(step.id)}, ${this.#options(step, "task", [`until: z.number().parse(${entered}.until)`])});`
        );
        this.#line(inner, done);
      },
      retry === undefined ? [] : [`retry: ${retry}`]
    );
  }

  /**
   * An `if` step: a task of its own (`switch`), whose task step decides
   * its condition, and its `if`, recorded.
   */
  #if(
    step: Placed<Extract<Step, { type: "if" }>>,
    tries: readonly PlacedTry[],
    depth: number
  ): void {
    const { code } = this.#expression(`${step.pointer}/condition`, {
      taskId: step.id,
      stage: "taskIf",
      result: "boolean",
    });
    this.#task({
      id: step.id,
      kind: "switch",
      pointer: step.pointer,
      steps: ["task"],
    });
    this.#decided(
      step,
      depth,
      "task",
      `{ then: Boolean(${code}) }`,
      (inner, decided) => {
        this.#line(inner, `if (${decided}.then) {`);
        this.#list(step.then, `${step.pointer}/then`, tries, inner + 1);
        if (step.else !== undefined) {
          this.#line(inner, "} else {");
          this.#list(step.else, `${step.pointer}/else`, tries, inner + 1);
        }
        this.#line(inner, "}");
        this.#line(inner, `steps[${literal(step.id)}] = { output: null };`);
      }
    );
  }

  /**
   * A try's catch, as sealed: its filter and the slots of its conditions,
   * and the code of each condition.
   */
  #sealedCatch(step: PlacedTry): {
    sealed: SealedCatch;
    when: string | undefined;
    retryWhen: string | undefined;
  } {
    const entry: ExpressionEntry = {
      taskId: step.id,
      stage: "taskDefinition",
      result: "boolean",
      caught: [{ variable: "error", taskId: step.id }],
    };
    const { errors, retry } = step.catch;
    const when =
      step.catch.when === undefined
        ? undefined
        : this.#expression(`${step.pointer}/catch/when`, entry);
    const retryWhen =
      retry?.when === undefined
        ? undefined
        : this.#expression(`${step.pointer}/catch/retry/when`, entry);
    return {
      sealed: {
        variable: "error",
        ...(errors === undefined ? {} : { errors: { ...errors } }),
        ...(when === undefined ? {} : { when: when.slot }),
        ...(retry === undefined
          ? {}
          : {
              retry: {
                attempts: retry.attempts,
                delayMs: durationMs(retry.delay),
                backoff: retry.backoff,
                ...(retryWhen === undefined ? {} : { when: retryWhen.slot }),
              },
            }),
      },
      when: when?.code,
      retryWhen: retryWhen?.code,
    };
  }

  #try(step: PlacedTry, tries: readonly PlacedTry[], depth: number): void {
    const { sealed, when, retryWhen } = this.#sealedCatch(step);
    this.#task({
      id: step.id,
      kind: "try",
      pointer: step.pointer,
      // Its `if`, if any, is decided in an enter step before its list.
      steps: step.if === undefined ? ["catch"] : ["enter", "catch"],
      catch: sealed,
    });
    const number = this.#next();
    // Its conditions as functions made here, where the try is written, so
    // they read its own `item` wherever a step inside it fails. Each is a
    // boolean, as the host reads the choice; only a step's callback calls
    // them, so nothing is evaluated between steps.
    const placed: PlacedTry = {
      ...step,
      ...(when === undefined ? {} : { catches: `catches${number}` }),
      ...(retryWhen === undefined ? {} : { retries: `retries${number}` }),
    };
    if (when !== undefined || retryWhen !== undefined) {
      this.#imports.add("type CaughtError");
    }
    const body = (inner: number): void => {
      if (placed.catches !== undefined) {
        this.#line(
          inner,
          `const ${placed.catches} = (error: CaughtError) => Boolean(${when});`
        );
      }
      if (placed.retries !== undefined) {
        this.#line(
          inner,
          `const ${placed.retries} = (error: CaughtError) => Boolean(${retryWhen});`
        );
      }
      this.#line(inner, "try {");
      this.#list(
        step.try,
        `${step.pointer}/try`,
        [placed, ...tries],
        inner + 1
      );
      this.#line(inner, `} catch (thrown${number}) {`);
      this.#line(
        inner + 1,
        `const caught${number} = await step.caught(${literal(step.id)}, ${this.#options(step, "catch")}, async (error) => ${placed.catches === undefined ? "true" : `${placed.catches}(error)`});`
      );
      this.#line(
        inner + 1,
        `if (caught${number} === undefined) throw thrown${number};`
      );
      if (step.catch.do !== undefined) {
        this.#line(inner + 1, "{");
        this.#line(inner + 2, `const error = caught${number};`);
        this.#list(step.catch.do, `${step.pointer}/catch/do`, tries, inner + 2);
        this.#line(inner + 1, "}");
      }
      this.#line(inner, "}");
      this.#line(inner, `steps[${literal(step.id)}] = { output: null };`);
    };
    if (step.if === undefined) {
      body(depth);
      return;
    }
    this.#decided(step, depth, "enter", "{ output: null }", body);
  }

  #raise(step: Placed<Extract<Step, { type: "raise" }>>, depth: number): void {
    this.#task({
      id: step.id,
      kind: "raise",
      pointer: step.pointer,
      steps: ["task"],
      error: { ...step.error },
    });
    // The host fails its step unless its record says its `if` skipped it.
    this.#decided(step, depth, "task", "{ output: null }", (inner) => {
      this.#line(inner, `steps[${literal(step.id)}] = { output: null };`);
    });
  }

  #step(
    step: Step,
    pointer: string,
    tries: readonly PlacedTry[],
    depth: number
  ): void {
    const from = this.#lines.length + 1;
    switch (step.type) {
      case "do": {
        this.#do({ ...step, pointer }, tries, depth);
        break;
      }
      case "agent": {
        this.#agent({ ...step, pointer }, tries, depth);
        break;
      }
      case "decision": {
        this.#decision({ ...step, pointer }, depth);
        break;
      }
      case "forEach": {
        this.#forEach({ ...step, pointer }, tries, depth);
        break;
      }
      case "wait": {
        this.#wait({ ...step, pointer }, tries, depth);
        break;
      }
      case "if": {
        this.#if({ ...step, pointer }, tries, depth);
        return;
      }
      case "try": {
        this.#try({ ...step, pointer }, tries, depth);
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
    tries: readonly PlacedTry[],
    depth: number
  ): void {
    for (const [index, step] of steps.entries()) {
      this.#step(step, `${pointer}/${index}`, tries, depth);
    }
  }

  generate(id: string): Generation {
    const { document } = this.#workflow;
    const params = Object.entries(document.params ?? {}).flatMap(
      ([name, param]) => (isPlain(param) ? [[name, param] as const] : [])
    );
    for (const [, param] of params) {
      this.#imports.add(param.kind);
    }
    this.#line(1, "const run = { id: runId };");
    this.#line(1, "const steps = Object.create(null);");
    // The snapshot is untrusted input: every version of the workflow
    // writes the same state, so a value an older one kept may not fit this
    // one's schema. What this build reads is only its declared keys whose
    // values fit (`fittedState`), each other one undefined.
    this.#imports.add("fittedState");
    const declared = [...this.#workflow.state.keys()].map(
      (key) =>
        `[${literal(key)}]: ${literal(JSON.stringify(this.#descriptorOf(key)))}`
    );
    this.#line(
      1,
      `const state = fittedState(snapshot, { ${declared.join(", ")} });`
    );
    this.#list(document.steps, "/steps", [], 1);
    if (document.output === undefined) {
      this.#line(1, "return null;");
    } else {
      // Its output too is evaluated in a step: the workflow's own
      // `workflow:output`.
      const { code } = this.#value(document.output.value, "/output/value", {
        taskId: null,
        stage: "workflowOutputAs",
        result: "json",
      });
      this.#line(
        1,
        `const ended = await step.do("workflow", { key: "output", description: "workflow" }, async () => ({ output: z.json().parse(${code}) }));`
      );
      this.#line(1, "return ended.output;");
    }
    const prelude = [
      "// Generated from a grasp-workflow/1 document on every save: not edited by hand.",
      `import { ${[...this.#imports].toSorted().join(", ")} } from ${literal(generatedImport)};`,
      "",
      `export default workflow(${literal(id)}, {`,
      `  params: { ${params.map(([name, param]) => `[${literal(name)}]: ${paramCall(param)}`).join(", ")} },`,
      "  input: z.json(),",
      `}, async (step, { input, params, env, runId, ${inboxRoot}, state: snapshot }) => {`,
    ];
    const offset = prelude.length;
    return {
      source: [...prelude, ...this.#lines, "});", ""].join("\n"),
      tasks: this.#tasks,
      expressions: this.#expressions,
      spans: this.#spans.map((span) => ({
        ...span,
        from: span.from + offset,
        to: span.to + offset,
      })),
      workflow: { output: document.output !== undefined },
      params: params.map(([name]) => name),
    };
  }
}

/**
 * Generates `checked` as workflow `id`'s module and the table it is held
 * to. Deterministic: the same document makes the same module.
 */
export const generateWorkflow = (
  checked: CheckedWorkflow,
  id: string
): Generation => new Generator(checked).generate(id);
