import { canonicalJson } from "@grasp-os/shared/json";
import type { Json } from "@grasp-os/shared/json";
import type { StandardSchemaV1 } from "@standard-schema/spec";

import { writeJson, writeJsonArray } from "./bounded-json.ts";
import { expressionError, expressionErrors } from "./errors.ts";
import type { ExpressionSite } from "./errors.ts";
import { runJq } from "./jq.ts";
import { checkSource } from "./source.ts";

/**
 * Where in a workflow's data flow an expression runs. Each stage sees the
 * variables Open Workflow 1.0 gives it (dsl.md, "Runtime expression
 * arguments"), less `$secrets` and `$authorization`, which the profile
 * doesn't have, plus Grasp's `$params` everywhere and a loop's variables
 * inside its tasks.
 */
export const stageVariables = {
  workflowInputFrom: ["workflow", "runtime", "params"],
  taskIf: ["context", "task", "workflow", "runtime", "params"],
  taskInputFrom: ["context", "task", "workflow", "runtime", "params"],
  taskDefinition: ["context", "input", "task", "workflow", "runtime", "params"],
  taskOutputAs: ["context", "input", "task", "workflow", "runtime", "params"],
  taskExportAs: [
    "context",
    "input",
    "output",
    "task",
    "workflow",
    "runtime",
    "params",
  ],
  workflowOutputAs: ["context", "workflow", "runtime", "params"],
} as const satisfies Record<string, readonly string[]>;

export type Stage = keyof typeof stageVariables;
type StageVariable<S extends Stage> = (typeof stageVariables)[S][number];

/** Stages inside a task, where a loop's variables are in scope. */
const taskStages = new Set<Stage>([
  "taskIf",
  "taskInputFrom",
  "taskDefinition",
  "taskOutputAs",
  "taskExportAs",
]);

/** The pinned descriptor every expression sees as `$runtime`. */
export const runtimeDescriptor = {
  name: "Grasp",
  version: "grasp-open-workflow/1",
} as const;

/** The limits on one evaluation. */
export const evaluatorLimits = {
  /**
   * CPU and wall time of one evaluation. Fuel (jq.ts) enforces both
   * deterministically, everywhere; an isolate running the evaluator gives
   * `cpuMs` to the platform as a backstop.
   */
  cpuMs: 100,
  wallMs: 1000,
  /** The input and every variable together, as JSON. */
  maxContextBytes: 1024 * 1024,
  maxResultBytes: 1024 * 1024,
  /** Of JSON values, in and out. */
  maxJsonDepth: 32,
  /** Of the task an expression belongs to, counting from the workflow. */
  maxTaskScopes: 16,
} as const;

// Loop variable names: jq identifiers, never one of a stage's own names.
const variableName = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const reservedNames = new Set<string>([
  ...Object.values(stageVariables).flat(),
  "secrets",
  "authorization",
  "ENV",
  "ARGS",
]);

/** An expression that passed the profile, ready to evaluate. */
export interface CompiledExpression<S extends Stage = Stage> {
  readonly source: string;
  readonly stage: S;
  readonly loopVariables: readonly string[];
  readonly site: ExpressionSite;
}

export interface CompileOptions<S extends Stage = Stage> {
  stage: S;
  /** Task IDs from the workflow's top-level list down to this task. */
  scope: readonly string[];
  /** Where the expression is, for errors. */
  pointer: string;
  /** Variables of the loops around this task (`for.each`/`for.at`). */
  loopVariables?: readonly string[];
}

// jq's exit codes: 3 for a compile error, 5 for a runtime one.
const jqCompileError = 3;

const fail = (
  site: ExpressionSite,
  code: Parameters<typeof expressionError>[0],
  remedy: string,
  more: { expected?: string; reason?: string } = {}
): never => {
  throw expressionError(code, site, { remedy, ...more });
};

/**
 * Runs `read` over caller data (objects the caller built: options, scopes,
 * contracts). Anything it throws that isn't an expression error, such as a
 * getter or proxy that throws, fails as `code` at `site`, and what it threw
 * is never passed on.
 */
const readCallerData = <T>(
  site: ExpressionSite,
  code: Parameters<typeof expressionError>[0],
  remedy: string,
  read: () => T
): T => {
  try {
    return read();
  } catch (error) {
    if (expressionErrors.codeOf(error) !== undefined) {
      throw error;
    }
    return fail(site, code, remedy);
  }
};

