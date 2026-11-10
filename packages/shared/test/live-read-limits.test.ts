import { describe, expect, it } from "vite-plus/test";

import { liveReadLimitsOf } from "../src/pages.ts";

/** A person's live-read budget when nothing lowers it. */
const budget = { burst: 200, perMinute: 600 };

describe("the live-read budget a deployment is configured with", () => {
  it("takes a lower burst and rate, each on its own", () => {
    expect({
      both: liveReadLimitsOf("50/300"),
      burst: liveReadLimitsOf("50/601"),
    }).toStrictEqual({
      both: { burst: 50, perMinute: 300 },
      burst: { burst: 50, perMinute: 600 },
    });
  });

  it("keeps the default for a higher, a garbled or an empty value, or none", () => {
    for (const value of [
      "201/601",
      "lots",
      "-5/-1",
      "1.5/2.5",
      "/",
      "",
      undefined,
    ]) {
      expect(liveReadLimitsOf(value)).toStrictEqual(budget);
    }
  });
});
