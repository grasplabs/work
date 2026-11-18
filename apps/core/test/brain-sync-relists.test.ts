import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi, describe } from "vite-plus/test";

import { overdueRelists, runSync } from "../src/brain-sync.ts";
import {
  idp,
  setUpTime,
  pollMs,
  markerOf,
  driveHolds,
  connectSampleFeed,
  mailItem,
  feedPage,
  connectDrive,
  docFile,
  withDomain,
  finds,
  clockAt,
  later,
  sync,
} from "./brain-sync-world.ts";
import { signedInApi } from "./sign-in.ts";

// Native sync (src/brain-sync.ts, GRA-1758): daily relists: a reader removed at the source, a restart, an overdue relist, and a connector that reads no names or IDs. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

describe("native sync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "takes away a reader removed with no change in the feed, and a file gone the same way, at the daily relist",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      await connectDrive(colleague);
      const { subject, email } = await connectDrive(owner);
      const [quiet, vanished] = [markerOf(), markerOf()];
      const contents = {
        quiet: `Pay scales ${quiet}`,
        vanished: `Pitch ${vanished}`,
      };
      const feed = { "80": { changes: [], newStartPageToken: "80" } };
      await driveHolds(subject, {
        start: "80",
        owned: [
          docFile("quiet", email, { permissions: withDomain(email) }),
          docFile("vanished", email),
        ],
        changes: feed,
        contents,
      });
      later(pollMs);
      await sync();
      const before = [
        await finds(colleague.userId, quiet),
        await finds(owner.userId, vanished),
      ];
      // Unshared and deleted at the source, and the feed says nothing.
      await driveHolds(subject, {
        start: "80",
        owned: [docFile("quiet", email)],
        changes: feed,
        contents,
      });
      later(pollMs);
      await sync();
      const noSignal = [
        await finds(colleague.userId, quiet),
        await finds(owner.userId, vanished),
      ];
      // A day on: the relist has read every file and its readers again.
      later(24 * 60 * 60 * 1000);
      await sync();

      expect({
        before,
        noSignal,
        relisted: [
          await finds(colleague.userId, quiet),
          await finds(owner.userId, vanished),
          await finds(owner.userId, quiet),
        ],
      }).toStrictEqual({
        before: [true, true],
        noSignal: [true, true],
        relisted: [false, false, true],
      });
    }
  );

  it(
    "finishes the daily relist after a restart in it, while changes go on applying",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const { subject, email } = await connectDrive(owner);
      const [vanished, added] = [markerOf(), markerOf()];
      const contents = {
        vanished: `Pitch ${vanished}`,
        added: `Memo ${added}`,
      };
      await driveHolds(subject, {
        start: "100",
        owned: [docFile("vanished", email)],
        changes: { "100": { changes: [], newStartPageToken: "100" } },
        contents,
      });
      later(pollMs);
      await sync();
      // Deleted with no signal, which only the relist's end takes out; and
      // the relist's own change feed (from "R") is lost to it once, so it
      // starts again.
      await driveHolds(subject, {
        start: "R",
        owned: [],
        changes: { "100": { changes: [], newStartPageToken: "100" } },
        contents,
      });
      later(24 * 60 * 60 * 1000);
      await sync();
      const afterRestart = await finds(owner.userId, vanished);
      // A change arrives on the ordinary feed meanwhile, and the relist's
      // feed is there again.
      await driveHolds(subject, {
        start: "R",
        owned: [],
        changes: {
          "100": {
            changes: [
              {
                fileId: "added",
                time: "2026-11-13T09:00:00.000Z",
                file: docFile("added", email),
              },
            ],
            newStartPageToken: "101",
          },
          "101": { changes: [], newStartPageToken: "101" },
          R: { changes: [], newStartPageToken: "R" },
        },
        contents,
      });
      later(pollMs);
      await sync();

      expect({
        afterRestart,
        relisted: await finds(owner.userId, vanished),
        change: await finds(owner.userId, added),
      }).toStrictEqual({ afterRestart: true, relisted: false, change: true });
    }
  );

  it(
    "finishes an overdue relist when changes alone would fill every run, and says it is overdue",
    setUpTime,
    async () => {
      const [owner, ...others] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      for (const other of others) {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await connectDrive(other);
      }
      const { connectionId, subject, email } = await connectDrive(owner);
      const vanished = markerOf();
      const feed = { "110": { changes: [], newStartPageToken: "110" } };
      await driveHolds(subject, {
        start: "110",
        owned: [docFile("vanished", email)],
        changes: feed,
        contents: { vanished: `Pitch ${vanished}` },
      });
      later(pollMs);
      await sync();
      // Deleted with no signal: only the relist's end takes it out.
      await driveHolds(subject, {
        start: "110",
        owned: [],
        changes: feed,
        contents: {},
      });
      // Two days on, its relist past its day.
      later(2 * 24 * 60 * 60 * 1000);
      vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
      const overdue = await overdueRelists(env);
      vi.useRealTimers();
      const warned: unknown[] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation((...line) => {
        warned.push(line);
      });
      // Runs a call short of reading every source's changes (claim, read,
      // commit each, after the run's own three), a minute apart, until the
      // relist ends: far within its day.
      const sources = await env.DB.prepare(
        "SELECT count(*) AS count FROM brain_sync_sources"
      ).first<{ count: number }>();
      const left = 3 + 3 * (sources?.count ?? 0) - 1;
      let minutes = 0;
      try {
        for (; minutes < 240; minutes += 1) {
          later(pollMs);
          vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
          try {
            // oxlint-disable-next-line no-await-in-loop -- one run after another, as the clock runs them
            await runSync(env, { left });
          } finally {
            vi.useRealTimers();
          }
          // oxlint-disable-next-line no-await-in-loop -- read after each run
          if (!(await finds(owner.userId, vanished))) {
            break;
          }
        }
      } finally {
        spy.mockRestore();
      }

      expect({
        overdue: overdue > 0,
        said: JSON.stringify(warned).includes("brain.sync.relist_overdue"),
        saidOf: JSON.stringify(warned).includes(connectionId),
        relisted: await finds(owner.userId, vanished),
        withinItsDay: minutes < 240,
      }).toStrictEqual({
        overdue: true,
        said: true,
        saidOf: true,
        relisted: false,
        withinItsDay: true,
      });
    }
  );

  it(
    "after a restart, takes out what the relist no longer names",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const { subject, email } = await connectDrive(owner);
      const [kept, gone] = [markerOf(), markerOf()];
      const contents = { kept: `Contract ${kept}`, gone: `Draft ${gone}` };
      await driveHolds(subject, {
        start: "40",
        owned: [docFile("kept", email), docFile("gone", email)],
        changes: { "40": { changes: [], newStartPageToken: "40" } },
        contents,
      });
      later(pollMs);
      await sync();
      const before = [
        await finds(owner.userId, kept),
        await finds(owner.userId, gone),
      ];

      // Google lost the cursor (404), and the file went while it was lost:
      // the relist names it nowhere, and no change says it went.
      await driveHolds(subject, {
        start: "50",
        owned: [docFile("kept", email)],
        changes: { "50": { changes: [], newStartPageToken: "50" } },
        contents,
      });
      // The run that meets the lost cursor, then the one that lists again.
      later(pollMs);
      await sync();
      later(pollMs);
      await sync();

      expect({
        before,
        after: [
          await finds(owner.userId, kept),
          await finds(owner.userId, gone),
        ],
      }).toStrictEqual({ before: [true, true], after: [true, false] });
    }
  );

  it(
    "relists mail in full from a connector that reads no names or IDs: refreshes what changed past its first page, and asks nothing by ID",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marks = {
        kept: markerOf(),
        draft: markerOf(),
        final: markerOf(),
        went: markerOf(),
      };
      const quiet = { changes: [], next: "q", more: false };
      const { world, fetchedOf } = await connectSampleFeed(owner, {
        "": quiet,
        q: quiet,
      });
      const changes: Record<string, unknown> = {
        "": feedPage(
          [
            mailItem("a/kept", `Kept ${marks.kept}`),
            mailItem("a/changed", `Draft ${marks.draft}`),
            mailItem("a/went", `Gone ${marks.went}`),
          ],
          "c1"
        ),
        c1: feedPage([], "c1"),
      };
      const set = async () => {
        await world({
          places: ["a"],
          folders: { a: { changes, ignores: true } },
        });
      };
      await set();
      later(pollMs);
      await sync();
      // The mailbox's listing now: two pages, the change on the second,
      // the message that went in neither.
      changes[""] = {
        changes: [mailItem("a/kept", `Kept ${marks.kept}`)],
        next: "p2",
        more: true,
      };
      changes.p2 = feedPage(
        [mailItem("a/changed", `Final ${marks.final}`, { version: "2" })],
        "c1"
      );
      await set();
      later(24 * 60 * 60 * 1000);
      for (let run = 0; run < 4; run += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one run after another
        await sync();
        later(pollMs);
      }

      expect({
        kept: await finds(owner.userId, marks.kept),
        draft: await finds(owner.userId, marks.draft),
        final: await finds(owner.userId, marks.final),
        went: await finds(owner.userId, marks.went),
        askedById: await fetchedOf("a"),
      }).toStrictEqual({
        kept: true,
        draft: false,
        final: true,
        went: false,
        askedById: [],
      });
    }
  );
});
