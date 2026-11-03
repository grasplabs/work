import { describe, expect, it } from "vite-plus/test";

import { stepBodyAt } from "./step-body.ts";

// Reading the step a diagram's pointer names, from the text it was drawn
// from: nested tasks and escaped IDs, and nothing for a pointer that names
// no task, text that isn't JSON or a key reached only through a prototype.

const source = JSON.stringify({
  do: [
    { first: { set: { status: "one" } } },
    {
      "check/a~b": {
        try: [{ inner: { call: "http", with: { method: "get" } } }],
        catch: { do: [] },
      },
    },
  ],
});

describe("a step's body", () => {
  it("is read at a task's pointer, nested and with an escaped ID", () => {
    expect({
      first: stepBodyAt(source, "/do/0/first"),
      inner: stepBodyAt(source, "/do/1/check~1a~0b/try/0/inner"),
    }).toStrictEqual({
      first: { set: { status: "one" } },
      inner: { call: "http", with: { method: "get" } },
    });
  });

  it("is nothing where the pointer names no task, or the text isn't JSON", () => {
    expect([
      stepBodyAt(source, "/do/0/second"),
      stepBodyAt(source, "/do/7/first"),
      stepBodyAt(source, "/do/01/check~1a~0b"),
      stepBodyAt(source, "/do"),
      stepBodyAt(source, "do/0/first"),
      stepBodyAt(source, "/do/0/first/set/status"),
      stepBodyAt("{ not yet", "/do/0/first"),
      stepBodyAt(source, "/do/0/constructor"),
      stepBodyAt(source, "/__proto__/0/first"),
    ]).toStrictEqual(Array.from({ length: 9 }));
  });
});
