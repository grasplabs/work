import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi, describe } from "vite-plus/test";

import { runSync } from "../src/brain-sync.ts";
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
  syncOn,
  overlappingRun,
  holdStatement,
  claimStatement,
  takeKeysStatement,
  deleteItemsStatement,
  listFoldersNow,
  placeGoneStatement,
  leaveStatement,
  sync,
} from "./brain-sync-world.ts";
import { interleaving } from "./d1-interleaving.ts";
import { signedInApi } from "./sign-in.ts";

const runs = async (count: number) => {
  for (let run = 0; run < count; run += 1) {
    later(pollMs);
    // oxlint-disable-next-line no-await-in-loop -- one run after another
    await sync();
  }
};

/** a dropped, then listed again with its old message and a new one while its erase stands at `pattern`. */
const restoredDuring = async (pattern: RegExp, secondErase: boolean) => {
  const owner = await signedInApi(idp, "user");
  const marks = { old: markerOf(), fresh: markerOf() };
  const quiet = { changes: [], next: "q", more: false };
  const { connectionId, world } = await connectSampleFeed(owner, {
    "": quiet,
    q: quiet,
  });
  const a: Record<string, unknown> = {
    "": feedPage([mailItem("a/old", `Mail ${marks.old}`)], "a1"),
    a1: feedPage([], "a1"),
  };
  const b = { "": feedPage([], "b1"), b1: feedPage([], "b1") };
  const set = async (places: string[]) => {
    await world({
      places,
      folders: { a: { changes: a }, b: { changes: b } },
    });
  };
  await set(["a", "b"]);
  later(pollMs);
  await sync();
  later(pollMs);
  await sync();
  // a deleted: its daily listing drops it.
  await set(["b"]);
  await listFoldersNow(connectionId);
  later(pollMs);
  await sync();
  // a comes back, with its old message and a new one, while the next
  // run erases it.
  a[""] = feedPage(
    [
      mailItem("a/old", `Mail ${marks.old}`),
      mailItem("a/fresh", `Mail ${marks.fresh}`),
    ],
    "a1"
  );
  later(pollMs);
  await syncOn(
    interleaving({ pattern, bound: connectionId }, async () => {
      if (secondErase) {
        await runSync(env);
      }
      await set(["a", "b"]);
      await listFoldersNow(connectionId);
      await runSync(env);
      await runSync(env);
    })
  );
  for (let run = 0; run < 3; run += 1) {
    later(pollMs);
    // oxlint-disable-next-line no-await-in-loop -- one run after another
    await sync();
  }
  return [
    await finds(owner.userId, marks.old),
    await finds(owner.userId, marks.fresh),
  ];
};

// Native sync (src/brain-sync.ts, GRA-1758): the fence every write carries: a folder's writes against another folder's, against a drop, and an erase against a restore. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

