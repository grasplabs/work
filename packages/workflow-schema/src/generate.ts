import type { ValueDescriptor } from "@grasp-os/sdk";
import { runtimeNames } from "@grasp-os/sdk/expression-check";

import type { CheckedWorkflow } from "./check.ts";
import {
  durationUnits,
  isPlain,
  isValueList,
  localContractPattern,
} from "./format.ts";
import type {
  Binding,
  Duration,
  DurationUnit,
  ErrorFilter,
  Json,
  PlainParam,
  Step,
  TryStep,
  Value,
} from "./format.ts";

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
// fails unless it records `{ skipped: true }`; a try's catch asks
// `step.caught` and throws the failure on when its catch doesn't take it;
// a step in a try whose catch retries offers `retry`, which names the
// catch that takes a failure and whether it retries.
//
// Threat model (as the generator before it, @grasp-os/open-workflow's
// generate.ts), and how each is closed:
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
// - Code that loops or reaches past the SDK. The module has no loop
//   statement, and imports `@grasp-os/sdk/workflow` and nothing else (the
//   compiler refuses any other import of generated code all the same).
// - A sensitive value reaching the run's code. A sensitive parameter is
//   only ever `sensitiveParam(<name>)` in a connector call's arguments,
//   sealed there as a `param` the host fills in; the code declares only
//   the parameters that aren't sensitive.
// - The host trusting what the code says. Everything the host decides on
//   is in the sealed table, built here from the same document, never read
//   from the code: which steps exist, which call each makes through which
//   binding, every literal of its arguments, each catch's filter, each
//   raise's error, each wait's length.

/** The SDK the generated module imports, and nothing else. */
export const generatedImport = "@grasp-os/sdk/workflow";

/** The generator, as a build names what made it. */
export const generatorVersion = "grasp-workflow-ts/1";

/** A value the host builds or checks a call by (core's `SealedTemplate`). */
export type Template =
  | { readonly literal: Json }
  | { readonly slot: number }
  | { readonly param: string }
  | { readonly object: readonly (readonly [string, Template])[] }
  | { readonly array: readonly Template[] };

/** A task's call, as the host checks and makes it (core's `SealedCall`). */
export type SealedCall =
  | {
      readonly name: "grasp.connector";
      readonly binding: string;
      readonly operation: string;
      readonly arguments: Template;
    }
  | {
      readonly name: "grasp.operation";
      readonly binding: string;
      readonly arguments: Template;
    }
  | {
      readonly name: "grasp.compute" | "grasp.action";
      readonly binding: string;
      readonly module: string;
      readonly export: string;
      readonly arguments: Template;
    }
  | {
      readonly name: "grasp.model";
      readonly binding: string;
      readonly instructions: Template;
      readonly input: Template;
      readonly outputSchema: ValueDescriptor;
    }
  | { readonly name: "grasp.sleepUntil"; readonly timestamp: Template };

/** A try task's catch, as the host decides it (core's sealed catch). */
export interface SealedCatch {
  readonly variable: string;
  readonly errors?: ErrorFilter;
  readonly when?: number;
  readonly retry?: {
    readonly attempts: number;
    readonly delayMs: number;
    readonly backoff: "constant" | "linear" | "exponential";
    readonly when?: number;
  };
}

/** One task of the module, as the host checks its steps (core's `SealedTask`). */
export interface SealedTask {
  readonly id: string;
  readonly kind: "call" | "wait" | "try" | "raise";
  readonly pointer: string;
  /** Its engine steps, `<id>:<step>`: a wait sleeps in its `task` step. */
  readonly steps: readonly ("task" | "enter" | "catch")[];
  /** The loops and forks around it: none in this version of the format. */
  readonly scope: readonly string[];
  readonly branches: readonly (number | null)[];
  readonly schemas: Readonly<Record<string, never>>;
  readonly call?: SealedCall;
  readonly milliseconds?: number;
  readonly catch?: SealedCatch;
  readonly error?: {
    readonly type: string;
    readonly status: number;
    readonly title?: string;
    readonly detail?: string;
  };
  readonly timeoutMs?: number;
}

/** An expression of the module, for review: where it is, what it says. */
export interface SealedExpression {
  readonly slot: number;
  readonly pointer: string;
  readonly taskId: string | null;
  readonly stage: "taskIf" | "taskDefinition" | "workflowOutputAs";
  readonly result: "boolean" | "json";
  readonly source: string;
  readonly loopVariables: readonly string[];
  readonly caught?: readonly {
    readonly variable: string;
    readonly taskId: string;
  }[];
}

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
  /** The workflow's own input and output steps: none, its code has them. */
  readonly workflow: { readonly input: false; readonly output: false };
  /** The parameters its code reads: those that aren't sensitive. */
  readonly params: readonly string[];
  readonly limits: Readonly<Record<string, never>>;
}

const literal = (value: unknown): string => JSON.stringify(value);

/** A try around a step, with where it is (its catch's expressions are by it). */
type PlacedTry = TryStep & { readonly pointer: string };

