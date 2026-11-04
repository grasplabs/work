import type { PreviewApplied, PreviewPart } from "@grasp-os/sdk/screen-runtime";
import { appErrors } from "@grasp-os/shared/apps";
import type { PreviewRefresh, PreviewUpdate } from "@grasp-os/shared/chat";
import { appIdSchema } from "@grasp-os/shared/ids";
import { platformLimits } from "@grasp-os/shared/platform-limits";
import { screenErrors } from "@grasp-os/shared/screens";
import { describe, expect, it, vi } from "vite-plus/test";

import { wait } from "../core.ts";
import {
  partsOf,
  previewPartChars,
  PreviewUpdates,
} from "./preview-updates.ts";
import type { PreviewHealth } from "./preview-updates.ts";

// The page handing a chat's preview its draft's writes (preview-updates.ts):
// what can go wrong is the frame shown another App's module, a stale one,
// or one it can't load as it is, and the person shown a broken screen
// rather than the last version that worked, with a calm word that it is
// being fixed. Core and the frame are outside: what core answers is
// scripted, and the frame answers each part as its receiver would.

const app = appIdSchema.parse("a".repeat(32));
const other = appIdSchema.parse("b".repeat(32));

/** The screen at `revision`, as core answers it. */
const refreshAt = (
  revision: number,
  extra: Partial<PreviewRefresh> = {}
): PreviewRefresh => ({
  revision,
  screen: "desk",
  code: `export default "r${revision}";`,
  bytes: 20,
  sha256: "0".repeat(64),
  css: "",
  kit: ["react.js"],
  ...extra,
});

/**
 * A preview's updates over a scripted core and frame: `answers` is what
 * core answers each ask with, in turn; the frame answers `frameSays` for
 * each update's last part.
 */
