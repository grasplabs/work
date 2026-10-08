import { v } from "@grasp-os/sdk";
import type { Json } from "@grasp-os/shared/json";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vite-plus/test";

import { expressionErrors } from "../src/errors.ts";
import { compileExpression, evaluateExpression } from "../src/evaluate.ts";
import type { ResultContract } from "../src/evaluate.ts";
import { evaluatorLimits } from "../src/limits.ts";
import { builtinAllowlist } from "../src/source.ts";
import { compileError, json, run } from "./run.ts";

const nested = (depth: number, leaf: Json = 0): Json => {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = [value];
  }
  return value;
};

/** A call of `name` with `arity` arguments that the profile accepts. */
const callOf = (name: string, arity: number): string => {
  if (arity === 0) {
    return name;
  }
  const argument =
    name === "strptime" || name === "strftime" ? '"%Y-%m-%d"' : ".";
  return `${name}(${Array.from({ length: arity }, () => argument).join("; ")})`;
};

const quoted = (bytes: number): string => `"${"x".repeat(bytes - 2)}"`;
const nestedArrays = (depth: number): string =>
  `${"[".repeat(depth)}1${"]".repeat(depth)}`;
const nestedIfs = (depth: number): string =>
  `${"if true then ".repeat(depth)}1${" else 0 end".repeat(depth)}`;
const scopeOf = (depth: number): string[] =>
  Array.from({ length: depth }, (_, index) => `task-${index}`);

/** How evaluating `source` on null ends: the resource it ran out of. */
const exhaust = async (
  source: string
): Promise<{ code: string | undefined; reason: unknown }> => {
  const expression = await compileExpression(source, {
    stage: "taskDefinition",
    scope: ["runaway"],
    pointer: "/do/0/runaway/set",
  });
  const failure: unknown = await evaluateExpression(
    expression,
    {
      input: null,
      variables: {
        context: null,
        input: null,
        task: null,
        workflow: null,
        params: null,
      },
    },
    json
  ).then(
    () => {},
    (error: unknown) => error
  );
  const details =
    typeof failure === "object" && failure !== null && "details" in failure
      ? failure.details
      : undefined;
  const reason =
    typeof details === "object" && details !== null && "reason" in details
      ? details.reason
      : undefined;
  return { code: expressionErrors.codeOf(failure), reason };
};

/** Whether `value` is an object whose status is pending. */
const isPending = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "status") === "pending";

describe("the builtin allowlist", () => {
  it.each(
    Object.entries(builtinAllowlist).flatMap(([name, arities]) =>
      arities.map((arity) => ({ name, arity }))
    )
  )("allows $name/$arity", async ({ name, arity }) => {
    await expect(compileError(callOf(name, arity))).resolves.toBeUndefined();
  });

  it("refuses every other builtin, including jq's own I/O, time and errors", async () => {
    const refused = [
      "input",
      "inputs",
      "env",
      "now",
      "debug",
      'debug("x")',
      "stderr",
      "input_filename",
      "input_line_number",
      "$__prog_args",
      "get_search_list",
      "halt",
      'halt_error("x")',
      'error("x")',
      "empty",
      "limit(1; .)",
      "first(.)",
      "recurse",
      "paths",
      "path(.)",
      "tojson",
      "fromjson",
      'test("a")',
      'match("a")',
      'split("a"; "g")',
      'ltrimstr("a")',
      "mktime",
      "gmtime",
      "localtime",
      'strflocaltime("%Y")',
      "splits",
      "map(.; .)",
      "length(.)",
      "getpath",
    ];
    const codes = await Promise.all(
      refused.map(async (source) => await compileError(source))
    );
    expect(codes).toStrictEqual(refused.map(() => "expression.unsupported"));
  });

  it("takes date formats only as short literals of plain directives", async () => {
    expect({
      iso: await compileError('strptime("%Y-%m-%dT%H:%M:%SZ")'),
      fromData: await compileError("strptime(.format)"),
      repeatedWhitespace: await compileError('strptime("%n%n%n")'),
      locale: await compileError('strftime("%c")'),
      long: await compileError(`strftime("${"%Y".repeat(40)}")`),
    }).toStrictEqual({
      iso: undefined,
      fromData: "expression.unsupported",
      repeatedWhitespace: "expression.unsupported",
      locale: "expression.unsupported",
      long: "expression.unsupported",
    });
  });

  it("negates with not, as a boolean operator", async () => {
    const condition = { kind: "boolean" } as const;
    expect({
      done: await run(".done | not", { input: { done: true } }, condition),
      pending: await run(
        "(.done | not) and .ready",
        { input: { done: false, ready: true } },
        condition
      ),
    }).toStrictEqual({ done: { result: false }, pending: { result: true } });
  });

  it("converts dates in UTC", async () => {
    await expect(
      run(
        '[(. | fromdateiso8601), (1791374400 | todateiso8601), ("07 Oct 2026" | strptime("%d %b %Y") | todateiso8601)]',
        { input: "2026-10-07T12:00:00Z" }
      )
    ).resolves.toStrictEqual({
      result: [1_791_374_400, "2026-10-07T12:00:00Z", "2026-10-07T00:00:00Z"],
    });
  });
});

