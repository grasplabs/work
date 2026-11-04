import { describe, expect, it } from "vite-plus/test";

import { moduleRecordOf } from "./increments.ts";

// What a screens build may reuse of earlier ones (increments.ts): pure
// logic. Whole builds reusing them, against core's cache, are core's
// tests (apps/core/test/screen-increments.test.ts).

describe("records handed to a build", () => {
  it("are used only as their own file's, shaped as a record", () => {
    const module = {
      path: "components/card.tsx",
      code: "export {};",
      app: [],
      kit: [],
      candidates: [],
    };
    expect({
      module: moduleRecordOf(module, "components/card.tsx")?.path,
      otherFile: moduleRecordOf(module, "screens/desk.tsx"),
      badCode: moduleRecordOf({ ...module, code: 1 }, "components/card.tsx"),
    }).toStrictEqual({
      module: "components/card.tsx",
      otherFile: undefined,
      badCode: undefined,
    });
  });
});
