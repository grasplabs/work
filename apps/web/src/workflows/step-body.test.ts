import { describe, expect, it } from "vite-plus/test";

import { stepFieldsAt } from "./step-body.ts";

// Reading the step a diagram's pointer names, from the text it was drawn
// from: nested steps, and nothing for a pointer that names no step, text
// that isn't JSON or a key reached only through a prototype.

const source = JSON.stringify({
  $schema: "https://grasp.work/schemas/grasp-workflow/1.json",
  steps: [
    { id: "first", type: "wait", for: "1 minute" },
    {
      id: "check",
      type: "try",
      try: [{ id: "inner", type: "do", binding: "http", operation: "get" }],
      catch: { do: [] },
    },
  ],
});

describe("a step's fields", () => {
  it("are read at a step's pointer, nested, without its ID", () => {
    expect({
      first: stepFieldsAt(source, "/steps/0"),
      inner: stepFieldsAt(source, "/steps/1/try/0"),
    }).toStrictEqual({
      first: { type: "wait", for: "1 minute" },
      inner: { type: "do", binding: "http", operation: "get" },
    });
  });

  it("are nothing where the pointer names no step, or the text isn't JSON", () => {
    expect([
      stepFieldsAt(source, "/steps/7"),
      stepFieldsAt(source, "/steps/01"),
      stepFieldsAt(source, "/steps"),
      stepFieldsAt(source, "steps/0"),
      stepFieldsAt(source, "/steps/1/catch"),
      stepFieldsAt("{ not yet", "/steps/0"),
      stepFieldsAt(source, "/steps/0/constructor"),
      stepFieldsAt(source, "/__proto__/0"),
    ]).toStrictEqual(Array.from({ length: 8 }));
  });
});
