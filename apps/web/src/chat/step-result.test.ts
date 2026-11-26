import { describe, expect, it } from "vite-plus/test";

import { stepResultOf } from "./step-result.ts";

// What a step gave back, read from what core gave the model. These start
// from the ways it could go wrong: a tool's own JSON taken for a run's
// result (and its fields hidden), a run's result shown as JSON, a cut
// marker shown as words of the result, or the same connection named twice.

describe("what a step gave back", () => {
  it("reads a run's result into where it read from, what it logged, what it returned or why it failed, and whether part was left out", () => {
    expect(
      stepResultOf(
        JSON.stringify({
          readFrom: [
            "connection conn-1 (messages.list)",
            "connection conn-1 (its account's name)",
            "connection conn-2",
          ],
          logs: ["one", "two"],
          returned: [1, 2],
          cut: true,
        })
      )
    ).toStrictEqual({
      kind: "run",
      readFrom: ["conn-1", "conn-2"],
      logs: ["one", "two"],
      returned: { value: [1, 2] },
      error: undefined,
      cut: true,
    });
    expect(
      stepResultOf(
        JSON.stringify({ status: "failed", error: "The ledger API is down" })
      )
    ).toStrictEqual({
      kind: "run",
      readFrom: [],
      logs: [],
      returned: undefined,
      error: "The ledger API is down",
      cut: false,
    });
    expect(stepResultOf('{"returned":null}')).toMatchObject({
      returned: { value: null },
    });
  });

  it("reads a run that returned, logged and read nothing as nothing to show, and an object that only looks like one as text", () => {
    expect({
      nothing: stepResultOf("{}"),
      status: stepResultOf('{"status":"done"}'),
      logs: stepResultOf('{"logs":"x"}'),
    }).toStrictEqual({
      nothing: {
        kind: "run",
        readFrom: [],
        logs: [],
        returned: undefined,
        error: undefined,
        cut: false,
      },
      status: { kind: "text", text: '{"status":"done"}', cut: false },
      logs: { kind: "text", text: '{"logs":"x"}', cut: false },
    });
  });

  it("keeps any other text as it is, a tool's own JSON too, and says when core cut it", () => {
    expect({
      lines: stepResultOf("1: export default"),
      json: stepResultOf('{"changed":["a.ts"]}'),
      cut: stepResultOf("1: a\n2: b\n… (cut: over 20000 bytes of output)"),
    }).toStrictEqual({
      lines: { kind: "text", text: "1: export default", cut: false },
      json: { kind: "text", text: '{"changed":["a.ts"]}', cut: false },
      cut: { kind: "text", text: "1: a\n2: b", cut: true },
    });
  });
});
