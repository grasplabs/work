import type {
  ReleaseCompatibility,
  ReleaseManifest,
} from "@grasp-os/shared/release";
import { describe, expect, it } from "vite-plus/test";

import { incompatibility } from "../src/deploy/compatibility.ts";
import { deployOrder } from "../src/deploy/versions.ts";
import { buildRelease, declared } from "./releases.ts";

/**
 * What a release declares when connect serves `serves` (from `servesFrom`,
 * when given) and core calls connect `calls`.
 */
const interfaces = (
  connect: { serves: number; servesFrom?: number },
  calls: { min: number; max: number }
): ReleaseCompatibility => ({
  ...declared,
  interfaces: {
    connect: { ...connect, calls: {} },
    core: { calls: { connect: calls } },
  },
});

const release = async (
  compatibility: ReleaseCompatibility
): Promise<ReleaseManifest> => {
  const built = await buildRelease({
    notes: "fix(admin): a test",
    compatibility,
  });
  return built.manifest;
};

/**
 * Why a client on `from` everywhere can't take `to`, its Workers switching
 * one at a time in `to`'s deploy order: as a rollout checks it
 * (src/hosting/operation.ts) and a rollback, `to` being the release
 * before (src/rollout/rollback.ts).
 */
const rollOut = (from: ReleaseManifest, to: ReleaseManifest) =>
  incompatibility(
    new Map(Object.keys(from.workers).map((app) => [app, from])),
    to,
    deployOrder(to.workers),
    null
  );

describe("a client's Workers switching to a release with another connect interface", () => {
  it("take an additive bump connect first, then core, from a release that declares only what it serves", async () => {
    // As 26.10.81 found its clients: connect 2, from before `servesFrom`.
    const before = await release(interfaces({ serves: 2 }, { min: 2, max: 2 }));
    const bumped = await release(
      interfaces({ serves: 3, servesFrom: 2 }, { min: 3, max: 3 })
    );

    expect(rollOut(before, bumped)).toBeNull();
  });

  it("go back from an additive bump whose core still calls the connect before", async () => {
    const before = await release(interfaces({ serves: 2 }, { min: 2, max: 2 }));
    const bumped = await release(
      interfaces({ serves: 3, servesFrom: 2 }, { min: 2, max: 3 })
    );

    expect({
      out: rollOut(before, bumped),
      back: rollOut(bumped, before),
    }).toStrictEqual({ out: null, back: null });
  });

  it("don't go back connect first while the bump's core calls only what the bump added", async () => {
    const before = await release(interfaces({ serves: 2 }, { min: 2, max: 2 }));
    const bumped = await release(
      interfaces({ serves: 3, servesFrom: 2 }, { min: 3, max: 3 })
    );

    expect(rollOut(bumped, before)).toStrictEqual({
      code: "release_incompatible",
      message: `core of ${bumped.releaseId} calls connect 3, but connect of ${before.releaseId} serves 2`,
    });
  });

  it("refuse a breaking bump, whose connect no longer serves what the core before calls", async () => {
    const before = await release(
      interfaces({ serves: 2, servesFrom: 1 }, { min: 2, max: 2 })
    );
    const breaking = await release(
      interfaces({ serves: 3, servesFrom: 3 }, { min: 3, max: 3 })
    );

    expect(rollOut(before, breaking)).toStrictEqual({
      code: "release_incompatible",
      message: `core of ${before.releaseId} calls connect 2, but connect of ${breaking.releaseId} serves 3`,
    });
  });

  it("read a release that declares only what it serves as serving exactly that", async () => {
    const before = await release(interfaces({ serves: 2 }, { min: 2, max: 2 }));
    const undeclared = await release(
      interfaces({ serves: 3 }, { min: 3, max: 3 })
    );
    const callsBoth = await release(
      interfaces({ serves: 3 }, { min: 2, max: 3 })
    );

    expect({
      exactly: rollOut(before, undeclared),
      calledBack: rollOut(callsBoth, before),
    }).toStrictEqual({
      exactly: {
        code: "release_incompatible",
        message: `core of ${before.releaseId} calls connect 2, but connect of ${undeclared.releaseId} serves 3`,
      },
      calledBack: null,
    });
  });

  it("refuse a release whose connect serves from later than its newest version", async () => {
    await expect(
      release(interfaces({ serves: 3, servesFrom: 4 }, { min: 3, max: 3 }))
    ).rejects.toThrow(/served from no later than its newest version/u);
  });
});
