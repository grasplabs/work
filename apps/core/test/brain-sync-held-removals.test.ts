import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import {
  idp,
  setUpTime,
  pollMs,
  markerOf,
  connectSampleFeed,
  mailItem,
  goneItem,
  feedPage,
  finds,
  later,
  sync,
  ownSourcesOnly,
  parkWorkerSources,
} from "./brain-sync-world.ts";
import { mockIdpWith } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

/** One more run of the sync, a poll later. */
const nextRun = async () => {
  later(pollMs);
  await sync();
};

mockIdpWith(idp);

// Native sync (src/brain-sync.ts, GRA-1758): held removals: a message moved between folders, one that comes back while its removal is held, and a hold that ends after a day. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

describe("native sync", () => {
  beforeAll(parkWorkerSources, setUpTime.timeout);
  beforeEach(ownSourcesOnly);
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "never loses a message moved between two folders for a run, read in either order, and lets a deleted one go",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { m: markerOf(), m2: markerOf(), m3: markerOf() };
      const message = (folder: string, name: keyof typeof marks) =>
        mailItem(`${folder}/${name}`, `Mail ${marks[name]}`);
      const quiet = { changes: [], next: "q", more: false };
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      // Folder pages by position, each step adding the next.
      const a: Record<string, unknown> = {
        "": feedPage(
          [message("a", "m"), message("a", "m2"), message("a", "m3")],
          "a1"
        ),
        a1: feedPage([], "a1"),
      };
      const b: Record<string, unknown> = {
        "": feedPage([], "b1"),
        b1: feedPage([], "b1"),
      };
      const set = async (failing: string[]) => {
        await world({
          places: ["a", "b"],
          folders: { a: { changes: a }, b: { changes: b } },
          failing,
        });
      };
      await set([]);
      later(pollMs);
      await sync();
      /** Whether the owner reads each message now, after one more run. */
      const run = async () => {
        later(pollMs);
        await sync();
        return {
          m: await finds(owner.userId, marks.m),
          m2: await finds(owner.userId, marks.m2),
          m3: await finds(owner.userId, marks.m3),
        };
      };
      const seen: Record<string, unknown>[] = [];
      // Moved from a to b, a read first: b fails (backing off) meanwhile.
      a.a1 = feedPage([goneItem("a/m")], "a2");
      a.a2 = feedPage([], "a2");
      b.b1 = feedPage([message("b", "m")], "b2");
      b.b2 = feedPage([], "b2");
      await set(["b"]);
      seen.push(await run());
      await set([]);
      seen.push(await run(), await run());
      // Moved from a to b again, b read first: a fails meanwhile.
      a.a2 = feedPage([goneItem("a/m2")], "a3");
      a.a3 = feedPage([], "a3");
      b.b2 = feedPage([message("b", "m2")], "b3");
      b.b3 = feedPage([], "b3");
      await set(["a"]);
      seen.push(await run());
      await set([]);
      seen.push(await run(), await run());
      // Deleted for good from a, nothing new anywhere.
      a.a3 = feedPage([goneItem("a/m3")], "a4");
      a.a4 = feedPage([], "a4");
      await set([]);
      const held = await run();
      const later1 = await run();
      const later2 = await run();

      expect({
        moved: seen.map(({ m, m2 }) => ({ m, m2 })),
        deleted: [held.m3, later2.m3],
        stillThere: [later1.m, later1.m2],
      }).toStrictEqual({
        moved: [
          { m: true, m2: true },
          { m: true, m2: true },
          { m: true, m2: true },
          { m: true, m2: true },
          { m: true, m2: true },
          { m: true, m2: true },
        ],
        deleted: [true, false],
        stillThere: [true, true],
      });
    }
  );

  it(
    "keeps a message that comes back as it was while its removal is held, in the place it left or in another, read in either order",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { m1: markerOf(), m2: markerOf(), m3: markerOf() };
      // One ID wherever the message is, as a provider with stable IDs
      // gives it.
      const message = (name: keyof typeof marks) =>
        mailItem(name, `Mail ${marks[name]}`);
      const quiet = { changes: [], next: "q", more: false };
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const a: Record<string, unknown> = {
        "": feedPage([message("m1"), message("m2"), message("m3")], "a1"),
        a1: feedPage([], "a1"),
      };
      const b: Record<string, unknown> = {
        "": feedPage([], "b1"),
        b1: feedPage([], "b1"),
      };
      const set = async (failing: string[]) => {
        await world({
          places: ["a", "b"],
          folders: { a: { changes: a }, b: { changes: b } },
          failing,
        });
      };
      await set([]);
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const found = async () => ({
        m1: await finds(owner.userId, marks.m1),
        m2: await finds(owner.userId, marks.m2),
        m3: await finds(owner.userId, marks.m3),
      });
      // m1 and m2 go from a, b failing: both held.
      a.a1 = feedPage([goneItem("m1"), goneItem("m2")], "a2");
      a.a2 = feedPage([], "a2");
      await set(["b"]);
      await nextRun();
      // m1 comes back to a as it was, while b still fails; then b comes
      // back with m2 as it was, which ends every hold.
      a.a2 = feedPage([message("m1")], "a3");
      a.a3 = feedPage([], "a3");
      b.b1 = feedPage([message("m2")], "b2");
      b.b2 = feedPage([], "b2");
      await nextRun();
      await set([]);
      await nextRun();
      await nextRun();
      await nextRun();
      const returned = await found();
      // m3 moves from a to b, b read first: a fails meanwhile, then names
      // it gone.
      b.b2 = feedPage([message("m3")], "b3");
      b.b3 = feedPage([], "b3");
      await set(["a"]);
      await nextRun();
      a.a3 = feedPage([goneItem("m3")], "a4");
      a.a4 = feedPage([], "a4");
      await set([]);
      await nextRun();
      await nextRun();
      await nextRun();

      expect({ returned, after: await found() }).toStrictEqual({
        returned: { m1: true, m2: true, m3: true },
        after: { m1: true, m2: true, m3: true },
      });
    }
  );

  it(
    "lets a held removal go after a day when another folder never catches up",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marker = markerOf();
      const quiet = feedPage([], "q");
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const a: Record<string, unknown> = {
        "": feedPage([mailItem("a/m", `Mail ${marker}`)], "a1"),
        a1: feedPage([], "a1"),
      };
      const b = { "": feedPage([], "b1"), b1: feedPage([], "b1") };
      await world({
        places: ["a", "b"],
        folders: { a: { changes: a }, b: { changes: b } },
        failing: [],
      });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      // Gone from a; b fails from now on and never reads again.
      a.a1 = feedPage([goneItem("a/m")], "a2");
      a.a2 = feedPage([], "a2");
      await world({
        folders: { a: { changes: a }, b: { changes: b } },
        failing: ["b"],
      });
      later(pollMs);
      await sync();
      const held = await finds(owner.userId, marker);
      later(24 * 60 * 60 * 1000 + pollMs);
      await sync();

      expect({ held, after: await finds(owner.userId, marker) }).toStrictEqual({
        held: true,
        after: false,
      });
    }
  );
});
