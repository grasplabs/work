import { describe, expect, it } from "vite-plus/test";

import { reportDelayMs } from "./stall-reporter.ts";

describe("when the stall report is due", () => {
  it("counts from the process's start, not from when the tests start", () => {
    expect([
      reportDelayMs(15, 0),
      reportDelayMs(15, 90),
      reportDelayMs(0.5, 10.5),
    ]).toStrictEqual([900_000, 810_000, 19_500]);
  });

  it("is at once when the process has already run that long", () => {
    expect([reportDelayMs(15, 900), reportDelayMs(15, 1000)]).toStrictEqual([
      0, 0,
    ]);
  });
});
