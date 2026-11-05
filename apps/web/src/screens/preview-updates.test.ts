import type { PreviewApplied, PreviewLoad } from "@grasp-os/sdk/screen-runtime";
import { versionErrors } from "@grasp-os/shared/app-releases";
import type {
  PreviewAt,
  PreviewRefresh,
  PreviewUpdate,
} from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { screenErrors } from "@grasp-os/shared/screens";
import { describe, expect, it, vi } from "vite-plus/test";

import { PreviewUpdates } from "./preview-updates.ts";
import type { PreviewHealth } from "./preview-updates.ts";

// The page handing a chat's preview its draft's writes (preview-updates.ts):
// what can go wrong is the frame shown another App's module, a stale one,
// or one it can't load as it is; code it ran before imported again, which
// a browser doesn't evaluate twice, so Refresh would keep the newer code;
// and the person shown a broken screen rather than the last version that
// worked, with a calm word that it is being fixed. Core and the frame are
// outside: what core answers is scripted, and the frame stands in for a
// browser's module map, evaluating one address once.

const app = appIdSchema.parse("a".repeat(32));
const other = appIdSchema.parse("b".repeat(32));

/**
 * The screen at `revision`, as core answers it: its module at `desk`, the
 * address of what it says, importing a component at `part`.
 */
const refreshAt = (
  revision: number,
  {
    desk = `desk-${revision}`,
    part = "part",
    bytes = 10,
    kit = ["react.js"],
    appVersion,
  }: {
    desk?: string;
    part?: string;
    bytes?: number;
    kit?: string[];
    appVersion?: number;
  } = {}
): PreviewRefresh => ({
  revision,
  screen: "desk",
  entry: desk,
  modules: { [desk]: bytes, [part]: bytes },
  css: "",
  kit,
  ...(appVersion === undefined ? {} : { appVersion }),
});

/** A version the frame is handed: its revision, entry, visit, and the modules it evaluated anew. */
interface Handed {
  revision: number;
  visit: number;
  evaluated: string[];
}

/**
 * A preview's updates over a scripted core and frame: `answers` is what
 * core answers each ask with, in turn; the frame answers `frameSays` for
 * each version it is handed, after evaluating, as a browser does, the
 * modules of it it hasn't at that address (visit and address). The frame
 * opened at `opened`, the App's latest version in place of the draft's
 * screen when `fallback`.
 */
const following = (
  answers: (() => Promise<PreviewUpdate>)[],
  frameSays: (handed: Handed) => PreviewApplied = () => "applied",
  { opened = refreshAt(1), fallback = false } = {}
) => {
  const versions = new Map<string, PreviewRefresh>([[opened.entry, opened]]);
  const moduleMap = new Set(
    Object.keys(opened.modules).map((address) => `0/${address}`)
  );
  const handedOver: Handed[] = [];
  const healths: PreviewHealth[] = [];
  const moved: PreviewAt[] = [];
  const askedFor: number[] = [];
  // The App's version the frame said it shows, with each ask.
  const showing: (number | undefined)[] = [];
  const shows: (number | undefined)[] = [];
  const seen = {
    handed: handedOver,
    health: healths,
    moved,
    askedFor,
    showing,
    shows,
    resets: 0,
    asked: 0,
  };
  const updates = new PreviewUpdates(
    app,
    opened,
    {
      fetch: async (revision, appVersion) => {
        seen.askedFor.push(revision);
        seen.showing.push(appVersion);
        const answer = answers[seen.asked];
        seen.asked += 1;
        if (answer === undefined) {
          throw new Error("Core was asked more than the test said.");
        }
        const update = await answer();
        if ("refresh" in update) {
          versions.set(update.refresh.entry, update.refresh);
        }
        return update;
      },
      health: (health) => {
        seen.health.push(health);
      },
      reset: () => {
        seen.resets += 1;
      },
      moved: (at) => {
        seen.moved.push(at);
      },
      shows: (appVersion) => {
        seen.shows.push(appVersion);
      },
    },
    fallback
  );
  const toFrame = async ({ entry, visit }: PreviewLoad) => {
    await Promise.resolve();
    const version = versions.get(entry);
    if (version === undefined) {
      return "refused";
    }
    const evaluated = Object.keys(version.modules).filter(
      (address) => !moduleMap.has(`${visit}/${address}`)
    );
    for (const address of evaluated) {
      moduleMap.add(`${visit}/${address}`);
    }
    const handed = { revision: version.revision, visit, evaluated };
    seen.handed.push(handed);
    return frameSays(handed);
  };
  return { updates, seen, toFrame };
};

