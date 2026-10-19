import { describe, expect, test } from "vite-plus/test";

import { resource } from "../src/action.ts";

// What `resource` refuses as an action's use is declared: each refusal
// names the kind of use the author wrote, never another's. Declarations
// here are what module code may pass at run time, not what its types allow.

/** Why declaring `kind` use `docs` with `options` was refused. */
const refusalOf = (
  kind: "knowledge" | "connector",
  options: unknown
): string => {
  try {
    Reflect.apply(resource[kind], undefined, ["docs", options]);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "declared";
};

describe("an action's declared uses", () => {
  test.each([
    ["no operations", []],
    ["the same operation twice", ["search", "search"]],
    ["more operations than there are", ["search", "read", "search"]],
  ])(
    "a knowledge use with %s is refused as a knowledge use's",
    (_case, operations) => {
      expect(refusalOf("knowledge", { operations })).toMatch(
        /knowledge use's/u
      );
    }
  );

  test("a knowledge use of an operation it has no such name for is refused", () => {
    expect(refusalOf("knowledge", { operations: ["delete"] })).toMatch(
      /"search", "read" or both/u
    );
  });

  test("a connector use with no operations is refused as a connector use's", () => {
    expect(refusalOf("connector", { operations: [] })).toMatch(
      /connector use's/u
    );
  });
});