/** A step, with where it is. */
type Placed<S extends Step = Step> = S & { readonly pointer: string };

/** An expression's entry in the review table, but for what generating it adds. */
type ExpressionEntry = Omit<
  SealedExpression,
  "slot" | "pointer" | "source" | "loopVariables"
>;

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

const localPattern = new RegExp(localContractPattern, "u");

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

/**
 * A step's options: its engine step's key, its description, and `extra`.
 * The description is the step's ID, its stable key, never its title: a
 * title is a label, renamed freely, so renaming a step changes nothing
 * that runs or is sealed. What shows a run reads the titles from the
 * document by ID.
 */
const optionsOf = (
  step: Step,
  key: "task" | "enter" | "catch",
  extra: readonly string[] = []
): string =>
  `{ ${[
    `key: ${literal(key)}`,
    `description: ${literal(step.id)}`,
    ...extra,
  ].join(", ")} }`;

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

/** A token of a JSON Pointer (RFC 6901). */
const token = (part: string): string =>
  part.replaceAll("~", "~0").replaceAll("/", "~1");

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
  if (binding.kind === "compute" || binding.kind === "action") {
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
  }
  return {
    call: { name: "grasp.operation", binding: step.binding, arguments: args },
    operation: "grasp.operation",
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
      loopVariables: [],
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
        this.#value(item, `${pointer}/${index}`, entry)
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
        [key, this.#value(item, `${pointer}/${token(key)}`, entry)] as const
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

  #binding(alias: string): Binding {
    const binding = this.#workflow.document.bindings?.[alias];
    if (binding === undefined) {
      throw new Error(`No binding ${alias}`);
    }
    return binding;
  }

  /** A try's retry decision for a failure: whether its retry holds. */
  #retries(around: PlacedTry): string {
    const { retry } = around.catch;
    if (retry === undefined) {
      return "false";
    }
    if (retry.when === undefined) {
      return "true";
    }
    return (
      this.#workflow.code.get(`${around.pointer}/catch/retry/when`) ?? "false"
    );
  }

  /** The step options' `retry`, deciding by the tries around a step. */
  #retryOf(tries: readonly PlacedTry[], depth: number): string | undefined {
    if (!tries.some((around) => around.catch.retry !== undefined)) {
      return undefined;
    }
    const lines = ["async (error) => {"];
    for (const around of tries) {
      const { errors, when } = around.catch;
      const conditions = [
        ...(errors?.type === undefined
          ? []
          : [`error.type === ${literal(errors.type)}`]),
        ...(errors?.status === undefined
          ? []
          : [`error.status === ${literal(errors.status)}`]),
        ...(when === undefined
          ? []
          : [
              this.#workflow.code.get(`${around.pointer}/catch/when`) ??
                "false",
            ]),
      ];
      lines.push(
        `${"  ".repeat(depth + 1)}if (${conditions.length === 0 ? "true" : conditions.join(" && ")}) return { by: ${literal(around.id)}, retry: ${this.#retries(around)} };`
      );
    }
    lines.push(
      `${"  ".repeat(depth + 1)}return null;`,
      `${"  ".repeat(depth)}}`
    );
    return lines.join("\n");
  }

  #task(task: Omit<SealedTask, "scope" | "branches" | "schemas">): void {
    this.#tasks.push({ ...task, scope: [], branches: [], schemas: {} });
  }

  /** Wraps `emit` in the step's `if`; skipped, its output is null. */
  #guarded(step: Placed, depth: number, emit: (depth: number) => void): void {
    if (step.if === undefined) {
      emit(depth);
      return;
    }
    const { code } = this.#expression(`${step.pointer}/if`, {
      taskId: step.id,
      stage: "taskIf",
      result: "boolean",
    });
    this.#line(depth, `if (${code}) {`);
    emit(depth + 1);
    this.#line(depth, "} else {");
    this.#line(
      depth + 1,
      `steps[${literal(step.id)}] = { output: null, skipped: true };`
    );
    this.#line(depth, "}");
  }

  /** A call step: its task, and its code making the call in its step. */
  #emitCall(
    step: Placed<Extract<Step, { type: "do" | "agent" }>>,
    tries: readonly PlacedTry[],
    depth: number,
    sealed: { call: SealedCall; operation: string; arguments: string }
  ): void {
    this.#task({
      id: step.id,
      kind: "call",
      pointer: step.pointer,
      steps: ["task"],
      call: sealed.call,
      ...(step.timeout === undefined
        ? {}
        : { timeoutMs: durationMs(step.timeout) }),
    });
    this.#guarded(step, depth, (inner) => {
      const retry = this.#retryOf(tries, inner);
      this.#line(
        inner,
        `steps[${literal(step.id)}] = await step.do(${literal(step.id)}, ${optionsOf(step, "task", retry === undefined ? [] : [`retry: ${retry}`])}, async () => ({ output: z.json().parse(await env[${literal(step.binding)}].call(${literal(sealed.operation)}, ${sealed.arguments})) }));`
      );
    });
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
        outputSchema,
      },
      operation: "grasp.model",
      arguments: `{ ["instructions"]: ${instructions.code}, ["input"]: ${input.code} }`,
    });
  }

  #wait(step: Placed<Extract<Step, { type: "wait" }>>, depth: number): void {
    const done = `steps[${literal(step.id)}] = { output: null };`;
    if ("for" in step) {
      const milliseconds = durationMs(step.for);
      this.#task({
        id: step.id,
        kind: "wait",
        pointer: step.pointer,
        steps: ["task"],
        milliseconds,
      });
      this.#guarded(step, depth, (inner) => {
        this.#line(
          inner,
          `await step.sleep(${literal(step.id)}, ${optionsOf(step, "task", [`duration: ${literal(milliseconds)}`])});`
        );
        this.#line(inner, done);
      });
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
    const until = `until${this.#next()}`;
    this.#guarded(step, depth, (inner) => {
      this.#line(
        inner,
        `const ${until} = await step.do(${literal(step.id)}, ${optionsOf(step, "enter")}, async () => ({ output: null, until: ${code} }));`
      );
      this.#line(
        inner,
        `await step.sleepUntil(${literal(step.id)}, ${optionsOf(step, "task", [`until: z.number().parse(${until}.until)`])});`
      );
      this.#line(inner, done);
    });
  }

  #if(
    step: Placed<Extract<Step, { type: "if" }>>,
    tries: readonly PlacedTry[],
    depth: number
  ): void {
    const { code } = this.#expression(`${step.pointer}/condition`, {
      taskId: null,
      stage: "taskIf",
      result: "boolean",
    });
    this.#guarded(step, depth, (inner) => {
      this.#line(inner, `if (${code}) {`);
      this.#list(step.then, `${step.pointer}/then`, tries, inner + 1);
      if (step.else !== undefined) {
        this.#line(inner, "} else {");
        this.#list(step.else, `${step.pointer}/else`, tries, inner + 1);
      }
      this.#line(inner, "}");
      this.#line(inner, `steps[${literal(step.id)}] = { output: null };`);
    });
  }

  /** A try's catch, as sealed: its filter and the slots of its conditions. */
  #sealedCatch(step: PlacedTry): {
    sealed: SealedCatch;
    when: string | undefined;
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
    };
  }

  #try(step: PlacedTry, tries: readonly PlacedTry[], depth: number): void {
    const { sealed, when } = this.#sealedCatch(step);
    this.#task({
      id: step.id,
      kind: "try",
      pointer: step.pointer,
      steps: ["catch"],
      catch: sealed,
    });
    const number = this.#next();
    this.#guarded(step, depth, (inner) => {
      this.#line(inner, "try {");
      this.#list(step.try, `${step.pointer}/try`, [step, ...tries], inner + 1);
      this.#line(inner, `} catch (thrown${number}) {`);
      this.#line(
        inner + 1,
        `const caught${number} = await step.caught(${literal(step.id)}, ${optionsOf(step, "catch")}, async (error) => ${when === undefined ? "true" : `Boolean(${when})`});`
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
    });
  }

  #raise(step: Placed<Extract<Step, { type: "raise" }>>, depth: number): void {
    this.#task({
      id: step.id,
      kind: "raise",
      pointer: step.pointer,
      steps: ["task"],
      error: { ...step.error },
    });
    // Its `if` decides whether it is skipped, as its record says: the host
    // fails its step unless it says so.
    const runs =
      step.if === undefined
        ? "true"
        : this.#expression(`${step.pointer}/if`, {
            taskId: step.id,
            stage: "taskIf",
            result: "boolean",
          }).code;
    this.#line(
      depth,
      `await step.do(${literal(step.id)}, ${optionsOf(step, "task")}, async () => (${runs} ? { output: null } : { skipped: true }));`
    );
    this.#line(depth, `steps[${literal(step.id)}] = { output: null };`);
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
      case "wait": {
        this.#wait({ ...step, pointer }, depth);
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
    this.#list(document.steps, "/steps", [], 1);
    const output =
      document.output === undefined
        ? "null"
        : this.#value(document.output.value, "/output/value", {
            taskId: null,
            stage: "workflowOutputAs",
            result: "json",
          }).code;
    this.#line(1, `return ${output};`);
    const prelude = [
      "// Generated from a grasp-workflow/1 document on every save: not edited by hand.",
      `import { ${[...this.#imports].toSorted().join(", ")} } from ${literal(generatedImport)};`,
      "",
      `export default workflow(${literal(id)}, {`,
      `  params: { ${params.map(([name, param]) => `[${literal(name)}]: ${paramCall(param)}`).join(", ")} },`,
      "  input: z.json(),",
      "}, async (step, { input, params, env, runId }) => {",
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
      workflow: { input: false, output: false },
      params: params.map(([name]) => name),
      limits: {},
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
