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

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import { addSource } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { completeOwedErasures } from "../src/shared-reads.ts";
import { allEvents } from "./audit-events.ts";
import { chooseAudience } from "./brain-audiences.ts";
import { newTeam } from "./brain-next-leaks-harness.ts";
import { inStoreOf } from "./brain-next-out-reads.ts";
import {
  clockAt,
  connectSharedSites,
  finds,
  idp,
  later,
  markerOf,
  ownSourcesOnly,
  parkWorkerSources,
  pollMs,
  setUpTime,
  sitesHeld,
  syncOn,
} from "./brain-sync-world.ts";
import type { Person } from "./brain-sync-world.ts";
import { mockIdpWith } from "./idp.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";

mockIdpWith(idp);

// What native sync copies from the places an admin picked on a shared
// connection (brain-sync.ts, GRA-1719), through core's RPC, the real
// connect and its sample sync connector, with the provider mocked at its
// host (test/sample-sync-fake.ts); the shared world, fakes and clock are
// in test/brain-sync-world.ts. These start from the threat model on
// GRA-1719: a place's files, whose permissions aren't read, kept for
// whoever connected it; kept for anyone outside the connection's Brain
// audience, or at all while it is nobody; an un-picked place still read
// after the admin's save answered, or brought back by a listing that read
// the picks before; copies an admin's "Erase what the Brain kept" or a
// disconnect leaves; and another producer or connection writing for a
// place's group.

/** The sample connector's sync of picked places (its `sites`). */
const feed = "sites";

/** `admin` picks `places` on `connectionId`, from the picks held now. */
const pick = async (
  admin: Person,
  connectionId: string,
  places: string[]
): Promise<void> => {
  const held = await admin.api.connections.syncPlaces(connectionId);
  await admin.api.connections.pickSyncPlaces({
    connectionId,
    feed,
    from: held?.picks ?? [],
    places,
  });
};

/** How many of `connectionId`'s items the sync holds, by place. */
const heldBy = async (
  connectionId: string
): Promise<Record<string, number>> => {
  const { results } = await env.DB.prepare(
    "SELECT place, count(*) AS count FROM brain_sync_items WHERE connection_id = ? AND store = 'shared' GROUP BY place ORDER BY place"
  )
    .bind(connectionId)
    .all<{ place: string; count: number }>();
  return Object.fromEntries(results.map(({ place, count }) => [place, count]));
};

/** How many events the shared store holds. */
const eventsHeld = async (): Promise<number> =>
  await inStoreOf(
    "brain",
    (sql) =>
      sql.exec<{ count: number }>("SELECT count(*) AS count FROM events").one()
        .count
  );

/** One run of the sync as the clock does, a poll after the last, on `given`. */
const sync = async (given: Env = env): Promise<void> => {
  later(pollMs);
  await syncOn(given);
};

/** Runs the sync until the picked places are listed and read: the listing, then each place's page. */
const syncAll = async (given: Env = env): Promise<void> => {
  await sync(given);
  await sync(given);
};