/** The expressions compileExpression made: evaluation trusts no other. */
const compiledExpressions = new WeakSet<object>();

const isStage = (value: unknown): value is Stage =>
  typeof value === "string" && Object.hasOwn(stageVariables, value);

/** The compile options, copied into plain data; throws on anything else. */
const readOptions = <S extends Stage>(
  options: CompileOptions<S>
): {
  stage: S;
  scope: string[];
  pointer: string;
  loopVariables: unknown[];
} => {
  const { stage, pointer } = options;
  const scope: unknown[] = [...options.scope];
  const loopVariables: unknown[] = [...(options.loopVariables ?? [])];
  if (
    !isStage(stage) ||
    typeof pointer !== "string" ||
    !scope.every((taskId) => typeof taskId === "string")
  ) {
    throw new TypeError("Compile options aren't plain data");
  }
  return {
    stage,
    scope: scope.filter((taskId) => typeof taskId === "string"),
    pointer,
    loopVariables,
  };
};

// jq's compile errors name the source position and the construct, never
// a value; the position is that of the generated program, so drop it.
const compileMessage = (stderr: string): string => {
  const first = stderr.split("\n")[0] ?? "";
  return first
    .replace(/^jq: error: /u, "")
    .replace(/ at <top-level>, line \d+, column \d+:?$/u, "")
    .replace(/ at <top-level>, line \d+:?$/u, "")
    .slice(0, 200);
};

/**
 * The jq program for an expression: binds the stage's variables from the
 * JSON array jq reads (`[input, ...variables]`), then runs the source,
 * parenthesised, on the input. The source passed the profile check, so its
 * brackets balance and the parentheses hold exactly it; the bindings are
 * generated from fixed names, never from data.
 */
const programFor = (source: string, names: readonly string[]): string => {
  const bindings = names.map((name, index) => `.[${index + 1}] as $${name} | `);
  return `${bindings.join("")}.[0] | (\n${source}\n)`;
};

const variableNamesOf = (expression: CompiledExpression): string[] => [
  ...stageVariables[expression.stage],
  ...expression.loopVariables,
];

/**
 * Checks `source` against the profile and compiles it with jq, as at
 * publication: the stage's variables, nothing else, are in scope. Refuses
 * with an expression error; never runs the expression on real data.
 */
export const compileExpression = async <S extends Stage>(
  source: string,
  options: CompileOptions<S>
): Promise<CompiledExpression<S>> => {
  const read = readCallerData(
    { pointer: "" },
    "expression.invalid",
    "Pass the compile options as plain data.",
    () => readOptions(options)
  );
  const site: ExpressionSite = { pointer: read.pointer };
  const taskId = read.scope.at(-1);
  if (taskId !== undefined) {
    site.taskId = taskId;
  }
  if (read.scope.length > evaluatorLimits.maxTaskScopes) {
    fail(
      site,
      "expression.scope_too_deep",
      "Move the task up, or split the workflow."
    );
  }
  const { loopVariables } = read;
  if (loopVariables.length > 0 && !taskStages.has(read.stage)) {
    fail(
      site,
      "expression.unavailable_variable",
      "Loop variables exist only in the loop's tasks."
    );
  }
  for (const name of loopVariables) {
    const valid =
      typeof name === "string" &&
      variableName.test(name) &&
      !reservedNames.has(name) &&
      !name.startsWith("__");
    if (!valid) {
      fail(
        site,
        "expression.unavailable_variable",
        "Name the loop variable as a plain identifier that isn't a workflow variable.",
        {
          reason:
            typeof name === "string"
              ? `loop variable ${name.slice(0, 64)}`
              : "a loop variable that isn't text",
        }
      );
    }
  }
  const checked = checkSource(source);
  if (!checked.ok) {
    const remedy =
      checked.problem.code === "unsupported"
        ? "Use only the profile's grammar and builtins."
        : "Shorten or simplify the expression.";
    fail(site, `expression.${checked.problem.code}`, remedy, {
      reason: checked.problem.reason,
    });
  }
  if (typeof source !== "string") {
    fail(site, "expression.invalid", "Pass the expression as text.");
  }
  const expression: CompiledExpression<S> = Object.freeze({
    source,
    stage: read.stage,
    loopVariables: Object.freeze(
      loopVariables.filter((name) => typeof name === "string")
    ),
    site: Object.freeze(site),
  });
  const available = new Set(variableNamesOf(expression));
  if (checked.ok) {
    for (const name of checked.source.freeVariables) {
      if (!available.has(name)) {
        fail(
          site,
          "expression.unavailable_variable",
          `Use only the variables of this stage: ${[...available].map((variable) => `$${variable}`).join(", ")}.`,
          { reason: `$${name}` }
        );
      }
    }
  }
  // jq compiles it against nulls; only a compile error matters here.
  const names = variableNamesOf(expression);
  const run = await runJq(
    programFor(source, names),
    JSON.stringify(Array.from({ length: names.length + 1 }, () => null))
  );
  if (run.kind === "completed" && run.exitCode === jqCompileError) {
    fail(site, "expression.invalid", "Fix the expression's jq syntax.", {
      reason: compileMessage(run.stderr),
    });
  }
  compiledExpressions.add(expression);
  return expression;
};

