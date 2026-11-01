import { describe, expect, it } from "vite-plus/test";

import { notesOf } from "../../src/admin/onboarding-admin.ts";

describe("Grasp’s notes on an organization", () => {
  it("carry a single text from before notes were a list as the first of the list", () => {
    expect(notesOf("Call Anne on Monday.")).toStrictEqual([
      { id: "note-0", at: 0, text: "Call Anne on Monday." },
    ]);
    expect(notesOf("   ")).toStrictEqual([]);
    expect(notesOf()).toStrictEqual([]);
    expect(
      notesOf([{ id: "a", at: 5, text: "x" }, { id: "b" }, null])
    ).toStrictEqual([{ id: "a", at: 5, text: "x" }]);
  });
});
