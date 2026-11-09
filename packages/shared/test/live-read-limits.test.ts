import { describe, expect, it } from "vite-plus/test";

import { liveReadLimitsOf, querySubscriptionLimits } from "../src/pages.ts";

const { liveReads } = querySubscriptionLimits;

describe("the live-read budget a deployment is configured with", () => {
  it("takes a lower burst and rate, each on its own", () => {
    expect({
      both: liveReadLimitsOf("50/300"),
      burst: liveReadLimitsOf(`50/${liveReads.perMinute + 1}`),
    }).toStrictEqual({
      both: { burst: 50, perMinute: 300 },
      burst: { burst: 50, perMinute: liveReads.perMinute },
    });
  });

  it("keeps the default for a higher, a garbled or an empty value, or none", () => {
    const higher = `${liveReads.burst + 1}/${liveReads.perMinute + 1}`;
    for (const value of [
      higher,
      "lots",
      "-5/-1",
      "1.5/2.5",
      "/",
      "",
      undefined,
    ]) {
      expect(liveReadLimitsOf(value)).toStrictEqual(liveReads);
    }
  });
});
