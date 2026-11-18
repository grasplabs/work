import { minTeamShown } from "@grasp-os/shared/onboarding";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi, describe } from "vite-plus/test";

import { runSync } from "../src/brain-sync.ts";
import { newTeam } from "./brain-next-leaks-harness.ts";
import { inStoreOf } from "./brain-next-out-reads.ts";
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
  syncOn,
  commitStatement,
  sync,
} from "./brain-sync-world.ts";
import { interleaving } from "./d1-interleaving.ts";
import { signedInApi, signedInWithRole } from "./sign-in.ts";

/** A file in the sample feed at `version`. */
const file = (id: string, text: string, version: string) =>
  mailItem(id, text, { kind: "file", version });

// Native sync (src/brain-sync.ts, GRA-1758): the Brain's events of synced changes. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

describe("native sync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "keeps each synced change as one event for each of the owner's teams of five or more, two teammates' identical copies apart, once however often its page is applied",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const teammate = await signedInApi(idp, "user");
      const others = await Promise.all(
        Array.from({ length: minTeamShown - 2 }, async () => {
          const { userId } = await signedInWithRole(idp, "user");
          return userId;
        })
      );
      // Five with both of them, and four with the owner alone.
      const [five, four] = await Promise.all([
        newTeam(owner.userId, teammate.userId, ...others),
        newTeam(owner.userId, ...others),
      ]);
      const note = markerOf();
      // Each with a copy of the same file: same ID, title, text, version.
      const feed = {
        "": feedPage(
          [mailItem("note", `Note ${note}`, { kind: "file" })],
          "p1"
        ),
        p1: feedPage([], "p1"),
      };
      const connections = [
        await connectSampleFeed(owner, feed),
        await connectSampleFeed(teammate, feed),
      ];
      const eventsOf = async () =>
        await inStoreOf("brain", (sql) =>
          sql
            .exec<Record<string, SqlStorageValue>>(
              "SELECT team, step, system, writes, item FROM events WHERE team IN (?, ?) ORDER BY team, key",
              `team:${five}`,
              `team:${four}`
            )
            .toArray()
        );
      later(pollMs);
      await sync();
      const kept = await eventsOf();
      // The same pages applied again, from the start.
      for (const { connectionId } of connections) {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await env.DB.prepare(
          "UPDATE brain_sync_sources SET cursor = NULL WHERE connection_id = ?"
        )
          .bind(connectionId)
          .run();
      }
      later(pollMs);
      await sync();

      expect({
        kept: kept.map(({ team, step, system, writes }) => ({
          team,
          step,
          system,
          writes,
        })),
        itemNamed: kept.every(
          ({ item }) => typeof item === "string" && item !== "note"
        ),
        found: [
          await finds(owner.userId, note),
          await finds(teammate.userId, note),
        ],
        again: await eventsOf(),
      }).toStrictEqual({
        kept: [
          {
            team: `team:${five}`,
            step: "file.added",
            system: "microsoft",
            writes: 0,
          },
          {
            team: `team:${five}`,
            step: "file.added",
            system: "microsoft",
            writes: 0,
          },
        ],
        itemNamed: true,
        found: [true, true],
        again: kept,
      });
    }
  );

  it(
    "keeps a change as one event when the read that saved it stopped before its page's commit, and a relist of it adds none",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const others = await Promise.all(
        Array.from({ length: minTeamShown - 1 }, async () => {
          const { userId } = await signedInWithRole(idp, "user");
          return userId;
        })
      );
      const team = await newTeam(owner.userId, ...others);
      const note = markerOf();
      const { connectionId } = await connectSampleFeed(owner, {
        "": feedPage(
          [mailItem("note", `Note ${note}`, { kind: "file" })],
          "p1"
        ),
        p1: feedPage([], "p1"),
      });
      const stepsKept = async () =>
        await inStoreOf("brain", (sql) =>
          sql
            .exec<{ step: string }>(
              "SELECT step FROM events WHERE team = ?",
              `team:${team}`
            )
            .toArray()
            .map(({ step }) => step)
        );
      // The first read saves the file and stops before its commit.
      later(pollMs);
      await syncOn(
        interleaving(
          { pattern: commitStatement, bound: connectionId },
          async () => {
            await Promise.reject(new Error("Stopped before the commit"));
          }
        )
      );
      const stopped = await stepsKept();
      later(pollMs);
      await sync();
      const read = await stepsKept();
      // A day on, its relist reads it again.
      later(24 * 60 * 60 * 1000);
      await sync();
      later(pollMs);
      await sync();

      expect({
        stopped,
        read,
        relisted: await stepsKept(),
        found: await finds(owner.userId, note),
      }).toStrictEqual({
        stopped: [],
        read: ["file.added"],
        relisted: ["file.added"],
        found: true,
      });
    }
  );

  it(
    "keeps a change past a key's first version as one event when the read that saved it stopped before its commit, and takes none from another run's next page around the retry's commit, nor from a later page seeing it again",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const others = await Promise.all(
        Array.from({ length: minTeamShown - 1 }, async () => {
          const { userId } = await signedInWithRole(idp, "user");
          return userId;
        })
      );
      const team = await newTeam(owner.userId, ...others);
      const marks = {
        x: markerOf(),
        x2: markerOf(),
        y: markerOf(),
        y2: markerOf(),
      };
      const pages: Record<string, unknown> = {
        "": feedPage(
          [file("x", `X ${marks.x}`, "1"), file("y", `Y ${marks.y}`, "1")],
          "p1"
        ),
        p1: feedPage([], "p1"),
      };
      const { connectionId, post } = await connectSampleFeed(owner, pages);
      const stepsKept = async () =>
        await inStoreOf("brain", (sql) =>
          sql
            .exec<{ step: string }>(
              "SELECT step FROM events WHERE team = ? ORDER BY step",
              `team:${team}`
            )
            .toArray()
            .map(({ step }) => step)
        );
      later(pollMs);
      await sync();
      // x changes on the next page, y on the page after it.
      pages.p1 = {
        changes: [file("x", `X ${marks.x2}`, "2")],
        next: "p2",
        more: true,
      };
      pages.p2 = feedPage([file("y", `Y ${marks.y2}`, "2")], "p3");
      pages.p3 = feedPage([], "p3");
      await post(pages);
      // The first read of x's page saves its change and stops before its
      // commit.
      later(pollMs);
      await syncOn(
        interleaving(
          { pattern: commitStatement, bound: connectionId },
          async () => {
            await Promise.reject(new Error("Stopped before the commit"));
          }
        )
      );
      // Its retry commits, and another run reads the next page, saving y's
      // change, as soon as that commit lets the source go.
      later(pollMs);
      await syncOn(
        interleaving(
          { pattern: commitStatement, bound: connectionId },
          async () => {
            await Promise.resolve();
          },
          async () => {
            await runSync(env);
          }
        )
      );
      const retried = await stepsKept();
      // A later page names x again, as it now is.
      pages.p3 = feedPage([file("x", `X ${marks.x2}`, "2")], "p4");
      pages.p4 = feedPage([], "p4");
      await post(pages);
      later(pollMs);
      await sync();

      expect({
        retried,
        after: await stepsKept(),
        found: [
          await finds(owner.userId, marks.x2),
          await finds(owner.userId, marks.y2),
        ],
      }).toStrictEqual({
        retried: ["file.added", "file.added", "file.changed", "file.changed"],
        after: ["file.added", "file.added", "file.changed", "file.changed"],
        found: [true, true],
      });
    }
  );
});
