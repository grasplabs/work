import { isRecord } from "@grasp-os/shared/json";

import type { AppTestFunction, AppTestSuite } from "./app-test-types.ts";
import { refuser } from "./declaration.ts";
import { tablesOf } from "./define-schema.ts";
import type { SchemaDefinition } from "./schema-types.ts";
import type { AnyTables } from "./server-function.ts";

// App tests, as `@grasp-os/sdk/testing` exports them.
//
// `appTest` describes a suite and runs nothing itself. Core's trusted test
// runner loads an App's `tests/*.test.ts` in a sandboxed isolate, with the
// App's release and its generated `@server/_generated/api` references, and
// runs each suite with `runAppSuite` over a host it passes in: every call
// a test identity makes crosses back into core, which runs it through the
// real function host on a store of the test's own, as it runs a page's
// call. Nothing here stands in for core; what a test asserts is what the
// App answered.

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

/** The suite `schema` and `tests` declare, checked and frozen. */
export const readSuite = (schema: unknown, tests: unknown): AppTestSuite => {
  try {
    tablesOf(schema);
  } catch {
    return refuseSuite(
      "appTest takes the App's schema first, the default export of server/schema.ts: appTest(schema, { ... })."
    );
  }
  if (!isRecord(tests)) {
    return refuseSuite("appTest's tests map each test's name to its function.");
  }
  // Defined, never assigned: a test named `__proto__` is a test, not a
  // new prototype that would drop it.
  const checked: Record<string, AppTestFunction> = {};
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
    Object.defineProperty(checked, name, { value: test, enumerable: true });
  }
  const count = Object.keys(checked).length;
  if (count === 0 || count > maxAppTests) {
    return refuseSuite(
      `A suite has between 1 and ${maxAppTests} tests; this one has ${count}.`
    );
  }
  return Object.freeze({
    kind: "app",
    // SAFETY: `tablesOf` found it one `defineSchema` made.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
    schema: schema as SchemaDefinition,
    tests: Object.freeze(checked),
  });
};

/**
 * Declares one of an App's test suites: the default export of a file in
 * its `tests/` folder named `*.test.ts`, such as `tests/notes.test.ts`,
 * over the App's schema (`server/schema.ts`'s default export). Every
 * suite runs when a version of the App is published, which is refused
 * while any of its tests fails. Each test runs on a store of its own,
 * empty as it starts; assert with `expect`, imported from `vitest`.
 *
 * ```ts
 * import { appTest } from "@grasp-os/sdk/testing";
 * import { api } from "@server/_generated/api";
 * import { expect } from "vitest";
 * import schema from "../server/schema";
 *
 * export default appTest(schema, {
 *   "an owner reads back the note they create": async (t) => {
 *     const ada = t.withIdentity({ name: "Ada" });
 *     const id = await ada.mutation(api.notes.create, { title: "First" });
 *     expect(await ada.query(api.notes.get, { id })).toMatchObject({
 *       title: "First",
 *     });
 *   },
 * });
 * ```
 */
export const appTest = <Tables extends AnyTables>(
  schema: SchemaDefinition<Tables>,
  tests: Readonly<Record<string, AppTestFunction<Tables>>>
): AppTestSuite => readSuite(schema, tests);