describe("native sync of a shared connection's picked places", () => {
  beforeAll(parkWorkerSources, setUpTime.timeout);
  beforeEach(ownSourcesOnly);
  afterEach(() => {
    vi.useRealTimers();
  });

  it(
    "keeps a picked place for the connection's audience alone, never for whoever connected it, nothing while the audience is nobody, and no one's steps",
    setUpTime,
    async () => {
      const [admin, seller, outsider] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const sales = await newTeam(seller.userId);
      const [picked, unpicked] = [markerOf(), markerOf()];
      const site = `site-${unique()}`;
      const other = `site-${unique()}`;
      const { connectionId } = await connectSharedSites(admin, {
        [site]: picked,
        [other]: unpicked,
      });
      await pick(admin, connectionId, [site]);

      // Nobody may read it yet: nothing is read or kept.
      await syncAll();
      const whileNobody = await heldBy(connectionId);

      await chooseAudience(admin.api, connectionId, {
        kind: "team",
        teamId: sales,
      });
      const eventsBefore = await eventsHeld();
      await syncAll();

      expect({
        whileNobody,
        // A shared place's changes are no one person's steps: none kept.
        events: (await eventsHeld()) - eventsBefore,
        kept: await heldBy(connectionId),
        seller: [await finds(seller.userId, picked)],
        // Connected it, but not in the audience: its files aren't theirs.
        admin: await finds(admin.userId, picked),
        outsider: await finds(outsider.userId, picked),
        // Never picked: nobody's.
        unpicked: await finds(seller.userId, unpicked),
      }).toStrictEqual({
        whileNobody: {},
        events: 0,
        kept: { [site]: 1 },
        seller: [true],
        admin: false,
        outsider: false,
        unpicked: false,
      });
    }
  );

  it(
    "hides an un-picked place before the admin's save answers, and erases what it kept afterwards",
    setUpTime,
    async () => {
      const [admin, member] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const [first, second] = [markerOf(), markerOf()];
      const [one, two] = [`site-${unique()}`, `site-${unique()}`];
      const { connectionId } = await connectSharedSites(admin, {
        [one]: first,
        [two]: second,
      });
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      await pick(admin, connectionId, [one, two]);
      await syncAll();
      const before = [
        await finds(member.userId, first),
        await finds(member.userId, second),
      ];

      await pick(admin, connectionId, [two]);
      // As soon as the save answered: no run of the sync in between.
      const atSave = [
        await finds(member.userId, first),
        await finds(member.userId, second),
      ];
      await syncAll();

      expect({
        before,
        atSave,
        after: [
          await finds(member.userId, first),
          await finds(member.userId, second),
        ],
        kept: await heldBy(connectionId),
      }).toStrictEqual({
        before: [true, true],
        atSave: [false, true],
        after: [false, true],
        kept: { [two]: 1 },
      });
    }
  );

  it(
    "keeps nothing of a place un-picked while a listing that read it was under way",
    setUpTime,
    async () => {
      const [admin, member] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const [first, second] = [markerOf(), markerOf()];
      const [one, two] = [`site-${unique()}`, `site-${unique()}`];
      const { connectionId } = await connectSharedSites(admin, {
        [one]: first,
        [two]: second,
      });
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      await pick(admin, connectionId, [one, two]);
      await syncAll();
      const before = await finds(member.userId, first);

      // A listing is due again (the picks changed), and reads both places;
      // the admin un-picks the first between connect's answer and the
      // listing's write.
      await pick(admin, connectionId, [one, two, `site-${unique()}`]);
      let raced = false;
      const listSyncPlaces = async (request: {
        connectionId: string;
        feed: string;
        cursor: string | null;
      }) => {
        const answer = await env.CONNECT.listSyncPlaces(request);
        if (!raced && request.connectionId === connectionId) {
          raced = true;
          // The admin acts now, not at the run's clock, which other files
          // in the worker may have moved past their session's end.
          vi.useRealTimers();
          await pick(admin, connectionId, [two]);
          vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
        }
        return answer;
      };
      const racing = new Proxy(env.CONNECT, {
        get: (target, key) => {
          if (key === "listSyncPlaces") {
            return listSyncPlaces;
          }
          const value: unknown = Reflect.get(target, key);
          // An RPC stub's method, called on the stub: never its `bind`,
          // which the stub would take for a method of connect's.
          return typeof value === "function"
            ? (...args: unknown[]): unknown =>
                Reflect.apply(value, target, args)
            : value;
        },
      });
      await sync({ ...env, CONNECT: racing });
      const afterRace = await finds(member.userId, first);
      await syncAll();

      expect({
        raced,
        before,
        afterRace,
        after: await finds(member.userId, first),
        kept: await heldBy(connectionId),
      }).toStrictEqual({
        raced: true,
        before: true,
        afterRace: false,
        after: false,
        kept: { [two]: 1 },
      });
    }
  );

  it(
    "erases a shared connection's copies once it is disconnected, hidden from the drain on",
    setUpTime,
    async () => {
      const [admin, member] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const marker = markerOf();
      const site = `site-${unique()}`;
      const { connectionId } = await connectSharedSites(admin, {
        [site]: marker,
      });
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      await pick(admin, connectionId, [site]);
      await syncAll();
      const before = await finds(member.userId, marker);

      await admin.api.connections.disconnect(connectionId);
      await drainAuditOutboxes(env);
      const atDrain = await finds(member.userId, marker);
      await sync();
      const closed = await env.DB.prepare(
        "SELECT erasing, erased FROM brain_sync_disconnects WHERE connection_id = ?"
      )
        .bind(connectionId)
        .first<{ erasing: number; erased: number }>();

      expect({
        before,
        atDrain,
        after: await finds(member.userId, marker),
        kept: await heldBy(connectionId),
        closed,
      }).toStrictEqual({
        before: true,
        atDrain: false,
        after: false,
        kept: {},
        closed: { erasing: 0, erased: 1 },
      });
    }
  );

  it(
    'erases what a picked place synced with "Erase what the Brain kept", for good, and reads it again from nothing for the next audience',
    setUpTime,
    async () => {
      const [admin, member] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const [old, fresh] = [markerOf(), markerOf()];
      const site = `site-${unique()}`;
      const { connectionId, subject } = await connectSharedSites(admin, {
        [site]: old,
      });
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      await pick(admin, connectionId, [site]);
      await syncAll();
      const before = await finds(member.userId, old);
      // The file changes at the source meanwhile.
      await sitesHeld(subject, { [site]: fresh }, "2");

      await admin.api.connections.eraseBrainReads(connectionId);
      const atErase = await finds(member.userId, old);
      // The clock erases the copies, then ends the erasure.
      await sync();
      await completeOwedErasures(env);
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      // An audience again, before any run: no old copy is left to read.
      const atAudience = await finds(member.userId, old);
      await syncAll();
      const events = await allEvents();
      const erased = events.filter(
        ({ action, target }) =>
          action === "brain.shared_reads.erased" && target?.id === connectionId
      );
      const places = await admin.api.connections.syncPlaces(connectionId);

      expect({
        before,
        atErase,
        atAudience,
        after: {
          old: await finds(member.userId, old),
          fresh: await finds(member.userId, fresh),
        },
        stillPicked: places?.picks,
        erased: erased.map(({ detail }) => detail),
      }).toStrictEqual({
        before: true,
        atErase: false,
        atAudience: false,
        after: { old: false, fresh: true },
        stillPicked: [site],
        // The one copy synced; no agent read anything through it.
        erased: [{ sources: 1 }],
      });
    }
  );

  it(
    "reads a place again each time it is picked again after an un-pick erased it",
    setUpTime,
    async () => {
      const [admin, member] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const marker = markerOf();
      const site = `site-${unique()}`;
      const { connectionId } = await connectSharedSites(admin, {
        [site]: marker,
      });
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      const seen: boolean[] = [];
      for (let round = 0; round < 3; round += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one round after another
        await pick(admin, connectionId, [site]);
        // oxlint-disable-next-line no-await-in-loop -- one round after another
        await syncAll();
        // oxlint-disable-next-line no-await-in-loop -- one round after another
        seen.push(await finds(member.userId, marker));
        // oxlint-disable-next-line no-await-in-loop -- one round after another
        await pick(admin, connectionId, []);
        // oxlint-disable-next-line no-await-in-loop -- one round after another
        await syncAll();
      }
      expect(seen).toStrictEqual([true, true, true]);
    }
  );

  it("keeps a place's group for what native sync copies from that place of that connection alone", async () => {
    const [connectionId, other] = [
      `connection-${unique()}`,
      `connection-${unique()}`,
    ];
    const readers: SourceReaders = {
      kind: "place",
      connectionId,
      feed,
      place: "site-1",
    };
    const added = async (source: SourceRef): Promise<string> => {
      const answer = await outcome(
        addSource(env, {
          source,
          change: crypto.randomUUID(),
          text: `Plan ${markerOf()}`,
          readers,
        })
      );
      return answer.startsWith("Error: Refused:") ? "refused" : answer;
    };
    expect({
      synced: await added({
        producer: "sync",
        id: `${connectionId}/1/${unique()}`,
      }),
      otherConnection: await added({
        producer: "sync",
        id: `${other}/1/${unique()}`,
      }),
      connected: await added({
        producer: "connected",
        id: `${connectionId}/1/${unique()}`,
      }),
      upload: await added({ producer: "upload", id: unique() }),
    }).toStrictEqual({
      synced: "ok",
      otherConnection: "refused",
      connected: "refused",
      upload: "refused",
    });
  });
});
