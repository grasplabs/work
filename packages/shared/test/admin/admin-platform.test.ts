import { describe, expect, it } from "vite-plus/test";

import {
  driftOf,
  needsOf,
  standingOf,
} from "../../src/admin/admin-platform.ts";
import type { Platform } from "../../src/admin/admin-platform.ts";
import { SAMPLE_PLATFORMS } from "./fixtures/admin-platform-sample.ts";

const { hartog, noordkade, vanrijn } = SAMPLE_PLATFORMS;
const [core] = noordkade.workers;

describe("a company’s own platform", () => {
  it("is in sync while what runs is what the console made live, and says how it is not", () => {
    expect(core).toBeDefined();
    if (!core) {
      return;
    }
    expect(driftOf(noordkade)).toBe("in_sync");
    const split: Platform = {
      ...noordkade,
      workers: [
        {
          ...core,
          live: [
            { version: core.version, share: 90 },
            { version: "v-old", share: 10 },
          ],
        },
      ],
    };
    expect(driftOf(split)).toBe("split");
    expect(
      driftOf({
        ...noordkade,
        workers: [{ ...core, live: [{ version: "v-other", share: 100 }] }],
      })
    ).toBe("drifted");
    expect(driftOf({ ...noordkade, workers: [{ ...core, live: null }] })).toBe(
      "unknown"
    );
  });

  it("is off its pin while it runs another release than the one it is pinned to, and unknown without Workers", () => {
    expect(driftOf({ ...noordkade, pinned: "r412-91d0e47" })).toBe("off_pin");
    expect(driftOf(vanrijn)).toBe("unknown");
  });

  it("says what needs someone at Grasp, the most pressing first", () => {
    expect(needsOf(noordkade)).toStrictEqual([]);
    expect(needsOf(hartog).map((need) => need.kind)).toStrictEqual([
      "failed",
      "errors",
      "secrets",
    ]);
    expect(
      [hartog, noordkade, vanrijn].map((platform) => standingOf(platform))
    ).toStrictEqual(["attention", "healthy", "none"]);
    const waiting: Platform = {
      ...vanrijn,
      status: "provisioning",
      provisioning: { step: "paid", state: "waiting", since: "2026-10-15" },
    };
    expect(needsOf(waiting)).toStrictEqual([
      { kind: "provisioning", step: "paid", state: "waiting" },
    ]);
  });
});
