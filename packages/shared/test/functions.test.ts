import { describe, expect, test } from "vite-plus/test";

import { categoryOf, jsonWithin } from "../src/functions.ts";
import { isRetryable, retryWaitMsOf } from "../src/workflows.ts";

// Reading a value as bounded JSON, and how a failure's code is classified:
// pure, so unit tests.

const encoder = new TextEncoder();

describe(jsonWithin, () => {
  test("copies JSON and counts exactly the bytes of its text", () => {
    const value = {
      title: "Café ☕",
      rank: -1.5e-7,
      tags: ["a", "", null, true, false],
      nested: { empty: {}, list: [] },
    };
    expect(jsonWithin(value, 1000)).toStrictEqual({
      json: value,
      bytes: encoder.encode(JSON.stringify(value)).byteLength,
    });
  });

  test("stops at the limit, however large the rest", () => {
    const text = "x".repeat(10_000_000);
    expect(jsonWithin({ text }, 128)).toBe("too_large");
    expect(jsonWithin(["a".repeat(60), "b".repeat(60), "c"], 128)).toBe(
      "too_large"
    );
    const exact = { a: "b" };
    expect(jsonWithin(exact, JSON.stringify(exact).length)).toStrictEqual({
      json: exact,
      bytes: 9,
    });
  });

  test("refuses what isn't JSON", () => {
    // An array with a hole, as an array's length makes one.
    const holed: unknown[] = [1];
    holed.length = 3;
    expect(
      [undefined, Number.NaN, new Date(0), holed, { a: undefined }].map(
        (value) => jsonWithin(value, 1000)
      )
    ).toStrictEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});

describe(categoryOf, () => {
  test("puts each verdict on a call's run where it belongs", () => {
    const verdicts = [
      "function.cpu_exceeded",
      "function.memory_exceeded",
      "function.sandbox_refused",
      "function.call_limit",
      "function.depth_exceeded",
      "function.ended",
      "function.unfinished_call",
      "function.deadline_exceeded",
      "function.sandbox_busy",
      "function.sandbox_unavailable",
    ];
    expect(
      Object.fromEntries(verdicts.map((code) => [code, categoryOf(code)]))
    ).toStrictEqual({
      // The App's own code went past a bound of one call.
      "function.cpu_exceeded": "source",
      "function.memory_exceeded": "source",
      "function.sandbox_refused": "source",
      "function.call_limit": "source",
      "function.depth_exceeded": "source",
      "function.ended": "operational",
      "function.unfinished_call": "contract",
      "function.deadline_exceeded": "operational",
      "function.sandbox_busy": "operational",
      "function.sandbox_unavailable": "operational",
    });
  });
});

describe(isRetryable, () => {
  test("retries a step on every code a function's caller would try again, and on the workflow's own", () => {
    const codes = [
      "permission.budget_busy",
      "function.sandbox_busy",
      "function.sandbox_unavailable",
      "mutation.concurrent_change",
      "connect.server_unavailable",
      "model.rate_limited",
      "function.cpu_exceeded",
      "permission.declined",
    ];
    expect(
      Object.fromEntries(codes.map((code) => [code, isRetryable({ code })]))
    ).toStrictEqual({
      "permission.budget_busy": true,
      "function.sandbox_busy": true,
      "function.sandbox_unavailable": true,
      "mutation.concurrent_change": true,
      "connect.server_unavailable": true,
      "model.rate_limited": true,
      "function.cpu_exceeded": false,
      "permission.declined": false,
    });
  });
});

/** The wait a step's failure of `code`, with `details`, names. */
const waitOf = (code: string, details?: unknown) =>
  retryWaitMsOf({ code, details });

describe(retryWaitMsOf, () => {
  test("waits as long as a failure a retry may fix names, in either unit, and never for one it can't", () => {
    expect({
      paused: waitOf("connect.rate_limited", { retryAfterSeconds: 90 }),
      throttled: waitOf("connect.server_unavailable", { retryAfterMs: 1500 }),
      fraction: waitOf("connect.rate_limited", { retryAfterSeconds: 0.0015 }),
      none: waitOf("connect.rate_limited", { retryAfterSeconds: 0 }),
      unnamed: waitOf("connect.rate_limited"),
      notANumber: waitOf("connect.rate_limited", { retryAfterSeconds: "90" }),
      // An outcome unknown names when it may be recovered: a retry can't
      // fix it, so the step doesn't wait for it.
      notRetryable: waitOf("connect.outcome_unknown", {
        retryAfterSeconds: 90,
      }),
    }).toStrictEqual({
      paused: 90_000,
      throttled: 1500,
      fraction: 2,
      none: undefined,
      unnamed: undefined,
      notANumber: undefined,
      notRetryable: undefined,
    });
  });
});
