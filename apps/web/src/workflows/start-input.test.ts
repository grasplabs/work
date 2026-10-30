import { describe, expect, it } from "vite-plus/test";

import { startFieldsOf, startInputOf } from "./start-input.ts";

// A workflow's input schema as a start form, and what a filled-in form
// sends: plain fields only, everything else typed as JSON; what the
// schema needs is never sent missing or of the wrong kind.

const schema = {
  type: "object",
  properties: {
    who: { type: "string" },
    times: { type: "integer" },
    ratio: { type: "number" },
    urgent: { type: "boolean" },
    tone: { type: "string", enum: ["warm", "formal"] },
    note: { type: "string" },
  },
  required: ["who", "times", "urgent", "tone"],
  additionalProperties: false,
};

describe("a workflow's input as a start form", () => {
  it("asks for each field of an object of text, numbers, yes or no and choices, as its schema says", () => {
    expect(startFieldsOf(schema)).toStrictEqual([
      { name: "who", required: true, kind: "text" },
      { name: "times", required: true, kind: "number", integer: true },
      { name: "ratio", required: false, kind: "number", integer: false },
      { name: "urgent", required: true, kind: "yes" },
      {
        name: "tone",
        required: true,
        kind: "choice",
        choices: ["warm", "formal"],
      },
      { name: "note", required: false, kind: "text" },
    ]);
  });

  it("leaves any other input to be typed as JSON", () => {
    expect({
      list: startFieldsOf({ type: "array", items: { type: "string" } }),
      nested: startFieldsOf({
        type: "object",
        properties: { address: { type: "object", properties: {} } },
      }),
      nullable: startFieldsOf({
        type: "object",
        properties: {
          who: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      }),
      unread: startFieldsOf(null),
      // An object of nothing: a form with no fields, nothing to type.
      empty: startFieldsOf({ type: "object", properties: {}, required: [] }),
    }).toStrictEqual({
      list: undefined,
      nested: undefined,
      nullable: undefined,
      unread: undefined,
      empty: [],
    });
  });

  it("sends each value as its kind, and leaves out an optional field left empty", () => {
    const fields = startFieldsOf(schema) ?? [];

    expect(
      startInputOf(fields, {
        who: "",
        times: "3",
        ratio: "",
        urgent: true,
        tone: "warm",
        note: "",
      })
    ).toStrictEqual({
      ok: true,
      input: { who: "", times: 3, urgent: true, tone: "warm" },
    });
  });

  it("names the first field it can't send, and why", () => {
    const fields = startFieldsOf(schema) ?? [];
    const filled = { who: "Ada", times: "3", tone: "warm" };

    expect({
      noTimes: startInputOf(fields, { ...filled, times: " " }),
      notNumber: startInputOf(fields, { ...filled, times: "three" }),
      notWhole: startInputOf(fields, { ...filled, times: "2.5" }),
      noChoice: startInputOf(fields, { ...filled, tone: "" }),
      badRatio: startInputOf(fields, { ...filled, ratio: "a lot" }),
    }).toStrictEqual({
      noTimes: { ok: false, field: "times", problem: "missing" },
      notNumber: { ok: false, field: "times", problem: "number" },
      notWhole: { ok: false, field: "times", problem: "integer" },
      noChoice: { ok: false, field: "tone", problem: "missing" },
      badRatio: { ok: false, field: "ratio", problem: "number" },
    });
  });
});
