import { describe, expect, it } from "vite-plus/test";

import { diagnosticCategory } from "../src/diagnostics.ts";

// Pure: a diagnostic's rule to its category. The categories App builds
// produce are tested through a save (core's build-on-save.test.ts); these
// are the shapes a rule can take beyond them.

describe("a diagnostic's category", () => {
  it.each([
    ["TS2322", "types"],
    ["shadcn/no-raw-colors", "design-system"],
    ["@scope/plugin-rule", "design-system"],
    ["lint", "design-system"],
    ["bindings", "structure"],
    ["file-names", "structure"],
    ["TS", "internal"],
    ["anything-else", "internal"],
  ])("files %s as %s", (rule, category) => {
    expect(diagnosticCategory(rule)).toBe(category);
  });
});