/** What the values an expression runs on are: its input and variables. */
export interface EvaluationScope<S extends Stage = Stage> {
  /** `.`: what the stage evaluates on. */
  input: Json;
  /** The stage's variables, except `$runtime`, which is pinned. */
  variables: Record<Exclude<StageVariable<S>, "runtime">, Json>;
  /** The loop variables the expression was compiled with. */
  loop?: Record<string, Json>;
}

/**
 * The type the result must have where the expression sits. A condition is
 * a boolean, a duration a safe positive integer of milliseconds, and a
 * selector exactly what its schema accepts, as is. No truthiness, no
 * coercion, no defaults.
 */
export type ResultContract =
  | { kind: "boolean" }
  | { kind: "duration" }
  | { kind: "json" }
  | { kind: "schema"; schema: StandardSchemaV1; expected: string };

const contractNames = {
  boolean: "boolean",
  duration: "positive safe integer (milliseconds)",
  json: "one JSON value",
} as const;

const contractKinds = new Set(["boolean", "duration", "json", "schema"]);

/** The contract, copied into plain data; throws on anything else. */
const readContract = (
  contract: ResultContract
): {
  kind: ResultContract["kind"];
  name: string;
  validate: (value: unknown) => unknown;
} => {
  const { kind } = contract;
  if (!contractKinds.has(kind)) {
    throw new TypeError("Not a result contract");
  }
  if (kind !== "schema") {
    return {
      kind,
      name: contractNames[kind],
      validate: () => ({ issues: [] }),
    };
  }
  const { expected, schema } = contract;
  const standard: unknown = schema["~standard"];
  const validate: unknown =
    typeof standard === "object" && standard !== null
      ? Reflect.get(standard, "validate")
      : undefined;
  if (typeof expected !== "string" || typeof validate !== "function") {
    throw new TypeError("Not a Standard Schema contract");
  }
  return {
    kind,
    name: expected.slice(0, 200),
    validate: (value) => {
      const answer: unknown = Reflect.apply(validate, standard, [value]);
      return answer;
    },
  };
};

/** A schema's answer, if it accepted the value: its value, else nothing. */
const acceptedValue = (validated: unknown): { value: unknown } | undefined => {
  if (typeof validated !== "object" || validated === null) {
    return undefined;
  }
  const issues: unknown = Reflect.get(validated, "issues");
  if (issues !== undefined) {
    return undefined;
  }
  const value: unknown = Reflect.get(validated, "value");
  return { value };
};

const isPlainObject = (value: object): boolean => {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Whether `value` is plain JSON the evaluator accepts: finite numbers,
 * well-formed strings, dense arrays and plain objects at most
 * `maxJsonDepth` deep, no `__proto__` key.
 * `safeIntegers` also refuses integers beyond 2^53, as jq prints them for
 * overflowing or non-finite numbers.
 */
const isAcceptedJson = (
  value: unknown,
  depth: number,
  safeIntegers: boolean
): value is Json => {
  if (value === null || typeof value === "boolean") {
    return true;
  }
  // jq refuses lone surrogates; they aren't text.
  if (typeof value === "string") {
    return value.isWellFormed();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return false;
    }
    return (
      !safeIntegers || !Number.isInteger(value) || Number.isSafeInteger(value)
    );
  }
  if (typeof value !== "object" || depth >= evaluatorLimits.maxJsonDepth) {
    return false;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (
        !(index in value) ||
        !isAcceptedJson(value[index], depth + 1, safeIntegers)
      ) {
        return false;
      }
    }
    return true;
  }
  if (!isPlainObject(value) || Object.hasOwn(value, "__proto__")) {
    return false;
  }
  for (const [key, member] of Object.entries(value)) {
    // A member set to undefined is left out, as JSON.stringify does.
    const accepted =
      member === undefined || isAcceptedJson(member, depth + 1, safeIntegers);
    if (!key.isWellFormed() || !accepted) {
      return false;
    }
  }
  return true;
};

