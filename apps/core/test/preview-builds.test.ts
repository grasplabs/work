import type { PreviewUpdate } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
import { describe, expect, it } from "vite-plus/test";

import { PreviewBuilds } from "../src/preview-builds.ts";
import type { PreviewBuilt } from "../src/preview-builds.ts";

// One build per revision of a chat's preview, shared by every preview
// that asks for it (preview-builds.ts): pure logic, so tested on its own,
// where every ask arrives exactly when the test says. What can go wrong:
// the same revision built once per asker; an older revision built after a
// newer one; a failed build standing in for the next ask.

const app = appIdSchema.parse("a".repeat(32));

/** An update at `revision`, its page's module `entry`, as a build answers one. */
const builtAt = (revision: number, entry: string): PreviewUpdate => ({
  app,
  refresh: { revision, entry, modules: {}, css: "", kit: [] },
});

/** What an ask answered: its update's module, or the code of its refusal. */
const outcomeOf = async (ask: Promise<PreviewBuilt>): Promise<unknown> => {
  try {
    const built = await ask;
    return "refresh" in built ? built.refresh?.entry : undefined;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error
      ? error.code
      : String(error);
  }
};

describe("a chat's preview's builds", () => {
  it("starts one build for every ask of a revision while it runs", async () => {
    const builds = new PreviewBuilds();
    const held = Promise.withResolvers<null>();
    let started = 0;
    const build = async (): Promise<PreviewUpdate> => {
      started += 1;
      await held.promise;
      return builtAt(2, `build ${String(started)}`);
    };
    const asks = Array.from(
      { length: 3 },
      async () => await outcomeOf(builds.build("chat:app:update", 2, 2, build))
    );
    held.resolve(null);
    expect({ answers: await Promise.all(asks), started }).toStrictEqual({
      answers: ["build 1", "build 1", "build 1"],
      started: 1,
    });
  });

  it("never builds a revision older than the draft's, while a newer one builds or after", async () => {
    const builds = new PreviewBuilds();
    const held = Promise.withResolvers<null>();
    const started: number[] = [];
    const building = (revision: number) => async (): Promise<PreviewUpdate> => {
      started.push(revision);
      await held.promise;
      return builtAt(revision, String(revision));
    };
    const newer = outcomeOf(builds.build("chat:app:update", 3, 3, building(3)));
    // A preview that knows only an earlier revision asks for it.
    const during = await outcomeOf(
      builds.build("chat:app:update", 2, 3, building(2))
    );
    held.resolve(null);
    const after = await outcomeOf(
      builds.build("chat:app:update", 2, 3, building(2))
    );
    expect({ newer: await newer, during, after, started }).toStrictEqual({
      newer: "3",
      during: "app.preview_outdated",
      after: "app.preview_outdated",
      started: [3],
    });
  });

  it("frees the revision of a build that failed, for every ask that shared it, so the next builds again", async () => {
    const builds = new PreviewBuilds();
    const held = Promise.withResolvers<null>();
    let started = 0;
    const failing = async (): Promise<PreviewUpdate> => {
      started += 1;
      await held.promise;
      throw new Error("The build failed.");
    };
    const shared = [
      outcomeOf(builds.build("chat:app:update", 2, 2, failing)),
      outcomeOf(builds.build("chat:app:update", 2, 2, failing)),
    ];
    held.resolve(null);
    const failed = await Promise.all(shared);
    const next = await outcomeOf(
      builds.build("chat:app:update", 2, 2, async () => {
        started += 1;
        return await Promise.resolve(builtAt(2, "built"));
      })
    );
    expect({ failed, next, started }).toStrictEqual({
      // The ask that only shared it asked again, once, and that failed too.
      failed: ["Error: The build failed.", "Error: The build failed."],
      next: "built",
      started: 3,
    });
  });

  it("builds again, once and shared, for the asks that shared a build whose asker went away", async () => {
    const builds = new PreviewBuilds();
    const gone = Promise.withResolvers<null>();
    let started = 0;
    // The first asker's tab closes mid-build: its callback is gone.
    const startersBuild = async (): Promise<PreviewUpdate> => {
      started += 1;
      await gone.promise;
      throw new Error("Network connection lost.");
    };
    const ownBuild = async (): Promise<PreviewUpdate> => {
      started += 1;
      return await Promise.resolve(builtAt(2, "built again"));
    };
    const asks = [
      outcomeOf(builds.build("chat:app:update", 2, 2, startersBuild)),
      outcomeOf(builds.build("chat:app:update", 2, 2, ownBuild)),
      outcomeOf(builds.build("chat:app:update", 2, 2, ownBuild)),
    ];
    gone.resolve(null);
    expect({ answers: await Promise.all(asks), started }).toStrictEqual({
      // The one that went away hears nothing; the other two, one build.
      answers: [
        "Error: Network connection lost.",
        "built again",
        "built again",
      ],
      started: 2,
    });
  });

  it("keeps the builds of different previews and asks apart", async () => {
    const builds = new PreviewBuilds();
    let started = 0;
    const build = async (): Promise<PreviewUpdate> => {
      started += 1;
      return await Promise.resolve(builtAt(2, String(started)));
    };
    const answers = await Promise.all([
      outcomeOf(builds.build("chat:app:update:desk", 2, 2, build)),
      outcomeOf(builds.build("chat:app:update:list", 2, 2, build)),
      outcomeOf(builds.build("other:app:update:desk", 2, 2, build)),
    ]);
    expect({ answers, started }).toStrictEqual({
      answers: ["1", "2", "3"],
      started: 3,
    });
  });
});
