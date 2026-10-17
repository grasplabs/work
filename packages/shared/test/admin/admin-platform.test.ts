import { describe, expect, it } from "vite-plus/test";

import {
  behindOf,
  driftOf,
  needsOf,
  releaseOf,
  ringsOf,
  standingOf,
} from "../../src/admin/admin-platform.ts";
import type { Platform, Rollout } from "../../src/admin/admin-platform.ts";
import { adminViewOf } from "../../src/admin/admin-view.ts";
import {
  SAMPLE_PLATFORMS,
  SAMPLE_RELEASES,
} from "./fixtures/admin-platform-sample.ts";
import { SAMPLE_ORGS } from "./fixtures/admin-sample.ts";

const { hartog, noordkade, veldkamp, vanrijn } = SAMPLE_PLATFORMS;
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

  it("counts how far behind the newest release it is, and a pinned one is never asked to catch up", () => {
    expect(behindOf(noordkade, SAMPLE_RELEASES)).toBe(0);
    expect(behindOf(veldkamp, SAMPLE_RELEASES)).toBe(1);
    const old: Platform = {
      ...veldkamp,
      workers: veldkamp.workers.map((worker) => ({
        ...worker,
        release: "r405-c27b18f",
      })),
    };
    expect(needsOf(old, SAMPLE_RELEASES)).toStrictEqual([
      { kind: "behind", releases: 2 },
    ]);
    expect(
      needsOf({ ...old, pinned: "r405-c27b18f" }, SAMPLE_RELEASES)
    ).toStrictEqual([]);
  });

  it("says what needs someone at Grasp, the most pressing first", () => {
    expect(needsOf(noordkade, SAMPLE_RELEASES)).toStrictEqual([]);
    expect(
      needsOf(hartog, SAMPLE_RELEASES).map((need) => need.kind)
    ).toStrictEqual(["failed", "errors", "secrets"]);
    expect(
      [hartog, noordkade, vanrijn].map((platform) =>
        standingOf(platform, SAMPLE_RELEASES)
      )
    ).toStrictEqual(["attention", "healthy", "none"]);
    const waiting: Platform = {
      ...vanrijn,
      status: "provisioning",
      provisioning: { step: "paid", state: "waiting", since: "2026-10-15" },
    };
    expect(needsOf(waiting, SAMPLE_RELEASES)).toStrictEqual([
      { kind: "provisioning", step: "paid", state: "waiting" },
    ]);
  });
});

describe("how a release reaches every company", () => {
  const rollout: Rollout = {
    id: "ro",
    kind: "release",
    release: "r418-3f9c2ab",
    status: "waiting",
    ring: 1,
    by: "Nick",
    at: "2026-10-14",
    targets: [
      { org: "a", ring: 0, status: "done" },
      { org: "b", ring: 1, status: "done" },
      { org: "c", ring: 2, status: "pending" },
      { org: "d", ring: 2, status: "pending" },
    ],
  };

  it("goes ring by ring, and waits after each for someone at Grasp", () => {
    expect(ringsOf(rollout).map((ring) => ring.state)).toStrictEqual([
      "done",
      "done",
      "waiting",
    ]);
    // Approved past ring 1: ring 2's companies deploy.
    const next: Rollout = {
      ...rollout,
      status: "running",
      ring: 2,
      targets: rollout.targets.map((target) =>
        target.ring === 2 ? { ...target, status: "deploying" } : target
      ),
    };
    expect(ringsOf(next).map((ring) => ring.state)).toStrictEqual([
      "done",
      "done",
      "running",
    ]);
  });

  it("does not count a ring as done when its rollout was cancelled part way", () => {
    const cancelled: Rollout = {
      ...rollout,
      status: "cancelled",
      ring: 2,
      targets: rollout.targets.map((target) =>
        target.ring === 2 ? { ...target, status: "stopped" } : target
      ),
    };
    expect(ringsOf(cancelled).map((ring) => ring.state)).toStrictEqual([
      "done",
      "done",
      "stopped",
    ]);
  });
});

describe("the samples", () => {
  it("belong to sample organizations, and run only where the contract is signed", () => {
    const releases = new Set(SAMPLE_RELEASES.map((release) => release.id));
    for (const [id, platform] of Object.entries(SAMPLE_PLATFORMS)) {
      const org = SAMPLE_ORGS.find((each) => each.id === id);
      expect(org).toBeDefined();
      if (!org) {
        continue;
      }
      const signed =
        adminViewOf(org, org.seed, "2026-10-02").contract.status === "signed";
      expect(platform.status === "active").toBe(signed);
      // Every release a sample runs or ran is one the console imported.
      expect(
        platform.deploys.every((deploy) => releases.has(deploy.release))
      ).toBeTruthy();
      expect(releaseOf(platform) === null).toBe(platform.workers.length === 0);
    }
  });
});