const utf8Bytes = (text: string): number =>
  new TextEncoder().encode(text).length;

/** How deep JSON text nests, without parsing it. */
const jsonTextDepth = (text: string): number => {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") {
        index += 1;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth += 1;
      deepest = Math.max(deepest, depth);
    } else if (char === "]" || char === "}") {
      depth -= 1;
    }
  }
  return deepest;
};

const checkContract = async (
  expression: CompiledExpression,
  result: Json,
  contract: ResultContract
): Promise<Json> => {
  const read = readCallerData(
    expression.site,
    "expression.type_mismatch",
    "Pass a boolean, duration, json or Standard Schema contract.",
    () => readContract(contract)
  );
  const mismatch = (): never =>
    fail(
      expression.site,
      "expression.type_mismatch",
      "Make the expression return exactly the required type.",
      { expected: read.name }
    );
  if (read.kind === "boolean") {
    return typeof result === "boolean" ? result : mismatch();
  }
  if (read.kind === "duration") {
    const isDuration =
      typeof result === "number" && Number.isSafeInteger(result) && result > 0;
    return isDuration ? result : mismatch();
  }
  if (read.kind === "json") {
    return result;
  }
  // Exactly the contract: a schema that would transform, coerce or fill in
  // the value doesn't make a different value acceptable. The schema is
  // caller code: it gets a copy, its answer is compared with the text taken
  // before it ran (so changing the copy in place doesn't pass), and what is
  // returned is parsed from that text, never an object the schema held.
  const snapshot = canonicalJson(result);
  let same: boolean;
  try {
    const accepted = acceptedValue(await read.validate(JSON.parse(snapshot)));
    // The schema's answer is caller data: written with the same bounds,
    // and no bigger than the snapshot it must equal.
    const answer =
      accepted === undefined
        ? undefined
        : writeJson(accepted.value, {
            maxBytes: utf8Bytes(snapshot),
            maxDepth: evaluatorLimits.maxJsonDepth,
            maxNodes: evaluatorLimits.maxResultBytes,
            sortKeys: true,
            safeIntegers: true,
          });
    same = answer?.ok === true && answer.text === snapshot;
  } catch {
    // A schema that throws accepts nothing; its message isn't passed on.
    same = false;
  }
  const accepted: unknown = JSON.parse(snapshot);
  return same && isAcceptedJson(accepted, 0, true) ? accepted : mismatch();
};

/**
 * The JSON text jq reads: `[input, ...variables]`, in the order the
 * program binds them, once it is plain JSON within the limits. It reads
 * the caller's scope throughout, so it only ever runs inside
 * readCallerData.
 */