describe("source limits", () => {
  it("takes expressions of up to 4096 bytes, counted in UTF-8", async () => {
    expect({
      atLimit: await compileError(quoted(4096)),
      overLimit: await compileError(quoted(4097)),
      // Two bytes per character: 2048 of them, quoted, is 4098 bytes.
      multibyte: await compileError(`"${"é".repeat(2048)}"`),
    }).toStrictEqual({
      atLimit: undefined,
      overLimit: "expression.too_large",
      multibyte: "expression.too_large",
    });
  });

  it("takes expressions nested up to 32 levels", async () => {
    expect({
      arrays: await compileError(nestedArrays(32)),
      deeperArrays: await compileError(nestedArrays(33)),
      ifs: await compileError(nestedIfs(32)),
      deeperIfs: await compileError(nestedIfs(33)),
    }).toStrictEqual({
      arrays: undefined,
      deeperArrays: "expression.too_deep",
      ifs: undefined,
      deeperIfs: "expression.too_deep",
    });
  });

  it("takes tasks nested up to 16 scopes deep", async () => {
    expect({
      atLimit: await compileError(".", { scope: scopeOf(16) }),
      overLimit: await compileError(".", { scope: scopeOf(17) }),
    }).toStrictEqual({
      atLimit: undefined,
      overLimit: "expression.scope_too_deep",
    });
  });
});

describe("value limits", () => {
  it("takes JSON nested up to 32 levels, in and out", async () => {
    expect({
      in: await run(".", { input: nested(32) }),
      deeperIn: await run(".", { input: nested(33) }),
      deeperInAVariable: await run("1", {
        variables: { context: nested(33) },
      }),
      deeperOut: await run("[.]", { input: nested(32) }),
      builtDeep: await run("reduce range(0; 40) as $i (0; [.])"),
    }).toStrictEqual({
      in: { result: nested(32) },
      deeperIn: { error: "expression.context_invalid" },
      deeperInAVariable: { error: "expression.context_invalid" },
      deeperOut: { error: "expression.result_invalid" },
      builtDeep: { error: "expression.result_invalid" },
    });
  });

  it("takes at most 1 MiB of input and variables together, and returns at most 1 MiB", async () => {
    const mebibyte = evaluatorLimits.maxContextBytes;
    const half = "x".repeat(mebibyte / 2);
    expect({
      underLimit: await run("length", { input: "x".repeat(mebibyte - 1024) }),
      overLimit: await run("length", { input: "x".repeat(mebibyte) }),
      overTogether: await run("length", {
        input: half,
        variables: { context: half },
      }),
      resultOverLimit: await run(". + . + .", { input: half }),
    }).toStrictEqual({
      underLimit: { result: mebibyte - 1024 },
      overLimit: { error: "expression.context_too_large" },
      overTogether: { error: "expression.context_too_large" },
      resultOverLimit: { error: "expression.result_too_large" },
    });
  });

  it("needs exactly one result", async () => {
    expect({
      one: await run("1"),
      two: await run("1, 2"),
      none: await run(".[]", { input: [] }),
      filteredOut: await run("select(. > 1)", { input: 1 }),
    }).toStrictEqual({
      one: { result: 1 },
      two: { error: "expression.result_count" },
      none: { error: "expression.result_count" },
      filteredOut: { error: "expression.result_count" },
    });
  });

  it("refuses numbers that aren't finite and safe", async () => {
    expect({
      overflow: await run("1e308 * 10"),
      unsafeInteger: await run("9007199254740992 + 2"),
      tonumber: await run('"1e400" | tonumber'),
      fraction: await run("0.1 + 0.2"),
      literalOutOfRange: await compileError("1e400"),
      nonFiniteInput: await run(".", { input: Number.POSITIVE_INFINITY }),
    }).toStrictEqual({
      overflow: { error: "expression.result_invalid" },
      unsafeInteger: { error: "expression.result_invalid" },
      tonumber: { error: "expression.result_invalid" },
      fraction: { result: 0.30000000000000004 },
      literalOutOfRange: "expression.unsupported",
      nonFiniteInput: { error: "expression.context_invalid" },
    });
  });
});