const answered =
  (refresh: PreviewRefresh, of = app) =>
  async (): Promise<PreviewUpdate> =>
    await Promise.resolve({ app: of, refresh });

/** The revisions handed, in turn. */
const revisionsOf = (handed: Handed[]): number[] =>
  handed.map(({ revision }) => revision);

describe("a preview taking its draft's writes in the frame it has open", () => {
  it("hands the frame each newer revision, loading only the modules a write changed, its calls following", async () => {
    const { updates, seen, toFrame } = following([answered(refreshAt(2))]);
    updates.follow(toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([2]);
    });
    expect(seen.handed).toStrictEqual([
      { revision: 2, visit: 0, evaluated: ["desk-2"] },
    ]);
  });

  it("asks for the revision the chat named, one at a time, then only the newest it named meanwhile", async () => {
    const slow = Promise.withResolvers<PreviewUpdate>();
    const { updates, seen, toFrame } = following([
      async () => await slow.promise,
      answered(refreshAt(5)),
    ]);
    updates.follow(toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(seen.askedFor).toStrictEqual([2]);
    });
    updates.revise(3);
    updates.revise(4);
    updates.revise(5);
    slow.resolve({ app, refresh: refreshAt(2) });
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([2, 5]);
    });
    expect({
      askedFor: seen.askedFor,
      handed: revisionsOf(seen.handed),
    }).toStrictEqual({ askedFor: [2, 5], handed: [2, 5] });
  });

  it("never hands the frame another App's module, nor one it is past", async () => {
    const { updates, seen, toFrame } = following([
      answered(refreshAt(2), other),
      answered(refreshAt(1)),
    ]);
    updates.follow(toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(seen.asked).toBe(1);
    });
    updates.revise(3);
    await vi.waitFor(() => {
      expect(seen.asked).toBe(2);
    });
    expect({ handed: seen.handed, moved: seen.moved }).toStrictEqual({
      handed: [],
      moved: [],
    });
  });

  it("evaluates code it ran before afresh, under a new visit, when a write goes back to it", async () => {
    const { updates, seen, toFrame } = following([
      answered(refreshAt(2, { desk: "desk-b" })),
      // Back to what it opened with.
      answered(refreshAt(3, { desk: "desk-1" })),
      answered(refreshAt(4, { desk: "desk-c" })),
    ]);
    updates.follow(toFrame);
    for (const revision of [2, 3, 4]) {
      updates.revise(revision);
      // oxlint-disable-next-line no-await-in-loop -- one write after another
      await vi.waitFor(() => {
        expect(seen.moved.at(-1)).toBe(revision);
      });
    }
    expect(seen.handed).toStrictEqual([
      { revision: 2, visit: 0, evaluated: ["desk-b"] },
      { revision: 3, visit: 1, evaluated: ["desk-1", "part"] },
      { revision: 4, visit: 1, evaluated: ["desk-c"] },
    ]);
  });

  it("swaps the last version that rendered back in, evaluated afresh, when a write fails to render, saying it is being fixed until a write fixes it", async () => {
    const { updates, seen, toFrame } = following(
      [
        // Doesn't build.
        async () =>
          await Promise.reject(
            screenErrors.create("screen.build_failed", { reason: "x" })
          ),
        // Builds, and fails to render in the frame.
        answered(refreshAt(3)),
        answered(refreshAt(4)),
      ],
      ({ revision }) => (revision === 3 ? "broken" : "applied")
    );
    updates.follow(toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(seen.health).toStrictEqual(["fixing"]);
    });
    updates.revise(3);
    await vi.waitFor(() => {
      expect(seen.handed).toHaveLength(2);
    });
    const whileBroken = { health: [...seen.health], moved: [...seen.moved] };
    updates.revise(4);
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([4]);
    });
    expect({
      whileBroken,
      handed: seen.handed,
      health: seen.health,
    }).toStrictEqual({
      whileBroken: { health: ["fixing"], moved: [] },
      handed: [
        { revision: 3, visit: 0, evaluated: ["desk-3"] },
        // The version it opened with, back.
        { revision: 1, visit: 1, evaluated: ["desk-1", "part"] },
        { revision: 4, visit: 1, evaluated: ["desk-4"] },
      ],
      health: ["fixing", "working"],
    });
  });

  it("says the problem is being fixed while the draft's server code doesn't build, showing each write of its screens meanwhile, until its server code builds", async () => {
    const { updates, seen, toFrame } = following([
      // Its server code doesn't build, and no server code did before.
      async () =>
        await Promise.reject(
          versionErrors.create("version.build_failed", { reason: "x" })
        ),
      // A write of its screens, on the last server code that built.
      answered({ ...refreshAt(3), serverUnbuilt: true }),
      // Its server code builds again.
      answered(refreshAt(4)),
    ]);
    updates.follow(toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(seen.health).toStrictEqual(["fixing"]);
    });
    updates.revise(3);
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([3]);
    });
    const whileUnbuilt = [...seen.health];
    updates.revise(4);
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([3, 4]);
    });

    expect({
      whileUnbuilt,
      handed: revisionsOf(seen.handed),
      health: seen.health,
    }).toStrictEqual({
      whileUnbuilt: ["fixing"],
      handed: [3, 4],
      health: ["fixing", "working"],
    });
  });

  it("opens being fixed on a build of the last server code that built, in place of the draft's: a problem reported then is nothing new", () => {
    const { seen, updates } = following([], () => "applied", {
      opened: { ...refreshAt(1), serverUnbuilt: true },
    });
    updates.problem();
    updates.close();

    expect(seen.health).toStrictEqual([]);
  });

  it("keeps the App's version shown in place of a draft that didn't build being fixed, its calls on that version's own code, until a write of the draft shows", async () => {
    // What the screen's first render and mount effects call, as each
    // version is handed: the fallback swapped back in too.
    const callsWhileHanded: PreviewAt[] = [];
    const held: { updates?: PreviewUpdates } = {};
    const { updates, seen, toFrame } = following(
      [answered(refreshAt(2)), answered(refreshAt(3))],
      ({ revision }) => {
        callsWhileHanded.push(held.updates?.runningAt() ?? -1);
        return revision === 2 ? "broken" : "applied";
      },
      { opened: refreshAt(1, { appVersion: 1 }), fallback: true }
    );
    held.updates = updates;
    updates.follow(toFrame);
    const opened = { health: [...seen.health], callsAt: updates.runningAt() };
    updates.revise(2);
    await vi.waitFor(() => {
      expect(seen.handed).toHaveLength(2);
    });
    const broken = updates.runningAt();
    updates.revise(3);
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([3]);
    });

    expect({
      opened,
      broken,
      health: seen.health,
      callsAt: updates.runningAt(),
      callsWhileHanded,
      shows: seen.shows,
    }).toStrictEqual({
      opened: { health: [], callsAt: { appVersion: 1 } },
      broken: { appVersion: 1 },
      health: ["working"],
      callsAt: 3,
      callsWhileHanded: [2, { appVersion: 1 }, 3],
      // The App's version 1, then the draft's own changes.
      shows: [1, undefined],
    });
  });

  it("names the App's version it shows in its calls and asks, then the draft's revision once a write of the draft shows", async () => {
    const { updates, seen, toFrame } = following(
      [answered(refreshAt(1))],
      undefined,
      {
        opened: refreshAt(0, { appVersion: 1 }),
      }
    );
    updates.follow(toFrame);
    const opened = updates.runningAt();
    updates.revise(1);
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([1]);
    });

    expect({
      opened,
      showing: seen.showing,
      callsAt: updates.runningAt(),
    }).toStrictEqual({
      opened: { appVersion: 1 },
      showing: [1],
      callsAt: 1,
    });
  });

  it("starts afresh when core says another version of the App is the one to show, takes nothing when it says the one shown is, and asks nothing over the draft's own changes", async () => {
    const drafted = following([]);
    drafted.updates.follow(drafted.toFrame);
    drafted.updates.again();
    const same = following(
      [async () => await Promise.resolve({ app, unchanged: true as const })],
      undefined,
      { opened: refreshAt(1, { appVersion: 1 }) }
    );
    same.updates.follow(same.toFrame);
    same.updates.again();
    await vi.waitFor(() => {
      expect(same.seen.asked).toBe(1);
    });
    const another = following(
      [async () => await Promise.resolve({ app, restart: true as const })],
      undefined,
      { opened: refreshAt(1, { appVersion: 1 }) }
    );
    another.updates.follow(another.toFrame);
    another.updates.again();
    await vi.waitFor(() => {
      expect(another.seen.resets).toBe(1);
    });

    expect({
      same: { handed: same.seen.handed, resets: same.seen.resets },
      another: {
        handed: another.seen.handed,
        askedFor: another.seen.askedFor,
        showing: another.seen.showing,
      },
      drafted: drafted.seen.asked,
    }).toStrictEqual({
      same: { handed: [], resets: 0 },
      another: { handed: [], askedFor: [1], showing: [1] },
      drafted: 0,
    });
  });

  it("files what the frame reports while it tries an update under that update's revision, and the rest under the one it shows", async () => {
    const reportedAt: PreviewAt[] = [];
    const held: { updates?: PreviewUpdates } = {};
    const run = following([answered(refreshAt(2))], ({ revision }) => {
      // The frame reports the update's render error before it answers.
      reportedAt.push(held.updates?.runningAt() ?? -1);
      return revision === 2 ? "broken" : "applied";
    });
    const { updates } = run;
    held.updates = updates;
    const before = updates.runningAt();
    updates.follow(run.toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(revisionsOf(run.seen.handed)).toStrictEqual([2, 1]);
    });
    // Swapped back: what the frame meets now is the version it shows.
    expect({ before, reportedAt, after: updates.runningAt() }).toStrictEqual({
      before: 1,
      reportedAt: [2, 1],
      after: 1,
    });
  });

  it.each([
    ["renders nothing", "an empty render"],
    ["logs an error without throwing", "a console.error"],
  ])(
    "keeps saying a problem is being fixed when an update that %s is applied",
    async () => {
      const held: { updates?: PreviewUpdates } = {};
      const run = following([answered(refreshAt(2))], () => {
        // The frame reports what the update ran into before it answers
        // that it shows it.
        held.updates?.problem();
        return "applied";
      });
      held.updates = run.updates;
      run.updates.follow(run.toFrame);
      run.updates.revise(2);
      await vi.waitFor(() => {
        expect(run.seen.moved).toStrictEqual([2]);
      });
      expect(run.seen.health).toStrictEqual(["fixing"]);
    }
  );

  it("says a problem the screen reported is being fixed, once", () => {
    const { updates, seen } = following([]);
    updates.problem();
    updates.problem();
    expect(seen.health).toStrictEqual(["fixing"]);
  });

  it("starts the frame afresh for an update it can't load as it is", async () => {
    const newKit = following([
      answered(refreshAt(2, { kit: ["react.js", "kit~chart.js"] })),
    ]);
    newKit.updates.follow(newKit.toFrame);
    newKit.updates.revise(2);
    const tooLarge = following([
      answered(refreshAt(2, { bytes: platformLimits.previewResetBytes })),
    ]);
    tooLarge.updates.follow(tooLarge.toFrame);
    tooLarge.updates.revise(2);
    const refreshGaveUp = following([answered(refreshAt(2))], ({ revision }) =>
      revision === 2 ? "reset" : "applied"
    );
    refreshGaveUp.updates.follow(refreshGaveUp.toFrame);
    refreshGaveUp.updates.revise(2);
    await vi.waitFor(() => {
      expect(
        [newKit, tooLarge, refreshGaveUp].map(({ seen }) => seen.resets)
      ).toStrictEqual([1, 1, 1]);
    });
    expect(
      [newKit, tooLarge, refreshGaveUp].map(({ seen }) =>
        revisionsOf(seen.handed)
      )
    ).toStrictEqual([[], [], [2]]);
  });

  it("counts every version a frame took toward its reset, those that failed to render and the version swapped back for each, not only those it took", async () => {
    const revisions = Array.from({ length: 64 }, (_, at) => at + 2);
    const { updates, seen, toFrame } = following(
      revisions.map((revision) => answered(refreshAt(revision))),
      ({ revision }) => (revision === 1 ? "applied" : "broken")
    );
    updates.follow(toFrame);
    for (const revision of revisions) {
      if (seen.resets > 0) {
        break;
      }
      const before = seen.handed.length;
      updates.revise(revision);
      // Handed over and swapped back, or the frame started afresh instead.
      // oxlint-disable-next-line no-await-in-loop -- one write after another
      await vi.waitFor(() => {
        expect(
          seen.handed.length === before + 2 || seen.resets > 0
        ).toBeTruthy();
      });
    }
    // Each broken write and the version swapped back for it: two a write,
    // so the frame starts afresh before it took more than one frame may.
    const failedWrites = Math.floor(platformLimits.previewResetRevisions / 2);
    expect({
      resets: seen.resets,
      handed: seen.handed.length,
    }).toStrictEqual({ resets: 1, handed: 2 * failedWrites });
  });
});
