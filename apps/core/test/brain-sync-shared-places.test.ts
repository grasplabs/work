import { recallBudgetMax } from "@grasp-os/brain-next/contract";
import { sha256Hex } from "@grasp-os/shared/encoding";
import type { Identity } from "@grasp-os/shared/rpc";
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
import { z } from "zod";

import { drainAuditOutboxes } from "../src/audit-drains.ts";
import {
  addSource,
  placeGroupOf,
  recallAs,
  workBrain,
} from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { syncForStaff } from "../src/brain-sync.ts";
import { personOf } from "../src/connections.ts";
import { completeOwedErasures } from "../src/shared-reads.ts";
import { plainPrincipalOf } from "../src/source-readers.ts";
import { pickSyncPlaces } from "../src/sync-picks.ts";
import { allEvents } from "./audit-events.ts";
import { chooseAudience } from "./brain-audiences.ts";
import { newTeam } from "./brain-next-leaks-harness.ts";
import { inStoreOf } from "./brain-next-out-reads.ts";
import {
  claimStatement,
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
  siteChanged,
  sitesFailing,
  sitesHeld,
  sitesHeldWith,
  syncOn,
} from "./brain-sync-world.ts";
import type { Person } from "./brain-sync-world.ts";
import { interleaving } from "./d1-interleaving.ts";
import { mockIdpWith } from "./idp.ts";
import { answeringProvider } from "./model-provider.ts";
import { noProducers } from "./no-producers.ts";
import { acmeTenant } from "./sign-in-config.ts";
import { outcome, signedInApi, unique } from "./sign-in.ts";
import { connectDb, testBinding } from "./test-env.ts";

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

/** Everyone in the company's tenant, as core names a source's reader. */
const tenantReader = {
  kind: "tenant" as const,
  provider: "microsoft" as const,
  tenant: acmeTenant,
};

/** Everyone in the company's tenant, as core names a source's readers. */
const everyoneInTenant = [tenantReader];

/** `person`'s own Microsoft account, as a synced item's readers name it. */
const accountAtSource = (person: Person) => ({
  kind: "account",
  id: String(person.person.oid),
});

/** An un-pick's hide taking the sync's places listing (brain-sync.ts `droppedExcept`). */
const takeListingStatement =
  /^update "brain_sync_sources" set "lease_id" = \?, "lease_until" = \?, "picks_version"/u;

/** The end of an erasure of a connection's records (shared-reads.ts `ended`). */
const erasureEndStatement =
  /^update "connection_brain_erasures" set "erasing" = \?/u;

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

/** Runs `queries` on core's database, in one batch. */
const run = async (queries: readonly string[]): Promise<void> => {
  await env.DB.batch(queries.map((query) => env.DB.prepare(query)));
};

/** One run of the sync as the clock does, a poll after the last, on `given`. */
const sync = async (given: Env = env): Promise<void> => {
  later(pollMs);
  await syncOn(given);
};

