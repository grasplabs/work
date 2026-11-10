import { isRecord } from "@grasp-os/shared/json";

import type {
  AppTestDefinition,
  AppTestFunction,
  AppTestSuite,
  WorkflowTestDefinition,
  WorkflowTestFunction,
  WorkflowTestSuite,
} from "./app-test-types.ts";
import { refuser } from "./declaration.ts";

// App tests, as `@grasp-os/runtime/testing` exports them.
//
// `appTest` describes a suite and runs nothing itself. Core's trusted test
// runner loads an App's `tests/*.test.ts` in a sandboxed isolate, with the
// App's release and its generated `@server/_generated/api` references, and runs each suite
// with `runAppSuite` over a host it passes in: every call a test principal
// makes crosses back into core, which runs it through the real operation
// host on a fixture store of the test's own, as it runs a page's call.
// Nothing here stands in for core; what a test asserts is what the App
// answered.

/** How a fixture or a principal is named: `notes`, `note-owner`. */
export const testNamePattern = /^[a-z][a-z0-9-]{0,63}$/u;

/** The most tests one suite holds. */
export const maxAppTests = 100;

/** The longest a test's name is, in characters. */
export const maxAppTestName = 200;

/** A suite declared wrong: says what to fix. */
export class TestDefinitionError extends Error {
  override name = "TestDefinitionError";
}

export const refuseSuite: (message: string) => never =
  refuser(TestDefinitionError);

/** The suite `definition` declares, as `kind`, checked and frozen. */
export const readSuite = <Test extends AppTestFunction | WorkflowTestFunction>(
  definition: unknown,
  kind: "app" | "workflow"
): {
  kind: "app" | "workflow";
  fixtures: string;
  tests: Readonly<Record<string, Test>>;
} => {
  if (!isRecord(definition)) {
    return refuseSuite(
      `${kind === "app" ? "appTest" : "workflowTest"} takes { fixtures, tests }.`
    );
  }
  const { fixtures, tests } = definition;
  if (typeof fixtures !== "string" || !testNamePattern.test(fixtures)) {
    return refuseSuite(
      "`fixtures` names a fixture in tests/fixtures/, such as `notes`: lowercase letters, digits and hyphens, starting with a letter."
    );
  }
  if (!isRecord(tests)) {
    return refuseSuite("`tests` maps each test's name to its function.");
  }
  // Defined, never assigned: a test named `__proto__` is a test, not a
  // new prototype that would drop it.
  const checked: Record<string, Test> = {};
  for (const [name, test] of Object.entries(tests)) {
    if (name.trim() === "" || name.length > maxAppTestName) {
      return refuseSuite(
        `A test's name is between 1 and ${maxAppTestName} characters.`
      );
    }
    if (typeof test !== "function") {
      return refuseSuite(`Test "${name}" isn't a function.`);
    }
    // A function, checked just above; what it does with `t` is the test's
    // own, and a failure is reported as the test's.
    Object.defineProperty(checked, name, {
      value: test,
      enumerable: true,
    });
  }
  const count = Object.keys(checked).length;
  if (count === 0 || count > maxAppTests) {
    return refuseSuite(
      `A suite has between 1 and ${maxAppTests} tests; this one has ${count}.`
    );
  }
  return Object.freeze({
    kind,
    fixtures,
    tests: Object.freeze(checked),
  });
};

/**
 * Declares one of an App's test suites: the default export of a file in
 * its `tests/` folder named `*.test.ts`, such as `tests/notes.test.ts`.
 * Every suite runs when a version of the App is made current, which is
 * refused while any of its tests fails.
 *
 * ```ts
 * import { appTest } from "@grasp-os/runtime/testing";
 * import { api } from "@server/_generated/api";
 *
 * export default appTest({
 *   fixtures: "notes",
 *   tests: {
 *     "an owner reads back the note they create": async (t) => {
 *       const owner = await t.as("note-owner");
 *       const id = await owner.mutation(api.notes.create, { title: "First" });
 *       t.equal((await owner.query(api.notes.get, { id }))?.title, "First");
 *     },
 *   },
 * });
 * ```
 */
export const appTest = (definition: AppTestDefinition): AppTestSuite => {
  const { fixtures, tests } = readSuite<AppTestFunction>(definition, "app");
  return Object.freeze({ kind: "app", fixtures, tests });
};

/**
 * Declares one of an App's suites of workflow tests: the default export of
 * a file in its `tests/` folder named `*.test.ts`, as `appTest`'s. Its
 * principals also start the workflows the App binds, each a real run on
 * the engine (`t.as(...).start`), and `t` follows those runs: how each
 * ended (`t.runs`) and what its steps did (`t.effects`). Its suites run,
 * and refuse a failing version, as `appTest`'s do.
 *
 * ```ts
 * import { workflowTest } from "@grasp-os/runtime/testing";
 * import { workflows } from "@server/_generated/api";
 *
 * export default workflowTest({
 *   fixtures: "notes",
 *   tests: {
 *     "a summary completes once": async (t) => {
 *       const owner = await t.as("note-owner");
 *       const run = await owner.start(workflows.summarize, { text: "Hi" });
 *       const outcome = await t.runs.untilTerminal(run);
 *       t.equal(outcome.status, "completed");
 *       t.equal(await t.effects.completedCount(run, "summarize"), 1);
 *     },
 *   },
 * });
 * ```
 */
export const workflowTest = (
  definition: WorkflowTestDefinition
): WorkflowTestSuite => {
  const { fixtures, tests } = readSuite<WorkflowTestFunction>(
    definition,
    "workflow"
  );
  return Object.freeze({ kind: "workflow", fixtures, tests });
};
