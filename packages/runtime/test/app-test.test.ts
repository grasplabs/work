import { describe, expect, it } from "vite-plus/test";

import { appTest, maxAppTests, TestDefinitionError } from "../src/testing.ts";
import schema from "./notes/server/schema.ts";

// How `appTest` reads a suite's declaration: pure checks, so unit tests.
// That core runs a suite against the real host, and what its identities'
// calls do, is tested through core (apps/core/test/app-tests.test.ts).

// SAFETY: a deliberately ill-typed view, for declarations the types refuse.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseAppTest = appTest as (schema: unknown, tests: unknown) => unknown;

const passing = async (): Promise<void> => {
  await Promise.resolve();
};

describe(appTest, () => {
  it("describes a suite over the App's schema, frozen, without running any test", () => {
    let ran = false;
    const suite = appTest(schema, {
      "never runs here": async () => {
        ran = true;
        await Promise.resolve();
      },
    });
    expect({
      kind: suite.kind,
      schema: suite.schema === schema,
      tests: Object.keys(suite.tests),
      frozen: Object.isFrozen(suite) && Object.isFrozen(suite.tests),
      ran,
    }).toStrictEqual({
      kind: "app",
      schema: true,
      tests: ["never runs here"],
      frozen: true,
      ran: false,
    });
  });

  it.each([
    ["no schema", undefined, { a: passing }],
    ["a schema defineSchema didn't make", { tables: {} }, { a: passing }],
    ["no tests map", schema, [passing]],
    ["no tests", schema, {}],
    ["a test that isn't a function", schema, { a: "run" }],
    ["a blank test name", schema, { " ": passing }],
    [
      "more tests than a suite holds",
      schema,
      Object.fromEntries(
        Array.from({ length: maxAppTests + 1 }, (_unused, index) => [
          `test ${index}`,
          passing,
        ])
      ),
    ],
  ])("refuses %s", (_case, given, tests) => {
    expect(() => looseAppTest(given, tests)).toThrow(TestDefinitionError);
  });

  it("keeps a test named after a prototype key, and every other test", () => {
    const tests = Object.fromEntries([
      ["__proto__", passing],
      ["constructor", passing],
      ["reads back", passing],
    ]);
    const suite = appTest(schema, tests);
    expect(Object.keys(suite.tests)).toStrictEqual([
      "__proto__",
      "constructor",
      "reads back",
    ]);
    expect(Object.getPrototypeOf(suite.tests)).toBe(Object.prototype);
  });
});
