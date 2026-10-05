import { describe, expect, test } from "vite-plus/test";

import { runValueCases } from "./value-cases.ts";

// The conformance cases of `v`, in workerd. The same cases run in a browser
// (e2e/sdk-values.e2e.ts); value-cases.ts says why.
describe("values", () => {
  test.each(runValueCases())("$name", ({ actual, expected }) => {
    expect(JSON.parse(actual)).toStrictEqual(JSON.parse(expected));
  });
});
