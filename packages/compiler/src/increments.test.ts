import { describe, expect, it } from "vite-plus/test";

import { moduleRecordOf } from "./increments.ts";

// What a pages build may reuse of earlier ones (increments.ts): pure
// logic. Whole builds reusing them, against core's cache, are core's
// tests (apps/core/test/page-increments.test.ts).

describe("records handed to a build", () => {
  it("are used only as their own file's, shaped as a record", () => {
    const module = {
      path: "src/components/card.tsx",
      code: "export {};",
      app: [],
      kit: [],
      candidates: [],
      references: { specifiers: [], global: false },
    };
    expect({
      module: moduleRecordOf(module, "src/components/card.tsx")?.path,
      otherFile: moduleRecordOf(module, "src/routes/index.tsx"),
      badCode: moduleRecordOf(
        { ...module, code: 1 },
        "src/components/card.tsx"
      ),
      badReferences: moduleRecordOf(
        { ...module, references: { specifiers: [1], global: false } },
        "src/components/card.tsx"
      ),
    }).toStrictEqual({
      module: "src/components/card.tsx",
      otherFile: undefined,
      badCode: undefined,
      badReferences: undefined,
    });
  });
});