describe("native sync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "leaves a message another folder brought back between a folder's read of its removal and the hold, the held removal's end, or a relist's sweep",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = {
        held: markerOf(),
        finished: markerOf(),
        swept: markerOf(),
        kept: markerOf(),
      };
      // One ID wherever the message is.
      const message = (name: keyof typeof marks) =>
        mailItem(name, `Mail ${marks[name]}`);
      const quiet = { changes: [], next: "q", more: false };
      const { connectionId, world } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      const a: Record<string, unknown> = {
        "": feedPage(
          [
            message("held"),
            message("finished"),
            message("swept"),
            message("kept"),
          ],
          "a1"
        ),
        a1: feedPage([], "a1"),
      };
      const b: Record<string, unknown> = {
        "": feedPage([], "b1"),
        b1: feedPage([], "b1"),
      };
      // The daily names-only listings: a names only `kept`, b what it has.
      const aNames = { "": feedPage([mailItem("kept", null)], "n") };
      const bNames: Record<string, unknown> = { "": feedPage([], "n") };
      const set = async (failing: string[] = []) => {
        await world({
          places: ["a", "b"],
          folders: {
            a: { changes: a, names: aNames, items: {} },
            b: { changes: b, names: bNames, items: {} },
          },
          failing,
        });
      };
      await set();
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const found = async () => ({
        held: await finds(owner.userId, marks.held),
        finished: await finds(owner.userId, marks.finished),
        swept: await finds(owner.userId, marks.swept),
        kept: await finds(owner.userId, marks.kept),
      });
      /**
       * b has `name` from its next read on, as a move into it does: once in
       * its changes, at the position its cursor is at, and in its listings.
       */
      const inB: string[] = [];
      let bAt = 1;
      const intoB = async (name: keyof typeof marks) => {
        inB.push(name);
        b[`b${bAt}`] = feedPage([message(name)], `b${bAt + 1}`);
        bAt += 1;
        b[`b${bAt}`] = feedPage([], `b${bAt}`);
        bNames[""] = feedPage(
          inB.map((id) => mailItem(id, null)),
          "n"
        );
        await set();
      };

      // a reads `held` gone; b brings it over before a's hold lands (a is
      // read first: both are due at once).
      a.a1 = feedPage([goneItem("held")], "a2");
      a.a2 = feedPage([], "a2");
      await set();
      later(pollMs);
      await syncOn(
        interleaving(
          { pattern: holdStatement, bound: connectionId },
          async () => {
            await intoB("held");
            await overlappingRun();
          }
        )
      );
      await runs(4);
      const afterHold = await finds(owner.userId, marks.held);

      // a reads `finished` gone while b fails: held. b comes back empty,
      // which ends the hold; b brings it over before a's end of it lands.
      a.a2 = feedPage([goneItem("finished")], "a3");
      a.a3 = feedPage([], "a3");
      await set(["b"]);
      await runs(1);
      await set();
      await runs(1);
      later(pollMs);
      await syncOn(
        interleaving(
          { pattern: leaveStatement, bound: connectionId },
          async () => {
            await intoB("finished");
            await overlappingRun();
          }
        )
      );
      await runs(3);
      const afterFinish = await finds(owner.userId, marks.finished);

      // A day on, a's names-only relist doesn't name `swept`; b (failing
      // until then) brings it over before a's sweep takes it out.
      await set(["b"]);
      later(24 * 60 * 60 * 1000);
      await syncOn(
        interleaving(
          { pattern: leaveStatement, bound: connectionId },
          async () => {
            await intoB("swept");
            await overlappingRun();
          }
        )
      );
      await runs(3);

      expect({ afterHold, afterFinish, end: await found() }).toStrictEqual({
        afterHold: true,
        afterFinish: true,
        end: { held: true, finished: true, swept: true, kept: true },
      });
    }
  );

  it(
    "keeps nothing of a folder dropped while a page of it is under way, the drop landing between the page's read and its claim and the erase ending after it",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { old: markerOf(), late: markerOf(), other: markerOf() };
      const quiet = { changes: [], next: "q", more: false };
      const { connectionId, world } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      const a: Record<string, unknown> = {
        "": feedPage([mailItem("a/old", `Mail ${marks.old}`)], "a1"),
        a1: feedPage([], "a1"),
      };
      const b = {
        "": feedPage([mailItem("b/other", `Mail ${marks.other}`)], "b1"),
        b1: feedPage([], "b1"),
      };
      const set = async (places: string[]) => {
        await world({
          places,
          folders: { a: { changes: a }, b: { changes: b } },
        });
      };
      await set(["a", "b"]);
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      // a's next page brings `late`; the folder is deleted meanwhile.
      a.a1 = feedPage([mailItem("a/late", `Mail ${marks.late}`)], "a2");
      a.a2 = feedPage([], "a2");
      await set(["b"]);
      // The page may claim once the erase has found nothing left; the
      // erase goes on once the claim has run.
      const claimMay = Promise.withResolvers<null>();
      const claimDone = Promise.withResolvers<null>();
      let erasing: Promise<void> = Promise.resolve();
      later(pollMs);
      await syncOn(
        interleaving(
          { pattern: claimStatement, bound: connectionId },
          async () => {
            // The folder list read without a, as its daily listing does:
            // a dropped.
            await env.DB.prepare(
              "UPDATE brain_sync_sources SET due_at = 0 WHERE connection_id = ? AND place = ':places'"
            )
              .bind(connectionId)
              .run();
            await runSync(env);
            // a's erase, up to its last step: the page's claim lands
            // after it found nothing left, before it deletes the source.
            erasing = runSync(
              interleaving(
                { pattern: placeGoneStatement, bound: connectionId },
                async () => {
                  claimMay.resolve(null);
                  await claimDone.promise;
                }
              )
            ).finally(() => {
              claimMay.resolve(null);
            });
            await claimMay.promise;
          },
          () => {
            claimDone.resolve(null);
          }
        )
      );
      await erasing;
      for (let run = 0; run < 3; run += 1) {
        later(pollMs);
        // oxlint-disable-next-line no-await-in-loop -- one run after another
        await sync();
      }
      const { results } = await env.DB.prepare(
        "SELECT count(*) AS count FROM brain_sync_items WHERE connection_id = ? AND place = 'a'"
      )
        .bind(connectionId)
        .all<{ count: number }>();

      expect({
        late: await finds(owner.userId, marks.late),
        old: await finds(owner.userId, marks.old),
        other: await finds(owner.userId, marks.other),
        rowsOfA: results[0]?.count,
      }).toStrictEqual({ late: false, old: false, other: true, rowsOfA: 0 });
    }
  );

  it(
    "keeps a folder listed again while its erase is under way: what it brings back stays, whether the erase stood at its keys or between its pages, and a second erase waits",
    setUpTime,
    async () => {
      expect({
        // The review's order: another run's erase of the same folder, then
        // the folder listed again and read, between the erase's read of
        // its rows and its taking their keys.
        atItsKeys: await restoredDuring(takeKeysStatement, true),
        // Its page read again between two pages of the erase.
        betweenPages: await restoredDuring(deleteItemsStatement, false),
      }).toStrictEqual({ atItsKeys: [true, true], betweenPages: [true, true] });
    }
  );
});