const contextText = <S extends Stage>(
  expression: CompiledExpression<S>,
  scope: EvaluationScope<S>
): string => {
  const { site } = expression;
  const stageNames = new Set<string>(stageVariables[expression.stage]);
  const loopNames = new Set(expression.loopVariables);
  // Each group only its own names: a loop value can't stand in for
  // $context or $params, nor a stage variable for a loop's.
  const extra = [
    ...Object.keys(scope.variables).filter((name) => !stageNames.has(name)),
    ...Object.keys(scope.loop ?? {}).filter((name) => !loopNames.has(name)),
  ];
  if (extra.length > 0) {
    fail(
      site,
      "expression.context_invalid",
      "Provide only the stage's variables and the loop variables it was compiled with.",
      { reason: `$${(extra[0] ?? "").slice(0, 64)} isn't available here` }
    );
  }
  const provided: Record<string, Json> = { ...scope.variables, ...scope.loop };
  const values: Json[] = [scope.input];
  for (const name of variableNamesOf(expression)) {
    if (name === "runtime") {
      values.push(runtimeDescriptor);
      continue;
    }
    if (!Object.hasOwn(provided, name)) {
      fail(
        site,
        "expression.context_invalid",
        "Provide every variable of the stage.",
        { reason: `$${name} missing` }
      );
    }
    values.push(provided[name] ?? null);
  }
  const invalidContext = (): never =>
    fail(
      site,
      "expression.context_invalid",
      "Pass plain JSON at most 32 levels deep, with finite numbers and no __proto__ keys."
    );
  // One bounded pass writes the text jq gets and checks it is plain JSON:
  // shared references (`[v, v]` nested) can't make it visit more than the
  // budget, and a getter is read once, so what is checked is what is sent.
  const written = writeJsonArray(values, {
    maxBytes: evaluatorLimits.maxContextBytes,
    maxDepth: evaluatorLimits.maxJsonDepth,
    maxNodes: evaluatorLimits.maxContextBytes,
    sortKeys: false,
    safeIntegers: false,
  });
  if (!written.ok) {
    if (written.refusal === "too_large") {
      fail(
        site,
        "expression.context_too_large",
        "Keep the input and variables under 1 MiB together."
      );
    }
    invalidContext();
  }
  const stdin = written.ok ? written.text : "";
  // The text is at most 1 MiB, so checking it again is bounded too.
  if (jsonTextDepth(stdin) > evaluatorLimits.maxJsonDepth + 1) {
    invalidContext();
  }
  const sent: unknown = JSON.parse(stdin);
  if (
    !Array.isArray(sent) ||
    !sent.every((value: unknown) => isAcceptedJson(value, 0, false))
  ) {
    invalidContext();
  }
  return stdin;
};

/**
 * Evaluates a compiled expression on `scope` and checks its one result
 * against `contract`. Fails with an expression error, which never carries
 * the values: when the context is over its limits or not plain JSON, when
 * jq fails or runs out of fuel or memory, when there isn't exactly one
 * result, or when the result is over its limits or breaks the contract.
 */
export const evaluateExpression = async <S extends Stage>(
  expression: CompiledExpression<S>,
  scope: EvaluationScope<S>,
  contract: ResultContract
): Promise<Json> => {
  if (!compiledExpressions.has(expression)) {
    throw expressionError(
      "expression.invalid",
      { pointer: "" },
      { remedy: "Evaluate only what compileExpression returned." }
    );
  }
  const { site } = expression;
  const stdin = readCallerData(
    site,
    "expression.context_invalid",
    "Pass plain JSON values, without getters or proxies.",
    () => contextText(expression, scope)
  );

  const run = await runJq(
    programFor(expression.source, variableNamesOf(expression)),
    stdin
  );
  if (run.kind === "exhausted") {
    return fail(
      site,
      "expression.resource_exhausted",
      "Do less work in one expression, or move it to a compute module.",
      { reason: run.resource }
    );
  }
  if (run.kind === "crashed") {
    return fail(
      site,
      "expression.failed",
      "Check the expression against the data it runs on."
    );
  }
  if (run.exitCode === jqCompileError) {
    return fail(site, "expression.invalid", "Fix the expression's jq syntax.", {
      reason: compileMessage(run.stderr),
    });
  }
  // jq's runtime error messages quote values, so none is passed on.
  if (run.exitCode !== 0) {
    return fail(
      site,
      "expression.failed",
      "Check the expression against the data it runs on."
    );
  }
  const lines = run.stdout === "" ? [] : run.stdout.split("\n");
  const [line] = lines;
  if (lines.length !== 1 || line === undefined) {
    return fail(
      site,
      "expression.result_count",
      "Make the expression produce exactly one value.",
      { reason: `${lines.length} results` }
    );
  }
  if (utf8Bytes(line) > evaluatorLimits.maxResultBytes) {
    return fail(site, "expression.result_too_large", "Return less than 1 MiB.");
  }
  if (jsonTextDepth(line) > evaluatorLimits.maxJsonDepth) {
    return fail(
      site,
      "expression.result_invalid",
      "Return JSON at most 32 levels deep."
    );
  }
  const result: unknown = JSON.parse(line);
  if (!isAcceptedJson(result, 0, true)) {
    return fail(
      site,
      "expression.result_invalid",
      "Return finite, safe numbers and no __proto__ keys."
    );
  }
  return await checkContract(expression, result, contract);
};
