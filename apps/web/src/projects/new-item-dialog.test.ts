import { workflowNameSchema } from "@grasp-os/shared/workflow-resources";
import { describe, expect, it } from "vite-plus/test";

import { workflowNameOf } from "./new-item-dialog.tsx";

// A workflow made from a project's New dialog takes its name from what
// was typed, in the form core accepts (`workflowNameSchema`), whatever was
// typed.

describe("a new workflow's name", () => {
  it("is one core accepts, from whatever was typed", () => {
    const typed = [
      "Invoice approvals",
      "Q1 cash — Ünïcödé!!",
      "",
      "   ",
      "-",
      "x".repeat(200),
    ];

    const names = typed.map(workflowNameOf);

    expect({
      valid: names.map((name) => workflowNameSchema.safeParse(name).success),
      words: names.map((name) => name.slice(0, -9)),
    }).toStrictEqual({
      valid: [true, true, true, true, true, true],
      words: [
        "invoice-approvals",
        "q1-cash-unicode",
        "new-workflow",
        "new-workflow",
        "new-workflow",
        "x".repeat(48),
      ],
    });
  });
});