describe("result contracts, with no truthiness or coercion", () => {
  it("needs a condition to be a boolean", async () => {
    const condition = { kind: "boolean" } as const;
    expect({
      true: await run(". > 1", { input: 2 }, condition),
      false: await run("false", {}, condition),
      number: await run("1", {}, condition),
      string: await run('"true"', {}, condition),
      null: await run("null", {}, condition),
      array: await run("[true]", {}, condition),
    }).toStrictEqual({
      true: { result: true },
      false: { result: false },
      number: { error: "expression.type_mismatch" },
      string: { error: "expression.type_mismatch" },
      null: { error: "expression.type_mismatch" },
      array: { error: "expression.type_mismatch" },
    });
  });

  it("needs a duration to be whole milliseconds or a fixed ISO 8601 duration, and returns its milliseconds", async () => {
    const duration = { kind: "duration" } as const;
    expect({
      milliseconds: await run("1500", {}, duration),
      iso: await run('"PT1.5S"', {}, duration),
      isoDays: await run('"P1DT1H"', {}, duration),
      zero: await run("0", {}, duration),
      negative: await run("-1", {}, duration),
      fraction: await run("1.5", {}, duration),
      unsafe: await run("9007199254740991 + 1", {}, duration),
      numberText: await run('"1500"', {}, duration),
      isoZero: await run('"PT0S"', {}, duration),
      isoCalendar: await run('"P1M"', {}, duration),
      isoBelowMs: await run('"PT0.0001S"', {}, duration),
      isoEarlyFraction: await run('"PT1.5H30M"', {}, duration),
      isoLastFraction: await run('"PT1H0.5M"', {}, duration),
      null: await run("null", {}, duration),
    }).toStrictEqual({
      milliseconds: { result: 1500 },
      iso: { result: 1500 },
      isoDays: { result: 90_000_000 },
      zero: { error: "expression.type_mismatch" },
      negative: { error: "expression.type_mismatch" },
      fraction: { error: "expression.type_mismatch" },
      unsafe: { error: "expression.result_invalid" },
      numberText: { error: "expression.type_mismatch" },
      isoZero: { error: "expression.type_mismatch" },
      isoCalendar: { error: "expression.type_mismatch" },
      isoBelowMs: { error: "expression.type_mismatch" },
      isoEarlyFraction: { error: "expression.type_mismatch" },
      isoLastFraction: { result: 3_630_000 },
      null: { error: "expression.type_mismatch" },
    });
  });

  it("waits for an asynchronous schema, and can't be fooled by one that changes the value", async () => {
    const expected = "status";
    const schema = (
      validate: StandardSchemaV1["~standard"]["validate"]
    ): ResultContract => ({
      kind: "schema",
      expected,
      schema: { "~standard": { version: 1, vendor: "test", validate } },
    });
    const asynchronous = schema(async (value) => {
      await Promise.resolve();
      return isPending(value)
        ? { value }
        : { issues: [{ message: "not pending" }] };
    });
    // Approves anything by rewriting it in place, then returns it.
    const rewriting = schema((value) => {
      if (typeof value === "object" && value !== null) {
        Reflect.set(value, "status", "approved");
      }
      return { value };
    });
    const throwing = schema(() => {
      throw new Error("schema exploded with secret-7f2a");
    });
    expect({
      asyncAccepts: await run('{status: "pending"}', {}, asynchronous),
      asyncRefuses: await run('{status: "done"}', {}, asynchronous),
      inPlace: await run('{status: "pending"}', {}, rewriting),
      unchanged: await run('{status: "approved"}', {}, rewriting),
      throws: await run('{status: "pending"}', {}, throwing),
    }).toStrictEqual({
      asyncAccepts: { result: { status: "pending" } },
      asyncRefuses: { error: "expression.type_mismatch" },
      inPlace: { error: "expression.type_mismatch" },
      unchanged: { result: { status: "approved" } },
      throws: { error: "expression.type_mismatch" },
    });
  });

  it("needs a selector to be exactly what its schema accepts, untransformed", async () => {
    const status = {
      kind: "schema",
      schema: v.object({ status: v.enum(["approved", "rejected"]) }),
      expected: "{ status }",
    } as const;
    const trimmed = {
      kind: "schema",
      schema: v.string().trim(),
      expected: "trimmed string",
    } as const;
    expect({
      matches: await run('{status: "approved"}', {}, status),
      otherValue: await run('{status: "pending"}', {}, status),
      extraKey: await run('{status: "approved", by: "x"}', {}, status),
      wrongType: await run('"approved"', {}, status),
      alreadyTrimmed: await run('"x"', {}, trimmed),
      wouldBeTrimmed: await run('" x "', {}, trimmed),
    }).toStrictEqual({
      matches: { result: { status: "approved" } },
      otherValue: { error: "expression.type_mismatch" },
      extraKey: { error: "expression.type_mismatch" },
      wrongType: { error: "expression.type_mismatch" },
      alreadyTrimmed: { result: "x" },
      wouldBeTrimmed: { error: "expression.type_mismatch" },
    });
  });
});