/** The Brain's clock: one tick of its work, as core's clock runs it. */
const brainTick = async (): Promise<void> => {
  later(pollMs);
  await workBrain(env, new Date(clockAt()), noProducers);
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
    "gives a picked place's file only to those its source lets read it, within the audience, and never to code reading for a team",
    setUpTime,
    async () => {
      const [admin, seller, colleague, outsider] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const sales = await newTeam(seller.userId, colleague.userId);
      const [shared, unread] = [markerOf(), markerOf()];
      const [site, other] = [`site-${unique()}`, `site-${unique()}`];
      // At the source, the seller and the outsider may open the file;
      // the colleague may not.
      const { connectionId } = await connectSharedSites(
        admin,
        { [site]: shared },
        [accountAtSource(seller), accountAtSource(outsider)]
      );
      // A file whose readers couldn't be read.
      const { connectionId: unreadId } = await connectSharedSites(
        admin,
        { [other]: unread },
        null
      );
      for (const [id, place] of [
        [connectionId, site],
        [unreadId, other],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await chooseAudience(admin.api, id, { kind: "team", teamId: sales });
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await pick(admin, id, [place]);
      }
      await syncAll();
      const { items } = await recallAs(env, seller.userId, {
        personal: false,
        question: shared,
        budget: { tokens: recallBudgetMax },
      });

      expect({
        kept: [await heldBy(connectionId), await heldBy(unreadId)],
        // In the audience and a reader at the source.
        seller: await finds(seller.userId, shared),
        // In the audience, not a reader at the source.
        colleague: await finds(colleague.userId, shared),
        // A reader at the source, not in the audience.
        outsider: await finds(outsider.userId, shared),
        admin: await finds(admin.userId, shared),
        // Read as the seller's teams, as code acting for them does.
        forTheTeam: items.some(({ text }) => text.includes(shared)),
        // Its readers unread: nobody's, the audience's neither.
        unread: [
          await finds(seller.userId, unread),
          await finds(colleague.userId, unread),
        ],
      }).toStrictEqual({
        kept: [{ [site]: 1 }, { [other]: 1 }],
        seller: true,
        colleague: false,
        outsider: false,
        admin: false,
        forTheTeam: false,
        unread: [false, false],
      });
    }
  );

  it(
    "keeps two places apart: a reader at the source of one reads nothing of the other, nor of a place whose audience leaves them out",
    setUpTime,
    async () => {
      const [admin, seller, colleague] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const sales = await newTeam(seller.userId);
      const others = await newTeam(colleague.userId);
      const [a, b, c] = [markerOf(), markerOf(), markerOf()];
      const [siteA, siteB, siteC] = [
        `site-${unique()}`,
        `site-${unique()}`,
        `site-${unique()}`,
      ];
      // One connection for everyone: the seller may open A at the source,
      // the colleague B.
      const { connectionId, subject } = await connectSharedSites(admin, {
        [siteA]: a,
        [siteB]: b,
      });
      await sitesHeldWith(subject, {
        [siteA]: { text: `Plan ${a}`, readers: [accountAtSource(seller)] },
        [siteB]: { text: `Plan ${b}`, readers: [accountAtSource(colleague)] },
      });
      // Another, for a team the seller isn't in: the seller may open C at
      // the source too.
      const { connectionId: otherId } = await connectSharedSites(
        admin,
        { [siteC]: c },
        [accountAtSource(seller), accountAtSource(colleague)]
      );
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      await chooseAudience(admin.api, otherId, {
        kind: "team",
        teamId: others,
      });
      await pick(admin, connectionId, [siteA, siteB]);
      await pick(admin, otherId, [siteC]);
      await syncAll();

      expect({
        seller: [
          await finds(seller.userId, a),
          await finds(seller.userId, b),
          await finds(seller.userId, c),
        ],
        colleague: [
          await finds(colleague.userId, a),
          await finds(colleague.userId, b),
          await finds(colleague.userId, c),
        ],
        sales: sales !== others,
      }).toStrictEqual({
        seller: [true, false, false],
        colleague: [false, true, true],
        sales: true,
      });
    }
  );

  it(
    "keeps a file's pairs before the Brain is given its readers: one left behind by a reader taken off gives nothing, one missing hides the file",
    setUpTime,
    async () => {
      const [admin, seller, colleague] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const marker = markerOf();
      const site = `site-${unique()}`;
      const both = [accountAtSource(seller), accountAtSource(colleague)];
      const { connectionId, subject } = await connectSharedSites(
        admin,
        { [site]: marker },
        both
      );
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      await pick(admin, connectionId, [site]);
      await syncAll();
      const before = [
        await finds(seller.userId, marker),
        await finds(colleague.userId, marker),
      ];
      // At the source, the file is taken from the colleague.
      await siteChanged(subject, site, `Plan ${marker}`, [
        both,
        [accountAtSource(seller)],
      ]);
      await sync();
      const pairsOf = async (): Promise<number> => {
        const row = await env.DB.prepare(
          "SELECT count(*) AS count FROM source_reader_pairs WHERE place LIKE ?"
        )
          .bind(`connection:${connectionId}/%`)
          .first<{ count: number }>();
        return row?.count ?? 0;
      };
      const takenOff = {
        pairs: await pairsOf(),
        seller: await finds(seller.userId, marker),
        colleague: await finds(colleague.userId, marker),
      };
      // Without its pairs, nobody holds the file's readers.
      await env.DB.prepare("DELETE FROM source_reader_pairs WHERE place LIKE ?")
        .bind(`connection:${connectionId}/%`)
        .run();

      expect({
        before,
        takenOff,
        withoutPairs: await finds(seller.userId, marker),
      }).toStrictEqual({
        before: [true, true],
        // The colleague's pair stays, and gives them nothing.
        takenOff: { pairs: 2, seller: true, colleague: false },
        withoutPairs: false,
      });
    }
  );

  it(
    "finds nothing at the next read once the audience narrows between two reads",
    setUpTime,
    async () => {
      const [admin, seller] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const sales = await newTeam(seller.userId);
      const marker = markerOf();
      const site = `site-${unique()}`;
      const { connectionId } = await connectSharedSites(admin, {
        [site]: marker,
      });
      await chooseAudience(admin.api, connectionId, {
        kind: "team",
        teamId: sales,
      });
      await pick(admin, connectionId, [site]);
      await syncAll();
      const before = await finds(seller.userId, marker);
      // No run of the sync in between.
      await chooseAudience(admin.api, connectionId, { kind: "nobody" });

      expect({
        before,
        after: await finds(seller.userId, marker),
      }).toStrictEqual({ before: true, after: false });
    }
  );

  it(
    "draws a file's memories for those its source lets read it, for one it lets in later, and hides them from one it takes off",
    setUpTime,
    async () => {
      const [admin, seller, colleague] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
      const name = `Acme${unique().replaceAll("-", "").slice(0, 12)}`;
      const text = `Plan for ${name}: we renew the contract in March.`;
      const statement = `${name} renews in March.`;
      const provider = await answeringProvider((requests) => {
        const body = JSON.stringify(requests.at(-1)?.body);
        return {
          text: body.includes("You check statements")
            ? JSON.stringify({ supported: [0] })
            : JSON.stringify({
                entities: [{ key: "c", kind: "customer", names: [name] }],
                memories: [
                  {
                    about: "c",
                    type: "fact",
                    statement,
                    quote: "we renew the contract in March",
                  },
                ],
              }),
          inputTokens: 50,
          outputTokens: 20,
        };
      });
      const site = `site-${unique()}`;
      const sellerOnly = [accountAtSource(seller)];
      const { connectionId, subject } = await connectSharedSites(
        admin,
        { [site]: name },
        sellerOnly
      );
      await siteChanged(subject, site, text, [
        sellerOnly,
        [...sellerOnly, accountAtSource(colleague)],
        sellerOnly,
      ]);
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      await pick(admin, connectionId, [site]);
      // Ticks the Brain until it has drawn from the file `times` times
      // (two calls each: the read and its check). Other files share its
      // queue, so not a fixed number of ticks.
      const drawn = async (times: number, ticks = 20): Promise<void> => {
        const calls = provider.requests.filter(({ body }) =>
          JSON.stringify(body).includes(name)
        ).length;
        if (calls < times * 2 && ticks > 0) {
          await brainTick();
          await drawn(times, ticks - 1);
        }
      };
      // The listing and its first page alone: the colleague may not read
      // it yet.
      await sync();
      await drawn(1);
      const memoriesOf = async (personId: string): Promise<string[]> => {
        const pack = await recallAs(env, personId, {
          personal: true,
          question: `${name} renews`,
          budget: { tokens: recallBudgetMax },
        });
        return pack.memories.map(({ statement: said }) => said);
      };
      const first = {
        seller: await memoriesOf(seller.userId),
        colleague: await memoriesOf(colleague.userId),
      };
      // The source lets the colleague in: the new version is drawn again,
      // for them too.
      await sync();
      await drawn(2);
      const widened = await memoriesOf(colleague.userId);
      // The source takes the colleague off again: what was drawn for them
      // is hidden at once, with no drawing.
      await sync();

      expect({
        first,
        widened,
        narrowed: {
          seller: await memoriesOf(seller.userId),
          colleague: await memoriesOf(colleague.userId),
        },
      }).toStrictEqual({
        first: { seller: [statement], colleague: [] },
        widened: [statement],
        narrowed: { seller: [statement], colleague: [] },
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
    "shows staff a shared connection's sync as any other, and a failing place it un-picks leaves the view",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const [one, two] = [`site-${unique()}`, `site-${unique()}`];
      const { connectionId, subject } = await connectSharedSites(admin, {
        [one]: markerOf(),
        [two]: markerOf(),
      });
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      await pick(admin, connectionId, [one, two]);
      await syncAll();
      // The second place's reads fail from now on.
      await sitesFailing(subject, [two]);
      await sync();
      const hashed = await sha256Hex(connectionId);
      const hash = hashed.slice(0, 12);
      const rowOf = async () => {
        const { connections } = await syncForStaff(env);
        const row = connections.find(({ connection }) => connection === hash);
        return row === undefined
          ? undefined
          : {
              provider: row.provider,
              feed: row.feed,
              items: row.items,
              failing: row.failing,
              error: row.error?.code ?? null,
            };
      };
      const failing = await rowOf();

      await pick(admin, connectionId, [one]);
      const unpicked = await rowOf();
      await sync();

      expect({ failing, unpicked, erased: await rowOf() }).toStrictEqual({
        failing: {
          provider: "microsoft",
          feed,
          items: 2,
          failing: true,
          error: "sync.provider_failed",
        },
        // Dropped at the save: read no more, so neither failing nor late.
        unpicked: {
          provider: "microsoft",
          feed,
          items: 2,
          failing: false,
          error: null,
        },
        erased: {
          provider: "microsoft",
          feed,
          items: 1,
          failing: false,
          error: null,
        },
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
      // A step of the erasure before the sync run has erased the copies:
      // still under way, so no audience can be chosen yet.
      await completeOwedErasures(env);
      const beforeCopiesErased = await outcome(
        chooseAudience(admin.api, connectionId, { kind: "everyone" })
      );
      // The run erases the copies; the erasure's next step ends it.
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
        beforeCopiesErased,
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
        beforeCopiesErased: "connection.brain_erasing",
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

  it(
    "keeps nothing more of a page under way once its connection's audience goes to nobody, or an erase of its records starts, before its next item",
    setUpTime,
    async () => {
      const [admin, seller] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const sales = await newTeam(seller.userId);
      /**
       * A place picked on a new connection for `sales`, its page read by a
       * run while `change` lands just before the page claims its item: what
       * the sync holds of it after that run.
       */
      const keptAfter = async (
        change: (connectionId: string) => Promise<void>
      ): Promise<Record<string, number>> => {
        const site = `site-${unique()}`;
        const { connectionId } = await connectSharedSites(admin, {
          [site]: markerOf(),
        });
        await chooseAudience(admin.api, connectionId, {
          kind: "team",
          teamId: sales,
        });
        await pick(admin, connectionId, [site]);
        // The run lists the place, then reads its page: the change lands
        // as that page claims its item.
        later(pollMs);
        await syncOn(
          interleaving(
            { pattern: claimStatement, bound: connectionId },
            async () => {
              // The admin acts now, not at the run's clock, which other
              // files in the worker may have moved past their session's end.
              vi.useRealTimers();
              await change(connectionId);
              vi.useFakeTimers({ toFake: ["Date"], now: clockAt() });
            }
          )
        );
        return await heldBy(connectionId);
      };
      expect({
        toNobody: await keptAfter(async (connectionId) => {
          await chooseAudience(admin.api, connectionId, { kind: "nobody" });
        }),
        erased: await keptAfter(async (connectionId) => {
          await admin.api.connections.eraseBrainReads(connectionId);
        }),
      }).toStrictEqual({ toNobody: {}, erased: {} });
    }
  );

  it(
    "never drops a place a newer save picks when an older save's hide lands after it",
    setUpTime,
    async () => {
      const [one, two, member] = await Promise.all([
        signedInApi(idp, "admin"),
        signedInApi(idp, "admin"),
        signedInApi(idp, "user"),
      ]);
      const [a, b] = [`site-${unique()}`, `site-${unique()}`];
      const kept = markerOf();
      const { connectionId } = await connectSharedSites(one, {
        [a]: markerOf(),
        [b]: kept,
      });
      await chooseAudience(one.api, connectionId, { kind: "everyone" });
      await pick(one, connectionId, [a, b]);
      await syncAll();
      const before = await finds(member.userId, kept);
      const identity: Identity = {
        userId: one.userId,
        email: String(one.person.email),
        name: "Admin",
        role: "admin",
        teams: [],
        staff: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      // The first admin saves `a` alone; between connect's save and its
      // hide, the second admin picks `a` and `b` again, hide and all.
      let landed = false;
      await pickSyncPlaces(
        interleaving(
          { pattern: takeListingStatement, bound: connectionId },
          async () => {
            landed = true;
            await pick(two, connectionId, [a, b]);
          }
        ),
        identity,
        async () => await personOf(env, identity),
        { connectionId, feed, from: [a, b], places: [a] }
      );
      const atSave = await finds(member.userId, kept);
      await syncAll();

      expect({
        landed,
        before,
        atSave,
        after: await finds(member.userId, kept),
        kept: await heldBy(connectionId),
      }).toStrictEqual({
        landed: true,
        before: true,
        atSave: true,
        after: true,
        kept: { [a]: 1, [b]: 1 },
      });
    }
  );

  it(
    "reports in its end every copy an erase erased, one the sync erased as the erasure ended included",
    setUpTime,
    async () => {
      const admin = await signedInApi(idp, "admin");
      const site = `site-${unique()}`;
      const { connectionId } = await connectSharedSites(admin, {
        [site]: markerOf(),
      });
      await chooseAudience(admin.api, connectionId, { kind: "everyone" });
      await pick(admin, connectionId, [site]);
      await syncAll();
      await admin.api.connections.eraseBrainReads(connectionId);
      // The step that ends the erasure reads it, then the sync run erases
      // its last copy, and counts it, just before that end lands.
      await completeOwedErasures(
        interleaving(
          { pattern: erasureEndStatement, bound: connectionId },
          async () => {
            await sync();
          }
        )
      );
      const events = await allEvents();

      expect({
        kept: await heldBy(connectionId),
        erased: events
          .filter(
            ({ action, target }) =>
              action === "brain.shared_reads.erased" &&
              target?.id === connectionId
          )
          .map(({ detail }) => detail),
      }).toStrictEqual({ kept: {}, erased: [{ sources: 1 }] });
    }
  );

  it("still reads a reader's own, the company's and what their provider groups are given, and all but the last places, when their audiences hold more picked places than a reader can", async () => {
    const reader = await signedInApi(idp, "user");
    // A Microsoft group of the reader's, as their own connection's latest
    // read of their groups names it (source-readers.ts `heldPrincipalsOf`).
    const providerGroup = crypto.randomUUID();
    const connectedAt = Date.now();
    await connectDb()
      .prepare(
        "INSERT INTO connections (id, provider, scope, owner_user_id, status, server_kind, server, tenant, account_id, reader_groups, reader_groups_at, created_at, updated_at) VALUES (?, 'microsoft', 'personal', ?, 'active', 'native', 'microsoft-365', ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        crypto.randomUUID(),
        reader.userId,
        acmeTenant,
        String(reader.person.oid),
        JSON.stringify([providerGroup]),
        connectedAt,
        connectedAt,
        connectedAt
      )
      .run();
    const word = markerOf();
    // Two connections everyone may read, kept in the reverse of their
    // order by ID, so only an ordered read holds the first one's places
    // first (connection-audiences.ts `audiencesRead`).
    const [first, last] = [`0-${unique()}`, `~-${unique()}`];
    const perConnection = 600;
    const placesOf = (connectionId: string) =>
      Array.from(
        { length: perConnection },
        (_, index) =>
          `${connectionId.slice(0, 1)}${String(index).padStart(4, "0")}`
      );
    const now = Date.now();
    const neverDue = Date.parse("2100-01-01T00:00:00.000Z");
    /** `source`, holding `marker`, for `readers`. */
    const add = async (
      source: SourceRef,
      readers: SourceReaders,
      marker: string
    ): Promise<void> => {
      await addSource(env, {
        source,
        change: crypto.randomUUID(),
        text: `Price list ${word} ${marker}`,
        readers,
      });
    };
    try {
      for (const connectionId of [last, first]) {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO connection_brain_audiences (connection_id, team_id, changed_by, changed_at) VALUES (?, NULL, ?, ?)"
          ).bind(connectionId, reader.userId, now),
          env.DB.prepare(
            "INSERT INTO brain_sync_sources (connection_id, feed, place, person_id, provider, tenant, account, cursor, listing, listing_open, due_at, lease_id, lease_until, last_success_at, last_error, added, changed, removed, relist_cursor, relisting, relist_at, relist_since, leaves_owed, kind, dropped, relist_catch_up, seen_in) SELECT ?, 'sites', value, NULL, 'microsoft', NULL, NULL, NULL, 1, 0, ?, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, 0, ?, NULL, 0, 'file', 0, 0, NULL FROM json_each(?)"
          ).bind(
            connectionId,
            neverDue,
            neverDue,
            JSON.stringify(placesOf(connectionId))
          ),
        ]);
      }
      // Each place's items name everyone in the tenant, the reader among
      // them, as kept items' pairs (source-readers.ts `readerPrincipalsOf`):
      // the reader holds one pair a place, more than a reader can hold.
      const tenant = plainPrincipalOf(tenantReader);
      const pairs = await Promise.all(
        [first, last].flatMap((connectionId) =>
          placesOf(connectionId).map(async (place) => [
            await placeGroupOf(connectionId, feed, place),
            tenant,
          ])
        )
      );
      await env.DB.prepare(
        "INSERT INTO source_reader_pairs (place, principal) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?) WHERE true ON CONFLICT DO NOTHING"
      )
        .bind(JSON.stringify(pairs))
        .run();
      const marks = {
        own: markerOf(),
        company: markerOf(),
        group: markerOf(),
        firstsLast: markerOf(),
        lastsFirst: markerOf(),
        lastsLast: markerOf(),
      };
      await add(
        { producer: "upload", id: unique() },
        { kind: "owner", personId: reader.userId },
        marks.own
      );
      await add(
        { producer: "upload", id: unique() },
        { kind: "everyone" },
        marks.company
      );
      // Shared at its source with that group of theirs (GRA-1761).
      await add(
        { producer: "upload", id: unique() },
        {
          kind: "readers",
          readers: [
            {
              kind: "group",
              provider: "microsoft",
              tenant: acmeTenant,
              group: providerGroup,
            },
          ],
        },
        marks.group
      );
      const placeCopy = async (
        connectionId: string,
        place: string,
        marker: string
      ) => {
        await add(
          { producer: "sync", id: `${connectionId}/1/${unique()}` },
          {
            kind: "place",
            connectionId,
            feed,
            place,
            readers: everyoneInTenant,
          },
          marker
        );
      };
      await placeCopy(first, placesOf(first).at(-1) ?? "", marks.firstsLast);
      await placeCopy(last, placesOf(last)[0] ?? "", marks.lastsFirst);
      await placeCopy(last, placesOf(last).at(-1) ?? "", marks.lastsLast);

      expect({
        own: await finds(reader.userId, marks.own),
        company: await finds(reader.userId, marks.company),
        // Their provider group before any place: what their source gives
        // them never goes for what an admin picked.
        group: await finds(reader.userId, marks.group),
        // The first connection's places, all of them, then the last's, as
        // many as there is room for: its last place goes unread.
        firstsLast: await finds(reader.userId, marks.firstsLast),
        lastsFirst: await finds(reader.userId, marks.lastsFirst),
        lastsLast: await finds(reader.userId, marks.lastsLast),
      }).toStrictEqual({
        own: true,
        company: true,
        group: true,
        firstsLast: true,
        lastsFirst: true,
        lastsLast: false,
      });
    } finally {
      // Nobody else in the worker reads these places.
      await env.DB.batch([
        env.DB.prepare(
          "DELETE FROM connection_brain_audiences WHERE connection_id IN (?, ?)"
        ).bind(first, last),
        env.DB.prepare(
          "DELETE FROM brain_sync_sources WHERE connection_id IN (?, ?)"
        ).bind(first, last),
        env.DB.prepare(
          "DELETE FROM source_reader_pairs WHERE place LIKE ? OR place LIKE ?"
        ).bind(`connection:${first}/%`, `connection:${last}/%`),
      ]);
    }
  });

  it("keeps every source row whole through the migration that lets a source have no person, with no version of its picks yet", async () => {
    // Core's migrations as the tests applied them (vite.config.ts), each
    // statement by its file: this table's own, run on a scratch copy of it
    // so the worker's own table stays as it is.
    const migrations = z
      .array(z.object({ name: z.string(), queries: z.array(z.string()) }))
      .parse(testBinding("CORE_MIGRATIONS"));
    const scratch = `brain_sync_sources_${unique().replaceAll("-", "").slice(0, 12)}`;
    const ofTable = (name: string): string[] =>
      (migrations.find((migration) => migration.name === name)?.queries ?? [])
        .filter((query) => query.includes("brain_sync_sources"))
        .map((query) => query.replaceAll("brain_sync_sources", scratch));
    // As main's migrations left it before this one: a person's own source.
    const row = {
      connection_id: `connection-${unique()}`,
      feed: "folders",
      place: "inbox",
      person_id: `person-${unique()}`,
      provider: "microsoft",
      tenant: "tenant",
      account: "account",
      cursor: "cursor",
      listing: 3,
      listing_open: 1,
      due_at: 1000,
      lease_id: "lease",
      lease_until: 2000,
      last_success_at: 3000,
      last_error: "sync.failed",
      added: 1,
      changed: 2,
      removed: 3,
      relist_cursor: "relist",
      relisting: 1,
      relist_at: 4000,
      relist_since: 5000,
      leaves_owed: 1,
      kind: "mail",
      dropped: 0,
      relist_catch_up: 1,
      seen_in: 7,
      last_error_at: 6000,
    };
    try {
      await run([
        ...ofTable("0274_brain_sync.sql"),
        ...ofTable("0275_ambitious_monster_badoon.sql"),
      ]);
      const columns = Object.keys(row);
      await env.DB.prepare(
        `INSERT INTO ${scratch} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`
      )
        .bind(...Object.values(row))
        .run();
      const migrated = ofTable("0276_brain_sync_shared_places.sql");
      await run(migrated);
      const after = await env.DB.prepare(`SELECT * FROM ${scratch}`).all();

      expect({ ran: migrated.length > 0, rows: after.results }).toStrictEqual({
        ran: true,
        rows: [{ ...row, picks_version: null }],
      });
    } finally {
      await env.DB.prepare(`DROP TABLE IF EXISTS ${scratch}`).run();
    }
  });

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
      readers: everyoneInTenant,
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
