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
  feedPage,
  finds,
  later,
  sync,
  ownSourcesOnly,
  parkWorkerSources,
} from "./brain-sync-world.ts";
import { mockIdpWith } from "./idp.ts";
import { signedInApi } from "./sign-in.ts";

const day = async () => {
  later(24 * 60 * 60 * 1000);
  for (let run = 0; run < 5; run += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one run after another
    await sync();
    later(pollMs);
  }
};

/** An item named by a names-only listing: its ID and version, no content. */
const named = (id: string, version = "1") => mailItem(id, null, { version });

mockIdpWith(idp);

// Native sync (src/brain-sync.ts, GRA-1758): names-only relists and their catch-ups by ID, and attachments across them. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

describe("native sync", () => {
  beforeAll(parkWorkerSources, setUpTime.timeout);
  beforeEach(ownSourcesOnly);
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "fetches by ID only what an answer covers: asks again what a partial answer left, and ends the day's catch-up when an answer covers none of it",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = { x: markerOf(), y: markerOf(), z: markerOf() };
      const quiet = { changes: [], next: "q", more: false };
      const { world, fetchedOf } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      await world({
        places: ["a", "b"],
        folders: {
          // Answers by ID, one at a time.
          a: {
            changes: {
              "": feedPage([mailItem("a/x", `Mail ${marks.x}`)], "c1"),
              c1: feedPage([], "c1"),
            },
            names: {
              "": feedPage([named("a/x"), named("a/y"), named("a/z")], "n"),
            },
            items: {
              "a/y": mailItem("a/y", `Mail ${marks.y}`),
              "a/z": mailItem("a/z", `Mail ${marks.z}`),
            },
            itemsMax: 1,
          },
          // Reads no IDs, and passes its messages over: its listing names
          // `b/later` on a second page, which an ID read never reaches.
          b: {
            changes: {
              "": {
                changes: [named("b/first")],
                next: "p2",
                more: true,
              },
              p2: feedPage([named("b/later")], "p2"),
            },
            ignores: true,
          },
        },
      });
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      await day();
      const askedFirstDay = await fetchedOf("b");
      await day();

      expect({
        a: await fetchedOf("a"),
        found: [
          await finds(owner.userId, marks.y),
          await finds(owner.userId, marks.z),
        ],
        // Within a day, never again once an answer covers nothing; still
        // owed the next day.
        bFirstDay: askedFirstDay,
        b: await fetchedOf("b"),
      }).toStrictEqual({
        a: [["a/y", "a/z"], ["a/z"]],
        found: [true, true],
        // Neither held (passed over from the start): both asked; its first
        // page covers `b/first`, so `b/later` is asked again, covered by
        // nothing, and left owed until the next day's.
        bFirstDay: [["b/first", "b/later"], ["b/later"]],
        b: [
          ["b/first", "b/later"],
          ["b/later"],
          ["b/first", "b/later"],
          ["b/later"],
        ],
      });
    }
  );

  it(
    "keeps a message's attachments across the daily names-only pass, takes them with a message that went, and drops one the message no longer has",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = {
        message: markerOf(),
        first: markerOf(),
        second: markerOf(),
        went: markerOf(),
        wentFile: markerOf(),
      };
      const quiet = { changes: [], next: "q", more: false };
      const { world } = await connectSampleFeed(owner, { "": quiet, q: quiet });
      const message = (version: string) =>
        mailItem("a/m", `Mail ${marks.message}`, { version });
      const first = mailItem("a/m/1", `File ${marks.first}`, {
        partOf: "a/m",
      });
      const second = mailItem("a/m/2", `File ${marks.second}`, {
        partOf: "a/m",
      });
      const changes: Record<string, unknown> = {
        "": feedPage(
          [
            message("1"),
            first,
            second,
            mailItem("a/x", `Gone ${marks.went}`),
            mailItem("a/x/1", `File ${marks.wentFile}`, { partOf: "a/x" }),
          ],
          "c1"
        ),
        c1: feedPage([], "c1"),
      };
      const set = async () => {
        await world({
          places: ["a"],
          folders: {
            a: {
              changes,
              // The list call names the message alone, as a mailbox's
              // does: no attachment, and not the message that went.
              names: {
                "": feedPage([mailItem("a/m", null, { version: "1" })], "n"),
              },
              items: {},
            },
          },
        });
      };
      await set();
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const found = async () => ({
        message: await finds(owner.userId, marks.message),
        first: await finds(owner.userId, marks.first),
        second: await finds(owner.userId, marks.second),
        went: await finds(owner.userId, marks.went),
        wentFile: await finds(owner.userId, marks.wentFile),
      });
      const before = await found();
      // A day on: the names-only relist, and runs after it.
      later(24 * 60 * 60 * 1000);
      await sync();
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();
      const relisted = await found();
      // The message read in full again, without its second attachment.
      changes.c1 = feedPage([message("2"), first], "c2");
      changes.c2 = feedPage([], "c2");
      await set();
      later(pollMs);
      await sync();

      expect({ before, relisted, reread: await found() }).toStrictEqual({
        before: {
          message: true,
          first: true,
          second: true,
          went: true,
          wentFile: true,
        },
        relisted: {
          message: true,
          first: true,
          second: true,
          went: false,
          wentFile: false,
        },
        reread: {
          message: true,
          first: true,
          second: false,
          went: false,
          wentFile: false,
        },
      });
    }
  );

  it(
    "relists mail by names once a day: keeps what it holds, fetches what changed or is new once, and takes out what went",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = {
        kept: markerOf(),
        changed: markerOf(),
        changedNow: markerOf(),
        unknown: markerOf(),
        went: markerOf(),
      };
      const quiet = { changes: [], next: "q", more: false };
      const { world, fetchedOf } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      const changes = {
        "": {
          changes: [
            mailItem("a/kept", `Kept ${marks.kept}`),
            mailItem("a/changed", `Draft ${marks.changed}`),
            mailItem("a/went", `Gone ${marks.went}`),
          ],
          next: "c1",
          more: false,
        },
        c1: { changes: [], next: "c1", more: false },
      };
      await world({
        places: ["a"],
        folders: {
          a: {
            changes,
            // A names-only listing: what is there, by ID and version.
            names: {
              "": {
                changes: [
                  named("a/kept"),
                  named("a/changed", "2"),
                  named("a/unknown"),
                ],
                next: "n",
                more: false,
              },
            },
            items: {
              "a/changed": mailItem("a/changed", `Final ${marks.changedNow}`, {
                version: "2",
              }),
              "a/unknown": mailItem("a/unknown", `Late ${marks.unknown}`),
            },
          },
        },
      });
      later(pollMs);
      await sync();
      const before = await finds(owner.userId, marks.kept);
      // A day on: the relist, its catch-up, and a run after it.
      later(24 * 60 * 60 * 1000);
      await sync();
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();

      expect({
        before,
        kept: await finds(owner.userId, marks.kept),
        changed: await finds(owner.userId, marks.changedNow),
        unknown: await finds(owner.userId, marks.unknown),
        went: await finds(owner.userId, marks.went),
        fetched: await fetchedOf("a"),
      }).toStrictEqual({
        before: true,
        kept: true,
        changed: true,
        unknown: true,
        went: false,
        // Only what it didn't hold at the version named, once.
        fetched: [["a/changed", "a/unknown"]],
      });
    }
  );
});
