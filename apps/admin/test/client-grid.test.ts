import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import {
  clientGrid,
  defaultLiveOptions,
  gridLive,
} from "../src/clients/grid.ts";
import type { GridRow, LiveOptions } from "../src/clients/grid.ts";
import { act, adminDatabase } from "../src/db/act.ts";
import { clients } from "../src/db/schema.ts";
import { mockCloudflareApi } from "./cloudflare-api-mock.ts";
import { livePlacedClient, placedRelease, scriptsOf } from "./placed.ts";
import { useStoreSecrets } from "./secrets-store.ts";

const token = "test-deployer-token-grid-4b7d21";
const cloudflare = mockCloudflareApi(token);
const db = adminDatabase(env.DB);
const staff = { email: "staff@grasp.test", sub: "sub-staff" };

/** A release a placed client runs, imported. */
const importedRelease = async (notes: string): Promise<string> =>
  await placedRelease(notes);

/** A client recorded as provisioning leaves it. */
const recordClient = async (
  status: "provisioning" | "active"
): Promise<{ clientId: string }> => {
  const clientId = `client-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date();
  await act(
    db,
    staff,
    [
      db.insert(clients).values({
        id: clientId,
        name: `Acme ${clientId}`,
        ring: 2,
        status,
        createdAt: now,
        updatedAt: now,
      }),
    ],
    { action: "client.create", clientId }
  );
  return { clientId };
};

/** An active client placed in the stage's destination, live on `releaseId`. */
const liveClient = async (releaseId: string) =>
  await livePlacedClient(cloudflare, 2, releaseId);

/** Client `clientId`'s row in `grid`. */
const rowOf = (grid: GridRow[], clientId: string): GridRow | undefined =>
  grid.find(({ id }) => id === clientId);

/** How many requests `client`'s core got in this test. */
const requestsTo = (client: { clientId: string }): number =>
  cloudflare
    .coreRequests()
    .filter(({ clientId }) => clientId === client.clientId).length;

/** Reading live columns as the grid does, answers not kept between tests. */
const uncached: LiveOptions = { ...defaultLiveOptions, cache: false };

describe("the client grid", () => {
  useStoreSecrets({ deployer: token });
  // Only each test's own clients are live: an earlier test's accounts are
  // gone from the fake.
  beforeEach(async () => {
    await db
      .update(clients)
      .set({ status: "offboarded" })
      .where(eq(clients.status, "active"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows each client's release, ring and its operation's latest run from what the admin recorded, reading no account", async () => {
    const release = await importedRelease("feat(core): on the grid");
    const acme = await liveClient(release);
    const waiting = await recordClient("provisioning");
    const calls = cloudflare.calls.length;

    const grid = await clientGrid(env);

    expect({
      acme: rowOf(grid, acme.clientId),
      waiting: rowOf(grid, waiting.clientId),
      calls: cloudflare.calls.length - calls,
    }).toMatchObject({
      acme: {
        status: "active",
        ring: 2,
        release,
        hostname: `${acme.clientId}.grasp.test`,
        lastDeploy: { releaseId: release, status: "done" },
      },
      waiting: { status: "provisioning", lastDeploy: null },
      calls: 0,
    });
  });

  it("reads a live placed client's drift, shared secrets, health and onboarding, and nothing for one that isn't live", async () => {
    const release = await importedRelease("feat(core): live on the grid");
    const acme = await liveClient(release);
    const waiting = await recordClient("provisioning");

    const live = await gridLive(env, uncached);

    expect({
      acme: live[acme.clientId],
      waiting: live[waiting.clientId],
    }).toStrictEqual({
      acme: {
        drift: "in_sync",
        sharedSecretsCurrent: true,
        reach: "reachable",
        onboarding: {
          stage: "none",
          day: null,
          days: null,
          known: 0,
          needs: 0,
        },
      },
      waiting: undefined,
    });
  });

  it("reaches a core in the clients' dispatch namespace through it, by the script its hostname's entry names, and no other, never a core's own workers.dev", async () => {
    const release = await importedRelease("feat(core): in the namespace");
    const acme = await liveClient(release);
    const host = `${acme.clientId}.grasp.test`;
    const entry = await env.ROUTER_HOSTS.get(host, "json");
    const { generation } = z.object({ generation: z.int() }).parse(entry);
    const { core: script } = await scriptsOf(acme.clientId);

    const reached = await gridLive(env, uncached);
    // Then its entry names a script the namespace doesn't have.
    await env.ROUTER_HOSTS.put(
      host,
      JSON.stringify({
        clientId: acme.clientId,
        script: "grasp-gone",
        generation,
      })
    );
    const gone = await gridLive(env, uncached);
    // Then its entry names a core on its own workers.dev, over the internet.
    const ownOrigin = "https://grasp-core.grasp-own.workers.dev";
    await env.ROUTER_HOSTS.put(
      host,
      JSON.stringify({
        clientId: acme.clientId,
        coreUrl: ownOrigin,
        generation,
      })
    );
    const own = await gridLive(env, uncached);

    const dispatched = cloudflare.dispatched();
    const overTheInternet = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([input]) =>
          new URL(input instanceof Request ? input.url : input).origin ===
          ownOrigin
      );
    expect({
      reached: reached[acme.clientId]?.reach,
      gone: gone[acme.clientId]?.reach,
      own: own[acme.clientId]?.reach,
      // To its own script, at its hostname, and never anywhere else.
      reachedIt: dispatched.some(
        ({ script: to, url }) => to === script && new URL(url).host === host
      ),
      onlyIt: dispatched.every(({ script: to }) => to === script),
      overTheInternet: overTheInternet.length,
    }).toStrictEqual({
      reached: "reachable",
      gone: "unreachable",
      // Never asked: only the namespace reaches a core.
      own: "unknown",
      reachedIt: true,
      onlyIt: true,
      overTheInternet: 0,
    });
  });

  it("reads a few clients at a time, stops one that takes too long, aborting its requests, keeps each whole answer a minute, and reads one with anything unknown again", async () => {
    const release = await importedRelease("feat(core): many live");
    const all = [];
    for (let index = 0; index < 4; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one deploy at a time
      const client = await liveClient(release);
      all.push(client);
    }
    const [slow, unread, ...whole] = all;
    // An unknown answer for a client that answers, kept a moment ago as
    // the admin kept them before: never served.
    const [stale] = whole;
    const kept = await caches.open("grid-live");
    await kept.put(
      `https://grid-live.admin.invalid/${encodeURIComponent(stale?.clientId ?? "")}`,
      Response.json(
        {
          drift: "unknown",
          sharedSecretsCurrent: null,
          reach: "unknown",
          onboarding: null,
        },
        { headers: { "cache-control": "max-age=60" } }
      )
    );
    // The slow client's core doesn't answer until the test lets it.
    const held = Promise.withResolvers<boolean>();
    const slowArrived = Promise.withResolvers<boolean>();
    if (slow !== undefined) {
      slow.core.held = async () => {
        slowArrived.resolve(true);
        await held.promise;
      };
    }
    // The fake answers every other request at once, so two clients' reads
    // overlap only if one is held open: the first request to another of
    // these cores waits until a second client's has arrived (the slow
    // one's, or another's), whichever order the clients are read in. Two
    // reads at a time hold two cores at once; one at a time never lets the
    // second arrive, and the held row fails its deadline.
    let firstOther: string | undefined;
    const secondArrived = Promise.withResolvers<boolean>();
    const heldFirst = (clientId: string) => async () => {
      firstOther ??= clientId;
      if (firstOther === clientId) {
        await Promise.race([slowArrived.promise, secondArrived.promise]);
      } else {
        secondArrived.resolve(true);
      }
    };
    for (const other of [unread, ...whole]) {
      if (other !== undefined) {
        other.core.held = heldFirst(other.clientId);
      }
    }
    // Another's core names no version for its connect, once: its drift
    // can't be told.
    if (unread !== undefined) {
      unread.core.connectAnswersFirst = [null];
    }
    const options: LiveOptions = {
      ...defaultLiveOptions,
      concurrency: 2,
      // Long enough for any client that answers, on a busy machine too.
      rowDeadlineMs: 2000,
      cache: true,
    };

    const reading = gridLive(env, options);
    const first = await reading;
    const peak = cloudflare.peakCores();
    const aborted = cloudflare.abortedCoreRequests();
    // Every core answers at once from here on.
    held.resolve(true);
    const callsBefore = whole.map((client) => requestsTo(client));
    const again = await gridLive(env, options);
    const callsAfter = whole.map((client) => requestsTo(client));

    expect({
      peak,
      // Its stalled request was aborted, not left running past the deadline.
      aborted: aborted > 0,
      first: {
        slow: first[slow?.clientId ?? ""],
        unread: first[unread?.clientId ?? ""],
        whole: whole.map(({ clientId }) => first[clientId]?.reach),
      },
      again: {
        // Not kept while unknown: read again, now that they answer.
        slow: again[slow?.clientId ?? ""],
        unread: again[unread?.clientId ?? ""],
        whole: whole.map(({ clientId }) => again[clientId]?.reach),
      },
      // Kept: the second read asked their cores nothing.
      calls: callsAfter.map(
        (count, index) => count - (callsBefore[index] ?? 0)
      ),
    }).toMatchObject({
      peak: 2,
      aborted: true,
      first: {
        slow: {
          drift: "unknown",
          sharedSecretsCurrent: null,
          reach: "unknown",
          onboarding: null,
        },
        unread: { drift: "unknown", reach: "reachable" },
        whole: whole.map(() => "reachable"),
      },
      again: {
        slow: { drift: "in_sync", reach: "reachable" },
        unread: { drift: "in_sync", reach: "reachable" },
        whole: whole.map(() => "reachable"),
      },
      calls: whole.map(() => 0),
    });
  });

  it("reads a client's onboarding from its core, signed for, numbers only, says when its core can't be asked, and never follows one that redirects", async () => {
    const release = await importedRelease("feat(core): onboarding on the grid");
    const onboarding = await liveClient(release);
    const older = await liveClient(release);
    const moved = await liveClient(release);
    moved.core.onboarding = {
      stage: "interviews",
      day: 1,
      days: 14,
      known: 2,
      needs: 0,
    };
    moved.core.redirectsTo = "https://elsewhere.example";
    onboarding.core.onboarding = {
      stage: "interviews",
      day: 4,
      days: 14,
      known: 48,
      needs: 1,
    };
    older.core.onboarding = "absent";

    const live = await gridLive(env, uncached);

    expect({
      onboarding: live[onboarding.clientId]?.onboarding,
      older: live[older.clientId]?.onboarding,
      moved: live[moved.clientId]?.onboarding,
      redirected: cloudflare.redirected(),
    }).toStrictEqual({
      onboarding: {
        stage: "interviews",
        day: 4,
        days: 14,
        known: 48,
        needs: 1,
      },
      older: "unreachable",
      // Unknown: what answers at the redirect's target isn't its core.
      moved: null,
      redirected: [],
    });
  });

  it("still answers when the cache can't keep what it read, or read it back", async () => {
    const release = await importedRelease("feat(core): no cache");
    const acme = await liveClient(release);
    const broken = await caches.open("broken-in-this-test");
    vi.spyOn(broken, "match").mockRejectedValue(new Error("cache down"));
    vi.spyOn(broken, "put").mockRejectedValue(new Error("cache down"));
    vi.spyOn(caches, "open").mockResolvedValue(broken);

    const live = await gridLive(env, defaultLiveOptions);

    expect(live[acme.clientId]).toMatchObject({
      drift: "in_sync",
      reach: "reachable",
    });
  });

  it("shows a client whose core doesn't answer as unreachable, one changed outside the admin as drifted, and shared secrets as unknown, never behind, when its connect's version can't be read", async () => {
    const release = await importedRelease("feat(core): trouble");
    const down = await liveClient(release);
    const changed = await liveClient(release);
    const unread = await liveClient(release);
    down.core.unhealthy = 100;
    // Someone deployed another version of each Worker by hand: core names
    // them.
    changed.core.answeringVersion = crypto.randomUUID();
    changed.core.connectAnswering = crypto.randomUUID();
    // Its core names no version for its connect.
    unread.core.connectAnswering = null;

    const live = await gridLive(env, uncached);

    expect({
      down: live[down.clientId],
      changed: live[changed.clientId],
      unread: live[unread.clientId],
    }).toMatchObject({
      down: { reach: "unreachable", drift: "unknown" },
      changed: { drift: "drifted" },
      unread: { drift: "unknown", sharedSecretsCurrent: null },
    });
  });
});