// Evaluation is synchronous inside the isolate: had a runaway not stopped
// inside jq, nothing else could have run, these tests included. So each
// test proves termination by finishing, and the reason it gives (fuel or
// memory, never the platform's limit) proves the meter stopped it; fuel
// stops it at the same point on every run, so the reason is deterministic.
// Wall time isn't asserted: it depends on the machine, and workerd doesn't
// advance its clock while code runs.
describe("the kill path", () => {
  it("stops a runaway loop where it is, and the next evaluation runs", async () => {
    const runaway = await exhaust("reduce range(0; 1e15) as $i (0; . + 1)");
    const next = await run(". + 1", { input: 1 });
    expect({ runaway, next }).toStrictEqual({
      runaway: { code: "expression.resource_exhausted", reason: "fuel" },
      next: { result: 2 },
    });
  });

  it.each([
    // strptime runs in jq's JavaScript runtime; every call is charged.
    {
      source:
        'reduce range(0; 1e15) as $i (0; ("2026-10-07T12:00:00Z" | fromdateiso8601) + .)',
      reason: "fuel",
    },
    { source: "[range(0; 1e12)] | length", reason: "fuel" },
    { source: '"x" * 100000000 | length', reason: "memory" },
    {
      source: "reduce range(0; 40) as $i ([0]; . + .) | length",
      reason: "memory",
    },
  ])("stops $source by $reason", async ({ source, reason }) => {
    await expect(exhaust(source)).resolves.toStrictEqual({
      code: "expression.resource_exhausted",
      reason,
    });
  });

  it("leaves enough budget for real work on a large context", async () => {
    const items = Array.from({ length: 5000 }, (_, index) => ({
      id: `item-${index}`,
      amount: index,
      tags: ["a", "b"],
      note: "x".repeat(100),
    }));
    await expect(
      run("map(select(.amount % 2 == 0) | .amount) | add", { input: items })
    ).resolves.toStrictEqual({ result: 6_247_500 });
  });
});