const following = (
  answers: (() => Promise<PreviewUpdate>)[],
  frameSays: (part: PreviewPart) => PreviewApplied = () => "applied"
) => {
  const handed: number[] = [];
  const healths: PreviewHealth[] = [];
  const moved: number[] = [];
  const seen = { handed, health: healths, moved, resets: 0, asked: 0 };
  const updates = new PreviewUpdates(app, refreshAt(1), {
    fetch: async () => {
      const answer = answers[seen.asked];
      seen.asked += 1;
      if (answer === undefined) {
        throw new Error("Core was asked more than the test said.");
      }
      return await answer();
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
  const toFrame = async (part: PreviewPart): Promise<PreviewApplied> => {
    await Promise.resolve();
    if (part.part < part.parts - 1) {
      return "more";
    }
    seen.handed.push(part.revision);
    return frameSays(part);
  };
  return { updates, seen, toFrame };
};

const answered =
  (refresh: PreviewRefresh, of = app) =>
  async (): Promise<PreviewUpdate> =>
    await Promise.resolve({ app: of, refresh });

describe("a preview taking its draft's writes in the frame it has open", () => {
  it("hands the frame the screen it opened, then each newer revision, its calls following", async () => {
    const { updates, seen, toFrame } = following([answered(refreshAt(2))]);
    updates.follow(toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([2]);
    });
    expect(seen.handed).toStrictEqual([1, 2]);
  });

  it("asks for one update at a time, then only the newest the chat named meanwhile", async () => {
    const slow = Promise.withResolvers<PreviewUpdate>();
    const { updates, seen, toFrame } = following([
      async () => await slow.promise,
      answered(refreshAt(5)),
    ]);
    updates.follow(toFrame);
    updates.revise(2);
    updates.revise(3);
    updates.revise(4);
    updates.revise(5);
    slow.resolve({ app, refresh: refreshAt(2) });
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([2, 5]);
    });
    expect({ asked: seen.asked, handed: seen.handed }).toStrictEqual({
      asked: 2,
      handed: [1, 2, 5],
    });
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
      handed: [1],
      moved: [],
    });
  });

  it("keeps the last working version, saying it is being fixed, until a write fixes it", async () => {
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
      (part) => (part.revision === 3 ? "failed" : "applied")
    );
    updates.follow(toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(seen.health).toStrictEqual(["fixing"]);
    });
    updates.revise(3);
    await vi.waitFor(() => {
      expect(seen.handed).toStrictEqual([1, 3]);
    });
    const whileBroken = { health: [...seen.health], moved: [...seen.moved] };
    updates.revise(4);
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([4]);
    });
    expect({ whileBroken, health: seen.health }).toStrictEqual({
      whileBroken: { health: ["fixing"], moved: [] },
      health: ["fixing", "working"],
    });
  });

  it("files what the frame reports while it tries an update under that update's revision, and the rest under the one it shows", async () => {
    const reportedAt: number[] = [];
    const held: { updates?: PreviewUpdates } = {};
    const run = following([answered(refreshAt(2))], (part) => {
      // The frame reports the update's render error before it answers.
      reportedAt.push(held.updates?.runningAt() ?? -1);
      return part.revision === 2 ? "failed" : "applied";
    });
    const { updates } = run;
    held.updates = updates;
    const before = updates.runningAt();
    updates.follow(run.toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(run.seen.handed).toStrictEqual([1, 2]);
    });
    // Rolled back: what the frame meets now is the version it shows.
    expect({ before, reportedAt, after: updates.runningAt() }).toStrictEqual({
      before: 1,
      reportedAt: [1, 2],
      after: 1,
    });
  });

  it("asks again when another tab's ask took its place in core's line, rather than show an older write", async () => {
    const { updates, seen, toFrame } = following([
      async () =>
        await Promise.reject(appErrors.create("app.preview_superseded")),
      answered(refreshAt(2)),
    ]);
    updates.follow(toFrame);
    updates.revise(2);
    await vi.waitFor(() => {
      expect(seen.moved).toStrictEqual([2]);
    });
    expect(seen.asked).toBe(2);
  });

  it("asks again once a revision when frames take each other's place, never on and on while one build runs", async () => {
    // Core's line for one chat's preview of an App: one build running,
    // the newest ask waiting, the one it replaced refused.
    const held = Promise.withResolvers<null>();
    let running = false;
    let waiting: ((go: boolean) => void) | undefined;
    let asks = 0;
    const fetch = async (): Promise<PreviewUpdate> => {
      asks += 1;
      // Asked on and on: core out of reach from here, so the test ends,
      // and fails on the count, rather than spin.
      if (asks > 50) {
        held.resolve(null);
        throw new Error("Asked on and on.");
      }
      const first = !running && asks === 1;
      if (running) {
        waiting?.(false);
        const turn = Promise.withResolvers<boolean>();
        waiting = turn.resolve;
        if (!(await turn.promise)) {
          throw appErrors.create("app.preview_superseded");
        }
      }
      running = true;
      try {
        if (first) {
          await held.promise;
        }
        return { app, refresh: refreshAt(2) };
      } finally {
        // Its place goes to the one waiting, or is free.
        const waited = waiting;
        waiting = undefined;
        running = waited !== undefined;
        waited?.(true);
      }
    };
    const frames = Array.from({ length: 3 }, () => {
      const moved: number[] = [];
      const updates = new PreviewUpdates(app, refreshAt(1), {
        fetch,
        health: () => {},
        reset: () => {},
        moved: (revision) => {
          moved.push(revision);
        },
      });
      updates.follow(async (part) =>
        part.part < part.parts - 1
          ? await Promise.resolve("more")
          : await Promise.resolve("applied")
      );
      return { updates, moved };
    });
    // The first frame's build runs, held; the other two take each
    // other's place behind it.
    for (const { updates } of frames) {
      updates.revise(2);
    }
    for (let tick = 0; tick < 20; tick += 1) {
      // oxlint-disable-next-line no-await-in-loop -- lets every ask settle
      await wait(0);
    }
    const whileHeld = asks;
    held.resolve(null);
    await vi.waitFor(() => {
      expect(frames[0]?.moved).toStrictEqual([2]);
    });
    // Each frame asked once, and each of the two behind asked once more.
    expect(whileHeld).toBe(5);
  });

  it.each([
    ["renders nothing", "an empty render"],
    ["logs an error without throwing", "a console.error"],
  ])(
    "keeps saying a problem is being fixed when an update that %s is applied",
    async () => {
      const held: { updates?: PreviewUpdates } = {};
      const run = following([answered(refreshAt(2))], (part) => {
        // The frame reports what the update ran into before it answers
        // that it shows it.
        if (part.revision === 2) {
          held.updates?.problem();
        }
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
    const refreshGaveUp = following([answered(refreshAt(2))], (part) =>
      part.revision === 2 ? "reset" : "applied"
    );
    refreshGaveUp.updates.follow(refreshGaveUp.toFrame);
    refreshGaveUp.updates.revise(2);
    await vi.waitFor(() => {
      expect(
        [newKit, tooLarge, refreshGaveUp].map(({ seen }) => seen.resets)
      ).toStrictEqual([1, 1, 1]);
    });
    expect(
      [newKit, tooLarge, refreshGaveUp].map(({ seen }) => seen.handed)
    ).toStrictEqual([[1], [1], [1, 2]]);
  });

  it("counts every update a frame evaluated toward its reset, those that failed and the copy swapped back for each, not only those it took", async () => {
    const revisions = Array.from({ length: 64 }, (_, at) => at + 2);
    const { updates, seen, toFrame } = following(
      revisions.map((revision) => answered(refreshAt(revision))),
      (part) => (part.revision === 1 ? "applied" : "failed")
    );
    updates.follow(toFrame);
    for (const revision of revisions) {
      if (seen.resets > 0) {
        break;
      }
      updates.revise(revision);
      // Handed over, or the frame started afresh instead.
      // oxlint-disable-next-line no-await-in-loop -- one write after another
      await vi.waitFor(() => {
        expect(seen.handed.length + seen.resets).toBe(revision);
      });
    }
    // The screen it opened, then each broken write and the copy swapped
    // back for it: two a write, so the frame starts afresh before it holds
    // more modules than one frame may.
    const failedWrites = Math.floor(
      (platformLimits.previewResetRevisions - 1) / 2
    );
    expect({
      resets: seen.resets,
      handed: seen.handed.length,
    }).toStrictEqual({ resets: 1, handed: 1 + failedWrites });
  });

  it("hands a large module over in parts no longer than a part may be, the CSS once", () => {
    const parts = partsOf(
      refreshAt(2, { code: "x".repeat(previewPartChars * 2 + 1), css: "c" })
    );
    expect(
      parts.map(({ part, parts: of, code, css }) => ({
        part,
        of,
        chars: code.length,
        css,
      }))
    ).toStrictEqual([
      { part: 0, of: 3, chars: previewPartChars, css: "" },
      { part: 1, of: 3, chars: previewPartChars, css: "" },
      { part: 2, of: 3, chars: 1, css: "c" },
    ]);
  });
});
