import { describe, expect, it } from "vite-plus/test";

import { appTest, maxAppTests, TestDefinitionError } from "../src/testing.ts";
import type { AppTestDefinition } from "../src/testing.ts";

// How `appTest` reads a suite's declaration: pure checks, so unit tests.
// That core runs a suite against the real host, and what its principals'
// calls do, is tested through core (apps/core/test/app-tests.test.ts).

// SAFETY: a deliberately ill-typed view, for declarations the types refuse.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
const looseAppTest = appTest as (definition: unknown) => unknown;

const passing = async (): Promise<void> => {
  await Promise.resolve();
};

describe(appTest, () => {
  it("describes a suite, frozen, without running any test", () => {
    let ran = false;
    const suite = appTest({
      fixtures: "notes",
      tests: {
        "never runs here": async () => {
          ran = true;
          await Promise.resolve();
        },
      },
    });
    expect({
      kind: suite.kind,
      fixtures: suite.fixtures,
      tests: Object.keys(suite.tests),
      frozen: Object.isFrozen(suite) && Object.isFrozen(suite.tests),
      ran,
    }).toStrictEqual({
      kind: "app",
      fixtures: "notes",
      tests: ["never runs here"],
      frozen: true,
      ran: false,
    });
  });

  it.each([
    ["no definition", undefined],
    [
      "a fixture name with capitals",
      { fixtures: "Notes", tests: { a: passing } },
    ],
    [
      "a fixture name that is a path",
      { fixtures: "../notes", tests: { a: passing } },
    ],
    ["no tests map", { fixtures: "notes", tests: [passing] }],
    ["no tests", { fixtures: "notes", tests: {} }],
    [
      "a test that isn't a function",
      { fixtures: "notes", tests: { a: "run" } },
    ],
    ["a blank test name", { fixtures: "notes", tests: { " ": passing } }],
    [
      "more tests than a suite holds",
      {
        fixtures: "notes",
        tests: Object.fromEntries(
          Array.from({ length: maxAppTests + 1 }, (_unused, index) => [
            `test ${index}`,
            passing,
          ])
        ),
      },
    ],
  ])("refuses %s", (_case, definition) => {
    expect(() => looseAppTest(definition)).toThrow(TestDefinitionError);
  });

  it("keeps a test named after a prototype key, and every other test", () => {
    const tests = Object.fromEntries([
      ["__proto__", passing],
      ["constructor", passing],
      ["reads back", passing],
    ]);
    const suite = appTest({ fixtures: "notes", tests });
    expect(Object.keys(suite.tests)).toStrictEqual([
      "__proto__",
      "constructor",
      "reads back",
    ]);
    expect(Object.getPrototypeOf(suite.tests)).toBe(Object.prototype);
  });

  it("keeps a test name as people wrote it", () => {
    const definition: AppTestDefinition = {
      fixtures: "notes-summary",
      tests: { "creating a note updates the list": passing },
    };
    expect(Object.keys(appTest(definition).tests)).toStrictEqual([
      "creating a note updates the list",
    ]);
  });
});
