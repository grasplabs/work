import { env } from "cloudflare:workers";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

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
  clockAt,
  later,
  sync,
  ownSourcesOnly,
  parkWorkerSources,
} from "./brain-sync-world.ts";
import { mockIdpWith } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

const folderOf = (id: string, text: string) => ({
  changes: {
    "": { changes: [mailItem(id, text)], next: "f1", more: false },
    f1: { changes: [], next: "f1", more: false },
  },
});

mockIdpWith(idp);

// Native sync (src/brain-sync.ts, GRA-1758): the places a sync lists: folders made and deleted, a listing started over, and the listings as queued work. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

describe("native sync", () => {
  beforeAll(parkWorkerSources, setUpTime.timeout);
  beforeEach(ownSourcesOnly);
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "keeps one source per listed place: a new one from no cursor, a dropped one's copies erased, a failed listing changing nothing",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const [inboxed, archived] = [markerOf(), markerOf()];
      const quiet = { changes: [], next: "q", more: false };
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const folders = {
        inbox: folderOf("inbox/a", `Invoice ${inboxed}`),
        archive: folderOf("archive/b", `Contract ${archived}`),
      };
      await world({ places: ["inbox"], folders });
      later(pollMs);
      await sync();
      const first = [
        await finds(owner.userId, inboxed),
        await finds(owner.userId, archived),
      ];
      // A folder made since: seen at the next listing of the folders, a
      // day on (`relistMs`), a new source read from the start.
      await world({ places: ["inbox", "archive"] });
      later(24 * 60 * 60 * 1000);
      await sync();
      later(pollMs);
      await sync();
      const added = await finds(owner.userId, archived);
      // The folders couldn't be listed at the next day's listing: nothing
      // changes.
      await world({ places: null });
      later(24 * 60 * 60 * 1000);
      await sync();
      const failed = [
        await finds(owner.userId, inboxed),
        await finds(owner.userId, archived),
      ];
      // The folder deleted: the listing, tried again at the next run, drops
      // its source, and the clock erases every copy it made.
      await world({ places: ["inbox"] });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();

      expect({
        first,
        added,
        failed,
        dropped: [
          await finds(owner.userId, inboxed),
          await finds(owner.userId, archived),
        ],
      }).toStrictEqual({
        first: [true, false],
        added: true,
        failed: [true, true],
        dropped: [true, false],
      });
    }
  );

  it(
    "lists the folders again from the start when the connector no longer knows the listing's position, dropping nothing for the abandoned one",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { a: markerOf(), b: markerOf(), c: markerOf() };
      const quiet = feedPage([], "q");
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const folder = (name: keyof typeof marks) => ({
        changes: {
          "": feedPage([mailItem(`${name}/x`, `Mail ${marks[name]}`)], "f1"),
          f1: feedPage([], "f1"),
        },
      });
      const folders = { a: folder("a"), b: folder("b"), c: folder("c") };
      // The folders listed over two reads.
      await world({
        placePages: {
          "": { folders: ["a"], next: "t1" },
          t1: { folders: ["b"] },
        },
        folders,
      });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const first = [
        await finds(owner.userId, marks.a),
        await finds(owner.userId, marks.b),
      ];
      // A day on, the listing gets partway and then the folder list's
      // position is gone: the connector answers "restart".
      await world({
        placePages: { "": { folders: ["a"], next: "t2" } },
      });
      later(24 * 60 * 60 * 1000);
      await sync();
      const abandoned = [
        await finds(owner.userId, marks.a),
        await finds(owner.userId, marks.b),
      ];
      // The next run lists from the start, and finishes: c made, b gone.
      await world({ placePages: { "": { folders: ["a", "c"] } } });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();

      expect({
        first,
        abandoned,
        after: [
          await finds(owner.userId, marks.a),
          await finds(owner.userId, marks.b),
          await finds(owner.userId, marks.c),
        ],
      }).toStrictEqual({
        first: [true, true],
        abandoned: [true, true],
        after: [true, false, true],
      });
    }
  );

  it(
    "lists mailboxes' folders as work in the queue: removals keep their turn, and every mailbox gets its folders",
    setUpTime,
    async () => {
      // A person whose note goes away: a removal waiting for its page.
      const remover = await signedInApi(idp, "user");
      const note = markerOf();
      const removing = await connectSampleFeed(remover, {
        "": feedPage([mailItem("note", `Note ${note}`)], "n1"),
        n1: feedPage([], "n1"),
      });
      later(pollMs);
      await sync();
      // Many mailboxes whose folders are still to be listed.
      const mailboxes = await Promise.all(
        Array.from({ length: 8 }, async () => await signedInApi(idp, "user"))
      );
      const markers = mailboxes.map(() => markerOf());
      for (const [index, mailbox] of mailboxes.entries()) {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        const { world } = await connectSampleFeed(mailbox, {
          "": feedPage([], "q"),
          q: feedPage([], "q"),
        });
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await world({
          places: ["inbox"],
          folders: {
            inbox: {
              changes: {
                "": feedPage(
                  [mailItem("inbox/x", `Mail ${markers[index] ?? ""}`)],
                  "i1"
                ),
                i1: feedPage([], "i1"),
              },
            },
          },
        });
      }
      await removing.post({
        "": feedPage([mailItem("note", `Note ${note}`)], "n1"),
        n1: feedPage([goneItem("note")], "n2"),
        n2: feedPage([], "n2"),
      });
      // Runs with room for the run's own four calls, one call for each sync
      // that lists places, and one mail item's page more (claim, read, rows,
      // the item's key, its add in its owner's store, its record, the
      // commit: 10): listing every mailbox's folders ahead of the pages on
      // every run would leave less than one item's page, for good.
      const listings = await env.DB.prepare(
        "SELECT count(*) AS count FROM brain_sync_sources WHERE place = ':places'"
      ).first<{ count: number }>();
      const left =
        4 + Math.max(listings?.count ?? 0, mailboxes.length) + 10 - 1;
      let removedAt: number | undefined;
      let listedAt: number | undefined;
      for (let run = 0; run < 120 && listedAt === undefined; run += 1) {
        later(pollMs);
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one run after another, as the clock runs them
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
        // oxlint-disable-next-line no-await-in-loop -- read after each run
        if (removedAt === undefined && !(await finds(remover.userId, note))) {
          removedAt = run;
        }
        // oxlint-disable-next-line no-await-in-loop -- read after each run
        const found = await Promise.all(
          mailboxes.map(
            async (mailbox, index) =>
              await finds(mailbox.userId, markers[index] ?? "")
          )
        );
        if (found.every(Boolean)) {
          listedAt = run;
        }
      }

      expect({
        removed: removedAt !== undefined && removedAt < 60,
        listed: listedAt !== undefined,
      }).toStrictEqual({ removed: true, listed: true });
    }
  );
});
