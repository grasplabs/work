import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi, describe } from "vite-plus/test";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { runSync } from "../src/brain-sync.ts";
import {
  idp,
  setUpTime,
  pollMs,
  markerOf,
  driveHolds,
  connectSampleFeed,
  mailItem,
  goneItem,
  feedPage,
  connectDrive,
  docFile,
  withDomain,
  finds,
  syncEvents,
  clockAt,
  later,
  syncOn,
  deleteItemsStatement,
  sync,
} from "./brain-sync-world.ts";
import { interleaving } from "./d1-interleaving.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { signedInApi } from "./sign-in.ts";

// Native sync (src/brain-sync.ts, GRA-1758): erasure: an erase a stopped run owed, a person's erasure, and a disconnect's erase. The shared world,
// fakes and clock are in test/brain-sync-world.ts.

describe("native sync", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "finishes an erase a stopped run owed, even while the provider fails every read",
    setUpTime,
    async () => {
      const owner = await signedInApi(idp, "user");
      const marker = markerOf();
      const { connectionId, post, world } = await connectSampleFeed(owner, {
        "": feedPage([mailItem("memo", `Memo ${marker}`)], "m1"),
        m1: feedPage([], "m1"),
      });
      later(pollMs);
      await sync();
      await post({
        "": feedPage([mailItem("memo", `Memo ${marker}`)], "m1"),
        m1: feedPage([goneItem("memo")], "m2"),
        m2: feedPage([], "m2"),
      });
      // Runs stopped at each step in turn, until one stops between the
      // removal's record and its erase: all at one time, so a source whose
      // page is done isn't due again, and each run's stop moves on by a call.
      // First in the file, so no other test's sources share these runs.
      let owed = false;
      later(pollMs);
      for (let left = 4; left < 80 && !owed; left += 1) {
        vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
        try {
          // oxlint-disable-next-line no-await-in-loop -- one run after another
          await runSync(env, { left });
        } finally {
          vi.useRealTimers();
        }
        // oxlint-disable-next-line no-await-in-loop -- read after each run
        const leaving = await env.DB.prepare(
          "SELECT count(*) AS count FROM brain_sync_items WHERE connection_id = ? AND leaving IS NOT NULL"
        )
          .bind(connectionId)
          .first<{ count: number }>();
        owed = (leaving?.count ?? 0) > 0;
      }
      const owedFound = await finds(owner.userId, marker);
      // The provider fails every read from now on.
      await world({ failing: ["files"] });
      later(pollMs);
      await sync();

      expect({
        owed,
        owedFound,
        after: await finds(owner.userId, marker),
      }).toStrictEqual({ owed: true, owedFound: true, after: false });
    }
  );

  it(
    "keeps nothing that names a person or their address past their erasure",
    setUpTime,
    async () => {
      const [admin, person] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "builder"),
      ]);
      const oid = String(person.person.oid);
      const email = `${oid}@acme.test`;
      const page = {
        changes: [
          mailItem("rota", `Rota ${markerOf()}`, {
            kind: "file",
            readers: [
              { kind: "account", id: oid },
              { kind: "tenant", id: acmeTenant },
            ],
          }),
          mailItem("note", `Note ${markerOf()}`),
        ],
        next: "n",
        more: false,
      };
      await connectSampleFeed(person, {
        "": page,
        n: { changes: [], next: "n", more: false },
      });
      later(pollMs);
      await sync();
      await admin.api.members.remove(person.userId);

      const erased = await admin.api.members.erase(
        person.userId,
        String(person.person.name)
      );
      const naming = await env.DB.prepare(
        `SELECT
          (SELECT count(*) FROM brain_sync_sources WHERE person_id = ?1 OR lower(account) = lower(?2) OR account = ?3)
          + (SELECT count(*) FROM brain_sync_items WHERE instr(lower(coalesce(change, '') || item_id || key || coalesce(part_of, '')), lower(?2)) > 0 OR instr(lower(coalesce(change, '') || item_id || key || coalesce(part_of, '')), lower(?3)) > 0 OR instr(item_id || key, ?1) > 0)
          AS count`
      )
        .bind(person.userId, email, oid)
        .first<{ count: number }>();

      expect({
        connect: erased.areas.find(({ area }) => area === "connect")?.state,
        naming: naming?.count,
      }).toStrictEqual({ connect: "complete", naming: 0 });
    }
  );

  it(
    "ends a disconnect's erase once, with one event, when a second run's erase overlaps it",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      await connectDrive(colleague);
      const [first, second] = [markerOf(), markerOf()];
      const { connectionId, subject, email } = await connectDrive(owner);
      await driveHolds(subject, {
        start: "80",
        owned: [
          docFile("first", email, { permissions: withDomain(email) }),
          docFile("second", email, { permissions: withDomain(email) }),
        ],
        changes: { "80": { changes: [], newStartPageToken: "80" } },
        contents: { first: `Plan ${first}`, second: `Plan ${second}` },
      });
      later(pollMs);
      await sync();
      await owner.api.connections.disconnect(connectionId);
      await drainAuditOutboxes(env);
      later(pollMs);
      await syncOn(
        interleaving(
          { pattern: deleteItemsStatement, bound: connectionId },
          async () => {
            await runSync(env);
          }
        )
      );
      later(pollMs);
      await sync();
      const events = await syncEvents(connectionId);

      expect({
        found: [
          await finds(colleague.userId, first),
          await finds(colleague.userId, second),
        ],
        erased: events.filter(({ action }) => action === "brain.sync.erased"),
      }).toStrictEqual({
        found: [false, false],
        erased: [{ action: "brain.sync.erased", detail: { sources: 2 } }],
      });
    }
  );

  it(
    "erases everything a connection synced once it is disconnected, its own and the shared store's",
    setUpTime,
    async () => {
      const [owner, colleague] = await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      await connectDrive(colleague);
      const [mine, everyones] = [markerOf(), markerOf()];
      const { connectionId, subject, email } = await connectDrive(owner);
      await driveHolds(subject, {
        start: "70",
        owned: [
          docFile("mine", email),
          docFile("everyones", email, { permissions: withDomain(email) }),
        ],
        changes: { "70": { changes: [], newStartPageToken: "70" } },
        contents: { mine: `Notes ${mine}`, everyones: `Guide ${everyones}` },
      });
      later(pollMs);
      await sync();
      const before = [
        await finds(owner.userId, mine),
        await finds(colleague.userId, everyones),
      ];

      await owner.api.connections.disconnect(connectionId);
      // connect's record of the disconnect drained: its own store's copies
      // erased at once.
      await drainAuditOutboxes(env);
      const atDrain = await finds(owner.userId, mine);
      later(pollMs);
      await sync();
      const erasedEvents = await syncEvents(connectionId);
      // Its event says who disconnected; nothing else keeps their ID.
      const naming = await env.DB.prepare(
        "SELECT count(*) AS count FROM brain_sync_disconnects WHERE instr(coalesce(actor, ''), ?) > 0"
      )
        .bind(owner.userId)
        .first<{ count: number }>();

      expect({
        before,
        atDrain,
        after: [
          await finds(owner.userId, mine),
          await finds(colleague.userId, everyones),
          await finds(owner.userId, everyones),
        ],
        erased: erasedEvents.filter(
          ({ action }) => action === "brain.sync.erased"
        ),
        naming: naming?.count,
      }).toStrictEqual({
        before: [true, true],
        atDrain: false,
        after: [false, false, false],
        erased: [{ action: "brain.sync.erased", detail: { sources: 2 } }],
        naming: 0,
      });
    }
  );
});
