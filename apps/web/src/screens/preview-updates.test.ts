import type { PreviewApplied, PreviewLoad } from "@grasp-os/sdk/screen-runtime";
import type { PreviewRefresh, PreviewUpdate } from "@grasp-os/shared/chat";
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
  }: { desk?: string; part?: string; bytes?: number; kit?: string[] } = {}
): PreviewRefresh => ({
  revision,
  screen: "desk",
  entry: desk,
  modules: { [desk]: bytes, [part]: bytes },
  css: "",
  kit,
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
 * modules of it it hasn't at that address (visit and address).
 */
const following = (
  answers: (() => Promise<PreviewUpdate>)[],
  frameSays: (handed: Handed) => PreviewApplied = () => "applied"
) => {
  const opened = refreshAt(1);
  const versions = new Map<string, PreviewRefresh>([[opened.entry, opened]]);
  const moduleMap = new Set(
    Object.keys(opened.modules).map((address) => `0/${address}`)
  );
  const handedOver: Handed[] = [];
  const healths: PreviewHealth[] = [];
  const moved: number[] = [];
  const askedFor: number[] = [];
  const seen = {
    handed: handedOver,
    health: healths,
    moved,
    askedFor,
    resets: 0,
    asked: 0,
  };
  const updates = new PreviewUpdates(app, opened, {
    fetch: async (revision) => {
      seen.askedFor.push(revision);
      const answer = answers[seen.asked];
      seen.asked += 1;
      if (answer === undefined) {
        throw new Error("Core was asked more than the test said.");
      }
      const update = await answer();
      versions.set(update.refresh.entry, update.refresh);
      return update;
    },
    health: (health) => {
      seen.health.push(health);
    },
    reset: () => {
      seen.resets += 1;
    },
    moved: (revision) => {
      seen.moved.push(revision);
    },
  });
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

  it("files what the frame reports while it tries an update under that update's revision, and the rest under the one it shows", async () => {
    const reportedAt: number[] = [];
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
